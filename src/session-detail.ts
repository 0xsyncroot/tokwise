/**
 * Enrich SessionSummary with review details loaded from real transcript files:
 * per-turn prompts, AI action summary, assistant output, thinking estimates,
 * model tags, and session title.
 *
 * Usage/token/tool aggregates already come from collectors; this pass only
 * re-reads transcripts for human-readable analysis context.
 */
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { SessionSummary, SessionTurnDetail } from "./types.js";
import { claudeConfigDirs, cursorProjectsDir } from "./providers/_paths.js";
import { parseJsonl, walkFiles } from "./providers/_shared/io.js";

const MAX_TURNS = 12;
const MAX_PROMPT_CHARS = 700;
const MAX_OUTPUT_CHARS = 500;
const MAX_ACTION_CHARS = 220;
/** Floor when a thinking block exists but body is redacted/empty */
const THINKING_BLOCK_FLOOR = 800;

function stripTags(s: string): string {
  return s
    .replace(/<\/?user_query>/gi, "")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanPromptBody(raw: string): string {
  let s = raw;
  s = s.replace(/\[Image:[^\]]*\]/gi, " ");
  s = s.replace(/\[Image\s*#\d+\]/gi, " ");
  if (/^Base directory for this skill:/i.test(s.trim())) {
    const parts = s.split(/\n\s*\n/);
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i].trim();
      if (p && !/^#\s*Feature Wave:/i.test(p) && p.length > 20) {
        s = p;
        break;
      }
    }
  }
  if (/^#\s*Feature Wave:/i.test(s.trim())) {
    const m = s.match(/Feature Wave:\s*([\s\S]+)/i);
    if (m) s = m[1];
  }
  return stripTags(s);
}

function extractUserQuery(text: string): string | null {
  const m = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (m) return cleanPromptBody(m[1]);
  return null;
}

function looksLikeNoise(text: string): boolean {
  const t = text.trim();
  if (t.length < 2) return true;
  if (t === "[REDACTED]" || t === "REDACTED") return true;
  if (/^\{[\s\S]*"level"\s*:/.test(t) && t.includes("metering")) return true;
  if ((t.match(/\{"level":/g) || []).length >= 2) return true;
  if (/^<[a-z-]+>/.test(t) && !/<user_query>/i.test(t) && t.length < 80) return true;
  if (/^Base directory for this skill:/i.test(t)) return true;
  if (/^#\s*Feature Wave:/i.test(t) && /Base directory|SKILL\.md/i.test(t)) return true;
  if (/^(\[Image[^\]]*\]\s*)+$/i.test(t)) return true;
  if (/\btoolu_[A-Za-z0-9]+\b/.test(t)) return true;
  if (/\/tmp\/claude-0\//i.test(t) && /\.output\b/i.test(t)) return true;
  if (/^\/tmp\/claude-/i.test(t)) return true;
  if (/<(command-message|command-name|local-command)/i.test(t) && !/<user_query>/i.test(t)) {
    return true;
  }
  if (/^\/model\b/i.test(t)) return true;
  if (/^Set model to\b/i.test(t)) return true;
  if (/^\[Request interrupted/i.test(t)) return true;
  if (/^Caveat:\s*The messages below were generated/i.test(t)) return true;
  if (/^Another Claude session sent a message:/i.test(t)) return true;
  if (/^You are (the lead orchestrator|cross-audit agent|an INDEPENDENT)/i.test(t)) return true;
  return false;
}

function normalizePrompt(raw: string): string | null {
  const fromQuery = extractUserQuery(raw);
  const text = fromQuery ?? cleanPromptBody(raw);
  if (!text || looksLikeNoise(text)) return null;
  if (!fromQuery && text.length > 600 && /^#\s|Base directory|SKILL\.md/i.test(text)) {
    return null;
  }
  if (text.length > MAX_PROMPT_CHARS) return text.slice(0, MAX_PROMPT_CHARS - 1) + "…";
  return text;
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  return t.slice(0, n - 1) + "…";
}

function estTokensFromChars(chars: number): number {
  return chars > 0 ? Math.max(1, Math.ceil(chars / 4)) : 0;
}

function shortModelName(model?: string): string {
  if (!model) return "";
  return model
    .replace(/^claude-/, "")
    .replace(/^gpt-/, "gpt-")
    .replace(/-20\d{6}$/, "");
}

interface PathIndex {
  claude: Map<string, string>;
  cursor: Map<string, string>;
  cursorSub: Map<string, string>;
}

async function buildPathIndex(): Promise<PathIndex> {
  const claude = new Map<string, string>();
  const cursor = new Map<string, string>();
  const cursorSub = new Map<string, string>();

  for (const root of claudeConfigDirs()) {
    const projects = join(root, "projects");
    if (!existsSync(projects)) continue;
    const files = await walkFiles(projects, { extensions: [".jsonl"] });
    for (const f of files) {
      if (f.includes(`${"subagents"}`)) continue;
      const id = basename(f, ".jsonl");
      if (!claude.has(id)) claude.set(id, f);
    }
  }

  const croot = cursorProjectsDir();
  if (existsSync(croot)) {
    const files = await walkFiles(croot, { extensions: [".jsonl"] });
    for (const f of files) {
      if (!f.includes("agent-transcripts")) continue;
      const id = basename(f, ".jsonl");
      if (f.includes(`${"subagents"}`)) {
        if (!cursorSub.has(id)) cursorSub.set(id, f);
      } else if (!cursor.has(id)) {
        cursor.set(id, f);
      }
    }
  }

  return { claude, cursor, cursorSub };
}

function resolveFromIndex(s: SessionSummary, idx: PathIndex): string | undefined {
  if (s.sourcePath && existsSync(s.sourcePath)) return s.sourcePath;
  const id = s.sessionId.replace(/^sub:/, "");
  if (s.provider === "claude") return idx.claude.get(id);
  if (s.provider === "cursor-agent") {
    if (s.sessionId.startsWith("sub:")) return idx.cursorSub.get(id) || idx.cursor.get(id);
    return idx.cursor.get(id);
  }
  return undefined;
}

function contentToUserText(content: unknown): { text: string; hasToolResult: boolean } {
  let text = "";
  let hasToolResult = false;
  if (typeof content === "string") return { text: content, hasToolResult: false };
  if (!Array.isArray(content)) return { text: "", hasToolResult: false };
  for (const c of content) {
    if (typeof c === "string") {
      text += (text ? "\n" : "") + c;
      continue;
    }
    if (!c || typeof c !== "object") continue;
    const b = c as Record<string, unknown>;
    if (b.type === "tool_result") hasToolResult = true;
    if (typeof b.text === "string") text += (text ? "\n" : "") + b.text;
  }
  return { text, hasToolResult };
}

interface AssistantParsed {
  model?: string;
  texts: string[];
  tools: string[];
  thinkingBlocks: number;
  thinkingChars: number;
  thinkingRedacted: boolean;
  /** output_tokens from usage when message is thinking-heavy / available */
  usageOutputTokens: number;
  thinkingOnly: boolean;
}

function parseAssistantContent(
  content: unknown,
  usage?: Record<string, unknown> | null,
): AssistantParsed {
  const out: AssistantParsed = {
    texts: [],
    tools: [],
    thinkingBlocks: 0,
    thinkingChars: 0,
    thinkingRedacted: false,
    usageOutputTokens: 0,
    thinkingOnly: false,
  };
  if (usage && typeof usage.output_tokens === "number") {
    out.usageOutputTokens = usage.output_tokens;
  }
  if (!Array.isArray(content)) {
    if (typeof content === "string" && content.trim() && content.trim() !== "[REDACTED]") {
      out.texts.push(content.trim());
    }
    return out;
  }
  let hasText = false;
  let hasTool = false;
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    const b = c as Record<string, unknown>;
    const type = b.type as string | undefined;
    if (type === "text" && typeof b.text === "string") {
      const t = b.text.trim();
      if (t && t !== "[REDACTED]") {
        out.texts.push(t);
        hasText = true;
      } else if (t === "[REDACTED]") {
        hasText = true; // present but redacted
      }
    } else if (type === "tool_use" && typeof b.name === "string") {
      out.tools.push(b.name);
      hasTool = true;
    } else if (type === "thinking" || type === "redacted_thinking" || type === "reasoning") {
      out.thinkingBlocks += 1;
      const body =
        (typeof b.thinking === "string" && b.thinking) ||
        (typeof b.text === "string" && b.text) ||
        (typeof b.content === "string" && b.content) ||
        "";
      if (body) out.thinkingChars += body.length;
      else out.thinkingRedacted = true;
    }
  }
  out.thinkingOnly = out.thinkingBlocks > 0 && !hasText && !hasTool;
  return out;
}

function mergeToolCounts(names: string[]): Array<{ name: string; count: number }> {
  const map = new Map<string, number>();
  for (const n of names) map.set(n, (map.get(n) || 0) + 1);
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

function describeAiAction(opts: {
  langHint?: "en" | "vi";
  output?: string;
  tools: Array<{ name: string; count: number }>;
  thinkingBlocks: number;
  thinkingTokensEst: number;
  model?: string;
}): string {
  const parts: string[] = [];
  if (opts.output) {
    // First sentence / clause of the assistant reply = best "what AI did"
    const first = opts.output.split(/(?<=[.!?。…])\s+|\n+/)[0] || opts.output;
    parts.push(truncate(first, 140));
  }
  if (opts.tools.length) {
    const top = opts.tools
      .slice(0, 5)
      .map((t) => (t.count > 1 ? `${t.name}×${t.count}` : t.name))
      .join(", ");
    const total = opts.tools.reduce((a, t) => a + t.count, 0);
    parts.push(`Tools (${total}): ${top}`);
  }
  if (opts.thinkingBlocks > 0) {
    parts.push(
      `Thinking: ${opts.thinkingBlocks} block(s) ≈ ${opts.thinkingTokensEst.toLocaleString()} tok`,
    );
  }
  if (!parts.length) {
    if (opts.model) {
      return `No assistant reply captured for ${shortModelName(opts.model)}`;
    }
    return "No assistant reply captured for this prompt";
  }
  return truncate(parts.join(" · "), MAX_ACTION_CHARS);
}

interface RawTurn {
  promptRaw: string;
  prompt: string | null;
  model?: string;
  tools: string[];
  texts: string[];
  thinkingBlocks: number;
  thinkingChars: number;
  thinkingRedacted: boolean;
  thinkingTokensFromUsage: number;
  assistantMessages: number;
}

async function extractSessionReview(
  file: string,
  kind: "claude" | "cursor",
): Promise<{
  title?: string;
  userTurns: number;
  turns: SessionTurnDetail[];
  thinkingBlocks: number;
  thinkingTokensEst: number;
}> {
  let title: string | undefined;
  const rawTurns: RawTurn[] = [];
  let cur: RawTurn | null = null;
  let userTurns = 0;

  const flush = () => {
    if (cur) rawTurns.push(cur);
    cur = null;
  };

  for await (const row of parseJsonl<Record<string, unknown>>(file)) {
    // Claude ai-title
    if (kind === "claude" && row.type === "ai-title" && typeof row.aiTitle === "string") {
      title = row.aiTitle;
    }

    let role: string | undefined;
    let content: unknown;
    let model: string | undefined;
    let usage: Record<string, unknown> | null = null;

    if (kind === "claude") {
      const msg = row.message as Record<string, unknown> | undefined;
      role = (msg?.role as string) || (row.type as string);
      content = msg?.content;
      model = typeof msg?.model === "string" ? msg.model : undefined;
      usage = (msg?.usage || row.usage) as Record<string, unknown> | null;
    } else {
      role =
        (row.role as string | undefined) ??
        ((row.message as Record<string, unknown> | undefined)?.role as string | undefined);
      const message = row.message as Record<string, unknown> | undefined;
      content = message?.content ?? row.content;
      model =
        (typeof message?.model === "string" && message.model) ||
        (typeof row.model === "string" && row.model) ||
        undefined;
      usage = (message?.usage || row.usage) as Record<string, unknown> | null;
    }

    if (role === "user") {
      const { text, hasToolResult } = contentToUserText(content);
      if (hasToolResult && !/<user_query>/i.test(text)) continue;
      if (!text.trim()) continue;
      userTurns += 1;
      flush();
      const prompt = normalizePrompt(text);
      cur = {
        promptRaw: text,
        prompt,
        tools: [],
        texts: [],
        thinkingBlocks: 0,
        thinkingChars: 0,
        thinkingRedacted: false,
        thinkingTokensFromUsage: 0,
        assistantMessages: 0,
      };
      continue;
    }

    if (role === "assistant" && cur) {
      const parsed = parseAssistantContent(content, usage);
      cur.assistantMessages += 1;
      if (model) cur.model = model;
      cur.tools.push(...parsed.tools);
      cur.texts.push(...parsed.texts);
      cur.thinkingBlocks += parsed.thinkingBlocks;
      cur.thinkingChars += parsed.thinkingChars;
      if (parsed.thinkingRedacted) cur.thinkingRedacted = true;
      // Thinking-only assistant lines: usage.output_tokens ≈ thinking tokens
      if (parsed.thinkingOnly && parsed.usageOutputTokens > 0) {
        cur.thinkingTokensFromUsage += parsed.usageOutputTokens;
      } else if (parsed.thinkingBlocks > 0 && parsed.usageOutputTokens > 0 && !parsed.texts.length) {
        cur.thinkingTokensFromUsage += parsed.usageOutputTokens;
      }
    }
  }
  flush();

  const turns: SessionTurnDetail[] = [];
  let thinkingBlocks = 0;
  let thinkingTokensEst = 0;

  for (const rt of rawTurns) {
    if (!rt.prompt && rt.assistantMessages === 0) continue;
    // Skip pure-noise user turns with no AI work
    if (!rt.prompt && !rt.tools.length && !rt.texts.length && !rt.thinkingBlocks) continue;
    // Skip noise prompts that never got a real assistant reply
    if (!rt.prompt && rt.assistantMessages > 0 && !rt.tools.length && !rt.texts.length && !rt.thinkingBlocks) {
      continue;
    }

    const tools = mergeToolCounts(rt.tools);
    let thinkTok = rt.thinkingTokensFromUsage;
    if (!thinkTok && rt.thinkingChars > 0) thinkTok = estTokensFromChars(rt.thinkingChars);
    if (!thinkTok && rt.thinkingBlocks > 0) {
      thinkTok = rt.thinkingBlocks * THINKING_BLOCK_FLOOR;
    }

    const output = rt.texts.length ? truncate(rt.texts[0], MAX_OUTPUT_CHARS) : undefined;
    const outputTokensEst = estTokensFromChars(rt.texts.join("\n").length);

    // Prefer real cleaned prompts; demote follow-ups without prompt text
    const promptText =
      rt.prompt ||
      (rt.tools.length || output || rt.thinkingBlocks
        ? truncate(cleanPromptBody(rt.promptRaw), MAX_PROMPT_CHARS) || "(continued — no new user text)"
        : null);
    if (!promptText) continue;

    const turn: SessionTurnDetail = {
      index: turns.length + 1,
      prompt: promptText,
      model: rt.model,
      aiAction: describeAiAction({
        output,
        tools,
        thinkingBlocks: rt.thinkingBlocks,
        thinkingTokensEst: thinkTok,
        model: rt.model,
      }),
      output,
      tools,
      thinkingBlocks: rt.thinkingBlocks,
      thinkingTokensEst: thinkTok,
      thinkingRedacted: rt.thinkingRedacted && rt.thinkingChars === 0,
      outputTokensEst,
      assistantMessages: rt.assistantMessages,
    };

    if (turns.length < MAX_TURNS) turns.push(turn);
    thinkingBlocks += rt.thinkingBlocks;
    thinkingTokensEst += thinkTok;
  }

  // Prefer turns that have cleaned prompts first in display order already chronological
  return { title, userTurns, turns, thinkingBlocks, thinkingTokensEst };
}

/** Resolve transcript path for a session (claude / cursor-agent). */
export async function resolveSessionSourcePath(s: SessionSummary): Promise<string | undefined> {
  const idx = await buildPathIndex();
  return resolveFromIndex(s, idx);
}

/**
 * Load turn-level review details from disk into each session (mutates in place).
 */
export async function enrichSessionDetails(
  sessions: SessionSummary[],
  opts: { limit?: number } = {},
): Promise<void> {
  const limit = opts.limit ?? sessions.length;
  const targets = sessions.slice(0, limit);
  if (!targets.length) return;

  const idx = await buildPathIndex();
  const concurrency = 6;
  let i = 0;

  async function worker() {
    while (i < targets.length) {
      const idxN = i++;
      const s = targets[idxN];
      try {
        const path = resolveFromIndex(s, idx);
        if (!path) continue;
        s.sourcePath = path;
        const kind =
          s.provider === "cursor-agent" ? "cursor" : s.provider === "claude" ? "claude" : null;
        if (!kind) continue;
        const review = await extractSessionReview(path, kind);
        s.title = review.title;
        s.userTurns = review.userTurns;
        s.turns = review.turns;
        s.prompts = review.turns.map((t) => t.prompt).filter(Boolean);
        s.thinkingBlocks = review.thinkingBlocks;
        s.thinkingTokensEst = review.thinkingTokensEst;
        // Prefer transcript models when usage events lacked them
        const turnModels = [...new Set(review.turns.map((t) => t.model).filter(Boolean) as string[])];
        if (turnModels.length) {
          for (const m of turnModels) {
            if (!s.models.includes(m)) s.models.push(m);
          }
          s.models.sort();
          if (!s.model) s.model = turnModels[turnModels.length - 1];
        }
      } catch {
        /* best-effort */
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()));
}

/** Short display path for UI */
export function shortSourcePath(p?: string): string {
  if (!p) return "—";
  const parts = p.replace(/\\/g, "/").split("/");
  return parts.slice(-3).join("/");
}

export function formatModelTag(model?: string): string {
  return shortModelName(model) || "—";
}
