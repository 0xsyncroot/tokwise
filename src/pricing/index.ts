/**
 * USD per 1M tokens, resolved per provider + model.
 * Override via ~/.config/tokwise/pricing.json (or TOKWISE_PRICING_FILE):
 *   { "models": [{ "match": "gpt-5", "provider": "codex", "rates": { "input": 1.25, ... } }] }
 *
 * Notes on semantics per platform:
 * - Anthropic: cacheRead = 0.1x input, cacheWrite (5m TTL) = 1.25x input.
 * - OpenAI/Codex: cached tokens are a discounted subset of input; no cache-write charge.
 *   `output_tokens` ALREADY INCLUDES reasoning tokens -> reasoningInOutput: true.
 * - Google/Gemini: thoughtsTokenCount is separate from candidatesTokenCount and billed
 *   at the output rate -> reasoning added on top. No cache-write charge (storage billed hourly, ignored).
 * - Antigravity: disk data is sessions-only (no token counts); cost is always $0 unless
 *   a real Gemini model id with tokens ever appears.
 * - Long-context (>200k) Gemini tiers are not modeled.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ModelRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** true when the provider counts reasoning tokens inside outputTokens (OpenAI) */
  reasoningInOutput?: boolean;
}

interface Row {
  match: string;
  rates: ModelRates;
}

const DEFAULT: ModelRates = {
  input: 3,
  output: 15,
  cacheRead: 0.3,
  cacheWrite: 3.75,
};

const ZERO: ModelRates = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const ANTHROPIC_ROWS: Row[] = [
  { match: "claude-fable-5", rates: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } },
  { match: "claude-mythos", rates: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } },
  // Opus 4.5 and later dropped to $5/$25
  { match: "claude-opus-4-8", rates: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
  { match: "claude-opus-4-7", rates: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
  { match: "claude-opus-4-6", rates: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
  { match: "claude-opus-4-5", rates: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
  // Opus 4.0 / 4.1 stay at the legacy $15/$75
  { match: "claude-opus-4-1", rates: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } },
  { match: "claude-opus-4", rates: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } },
  { match: "claude-3-opus", rates: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } },
  { match: "claude-sonnet-5", rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  { match: "claude-sonnet-4", rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  { match: "claude-3-7-sonnet", rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  { match: "claude-3-5-sonnet", rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  { match: "claude-haiku-4-5", rates: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
  { match: "claude-3-5-haiku", rates: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 } },
  { match: "claude-3-haiku", rates: { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.3 } },
  // Generic family fallbacks (assume current generation)
  { match: "opus", rates: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
  { match: "sonnet", rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  { match: "haiku", rates: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
  { match: "claude", rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
];

const oai = (input: number, output: number, cacheRead: number): ModelRates => ({
  input,
  output,
  cacheRead,
  cacheWrite: 0,
  reasoningInOutput: true,
});

const OPENAI_ROWS: Row[] = [
  // GPT-5.5 / 5.4 generation (developers.openai.com/api/docs/pricing, Jul 2026)
  { match: "gpt-5.5-pro", rates: oai(30, 180, 0) },
  { match: "gpt-5.5", rates: oai(5, 30, 0.5) },
  { match: "gpt-5.4-pro", rates: oai(30, 180, 0) },
  { match: "gpt-5.4-mini", rates: oai(0.75, 4.5, 0.075) },
  { match: "gpt-5.4-nano", rates: oai(0.2, 1.25, 0.02) },
  { match: "gpt-5.4", rates: oai(2.5, 15, 0.25) },
  { match: "gpt-5.3-codex", rates: oai(1.75, 14, 0.175) },
  { match: "gpt-5-mini", rates: oai(0.25, 2, 0.025) },
  { match: "gpt-5-nano", rates: oai(0.05, 0.4, 0.005) },
  // covers gpt-5, gpt-5.1, gpt-5.1-codex, gpt-5-codex, ...
  { match: "gpt-5", rates: oai(1.25, 10, 0.125) },
  { match: "gpt-4.1-mini", rates: oai(0.4, 1.6, 0.1) },
  { match: "gpt-4.1-nano", rates: oai(0.1, 0.4, 0.025) },
  { match: "gpt-4.1", rates: oai(2, 8, 0.5) },
  { match: "gpt-4o-mini", rates: oai(0.15, 0.6, 0.075) },
  { match: "gpt-4o", rates: oai(2.5, 10, 1.25) },
  { match: "o3-pro", rates: oai(20, 80, 0) },
  { match: "o3-mini", rates: oai(1.1, 4.4, 0.55) },
  { match: "o3", rates: oai(2, 8, 0.5) },
  { match: "o4-mini", rates: oai(1.1, 4.4, 0.275) },
  { match: "codex-mini", rates: oai(1.5, 6, 0.375) },
  { match: "codex", rates: oai(1.25, 10, 0.125) },
];

const goog = (input: number, output: number, cacheRead: number): ModelRates => ({
  input,
  output,
  cacheRead,
  cacheWrite: 0,
});

const GOOGLE_ROWS: Row[] = [
  // Gemini 3.5 / 3.1 generation (ai.google.dev/gemini-api/docs/pricing, Jul 2026)
  { match: "gemini-3.5-flash", rates: goog(1.5, 9, 0.15) },
  { match: "gemini-3.1-pro", rates: goog(2, 12, 0.2) },
  { match: "gemini-3.1-flash-lite", rates: goog(0.25, 1.5, 0.025) },
  { match: "gemini-3-pro", rates: goog(2, 12, 0.2) },
  { match: "gemini-3-flash", rates: goog(0.5, 3, 0.05) },
  { match: "gemini-2.5-pro", rates: goog(1.25, 10, 0.125) },
  { match: "gemini-2.5-flash-lite", rates: goog(0.1, 0.4, 0.01) },
  { match: "gemini-2.5-flash", rates: goog(0.3, 2.5, 0.03) },
  { match: "gemini-2.0-flash", rates: goog(0.1, 0.4, 0.025) },
  { match: "gemini-1.5-pro", rates: goog(1.25, 5, 0.3125) },
  // Unknown gemini model — assume current Pro generation
  { match: "gemini", rates: goog(2, 12, 0.2) },
];

// Cursor (opaque Auto / Composer — proxy API list prices, not Cursor subscription billing)
const CURSOR_ROWS: Row[] = [
  { match: "cursor-auto", rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  { match: "composer", rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  { match: "cursor", rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
];

const ALL_ROWS: Row[] = [...ANTHROPIC_ROWS, ...OPENAI_ROWS, ...GOOGLE_ROWS, ...CURSOR_ROWS];

/** Table searched first for a given provider id */
const PROVIDER_TABLES: Record<string, Row[]> = {
  claude: ANTHROPIC_ROWS,
  codex: OPENAI_ROWS,
  gemini: GOOGLE_ROWS,
  antigravity: GOOGLE_ROWS,
  "cursor-agent": CURSOR_ROWS,
};

/** Fallback when the model string matches nothing for that provider */
const PROVIDER_DEFAULTS: Record<string, ModelRates> = {
  codex: oai(1.25, 10, 0.125),
  gemini: goog(2, 12, 0.2),
  // sessions-only: no token data on disk, never fabricate a cost
  antigravity: ZERO,
};

// --- user overrides (~/.config/tokwise/pricing.json) ---

interface UserRow extends Row {
  provider?: string;
}

let userRowsCache: UserRow[] | null = null;

function userPricingPath(): string {
  const env = process.env.TOKWISE_PRICING_FILE;
  if (env && env.trim()) return env.trim();
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() ? xdg.trim() : join(homedir(), ".config");
  return join(base, "tokwise", "pricing.json");
}

function loadUserRows(): UserRow[] {
  if (userRowsCache) return userRowsCache;
  userRowsCache = [];
  try {
    const raw = readFileSync(userPricingPath(), "utf8");
    const parsed = JSON.parse(raw) as { models?: UserRow[] };
    if (Array.isArray(parsed.models)) {
      userRowsCache = parsed.models.filter(
        (r) => r && typeof r.match === "string" && r.rates && typeof r.rates.input === "number",
      );
    }
  } catch {
    /* no override file — use built-ins */
  }
  return userRowsCache;
}

/** test hook */
export function resetUserPricingCache(): void {
  userRowsCache = null;
}

// --- resolution ---

function bestMatch(rows: Row[], model: string): ModelRates | null {
  let best: { len: number; rates: ModelRates } | null = null;
  for (const row of rows) {
    if (model.includes(row.match) && (!best || row.match.length > best.len)) {
      best = { len: row.match.length, rates: row.rates };
    }
  }
  return best?.rates ?? null;
}

/** Resolve rates for a provider + model. Provider tables win over the global table; user overrides win over everything. */
export function ratesFor(provider?: string, model?: string): ModelRates {
  const p = provider?.toLowerCase();
  const m = model?.toLowerCase() ?? "";

  const userRows = loadUserRows();
  if (userRows.length && m) {
    const scoped = userRows.filter((r) => !r.provider || r.provider.toLowerCase() === p);
    const hit = bestMatch(scoped, m);
    if (hit) return hit;
  }

  if (m) {
    if (p && PROVIDER_TABLES[p]) {
      const hit = bestMatch(PROVIDER_TABLES[p], m);
      if (hit) return hit;
    }
    const hit = bestMatch(ALL_ROWS, m);
    if (hit) return hit;
  }

  if (p && PROVIDER_DEFAULTS[p]) return PROVIDER_DEFAULTS[p];
  return DEFAULT;
}

/** Back-compat: model-only lookup */
export function ratesForModel(model?: string): ModelRates {
  return ratesFor(undefined, model);
}

export function costUsd(opts: {
  provider?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens?: number;
  rawCost?: number;
}): number {
  if (opts.rawCost != null && opts.rawCost > 0) return opts.rawCost;
  const r = ratesFor(opts.provider, opts.model);
  const perM = 1_000_000;
  let c =
    (opts.inputTokens / perM) * r.input +
    (opts.outputTokens / perM) * r.output +
    (opts.cacheReadTokens / perM) * r.cacheRead +
    (opts.cacheWriteTokens / perM) * r.cacheWrite;
  // OpenAI already counts reasoning inside outputTokens — adding it again would double-bill.
  if (opts.reasoningTokens && !r.reasoningInOutput) {
    c += (opts.reasoningTokens / perM) * r.output;
  }
  return c;
}

export function formatUsd(n: number): string {
  if (n < 0.01 && n > 0) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}
