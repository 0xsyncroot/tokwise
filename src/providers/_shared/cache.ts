/**
 * Per-file parse cache. Transcript files are append-only; a file whose
 * (mtimeMs, size) is unchanged re-yields the exact same events, so repeat
 * runs skip re-reading hundreds of MB of jsonl.
 *
 * Location: $TOKWISE_CACHE_DIR | $XDG_CACHE_HOME/tokusage | ~/.cache/tokusage
 * Disable with TOKWISE_NO_CACHE=1. Bump the cache name (e.g. claude-v3) when
 * the parser changes so stale entries are ignored wholesale.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cacheRoot } from "../../paths.js";

interface Slot {
  mtimeMs: number;
  size: number;
  data: unknown;
}

function cacheDir(): string {
  return cacheRoot();
}

export class FileParseCache {
  private map: Record<string, Slot> = {};
  private dirty = false;
  private readonly file: string;
  private readonly disabled: boolean;

  constructor(name: string) {
    this.disabled = process.env.TOKWISE_NO_CACHE === "1";
    this.file = join(cacheDir(), `${name}.json`);
    if (!this.disabled) {
      try {
        this.map = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, Slot>;
      } catch {
        this.map = {};
      }
    }
  }

  get<T>(path: string, mtimeMs: number, size: number): T | null {
    if (this.disabled) return null;
    const slot = this.map[path];
    if (!slot || slot.mtimeMs !== mtimeMs || slot.size !== size) return null;
    return slot.data as T;
  }

  set(path: string, mtimeMs: number, size: number, data: unknown): void {
    if (this.disabled) return;
    this.map[path] = { mtimeMs, size, data };
    this.dirty = true;
  }

  save(): void {
    if (this.disabled || !this.dirty) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.map));
      this.dirty = false;
    } catch {
      /* cache is best-effort */
    }
  }
}
