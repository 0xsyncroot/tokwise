#!/usr/bin/env node
import { Command } from "commander";
import type { Lang } from "./types.js";
import { resolveDateRange } from "./dates.js";
import { collectAll, getProviders, providers } from "./providers/index.js";
import { aggregate } from "./aggregate.js";
import { buildAdvice, buildInventory, sessionFindings } from "./advice/index.js";
import {
  renderAdvice,
  renderDetect,
  renderInventory,
  renderReport,
  renderSession,
} from "./render/terminal.js";

const program = new Command();

program
  .name("tokusage")
  .description("Analyze local AI coding agent token usage, cost, and optimization tips")
  .version("0.1.0")
  .argument("[day]", "YYYY-MM-DD (default: today)")
  .option("--from <date>", "Range start YYYY-MM-DD")
  .option("--to <date>", "Range end YYYY-MM-DD")
  .option("--all", "All sessions", false)
  .option("--lang <lang>", "en | vi", "en")
  .option("--provider <list>", "Comma-separated provider ids")
  .option("--json", "JSON output", false)
  .option("--top <n>", "Top sessions", "10")
  .action(async (day: string | undefined, opts) => {
    await runReport({ day, ...opts });
  });

program
  .command("detect")
  .description("List providers and whether local data was found")
  .option("--lang <lang>", "en | vi", "en")
  .option("--json", "JSON output", false)
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
  .description("Ranked optimization findings for a date range")
  .argument("[day]", "YYYY-MM-DD (default: today)")
  .option("--from <date>", "Range start")
  .option("--to <date>", "Range end")
  .option("--all", "All sessions", false)
  .option("--lang <lang>", "en | vi", "en")
  .option("--provider <list>", "Comma-separated provider ids")
  .option("--json", "JSON output", false)
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
  .description("MCP/skills declared vs used + on/off advice")
  .argument("[day]", "YYYY-MM-DD (default: today)")
  .option("--from <date>", "Range start")
  .option("--to <date>", "Range end")
  .option("--all", "All sessions", false)
  .option("--lang <lang>", "en | vi", "en")
  .option("--provider <list>", "Comma-separated provider ids")
  .option("--json", "JSON output", false)
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
  .description("Deep-dive one session")
  .argument("<id>", "Session id (prefix ok)")
  .option("--from <date>", "Range start")
  .option("--to <date>", "Range end")
  .option("--all", "Search all sessions", true)
  .option("--lang <lang>", "en | vi", "en")
  .option("--provider <list>", "Comma-separated provider ids")
  .option("--json", "JSON output", false)
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

async function runReport(opts: {
  day?: string;
  from?: string;
  to?: string;
  all?: boolean;
  lang?: string;
  provider?: string;
  json?: boolean;
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
  console.log(renderReport(lang, report, findings));
}

// silence unused
void getProviders;

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
