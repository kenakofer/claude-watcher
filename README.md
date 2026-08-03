# claude-watcher

A local, zero-dependency dashboard for Claude Code token usage and cost.

It tails the JSONL transcripts Claude Code already writes, normalizes them into
an event stream, and serves a live dashboard over HTTP + SSE. Nothing is sent
anywhere — it reads local files and serves `localhost`.

<!-- Add a screenshot at docs/dashboard.png and uncomment:
![dashboard](docs/dashboard.png)
-->


## Why

Claude Code records every model call — tokens, model, cost inputs, tool calls,
and compaction boundaries — but there is no built-in way to see that history
over time. This turns it into charts: what you spent, on which models, in which
projects, and how your context window behaves across a long session.

## Quick start

Requires Node.js 18+. No `npm install` — there are no dependencies.

```bash
git clone https://github.com/kenakofer/claude-watcher
cd claude-watcher
node watcher.js
```

Open <http://localhost:4791>. The page updates live as Claude Code writes.

```
node watcher.js [--projects <dir>] [--port <n>] [--host <addr>] [--poll <ms>]

  --projects  transcript root            (default ~/.claude/projects)
  --port      HTTP/SSE port              (default 4791)
  --host      bind address               (default 127.0.0.1 — see Privacy)
  --poll      filesystem poll interval   (default 1000ms)
```

## What it shows

Panels are collapsible; the dashboard opens on the most recent session with
model calls, so the breakdown is populated on first paint.

- **Session breakdown** for the selected session — the four token types stacked per
  model call, with exact compaction boundaries marked. The stack height *is*
  the context window, so this is the sawtooth: context inflating turn over turn,
  then dropping hard at a compaction.

  Two views, because tokens and money are genuinely different questions:

  - **Tokens per turn** — the stack height is the context window. Shows the
    sawtooth and how large context actually gets. Cache read is ~99% of a turn,
    so the other three bands are near-invisible here.
  - **Cost per turn** — each band is scaled by what that token type costs, so
    **area is money**. Not a normalization trick: an output token is 50× the
    price of a cache-read token on Opus, so the expensive-but-thin bands rise
    into view on their own merits. This is the view that answers "where did the
    money actually go," and output tokens turn out to matter far more than their
    token count suggests.

  In the cost view, output (green) becomes a clearly visible band; in the token
  view it all but disappears, because it is a tiny share of tokens and a real
  share of the money.

  <!-- Add screenshots and uncomment:
  ![cost per turn](docs/session-cost.png)
  ![tokens per turn](docs/session-tokens.png)
  -->


  A single re-cache of a large context can cost ~30× the median call, which
  would flatten everything else, so the cost axis clips at roughly the 98th
  percentile. Clipped calls are counted in the legend and still report their
  true value on hover — nothing is silently dropped.

- **Sessions table** — AI-generated titles, project, calls, current context
  window, cost, last activity. Subagent runs are tagged with their agent type.
  Selecting a row retargets the session breakdown above.

Every chart has a table view, so no value is reachable only by hovering.

## Where the data comes from

Claude Code writes one JSONL file per session under
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, appending as it goes.
Subagent runs get their own transcripts under
`<session-id>/subagents/agent-*.jsonl` plus a `.meta.json` naming the agent type.

Assistant entries carry a full `usage` block:

```json
{
  "type": "assistant",
  "message": {
    "model": "claude-opus-5",
    "usage": {
      "input_tokens": 2,
      "cache_creation_input_tokens": 9137,
      "cache_read_input_tokens": 12725,
      "output_tokens": 330,
      "cache_creation": { "ephemeral_1h_input_tokens": 9137 }
    }
  },
  "timestamp": "..."
}
```

That is everything needed for cost, so — unlike the equivalent for other CLI
agents — **no OpenTelemetry export or environment setup is required**.

Compaction is also explicit rather than inferred. A `compact_boundary` system
entry carries `preTokens`, `postTokens`, and the trigger, so the markers on the
context chart are exact boundaries, not a guess at a drop in the trend.

## Privacy

Your transcripts contain your prompts. This tool reads them, and the HTTP API
serves them back verbatim — `/api/events` includes prompt text, session titles,
the working directory of each session, and git branch names. There is no
authentication on any endpoint.

Two consequences worth being deliberate about:

- **The server binds to `127.0.0.1` by default**, so only your own machine can
  reach it. `--host 0.0.0.0` opens it to the whole network; on shared or public
  WiFi that publishes your prompts to anyone who can reach the port. The flag
  exists for people who genuinely want a dashboard on another device, and it
  prints a warning when used.
- **Nothing is sent anywhere.** No telemetry, no external calls; the process
  reads local files and serves them on a local port. The pricing table is a
  static file in this repo, not a lookup.

Screenshots of the dashboard show real prompt text and project paths. Worth a
look before posting one.

### Normalized events

| kind | from | carries |
|---|---|---|
| `prompt` | `user` entries that aren't tool results | prompt text |
| `chat_completion` | `assistant` entries with a model | model, usage, effort, computed cost |
| `tool_call` | `tool_use` blocks | tool name |
| `compaction` | `system` / `compact_boundary` | pre/post tokens, trigger |
| `turn_duration` | `system` / `turn_duration` | duration, message count |

## Cost model

Rates live in [`pricing.js`](pricing.js) as USD per million tokens, and are
applied per call against that call's own timestamp and model.

| Model | Input | Output |
|---|---:|---:|
| Opus 5, Opus 4.8/4.7/4.6/4.5 | $5 | $25 |
| Fable 5 / Mythos 5 | $10 | $50 |
| Sonnet 5, Sonnet 4.6/4.5 | $3 | $15 |
| Haiku 4.5 | $1 | $5 |

Derived rates: cache reads are **0.1×** input; cache writes are **1.25×** at the
5-minute TTL and **2×** at the 1-hour TTL. The two TTLs are tracked separately
rather than averaged, because Claude Code writes almost exclusively 1h entries —
collapsing them would understate cost by ~35% of the cache-write line.

Two other cases are handled: Sonnet 5's introductory $2/$10 pricing (applied only
to calls before 2026-08-31) and Opus fast mode at $10/$50.

Rates are applied per call against that call's own model and timestamp, so a
mid-history price change doesn't contaminate calls on either side of it.

### If you're on a subscription plan

**These are list API prices, not your bill.** On Pro/Max the figures show what
the same usage *would* cost at API rates — useful for comparing sessions,
spotting expensive patterns, and seeing which token type dominates. They are not
a percentage of your plan's allowance.

The transcripts contain **no cost, quota, credit, or plan fields** — only raw
token counts. The percent-usage figures Claude Code shows you come from a
server-side response and are not written to disk, so no local tool can reproduce
them. This project deliberately does not try to infer them: a guessed
"percentage of your limit" would look authoritative and be wrong.

Verify rates against [current pricing](https://claude.com/pricing) before
relying on the dollar figures.

## HTTP API

| Endpoint | Returns |
|---|---|
| `GET /api/sessions` | one summary object per session |
| `GET /api/sessions/:id` | session summary + its full event timeline |
| `GET /api/events?limit=N` | normalized events across all sessions |
| `GET /api/stats` | totals, daily spend, per-model and per-tool breakdowns |
| `GET /stream` | SSE; pushes each new batch of events as they are parsed |

```bash
curl -s localhost:4791/api/stats | jq '.totals.cost'
curl -sN localhost:4791/stream
```

## Notes and limitations

- **Read-only.** The watcher opens transcripts for reading and never writes to
  `~/.claude`.
- **In-memory.** State is rebuilt from the transcripts on each start (~4s for
  ~30 sessions) and is not persisted; the transcripts are the source of truth.
  Events are capped at 200k in memory, oldest dropped first.
- **Project names are approximate.** Claude Code encodes the cwd by replacing
  path separators with `-`, which is lossy for paths that contain a literal `-`.
  Displayed project paths may render those as `/`. The authoritative `cwd` is
  read from the entries themselves.
- **Resumed sessions.** Transcripts can be appended out of chronological order,
  so the session chart sorts by timestamp. Compaction boundaries outside the
  plotted call range are reported in the legend rather than drawn at an
  arbitrary edge.
- Polling is a `stat` per transcript per interval — cheap, and it avoids
  inotify watch limits on large project trees.

## License

MIT — see [LICENSE](LICENSE).
