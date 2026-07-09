import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveDateRange } from "../src/dates.js";

const tokenCount = (ts: string, output: number) =>
  JSON.stringify({
    timestamp: ts,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { input_tokens: 1000, output_tokens: output, cached_input_tokens: 0 },
      },
    },
  });

describe("codex fixture parse", () => {
  it("skips replayed parent history in forked rollouts and backfills model from turn_context", async () => {
    const dir = join(tmpdir(), `tokwise-codex-${Date.now()}`);
    const day = join(dir, "sessions", "2026", "07", "05");
    mkdirSync(day, { recursive: true });

    // Forked subagent rollout: parent history is replayed BEFORE turn_context.
    const forked = [
      JSON.stringify({
        timestamp: "2026-07-05T10:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
          forked_from_id: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
          originator: "codex-tui",
          cwd: "/tmp/proj",
          source: { subagent: { thread_spawn: { parent_thread_id: "bbbbbbbb" } } },
        },
      }),
      // replayed parent usage — must NOT be counted
      tokenCount("2026-07-05T10:00:00.100Z", 111),
      tokenCount("2026-07-05T10:00:00.101Z", 222),
      JSON.stringify({
        timestamp: "2026-07-05T10:00:01.000Z",
        type: "turn_context",
        payload: { model: "gpt-5.5", cwd: "/tmp/proj" },
      }),
      // live subagent usage — counted, attributed to gpt-5.5
      tokenCount("2026-07-05T10:00:02.000Z", 500),
    ];
    writeFileSync(
      join(day, "rollout-2026-07-05T10-00-00-aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa.jsonl"),
      forked.join("\n") + "\n",
    );

    // Normal rollout where usage precedes turn_context (model backfilled)
    const normal = [
      JSON.stringify({
        timestamp: "2026-07-05T11:00:00.000Z",
        type: "session_meta",
        payload: { id: "cccccccc-3333-4333-8333-cccccccccccc", originator: "codex_exec", cwd: "/tmp/p2" },
      }),
      tokenCount("2026-07-05T11:00:00.500Z", 50),
      JSON.stringify({
        timestamp: "2026-07-05T11:00:01.000Z",
        type: "turn_context",
        payload: { model: "gpt-5.4" },
      }),
      tokenCount("2026-07-05T11:00:02.000Z", 60),
    ];
    writeFileSync(
      join(day, "rollout-2026-07-05T11-00-00-cccccccc-3333-4333-8333-cccccccccccc.jsonl"),
      normal.join("\n") + "\n",
    );

    process.env.CODEX_HOME = dir;
    process.env.TOKWISE_NO_CACHE = "1";
    const { collectCodex } = await import("../src/providers/codex.js");
    const range = resolveDateRange({ from: "2026-07-01", to: "2026-07-09" });
    const events = await collectCodex(range);
    delete process.env.CODEX_HOME;

    const forkEvents = events.filter((e) => e.sessionId.startsWith("aaaaaaaa"));
    assert.equal(forkEvents.length, 1); // replayed rows dropped
    assert.equal(forkEvents[0].outputTokens, 500);
    assert.equal(forkEvents[0].model, "gpt-5.5");

    const normalEvents = events.filter((e) => e.sessionId.startsWith("cccccccc"));
    assert.equal(normalEvents.length, 2); // non-forked: everything counted
    assert.equal(normalEvents[0].model, "gpt-5.4"); // backfilled
    assert.equal(normalEvents[1].model, "gpt-5.4");

    rmSync(dir, { recursive: true, force: true });
  });
});
