import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveDateRange } from "../src/dates.js";

describe("claude fixture parse", () => {
  it("parses usage and mcp tool from jsonl", async () => {
    const dir = join(tmpdir(), `tokwise-claude-${Date.now()}`);
    const proj = join(dir, "projects", "-tmp-proj");
    mkdirSync(proj, { recursive: true });
    const file = join(proj, "sess-1.jsonl");
    const lines = [
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-05T10:00:00.000Z",
        message: {
          id: "msg_1",
          role: "assistant",
          model: "claude-sonnet-4",
          content: [
            { type: "tool_use", id: "t1", name: "mcp__codegraph__explore", input: {} },
            { type: "tool_use", id: "t2", name: "Skill", input: { skill: "plan" } },
          ],
          usage: {
            input_tokens: 1000,
            output_tokens: 50,
            cache_read_input_tokens: 2000,
            cache_creation_input_tokens: 500,
          },
        },
      }),
      // duplicate id should be skipped
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-05T10:00:01.000Z",
        message: {
          id: "msg_1",
          role: "assistant",
          model: "claude-sonnet-4",
          content: [],
          usage: { input_tokens: 1000, output_tokens: 50 },
        },
      }),
    ];
    writeFileSync(file, lines.join("\n") + "\n");

    process.env.CLAUDE_CONFIG_DIR = dir;
    process.env.TOKWISE_NO_CACHE = "1";
    // dynamic import after env set — re-import module
    const { collectClaude } = await import("../src/providers/claude.js");
    const range = resolveDateRange({ from: "2026-07-01", to: "2026-07-09" });
    const events = await collectClaude(range);
    delete process.env.CLAUDE_CONFIG_DIR;

    assert.equal(events.length, 1);
    assert.equal(events[0].inputTokens, 1000);
    assert.equal(events[0].cacheReadTokens, 2000);
    assert.ok(events[0].tools.some((t) => t.kind === "mcp"));
    assert.ok(events[0].tools.some((t) => t.kind === "skill"));

    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps per-message max usage across streamed lines and counts subagents under the parent session", async () => {
    const dir = join(tmpdir(), `tokwise-claude-max-${Date.now()}`);
    const proj = join(dir, "projects", "-tmp-proj2");
    const subDir = join(proj, "parent-1", "subagents");
    mkdirSync(subDir, { recursive: true });

    const mkLine = (id: string, out: number, blocks: unknown[] = []) =>
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-05T10:00:00.000Z",
        message: {
          id,
          role: "assistant",
          model: "claude-fable-5",
          content: blocks,
          usage: { input_tokens: 500, output_tokens: out, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 },
        },
      });

    // main session: one message streamed over 3 lines with growing output;
    // a tool_use block arrives on a later line and must not be lost
    writeFileSync(
      join(proj, "parent-1.jsonl"),
      [
        mkLine("m1", 50, [{ type: "thinking" }]),
        mkLine("m1", 120, [{ type: "tool_use", id: "t1", name: "Bash", input: {} }]),
        mkLine("m1", 421, [{ type: "text", text: "done" }]),
      ].join("\n") + "\n",
    );

    // subagent transcript under the same session
    writeFileSync(join(subDir, "agent-x.jsonl"), mkLine("m2", 999) + "\n");

    process.env.CLAUDE_CONFIG_DIR = dir;
    process.env.TOKWISE_NO_CACHE = "1";
    const { collectClaude } = await import("../src/providers/claude.js");
    const range = resolveDateRange({ from: "2026-07-01", to: "2026-07-09" });
    const events = await collectClaude(range);
    delete process.env.CLAUDE_CONFIG_DIR;

    const mine = events.filter((e) => e.project === "tmp/proj2");
    assert.equal(mine.length, 2); // m1 merged, m2 from subagent
    const m1 = mine.find((e) => e.outputTokens === 421);
    assert.ok(m1, "kept the max streamed output, not the first partial");
    assert.equal(m1!.inputTokens, 500); // counted once, not 3x
    assert.ok(m1!.tools.some((t) => t.name === "Bash"), "tool_use from a later duplicate line kept");
    const m2 = mine.find((e) => e.outputTokens === 999);
    assert.ok(m2, "subagent usage counted");
    assert.equal(m2!.sessionId, "parent-1", "subagent attributed to parent session");

    rmSync(dir, { recursive: true, force: true });
  });
});
