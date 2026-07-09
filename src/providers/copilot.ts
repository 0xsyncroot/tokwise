/**
 * GitHub Copilot CLI session-state
 * Sources: CodeBurn docs/providers/copilot.md, local ~/.copilot/session-state
 */
import { basename, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import type { DateRange, ProviderInfo, UsageEvent } from "../types.js";
import { copilotDir } from "./_paths.js";
import {
  estimateTokensFromText,
  fileMtimeMs,
  mergeToolCounts,
  parseJsonl,
  walkFiles,
} from "./_shared/io.js";
import { inRange, mtimePossiblyInRange } from "../dates.js";

export async function collectCopilot(range: DateRange): Promise<UsageEvent[]> {
  const root = join(copilotDir(), "session-state");
  if (!existsSync(root)) return [];

  const events: UsageEvent[] = [];
  const files = await walkFiles(root, { extensions: [".jsonl"] });

  for (const file of files) {
    if (!basename(file).includes("events")) continue;
    const mtime = await fileMtimeMs(file);
    if (mtime != null && !mtimePossiblyInRange(mtime, range)) continue;

    const sessionId = basename(dirname(file));
    let output = 0;
    let input = 0;
    let requests = 0;
    const toolMap = new Map();
    let lastTs = mtime ? new Date(mtime) : new Date();
    let model = "copilot";

    for await (const row of parseJsonl<Record<string, unknown>>(file)) {
      const ts = row.timestamp
        ? new Date(row.timestamp as string)
        : row.createdAt
          ? new Date(row.createdAt as string)
          : lastTs;
      lastTs = ts;
      if (!inRange(ts, range)) continue;

      const type = String(row.type || row.kind || "");
      const data = (row.data || row.payload || row) as Record<string, unknown>;

      if (typeof data.model === "string") model = data.model;

      const text =
        (typeof data.content === "string" && data.content) ||
        (typeof data.text === "string" && data.text) ||
        (typeof data.message === "string" && data.message) ||
        "";

      if (/assistant|response|message/i.test(type) && text) {
        output += estimateTokensFromText(text);
        requests += 1;
      } else if (/user|prompt/i.test(type) && text) {
        input += estimateTokensFromText(text);
      }

      const toolName =
        (data.toolName as string) ||
        (data.name as string) ||
        ((data.tool as Record<string, unknown>)?.name as string);
      if (toolName) mergeToolCounts(toolMap, toolName);

      // explicit token fields if present
      const usage = data.usage as Record<string, number> | undefined;
      if (usage) {
        input += usage.input_tokens || usage.prompt_tokens || 0;
        output += usage.output_tokens || usage.completion_tokens || 0;
        requests += 1;
      }
    }

    if (input + output === 0 && toolMap.size === 0) continue;

    events.push({
      provider: "copilot",
      sessionId,
      model,
      timestamp: lastTs,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      requestCount: Math.max(1, requests),
      tools: [...toolMap.values()],
      estimated: true,
    });
  }

  return events;
}

export const copilotProvider: ProviderInfo = {
  id: "copilot",
  name: "GitHub Copilot",
  quality: "estimated",
  detect() {
    const p = join(copilotDir(), "session-state");
    return { found: existsSync(p), paths: existsSync(p) ? [p] : [] };
  },
  collect: collectCopilot,
};
