'use strict';

// The before & after shots start once the preview is up, beside the checks,
// instead of after the whole suite (the first production run of the shots
// agent waited ~3m45s for checks it never reads). Only when nothing holds
// the session: a run first waits at most two minutes for the proposal's
// agent to be free, and a turn that launched the capture is still wrapping up.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const visuals = require('../src/services/visuals');
const orchestrator = require('../src/services/shots-orchestrator');
const worker = require('../src/services/worker');

const HEAD = 'b'.repeat(40);
const config = { shots: { execute: true } };

function stubs(t, { activeTurn = null, inFlight = false } = {}) {
  const scheduled = [];
  const queries = [];
  const saved = { schedule: orchestrator.scheduleForSession, inFlight: worker.isInFlight };
  orchestrator.scheduleForSession = async (_config, options) => {
    scheduled.push({ sessionId: options.sessionId, headSha: options.headSha, trigger: options.trigger });
    return { scheduled: true };
  };
  worker.isInFlight = () => inFlight;
  t.after(() => {
    orchestrator.scheduleForSession = saved.schedule;
    worker.isInFlight = saved.inFlight;
  });
  const pool = { query: async (sql, params) => {
    queries.push({ sql: String(sql), params });
    return { rows: [{ active_turn: activeTurn }] };
  } };
  return { pool, scheduled, queries };
}

// scheduleShots hands the orchestrator call to a detached microtask.
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('an idle session starts its shots as soon as the preview is up', async (t) => {
  const { pool, scheduled } = stubs(t);
  await visuals.startShotsIfIdle(config, pool, 42, HEAD);
  await settle();
  assert.deepEqual(scheduled, [{ sessionId: 42, headSha: HEAD, trigger: 'preview-ready' }]);
});

test('a session with a turn open, or a busy worker, keeps the start after its checks', async (t) => {
  const turn = stubs(t, { activeTurn: { turnId: 't1', mode: 'build' } });
  await visuals.startShotsIfIdle(config, turn.pool, 42, HEAD);
  await settle();
  assert.deepEqual(turn.scheduled, []);

  const busy = stubs(t, { inFlight: true });
  await visuals.startShotsIfIdle(config, busy.pool, 42, HEAD);
  await settle();
  assert.deepEqual(busy.scheduled, []);

  const unknown = stubs(t);
  await visuals.startShotsIfIdle(config, unknown.pool, 42, null);
  assert.deepEqual(unknown.queries, [], 'no commit, nothing to look up');
});

test('the checks run starts the shots right after it claims the preview, and still hands off after', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/services/visuals.js'), 'utf8');
  const body = source.slice(source.indexOf('async function captureForSession('));
  const claim = body.indexOf('_inFlight.set(key, { operation, commitHash: commitHash || null });');
  const early = body.indexOf('startShotsIfIdle(config, pool, session.id, commitHash);');
  const decided = body.indexOf('checksAlreadyDecided(pool, session.id, commitHash)');
  assert.ok(claim > 0 && early > claim && early < decided,
    'after the run claims its slot, before any early return');
  assert.match(body, /scheduleShots\(config, pool, session\.id, commitHash\);\n  \}\n\}/,
    'the hand-off after the checks stays as the fallback');
});

test('an interrupted run is looked for every 30 seconds, apart from the two-minute sweep', () => {
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.match(server, /setInterval\(retryInterruptedShots, 30 \* 1000\)/);
  const unstarted = server.slice(server.indexOf('const runUnstartedShots = '), server.indexOf('setInterval(runUnstartedShots'));
  assert.doesNotMatch(unstarted, /retryInterrupted/, 'the retry no longer waits for the slower sweep');
});
