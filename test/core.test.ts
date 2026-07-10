import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveDateRange, formatYmd, inRange } from "../src/dates.js";
import { costUsd, formatTokens, ratesForModel } from "../src/pricing/index.js";
import { aggregate } from "../src/aggregate.js";
import { buildAdvice, buildInventory } from "../src/advice/index.js";
import { classifyTool } from "../src/providers/_shared/io.js";
import { renderHtmlReport } from "../src/render/html.js";
import { defaultReportPath, slugRangeLabel, stateRoot } from "../src/paths.js";
import type { UsageEvent } from "../src/types.js";

describe("dates", () => {
  it("defaults to today", () => {
    const r = resolveDateRange({});
    assert.equal(r.all, false);
    assert.equal(r.label, formatYmd(new Date()));
  });

  it("parses range", () => {
    const r = resolveDateRange({ from: "2026-07-01", to: "2026-07-09" });
    assert.ok(inRange(new Date(2026, 6, 5), r));
    assert.ok(!inRange(new Date(2026, 5, 30), r));
  });

  it("all flag", () => {
    assert.equal(resolveDateRange({ all: true }).all, true);
  });
});

describe("pricing", () => {
  it("prices current opus generation at $5/$25", () => {
    const r = ratesForModel("claude-opus-4-8");
    assert.equal(r.input, 5);
    assert.equal(r.output, 25);
  });

  it("keeps legacy opus at $15/$75", () => {
    assert.equal(ratesForModel("claude-opus-4-1").input, 15);
    assert.equal(ratesForModel("claude-3-opus-20240229").input, 15);
  });

  it("prices fable 5 at $10/$50 with cache rates", () => {
    const r = ratesForModel("claude-fable-5");
    assert.equal(r.input, 10);
    assert.equal(r.output, 50);
    assert.equal(r.cacheRead, 1);
    assert.equal(r.cacheWrite, 12.5);
  });

  it("prices latest openai and gemini generations", () => {
    assert.equal(ratesForModel("gpt-5.4").input, 2.5);
    assert.equal(ratesForModel("gpt-5.5").output, 30);
    assert.equal(ratesForModel("gpt-5.3-codex").output, 14);
    assert.equal(ratesForModel("gemini-3.1-pro-preview").input, 2);
    assert.equal(ratesForModel("gemini-3.5-flash").output, 9);
  });

  it("computes cost", () => {
    const c = costUsd({
      model: "claude-sonnet-4",
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    assert.equal(c, 3);
  });

  it("does not double-bill codex reasoning (reasoning ⊂ output)", () => {
    const c = costUsd({
      provider: "codex",
      model: "gpt-5",
      inputTokens: 0,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 500_000,
    });
    assert.equal(c, 10);
  });

  it("bills gemini thinking tokens on top at output rate", () => {
    const c = costUsd({
      provider: "gemini",
      model: "gemini-2.5-pro",
      inputTokens: 0,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 1_000_000,
    });
    assert.equal(c, 20);
  });

  it("never fabricates a cost for antigravity (sessions-only)", () => {
    const c = costUsd({
      provider: "antigravity",
      model: "antigravity",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    assert.equal(c, 0);
  });

  it("prefers provider-reported rawCost", () => {
    const c = costUsd({
      provider: "claude",
      model: "claude-opus-4-8",
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      rawCost: 1.23,
    });
    assert.equal(c, 1.23);
  });

  it("formats tokens", () => {
    assert.equal(formatTokens(1500), "1.5k");
  });
});

describe("classifyTool", () => {
  it("detects mcp server", () => {
    const c = classifyTool("mcp__codewiki__codewiki_context");
    assert.equal(c.kind, "mcp");
    assert.equal(c.server, "codewiki");
  });

  it("detects skill", () => {
    assert.equal(classifyTool("Skill").kind, "skill");
  });
});

describe("aggregate + advice", () => {
  const range = resolveDateRange({ from: "2026-07-01", to: "2026-07-09" });

  const events: UsageEvent[] = [
    {
      provider: "claude",
      sessionId: "s1",
      model: "claude-opus-4-8",
      timestamp: new Date(2026, 6, 5, 10),
      inputTokens: 50_000,
      outputTokens: 2_000,
      cacheReadTokens: 5_000,
      cacheWriteTokens: 40_000,
      reasoningTokens: 0,
      requestCount: 1,
      tools: [
        { name: "Read", kind: "system", count: 2 },
        { name: "Edit", kind: "system", count: 10 },
        { name: "mcp__codewiki__x", kind: "mcp", count: 1, server: "codewiki" },
      ],
    },
    {
      provider: "claude",
      sessionId: "s1",
      model: "claude-opus-4-8",
      timestamp: new Date(2026, 6, 5, 11),
      inputTokens: 10_000,
      outputTokens: 1_000,
      cacheReadTokens: 80_000,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      requestCount: 1,
      tools: [{ name: "Bash", kind: "system", count: 3 }],
    },
    {
      provider: "codex",
      sessionId: "c1",
      model: "gpt-5",
      timestamp: new Date(2026, 6, 6),
      inputTokens: 20_000,
      outputTokens: 5_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 1_000,
      requestCount: 2,
      tools: [],
    },
  ];

  it("aggregates sessions and cost", () => {
    const report = aggregate(events, range, 5);
    assert.equal(report.totals.sessions, 2);
    assert.ok(report.totals.costUsd > 0);
    assert.equal(report.byProvider.length, 2);
    assert.equal(report.topSessions[0].sessionId, "s1");
    assert.ok(report.byDay.length >= 1);
    assert.equal(report.multiDay, true);
  });

  it("splits byDay per provider (no comma-joined platforms)", () => {
    const mixed: UsageEvent[] = [
      {
        provider: "claude",
        sessionId: "c1",
        model: "claude-sonnet-4",
        timestamp: new Date(2026, 6, 5, 10),
        inputTokens: 10_000,
        outputTokens: 1_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        requestCount: 2,
        tools: [],
      },
      {
        provider: "cursor-agent",
        sessionId: "a1",
        model: "cursor-auto",
        timestamp: new Date(2026, 6, 5, 12),
        inputTokens: 5_000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        requestCount: 3,
        tools: [],
        estimated: true,
      },
    ];
    const report = aggregate(mixed, range, 5);
    const dayRows = report.byDay.filter((d) => d.date === "2026-07-05");
    assert.equal(dayRows.length, 2);
    const claude = dayRows.find((d) => d.provider === "claude");
    const cursor = dayRows.find((d) => d.provider === "cursor-agent");
    assert.ok(claude);
    assert.ok(cursor);
    assert.equal(claude!.requests, 2);
    assert.equal(cursor!.requests, 3);
    assert.ok(cursor!.estimated);
    assert.notEqual(claude!.costUsd, cursor!.costUsd);
    // reconcile: day×provider sums match totals
    const sumCost = report.byDay.reduce((a, d) => a + d.costUsd, 0);
    assert.ok(Math.abs(sumCost - report.totals.costUsd) < 1e-9);
  });

  it("ratesForModel matches cursor-auto", () => {
    const r = ratesForModel("cursor-auto");
    assert.equal(r.input, 3);
    assert.equal(r.output, 15);
  });

  it("prices mixed-model sessions per event, not by last model", () => {
    const mixed: UsageEvent[] = [
      {
        provider: "claude",
        sessionId: "mix1",
        model: "claude-opus-4-8", // $5/M input
        timestamp: new Date(2026, 6, 5, 10),
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        requestCount: 1,
        tools: [],
      },
      {
        provider: "claude",
        sessionId: "mix1",
        model: "claude-haiku-4-5", // $1/M input — last model must NOT reprice the opus half
        timestamp: new Date(2026, 6, 5, 11),
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        requestCount: 1,
        tools: [],
      },
    ];
    const report = aggregate(mixed, range, 5);
    const s = report.sessions[0];
    assert.equal(s.costUsd, 6); // 5 + 1, not 2 (all-haiku) or 10 (all-opus)
    assert.deepEqual(s.models, ["claude-haiku-4-5", "claude-opus-4-8"]);
    assert.equal(s.modelBreakdown.length, 2);
    assert.equal(s.modelBreakdown[0].model, "claude-opus-4-8");
    assert.equal(s.modelBreakdown[0].costUsd, 5);
    assert.equal(s.modelBreakdown[1].model, "claude-haiku-4-5");
    assert.equal(s.modelBreakdown[1].costUsd, 1);
  });

  it("honors rawCost at session and provider level", () => {
    const ev: UsageEvent[] = [
      {
        provider: "cline",
        sessionId: "r1",
        model: "claude-sonnet-4-5",
        timestamp: new Date(2026, 6, 5, 10),
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        requestCount: 1,
        tools: [],
        rawCost: 0.42,
      },
    ];
    const report = aggregate(ev, range, 5);
    assert.equal(report.sessions[0].costUsd, 0.42);
    assert.equal(report.byProvider[0].costUsd, 0.42);
    assert.equal(report.byDay[0].costUsd, 0.42);
  });

  it("keeps model rollups per platform (same model id stays separate rows)", () => {
    const ev: UsageEvent[] = [
      {
        provider: "codex",
        sessionId: "a",
        model: "gpt-5",
        timestamp: new Date(2026, 6, 5),
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        requestCount: 1,
        tools: [],
      },
      {
        provider: "copilot",
        sessionId: "b",
        model: "gpt-5",
        timestamp: new Date(2026, 6, 5),
        inputTokens: 500_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        requestCount: 1,
        tools: [],
        estimated: true,
      },
    ];
    const report = aggregate(ev, range, 5);
    assert.equal(report.models.length, 2);
    const codexRow = report.models.find((m) => m.provider === "codex");
    const copilotRow = report.models.find((m) => m.provider === "copilot");
    assert.ok(codexRow && copilotRow);
    assert.equal(codexRow!.estimated, false);
    assert.equal(copilotRow!.estimated, true);
    // provider summaries carry their own model breakdown
    const codexProv = report.byProvider.find((p) => p.provider === "codex");
    assert.equal(codexProv!.models.length, 1);
    assert.equal(codexProv!.models[0].model, "gpt-5");
  });

  it("builds advice findings", () => {
    // pad with short sessions to trigger rules
    const more: UsageEvent[] = [...events];
    for (let i = 0; i < 10; i++) {
      more.push({
        provider: "claude",
        sessionId: `short${i}`,
        model: "claude-sonnet-4",
        timestamp: new Date(2026, 6, 7),
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 5000,
        reasoningTokens: 0,
        requestCount: 1,
        tools: [{ name: "Edit", kind: "system", count: 5 }],
      });
    }
    const report = aggregate(more, range, 5);
    const inv = buildInventory(more, report);
    const findings = buildAdvice(report, inv);
    assert.ok(findings.length >= 1);
    assert.ok(findings.some((f) => f.id === "tools.low_read_edit" || f.id === "session.too_many_short" || f.id === "session.expensive"));
  });
});

describe("html report", () => {
  it("renders detailed tables with escaped content", () => {
    const range = resolveDateRange({ from: "2026-07-01", to: "2026-07-09" });
    const events: UsageEvent[] = [
      {
        provider: "claude",
        sessionId: "s<script>",
        project: "proj/<x>",
        model: "claude-sonnet-4",
        timestamp: new Date(2026, 6, 5, 10),
        inputTokens: 10_000,
        outputTokens: 1_000,
        cacheReadTokens: 2_000,
        cacheWriteTokens: 500,
        reasoningTokens: 100,
        requestCount: 2,
        tools: [{ name: "Read", kind: "system", count: 3 }],
      },
      {
        provider: "codex",
        sessionId: "c1",
        model: "gpt-5",
        timestamp: new Date(2026, 6, 6),
        inputTokens: 5_000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        requestCount: 1,
        tools: [],
      },
    ];
    const report = aggregate(events, range, 5);
    // Simulate enriched transcript details
    report.sessions[0].prompts = ['Fix the <bug> in "auth"'];
    report.sessions[0].userTurns = 3;
    report.sessions[0].sourcePath = "/tmp/proj/s<script>.jsonl";
    report.sessions[0].title = "Auth fix";
    report.sessions[0].model = "claude-sonnet-4";
    report.sessions[0].models = ["claude-sonnet-4"];
    report.sessions[0].thinkingBlocks = 2;
    report.sessions[0].thinkingTokensEst = 1600;
    report.sessions[0].turns = [
      {
        index: 1,
        prompt: 'Fix the <bug> in "auth"',
        model: "claude-sonnet-4",
        aiAction: "I'll patch auth.ts · Tools (2): Read, Edit · Thinking: 2 block(s) ≈ 1,600 tok",
        output: "Patched the null check in auth.ts.",
        tools: [
          { name: "Read", count: 1 },
          { name: "Edit", count: 1 },
        ],
        thinkingBlocks: 2,
        thinkingTokensEst: 1600,
        thinkingRedacted: true,
        outputTokensEst: 10,
        assistantMessages: 2,
      },
    ];
    const inv = buildInventory(events, report);
    const findings = buildAdvice(report, inv);
    const html = renderHtmlReport("vi", report, findings, { inventory: inv });
    assert.match(html, /<!DOCTYPE html>/);
    assert.match(html, /Theo nền tảng/);
    assert.match(html, /row-drill/);
    assert.match(html, /tr class="nested" hidden/);
    assert.match(html, /s&lt;script&gt;/);
    assert.match(html, /proj\/&lt;x&gt;/);
    assert.match(html, /id="sessions"/);
    assert.match(html, /id="by-provider"/);
    assert.match(html, /id="models"/);
    assert.match(html, /Chi tiết token|token-grid/);
    assert.match(html, /Bấm ▶/);
    assert.match(html, /Prompt người dùng/);
    assert.match(html, /Fix the &lt;bug&gt; in &quot;auth&quot;/);
    assert.match(html, /Review session/);
    assert.match(html, /model-tag/);
    assert.match(html, /sonnet-4/);
    assert.match(html, /AI đã làm gì/);
    assert.match(html, /Output của AI/);
    assert.match(html, /Patched the null check/);
    assert.match(html, /Thinking \(ước lượng\)/);
  });
});

describe("paths", () => {
  it("builds report path under state/reports", () => {
    const p = defaultReportPath("2026-07-01 → 2026-07-09", new Date(2026, 6, 10, 12, 30, 5));
    assert.ok(p.includes(stateRoot()));
    assert.ok(p.includes("/reports/"));
    assert.match(p, /report-2026-07-01_to_2026-07-09-20260710-123005\.html$/);
  });

  it("slugs range labels safely", () => {
    assert.equal(slugRangeLabel("2026-07-01 → 2026-07-09"), "2026-07-01_to_2026-07-09");
    assert.equal(slugRangeLabel("all"), "all");
  });
});
