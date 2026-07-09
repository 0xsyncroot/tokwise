import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectCursorAgent } from "../src/providers/cursor-agent.js";
import { resolveDateRange } from "../src/dates.js";

describe("collectCursorAgent", () => {
  it("estimates redacted turns with tool floors and counts tool payloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokwise-ca-"));
    const project = join(root, "my-project", "agent-transcripts", "sess-1");
    await mkdir(project, { recursive: true });
    const file = join(project, "sess-1.jsonl");
    const lines = [
      JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "hello world" }] },
        timestamp: "2026-07-05T10:00:00.000Z",
      }),
      JSON.stringify({
        role: "assistant",
        message: {
          content: [
            { type: "text", text: "[REDACTED]" },
            {
              type: "tool_use",
              name: "Write",
              input: { path: "a.ts", contents: "x".repeat(400) },
            },
          ],
        },
        timestamp: "2026-07-05T10:01:00.000Z",
      }),
    ];
    await writeFile(file, lines.join("\n") + "\n");

    const prev = process.env.TOKWISE_CURSOR_AGENT_DIR;
    process.env.TOKWISE_CURSOR_AGENT_DIR = root;
    try {
      const range = resolveDateRange({ from: "2026-07-01", to: "2026-07-09" });
      const events = await collectCursorAgent(range);
      assert.equal(events.length, 1);
      const e = events[0]!;
      assert.equal(e.provider, "cursor-agent");
      assert.equal(e.project, "my-project");
      assert.equal(e.model, "cursor-auto");
      assert.equal(e.estimated, true);
      assert.equal(e.requestCount, 1);
      // user text (~3 tok) + tool payload (100) + tool-result floor (4000) + context floor (2000)
      assert.ok(e.inputTokens > 4_000, `input too low: ${e.inputTokens}`);
      // redacted output floor 1200 (tool payload 100 < floor)
      assert.ok(e.outputTokens >= 1_200, `output too low: ${e.outputTokens}`);
      assert.ok(e.tools.some((t) => t.name === "Write"));
    } finally {
      if (prev === undefined) delete process.env.TOKWISE_CURSOR_AGENT_DIR;
      else process.env.TOKWISE_CURSOR_AGENT_DIR = prev;
    }
  });

  it("includes subagent transcripts", async () => {
    const root = await mkdtemp(join(tmpdir(), "tokwise-ca-sub-"));
    const project = join(
      root,
      "proj",
      "agent-transcripts",
      "parent",
      "subagents",
    );
    await mkdir(project, { recursive: true });
    const file = join(project, "child.jsonl");
    await writeFile(
      file,
      JSON.stringify({
        role: "assistant",
        message: { content: [{ type: "text", text: "subagent reply here" }] },
        timestamp: "2026-07-05T12:00:00.000Z",
      }) + "\n",
    );

    const prev = process.env.TOKWISE_CURSOR_AGENT_DIR;
    process.env.TOKWISE_CURSOR_AGENT_DIR = root;
    try {
      const range = resolveDateRange({ from: "2026-07-01", to: "2026-07-09" });
      const events = await collectCursorAgent(range);
      assert.equal(events.length, 1);
      assert.ok(events[0]!.sessionId.startsWith("sub:"));
      assert.ok(events[0]!.outputTokens > 0);
    } finally {
      if (prev === undefined) delete process.env.TOKWISE_CURSOR_AGENT_DIR;
      else process.env.TOKWISE_CURSOR_AGENT_DIR = prev;
    }
  });
});
