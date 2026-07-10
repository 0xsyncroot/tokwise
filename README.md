# tokusage

A 100% local CLI that reads the session logs your AI coding agents already write to
disk — Claude Code, Codex, Cursor, Gemini, and more — and turns them into a token
usage, cost, and optimization report. No API keys, no network calls, nothing ever
leaves your machine.

> Published as `tokusage` on npm. Source lives at
> [0xsyncroot/tokwise](https://github.com/0xsyncroot/tokwise) — the name `tokwise` was
> already taken on the npm registry.

Token totals reconcile with [`ccusage`](https://github.com/ryoppippi/ccusage) to
within ~0.1% for Claude and Codex, and `tokusage` correctly excludes Codex
fork/subagent-replay double counting — a known bug class in naive parsers that
re-sums the same transcript twice.

## Quickstart

```bash
npx tokusage                 # today's usage: terminal summary + HTML report
```

Or install it globally:

```bash
npm install -g tokusage
tokusage
```

Or run straight from source without installing from a registry:

```bash
npx github:0xsyncroot/tokwise
```

## Commands

The default command has no name — `tokusage` on its own is `tokusage report`.

```bash
tokusage                                    # today's usage: terminal + HTML report
tokusage 2026-07-01                         # report for a single day
tokusage --from 2026-07-01 --to 2026-07-09  # report for a date range
tokusage --all --provider claude,codex      # everything ever recorded, filtered by provider
tokusage --all --json > report.json         # machine-readable, no HTML written
tokusage --out ./report.html --all          # choose where the HTML report is saved

tokusage detect                             # which providers have local data on this machine
tokusage advice --all                       # just the ranked optimization findings, no HTML
tokusage inventory --all                    # MCP/skills declared vs. actually used
tokusage session <id> --all                 # deep-dive a single session (id prefix is fine)
```

Flags shared across `report` / `advice` / `inventory` / `session`:

| Flag | Meaning |
|---|---|
| `--from <date>`, `--to <date>` | date range, `YYYY-MM-DD` |
| `--all` | every session ever recorded, ignores day/`--from`/`--to` |
| `--lang <en\|vi>` | output language, defaults to `en` |
| `--provider <list>` | comma-separated provider ids, e.g. `claude,codex` |
| `--json` | machine-readable output instead of the terminal view |

`report`-only flags: `--no-html` (skip writing the HTML report), `--out <file>`
(explicit output path), `--top <n>` (how many sessions to list in the *terminal*
report — the HTML report always lists every session).

Every command also supports `-V/--version` and `-h/--help`; run `tokusage --help` or
`tokusage <command> --help` for the full built-in reference.

### HTML report location

By default `report` writes an HTML file to
`~/.local/state/tokusage/reports/report-<range>-<timestamp>.html` (the XDG state
directory; override the root with `TOKWISE_STATE_DIR` or `XDG_STATE_HOME`). Pass
`--out <file>` to pick an explicit path, or `--no-html` to skip it entirely.

**Note for anyone on an older version:** earlier releases wrote `tokusage-report.html`
into the current working directory. That default is gone — reports now live under the
XDG state path above.

## Providers

| Provider | Local data path | Quality | Turn-by-turn detail in HTML report |
|---|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` (incl. `subagents/**`) | full | yes — prompts, output, tool calls, thinking |
| Codex CLI | `~/.codex/sessions/**/rollout-*.jsonl` | full | no — token/cost totals only |
| Gemini CLI | `~/.gemini/tmp/*/chats/session-*` | full | no — token/cost totals only |
| Cursor Agent | `~/.cursor/projects/*/agent-transcripts` | estimated | yes — prompts, output, tool calls |
| GitHub Copilot | `~/.copilot/session-state` | estimated | no — token/cost totals only |
| Antigravity | `~/.gemini/antigravity/conversations/*.pb` | sessions-only | no — token/cost totals only |
| Cline | `~/.cline/data/tasks` + VS Code globalStorage | full | no — token/cost totals only |

"Quality" is about how the token/cost numbers are derived: `full` means real usage
counters from the transcript, `estimated` means tokens are approximated from text
length, `sessions-only` means only session metadata is on disk (see Antigravity
below).

"Turn-by-turn detail" is a separate axis: whether the HTML report's per-session
drill-down (prompt/output/tool-call/thinking timeline) is available at all. **That
drill-down is currently implemented only for Claude Code and Cursor Agent** — they're
the only two collectors that capture message *content*, not just token counts. Every
other provider still gets accurate token/cost totals and shows up correctly
everywhere else in the report; the report UI says so explicitly rather than rendering
a misleading empty state.

Around 42 more provider IDs are registered for `tokusage detect` — path-detection
stubs sourced from the CodeBurn / Tokscale / continues / agentscrub provider
matrices, with no usage parsing wired up yet. Run `tokusage detect` to see the full
list and what's actually found on your machine.

### Thinking / reasoning data

Claude Code sessions report real thinking-block counts and token estimates, because
Claude Code writes the thinking text to disk. Codex does not: inspecting actual
`~/.codex/sessions/**/rollout-*.jsonl` files shows OpenAI stores reasoning as
`encrypted_content` with an empty `summary` — only the token count
(`reasoning_output_tokens`) is available locally, never the text. That count still
appears in the cost/token breakdown as "Reasoning". This is a platform limitation
(OpenAI encrypts the reasoning payload), not a gap in `tokusage`.

In the HTML report, long prompts and outputs in the per-turn view show a short
preview with a native "show full" expander (plain `<details>`, no JavaScript) so you
can read the complete text on demand.

## Performance & caching

Parsed transcript files are cached per `(path, mtime, size)` under
`~/.cache/tokusage/` (override the root with `TOKWISE_CACHE_DIR` or
`XDG_CACHE_HOME`). Session transcripts are append-only, so an unchanged file always
re-yields identical results from cache. This applies both to the usage/cost
collectors and to the HTML report's per-turn enrichment pass.

Measured effect: a report over the same dataset went from 6.9s cold to under 1s warm.
Disable caching entirely with `TOKWISE_NO_CACHE=1`.

## Pricing

Costs are computed **per event, per platform**: each usage event is priced with its
own provider and model, mixed-model sessions are summed per event, and
provider-reported costs win when present. Model rollups are scoped to their
platform, so the same model id used on two platforms stays two separate rows.

Built-in rates (USD / 1M tokens) cover current Anthropic (Fable 5, Opus 4.5–4.8,
Sonnet 5/4.x, Haiku), OpenAI (GPT-5.x incl. 5.4/5.5, codex, o-series), and Google
(Gemini 3.5/3.1/3/2.5) generations. Billing semantics differ per platform and are
handled accordingly:

- **Anthropic**: cache read = 0.1× input, cache write (5m TTL) = 1.25× input.
- **OpenAI/Codex**: reasoning tokens are already inside `output_tokens` (never
  double-billed); cached input is discounted, no cache-write charge.
- **Gemini**: thinking tokens are billed on top, at the output rate.
- **Antigravity**: on-disk data has no token counts (sessions-only) — cost is always
  $0, never fabricated.

Override any rate via `~/.config/tokusage/pricing.json` (or `TOKWISE_PRICING_FILE`):

```json
{ "models": [{ "match": "gpt-5.5", "provider": "codex", "rates": { "input": 5, "output": 30, "cacheRead": 0.5, "cacheWrite": 0 } }] }
```

## Inventory

`tokusage inventory` compares **declared** MCP servers/skills (e.g. `~/.claude.json`
`mcpServers`, `~/.claude/skills`) against what was **actually called** in your
sessions, then suggests turning off or archiving the unused ones with an estimated
token/cost savings.

## Advice

`tokusage advice` prints just the ranked optimization findings — the same findings
engine used by the full report (costly sessions, unused MCP/skills, low cache hit
rate, expensive-model share, tool thrashing, and more) — without generating the full
report or writing HTML.

## Environment variables

| Variable | Controls |
|---|---|
| `TOKWISE_STATE_DIR` / `XDG_STATE_HOME` | where the HTML report is written |
| `TOKWISE_CACHE_DIR` / `XDG_CACHE_HOME` | where the parse cache is stored |
| `TOKWISE_CONFIG_DIR` / `XDG_CONFIG_HOME` | where `pricing.json` is looked up |
| `TOKWISE_PRICING_FILE` | direct override path for the pricing file |
| `TOKWISE_NO_CACHE=1` | disable the parse cache entirely |

## License

MIT
