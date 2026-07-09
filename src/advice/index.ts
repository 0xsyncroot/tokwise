import type {
  AggregateReport,
  Finding,
  InventoryItem,
  InventoryReport,
  SessionSummary,
  UsageEvent,
} from "../types.js";
import { listClaudeMcps, listClaudeSkills } from "../setup/claude-setup.js";
import { ratesForModel } from "../pricing/index.js";

const MCP_TOKENS_PER_SESSION = 12_000;
const SKILL_TOKENS_EST = 800;

function cacheHit(s: {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}): number {
  const d = s.inputTokens + s.cacheReadTokens + s.cacheWriteTokens;
  return d > 0 ? s.cacheReadTokens / d : 0;
}

export function buildInventory(
  events: UsageEvent[],
  report: AggregateReport,
): InventoryReport {
  const mcpCalls = new Map<string, { calls: number; sessions: Set<string> }>();
  const skillCalls = new Map<string, { calls: number; sessions: Set<string> }>();

  for (const e of events) {
    for (const tool of e.tools) {
      if (tool.kind === "mcp" && tool.server) {
        const row = mcpCalls.get(tool.server) || { calls: 0, sessions: new Set<string>() };
        row.calls += tool.count;
        row.sessions.add(`${e.provider}:${e.sessionId}`);
        mcpCalls.set(tool.server, row);
      }
      if (tool.kind === "skill") {
        const name = tool.skill || tool.name;
        const row = skillCalls.get(name) || { calls: 0, sessions: new Set<string>() };
        row.calls += tool.count;
        row.sessions.add(`${e.provider}:${e.sessionId}`);
        skillCalls.set(name, row);
      }
      if (tool.name.startsWith("mcp__")) {
        const server = tool.name.split("__")[1];
        if (server) {
          const row = mcpCalls.get(server) || { calls: 0, sessions: new Set<string>() };
          row.calls += tool.count;
          row.sessions.add(`${e.provider}:${e.sessionId}`);
          mcpCalls.set(server, row);
        }
      }
    }
  }

  const items: InventoryItem[] = [];
  const findings: Finding[] = [];
  const claudeRow = report.byProvider.find((p) => p.provider === "claude");
  const hasClaude = Boolean(claudeRow);
  const sessionCountForSave = hasClaude
    ? Math.max(1, claudeRow!.sessions)
    : Math.min(5, Math.max(1, report.totals.sessions));
  const inputPrice = ratesForModel("claude-sonnet-4").input;

  for (const mcp of listClaudeMcps()) {
    // Cursor-declared MCPs are separate; only advise OFF for Claude scopes in Claude findings
    const used = mcpCalls.get(mcp.name);
    const calls = used?.calls || 0;
    const sessions = used?.sessions.size || 0;
    const isCursor = mcp.scope.startsWith("cursor");
    items.push({
      kind: "mcp",
      provider: isCursor ? "cursor" : "claude",
      name: mcp.name,
      declared: true,
      calls,
      sessions,
      scope: mcp.scope,
      advice: calls === 0 ? "off" : "keep",
      estOverheadTokensPerSession: calls === 0 ? MCP_TOKENS_PER_SESSION : undefined,
    });

    if (
      calls === 0 &&
      !isCursor &&
      (mcp.scope === "user" || mcp.scope.startsWith("project") || mcp.scope === "settings")
    ) {
      const saveTokens = MCP_TOKENS_PER_SESSION * sessionCountForSave;
      const saveUsd = (saveTokens / 1_000_000) * inputPrice;
      findings.push({
        id: "overhead.mcp_unused",
        severity: saveUsd > 1 ? "critical" : "warn",
        scope: "setup",
        provider: "claude",
        metrics: { name: mcp.name, tokens: MCP_TOKENS_PER_SESSION, sessions: sessionCountForSave },
        estimatedSaveUsd: saveUsd,
        estimatedSaveTokens: saveTokens,
        titleKey: "overhead.mcp_unused.title",
        whyKey: "overhead.mcp_unused.why",
        fixKey: "overhead.mcp_unused.fix",
        fixCommand: `claude mcp remove ${mcp.name}`,
      });
    }
  }

  for (const [name, used] of mcpCalls) {
    if (items.some((i) => i.kind === "mcp" && i.name === name)) continue;
    items.push({
      kind: "mcp",
      provider: "claude",
      name,
      declared: false,
      calls: used.calls,
      sessions: used.sessions.size,
      advice: "keep",
    });
  }

  for (const skill of listClaudeSkills()) {
    const used = skillCalls.get(skill.name);
    const calls = used?.calls || 0;
    items.push({
      kind: "skill",
      provider: "claude",
      name: skill.name,
      declared: true,
      calls,
      sessions: used?.sessions.size || 0,
      advice: calls === 0 ? "archive" : "keep",
      estOverheadTokensPerSession: calls === 0 ? SKILL_TOKENS_EST : undefined,
    });
    if (calls === 0) {
      const saveTokens = SKILL_TOKENS_EST * sessionCountForSave;
      findings.push({
        id: "overhead.skill_unused",
        severity: "info",
        scope: "setup",
        provider: "claude",
        metrics: { name: skill.name, tokens: SKILL_TOKENS_EST },
        estimatedSaveUsd: (saveTokens / 1_000_000) * inputPrice,
        estimatedSaveTokens: saveTokens,
        titleKey: "overhead.skill_unused.title",
        whyKey: "overhead.skill_unused.why",
        fixKey: "overhead.skill_unused.fix",
        fixCommand: `mv ~/.claude/skills/${skill.name} ~/.claude/skills-archive/`,
      });
    }
  }

  return { items, findings };
}

export function sessionFindings(s: SessionSummary): Finding[] {
  const rate = cacheHit(s);
  const isOpus = /opus/i.test(s.model || "");
  // Save estimate: low cache → fix cache; high cache + opus → model routing
  let saveFrac = 0.1;
  if (rate < 0.5) saveFrac = 0.3;
  else if (isOpus) saveFrac = 0.35;
  return [
    {
      id: "session.expensive",
      severity: s.costUsd > 5 ? "critical" : s.costUsd > 1 ? "warn" : "info",
      scope: "session",
      provider: s.provider,
      sessionId: s.sessionId,
      metrics: {
        cost: `$${s.costUsd.toFixed(2)}`,
        rate: Math.round(rate * 100),
        requests: s.requests,
        model: s.model || "unknown",
      },
      estimatedSaveUsd: s.costUsd * saveFrac,
      titleKey: "session.expensive.title",
      whyKey: "session.expensive.why",
      fixKey: isOpus && rate >= 0.7 ? "model.opus_heavy.fix" : "session.expensive.fix",
    },
  ];
}

export function buildAdvice(
  report: AggregateReport,
  inventory?: InventoryReport,
): Finding[] {
  const findings: Finding[] = [];
  const tot = report.totals;

  if (tot.requests >= 5) {
    const rate = report.cacheHitRate;
    if (rate < 0.6 && tot.cacheReadTokens + tot.cacheWriteTokens + tot.inputTokens > 10_000) {
      const target = 0.85;
      const inputish = tot.inputTokens + tot.cacheReadTokens + tot.cacheWriteTokens;
      const missing = Math.max(0, target * inputish - tot.cacheReadTokens);
      const r = ratesForModel("claude-sonnet-4");
      const saveUsd = (missing / 1_000_000) * (r.input - r.cacheRead);
      findings.push({
        id: "cache.low_hit_rate",
        severity: saveUsd > 2 ? "critical" : "warn",
        scope: "period",
        metrics: { rate: Math.round(rate * 100) },
        estimatedSaveUsd: Math.max(0, saveUsd),
        estimatedSaveTokens: missing,
        titleKey: "cache.low_hit_rate.title",
        whyKey: "cache.low_hit_rate.why",
        fixKey: "cache.low_hit_rate.fix",
      });
    }
  }

  const shortSessions = report.sessions.filter((s) => s.requests < 3).length;
  if (shortSessions >= 5 && report.sessions.length >= 8) {
    findings.push({
      id: "session.too_many_short",
      severity: "warn",
      scope: "period",
      metrics: { count: shortSessions },
      estimatedSaveUsd: shortSessions * 0.05,
      titleKey: "session.too_many_short.title",
      whyKey: "session.too_many_short.why",
      fixKey: "session.too_many_short.fix",
    });
  }

  const opusSpend = report.models
    .filter((m) => /opus|o3/i.test(m.model))
    .reduce((a, m) => a + m.costUsd, 0);
  if (tot.costUsd > 0.5 && opusSpend / tot.costUsd > 0.5) {
    findings.push({
      id: "model.opus_heavy",
      severity: "warn",
      scope: "period",
      metrics: { pct: Math.round((opusSpend / tot.costUsd) * 100) },
      estimatedSaveUsd: opusSpend * 0.4,
      titleKey: "model.opus_heavy.title",
      whyKey: "model.opus_heavy.why",
      fixKey: "model.opus_heavy.fix",
    });
  }

  if (tot.requests > 0) {
    const toolCount = report.tools.reduce((a, x) => a + x.count, 0);
    const avg = toolCount / tot.requests;
    if (avg > 8) {
      findings.push({
        id: "tools.thrash",
        severity: "info",
        scope: "period",
        metrics: { avg: Number(avg.toFixed(1)) },
        estimatedSaveUsd: tot.costUsd * 0.1,
        titleKey: "tools.thrash.title",
        whyKey: "tools.thrash.why",
        fixKey: "tools.thrash.fix",
      });
    }

    const reads = report.tools
      .filter((x) => /^(Read|Grep|Glob)$/i.test(x.name))
      .reduce((a, x) => a + x.count, 0);
    const edits = report.tools
      .filter((x) => /^(Edit|Write)$/i.test(x.name))
      .reduce((a, x) => a + x.count, 0);
    if (edits >= 10 && reads / Math.max(1, edits) < 0.5) {
      findings.push({
        id: "tools.low_read_edit",
        severity: "warn",
        scope: "period",
        metrics: { reads, edits },
        estimatedSaveUsd: tot.costUsd * 0.15,
        titleKey: "tools.low_read_edit.title",
        whyKey: "tools.low_read_edit.why",
        fixKey: "tools.low_read_edit.fix",
      });
    }
  }

  for (const s of report.topSessions.slice(0, 3)) {
    findings.push(...sessionFindings(s));
  }

  if (inventory) findings.push(...inventory.findings);

  return findings.sort((a, b) => b.estimatedSaveUsd - a.estimatedSaveUsd);
}
