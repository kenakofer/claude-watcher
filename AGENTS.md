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

The TTL split is also surfaced per session: `splitCacheCreation` in
`watcher.js` mirrors the `costOf` fallback (a flat `cache_creation_input_tokens`
with no ephemeral fields is attributed to 1h, because that is how it is billed),
and `cacheTtl` in `dashboard.html` turns the session totals into a **Cache TTL**
column. Keep those two fallbacks in lockstep — if they diverge, a session shows
"no cache writes by TTL" while still being charged for them.

`FORCE_PROMPT_CACHING_5M=1` forces the short TTL for a whole session. That
setting is never written to the transcript, so the billing split is the only
evidence of it. The column reports a *share*, not a verdict: a resumed session
legitimately carries both TTLs (pre-resume calls keep what they were written
under), so `mixed` is a real state rather than an error — in practice a
sizeable minority of sessions land there. The 1h/5m thresholds are 99%/1%
rather than exact equality so a few stray tokens don't demote a clean session.

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

There is a third mode, **Usage per turn**, whose job is quota. It is read as
*area*, with a grid square equal to 1% of a 5-hour window. Three things make it
different from the other two, and all are load-bearing:

- **It plots output plus cache write, never cache read.** One point is ~3,500
  output tokens *or* ~29,000 cache-write tokens (about 1/8 of an output token
  each). Cache read is the dominant quantity in every other view here and is not
  metered at all — in a three-term fit it lands at 1 point per ~34M tokens and
  improves MAPE by 0.03pp.
- **Compactions contribute zero,** and are drawn as dashed markers rather than
  bars. The summary is written into a fresh cache, which appears as a large
  `cacheCreationTokens` on the *next ordinary call* — verified across 60
  compactions, where the following call's cache write covers `postTokens` 85% of
  the time. Charging the boundary as well double-counts: calls alone predict
  68.6% against an actual 68%, and adding `postTokens` gives 69.0%. If you make
  compactions carry quota again, check that number first.
- **It never clips.** Cost mode clips at ~p98 and that is fine there, because a
  clipped bar still reads as "off the top" on a rate axis. Here area *is* the
  quantity, so clipping would destroy it.

The unit is **measured on Opus 5 only** (`QUOTA_CALIBRATION_MODEL`). Sessions
that ran mostly on another model get an explicit warning in the grid note rather
than silently borrowing the figure. Whether the constant is per-model is an open
question the data cannot settle: if the meter counts raw output tokens it is
universal, and if it counts cost in output-equivalents a cheaper model should
consume more slowly. Resolve it by fitting a window of substantial Sonnet
traffic the same way — landing near 3,500 means raw tokens, ~5× higher means
cost.

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

Do not add an inferred "percent of your plan used" figure **from token counts
alone**. It would look authoritative and be a guess.

The one sanctioned exception is the **Usage per turn** mode, whose unit
(`QUOTA_OUTPUT_TOKENS_PER_PERCENT` ≈ 3,500 output tokens per point, plus a
cache-write term) is measured
rather than assumed — see the comment on that constant for the holdout tests. It
is still an estimate of a *session's* contribution, not an account-wide reading:
the meter is account-wide and counts sessions outside the watched directory, so
the figure is a floor.

**The meter tracks output tokens and cache writes**, at roughly 1 point per
3,500 output or 29,000 cache-write tokens. Established on a clean window (one
session, true 0% start, complete transcripts) by holdout: fitting on 1–36% and
predicting 37–66% gives 0.99% MAPE for the two-term model against 2.58% for
output-only, and the cache-write coefficient's bootstrap 95% CI is
[3.11e-5, 3.87e-5] with P(<0)=0.0000. End to end it predicts the window's
reading to 0.9%.

The cache-write term was missed at first because ordinary turns write ~1k cache
tokens against ~500 output, making it a rounding error. A **cache miss** exposed
it: 172k cache-write tokens in one call moved the meter 58%→66% where
output-only predicted ~1 point. If you are trying to identify a weak term, look
for the event that breaks the usual ratio between regressors — ordinary traffic
never will.

Two total-token models were tried and **rejected**. Both failed the same way, so
the failure mode is worth naming: cache read is 94–99.5% of every turn and
scales with output *within* a window, so a total-token unit validates locally
and then disagrees with itself by ~90% across windows with different context
sizes. An earlier per-token-type price weighting failed differently — it was fit
on per-session meter deltas while the meter is account-wide, inflating the
implied cost ~14x. Do not re-derive this unit from total tokens, and do not fit
it on single-session deltas; calibrate only over whole windows with a known
`resets_at` and a true 0% start.

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

`/api/sessions/<id>` returns `{ session, events }` — the compaction list is at
`session.compactions`, not at the top level. Reading it from the wrong level
yields an empty array rather than an error, which silently makes every
compaction-dependent behaviour look like a no-op. If a check involving
compactions reports zero across every session, suspect the harness before the
feature: `/api/stats` `.totals.compactions` is the independent cross-check.

Cache-expiry markers are derived from wall-clock gaps between consecutive
calls, not reported by the transcript, and are suppressed where a compaction
lands on the same call — compaction forces a cache write regardless, so the
lapse costs nothing extra there. Both TTL thresholds are drawn for every
session regardless of which TTL it ran under, because the value is
counterfactual in both directions.

Because the watcher reads real local session history, output is not
reproducible across machines — don't assume specific totals in tests.
