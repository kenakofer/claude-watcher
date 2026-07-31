// Per-model token pricing, USD per million tokens.
//
// `input` / `output` are the published API rates. Cache rates are derived:
// reads are 0.1x input, cache writes are 1.25x input at the 5-minute TTL and
// 2x at the 1-hour TTL. Claude Code writes almost exclusively 1h-TTL cache
// entries, so the two are tracked separately rather than averaged.
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2.0;

const MODELS = {
  'claude-opus-5': { input: 5, output: 25, label: 'Opus 5' },
  'claude-opus-4-8': { input: 5, output: 25, label: 'Opus 4.8' },
  'claude-opus-4-7': { input: 5, output: 25, label: 'Opus 4.7' },
  'claude-opus-4-6': { input: 5, output: 25, label: 'Opus 4.6' },
  'claude-opus-4-5': { input: 5, output: 25, label: 'Opus 4.5' },
  'claude-fable-5': { input: 10, output: 50, label: 'Fable 5' },
  'claude-mythos-5': { input: 10, output: 50, label: 'Mythos 5' },
  // Sonnet 5 has introductory pricing of $2/$10 through 2026-08-31, after
  // which it returns to $3/$15. Priced per-call against the call's timestamp.
  'claude-sonnet-5': {
    input: 3,
    output: 15,
    label: 'Sonnet 5',
    intro: { until: '2026-08-31T23:59:59Z', input: 2, output: 10 },
  },
  'claude-sonnet-4-6': { input: 3, output: 15, label: 'Sonnet 4.6' },
  'claude-sonnet-4-5': { input: 3, output: 15, label: 'Sonnet 4.5' },
  'claude-haiku-4-5': { input: 1, output: 5, label: 'Haiku 4.5' },
};

// Fast mode is a premium tier on Opus 5 / Opus 4.8 ($10/$50 per MTok).
const FAST_MODE = { input: 10, output: 50 };

function normalizeModel(model) {
  if (!model) return null;
  // Strip a trailing date snapshot (e.g. claude-haiku-4-5-20251001).
  return String(model).replace(/-\d{8}$/, '');
}

function ratesFor(model, timestamp, speed) {
  const id = normalizeModel(model);
  const spec = MODELS[id];
  if (!spec) return null;

  let { input, output } = spec;

  if (spec.intro && timestamp && new Date(timestamp) <= new Date(spec.intro.until)) {
    input = spec.intro.input;
    output = spec.intro.output;
  }

  if (speed === 'fast' && (id === 'claude-opus-5' || id === 'claude-opus-4-8')) {
    input = FAST_MODE.input;
    output = FAST_MODE.output;
  }

  return { input, output, label: spec.label };
}

/**
 * Cost breakdown for a single assistant message's usage block.
 * Returns per-token-type dollar amounts so the dashboard can show where the
 * money actually goes (which, for Claude Code, is overwhelmingly cache writes
 * and cache reads rather than uncached input).
 */
function costOf(usage, model, timestamp, speed) {
  const rates = ratesFor(model, timestamp, speed);
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, priced: false };
  if (!rates || !usage) return zero;

  const per = (tokens, rate) => ((tokens || 0) / 1e6) * rate;

  const creation = usage.cache_creation || {};
  // Fall back to the flat cache_creation_input_tokens when the TTL split is
  // absent, assuming the 1h rate (what Claude Code actually writes).
  const has1h = creation.ephemeral_1h_input_tokens != null;
  const has5m = creation.ephemeral_5m_input_tokens != null;
  const write1h = has1h || has5m
    ? creation.ephemeral_1h_input_tokens || 0
    : usage.cache_creation_input_tokens || 0;
  const write5m = creation.ephemeral_5m_input_tokens || 0;

  const input = per(usage.input_tokens, rates.input);
  const output = per(usage.output_tokens, rates.output);
  const cacheRead = per(usage.cache_read_input_tokens, rates.input * CACHE_READ_MULTIPLIER);
  const cacheWrite =
    per(write1h, rates.input * CACHE_WRITE_1H_MULTIPLIER) +
    per(write5m, rates.input * CACHE_WRITE_5M_MULTIPLIER);

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
    priced: true,
  };
}

function labelFor(model) {
  const spec = MODELS[normalizeModel(model)];
  return spec ? spec.label : model || 'unknown';
}

export { costOf, ratesFor, labelFor, normalizeModel, MODELS };
