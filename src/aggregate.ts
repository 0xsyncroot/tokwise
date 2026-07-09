import type {
  AggregateReport,
  DateRange,
  DaySummary,
  ModelSummary,
  ProviderSummary,
  SessionSummary,
  ToolUse,
  UsageEvent,
} from "./types.js";
import { costUsd } from "./pricing/index.js";
import { formatYmd } from "./dates.js";

function mergeTools(tools: ToolUse[]): ToolUse[] {
  const map = new Map<string, ToolUse>();
  for (const t of tools) {
    const key = `${t.kind}:${t.server || ""}:${t.skill || ""}:${t.name}`;
    const prev = map.get(key);
    if (prev) prev.count += t.count;
    else map.set(key, { ...t });
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

function hitRate(p: { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): number {
  const denom = p.inputTokens + p.cacheReadTokens + p.cacheWriteTokens;
  return denom > 0 ? p.cacheReadTokens / denom : 0;
}

/** Cost of a single event, priced with its own provider + model (rawCost wins when reported). */
function eventCost(e: UsageEvent): number {
  return costUsd({
    provider: e.provider,
    model: e.model,
    inputTokens: e.inputTokens,
    outputTokens: e.outputTokens,
    cacheReadTokens: e.cacheReadTokens,
    cacheWriteTokens: e.cacheWriteTokens,
    reasoningTokens: e.reasoningTokens,
    rawCost: e.rawCost,
  });
}

export function aggregate(events: UsageEvent[], range: DateRange, topN = 10): AggregateReport {
  const sessionMap = new Map<string, SessionSummary>();
  const sessionModels = new Map<string, Set<string>>();

  for (const e of events) {
    const key = `${e.provider}::${e.sessionId}`;
    let s = sessionMap.get(key);
    if (!s) {
      s = {
        provider: e.provider,
        sessionId: e.sessionId,
        project: e.project,
        model: e.model,
        models: [],
        start: e.timestamp,
        end: e.timestamp,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costUsd: 0,
        tools: [],
        systemPromptTokens: 0,
        estimated: false,
      };
      sessionMap.set(key, s);
      sessionModels.set(key, new Set());
    }
    if (e.timestamp < s.start) s.start = e.timestamp;
    if (e.timestamp > s.end) s.end = e.timestamp;
    s.requests += e.requestCount;
    s.inputTokens += e.inputTokens;
    s.outputTokens += e.outputTokens;
    s.cacheReadTokens += e.cacheReadTokens;
    s.cacheWriteTokens += e.cacheWriteTokens;
    s.reasoningTokens += e.reasoningTokens;
    // Cost accrues per event so mixed-model sessions are priced correctly
    // and provider-reported rawCost is honored.
    s.costUsd += eventCost(e);
    if (e.model) {
      s.model = e.model;
      sessionModels.get(key)!.add(e.model);
    }
    if (e.project) s.project = e.project;
    if (e.estimated) s.estimated = true;
    if (e.systemPromptTokens) {
      s.systemPromptTokens = Math.max(s.systemPromptTokens, e.systemPromptTokens);
    }
    s.tools = mergeTools([...s.tools, ...e.tools]);
  }

  for (const [key, s] of sessionMap) {
    s.models = [...(sessionModels.get(key) ?? [])].sort();
  }

  const sessions = [...sessionMap.values()].sort((a, b) => b.costUsd - a.costUsd);

  // Per-provider × per-model rollup straight from events — each model row is
  // scoped to its platform (the same model id on two platforms stays two rows).
  const modelMap = new Map<string, ModelSummary>();
  for (const e of events) {
    const model = e.model || "unknown";
    const key = `${e.provider}::${model}`;
    let row = modelMap.get(key);
    if (!row) {
      row = {
        provider: e.provider,
        model,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        tokens: 0,
        costUsd: 0,
        estimated: false,
      };
      modelMap.set(key, row);
    }
    row.requests += e.requestCount;
    row.inputTokens += e.inputTokens;
    row.outputTokens += e.outputTokens;
    row.cacheReadTokens += e.cacheReadTokens;
    row.cacheWriteTokens += e.cacheWriteTokens;
    row.reasoningTokens += e.reasoningTokens;
    row.tokens += e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens;
    row.costUsd += eventCost(e);
    if (e.estimated) row.estimated = true;
  }
  const models = [...modelMap.values()].sort(
    (a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens,
  );

  const byProv = new Map<string, ProviderSummary>();
  for (const s of sessions) {
    let p = byProv.get(s.provider);
    if (!p) {
      p = {
        provider: s.provider,
        sessions: 0,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costUsd: 0,
        estimated: false,
        cacheHitRate: 0,
        models: [],
      };
      byProv.set(s.provider, p);
    }
    p.sessions += 1;
    p.requests += s.requests;
    p.inputTokens += s.inputTokens;
    p.outputTokens += s.outputTokens;
    p.cacheReadTokens += s.cacheReadTokens;
    p.cacheWriteTokens += s.cacheWriteTokens;
    p.reasoningTokens += s.reasoningTokens;
    p.costUsd += s.costUsd;
    if (s.estimated) p.estimated = true;
  }
  for (const p of byProv.values()) {
    p.cacheHitRate = hitRate(p);
    p.models = models.filter((m) => m.provider === p.provider);
  }

  const byProvider = [...byProv.values()].sort((a, b) => b.costUsd - a.costUsd);

  const tools = mergeTools(sessions.flatMap((s) => s.tools));

  // Daily × provider rollup from events (local calendar day)
  const dayMap = new Map<
    string,
    {
      date: string;
      provider: string;
      sessionKeys: Set<string>;
      requests: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      costUsd: number;
      estimated: boolean;
    }
  >();
  for (const e of events) {
    const date = formatYmd(e.timestamp);
    const key = `${date}::${e.provider}`;
    let d = dayMap.get(key);
    if (!d) {
      d = {
        date,
        provider: e.provider,
        sessionKeys: new Set(),
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        estimated: false,
      };
      dayMap.set(key, d);
    }
    d.sessionKeys.add(`${e.provider}::${e.sessionId}`);
    d.requests += e.requestCount;
    d.inputTokens += e.inputTokens;
    d.outputTokens += e.outputTokens;
    d.cacheReadTokens += e.cacheReadTokens;
    d.cacheWriteTokens += e.cacheWriteTokens;
    if (e.estimated) d.estimated = true;
    d.costUsd += eventCost(e);
  }
  const byDay: DaySummary[] = [...dayMap.values()]
    .map((d) => ({
      date: d.date,
      provider: d.provider,
      sessions: d.sessionKeys.size,
      requests: d.requests,
      inputTokens: d.inputTokens,
      outputTokens: d.outputTokens,
      cacheReadTokens: d.cacheReadTokens,
      cacheWriteTokens: d.cacheWriteTokens,
      costUsd: d.costUsd,
      estimated: d.estimated,
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.provider.localeCompare(b.provider));

  const uniqueDays = new Set(byDay.map((d) => d.date)).size;
  const multiDay =
    range.all ||
    uniqueDays > 1 ||
    formatYmd(range.from) !== formatYmd(range.to);

  const totalsBase = byProvider.reduce(
    (acc, p) => {
      acc.sessions += p.sessions;
      acc.requests += p.requests;
      acc.inputTokens += p.inputTokens;
      acc.outputTokens += p.outputTokens;
      acc.cacheReadTokens += p.cacheReadTokens;
      acc.cacheWriteTokens += p.cacheWriteTokens;
      acc.reasoningTokens += p.reasoningTokens;
      acc.costUsd += p.costUsd;
      if (p.estimated) acc.estimated = true;
      return acc;
    },
    {
      provider: "all",
      sessions: 0,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
      estimated: false,
      cacheHitRate: 0,
      models: [],
    } as ProviderSummary,
  );
  totalsBase.cacheHitRate = hitRate(totalsBase);
  totalsBase.models = models;

  return {
    range,
    totals: { ...totalsBase, providers: byProvider.length },
    byProvider,
    byDay,
    topSessions: sessions.slice(0, topN),
    sessions,
    tools,
    models,
    cacheHitRate: totalsBase.cacheHitRate,
    multiDay,
  };
}
