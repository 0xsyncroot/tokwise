/**
 * Gemini CLI sessions
 * Sources: CodeBurn docs/providers/gemini.md
 * promptTokenCount is inclusive of cached — subtract before pricing.
 */
import { basename, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { DateRange, ProviderInfo, UsageEvent } from "../types.js";
import { geminiDir } from "./_paths.js";
import { fileMtimeMs, walkFiles } from "./_shared/io.js";
import { inRange, mtimePossiblyInRange } from "../dates.js";

function extractFromSession(obj: unknown, sessionId: string, ts: Date): UsageEvent | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;

  let input = 0;
  let output = 0;
  let cached = 0;
  let thoughts = 0;
  let model = "gemini";
  let requests = 0;

  const messages = (o.messages || o.history || o.chats || []) as unknown[];
  if (Array.isArray(messages) && messages.length) {
    for (const m of messages) {
      if (!m || typeof m !== "object") continue;
      const msg = m as Record<string, unknown>;
      const usage =
        (msg.usageMetadata as Record<string, number>) ||
        (msg.usage as Record<string, number>) ||
        {};
      const prompt = usage.promptTokenCount || usage.input_tokens || 0;
      const cand = usage.candidatesTokenCount || usage.output_tokens || 0;
      const cache = usage.cachedContentTokenCount || usage.cached_tokens || 0;
      const think = usage.thoughtsTokenCount || 0;
      input += Math.max(0, prompt - cache);
      cached += cache;
      output += cand;
      thoughts += think;
      if (typeof msg.model === "string") model = msg.model;
      if (prompt || cand) requests += 1;
    }
  } else {
    // aggregate fields on root
    const usage = (o.usageMetadata || o.usage || {}) as Record<string, number>;
    const prompt = usage.promptTokenCount || 0;
    const cache = usage.cachedContentTokenCount || 0;
    input = Math.max(0, prompt - cache);
    cached = cache;
    output = usage.candidatesTokenCount || 0;
    thoughts = usage.thoughtsTokenCount || 0;
    requests = 1;
  }

  if (input + output + cached === 0) return null;

  return {
    provider: "gemini",
    sessionId,
    model,
    timestamp: ts,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    reasoningTokens: thoughts,
    requestCount: Math.max(1, requests),
    tools: [],
  };
}

export async function collectGemini(range: DateRange): Promise<UsageEvent[]> {
  const tmp = join(geminiDir(), "tmp");
  if (!existsSync(tmp)) return [];

  const events: UsageEvent[] = [];
  const files = await walkFiles(tmp, { extensions: [".json", ".jsonl"] });

  for (const file of files) {
    if (!basename(file).startsWith("session-")) continue;
    const mtime = await fileMtimeMs(file);
    if (mtime != null && !mtimePossiblyInRange(mtime, range)) continue;
    const ts = mtime ? new Date(mtime) : new Date();
    if (!inRange(ts, range)) continue;

    let raw: string;
    try {
      raw = readFileSync(file, "utf8").trim();
    } catch {
      continue;
    }
    if (!raw) continue;

    const sessionId = basename(file).replace(/\.(json|jsonl)$/, "");
    if (raw.startsWith("[")) {
      try {
        const arr = JSON.parse(raw);
        const ev = extractFromSession({ messages: arr }, sessionId, ts);
        if (ev) events.push(ev);
      } catch {
        /* skip */
      }
    } else if (raw.startsWith("{")) {
      try {
        const obj = JSON.parse(raw);
        const ev = extractFromSession(obj, sessionId, ts);
        if (ev) events.push(ev);
      } catch {
        /* skip */
      }
    } else {
      // jsonl
      const messages: unknown[] = [];
      for (const line of raw.split("\n")) {
        try {
          messages.push(JSON.parse(line));
        } catch {
          /* skip */
        }
      }
      const ev = extractFromSession({ messages }, sessionId, ts);
      if (ev) events.push(ev);
    }
  }

  return events;
}

export const geminiProvider: ProviderInfo = {
  id: "gemini",
  name: "Gemini CLI",
  quality: "full",
  detect() {
    const p = join(geminiDir(), "tmp");
    return { found: existsSync(p), paths: existsSync(p) ? [p] : [] };
  },
  collect: collectGemini,
};
