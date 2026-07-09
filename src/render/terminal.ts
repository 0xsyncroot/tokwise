import pc from "picocolors";
import type {
  AggregateReport,
  Finding,
  InventoryReport,
  Lang,
  ProviderInfo,
} from "../types.js";
import { t, type MsgKey } from "../i18n/index.js";
import { formatTokens, formatUsd } from "../pricing/index.js";
import { formatYmd } from "../dates.js";
import { IMPLEMENTED } from "../providers/index.js";

type Align = "left" | "right";

function visibleLen(s: string): number {
  // strip ANSI
  return s.replace(/\u001b\[[0-9;]*m/g, "").length;
}

function pad(s: string, width: number, align: Align = "left"): string {
  const len = visibleLen(s);
  if (len >= width) return s;
  const space = " ".repeat(width - len);
  return align === "right" ? space + s : s + space;
}

function truncate(s: string, width: number): string {
  if (visibleLen(s) <= width) return s;
  const plain = s.replace(/\u001b\[[0-9;]*m/g, "");
  if (plain.length <= width) return s;
  return plain.slice(0, Math.max(1, width - 1)) + "…";
}

/** Simple ASCII table */
function table(
  headers: string[],
  rows: string[][],
  aligns: Align[] = [],
): string[] {
  if (!rows.length) return [];
  const cols = headers.length;
  const widths = headers.map((h, i) => {
    let w = visibleLen(h);
    for (const r of rows) w = Math.max(w, visibleLen(r[i] ?? ""));
    return Math.min(w, i === cols - 1 ? 48 : 28);
  });

  const line = (cells: string[], header = false) => {
    const parts = cells.map((c, i) => {
      const a = aligns[i] || (header ? "left" : "left");
      return pad(truncate(c, widths[i]), widths[i], a);
    });
    return "  " + parts.join("  ");
  };

  const sep = "  " + widths.map((w) => "─".repeat(w)).join("  ");
  const out = [pc.dim(line(headers, true)), pc.dim(sep)];
  for (const r of rows) out.push(line(r));
  return out;
}

function section(title: string): string {
  return pc.bold(`── ${title} ──`);
}

function sev(s: Finding["severity"]): string {
  if (s === "critical") return pc.red("●");
  if (s === "warn") return pc.yellow("●");
  return pc.cyan("●");
}

function findingLine(lang: Lang, f: Finding): string[] {
  const title = t(lang, f.titleKey as MsgKey, f.metrics as Record<string, string | number>);
  const why = t(lang, f.whyKey as MsgKey, f.metrics as Record<string, string | number>);
  const fix = t(lang, f.fixKey as MsgKey, f.metrics as Record<string, string | number>);
  const lines = [
    `${sev(f.severity)} ${pc.bold(title)}  ${pc.dim(`(${t(lang, "estSave")} ${formatUsd(f.estimatedSaveUsd)})`)}`,
    `  ${pc.dim(why)}`,
    `  → ${fix}`,
  ];
  if (f.fixCommand) lines.push(`  $ ${pc.green(f.fixCommand)}`);
  return lines;
}

function shortId(id: string): string {
  return id.length > 10 ? id.slice(0, 8) + "…" : id;
}

function shortModel(m?: string): string {
  if (!m) return "-";
  return m.length > 22 ? m.slice(0, 21) + "…" : m;
}

function shortProject(p?: string): string {
  if (!p) return "-";
  // show last 2 path segments
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  const tail = parts.slice(-2).join("/");
  return tail.length > 28 ? "…" + tail.slice(-27) : tail;
}

export function renderReport(
  lang: Lang,
  report: AggregateReport,
  findings: Finding[],
  opts: { topAdvice?: number } = {},
): string {
  const lines: string[] = [];
  const tot = report.totals;
  const dayCount = new Set(report.byDay.map((d) => d.date)).size || 1;

  lines.push(
    pc.bold(pc.magenta("tokwise")) +
      "  " +
      pc.dim(`${t(lang, "range")}: `) +
      pc.bold(report.range.label) +
      (report.multiDay
        ? pc.dim(`  (${dayCount} ${t(lang, "days")})`)
        : ""),
  );
  lines.push("");

  if (tot.sessions === 0) {
    lines.push(t(lang, "noData"));
    return lines.join("\n");
  }

  // Summary cards
  lines.push(section(t(lang, "summary")));
  lines.push(
    `  ${pc.bold(formatUsd(tot.costUsd))} ${t(lang, "cost")}` +
      (tot.estimated ? pc.dim(` (${t(lang, "estimated")})`) : "") +
      `   ·   ${tot.sessions} ${t(lang, "sessions")}   ·   ${tot.requests} ${t(lang, "requests")}   ·   ${t(lang, "cacheHit")} ${pc.bold(`${(report.cacheHitRate * 100).toFixed(1)}%`)}`,
  );
  lines.push(
    pc.dim(
      `  ${t(lang, "input")} ${formatTokens(tot.inputTokens)}   ${t(lang, "output")} ${formatTokens(tot.outputTokens)}   ${t(lang, "cacheRead")} ${formatTokens(tot.cacheReadTokens)}   ${t(lang, "cacheWrite")} ${formatTokens(tot.cacheWriteTokens)}`,
    ),
  );
  lines.push("");

  // By day × provider (when multi-day)
  if (report.multiDay && report.byDay.length > 0) {
    lines.push(section(t(lang, "byDay")));
    const dayRows = report.byDay.map((d) => [
      d.date,
      pc.cyan(d.provider) + (d.estimated ? pc.dim("*") : ""),
      String(d.sessions),
      String(d.requests),
      formatUsd(d.costUsd),
      formatTokens(d.inputTokens),
      formatTokens(d.outputTokens),
    ]);
    // total row
    dayRows.push([
      pc.bold(t(lang, "total")),
      "",
      pc.bold(String(tot.sessions)),
      pc.bold(String(tot.requests)),
      pc.bold(formatUsd(tot.costUsd)),
      pc.bold(formatTokens(tot.inputTokens)),
      pc.bold(formatTokens(tot.outputTokens)),
    ]);
    lines.push(
      ...table(
        [
          t(lang, "date"),
          t(lang, "provider"),
          t(lang, "sessions"),
          t(lang, "requests"),
          t(lang, "cost"),
          t(lang, "input"),
          t(lang, "output"),
        ],
        dayRows,
        ["left", "left", "right", "right", "right", "right", "right"],
      ),
    );
    lines.push("");
  }

  // By provider
  lines.push(section(t(lang, "byProvider")));
  lines.push(
    ...table(
      [
        t(lang, "provider"),
        t(lang, "sessions"),
        t(lang, "requests"),
        t(lang, "cost"),
        t(lang, "input"),
        t(lang, "output"),
        t(lang, "cacheRead"),
        t(lang, "cacheHit"),
      ],
      report.byProvider.map((p) => [
        pc.cyan(p.provider) + (p.estimated ? pc.dim("*") : ""),
        String(p.sessions),
        String(p.requests),
        formatUsd(p.costUsd),
        formatTokens(p.inputTokens),
        formatTokens(p.outputTokens),
        formatTokens(p.cacheReadTokens),
        `${(p.cacheHitRate * 100).toFixed(1)}%`,
      ]),
      ["left", "right", "right", "right", "right", "right", "right", "right"],
    ),
  );
  lines.push("");

  // Top sessions — always show date
  lines.push(section(t(lang, "topSessions")));
  lines.push(
    ...table(
      [
        t(lang, "date"),
        t(lang, "provider"),
        t(lang, "session"),
        t(lang, "cost"),
        t(lang, "requests"),
        t(lang, "model"),
        t(lang, "project"),
      ],
      report.topSessions.slice(0, 10).map((s) => [
        formatYmd(s.start),
        pc.cyan(s.provider),
        shortId(s.sessionId),
        formatUsd(s.costUsd),
        String(s.requests),
        shortModel(s.model),
        shortProject(s.project),
      ]),
      ["left", "left", "left", "right", "right", "left", "left"],
    ),
  );
  lines.push("");

  // Tools
  if (report.tools.length) {
    lines.push(section(t(lang, "tools")));
    lines.push(
      ...table(
        [t(lang, "count"), t(lang, "tool"), t(lang, "kind")],
        report.tools.slice(0, 12).map((tool) => {
          const kind =
            tool.kind === "mcp"
              ? pc.yellow("mcp")
              : tool.kind === "skill"
                ? pc.magenta("skill")
                : pc.dim(tool.kind);
          return [String(tool.count), tool.name, kind];
        }),
        ["right", "left", "left"],
      ),
    );
    lines.push("");
  }

  // Models — one row per (provider, model); never merged across platforms
  if (report.models.length > 0) {
    lines.push(section(t(lang, "models")));
    lines.push(
      ...table(
        [
          t(lang, "provider"),
          t(lang, "model"),
          t(lang, "cost"),
          t(lang, "requests"),
          t(lang, "tokens"),
        ],
        report.models.slice(0, 12).map((m) => [
          pc.cyan(m.provider) + (m.estimated ? pc.dim("*") : ""),
          shortModel(m.model),
          formatUsd(m.costUsd),
          String(m.requests),
          formatTokens(m.tokens),
        ]),
        ["left", "left", "right", "right", "right"],
      ),
    );
    lines.push("");
  }

  const top = findings.slice(0, opts.topAdvice ?? 5);
  if (top.length) {
    lines.push(section(t(lang, "advice")));
    for (const f of top) {
      lines.push(...findingLine(lang, f));
      lines.push("");
    }
  }

  return lines.join("\n");
}

export function renderAdvice(lang: Lang, findings: Finding[]): string {
  const lines = [section(t(lang, "advice")), ""];
  if (!findings.length) {
    lines.push(pc.dim("No findings."));
    return lines.join("\n");
  }
  for (const f of findings) {
    lines.push(...findingLine(lang, f));
    lines.push("");
  }
  return lines.join("\n");
}

export function renderInventory(lang: Lang, inv: InventoryReport): string {
  const lines = [section(t(lang, "inventory")), ""];
  const mcps = inv.items.filter((i) => i.kind === "mcp");
  const skills = inv.items.filter((i) => i.kind === "skill");

  if (mcps.length) {
    lines.push(pc.bold("MCP"));
    lines.push(
      ...table(
        [t(lang, "name"), t(lang, "scope"), t(lang, "calls"), t(lang, "adviceCol")],
        mcps.map((m) => {
          const adv =
            m.advice === "off"
              ? pc.red(t(lang, "off"))
              : m.advice === "archive"
                ? pc.yellow(t(lang, "archive"))
                : pc.green(t(lang, "keep"));
          return [m.name, (m.scope || "-").slice(0, 24), String(m.calls), adv];
        }),
        ["left", "left", "right", "left"],
      ),
    );
    lines.push("");
  }

  if (skills.length) {
    lines.push(pc.bold("Skills"));
    lines.push(
      ...table(
        [t(lang, "name"), t(lang, "calls"), t(lang, "adviceCol")],
        skills.map((s) => {
          const adv =
            s.advice === "archive" ? pc.yellow(t(lang, "archive")) : pc.green(t(lang, "keep"));
          return [s.name, String(s.calls), adv];
        }),
        ["left", "right", "left"],
      ),
    );
    lines.push("");
  }

  if (inv.findings.length) {
    lines.push(pc.bold(t(lang, "advice")));
    for (const f of inv.findings.slice(0, 10)) {
      lines.push(...findingLine(lang, f));
      lines.push("");
    }
  }

  if (!mcps.length && !skills.length) {
    lines.push(pc.dim("No MCP/skills declared."));
  }

  return lines.join("\n");
}

export function renderDetect(lang: Lang, list: ProviderInfo[]): string {
  const lines = [section(t(lang, "detect")), ""];
  const found = list.filter((p) => p.detect().found);
  const missing = list.filter((p) => !p.detect().found);

  lines.push(pc.bold(t(lang, "found")));
  lines.push(
    ...table(
      [t(lang, "provider"), t(lang, "quality"), t(lang, "status"), t(lang, "path")],
      found.map((p) => {
        const d = p.detect();
        return [
          p.id,
          p.quality,
          IMPLEMENTED.has(p.id) ? pc.green("collect") : pc.dim("stub"),
          d.paths[0] || "-",
        ];
      }),
      ["left", "left", "left", "left"],
    ),
  );
  lines.push("");
  lines.push(pc.dim(`${t(lang, "missing")}: ${missing.map((p) => p.id).join(", ")}`));
  return lines.join("\n");
}

export function renderSession(
  lang: Lang,
  report: AggregateReport,
  id: string,
  findings: Finding[],
): string {
  const s = report.sessions.find(
    (x) =>
      x.sessionId === id ||
      x.sessionId.startsWith(id) ||
      `${x.provider}::${x.sessionId}` === id,
  );
  if (!s) return `Session not found: ${id}`;

  const sameDay = formatYmd(s.start) === formatYmd(s.end);
  const when = sameDay
    ? formatYmd(s.start)
    : `${formatYmd(s.start)} → ${formatYmd(s.end)}`;

  const lines = [
    pc.bold(`Session ${s.sessionId}`),
    "",
    ...table(
      ["", ""],
      [
        [t(lang, "date"), when],
        [t(lang, "provider"), s.provider],
        [t(lang, "model"), s.models.length > 1 ? s.models.join(", ") : s.model || "-"],
        [t(lang, "project"), s.project || "-"],
        [t(lang, "cost"), formatUsd(s.costUsd)],
        [t(lang, "requests"), String(s.requests)],
        [t(lang, "input"), formatTokens(s.inputTokens)],
        [t(lang, "output"), formatTokens(s.outputTokens)],
        [t(lang, "cacheRead"), formatTokens(s.cacheReadTokens)],
        [t(lang, "cacheWrite"), formatTokens(s.cacheWriteTokens)],
      ],
      ["left", "left"],
    ),
    "",
    section(t(lang, "tools")),
  ];
  if (s.tools.length) {
    lines.push(
      ...table(
        [t(lang, "count"), t(lang, "tool")],
        s.tools.slice(0, 20).map((tool) => [String(tool.count), tool.name]),
        ["right", "left"],
      ),
    );
  } else {
    lines.push(pc.dim("  (none)"));
  }
  lines.push("");
  lines.push(section(t(lang, "whyExpensive")));
  for (const f of findings) {
    lines.push(...findingLine(lang, f));
    lines.push("");
  }
  return lines.join("\n");
}
