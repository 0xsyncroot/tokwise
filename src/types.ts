export type Lang = "en" | "vi";

export type DataQuality = "full" | "estimated" | "sessions-only" | "stub";

export type ToolKind = "system" | "mcp" | "user" | "skill";

export interface ToolUse {
  name: string;
  kind: ToolKind;
  count: number;
  /** MCP server id when kind=mcp */
  server?: string;
  /** Skill name when kind=skill */
  skill?: string;
}

export interface UsageEvent {
  provider: string;
  sessionId: string;
  project?: string;
  model?: string;
  timestamp: Date;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  requestCount: number;
  tools: ToolUse[];
  systemPromptTokens?: number;
  rawCost?: number;
  /** true when tokens were estimated from text length */
  estimated?: boolean;
}

export interface DateRange {
  from: Date;
  to: Date;
  label: string;
  all: boolean;
}

export interface ProviderInfo {
  id: string;
  name: string;
  quality: DataQuality;
  /** Resolve whether data exists and return path(s) */
  detect: () => { found: boolean; paths: string[] };
  /** Parse usage events in range (inclusive local-day bounds) */
  collect: (range: DateRange) => Promise<UsageEvent[]>;
}

export interface SessionTurnDetail {
  index: number;
  /** Cleaned user prompt for this turn */
  prompt: string;
  /** Model that answered this turn (from assistant messages) */
  model?: string;
  /** Short human-readable description of what the AI did */
  aiAction: string;
  /** First meaningful assistant text reply (may be missing if redacted) */
  output?: string;
  /** Tools used while answering this prompt */
  tools: Array<{ name: string; count: number }>;
  /** Number of thinking/reasoning blocks observed */
  thinkingBlocks: number;
  /**
   * Estimated thinking/reasoning tokens for this turn.
   * Prefer usage.output_tokens on thinking-only messages; else chars/4; else block floor.
   */
  thinkingTokensEst: number;
  /** True when thinking blocks exist but body text is empty/redacted */
  thinkingRedacted: boolean;
  /** Estimated visible output text tokens (chars/4) */
  outputTokensEst: number;
  assistantMessages: number;
}

export interface SessionSummary {
  provider: string;
  sessionId: string;
  project?: string;
  model?: string;
  /** distinct models seen in this session (mixed-model sessions are priced per event) */
  models: string[];
  /** per-model cost/tokens within this session (from usage events) */
  modelBreakdown: ModelSummary[];
  start: Date;
  end: Date;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
  tools: ToolUse[];
  systemPromptTokens: number;
  estimated: boolean;
  /** Absolute path to the primary transcript file when known */
  sourcePath?: string;
  /** @deprecated prefer turns[].prompt — kept for simple lists */
  prompts: string[];
  /** Count of user turns (non-tool-result) seen in the transcript */
  userTurns: number;
  /** Auto title from transcript (e.g. Claude ai-title) when present */
  title?: string;
  /** Per-prompt review cards loaded from the real transcript */
  turns: SessionTurnDetail[];
  /** Session-level thinking block count */
  thinkingBlocks: number;
  /** Session-level estimated thinking tokens */
  thinkingTokensEst: number;
}

export interface ModelSummary {
  provider: string;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** input + output + cacheRead + cacheWrite */
  tokens: number;
  costUsd: number;
  estimated: boolean;
}

export interface ProviderSummary {
  provider: string;
  sessions: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
  estimated: boolean;
  /** cacheRead / (input + cacheRead + cacheWrite) for this provider only */
  cacheHitRate: number;
  /** per-model breakdown within this provider */
  models: ModelSummary[];
}

export interface DaySummary {
  date: string; // YYYY-MM-DD local
  /** One row per (date, provider) — metrics are not cross-platform sums */
  provider: string;
  sessions: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  estimated: boolean;
}

export interface AggregateReport {
  range: DateRange;
  totals: ProviderSummary & { providers: number };
  byProvider: ProviderSummary[];
  byDay: DaySummary[];
  topSessions: SessionSummary[];
  sessions: SessionSummary[];
  tools: ToolUse[];
  /** flat per-provider-per-model rollup — models are scoped to their platform, never merged across platforms */
  models: ModelSummary[];
  cacheHitRate: number;
  /** true when range spans more than one local calendar day */
  multiDay: boolean;
}

export type FindingSeverity = "critical" | "warn" | "info";
export type FindingScope = "period" | "session" | "setup";

export interface Finding {
  id: string;
  severity: FindingSeverity;
  scope: FindingScope;
  provider?: string;
  sessionId?: string;
  metrics: Record<string, number | string>;
  estimatedSaveUsd: number;
  estimatedSaveTokens?: number;
  titleKey: string;
  whyKey: string;
  fixKey: string;
  fixCommand?: string;
}

export interface InventoryItem {
  kind: "mcp" | "skill" | "command";
  provider: string;
  name: string;
  declared: boolean;
  calls: number;
  sessions: number;
  scope?: string;
  advice: "keep" | "off" | "archive";
  estOverheadTokensPerSession?: number;
}

export interface InventoryReport {
  items: InventoryItem[];
  findings: Finding[];
}

export interface CliOptions {
  lang: Lang;
  providers?: string[];
  json?: boolean;
  top?: number;
}
