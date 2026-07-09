/**
 * Google Antigravity — sessions-only from disk (.pb metadata)
 * Sources: CodeBurn docs/providers/antigravity.md
 * Full tokens require live RPC (not in v1 disk path).
 */
import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import type { DateRange, ProviderInfo, UsageEvent } from "../types.js";
import { antigravityDir } from "./_paths.js";
import { inRange } from "../dates.js";

export async function collectAntigravity(range: DateRange): Promise<UsageEvent[]> {
  const conv = join(antigravityDir(), "conversations");
  if (!existsSync(conv)) return [];

  const events: UsageEvent[] = [];
  let entries;
  try {
    entries = await readdir(conv);
  } catch {
    return [];
  }

  for (const name of entries) {
    if (!name.endsWith(".pb")) continue;
    const file = join(conv, name);
    let st;
    try {
      st = await stat(file);
    } catch {
      continue;
    }
    const ts = st.mtime;
    if (!inRange(ts, range)) continue;
    events.push({
      provider: "antigravity",
      sessionId: basename(name, ".pb"),
      model: "antigravity",
      timestamp: ts,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      requestCount: 1,
      tools: [],
      estimated: true,
    });
  }
  return events;
}

export const antigravityProvider: ProviderInfo = {
  id: "antigravity",
  name: "Google Antigravity",
  quality: "sessions-only",
  detect() {
    const p = join(antigravityDir(), "conversations");
    return { found: existsSync(p), paths: existsSync(p) ? [p] : [] };
  },
  collect: collectAntigravity,
};
