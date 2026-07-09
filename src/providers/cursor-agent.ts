/**
 * Cursor Agent transcripts under ~/.cursor/projects/.../agent-transcripts
 *
 * Cursor rarely writes real usage blocks. Many assistant texts are "[REDACTED]"
 * and tool results are omitted — so we estimate from visible text + tool_use
 * payloads, with floors when redaction hides the bulk of the turn.
 */
import { basename, dirname } from "node:path";
import { existsSync } from "node:fs";
import type { DateRange, ProviderInfo, UsageEvent } from "../types.js";
import { cursorProjectsDir } from "./_paths.js";
import {
  estimateTokensFromText,
  fileMtimeMs,
  mergeToolCounts,
  parseJsonl,
  walkFiles,
} from "./_shared/io.js";
import { inRange, mtimePossiblyInRange } from "../dates.js";

/** Missing tool-result / context overhead when transcripts omit results */
const TOOL_RESULT_INPUT_FLOOR = 4_000;
/** Typical assistant reply when text is redacted to "[REDACTED]" */
const REDACTED_OUTPUT_FLOOR = 1_200;
/** Minimum input per assistant turn that used tools (system/context overhead) */
const TURN_CONTEXT_INPUT_FLOOR = 2_000;

function isRedactedText(text: string): boolean {
  const t = text.trim();
  return t === "[REDACTED]" || t === "REDACTED" || /^\[REDACTED\]$/i.test(t);
}

function projectFromTranscriptPath(file: string): string {
  // Walk up until we hit .../<project>/agent-transcripts/...
  let dir = dirname(file);
  for (let i = 0; i < 8; i++) {
    if (basename(dir) === "agent-transcripts") {
      return basename(dirname(dir));
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return basename(dirname(dirname(file)));
}

function extractUsageTokens(row: Record<string, unknown>): {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
} | null {
  const candidates = [
    row.usage,
    (row.message as Record<string, unknown> | undefined)?.usage,
    row.tokenUsage,
    row.token_count,
  ];
  for (const u of candidates) {
    if (!u || typeof u !== "object") continue;
    const o = u as Record<string, unknown>;
    const input =
      num(o.input_tokens) ??
      num(o.inputTokens) ??
      num(o.prompt_tokens) ??
      num(o.promptTokens);
    const output =
      num(o.output_tokens) ??
      num(o.outputTokens) ??
      num(o.completion_tokens) ??
      num(o.completionTokens);
    if (input != null || output != null) {
      return {
        input: input ?? 0,
        output: output ?? 0,
        cacheRead:
          num(o.cache_read_input_tokens) ??
          num(o.cacheReadTokens) ??
          num(o.cache_read_tokens) ??
          0,
        cacheWrite:
          num(o.cache_creation_input_tokens) ??
          num(o.cacheWriteTokens) ??
          num(o.cache_write_tokens) ??
          0,
      };
    }
  }
  return null;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export async function collectCursorAgent(range: DateRange): Promise<UsageEvent[]> {
  const root = cursorProjectsDir();
  if (!existsSync(root)) return [];

  const events: UsageEvent[] = [];
  const files = await walkFiles(root, { extensions: [".jsonl"] });

  for (const file of files) {
    if (!file.includes("agent-transcripts")) continue;
    const mtime = await fileMtimeMs(file);
    if (mtime != null && !mtimePossiblyInRange(mtime, range)) continue;

    const sessionId = basename(file, ".jsonl");
    const project = projectFromTranscriptPath(file);
    const isSubagent = file.includes(`${"subagents"}`);

    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let requests = 0;
    const toolMap = new Map();
    let lastTs = mtime ? new Date(mtime) : new Date();

    for await (const row of parseJsonl<Record<string, unknown>>(file)) {
      const role = (row.role as string | undefined) ??
        ((row.message as Record<string, unknown> | undefined)?.role as string | undefined);
      const message = row.message as Record<string, unknown> | undefined;
      const ts = row.timestamp
        ? new Date(row.timestamp as string)
        : lastTs;
      lastTs = ts;

      const explicit = extractUsageTokens(row);
      if (explicit) {
        input += explicit.input ?? 0;
        output += explicit.output ?? 0;
        cacheRead += explicit.cacheRead ?? 0;
        cacheWrite += explicit.cacheWrite ?? 0;
        if (role === "assistant") requests += 1;
        // Still inventory tools below
      }

      const content = message?.content ?? row.content;
      let text = "";
      let toolUseCount = 0;
      let toolPayloadChars = 0;

      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        for (const c of content) {
          if (typeof c === "string") {
            text += c;
            continue;
          }
          if (!c || typeof c !== "object") continue;
          const b = c as Record<string, unknown>;
          if (typeof b.text === "string") text += b.text;

          if (b.type === "tool_use" && typeof b.name === "string") {
            toolUseCount += 1;
            const toolInput = (b.input || b.arguments || {}) as Record<string, unknown>;
            try {
              toolPayloadChars += JSON.stringify(toolInput).length;
            } catch {
              /* ignore */
            }
            if (b.name === "CallMcpTool" || b.name === "call_mcp_tool") {
              const server = String(toolInput.server || toolInput.serverName || "mcp");
              const toolName = String(toolInput.toolName || toolInput.tool || "unknown");
              mergeToolCounts(toolMap, `mcp__${server}__${toolName}`);
            } else {
              mergeToolCounts(toolMap, b.name);
            }
          } else if (
            typeof b.name === "string" &&
            (b.parameters || b.arguments) &&
            b.type !== "tool_use"
          ) {
            mergeToolCounts(toolMap, b.name);
          }
        }
      }

      if (explicit) continue; // tokens already taken from usage block

      const textTokens = estimateTokensFromText(text);
      const toolTokens = toolPayloadChars > 0 ? Math.ceil(toolPayloadChars / 4) : 0;
      const redacted = isRedactedText(text);

      if (role === "assistant") {
        requests += 1;
        if (redacted) {
          // Visible text is useless; use tool payload + floor for the reply
          output += Math.max(toolTokens, REDACTED_OUTPUT_FLOOR);
          if (toolUseCount > 0) {
            input += toolUseCount * TOOL_RESULT_INPUT_FLOOR + TURN_CONTEXT_INPUT_FLOOR;
            input += toolTokens; // Write/StrReplace payloads are real input cost
          } else {
            input += TURN_CONTEXT_INPUT_FLOOR;
          }
        } else {
          output += textTokens;
          // Tool args (e.g. Write contents) count toward the turn
          input += toolTokens;
          if (toolUseCount > 0) {
            // Tool results are almost never in transcripts
            input += toolUseCount * TOOL_RESULT_INPUT_FLOOR;
          }
        }
      } else if (role === "user") {
        if (!redacted) input += textTokens;
        else input += TURN_CONTEXT_INPUT_FLOOR;
      }
    }

    if (input + output === 0 && toolMap.size === 0) continue;
    if (!inRange(lastTs, range)) continue;

    events.push({
      provider: "cursor-agent",
      sessionId: isSubagent ? `sub:${sessionId}` : sessionId,
      project,
      model: "cursor-auto",
      timestamp: lastTs,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      reasoningTokens: 0,
      requestCount: Math.max(1, requests),
      tools: [...toolMap.values()],
      // Transcripts omit tool results / often redact assistant text — always estimated
      estimated: true,
    });
  }

  return events;
}

export const cursorAgentProvider: ProviderInfo = {
  id: "cursor-agent",
  name: "Cursor Agent",
  quality: "estimated",
  detect() {
    const p = cursorProjectsDir();
    return { found: existsSync(p), paths: existsSync(p) ? [p] : [] };
  },
  collect: collectCursorAgent,
};
