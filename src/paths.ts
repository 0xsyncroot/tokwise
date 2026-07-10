/**
 * Standard on-disk locations for tokusage (npm name) / tokwise (repo).
 *
 * Cache:  $TOKWISE_CACHE_DIR | $XDG_CACHE_HOME/tokusage | ~/.cache/tokusage
 * Config: $TOKWISE_CONFIG_DIR | $XDG_CONFIG_HOME/tokusage | ~/.config/tokusage
 * State:  $TOKWISE_STATE_DIR | $XDG_STATE_HOME/tokusage | ~/.local/state/tokusage
 * Reports default under state/reports/
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function envDir(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

export function cacheRoot(): string {
  return (
    envDir("TOKWISE_CACHE_DIR") ||
    join(envDir("XDG_CACHE_HOME") || join(homedir(), ".cache"), "tokusage")
  );
}

export function configRoot(): string {
  return (
    envDir("TOKWISE_CONFIG_DIR") ||
    join(envDir("XDG_CONFIG_HOME") || join(homedir(), ".config"), "tokusage")
  );
}

export function stateRoot(): string {
  return (
    envDir("TOKWISE_STATE_DIR") ||
    join(envDir("XDG_STATE_HOME") || join(homedir(), ".local", "state"), "tokusage")
  );
}

/** Default directory for HTML reports. Created on demand. */
export function reportsDir(): string {
  const dir = join(stateRoot(), "reports");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Sanitize a range label into a filesystem-safe slug. */
export function slugRangeLabel(label: string): string {
  return label
    .trim()
    .replace(/\s*→\s*/g, "_to_")
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 80) || "all";
}

/**
 * Default HTML report path:
 *   ~/.local/state/tokusage/reports/report-<range>-<YYYYMMDD-HHmmss>.html
 */
export function defaultReportPath(rangeLabel: string, when = new Date()): string {
  const stamp = [
    when.getFullYear(),
    String(when.getMonth() + 1).padStart(2, "0"),
    String(when.getDate()).padStart(2, "0"),
    "-",
    String(when.getHours()).padStart(2, "0"),
    String(when.getMinutes()).padStart(2, "0"),
    String(when.getSeconds()).padStart(2, "0"),
  ].join("");
  return join(reportsDir(), `report-${slugRangeLabel(rangeLabel)}-${stamp}.html`);
}
