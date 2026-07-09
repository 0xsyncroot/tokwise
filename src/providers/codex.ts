/**
 * OpenAI Codex CLI adapter
 * Sources: CodeBurn docs/providers/codex.md, Agent Archaeology,
 * local ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *
 * Quirks: OpenAI counts cached tokens inside input_tokens — subtract them.
 * Prefer last_token_usage; else delta total_token_usage.
 */
import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import type { DateRange, ProviderInfo, UsageEvent, ToolUse } from "../types.js";
import { codexDir } from "./_paths.js";
import { mapPool, mergeToolCounts, parseJsonl, walkFiles } from "./_shared/io.js";
import { FileParseCache } from "./_shared/cache.js";
import { inRange, mtimePossiblyInRange } from "../dates.js";

interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  reasoning_output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_write_input_tokens?: number;
}

function sessionIdFromRollout(file: string): string {
  // rollout-2026-05-17T00-49-49-019e3369-2494-7cf2-a428-b7d1374bed3e.jsonl
  const base = basename(file, ".jsonl");
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(base);
  return m ? m[1] : base;
}

function normalizeUsage(u: TokenUsage | undefined): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
} | null {
  if (!u) return null;
  const cacheRead = u.cached_input_tokens || u.cache_read_input_tokens || 0;
  const cacheWrite = u.cache_write_input_tokens || 0;
  let input = u.input_tokens || 0;
  // OpenAI: cached counted inside input — subtract for Anthropic-like semantics
  if (cacheRead > 0 && input >= cacheRead) input -= cacheRead;
  return {
    input,
    output: u.output_tokens || 0,
    cacheRead,
    cacheWrite,
    reasoning: u.reasoning_output_tokens || 0,
  };
}

export async function collectCodex(range: DateRange): Promise<UsageEvent[]> {
  const root = join(codexDir(), "sessions");
  if (!existsSync(root)) return [];

  const cache = new FileParseCache("codex-v2");
  const allFiles = await walkFiles(root, { extensions: [".jsonl"] });
  const files: { file: string; mtimeMs: number; size: number }[] = [];
  for (const file of allFiles.sort()) {
    if (!basename(file).startsWith("rollout-")) continue;
    try {
      const s = await stat(file);
      if (!mtimePossiblyInRange(s.mtimeMs, range)) continue;
      files.push({ file, mtimeMs: s.mtimeMs, size: s.size });
    } catch {
      /* unreadable file */
    }
  }

  const perFile = await mapPool(files, 12, async ({ file, mtimeMs, size }) => {
    const hit = cache.get<UsageEvent[]>(file, mtimeMs, size);
    if (hit) {
      for (const e of hit) e.timestamp = new Date(e.timestamp);
      return hit;
    }
    const mtime = mtimeMs;
    const sessionId = sessionIdFromRollout(file);
    let model: string | undefined;
    let project: string | undefined;
    let prevTotal: TokenUsage | null = null;
    let valid = false;
    // Forked / subagent rollouts replay the parent session's history (thousands of
    // token_count rows dumped in <1s) before the fork's own first turn_context.
    // That usage is already counted in the parent's rollout — skip it or we double-bill.
    let isFork = false;
    let seenTurnContext = false;
    const fileEvents: UsageEvent[] = [];

    // Peek first line for session_meta
    let first = true;
    for await (const row of parseJsonl<Record<string, unknown>>(file, {
      // Only these row kinds feed usage/model/tool extraction — skip parsing the rest.
      lineFilter: (line) =>
        line.includes("session_meta") ||
        line.includes("turn_context") ||
        line.includes("token_count") ||
        line.includes("task_complete") ||
        line.includes("function_call") ||
        line.includes('"usage"'),
    })) {
      if (first) {
        first = false;
        const type = row.type as string | undefined;
        const payload = (row.payload || {}) as Record<string, unknown>;
        if (type === "session_meta") {
          const originator = String(payload.originator || "").toLowerCase();
          if (originator && !originator.includes("codex")) {
            // skip non-codex
            break;
          }
          valid = true;
          isFork =
            payload.forked_from_id != null ||
            (typeof payload.source === "object" &&
              payload.source != null &&
              (payload.source as Record<string, unknown>).subagent != null);
          model = (payload.model as string) || model;
          project = (payload.cwd as string) || (payload.workspace as string) || project;
        } else {
          // Some older files may not start with session_meta — still try
          valid = true;
        }
      }
      if (!valid && !first) break;

      const type = row.type as string | undefined;
      const payload = (row.payload || row) as Record<string, unknown>;
      const ts = row.timestamp ? new Date(row.timestamp as string) : mtime ? new Date(mtime) : new Date();

      if (type === "turn_context") seenTurnContext = true;

      // model updates (session_meta rarely carries it; turn_context.payload.model does)
      if (payload.model && typeof payload.model === "string") model = payload.model;

      // replayed parent history in a forked rollout — not this session's usage
      if (isFork && !seenTurnContext) continue;

      // function_call tools
      const toolMap = new Map<
        string,
        { name: string; kind: ToolUse["kind"]; count: number; server?: string; skill?: string }
      >();
      const pType = payload.type as string | undefined;
      if (pType === "function_call" || type === "function_call") {
        const name = (payload.name as string) || (payload.tool_name as string);
        if (name) mergeToolCounts(toolMap, name);
      }

      // token_count event
      let usage: ReturnType<typeof normalizeUsage> = null;
      if (
        type === "event_msg" &&
        (payload.type === "token_count" || payload.type === "task_complete")
      ) {
        const info = (payload.info || payload) as Record<string, unknown>;
        const last = normalizeUsage(info.last_token_usage as TokenUsage);
        if (last) {
          usage = last;
        } else {
          const total = info.total_token_usage as TokenUsage | undefined;
          const cur = normalizeUsage(total);
          if (cur && prevTotal) {
            const prev = normalizeUsage(prevTotal)!;
            usage = {
              input: Math.max(0, cur.input - prev.input),
              output: Math.max(0, cur.output - prev.output),
              cacheRead: Math.max(0, cur.cacheRead - prev.cacheRead),
              cacheWrite: Math.max(0, cur.cacheWrite - prev.cacheWrite),
              reasoning: Math.max(0, cur.reasoning - prev.reasoning),
            };
          } else if (cur) {
            usage = cur;
          }
          if (total) prevTotal = total;
        }
        if (info.last_token_usage) {
          // also track cumulative if present
          if (info.total_token_usage) prevTotal = info.total_token_usage as TokenUsage;
        }
      }

      // Also check response_item with usage
      if (!usage && payload.usage) {
        usage = normalizeUsage(payload.usage as TokenUsage);
      }

      if (!usage) {
        // still record tools if any? skip orphan tools without usage
        continue;
      }
      if (usage.input + usage.output + usage.cacheRead + usage.cacheWrite === 0) continue;

      fileEvents.push({
        provider: "codex",
        sessionId,
        project,
        model,
        timestamp: ts,
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
        reasoningTokens: usage.reasoning,
        requestCount: 1,
        tools: [...toolMap.values()],
      });
    }

    // Backfill: usage rows can precede the turn_context that names the model.
    if (model) {
      for (const ev of fileEvents) if (!ev.model) ev.model = model;
    }
    cache.set(file, mtimeMs, size, fileEvents);
    return fileEvents;
  });

  cache.save();
  return perFile.flat().filter((e) => inRange(e.timestamp, range));
}

export const codexProvider: ProviderInfo = {
  id: "codex",
  name: "Codex CLI",
  quality: "full",
  detect() {
    const p = join(codexDir(), "sessions");
    return { found: existsSync(p), paths: existsSync(p) ? [p] : [] };
  },
  collect: collectCodex,
};
