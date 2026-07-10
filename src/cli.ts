#!/usr/bin/env node
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { Command } from "commander";
import type { Lang } from "./types.js";
import { resolveDateRange } from "./dates.js";
import { collectAll, getProviders, providers, IMPLEMENTED } from "./providers/index.js";
import { aggregate } from "./aggregate.js";
import { buildAdvice, buildInventory, sessionFindings } from "./advice/index.js";
import {
  renderAdvice,
  renderDetect,
  renderInventory,
  renderReport,
  renderSession,
} from "./render/terminal.js";
import { renderHtmlReport } from "./render/html.js";
import { t } from "./i18n/index.js";
import { defaultReportPath } from "./paths.js";
import { enrichSessionDetails } from "./session-detail.js";

const program = new Command();

const IMPLEMENTED_PROVIDERS = providers.filter((p) => IMPLEMENTED.has(p.id));

program
  .name("tokusage")
  .description(
    "Analyze local AI coding agent token usage, cost, and optimization tips.\n" +
      "Reads session logs already on disk (Claude Code, Codex, Gemini CLI, Cursor, Copilot, ...).\n" +
      "100% local: no API keys, no network calls, nothing uploaded.",
  )
  .version("0.2.1", "-V, --version", "output the installed tokusage version")
  .argument("[day]", "report for one day, YYYY-MM-DD (default: today)")
  .option("--from <date>", "range start, YYYY-MM-DD (use with --to)")
  .option("--to <date>", "range end, YYYY-MM-DD (use with --from)")
  .option("--all", "every session ever recorded, ignores day/--from/--to", false)
  .option("--lang <lang>", "output language: en | vi", "en")
  .option(
    "--provider <list>",
    `comma-separated provider ids to include, e.g. claude,codex (see: tokusage detect)`,
  )
  .option("--json", "print machine-readable JSON instead of the terminal report; skips the HTML report", false)
  .option("--no-html", "skip writing the HTML report (an HTML report is written by default)")
  .option(
    "--out <file>",
    "HTML report path (default: ~/.local/state/tokusage/reports/report-<range>-<timestamp>.html)",
  )
  .option("--top <n>", "how many sessions to list in the terminal report; the HTML report always lists all", "10")
  .action(async (day: string | undefined, opts) => {
    await runReport({ day, ...opts });
  })
  .addHelpText(
    "after",
    `
This is the default command ("report") — running "tokusage" with no subcommand is the same
as "tokusage report". It prints a terminal summary and writes a drill-down HTML report.

Examples:
  $ tokusage                                Today's usage: terminal + HTML report
  $ tokusage 2026-07-01                     Report for a single day
  $ tokusage --from 2026-07-01 --to 2026-07-09
  $ tokusage --all --provider claude,codex  Everything ever recorded, filtered by provider
  $ tokusage --all --json > report.json     Machine-readable, no HTML written
  $ tokusage --out ./report.html --all      Choose where the HTML report is saved

Other commands:
  $ tokusage detect                         Which providers have local data on this machine
  $ tokusage advice --all                   Just the ranked optimization findings
  $ tokusage inventory --all                MCP/skills declared vs. actually used
  $ tokusage session <id> --all             Deep-dive a single session (id prefix ok)

Providers with real usage data (${IMPLEMENTED_PROVIDERS.length}): ${IMPLEMENTED_PROVIDERS.map((p) => p.id).join(", ")}
  ~${providers.length - IMPLEMENTED_PROVIDERS.length} more are path-detected only — run "tokusage detect" for the full list.

Env vars:
  TOKWISE_STATE_DIR / XDG_STATE_HOME   Where HTML reports are written (default state dir)
  TOKWISE_CONFIG_DIR / XDG_CONFIG_HOME Where pricing.json overrides are read from
  TOKWISE_PRICING_FILE                 Override the pricing.json path directly
  TOKWISE_NO_CACHE=1                   Disable the parsed-events cache in ~/.cache/tokusage

Docs: https://github.com/0xsyncroot/tokwise#readme
`,
  );

program
  .command("detect")
  .description("List every known provider and whether local usage data was found for it")
  .option("--lang <lang>", "output language: en | vi", "en")
  .option("--json", "print machine-readable JSON instead of a table", false)
  .addHelpText(
    "after",
    `
Examples:
  $ tokusage detect                 Table of every provider id + found paths
  $ tokusage detect --json          Same data as JSON (id, name, quality, found, paths)

Use the "id" column with --provider on other commands, e.g. --provider claude,codex.
`,
  )
  .action((opts) => {
    const lang = (opts.lang as Lang) || "en";
    if (opts.json) {
      console.log(
        JSON.stringify(
          providers.map((p) => {
            const d = p.detect();
            return { id: p.id, name: p.name, quality: p.quality, ...d };
          }),
          null,
          2,
        ),
      );
      return;
    }
    console.log(renderDetect(lang, providers));
  });

program
  .command("advice")
  .description("Ranked optimization findings only (no full report, no HTML)")
  .argument("[day]", "report for one day, YYYY-MM-DD (default: today)")
  .option("--from <date>", "range start, YYYY-MM-DD (use with --to)")
  .option("--to <date>", "range end, YYYY-MM-DD (use with --from)")
  .option("--all", "every session ever recorded, ignores day/--from/--to", false)
  .option("--lang <lang>", "output language: en | vi", "en")
  .option("--provider <list>", "comma-separated provider ids to include, e.g. claude,codex")
  .option("--json", "print machine-readable JSON instead of the terminal list", false)
  .addHelpText(
    "after",
    `
Examples:
  $ tokusage advice                 Findings for today
  $ tokusage advice --all           Findings across everything ever recorded
  $ tokusage advice --from 2026-07-01 --to 2026-07-09 --json
`,
  )
  .action(async (day, opts) => {
    const lang = (opts.lang as Lang) || "en";
    const range = resolveDateRange({
      day,
      from: opts.from,
      to: opts.to,
      all: opts.all,
    });
    const filter = opts.provider
      ? String(opts.provider).split(",").map((s: string) => s.trim())
      : undefined;
    const events = await collectAll(range, filter);
    const report = aggregate(events, range, 10);
    const inventory = buildInventory(events, report);
    const findings = buildAdvice(report, inventory);
    if (opts.json) {
      console.log(JSON.stringify(findings, null, 2));
      return;
    }
    console.log(renderAdvice(lang, findings));
  });

program
  .command("inventory")
  .description("MCP servers/skills declared vs. actually used, with on/off advice")
  .argument("[day]", "report for one day, YYYY-MM-DD (default: today)")
  .option("--from <date>", "range start, YYYY-MM-DD (use with --to)")
  .option("--to <date>", "range end, YYYY-MM-DD (use with --from)")
  .option("--all", "every session ever recorded, ignores day/--from/--to", false)
  .option("--lang <lang>", "output language: en | vi", "en")
  .option("--provider <list>", "comma-separated provider ids to include, e.g. claude,codex")
  .option("--json", "print machine-readable JSON instead of the terminal list", false)
  .addHelpText(
    "after",
    `
Examples:
  $ tokusage inventory              Declared vs. used MCP/skills for today
  $ tokusage inventory --all        Same, across everything ever recorded
`,
  )
  .action(async (day, opts) => {
    const lang = (opts.lang as Lang) || "en";
    const range = resolveDateRange({
      day,
      from: opts.from,
      to: opts.to,
      all: opts.all,
    });
    const filter = opts.provider
      ? String(opts.provider).split(",").map((s: string) => s.trim())
      : undefined;
    const events = await collectAll(range, filter);
    const report = aggregate(events, range, 10);
    const inventory = buildInventory(events, report);
    if (opts.json) {
      console.log(JSON.stringify(inventory, null, 2));
      return;
    }
    console.log(renderInventory(lang, inventory));
  });

program
  .command("session")
  .description("Deep-dive one session: turn-by-turn tokens, cost, and findings")
  .argument("<id>", "session id, a prefix of it, or 'provider::sessionId'")
  .option("--from <date>", "narrow the search to a range start, YYYY-MM-DD")
  .option("--to <date>", "narrow the search to a range end, YYYY-MM-DD")
  .option("--all", "search every session ever recorded", true)
  .option("--lang <lang>", "output language: en | vi", "en")
  .option("--provider <list>", "comma-separated provider ids to search, e.g. claude,codex")
  .option("--json", "print machine-readable JSON instead of the terminal view", false)
  .addHelpText(
    "after",
    `
Examples:
  $ tokusage session 8f3a              Look up by id prefix (searches all sessions)
  $ tokusage session claude::8f3a...   Disambiguate with 'provider::sessionId'
  $ tokusage session 8f3a --json

Tip: run "tokusage --all --json" or the HTML report first to find session ids.
`,
  )
  .action(async (id, opts) => {
    const lang = (opts.lang as Lang) || "en";
    const range = resolveDateRange({
      from: opts.from,
      to: opts.to,
      all: opts.all !== false,
    });
    const filter = opts.provider
      ? String(opts.provider).split(",").map((s: string) => s.trim())
      : undefined;
    const events = await collectAll(range, filter);
    const report = aggregate(events, range, 50);
    const s = report.sessions.find(
      (x) =>
        x.sessionId === id ||
        x.sessionId.startsWith(id) ||
        `${x.provider}::${x.sessionId}` === id,
    );
    const findings = s ? sessionFindings(s) : [];
    if (opts.json) {
      console.log(JSON.stringify({ session: s, findings }, null, 2));
      return;
    }
    console.log(renderSession(lang, report, id, findings));
  });

function writeHtml(html: string, outPath: string | undefined, rangeLabel: string): string {
  const path = outPath
    ? isAbsolute(outPath)
      ? outPath
      : resolve(outPath)
    : defaultReportPath(rangeLabel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, html, "utf8");
  return path;
}

async function runReport(opts: {
  day?: string;
  from?: string;
  to?: string;
  all?: boolean;
  lang?: string;
  provider?: string;
  json?: boolean;
  /** Commander --no-html sets this to false; default true */
  html?: boolean;
  out?: string;
  top?: string;
}) {
  const lang = (opts.lang as Lang) || "en";
  const range = resolveDateRange({
    day: opts.day,
    from: opts.from,
    to: opts.to,
    all: opts.all,
  });
  const filter = opts.provider
    ? String(opts.provider).split(",").map((s) => s.trim())
    : undefined;
  const top = Number(opts.top) || 10;

  const events = await collectAll(range, filter);
  const report = aggregate(events, range, top);
  const inventory = buildInventory(events, report);
  const findings = buildAdvice(report, inventory);

  if (opts.json) {
    console.log(JSON.stringify({ report, findings, inventory }, null, 2));
    return;
  }

  // HTML on by default. --no-html always skips (even with --out).
  const writeHtmlReport = opts.html !== false;
  let htmlPath: string | undefined;
  if (writeHtmlReport) {
    // Load real transcript prompts for review (claude + cursor-agent)
    await enrichSessionDetails(report.sessions);
    const html = renderHtmlReport(lang, report, findings, { inventory });
    htmlPath = writeHtml(html, opts.out, report.range.label);
  }

  console.log(renderReport(lang, report, findings));

  if (htmlPath) {
    console.log("");
    console.log(t(lang, "htmlWritten", { path: htmlPath }));
    console.log(t(lang, "htmlSeeDetails", { path: htmlPath }));
  }
}

// silence unused
void getProviders;

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
