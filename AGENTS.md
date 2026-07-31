# AGENTS.md

Guidance for agents (and humans) working on this repo.

## What this is

A local observability stack for Claude Code sessions, built on the JSONL
transcripts Claude Code writes to `~/.claude/projects`. No CLI configuration,
no OTel exporter, no dependencies — the transcripts already contain per-call
token usage.

- **`watcher.js`** — tails transcripts, normalizes entries into a flat event
  stream (`prompt`, `chat_completion`, `tool_call`, `compaction`,
  `turn_duration`), folds them into per-session summaries, and serves both over
  HTTP (`/api/*`) and SSE (`/stream`). All state is in memory.
- **`pricing.js`** — per-model USD/MTok rates and the cost breakdown function.
- **`dashboard.html`** — single-file dashboard; no build step, no CDN. Fetches
  the aggregate endpoints and re-renders on SSE activity.

See `README.md` for usage and the data-source notes.

## Key gotcha 1: transcripts are not chronological

A resumed session appends entries whose timestamps predate ones already in the
file, and subagent transcripts are ingested whole rather than interleaved. So
**ingest order is not time order**.

Anything that plots or aligns against time must sort by `timestamp` first —
`renderSessionDetail` in `dashboard.html` does this. Charting in file order
silently misplaces both the trend line and the compaction markers drawn against
it (this was a real bug: 8 of 35 markers landed in range, clustered at one
edge, before the sort was added).

Related: a session's `compactions` list can include boundaries outside the
range of calls actually present in its event list. Those are counted in the
legend rather than clamped to an edge — clamping invents a drop the data
doesn't show.

## Key gotcha 2: cache-write TTL matters

Cache writes are billed at **1.25×** input for the 5-minute TTL and **2×** for
the 1-hour TTL. Claude Code writes almost exclusively 1h entries (~98% of
cache-creation tokens in practice), so treating them as one blended rate
understates cost materially. `costOf` in `pricing.js` reads the
`usage.cache_creation.ephemeral_{1h,5m}_input_tokens` split and only falls back
to the flat `cache_creation_input_tokens` (assuming 1h) when the split is
absent.

Cache reads dominate total spend — typically ~65–85%. If a change makes the
cache lines look small, that is the bug, not the data.

## Adding a model

Add an entry to `MODELS` in `pricing.js` keyed by the bare model id (no date
suffix — `normalizeModel` strips a trailing `-YYYYMMDD`). Introductory pricing
uses the `intro: { until, input, output }` shape and is applied per call
against the call's own timestamp, so historical calls keep their real rate.

Unknown models are not guessed at: `costOf` returns zeros with
`priced: false`, and their tokens still appear in the token totals.

## Key gotcha 3: cache read swamps the per-session token stack

In the per-session chart, cache read is a median ~99% of every turn. On the
token axis the other three bands are literally sub-pixel. That is why the chart
has a **"Cost per turn"** mode: weighting each band by its own $/token lifts the
thin-but-expensive bands into view *on their own merits* (an output token is 50x
a cache-read token on Opus), so area is money.

Don't "fix" the token view by log-scaling or dropping cache read — the token
view's job is the sawtooth (how big context gets, and the compaction drop); the
cost view's job is where the money went. Keep both.

Note this differs from the Copilot-era chart it's modeled on, which summed
cumulatively — there, compaction was a slope change. Here the stack is per-call,
so the stack height is the live context window and compaction is a real drop.
That project also had to *infer* per-token-type rates via non-negative least
squares, because its telemetry gave only a total cost per call. We don't: the
four cost components are computed directly from published rates in
`pricing.js`, so the split is exact and there is no fitting step to maintain.

The cost axis clips at ~p98 (see `costCeiling`). A single large re-cache can be
30x the median call and would flatten everything else. Clipped calls are counted
in the legend and still report their true value in the tooltip — if you change
this, preserve that disclosure rather than silently dropping outliers.

## What is NOT in the transcripts

There are no cost, quota, credit, plan, or percent-used fields anywhere in the
session JSONL — only raw token counts. Subscription usage percentages come from
a server-side response and are never written to disk. `~/.claude/.credentials.json`
holds `subscriptionType` and `rateLimitTier`, but that is an OAuth credentials
file, not usage data, and this project does not read it.

Do not add an inferred "percent of your plan used" figure. It would look
authoritative and be a guess.

## Key gotcha 4: charts inside a collapsed `<details>` measure 0 width

Panels are `<details class="card panel">`. An SVG rendered while its panel is
collapsed measures `clientWidth === 0` and lays out wrong. Two guards keep this
correct, and both are load-bearing:

- `renderAll()` skips a chart whose panel is closed (`panelOpen(id)`).
- A `toggle` listener re-renders on expand — `renderSessionDetail` for
  `#detail-card`, `renderAll()` for the rest.

If you add a panel containing a chart, wire it into both. Symptom of getting it
wrong: a chart that is invisible or hairline-thin until the window is resized.

## Charts

`dashboard.html` follows a fixed palette with validated light and dark steps
(the two are separate selections, not an automatic inversion). Rules worth
preserving if you touch the charts:

- Series color follows the entity, never its rank — filtering must not repaint.
- A legend is present for every multi-series chart; direct labels are selective.
- Every chart has a table view, so no value is reachable only via tooltip.
- Stacked segments carry a 2px surface gap rather than a stroke.

## Running / testing

No test suite. Validate changes by:

```bash
node --check watcher.js && node --check pricing.js
node watcher.js --port 4791          # then open http://localhost:4791
curl -s localhost:4791/api/stats | jq '.totals'
```

Sanity checks that catch most regressions: `totals.cost` should be dominated by
`costCacheRead`; `daily[]` rows must carry the per-token-type cost split (the
stacked chart reads those keys, and their absence renders empty bars); and a
session with compactions should draw markers that land on visible drops in the
context line.

Because the watcher reads real local session history, output is not
reproducible across machines — don't assume specific totals in tests.
