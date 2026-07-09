# tokusage

Local CLI to analyze **AI coding agent** token usage, cost, MCP/skills waste, and optimization tips.

> Published as `tokusage` on npm (project source lives at [0xsyncroot/tokwise](https://github.com/0xsyncroot/tokwise) — `tokwise` was already taken on the npm registry).

```bash
npx tokusage
npx tokusage --lang vi
npx tokusage --from 2026-07-01 --to 2026-07-09
npx tokusage --all --provider claude,codex
npx tokusage detect
npx tokusage inventory
npx tokusage advice
npx tokusage session <id>
```

Or straight from source without a registry, using the same commands:

```bash
npx github:0xsyncroot/tokwise
```

100% local — reads session logs on disk. No API keys. No uploads.

Token totals reconcile with `ccusage` to within ~0.1% (Claude + Codex), while also
excluding Codex fork-replay double counting. Repeat runs are fast: parsed files are
cached per (path, mtime, size) in `~/.cache/tokusage/` — first run pays the full parse,
subsequent runs take ~1–2s. Disable with `TOKWISE_NO_CACHE=1`.

## Implemented collectors (v0.1)

| Provider | Path | Quality |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` (incl. `subagents/**`) | full |
| Codex CLI | `~/.codex/sessions/**/rollout-*.jsonl` | full |
| Gemini CLI | `~/.gemini/tmp/*/chats/session-*` | full |
| Cursor Agent | `~/.cursor/projects/*/agent-transcripts` | estimated |
| GitHub Copilot | `~/.copilot/session-state` | estimated |
| Antigravity | `~/.gemini/antigravity/conversations/*.pb` | sessions-only |
| Cline | `~/.cline/data/tasks` + VS Code globalStorage | full |

~40 more provider IDs are registered for `tokusage detect` (stubs) — path matrix from CodeBurn / Tokscale / continues / agentscrub.

## Pricing

Costs are computed **per event, per platform**: each usage event is priced with its own
provider + model (mixed-model sessions are summed per event, provider-reported costs win
when present). Model rollups are scoped to their platform — the same model id used on two
platforms stays two rows.

Built-in rates (USD / 1M tokens) cover the current Anthropic (Fable 5, Opus 4.5–4.8,
Sonnet 5/4.x, Haiku), OpenAI (GPT-5.x incl. 5.4/5.5, codex, o-series), and Google
(Gemini 3.5/3.1/3/2.5) generations. Semantics differ per platform and are handled:

- **Anthropic**: cache read = 0.1× input, cache write (5m TTL) = 1.25× input.
- **OpenAI/Codex**: reasoning tokens are already inside `output_tokens` (never double-billed);
  cached input is discounted, no cache-write charge.
- **Gemini**: thinking tokens billed on top at the output rate.
- **Antigravity**: on-disk data has no token counts (sessions-only) — cost is always $0,
  never fabricated.

Override any rate via `~/.config/tokusage/pricing.json` (or `TOKWISE_PRICING_FILE`):

```json
{ "models": [{ "match": "gpt-5.5", "provider": "codex", "rates": { "input": 5, "output": 30, "cacheRead": 0.5, "cacheWrite": 0 } }] }
```

## Inventory

`tokusage inventory` compares **declared** MCP/skills (e.g. `~/.claude.json` `mcpServers`, `~/.claude/skills`) vs **used** tool calls in sessions, then suggests OFF / archive with estimated savings.

## License

MIT
