import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

export function home(...parts: string[]): string {
  return join(homedir(), ...parts);
}

export function envPath(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

export function firstExisting(...candidates: string[]): string | undefined {
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return undefined;
}

/** VS Code-family User roots (Linux / macOS / Windows) */
export function vscodeUserRoots(): string[] {
  const roots: string[] = [];
  const flavors = ["Code", "Code - Insiders", "VSCodium", "Cursor"];
  const homeDir = homedir();
  const platform = process.platform;

  for (const f of flavors) {
    if (platform === "darwin") {
      roots.push(join(homeDir, "Library", "Application Support", f, "User"));
    } else if (platform === "win32") {
      const appdata = process.env.APPDATA || join(homeDir, "AppData", "Roaming");
      roots.push(join(appdata, f, "User"));
    } else {
      roots.push(join(homeDir, ".config", f, "User"));
    }
  }
  // Remote SSH server
  roots.push(join(homeDir, ".vscode-server", "data", "User"));
  roots.push(join(homeDir, ".cursor-server", "data", "User"));
  return roots.filter((r) => existsSync(r));
}

export function vscodeGlobalStorage(extensionId: string): string[] {
  return vscodeUserRoots()
    .map((u) => join(u, "globalStorage", extensionId))
    .filter((p) => existsSync(p));
}

// --- Provider path resolvers (cite CodeBurn / Tokscale / continues / agentscrub) ---

export function claudeDir(): string {
  return envPath("CLAUDE_CONFIG_DIR") || envPath("TOKWISE_CLAUDE_DIR") || home(".claude");
}

export function claudeConfigDirs(): string[] {
  const multi = envPath("CLAUDE_CONFIG_DIRS");
  if (multi) {
    const sep = process.platform === "win32" ? ";" : ":";
    return multi.split(sep).map((s) => s.trim()).filter(Boolean);
  }
  return [claudeDir()];
}

export function codexDir(): string {
  return envPath("CODEX_HOME") || envPath("TOKWISE_CODEX_DIR") || home(".codex");
}

export function geminiDir(): string {
  return envPath("GEMINI_CLI_HOME") || envPath("TOKWISE_GEMINI_DIR") || home(".gemini");
}

export function cursorStateDb(): string | undefined {
  const override = envPath("CURSOR_DB") || envPath("TOKWISE_CURSOR_DIR");
  if (override) {
    if (override.endsWith(".vscdb")) return existsSync(override) ? override : undefined;
    const candidate = join(override, "state.vscdb");
    return existsSync(candidate) ? candidate : undefined;
  }
  const platform = process.platform;
  const homeDir = homedir();
  let base: string;
  if (platform === "darwin") {
    base = join(homeDir, "Library", "Application Support", "Cursor", "User", "globalStorage");
  } else if (platform === "win32") {
    const appdata = process.env.APPDATA || join(homeDir, "AppData", "Roaming");
    base = join(appdata, "Cursor", "User", "globalStorage");
  } else {
    base = join(homeDir, ".config", "Cursor", "User", "globalStorage");
  }
  const db = join(base, "state.vscdb");
  return existsSync(db) ? db : undefined;
}

export function cursorProjectsDir(): string {
  return envPath("TOKWISE_CURSOR_AGENT_DIR") || home(".cursor", "projects");
}

export function copilotDir(): string {
  return envPath("TOKWISE_COPILOT_DIR") || home(".copilot");
}

export function clineDataDir(): string {
  return envPath("TOKWISE_CLINE_DIR") || home(".cline", "data");
}

export function opencodeDir(): string {
  const xdg = envPath("XDG_DATA_HOME");
  return (
    envPath("TOKWISE_OPENCODE_DIR") ||
    (xdg ? join(xdg, "opencode") : undefined) ||
    home(".local", "share", "opencode")
  );
}

export function antigravityDir(): string {
  return envPath("TOKWISE_ANTIGRAVITY_DIR") || join(geminiDir(), "antigravity");
}
