import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { enrichSessionDetails, shortSourcePath } from "../src/session-detail.js";
import type { SessionSummary } from "../src/types.js";

function baseSession(over: Partial<SessionSummary>): SessionSummary {
  return {
    provider: "claude",
    sessionId: "sess-1",
    models: [],
    modelBreakdown: [],
    start: new Date(),
    end: new Date(),
    requests: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    tools: [],
    systemPromptTokens: 0,
    estimated: false,
    prompts: [],
    userTurns: 0,
    turns: [],
    thinkingBlocks: 0,
    thinkingTokensEst: 0,
    ...over,
  };
}

describe("session-detail", () => {
  it("shortSourcePath keeps last 3 segments", () => {
    assert.equal(shortSourcePath("/a/b/c/d/e.jsonl"), "c/d/e.jsonl");
    assert.equal(shortSourcePath(undefined), "—");
  });

  it("extracts user prompts from claude + cursor transcripts", async () => {
    const root = mkdtempSync(join(tmpdir(), "tokusage-sd-"));
    const prevClaude = process.env.TOKWISE_CLAUDE_DIR;
    const prevCursor = process.env.TOKWISE_CURSOR_PROJECTS;
    // cursorProjectsDir uses ~/.cursor/projects — override via symlink-like layout
    // We set CLAUDE dir; for cursor we write under a fake home by patching env if supported.
    // Instead: write files and point sourcePath directly by pre-setting after enrich index —
    // enrich looks up by id under configured dirs. Use TOKWISE_CLAUDE_DIR.
    process.env.TOKWISE_CLAUDE_DIR = root;

    const proj = join(root, "projects", "-tmp-proj");
    mkdirSync(proj, { recursive: true });
    const claudeFile = join(proj, "abc-claude.jsonl");
    writeFileSync(
      claudeFile,
      [
        JSON.stringify({
          type: "ai-title",
          aiTitle: "Fix auth login flow",
          sessionId: "abc-claude",
        }),
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "text", text: "Please fix the auth bug in login.ts" }],
          },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            model: "claude-opus-4-8",
            content: [{ type: "thinking", thinking: "", signature: "x" }],
            usage: { input_tokens: 100, output_tokens: 2400 },
          },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            model: "claude-opus-4-8",
            content: [
              { type: "text", text: "I'll inspect login.ts and patch the auth check." },
              { type: "tool_use", name: "Read", input: { file_path: "login.ts" } },
              { type: "tool_use", name: "Edit", input: { file_path: "login.ts" } },
            ],
            usage: { input_tokens: 200, output_tokens: 80 },
          },
        }),
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", content: "ok" }],
          },
        }),
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "text", text: "also add tests" }],
          },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            model: "claude-opus-4-8",
            content: [{ type: "text", text: "Adding unit tests for the auth helper." }],
          },
        }),
      ].join("\n") + "\n",
    );

    // Cursor: write under a temp projects tree and set sourcePath manually via
    // enrich after we also create cursor layout. cursorProjectsDir() = ~/.cursor/projects
    // unless we can't override — so set sourcePath on session and call extract via enrich
    // by placing file where index finds it. Skip cursor env; test claude path + direct sourcePath.

    const cursorRoot = join(root, "cursor-projects", "myproj", "agent-transcripts", "cur-1");
    mkdirSync(cursorRoot, { recursive: true });
    const cursorFile = join(cursorRoot, "cur-1.jsonl");
    writeFileSync(
      cursorFile,
      [
        JSON.stringify({
          role: "user",
          message: {
            content: [{ type: "text", text: "<user_query>\nrefactor the HTML report\n</user_query>" }],
          },
        }),
        JSON.stringify({
          role: "assistant",
          message: {
            content: [
              { type: "text", text: "I'll redesign the session drill-down next." },
              { type: "tool_use", name: "Read", input: {} },
              { type: "tool_use", name: "Write", input: {} },
            ],
          },
        }),
        JSON.stringify({
          role: "user",
          message: {
            content: [{ type: "text", text: "<user_query>\nadd drill down\n</user_query>" }],
          },
        }),
        JSON.stringify({
          role: "assistant",
          message: { content: [{ type: "text", text: "Drill-down cards are in place." }] },
        }),
      ].join("\n") + "\n",
    );

    const sessions = [
      baseSession({ provider: "claude", sessionId: "abc-claude" }),
      baseSession({
        provider: "cursor-agent",
        sessionId: "cur-1",
        sourcePath: cursorFile,
      }),
    ];

    // For cursor, enrich uses path index from cursorProjectsDir — may miss our temp file.
    // Pre-set sourcePath so resolveFromIndex returns it when exists.
    await enrichSessionDetails(sessions);

    const claude = sessions[0];
    assert.ok(claude.sourcePath?.endsWith("abc-claude.jsonl"));
    assert.equal(claude.title, "Fix auth login flow");
    assert.ok(claude.userTurns >= 2);
    assert.ok(claude.turns.length >= 2);
    const t0 = claude.turns[0];
    assert.match(t0.prompt, /auth bug/i);
    assert.equal(t0.model, "claude-opus-4-8");
    assert.match(t0.aiAction, /inspect login|Tools/i);
    assert.ok(t0.output && /inspect login/i.test(t0.output));
    assert.ok(t0.thinkingBlocks >= 1);
    assert.ok(t0.thinkingTokensEst >= 2400); // from thinking-only usage.output_tokens
    assert.ok(t0.tools.some((x) => x.name === "Read"));
    assert.ok(claude.prompts.some((p) => /add tests/i.test(p)));

    const cur = sessions[1];
    assert.equal(cur.sourcePath, cursorFile);
    assert.ok(cur.turns.some((t) => /refactor the HTML report/i.test(t.prompt)));
    assert.ok(cur.turns.some((t) => t.output && /redesign/i.test(t.output)));
    assert.ok(cur.userTurns >= 2);

    if (prevClaude === undefined) delete process.env.TOKWISE_CLAUDE_DIR;
    else process.env.TOKWISE_CLAUDE_DIR = prevClaude;
    void prevCursor;
    rmSync(root, { recursive: true, force: true });
  });
});
