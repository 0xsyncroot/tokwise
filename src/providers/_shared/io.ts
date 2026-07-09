import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export const CHARS_PER_TOKEN = 4;

export function estimateTokensFromText(text: string | undefined | null): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Stream non-empty lines from a jsonl file.
 * Manual chunk splitting (4MB reads) — measurably faster than readline on
 * multi-hundred-MB transcript trees.
 */
export async function* readJsonlLines(filePath: string): AsyncGenerator<string> {
  const stream = createReadStream(filePath, { encoding: "utf8", highWaterMark: 1 << 22 });
  let carry = "";
  for await (const chunk of stream) {
    const data = carry ? carry + (chunk as string) : (chunk as string);
    let start = 0;
    let idx: number;
    while ((idx = data.indexOf("\n", start)) !== -1) {
      const line = data.slice(start, idx).trim();
      if (line) yield line;
      start = idx + 1;
    }
    carry = data.slice(start);
  }
  const tail = carry.trim();
  if (tail) yield tail;
}

export async function* parseJsonl<T = unknown>(
  filePath: string,
  opts: {
    /** cheap substring test run BEFORE JSON.parse — skip lines that can't matter */
    lineFilter?: (line: string) => boolean;
  } = {},
): AsyncGenerator<T> {
  const { lineFilter } = opts;
  for await (const line of readJsonlLines(filePath)) {
    if (lineFilter && !lineFilter(line)) continue;
    try {
      yield JSON.parse(line) as T;
    } catch {
      // skip corrupt lines
    }
  }
}

/** Run `fn` over items with bounded concurrency, preserving order of results. */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function walkFiles(
  root: string,
  opts: { extensions?: string[]; maxDepth?: number } = {},
): Promise<string[]> {
  const { extensions, maxDepth = 12 } = opts;
  const out: string[] = [];

  async function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        await walk(p, depth + 1);
      } else if (e.isFile()) {
        if (!extensions || extensions.some((ext) => e.name.endsWith(ext))) {
          out.push(p);
        }
      }
    }
  }

  await walk(root, 0);
  return out;
}

export async function fileMtimeMs(path: string): Promise<number | null> {
  try {
    const s = await stat(path);
    return s.mtimeMs;
  } catch {
    return null;
  }
}

export function classifyTool(name: string): {
  kind: "system" | "mcp" | "user" | "skill";
  server?: string;
  skill?: string;
} {
  if (name === "Skill" || name.toLowerCase() === "skill") {
    return { kind: "skill" };
  }
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    return { kind: "mcp", server: parts[1] || "unknown" };
  }
  // Built-in agent tools (Claude + Cursor + common)
  const system = new Set([
    "Bash",
    "Shell",
    "Read",
    "Edit",
    "Write",
    "StrReplace",
    "Delete",
    "Grep",
    "Glob",
    "Agent",
    "Task",
    "WebSearch",
    "WebFetch",
    "ToolSearch",
    "AskUserQuestion",
    "AskQuestion",
    "TodoWrite",
    "NotebookEdit",
    "KillShell",
    "ListMcpResources",
    "ReadMcpResource",
    "CallMcpTool",
    "GetMcpTools",
    "FetchMcpResource",
    "CreatePlan",
    "SwitchMode",
    "AwaitShell",
    "EditNotebook",
    "GenerateImage",
    "TaskOutput",
    "TaskCreate",
    "TaskUpdate",
    "TaskList",
    "TaskStop",
    "SendMessage",
    "Workflow",
    "Monitor",
    "ScheduleWakeup",
    "Artifact",
    "DesignSync",
  ]);
  if (system.has(name) || name.startsWith("browser_")) return { kind: "system" };
  return { kind: "user" };
}

export function mergeToolCounts(
  into: Map<string, { name: string; kind: "system" | "mcp" | "user" | "skill"; count: number; server?: string; skill?: string }>,
  name: string,
  extra?: { skill?: string },
  count = 1,
) {
  const cls = classifyTool(name);
  const key = cls.kind === "mcp" ? `mcp:${cls.server}:${name}` : cls.kind === "skill" ? `skill:${extra?.skill || name}` : name;
  const prev = into.get(key);
  if (prev) {
    prev.count += count;
  } else {
    into.set(key, {
      name,
      kind: cls.kind,
      count,
      server: cls.server,
      skill: extra?.skill,
    });
  }
}
