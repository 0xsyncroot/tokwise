/**
 * Cline — ui_messages.json api_req_started usage
 * Sources: CodeBurn docs/providers/cline.md
 */
import { basename, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { DateRange, ProviderInfo, UsageEvent } from "../types.js";
import { clineDataDir, vscodeGlobalStorage } from "./_paths.js";
import { fileMtimeMs, walkFiles } from "./_shared/io.js";
import { inRange, mtimePossiblyInRange } from "../dates.js";

function taskRoots(): string[] {
  const roots: string[] = [];
  const homeTasks = join(clineDataDir(), "tasks");
  if (existsSync(homeTasks)) roots.push(homeTasks);
  for (const g of vscodeGlobalStorage("saoudrizwan.claude-dev")) {
    const t = join(g, "tasks");
    if (existsSync(t)) roots.push(t);
  }
  return roots;
}

export async function collectCline(range: DateRange): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  const seen = new Set<string>();

  for (const root of taskRoots()) {
    const files = await walkFiles(root, { extensions: [".json"] });
    for (const file of files) {
      if (basename(file) !== "ui_messages.json") continue;
      const taskId = basename(join(file, ".."));
      if (seen.has(taskId)) continue;
      seen.add(taskId);

      const mtime = await fileMtimeMs(file);
      if (mtime != null && !mtimePossiblyInRange(mtime, range)) continue;

      let data: unknown;
      try {
        data = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      const messages = Array.isArray(data) ? data : (data as { messages?: unknown[] })?.messages;
      if (!Array.isArray(messages)) continue;

      let model = "cline";
      for (const m of messages) {
        if (!m || typeof m !== "object") continue;
        const msg = m as Record<string, unknown>;
        if (msg.type === "say" && msg.say === "api_req_started") {
          const ts = msg.ts
            ? new Date(msg.ts as number)
            : msg.timestamp
              ? new Date(msg.timestamp as string)
              : mtime
                ? new Date(mtime)
                : new Date();
          if (!inRange(ts, range)) continue;

          let text = msg.text;
          let parsed: Record<string, unknown> = {};
          if (typeof text === "string") {
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = {};
            }
          } else if (text && typeof text === "object") {
            parsed = text as Record<string, unknown>;
          }

          const tokensIn = Number(parsed.tokensIn || parsed.inputTokens || 0);
          const tokensOut = Number(parsed.tokensOut || parsed.outputTokens || 0);
          const cacheWrites = Number(parsed.cacheWrites || parsed.cacheCreationInputTokens || 0);
          const cacheReads = Number(parsed.cacheReads || parsed.cacheReadInputTokens || 0);
          if (typeof parsed.model === "string") model = parsed.model;

          if (tokensIn + tokensOut + cacheWrites + cacheReads === 0) continue;

          events.push({
            provider: "cline",
            sessionId: taskId,
            model,
            timestamp: ts,
            inputTokens: tokensIn,
            outputTokens: tokensOut,
            cacheReadTokens: cacheReads,
            cacheWriteTokens: cacheWrites,
            reasoningTokens: 0,
            requestCount: 1,
            tools: [],
          });
        }
      }
    }
  }

  return events;
}

export const clineProvider: ProviderInfo = {
  id: "cline",
  name: "Cline",
  quality: "full",
  detect() {
    const paths = taskRoots();
    return { found: paths.length > 0, paths };
  },
  collect: collectCline,
};
