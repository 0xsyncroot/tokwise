/**
 * Claude Code adapter
 * Sources: CodeBurn docs/providers/claude.md, Agent Archaeology traces,
 * local ~/.claude/projects/<slug>/<session>.jsonl
 */
import { basename, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import type { DateRange, ProviderInfo, UsageEvent, ToolUse } from "../types.js";
import { claudeConfigDirs } from "./_paths.js";
import {
  mapPool,
  mergeToolCounts,
  parseJsonl,
  walkFiles,
} from "./_shared/io.js";
import { FileParseCache } from "./_shared/cache.js";
import { inRange, mtimePossiblyInRange } from "../dates.js";

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

function projectFromSlug(slug: string): string {
  return slug.replace(/^-/, "").replace(/-/g, "/") || slug;
}

/**
 * Main transcripts:      projects/<slug>/<sessionId>.jsonl
 * Subagent transcripts:  projects/<slug>/<sessionId>/subagents/**\/*.jsonl
 *                        (e.g. subagents/agent-*.jsonl, subagents/workflows/wf_*\/agent-*.jsonl)
 * Subagent usage is real billed API traffic — count it, attributed to the
 * parent session so session rollups stay meaningful.
 */
function sessionInfoFromPath(filePath: string): { sessionId: string; project: string } {
  const parts = filePath.split(/[\\/]/);
  const idx = parts.lastIndexOf("subagents");
  if (idx >= 2) {
    return {
      sessionId: parts[idx - 1],
      project: projectFromSlug(parts[idx - 2]),
    };
  }
  return {
    sessionId: basename(filePath).replace(/\.jsonl$/, ""),
    project: projectFromSlug(basename(dirname(filePath))),
  };
}

function extractTools(content: unknown): ToolUse[] {
  const toolMap = new Map<
    string,
    { name: string; kind: ToolUse["kind"]; count: number; server?: string; skill?: string }
  >();
  if (!Array.isArray(content)) return [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "tool_use" && typeof b.name === "string") {
      const input = (b.input || {}) as Record<string, unknown>;
      const skill =
        typeof input.skill === "string"
          ? input.skill
          : typeof input.name === "string"
            ? input.name
            : undefined;
      mergeToolCounts(toolMap, b.name, { skill });
    }
  }
  return [...toolMap.values()];
}

interface ParsedEntry {
  msgId?: string;
  event: UsageEvent;
}

/**
 * One API response is written as several jsonl lines sharing message.id —
 * one per content block, and streamed lines carry cumulative usage (later
 * lines have larger output_tokens). Billing truth per message = per-field MAX
 * across its lines; tool_use blocks accumulate across lines.
 */
function maxMergeInto(target: UsageEvent, ev: UsageEvent): void {
  target.inputTokens = Math.max(target.inputTokens, ev.inputTokens);
  target.outputTokens = Math.max(target.outputTokens, ev.outputTokens);
  target.cacheReadTokens = Math.max(target.cacheReadTokens, ev.cacheReadTokens);
  target.cacheWriteTokens = Math.max(target.cacheWriteTokens, ev.cacheWriteTokens);
  if (ev.tools.length) target.tools = [...target.tools, ...ev.tools];
}

export async function collectClaude(range: DateRange): Promise<UsageEvent[]> {
  const cache = new FileParseCache("claude-v3");
  const merged: ParsedEntry[] = [];
  // Global across files: resumed/forked sessions replay lines with the same
  // message id into a new file — usage must be counted exactly once.
  const eventByMsgId = new Map<string, UsageEvent>();

  for (const root of claudeConfigDirs()) {
    const projectsDir = join(root, "projects");
    if (!existsSync(projectsDir)) continue;

    const allFiles = await walkFiles(projectsDir, { extensions: [".jsonl"] });
    const files: { file: string; mtimeMs: number; size: number }[] = [];
    for (const file of allFiles.sort()) {
      try {
        const s = await stat(file);
        if (!mtimePossiblyInRange(s.mtimeMs, range)) continue;
        files.push({ file, mtimeMs: s.mtimeMs, size: s.size });
      } catch {
        /* unreadable file */
      }
    }

    // Parse files concurrently; merge below stays deterministic (path order).
    const perFile = await mapPool(files, 12, async ({ file, mtimeMs, size }) => {
      const hit = cache.get<ParsedEntry[]>(file, mtimeMs, size);
      if (hit) {
        for (const e of hit) e.event.timestamp = new Date(e.event.timestamp);
        return hit;
      }

      const { sessionId, project } = sessionInfoFromPath(file);
      const fileEvents: ParsedEntry[] = [];
      const byMsgId = new Map<string, UsageEvent>();

      for await (const row of parseJsonl<Record<string, unknown>>(file, {
        // Only assistant lines carry usage; skip parsing the (huge) rest.
        lineFilter: (line) => line.includes('"input_tokens"'),
      })) {
        const type = row.type as string | undefined;
        const msg = row.message as Record<string, unknown> | undefined;
        if (!msg || (type !== "assistant" && msg.role !== "assistant")) continue;

        const usage = (msg.usage || row.usage) as ClaudeUsage | undefined;
        if (!usage) continue;

        const tsRaw = (row.timestamp as string) || (row.created_at as string);
        const ts = tsRaw ? new Date(tsRaw) : new Date(mtimeMs);

        const ev: UsageEvent = {
          provider: "claude",
          sessionId,
          project,
          model: (msg.model as string) || undefined,
          timestamp: ts,
          inputTokens: usage.input_tokens || 0,
          outputTokens: usage.output_tokens || 0,
          cacheReadTokens: usage.cache_read_input_tokens || 0,
          cacheWriteTokens: usage.cache_creation_input_tokens || 0,
          reasoningTokens: 0,
          requestCount: 1,
          tools: extractTools(msg.content),
        };

        const msgId = msg.id as string | undefined;
        if (msgId) {
          const prev = byMsgId.get(msgId);
          if (prev) {
            maxMergeInto(prev, ev);
            continue;
          }
          byMsgId.set(msgId, ev);
        }
        fileEvents.push({ msgId, event: ev });
      }

      cache.set(file, mtimeMs, size, fileEvents);
      return fileEvents;
    });

    for (const fileEvents of perFile) {
      for (const entry of fileEvents) {
        if (entry.msgId) {
          const prev = eventByMsgId.get(entry.msgId);
          if (prev) {
            maxMergeInto(prev, entry.event);
            continue;
          }
          eventByMsgId.set(entry.msgId, entry.event);
        }
        merged.push(entry);
      }
    }
  }

  cache.save();
  return merged.map((m) => m.event).filter((e) => inRange(e.timestamp, range));
}

export const claudeProvider: ProviderInfo = {
  id: "claude",
  name: "Claude Code",
  quality: "full",
  detect() {
    const paths = claudeConfigDirs()
      .map((d) => join(d, "projects"))
      .filter((p) => existsSync(p));
    return { found: paths.length > 0, paths };
  },
  collect: collectClaude,
};
