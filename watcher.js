#!/usr/bin/env node
//
// claude-watcher
//
// Tails Claude Code's per-session JSONL transcripts under ~/.claude/projects,
// normalizes them into a flat event stream (prompt, chat_completion,
// tool_call, compaction, turn_duration), and serves it over HTTP + SSE.
//
// Unlike the Copilot equivalent, no OTel export or env-var setup is needed:
// Claude Code writes token usage directly into the transcript as it goes.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { costOf, labelFor, normalizeModel } from './pricing.js';

const DEFAULTS = {
  projects: path.join(os.homedir(), '.claude', 'projects'),
  port: 4791,
  pollMs: 1000,
  // Loopback, not every interface. The API serves prompt text, session titles,
  // working directories and branch names with no authentication, so binding to
  // 0.0.0.0 — which is what listen(port) does when no host is given — publishes
  // the contents of every transcript to whatever network the machine is on.
  // Opt in with --host if you actually want that; it is never the safe default.
  host: '127.0.0.1',
};

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--projects') opts.projects = path.resolve(next());
    else if (arg === '--port') opts.port = Number(next());
    else if (arg === '--host') opts.host = next();
    else if (arg === '--poll') opts.pollMs = Number(next());
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

const HELP = `claude-watcher

  node watcher.js [--projects <dir>] [--port <n>] [--host <addr>] [--poll <ms>]

  --projects  Claude Code transcript root (default ~/.claude/projects)
  --port      HTTP/SSE port (default ${DEFAULTS.port})
  --host      bind address (default ${DEFAULTS.host}). The API is unauthenticated
              and serves prompt text, so only widen this on a network you trust.
  --poll      filesystem poll interval in ms (default ${DEFAULTS.pollMs})

Endpoints:
  GET /api/sessions      one summary object per session
  GET /api/sessions/:id  full normalized event timeline for one session
  GET /api/events        every normalized event across all sessions
  GET /api/stats         cross-session totals, daily spend, model breakdown
  GET /stream            Server-Sent Events; pushes new events as they land
  GET /                  the dashboard
`;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** sessionId -> session summary */
const sessions = new Map();
/** absolute file path -> { offset, partial, sessionId } */
const files = new Map();
/** every normalized event, in ingest order */
const events = [];
/** live SSE clients */
const clients = new Set();

const MAX_EVENTS = 200_000;

function decodeProjectDir(dirName) {
  // Claude Code encodes the cwd by replacing separators with '-'. That's
  // lossy (a real '-' in a path segment is indistinguishable), so this is a
  // display-only best effort; the authoritative cwd comes from the entries.
  return dirName.replace(/^-/, '/').replace(/-/g, '/');
}

function emptySession(sessionId, meta = {}) {
  return {
    sessionId,
    cwd: meta.cwd || null,
    project: meta.project || null,
    gitBranch: meta.gitBranch || null,
    version: meta.version || null,
    title: null,
    slug: null,
    firstTimestamp: null,
    lastTimestamp: null,
    isSidechain: Boolean(meta.isSidechain),
    agentType: meta.agentType || null,
    agentId: meta.agentId || null,
    parentSessionId: meta.parentSessionId || null,
    models: {},
    tools: {},
    totals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      // Cache writes split by TTL. Billed at different rates (1.25x input for
      // 5m, 2x for 1h), and the mix is a property of how the session was
      // launched — FORCE_PROMPT_CACHING_5M forces the short TTL throughout.
      cacheCreation1h: 0,
      cacheCreation5m: 0,
      calls: 0,
      prompts: 0,
      toolCalls: 0,
      cost: 0,
      costInput: 0,
      costOutput: 0,
      costCacheRead: 0,
      costCacheWrite: 0,
      durationMs: 0,
    },
    compactions: [],
    contextWindow: null,
    eventCount: 0,
  };
}

function getSession(sessionId, meta) {
  let session = sessions.get(sessionId);
  if (!session) {
    session = emptySession(sessionId, meta);
    sessions.set(sessionId, session);
  } else if (meta) {
    // Backfill metadata we may not have had on the first sighting.
    for (const key of ['cwd', 'project', 'gitBranch', 'version', 'agentType', 'parentSessionId']) {
      if (session[key] == null && meta[key] != null) session[key] = meta[key];
    }
  }
  return session;
}

function touchTimestamps(session, timestamp) {
  if (!timestamp) return;
  if (!session.firstTimestamp || timestamp < session.firstTimestamp) {
    session.firstTimestamp = timestamp;
  }
  if (!session.lastTimestamp || timestamp > session.lastTimestamp) {
    session.lastTimestamp = timestamp;
  }
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Split a usage block's cache-creation tokens by TTL.
 *
 * Kept in lockstep with the fallback in `costOf`: when neither ephemeral field
 * is present the flat `cache_creation_input_tokens` is billed at the 1h rate,
 * so it is attributed to 1h here as well. Otherwise the classification and the
 * cost would disagree — a session would show as "no cache writes by TTL" while
 * still being charged for them.
 */
function splitCacheCreation(usage) {
  const creation = usage.cache_creation || {};
  const has1h = creation.ephemeral_1h_input_tokens != null;
  const has5m = creation.ephemeral_5m_input_tokens != null;
  return {
    cacheCreation1h: has1h || has5m
      ? creation.ephemeral_1h_input_tokens || 0
      : usage.cache_creation_input_tokens || 0,
    cacheCreation5m: creation.ephemeral_5m_input_tokens || 0,
  };
}

/**
 * Convert one raw transcript entry into zero or more normalized events.
 * Returns [] for entry types that carry no analytical signal (mode changes,
 * file-history snapshots, queue operations, and so on).
 */
function normalize(entry, context) {
  const sessionId = entry.sessionId || entry.session_id || context.sessionId;
  if (!sessionId) return [];

  const base = {
    sessionId,
    timestamp: entry.timestamp || null,
    uuid: entry.uuid || null,
    cwd: entry.cwd || context.cwd || null,
    gitBranch: entry.gitBranch || null,
    version: entry.version || null,
    isSidechain: Boolean(entry.isSidechain || context.isSidechain),
    agentId: entry.agentId || context.agentId || null,
  };

  switch (entry.type) {
    case 'user': {
      // A user entry is either a real prompt or a tool result being fed back.
      const content = entry.message?.content;
      if (Array.isArray(content) && content.some((b) => b && b.type === 'tool_result')) {
        return [];
      }
      if (entry.isMeta) return [];
      const text = textFromContent(content);
      if (!text.trim()) return [];
      return [{ ...base, kind: 'prompt', text, promptId: entry.promptId || null }];
    }

    case 'assistant': {
      const message = entry.message || {};
      const usage = message.usage || {};
      const out = [];

      // Claude Code writes one transcript row per content block, not per API
      // call: a turn that emits text plus two tool_use blocks lands as three
      // assistant entries sharing a message.id, a requestId, and a verbatim
      // copy of the same usage object. Counting each row as a call would
      // multiply both tokens and cost by the block count (~1.8x in practice),
      // so only the first row of a message becomes a chat_completion. The
      // tool_call loop below still runs for every row — those blocks are
      // genuinely one per row, and each is a distinct tool invocation.
      //
      // Keyed on message.id, falling back to requestId. When a row carries
      // neither there is nothing to correlate siblings by, so it is counted:
      // over-counting an unidentifiable call is better than dropping a real
      // one, and such rows have no siblings to collapse anyway.
      const dedupeKey = message.id || entry.requestId || null;
      const seen = context.seenMessages;
      const duplicate = Boolean(dedupeKey && seen && seen.has(dedupeKey));
      if (dedupeKey && seen) seen.add(dedupeKey);

      // Synthetic messages are local placeholders (e.g. interrupts), not
      // billable model calls.
      const model = message.model;
      if (model && model !== '<synthetic>' && !duplicate) {
        out.push({
          ...base,
          kind: 'chat_completion',
          model,
          modelLabel: labelFor(model),
          effort: entry.effort || null,
          speed: usage.speed || null,
          serviceTier: usage.service_tier || null,
          requestId: entry.requestId || null,
          messageId: message.id || null,
          stopReason: message.stop_reason || null,
          usage: {
            inputTokens: usage.input_tokens || 0,
            outputTokens: usage.output_tokens || 0,
            cacheReadTokens: usage.cache_read_input_tokens || 0,
            cacheCreationTokens: usage.cache_creation_input_tokens || 0,
            // Mirror the fallback in `costOf`: when the TTL split is absent
            // entirely, the flat count is billed as 1h, so attribute it to 1h
            // here too rather than reporting 0/0 and losing the tokens.
            ...splitCacheCreation(usage),
          },
          cost: costOf(usage, model, entry.timestamp, usage.speed),
        });
      }

      for (const block of message.content || []) {
        if (block && block.type === 'tool_use') {
          out.push({
            ...base,
            kind: 'tool_call',
            tool: block.name,
            toolUseId: block.id || null,
            model: model || null,
          });
        }
      }
      return out;
    }

    case 'system': {
      if (entry.subtype === 'compact_boundary') {
        const meta = entry.compactMetadata || {};
        return [
          {
            ...base,
            kind: 'compaction',
            trigger: meta.trigger || null,
            preTokens: meta.preTokens ?? null,
            postTokens: meta.postTokens ?? null,
            droppedTokens: meta.cumulativeDroppedTokens ?? null,
            durationMs: meta.durationMs ?? null,
          },
        ];
      }
      if (entry.subtype === 'turn_duration') {
        return [
          {
            ...base,
            kind: 'turn_duration',
            durationMs: entry.durationMs || 0,
            messageCount: entry.messageCount || 0,
          },
        ];
      }
      return [];
    }

    // Title/slug entries carry no timestamp but name the session.
    case 'ai-title':
      return [{ sessionId, kind: 'title', title: entry.aiTitle || null }];
    case 'custom-title':
      return [{ sessionId, kind: 'title', title: entry.customTitle || entry.title || null }];

    default:
      return [];
  }
}

/** Fold a normalized event into its session summary. */
function applyToSession(event) {
  const session = getSession(event.sessionId, {
    cwd: event.cwd,
    gitBranch: event.gitBranch,
    version: event.version,
    isSidechain: event.isSidechain,
    agentId: event.agentId,
  });
  touchTimestamps(session, event.timestamp);
  session.eventCount += 1;

  switch (event.kind) {
    case 'title':
      if (event.title) session.title = event.title;
      break;

    case 'prompt':
      session.totals.prompts += 1;
      break;

    case 'chat_completion': {
      const t = session.totals;
      const u = event.usage;
      t.calls += 1;
      t.inputTokens += u.inputTokens;
      t.outputTokens += u.outputTokens;
      t.cacheReadTokens += u.cacheReadTokens;
      t.cacheCreationTokens += u.cacheCreationTokens;
      t.cacheCreation1h += u.cacheCreation1h;
      t.cacheCreation5m += u.cacheCreation5m;
      t.cost += event.cost.total;
      t.costInput += event.cost.input;
      t.costOutput += event.cost.output;
      t.costCacheRead += event.cost.cacheRead;
      t.costCacheWrite += event.cost.cacheWrite;

      const key = normalizeModel(event.model);
      const m = (session.models[key] ||= {
        label: event.modelLabel,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        cost: 0,
      });
      m.calls += 1;
      m.inputTokens += u.inputTokens;
      m.outputTokens += u.outputTokens;
      m.cacheReadTokens += u.cacheReadTokens;
      m.cacheCreationTokens += u.cacheCreationTokens;
      m.cost += event.cost.total;

      // The context window is the whole prompt the model just saw: uncached
      // input + cache reads + cache writes. This is the live "how full is the
      // window" signal, and compaction shows up as a sharp drop.
      session.contextWindow = u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens;
      break;
    }

    case 'tool_call':
      session.totals.toolCalls += 1;
      session.tools[event.tool] = (session.tools[event.tool] || 0) + 1;
      break;

    case 'compaction':
      session.compactions.push({
        timestamp: event.timestamp,
        trigger: event.trigger,
        preTokens: event.preTokens,
        postTokens: event.postTokens,
        droppedTokens: event.droppedTokens,
      });
      break;

    case 'turn_duration':
      session.totals.durationMs += event.durationMs;
      break;

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Tailing
// ---------------------------------------------------------------------------

function broadcast(batch) {
  if (!batch.length || !clients.size) return;
  const payload = `data: ${JSON.stringify(batch)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

function ingest(rawLines, context) {
  const produced = [];
  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue; // partial or corrupt line; skip it
    }
    for (const event of normalize(entry, context)) {
      applyToSession(event);
      events.push(event);
      produced.push(event);
    }
  }
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  return produced;
}

/**
 * Read whatever is new in a transcript file since we last looked.
 * Handles the append-only case (the norm) and truncation/rotation (rare).
 */
async function readNew(filePath, state) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return [];
  }
  if (stat.size === state.offset) return [];
  if (stat.size < state.offset) {
    // File shrank — treat as a fresh file rather than reading garbage. The
    // seen-message set is part of that reset: its ids describe content that is
    // no longer in the file, and keeping them would suppress calls in the
    // replacement transcript that happened to reuse an id.
    state.offset = 0;
    state.partial = '';
    state.context.seenMessages?.clear();
  }

  const handle = await fsp.open(filePath, 'r');
  try {
    const length = stat.size - state.offset;
    const buffer = Buffer.allocUnsafe(length);
    await handle.read(buffer, 0, length, state.offset);
    state.offset = stat.size;

    const chunk = state.partial + buffer.toString('utf8');
    const lines = chunk.split('\n');
    // The last element is either '' (clean newline boundary) or a partial
    // line still being written; hold it until the rest arrives.
    state.partial = lines.pop() ?? '';
    return lines;
  } finally {
    await handle.close();
  }
}

async function walkTranscripts(root) {
  const found = [];
  let projectDirs;
  try {
    projectDirs = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) continue;
    const project = decodeProjectDir(projectDir.name);
    const projectPath = path.join(root, projectDir.name);

    let entries;
    try {
      entries = await fsp.readdir(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        found.push({ file: path.join(projectPath, entry.name), project, isSidechain: false });
        continue;
      }
      if (!entry.isDirectory() || entry.name === 'memory') continue;

      // A per-session subdirectory: subagent transcripts live under
      // <session-id>/subagents/agent-*.jsonl and share the parent's project.
      const subagentDir = path.join(projectPath, entry.name, 'subagents');
      let subFiles;
      try {
        subFiles = await fsp.readdir(subagentDir);
      } catch {
        continue;
      }
      for (const name of subFiles) {
        if (!name.endsWith('.jsonl')) continue;
        found.push({
          file: path.join(subagentDir, name),
          project,
          isSidechain: true,
          parentSessionId: entry.name,
        });
      }
    }
  }
  return found;
}

/** Subagent transcripts carry no sessionId; derive one from the filename. */
async function contextForFile(descriptor) {
  const context = {
    cwd: null,
    project: descriptor.project,
    isSidechain: descriptor.isSidechain,
    parentSessionId: descriptor.parentSessionId || null,
    // Message ids already counted as calls in this file. It lives on the
    // per-file context (which outlives a single poll) rather than inside
    // ingest(), because a message's sibling rows are frequently split across
    // reads — the tail catches the text block on one pass and its tool_use
    // rows on the next.
    seenMessages: new Set(),
  };
  if (!descriptor.isSidechain) return context;

  const base = path.basename(descriptor.file, '.jsonl');
  context.sessionId = `${descriptor.parentSessionId}/${base}`;
  context.agentId = base.replace(/^agent-/, '');

  try {
    const meta = JSON.parse(
      await fsp.readFile(descriptor.file.replace(/\.jsonl$/, '.meta.json'), 'utf8'),
    );
    context.agentType = meta.agentType || null;
    context.description = meta.description || null;
  } catch {
    // Meta file is optional.
  }
  return context;
}

async function scan(root) {
  const descriptors = await walkTranscripts(root);
  const batch = [];

  for (const descriptor of descriptors) {
    let state = files.get(descriptor.file);
    if (!state) {
      state = { offset: 0, partial: '', context: await contextForFile(descriptor) };
      files.set(descriptor.file, state);
    }
    const lines = await readNew(descriptor.file, state);
    if (!lines.length) continue;

    const produced = ingest(lines, state.context);

    // Stamp session-level metadata the entries themselves don't carry.
    for (const event of produced) {
      const session = sessions.get(event.sessionId);
      if (!session) continue;
      if (!session.project) session.project = state.context.project;
      if (state.context.isSidechain) {
        session.isSidechain = true;
        session.agentType ||= state.context.agentType;
        session.agentId ||= state.context.agentId;
        session.parentSessionId ||= state.context.parentSessionId;
        session.title ||= state.context.description;
      }
    }
    batch.push(...produced);
  }

  broadcast(batch);
  return batch.length;
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

function sessionList() {
  return [...sessions.values()].sort((a, b) =>
    String(b.lastTimestamp || '').localeCompare(String(a.lastTimestamp || '')),
  );
}

function stats() {
  const byDay = new Map();
  const byModel = new Map();
  const byTool = new Map();
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cacheCreation1h: 0,
    cacheCreation5m: 0,
    cost: 0,
    costInput: 0,
    costOutput: 0,
    costCacheRead: 0,
    costCacheWrite: 0,
    calls: 0,
    prompts: 0,
    toolCalls: 0,
    sessions: sessions.size,
    compactions: 0,
  };

  for (const event of events) {
    if (event.kind === 'prompt') totals.prompts += 1;
    if (event.kind === 'compaction') totals.compactions += 1;
    if (event.kind === 'tool_call') {
      totals.toolCalls += 1;
      byTool.set(event.tool, (byTool.get(event.tool) || 0) + 1);
    }
    if (event.kind !== 'chat_completion') continue;

    const u = event.usage;
    totals.calls += 1;
    totals.inputTokens += u.inputTokens;
    totals.outputTokens += u.outputTokens;
    totals.cacheReadTokens += u.cacheReadTokens;
    totals.cacheCreationTokens += u.cacheCreationTokens;
    totals.cacheCreation1h += u.cacheCreation1h;
    totals.cacheCreation5m += u.cacheCreation5m;
    totals.cost += event.cost.total;
    totals.costInput += event.cost.input;
    totals.costOutput += event.cost.output;
    totals.costCacheRead += event.cost.cacheRead;
    totals.costCacheWrite += event.cost.cacheWrite;

    const day = (event.timestamp || '').slice(0, 10);
    if (day) {
      const bucket = byDay.get(day) || {
        day,
        cost: 0,
        calls: 0,
        outputTokens: 0,
        // Per-token-type split, so the dashboard can stack a day's spend by
        // where it actually went rather than showing a single opaque total.
        costInput: 0,
        costOutput: 0,
        costCacheRead: 0,
        costCacheWrite: 0,
      };
      bucket.cost += event.cost.total;
      bucket.calls += 1;
      bucket.outputTokens += u.outputTokens;
      bucket.costInput += event.cost.input;
      bucket.costOutput += event.cost.output;
      bucket.costCacheRead += event.cost.cacheRead;
      bucket.costCacheWrite += event.cost.cacheWrite;
      byDay.set(day, bucket);
    }

    const key = normalizeModel(event.model);
    const model = byModel.get(key) || {
      model: key,
      label: event.modelLabel,
      calls: 0,
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    model.calls += 1;
    model.cost += event.cost.total;
    model.inputTokens += u.inputTokens;
    model.outputTokens += u.outputTokens;
    model.cacheReadTokens += u.cacheReadTokens;
    model.cacheCreationTokens += u.cacheCreationTokens;
    byModel.set(key, model);
  }

  return {
    totals,
    daily: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    models: [...byModel.values()].sort((a, b) => b.cost - a.cost),
    tools: [...byTool.entries()]
      .map(([tool, count]) => ({ tool, count }))
      .sort((a, b) => b.count - a.count),
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function sendJson(res, body, status = 200) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(payload);
}

function createServer(opts) {
  const dashboardPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'dashboard.html');

  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname;

    if (route === '/' || route === '/index.html') {
      fs.readFile(dashboardPath, (err, data) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('dashboard.html not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      });
      return;
    }

    if (route === '/api/sessions') return sendJson(res, sessionList());

    if (route.startsWith('/api/sessions/')) {
      const id = decodeURIComponent(route.slice('/api/sessions/'.length));
      const session = sessions.get(id);
      if (!session) return sendJson(res, { error: 'no such session' }, 404);
      return sendJson(res, {
        session,
        events: events.filter((e) => e.sessionId === id),
      });
    }

    if (route === '/api/events') {
      const limit = Number(url.searchParams.get('limit')) || 0;
      return sendJson(res, limit > 0 ? events.slice(-limit) : events);
    }

    if (route === '/api/stats') return sendJson(res, stats());

    if (route === '/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(': connected\n\n');
      clients.add(res);
      const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => {
        clearInterval(keepAlive);
        clients.delete(res);
      });
      return;
    }

    sendJson(res, { error: 'not found' }, 404);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv);
  } catch (err) {
    console.error(err.message);
    console.error(HELP);
    process.exit(1);
  }
  if (opts.help) {
    console.log(HELP);
    return;
  }

  if (!fs.existsSync(opts.projects)) {
    console.error(`transcript root not found: ${opts.projects}`);
    process.exit(1);
  }

  const started = Date.now();
  const initial = await scan(opts.projects);
  console.log(
    `[watcher] loaded ${initial} events from ${sessions.size} sessions ` +
      `in ${Date.now() - started}ms`,
  );

  const server = createServer(opts);
  server.listen(opts.port, opts.host, () => {
    // Reports the address actually bound, not a hardcoded "localhost". The old
    // line said localhost while listening on every interface, which is the one
    // combination that hides the thing worth knowing.
    const shown = opts.host === '0.0.0.0' || opts.host === '::' ? opts.host : 'localhost';
    console.log(`[watcher] dashboard  http://${shown}:${opts.port}`);
    console.log(`[watcher] watching   ${opts.projects}`);
    if (shown !== 'localhost') {
      console.log(
        '[watcher] WARNING   bound to all interfaces; the API is unauthenticated '
          + 'and serves prompt text',
      );
    }
  });

  let scanning = false;
  setInterval(async () => {
    if (scanning) return; // never overlap scans
    scanning = true;
    try {
      await scan(opts.projects);
    } catch (err) {
      console.error('[watcher] scan failed:', err.message);
    } finally {
      scanning = false;
    }
  }, opts.pollMs);
}

main();
