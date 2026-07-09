import type { DateRange } from "./types.js";

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function endOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

function parseYmd(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`Invalid date "${s}". Use YYYY-MM-DD.`);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date "${s}".`);
  return d;
}

export function formatYmd(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

export interface ResolveDateArgs {
  day?: string;
  from?: string;
  to?: string;
  all?: boolean;
}

export function resolveDateRange(args: ResolveDateArgs): DateRange {
  if (args.all) {
    return {
      from: new Date(0),
      to: new Date(8640000000000000),
      label: "all",
      all: true,
    };
  }

  if (args.from || args.to) {
    const from = startOfLocalDay(parseYmd(args.from ?? args.to!));
    const to = endOfLocalDay(parseYmd(args.to ?? args.from!));
    if (from > to) throw new Error("--from must be <= --to");
    return {
      from,
      to,
      label: `${formatYmd(from)} → ${formatYmd(to)}`,
      all: false,
    };
  }

  const day = args.day ? parseYmd(args.day) : new Date();
  const from = startOfLocalDay(day);
  const to = endOfLocalDay(day);
  return {
    from,
    to,
    label: formatYmd(from),
    all: false,
  };
}

export function inRange(ts: Date, range: DateRange): boolean {
  if (range.all) return true;
  return ts >= range.from && ts <= range.to;
}

/** Fast path filter using file mtime when available */
export function mtimePossiblyInRange(mtimeMs: number, range: DateRange): boolean {
  if (range.all) return true;
  // Allow 2-day slack for timezone / write lag
  const slack = 2 * 24 * 60 * 60 * 1000;
  return mtimeMs >= range.from.getTime() - slack && mtimeMs <= range.to.getTime() + slack;
}
