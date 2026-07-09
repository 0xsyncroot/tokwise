/**
 * Provider registry.
 * Implemented: claude, codex, gemini, cursor-agent, copilot, antigravity, cline.
 * Remaining IDs are path-detect stubs (Tokscale/CodeBurn matrix).
 */
import { existsSync } from "node:fs";
import type { DateRange, ProviderInfo, UsageEvent } from "../types.js";
import { home, cursorStateDb, opencodeDir } from "./_paths.js";
import { claudeProvider } from "./claude.js";
import { codexProvider } from "./codex.js";
import { geminiProvider } from "./gemini.js";
import { cursorAgentProvider } from "./cursor-agent.js";
import { copilotProvider } from "./copilot.js";
import { antigravityProvider } from "./antigravity.js";
import { clineProvider } from "./cline.js";

function makeStub(
  id: string,
  name: string,
  quality: ProviderInfo["quality"],
  pathsFn: () => string[],
): ProviderInfo {
  return {
    id,
    name,
    quality,
    detect() {
      const paths = pathsFn().filter((p) => existsSync(p));
      return { found: paths.length > 0, paths };
    },
    async collect() {
      return [];
    },
  };
}

const stubProviders: ProviderInfo[] = [
  makeStub("cursor", "Cursor IDE", "full", () => {
    const db = cursorStateDb();
    return db ? [db] : [];
  }),
  makeStub("opencode", "OpenCode", "full", () => [opencodeDir()]),
  makeStub("pi", "Pi", "full", () => [home(".pi", "agent", "sessions")]),
  makeStub("omp", "Oh My Pi", "full", () => [home(".omp", "agent", "sessions")]),
  makeStub("kimi", "Kimi CLI", "full", () => [home(".kimi", "sessions")]),
  makeStub("qwen", "Qwen CLI", "full", () => [home(".qwen", "projects")]),
  makeStub("droid", "Factory Droid", "full", () => [home(".factory", "sessions")]),
  makeStub("amp", "Amp", "full", () => [home(".local", "share", "amp", "threads")]),
  makeStub("openclaw", "OpenClaw", "full", () => [home(".openclaw", "agents")]),
  makeStub("goose", "Goose", "full", () => [home(".local", "share", "goose", "sessions")]),
  makeStub("codebuff", "Codebuff", "full", () => [home(".config", "manicode")]),
  makeStub("hermes", "Hermes", "full", () => [home(".hermes")]),
  makeStub("grok", "Grok Build", "full", () => [home(".grok", "sessions")]),
  makeStub("mux", "Mux", "full", () => [home(".mux", "sessions")]),
  makeStub("crush", "Crush", "full", () => [home(".local", "share", "crush"), home(".crush")]),
  makeStub("roo", "Roo Code", "stub", () => []),
  makeStub("kilo", "Kilo Code", "stub", () => []),
  makeStub("kilo-cli", "Kilo CLI", "stub", () => [home(".local", "share", "kilo")]),
  makeStub("kiro", "Kiro", "estimated", () => [home(".kiro")]),
  makeStub("warp", "Warp / Oz", "stub", () => []),
  makeStub("zed", "Zed Agent", "stub", () => [home(".local", "share", "zed")]),
  makeStub("claude-desktop", "Claude Desktop", "stub", () => [home(".config", "Claude")]),
  makeStub("junie", "Junie", "stub", () => [home(".junie", "sessions")]),
  makeStub("codebuddy", "CodeBuddy", "stub", () => [home(".codebuddy")]),
  makeStub("zcode", "ZCode", "stub", () => [home(".zcode")]),
  makeStub("mimo", "MiMo Code", "stub", () => [home(".local", "share", "mimocode")]),
  makeStub("jcode", "Jcode", "stub", () => [home(".jcode")]),
  makeStub("gajae", "gajae-code", "stub", () => [home(".gjc")]),
  makeStub("command-code", "Command Code", "stub", () => [home(".commandcode")]),
  makeStub("opencodereview", "OpenCodeReview", "stub", () => [home(".opencodereview")]),
  makeStub("trae", "Trae", "stub", () => []),
  makeStub("windsurf", "Windsurf", "stub", () => [home(".windsurf"), home(".codeium", "windsurf")]),
  makeStub("aider", "Aider", "stub", () => [home(".aider")]),
  makeStub("continue", "Continue", "stub", () => [home(".continue", "sessions")]),
  makeStub("devin", "Devin", "stub", () => []),
  makeStub("forge", "Forge", "stub", () => []),
  makeStub("ibm-bob", "IBM Bob", "stub", () => []),
  makeStub("mistral-vibe", "Mistral Vibe", "stub", () => []),
  makeStub("vercel-gateway", "Vercel AI Gateway", "stub", () => []),
  makeStub("synthetic", "Synthetic", "stub", () => [home(".local", "share", "octofriend")]),
  makeStub("antigravity-cli", "Antigravity CLI", "sessions-only", () => [
    home(".gemini", "antigravity-cli"),
  ]),
  makeStub("fugu", "Sakana Fugu", "stub", () => [home(".codex", "sessions")]),
];

export const IMPLEMENTED = new Set([
  "claude",
  "codex",
  "gemini",
  "cursor-agent",
  "copilot",
  "antigravity",
  "cline",
]);

export const providers: ProviderInfo[] = [
  claudeProvider,
  codexProvider,
  geminiProvider,
  cursorAgentProvider,
  copilotProvider,
  antigravityProvider,
  clineProvider,
  ...stubProviders,
];

export function getProviders(filter?: string[]): ProviderInfo[] {
  if (!filter?.length) return providers;
  const set = new Set(filter.map((s) => s.trim().toLowerCase()));
  return providers.filter((p) => set.has(p.id));
}

export async function collectAll(
  range: DateRange,
  filter?: string[],
): Promise<UsageEvent[]> {
  const list = getProviders(filter);
  const toRun = list.filter(
    (p) => IMPLEMENTED.has(p.id) && (filter?.length || p.detect().found),
  );
  const chunks = await Promise.all(
    toRun.map(async (p) => {
      try {
        return await p.collect(range);
      } catch (err) {
        console.error(`[tokwise] ${p.id} failed:`, (err as Error).message);
        return [] as UsageEvent[];
      }
    }),
  );
  return chunks.flat();
}
