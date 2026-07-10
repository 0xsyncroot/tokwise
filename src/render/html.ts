import type {
  AggregateReport,
  Finding,
  InventoryReport,
  Lang,
  ModelSummary,
  SessionSummary,
  SessionTurnDetail,
  ToolUse,
} from "../types.js";
import { t, type MsgKey } from "../i18n/index.js";
import { formatTokens, formatUsd } from "../pricing/index.js";
import { formatYmd } from "../dates.js";
import { shortSourcePath, formatModelTag, TURN_DETAIL_PROVIDERS } from "../session-detail.js";
import { sessionFindings } from "../advice/index.js";

function esc(s: string | number | undefined | null): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function fmtWhen(s: SessionSummary): string {
  const a = formatYmd(s.start);
  const b = formatYmd(s.end);
  return a === b ? a : `${a} → ${b}`;
}

function shortId(id: string): string {
  return id.length > 14 ? id.slice(0, 12) + "…" : id;
}

function shortProject(p?: string): string {
  if (!p) return "—";
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  const tail = parts.slice(-2).join("/");
  return tail.length > 36 ? "…" + tail.slice(-35) : tail;
}

const EXPAND_PREVIEW_CHARS = 320;

/**
 * Renders long turn text (prompt/output) as a short preview with a native
 * <details> "show full" expander — no JS needed. Short text renders as a
 * plain <p>. The <details> body holds only the remainder past the preview,
 * so expanding appends rather than duplicating the visible text.
 */
function expandableBlock(lang: Lang, text: string, cls: string): string {
  const clean = text.trim();
  if (clean.length <= EXPAND_PREVIEW_CHARS) {
    return `<p class="${cls}">${esc(clean)}</p>`;
  }
  const preview = clean.slice(0, EXPAND_PREVIEW_CHARS);
  const rest = clean.slice(EXPAND_PREVIEW_CHARS);
  return `<details class="expand">
    <summary class="${cls}"><span class="chev">▸</span>${esc(preview)}<span class="more-link"> … ${esc(t(lang, "showMore"))}</span></summary>
    <p class="${cls} full">${esc(rest)}</p>
  </details>`;
}

function costShareBar(cost: number, total: number): string {
  const p = total > 0 ? Math.min(100, (cost / total) * 100) : 0;
  return `<span class="bar" title="${p.toFixed(1)}%"><i style="width:${p.toFixed(1)}%"></i></span>`;
}

function sevClass(sev: Finding["severity"]): string {
  if (sev === "critical") return "sev-critical";
  if (sev === "warn") return "sev-warn";
  return "sev-info";
}

function findingHtml(lang: Lang, f: Finding, open: boolean): string {
  const title = t(lang, f.titleKey as MsgKey, f.metrics as Record<string, string | number>);
  const why = t(lang, f.whyKey as MsgKey, f.metrics as Record<string, string | number>);
  const fix = t(lang, f.fixKey as MsgKey, f.metrics as Record<string, string | number>);
  return `<details class="finding ${sevClass(f.severity)}"${open ? " open" : ""}>
  <summary>
    <span class="dot"></span>
    <strong>${esc(title)}</strong>
    <span class="save">${esc(t(lang, "estSave"))} ${esc(formatUsd(f.estimatedSaveUsd))}</span>
  </summary>
  <div class="finding-body">
    <p class="why">${esc(why)}</p>
    <p class="fix"><span>→</span> ${esc(fix)}</p>
    ${f.fixCommand ? `<pre class="cmd">$ ${esc(f.fixCommand)}</pre>` : ""}
    <div class="meta">
      ${f.provider ? `<span>${esc(t(lang, "provider"))}: ${esc(f.provider)}</span>` : ""}
      ${f.sessionId ? `<span>${esc(t(lang, "session"))}: <code>${esc(f.sessionId)}</code></span>` : ""}
      <span>${esc(f.scope)} · ${esc(f.severity)}</span>
    </div>
  </div>
</details>`;
}

function tokenGrid(
  lang: Lang,
  row: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens?: number;
  },
): string {
  const cells = [
    [t(lang, "input"), formatTokens(row.inputTokens)],
    [t(lang, "output"), formatTokens(row.outputTokens)],
    [t(lang, "cacheRead"), formatTokens(row.cacheReadTokens)],
    [t(lang, "cacheWrite"), formatTokens(row.cacheWriteTokens)],
  ];
  if (row.reasoningTokens != null && row.reasoningTokens > 0) {
    cells.push([t(lang, "reasoning"), formatTokens(row.reasoningTokens)]);
  }
  return `<div class="token-grid">${cells
    .map(
      ([k, v]) =>
        `<div><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`,
    )
    .join("")}</div>`;
}

function modelsMiniTable(lang: Lang, models: ModelSummary[]): string {
  if (!models.length) return `<p class="empty">${esc(t(lang, "noModels"))}</p>`;
  const rows = models
    .map(
      (m) => `<tr>
      <td>${esc(m.model)}${m.estimated ? ` <span class="badge est">*</span>` : ""}</td>
      <td class="num">${esc(formatUsd(m.costUsd))}</td>
      <td class="num">${m.requests}</td>
      <td class="num">${esc(formatTokens(m.tokens))}</td>
    </tr>`,
    )
    .join("");
  return `<table class="mini">
    <thead><tr>
      <th>${esc(t(lang, "model"))}</th>
      <th class="num">${esc(t(lang, "cost"))}</th>
      <th class="num">${esc(t(lang, "requests"))}</th>
      <th class="num">${esc(t(lang, "tokens"))}</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function toolsMiniTable(lang: Lang, tools: ToolUse[], limit = 0): string {
  if (!tools.length) return `<p class="empty">—</p>`;
  const shown = limit > 0 ? tools.slice(0, limit) : tools;
  const rows = shown
    .map((tool) => {
      const kind =
        tool.kind === "mcp"
          ? "mcp"
          : tool.kind === "skill"
            ? "skill"
            : tool.kind;
      return `<tr>
        <td class="num">${tool.count}</td>
        <td><code>${esc(tool.name)}</code></td>
        <td><span class="badge ${kind === "mcp" ? "mcp" : kind === "skill" ? "skill" : "system"}">${esc(kind)}</span></td>
      </tr>`;
    })
    .join("");
  const note =
    limit > 0 && tools.length > limit
      ? `<p class="muted" style="margin:0.5rem 0 0">${esc(
          t(lang, "showingTop", { shown: limit, total: tools.length }),
        )}</p>`
      : "";
  return `<table class="mini">
    <thead><tr>
      <th class="num">${esc(t(lang, "count"))}</th>
      <th>${esc(t(lang, "tool"))}</th>
      <th>${esc(t(lang, "kind"))}</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>${note}`;
}

const CSS = /* css */ `
:root {
  --bg: #f4f6f8;
  --panel: #ffffff;
  --line: #d8dee6;
  --line2: #e8edf3;
  --text: #1a2332;
  --muted: #5c6b7e;
  --accent: #0d7a5f;
  --accent-soft: #e6f5f0;
  --accent2: #1a5f8a;
  --warn: #9a6b12;
  --warn-bg: #fbf3e0;
  --crit: #b42318;
  --crit-bg: #fceceb;
  --info: #1a5f8a;
  --info-bg: #e8f1f8;
  --bar: #c5d4ce;
  --bar-fill: #0d7a5f;
  --mono: "IBM Plex Mono", ui-monospace, monospace;
  --sans: "IBM Plex Sans", "Segoe UI", sans-serif;
  --radius: 10px;
  --shadow: 0 1px 2px #1a233214, 0 4px 16px #1a23320a;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  font-family: var(--sans);
  background: var(--bg);
  color: var(--text);
  line-height: 1.45;
  min-height: 100vh;
}
a { color: var(--accent2); text-decoration: none; }
a:hover { text-decoration: underline; }
.wrap { max-width: 1100px; margin: 0 auto; padding: 1.75rem 1.25rem 3.5rem; }

header.hero {
  display: flex; flex-wrap: wrap; gap: 0.75rem 1.5rem;
  align-items: flex-end; justify-content: space-between;
  margin-bottom: 1.25rem;
}
.brand {
  font-family: var(--mono);
  font-weight: 600;
  font-size: 1.25rem;
  letter-spacing: -0.02em;
  color: var(--accent);
}
.brand span { color: var(--muted); font-weight: 400; font-size: 0.8rem; margin-left: 0.45rem; }
.range { color: var(--muted); font-size: 0.92rem; }
.range strong { color: var(--text); }

.nav {
  display: flex; flex-wrap: wrap; gap: 0.4rem;
  margin-bottom: 1.25rem;
}
.nav a {
  font-size: 0.78rem;
  padding: 0.3rem 0.65rem;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--panel);
  color: var(--muted);
}
.nav a:hover { color: var(--text); border-color: var(--accent); text-decoration: none; }

.kpis {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.75rem;
  margin-bottom: 0.75rem;
}
.kpi {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 1rem 1.1rem;
  box-shadow: var(--shadow);
}
.kpi.primary .kpi-val { color: var(--accent); font-size: 1.55rem; }
.kpi-val {
  font-family: var(--mono);
  font-size: 1.25rem;
  font-weight: 600;
  letter-spacing: -0.02em;
}
.kpi-label {
  font-size: 0.72rem;
  color: var(--muted);
  margin-top: 0.2rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.hint { text-transform: none; letter-spacing: 0; opacity: 0.85; }

.panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 0;
  margin-bottom: 0.9rem;
  box-shadow: var(--shadow);
  overflow: hidden;
}
.panel > summary.panel-sum,
.panel-head {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.85rem 1.1rem;
  cursor: pointer;
  list-style: none;
  user-select: none;
  border-bottom: 1px solid transparent;
}
.panel > summary.panel-sum::-webkit-details-marker { display: none; }
.panel[open] > summary.panel-sum { border-bottom-color: var(--line2); }
.panel-title {
  font-size: 0.82rem;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: var(--muted);
  flex: 1;
}
.panel-meta { font-size: 0.8rem; color: var(--muted); font-family: var(--mono); }
.chev {
  width: 1.4rem; height: 1.4rem;
  display: grid; place-items: center;
  border-radius: 6px;
  background: var(--bg);
  color: var(--muted);
  font-size: 0.7rem;
  transition: transform 0.15s ease;
}
details[open] > summary .chev { transform: rotate(90deg); }
.panel-body { padding: 0.85rem 1.1rem 1.1rem; }

.scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.86rem;
}
table.wide { min-width: 640px; }
table.mini { min-width: 0; font-size: 0.82rem; }
th, td {
  padding: 0.5rem 0.55rem;
  border-bottom: 1px solid var(--line2);
  text-align: left;
  vertical-align: middle;
}
th {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
  font-weight: 600;
  white-space: nowrap;
  background: #fafbfc;
}
td.num, th.num { text-align: right; font-family: var(--mono); font-variant-numeric: tabular-nums; }
tr:hover td { background: #f7faf9; }
tr.total td {
  font-weight: 600;
  border-top: 2px solid var(--line);
  color: var(--accent);
  background: var(--accent-soft);
}
tr.drill { cursor: pointer; }
tr.drill > td:first-child { padding-left: 0.25rem; }
tr.drill summary {
  display: flex; align-items: center; gap: 0.45rem;
  cursor: pointer; list-style: none;
}
tr.drill summary::-webkit-details-marker { display: none; }
.nested {
  background: #f7f9fb;
  border-top: 1px dashed var(--line);
}
.nested td { padding: 0.75rem 0.85rem 0.9rem; }
.nested-inner { display: grid; gap: 0.75rem; }
@media (min-width: 720px) {
  .nested-inner.cols-2 { grid-template-columns: 1fr 1fr; }
}

.token-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 0.45rem;
}
.token-grid > div {
  background: var(--panel);
  border: 1px solid var(--line2);
  border-radius: 8px;
  padding: 0.45rem 0.55rem;
}
.token-grid .k { display: block; font-size: 0.68rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.03em; }
.token-grid .v { font-family: var(--mono); font-size: 0.9rem; font-weight: 600; }

.bar {
  display: inline-block;
  width: 64px; height: 6px;
  background: var(--bar);
  border-radius: 99px;
  overflow: hidden;
  vertical-align: middle;
  margin-left: 0.35rem;
}
.bar i { display: block; height: 100%; background: var(--bar-fill); border-radius: 99px; }

.badge {
  display: inline-block;
  font-size: 0.68rem;
  padding: 0.1rem 0.35rem;
  border-radius: 4px;
  background: var(--accent-soft);
  color: var(--accent);
  font-family: var(--mono);
}
.badge.est { background: var(--warn-bg); color: var(--warn); }
.badge.mcp { background: var(--warn-bg); color: var(--warn); }
.badge.skill { background: var(--info-bg); color: var(--info); }
.badge.system { background: var(--line2); color: var(--muted); }
.badge.off { background: var(--crit-bg); color: var(--crit); }
.provider { color: var(--accent2); font-weight: 500; }
code {
  font-family: var(--mono);
  font-size: 0.82em;
  background: var(--bg);
  padding: 0.08rem 0.3rem;
  border-radius: 4px;
}

.findings { display: flex; flex-direction: column; gap: 0.5rem; }
.finding {
  border: 1px solid var(--line);
  border-left-width: 3px;
  border-radius: 8px;
  background: #fafbfc;
}
.finding.sev-critical { border-left-color: var(--crit); }
.finding.sev-warn { border-left-color: var(--warn); }
.finding.sev-info { border-left-color: var(--info); }
.finding > summary {
  display: flex; flex-wrap: wrap; gap: 0.4rem 0.65rem; align-items: center;
  padding: 0.7rem 0.85rem;
  cursor: pointer; list-style: none;
}
.finding > summary::-webkit-details-marker { display: none; }
.finding .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
.sev-critical .dot { color: var(--crit); }
.sev-warn .dot { color: var(--warn); }
.sev-info .dot { color: var(--info); }
.finding .save {
  margin-left: auto;
  font-size: 0.75rem;
  color: var(--muted);
  font-family: var(--mono);
}
.finding-body { padding: 0 0.85rem 0.85rem; }
.finding .why, .finding .fix { margin: 0.2rem 0; font-size: 0.88rem; color: var(--muted); }
.finding .fix { color: var(--text); }
.finding .fix span { color: var(--accent); }
.finding .cmd {
  margin: 0.45rem 0 0;
  padding: 0.45rem 0.65rem;
  background: var(--bg);
  border-radius: 6px;
  font-family: var(--mono);
  font-size: 0.78rem;
  color: var(--accent);
  overflow-x: auto;
}
.finding .meta {
  margin-top: 0.45rem;
  display: flex; flex-wrap: wrap; gap: 0.65rem;
  font-size: 0.72rem;
  color: var(--muted);
}

.subhead {
  margin: 0.25rem 0 0.45rem;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.foot {
  margin-top: 1.75rem;
  padding-top: 0.85rem;
  border-top: 1px solid var(--line);
  font-size: 0.75rem;
  color: var(--muted);
  display: flex; flex-wrap: wrap; gap: 0.4rem 1.25rem;
  justify-content: space-between;
}
.empty { color: var(--muted); font-style: italic; margin: 0.25rem 0; }
.muted { color: var(--muted); font-size: 0.82rem; }
.review-meta {
  display: flex; flex-wrap: wrap; gap: 0.45rem 1rem;
  font-size: 0.8rem; color: var(--muted); margin: 0 0 0.75rem;
}
.review-meta code { font-size: 0.78em; }
.prompts { display: flex; flex-direction: column; gap: 0.45rem; }
.prompt {
  margin: 0;
  padding: 0.65rem 0.75rem;
  background: var(--bg);
  border: 1px solid var(--line2);
  border-left: 3px solid var(--accent);
  border-radius: 8px;
  font-size: 0.86rem;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.4;
}
.prompt .n {
  display: inline-block;
  font-family: var(--mono);
  font-size: 0.7rem;
  color: var(--muted);
  margin-bottom: 0.25rem;
}
.model-tag {
  display: inline-block;
  font-family: var(--mono);
  font-size: 0.68rem;
  padding: 0.12rem 0.4rem;
  border-radius: 4px;
  background: #e8f1f8;
  color: var(--accent2);
  font-weight: 500;
  max-width: 11rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
}
.model-tag.multi { background: #fbf3e0; color: var(--warn); }
.turns { display: flex; flex-direction: column; gap: 0.65rem; }
.turn {
  border: 1px solid var(--line);
  border-radius: 10px;
  background: #fafbfc;
  overflow: hidden;
}
.turn-head {
  display: flex; flex-wrap: wrap; gap: 0.35rem 0.65rem; align-items: center;
  padding: 0.55rem 0.75rem;
  background: var(--panel);
  border-bottom: 1px solid var(--line2);
  font-size: 0.78rem;
}
.turn-head .idx {
  font-family: var(--mono);
  font-weight: 600;
  color: var(--muted);
}
.turn-body { padding: 0.65rem 0.75rem 0.8rem; }
.turn-label {
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
  margin: 0.45rem 0 0.2rem;
  font-weight: 600;
}
.turn-label:first-child { margin-top: 0; }
.turn-prompt, .turn-action, .turn-output {
  margin: 0;
  font-size: 0.86rem;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
}
.turn-action {
  color: var(--accent);
  font-weight: 500;
}
.turn-output {
  padding: 0.5rem 0.6rem;
  background: var(--bg);
  border-radius: 6px;
  border-left: 3px solid var(--accent2);
  color: var(--text);
}
details.expand { margin: 0; }
details.expand > summary {
  cursor: pointer;
  list-style: none;
}
details.expand > summary::-webkit-details-marker { display: none; }
details.expand > summary .chev {
  display: inline-block;
  margin-right: 0.2rem;
  font-size: 0.7rem;
  color: var(--muted);
  transition: transform 0.15s;
}
details.expand[open] > summary .chev { transform: rotate(90deg); }
details.expand > summary .more-link { color: var(--accent); font-weight: 600; white-space: nowrap; }
details.expand[open] > summary .more-link { display: none; }
details.expand > p.full { margin-top: 0.15rem; }
.turn-stats {
  display: flex; flex-wrap: wrap; gap: 0.4rem 0.85rem;
  margin-top: 0.55rem;
  font-size: 0.75rem;
  color: var(--muted);
  font-family: var(--mono);
}
.tool-chips { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-top: 0.35rem; }
.tool-chip {
  font-size: 0.7rem;
  font-family: var(--mono);
  padding: 0.1rem 0.35rem;
  border-radius: 4px;
  background: var(--line2);
  color: var(--text);
}
.nested-inner.cols-review {
  grid-template-columns: 1fr;
  gap: 1rem;
}
@media (min-width: 900px) {
  .nested-inner.cols-review {
    grid-template-columns: 1.25fr 0.75fr;
  }
}

@media (max-width: 720px) {
  .kpis { grid-template-columns: repeat(2, 1fr); }
  .kpi.primary .kpi-val { font-size: 1.25rem; }
  .wrap { padding: 1.1rem 0.75rem 2.5rem; }
}
`;

const JS = /* js */ `
document.querySelectorAll('tr.drill').forEach((tr) => {
  const det = tr.querySelector('details.row-drill');
  if (!det) return;
  const nest = tr.nextElementSibling;
  const sync = () => {
    if (nest && nest.classList.contains('nested')) nest.hidden = !det.open;
  };
  det.addEventListener('toggle', sync);
  sync();
  tr.addEventListener('click', (e) => {
    if (e.target.closest('a, button, summary, details')) return;
    det.open = !det.open;
  });
});
`;

export interface HtmlReportOpts {
  inventory?: InventoryReport;
  generatedAt?: Date;
  allSessions?: boolean;
}

function panel(
  id: string,
  title: string,
  meta: string,
  body: string,
  open = false,
): string {
  return `<details class="panel" id="${id}"${open ? " open" : ""}>
  <summary class="panel-sum">
    <span class="chev">▶</span>
    <span class="panel-title">${esc(title)}</span>
    <span class="panel-meta">${meta}</span>
  </summary>
  <div class="panel-body">${body}</div>
</details>`;
}

function providerDrillRows(lang: Lang, report: AggregateReport): string {
  const total = report.totals.costUsd;
  const parts: string[] = [];
  for (const p of report.byProvider) {
    parts.push(`<tr class="drill">
      <td>
        <details class="row-drill">
          <summary>
            <span class="chev">▶</span>
            <span class="provider">${esc(p.provider)}</span>
            ${p.estimated ? `<span class="badge est">*</span>` : ""}
          </summary>
        </details>
      </td>
      <td class="num">${esc(formatUsd(p.costUsd))}${costShareBar(p.costUsd, total)}</td>
      <td class="num">${p.sessions}</td>
      <td class="num">${p.requests}</td>
      <td class="num">${pct(p.cacheHitRate)}</td>
      <td class="num">${esc(formatTokens(p.inputTokens + p.outputTokens))}</td>
    </tr>
    <tr class="nested" hidden>
      <td colspan="6">
        <div class="nested-inner cols-2">
          <div>
            <div class="subhead">${esc(t(lang, "tokenBreakdown"))}</div>
            ${tokenGrid(lang, p)}
          </div>
          <div>
            <div class="subhead">${esc(t(lang, "models"))}</div>
            ${modelsMiniTable(lang, p.models)}
          </div>
        </div>
      </td>
    </tr>`);
  }
  return parts.join("\n");
}

function dayDrillRows(lang: Lang, report: AggregateReport): string {
  // Group by date; each date expands to provider rows
  const byDate = new Map<string, typeof report.byDay>();
  for (const d of report.byDay) {
    const list = byDate.get(d.date) || [];
    list.push(d);
    byDate.set(d.date, list);
  }
  const parts: string[] = [];
  for (const [date, rows] of byDate) {
    const cost = rows.reduce((a, r) => a + r.costUsd, 0);
    const sessions = rows.reduce((a, r) => a + r.sessions, 0);
    const requests = rows.reduce((a, r) => a + r.requests, 0);
    const providers = rows.map((r) => r.provider).join(", ");
    const detail = rows
      .map(
        (r) => `<tr>
          <td><span class="provider">${esc(r.provider)}</span>${r.estimated ? ` <span class="badge est">*</span>` : ""}</td>
          <td class="num">${esc(formatUsd(r.costUsd))}</td>
          <td class="num">${r.sessions}</td>
          <td class="num">${r.requests}</td>
          <td class="num">${esc(formatTokens(r.inputTokens))}</td>
          <td class="num">${esc(formatTokens(r.outputTokens))}</td>
          <td class="num">${esc(formatTokens(r.cacheReadTokens))}</td>
          <td class="num">${esc(formatTokens(r.cacheWriteTokens))}</td>
        </tr>`,
      )
      .join("");
    parts.push(`<tr class="drill">
      <td>
        <details class="row-drill">
          <summary>
            <span class="chev">▶</span>
            <strong>${esc(date)}</strong>
            <span class="muted">· ${esc(providers)}</span>
          </summary>
        </details>
      </td>
      <td class="num">${esc(formatUsd(cost))}</td>
      <td class="num">${sessions}</td>
      <td class="num">${requests}</td>
      <td class="num">${rows.length}</td>
    </tr>
    <tr class="nested" hidden>
      <td colspan="5">
        <table class="mini">
          <thead><tr>
            <th>${esc(t(lang, "provider"))}</th>
            <th class="num">${esc(t(lang, "cost"))}</th>
            <th class="num">${esc(t(lang, "sessions"))}</th>
            <th class="num">${esc(t(lang, "requests"))}</th>
            <th class="num">${esc(t(lang, "input"))}</th>
            <th class="num">${esc(t(lang, "output"))}</th>
            <th class="num">${esc(t(lang, "cacheRead"))}</th>
            <th class="num">${esc(t(lang, "cacheWrite"))}</th>
          </tr></thead>
          <tbody>${detail}</tbody>
        </table>
      </td>
    </tr>`);
  }
  return parts.join("\n");
}

function sessionDrillRows(lang: Lang, sessions: SessionSummary[], totalCost: number): string {
  return sessions
    .map((s) => {
      const modelLabel =
        s.models.length > 1
          ? s.models.map((m) => formatModelTag(m)).join(" · ")
          : formatModelTag(s.model || s.models[0]);
      const modelTagClass = s.models.length > 1 ? "model-tag multi" : "model-tag";
      const findings = sessionFindings(s);

      const turns = s.turns?.length
        ? s.turns
        : s.prompts.map(
            (p, i): SessionTurnDetail => ({
              index: i + 1,
              prompt: p,
              model: s.model,
              aiAction: "",
              tools: [],
              thinkingBlocks: 0,
              thinkingTokensEst: 0,
              thinkingRedacted: false,
              outputTokensEst: 0,
              assistantMessages: 0,
            }),
          );

      const turnsHtml = turns.length
        ? `<div class="turns">${turns
            .map((turn) => {
              const chips = turn.tools
                .slice(0, 8)
                .map(
                  (x) =>
                    `<span class="tool-chip">${esc(x.name)}${x.count > 1 ? `×${x.count}` : ""}</span>`,
                )
                .join("");
              return `<article class="turn">
                <div class="turn-head">
                  <span class="idx">#${turn.index}</span>
                  ${turn.model ? `<span class="model-tag" title="${esc(turn.model)}">${esc(formatModelTag(turn.model))}</span>` : ""}
                  ${
                    turn.thinkingBlocks
                      ? `<span title="${esc(t(lang, "thinkingRedacted"))}">${esc(t(lang, "thinkingEst"))}: ~${turn.thinkingTokensEst.toLocaleString()} tok (${turn.thinkingBlocks})</span>`
                      : ""
                  }
                  ${turn.outputTokensEst ? `<span>${esc(t(lang, "output"))} ≈ ${turn.outputTokensEst.toLocaleString()} tok</span>` : ""}
                </div>
                <div class="turn-body">
                  <div class="turn-label">${esc(t(lang, "turnPrompt"))}</div>
                  ${expandableBlock(lang, turn.prompt, "turn-prompt")}
                  ${
                    turn.aiAction
                      ? `<div class="turn-label">${esc(t(lang, "aiAction"))}</div>
                  <p class="turn-action">${esc(turn.aiAction)}</p>`
                      : ""
                  }
                  <div class="turn-label">${esc(t(lang, "aiOutput"))}</div>
                  ${
                    turn.output
                      ? expandableBlock(lang, turn.output, "turn-output")
                      : `<p class="empty">${esc(t(lang, "noOutput"))}</p>`
                  }
                  ${chips ? `<div class="tool-chips">${chips}</div>` : ""}
                </div>
              </article>`;
            })
            .join("")}</div>`
        : `<p class="empty">${esc(t(lang, TURN_DETAIL_PROVIDERS.has(s.provider) ? "noPrompts" : "turnDataUnavailable"))}</p>`;

      const findingsHtml = findings.length
        ? `<div class="findings" style="margin-top:0.5rem">${findings
            .map((f) => findingHtml(lang, f, true))
            .join("")}</div>`
        : "";

      const thinkMeta =
        s.thinkingBlocks > 0
          ? `<span title="${esc(t(lang, "thinkingRedacted"))}">${esc(t(lang, "thinkingEst"))}: <strong>~${s.thinkingTokensEst.toLocaleString()}</strong> tok · ${s.thinkingBlocks} block(s)</span>`
          : "";

      return `<tr class="drill">
        <td>
          <details class="row-drill">
            <summary>
              <span class="chev">▶</span>
              <code title="${esc(s.sessionId)}">${esc(shortId(s.sessionId))}</code>
              ${s.estimated ? `<span class="badge est">*</span>` : ""}
            </summary>
          </details>
        </td>
        <td>${esc(fmtWhen(s))}</td>
        <td><span class="provider">${esc(s.provider)}</span></td>
        <td class="num">${esc(formatUsd(s.costUsd))}${costShareBar(s.costUsd, totalCost)}</td>
        <td class="num">${s.requests}</td>
        <td><span class="${modelTagClass}" title="${esc(s.models.join(", ") || s.model || "")}">${esc(modelLabel)}</span></td>
        <td title="${esc(s.project || "")}">${esc(shortProject(s.project))}</td>
      </tr>
      <tr class="nested" hidden>
        <td colspan="7">
          <div class="subhead">${esc(t(lang, "sessionReview"))}${s.title ? ` — ${esc(s.title)}` : ""}</div>
          <div class="review-meta">
            <span>${esc(t(lang, "session"))}: <code>${esc(s.sessionId)}</code></span>
            <span>${esc(t(lang, "provider"))}: <span class="provider">${esc(s.provider)}</span></span>
            <span>${esc(t(lang, "model"))}: <span class="${modelTagClass}">${esc(modelLabel)}</span></span>
            <span>${esc(t(lang, "project"))}: ${esc(s.project || "—")}</span>
            <span>${esc(t(lang, "userTurns"))}: <strong>${s.userTurns || "—"}</strong></span>
            ${thinkMeta}
            <span>${esc(t(lang, "sourceFile"))}: <code title="${esc(s.sourcePath || "")}">${esc(shortSourcePath(s.sourcePath))}</code></span>
          </div>
          <div class="nested-inner cols-review">
            <div>
              <div class="subhead">${esc(t(lang, "userPrompts"))} (${turns.length})</div>
              ${turnsHtml}
              ${findingsHtml}
            </div>
            <div>
              <div class="subhead">${esc(t(lang, "tokenBreakdown"))}</div>
              ${tokenGrid(lang, {
                ...s,
                reasoningTokens: s.reasoningTokens || s.thinkingTokensEst || undefined,
              })}
              <div class="subhead" style="margin-top:0.85rem">${esc(t(lang, "models"))}</div>
              ${modelsMiniTable(
                lang,
                s.modelBreakdown.length
                  ? s.modelBreakdown
                  : s.models.map((m) => ({
                      provider: s.provider,
                      model: m,
                      requests: 0,
                      inputTokens: 0,
                      outputTokens: 0,
                      cacheReadTokens: 0,
                      cacheWriteTokens: 0,
                      reasoningTokens: 0,
                      tokens: 0,
                      costUsd: 0,
                      estimated: s.estimated,
                    })),
              )}
              <div class="subhead" style="margin-top:0.85rem">${esc(t(lang, "tools"))}</div>
              ${toolsMiniTable(lang, s.tools, 25)}
            </div>
          </div>
        </td>
      </tr>`;
    })
    .join("\n");
}

export function renderHtmlReport(
  lang: Lang,
  report: AggregateReport,
  findings: Finding[],
  opts: HtmlReportOpts = {},
): string {
  const tot = report.totals;
  const dayCount = new Set(report.byDay.map((d) => d.date)).size || 1;
  const generated = opts.generatedAt || new Date();
  const sessions = opts.allSessions === false ? report.topSessions : report.sessions;

  if (tot.sessions === 0) {
    return documentShell(
      lang,
      report.range.label,
      `<p class="empty">${esc(t(lang, "noData"))}</p>`,
      generated,
    );
  }

  const nav: [string, string][] = [
    ["summary", t(lang, "summary")],
    ["by-provider", t(lang, "byProvider")],
    ...(report.multiDay && report.byDay.length ? [["by-day", t(lang, "byDay")] as [string, string]] : []),
    ["sessions", t(lang, "allSessions")],
    ...(report.models.length ? [["models", t(lang, "models")] as [string, string]] : []),
    ...(findings.length ? [["advice", t(lang, "advice")] as [string, string]] : []),
    ...(report.tools.length ? [["tools", t(lang, "tools")] as [string, string]] : []),
    ...(opts.inventory?.items.length
      ? [["inventory", t(lang, "inventory")] as [string, string]]
      : []),
  ];

  const focusKpis = `
<section id="summary">
  <div class="kpis">
    <div class="kpi primary">
      <div class="kpi-val">${esc(formatUsd(tot.costUsd))}</div>
      <div class="kpi-label">${esc(t(lang, "cost"))}${tot.estimated ? ` <span class="hint">(${esc(t(lang, "estimated"))})</span>` : ""}</div>
    </div>
    <div class="kpi">
      <div class="kpi-val">${tot.sessions}</div>
      <div class="kpi-label">${esc(t(lang, "sessions"))}</div>
    </div>
    <div class="kpi">
      <div class="kpi-val">${tot.requests}</div>
      <div class="kpi-label">${esc(t(lang, "requests"))}</div>
    </div>
    <div class="kpi">
      <div class="kpi-val">${pct(report.cacheHitRate)}</div>
      <div class="kpi-label">${esc(t(lang, "cacheHit"))}</div>
    </div>
  </div>
  ${panel(
    "token-summary",
    t(lang, "tokenBreakdown"),
    `${esc(formatTokens(tot.inputTokens))} in · ${esc(formatTokens(tot.outputTokens))} out`,
    tokenGrid(lang, tot),
    false,
  )}
</section>`;

  const byProvider = panel(
    "by-provider",
    t(lang, "byProvider"),
    `${report.byProvider.length} · ${esc(formatUsd(tot.costUsd))}`,
    `<div class="scroll"><table class="wide">
      <thead><tr>
        <th>${esc(t(lang, "provider"))}</th>
        <th class="num">${esc(t(lang, "cost"))}</th>
        <th class="num">${esc(t(lang, "sessions"))}</th>
        <th class="num">${esc(t(lang, "requests"))}</th>
        <th class="num">${esc(t(lang, "cacheHit"))}</th>
        <th class="num">${esc(t(lang, "tokens"))}</th>
      </tr></thead>
      <tbody>${providerDrillRows(lang, report)}</tbody>
    </table></div>
    <p class="muted" style="margin:0.65rem 0 0">${esc(t(lang, "drillHint"))}</p>`,
    true,
  );

  let byDay = "";
  if (report.multiDay && report.byDay.length > 0) {
    byDay = panel(
      "by-day",
      t(lang, "byDay"),
      `${dayCount} ${esc(t(lang, "days"))}`,
      `<div class="scroll"><table class="wide">
        <thead><tr>
          <th>${esc(t(lang, "date"))}</th>
          <th class="num">${esc(t(lang, "cost"))}</th>
          <th class="num">${esc(t(lang, "sessions"))}</th>
          <th class="num">${esc(t(lang, "requests"))}</th>
          <th class="num">${esc(t(lang, "provider"))}</th>
        </tr></thead>
        <tbody>${dayDrillRows(lang, report)}</tbody>
      </table></div>
      <p class="muted" style="margin:0.65rem 0 0">${esc(t(lang, "drillHint"))}</p>`,
      dayCount <= 7,
    );
  }

  // Sessions: open when few; collapse when many so the page stays scannable
  const sessionsOpen = sessions.length <= 12;
  const sessionsPanel = panel(
    "sessions",
    t(lang, "allSessions"),
    `${sessions.length}`,
    sessions.length
      ? `<div class="scroll"><table class="wide">
      <thead><tr>
        <th>${esc(t(lang, "session"))}</th>
        <th>${esc(t(lang, "date"))}</th>
        <th>${esc(t(lang, "provider"))}</th>
        <th class="num">${esc(t(lang, "cost"))}</th>
        <th class="num">${esc(t(lang, "requests"))}</th>
        <th>${esc(t(lang, "model"))}</th>
        <th>${esc(t(lang, "project"))}</th>
      </tr></thead>
      <tbody>${sessionDrillRows(lang, sessions, tot.costUsd)}</tbody>
    </table></div>
    <p class="muted" style="margin:0.65rem 0 0">${esc(t(lang, "drillHint"))}</p>`
      : `<p class="empty">—</p>`,
    sessionsOpen,
  );

  let modelsPanel = "";
  if (report.models.length) {
    modelsPanel = panel(
      "models",
      t(lang, "models"),
      `${report.models.length}`,
      `<div class="scroll">${modelsMiniTable(
        lang,
        report.models.map((m) => ({
          ...m,
          model: `${m.provider} / ${m.model}`,
        })),
      )}</div>`,
      false,
    );
  }

  let advicePanel = "";
  if (findings.length) {
    const top = findings.slice(0, 3);
    const rest = findings.slice(3);
    advicePanel = panel(
      "advice",
      t(lang, "advice"),
      `${findings.length}`,
      `<div class="findings">
        ${top.map((f) => findingHtml(lang, f, true)).join("\n")}
        ${rest.map((f) => findingHtml(lang, f, false)).join("\n")}
      </div>`,
      true,
    );
  }

  let toolsPanel = "";
  if (report.tools.length) {
    toolsPanel = panel(
      "tools",
      t(lang, "tools"),
      `${report.tools.length}`,
      toolsMiniTable(lang, report.tools, 40),
      false,
    );
  }

  let inventoryPanel = "";
  if (opts.inventory?.items.length) {
    const mcps = opts.inventory.items.filter((i) => i.kind === "mcp");
    const skills = opts.inventory.items.filter((i) => i.kind === "skill");
    const advLabel = (a: string) => {
      if (a === "off") return `<span class="badge off">${esc(t(lang, "off"))}</span>`;
      if (a === "archive") return `<span class="badge est">${esc(t(lang, "archive"))}</span>`;
      return `<span class="badge">${esc(t(lang, "keep"))}</span>`;
    };
    const parts: string[] = [];
    if (mcps.length) {
      parts.push(`<div class="subhead">MCP</div>
        <div class="scroll"><table class="mini">
          <thead><tr>
            <th>${esc(t(lang, "name"))}</th>
            <th>${esc(t(lang, "provider"))}</th>
            <th class="num">${esc(t(lang, "calls"))}</th>
            <th>${esc(t(lang, "adviceCol"))}</th>
          </tr></thead>
          <tbody>${mcps
            .map(
              (m) => `<tr>
              <td>${esc(m.name)}</td>
              <td>${esc(m.provider)}</td>
              <td class="num">${m.calls}</td>
              <td>${advLabel(m.advice)}</td>
            </tr>`,
            )
            .join("")}</tbody>
        </table></div>`);
    }
    if (skills.length) {
      parts.push(`<div class="subhead" style="margin-top:0.85rem">Skills</div>
        <div class="scroll"><table class="mini">
          <thead><tr>
            <th>${esc(t(lang, "name"))}</th>
            <th>${esc(t(lang, "provider"))}</th>
            <th class="num">${esc(t(lang, "calls"))}</th>
            <th>${esc(t(lang, "adviceCol"))}</th>
          </tr></thead>
          <tbody>${skills
            .map(
              (s) => `<tr>
              <td>${esc(s.name)}</td>
              <td>${esc(s.provider)}</td>
              <td class="num">${s.calls}</td>
              <td>${advLabel(s.advice)}</td>
            </tr>`,
            )
            .join("")}</tbody>
        </table></div>`);
    }
    inventoryPanel = panel("inventory", t(lang, "inventory"), `${opts.inventory.items.length}`, parts.join("\n"), false);
  }

  const body = `
<header class="hero">
  <div>
    <div class="brand">tokusage<span>report</span></div>
    <div class="range">${esc(t(lang, "range"))}: <strong>${esc(report.range.label)}</strong>${
      report.multiDay ? ` · ${dayCount} ${esc(t(lang, "days"))}` : ""
    }</div>
  </div>
</header>
<nav class="nav">${nav.map(([id, label]) => `<a href="#${id}">${esc(label)}</a>`).join("")}</nav>
${focusKpis}
${byProvider}
${byDay}
${sessionsPanel}
${modelsPanel}
${advicePanel}
${toolsPanel}
${inventoryPanel}
`;

  return documentShell(lang, report.range.label, body, generated);
}

function documentShell(lang: Lang, rangeLabel: string, body: string, generated: Date): string {
  const title = `tokusage — ${rangeLabel}`;
  const genStr = generated.toISOString().replace("T", " ").slice(0, 19) + " UTC";
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet"/>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
${body}
<footer class="foot">
  <span>tokusage · * = ${esc(t(lang, "estimated"))}</span>
  <span>${esc(t(lang, "generated"))}: ${esc(genStr)}</span>
</footer>
</div>
<script>${JS}</script>
</body>
</html>
`;
}
