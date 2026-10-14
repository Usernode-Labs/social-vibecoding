'use strict';

// The workflow side of tests/bot-build-crash-postgres.test.js
// (tests/lib/bot-build-crash.js): the real workflow runtime with the
// bot-build machine and the bot's real pipeline, its outside services faked
// by the fixture. It loads everything, says `loaded`, and waits for
// `start({ killAt })`; then it runs the runtime's loops (pipeline slots,
// services) until it is stopped, or until it reaches `killAt`, where it
// SIGKILLs itself. `arm({ killAt })` gives a process that is already
// running the next build's kill point.
//
// Kill points it counts itself:
//   save:<n>:before / save:<n>:after   the build's n-th durable save (a write
//                                      of its work item's checkpoint), in
//                                      this process
// and the fixture's: exec:<step>, dispatched:<step>, promote:pr,
// comment:<n>:before, comment:<n>:after.

const { AsyncLocalStorage } = require('node:async_hooks');
const path = require('node:path');
const { Pool } = require('pg');

const spec = JSON.parse(process.env.BOT_BUILD_CRASH_CHILD);
const SRC = path.join(__dirname, '..', '..', 'src');
const pool = new Pool({ connectionString: spec.databaseUrl, max: 3 });
pool.on('error', () => {});
const als = new AsyncLocalStorage();
let killAt = null;
// 'kill' (SIGKILL: a crash) or 'stop' (a clean stop, as a release's SIGTERM
// gives one: the runtime stops, the build unwinds, its lease is given up).
let killMode = 'kill';
let stopping = null;
// Counters a new build starts from (its saves, the fixture's posts).
const resets = [];

const world = {
  pool,
  pid: process.pid,
  als,
  get killAt() { return killAt; },
  // Replace a module before anything loads it.
  stub(modulePath, exports) {
    const id = require.resolve(modulePath);
    require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
  },
  build() { return als.getStore()?.key || null; },
  async record(kind, data = {}, appId = null) {
    await pool.query(
      'INSERT INTO crash_world_effects (app_id, build, kind, data, pid) VALUES ($1, $2, $3, $4, $5)',
      [appId ?? data.appId ?? null, world.build(), kind, JSON.stringify(data), process.pid]);
  },
  // Die here, as a crash does: nothing flushed, nothing given up. Or, in
  // 'stop' mode, stop here: the stop begins and the build goes on until it
  // notices.
  async kill(point, extra = {}) {
    if (!killAt || killAt !== point) return;
    if (killMode === 'stop') {
      killAt = null;
      await world.record('stopping', { point, ...extra }).catch(() => {});
      stopping ||= new Promise((resolve) => setImmediate(resolve)).then(stopAndExit);
      return;
    }
    await pool.query('UPDATE crash_world_platform SET up = FALSE').catch(() => {});
    await world.record('killed', { point, ...extra }).catch(() => {});
    process.kill(process.pid, 'SIGKILL');
    await new Promise(() => {});
  },
  appPool() { return require(path.join(SRC, 'db/pool')).getPool(); },
  onReset(fn) { resets.push(fn); },
};

// The outside network is refused (as tests/lib/workflow-child.js does): a
// connection that would leave the machine is recorded, so a run shows what
// it reached unfaked. Loopback and the database's own sockets are left alone.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const refused = (where) => {
  world.record('net.refused', { url: where }).catch(() => {});
  return Object.assign(new Error(`outside network refused in the workflow test process: ${where}`), { code: 'ECONNREFUSED' });
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (LOOPBACK.has(url.hostname)) return realFetch(input, init);
  throw refused(`${url.origin}${url.pathname}`);
};
for (const mod of [require('node:http'), require('node:https')]) {
  for (const fn of ['request', 'get']) {
    const real = mod[fn];
    mod[fn] = function guarded(target, ...rest) {
      const host = typeof target === 'string' || target instanceof URL ? new URL(String(target)).hostname : (target?.hostname || target?.host || 'localhost');
      if (!LOOPBACK.has(String(host).replace(/:\d+$/, ''))) throw refused(`${fn} ${host}`);
      return real.call(this, target, ...rest);
    };
  }
}
const net = require('node:net');
for (const fn of ['connect', 'createConnection']) {
  const real = net[fn];
  net[fn] = function guarded(...args) {
    const o = typeof args[0] === 'object' && args[0] ? args[0] : { port: args[0], host: typeof args[1] === 'string' ? args[1] : 'localhost' };
    if (!o.path && !LOOPBACK.has(String(o.host || 'localhost'))) throw refused(`net ${o.host}:${o.port}`);
    return real.apply(this, args);
  };
}

require(spec.fixture)(world);

// The build's handler, real, with its checkpoint counted (and, armed, the
// process killed right before or right after a save), and the handler's
// runs recorded so the test can check no two ever overlapped.
const realRuns = require(path.join(SRC, 'services/build-runs'));
let saves = 0;
world.onReset(() => { saves = 0; });
const turnPhase = (v) => (v && typeof v === 'object' ? `(${v.phase || '?'}${v.record ? '+record' : ''})` : '');
function labelOf(prev, next) {
  const out = [];
  for (const [k, v] of Object.entries(next || {})) {
    const had = prev && Object.prototype.hasOwnProperty.call(prev, k);
    if (had && JSON.stringify(prev[k]) === JSON.stringify(v)) continue;
    let extra = '';
    if (/(^|\/)turn:/.test(k)) extra = turnPhase(v);
    else if (/(^|\/)review_state$/.test(k)) extra = `(${v?.inFlight?.step ? `${v.inFlight.step}:${v.inFlight.round ?? v.inFlight.index ?? ''}` : v?.state || '?'})`;
    out.push(`${had ? '~' : '+'}${k}${extra}`);
  }
  for (const k of Object.keys(prev || {})) if (!Object.prototype.hasOwnProperty.call(next || {}, k)) out.push(`-${k}`);
  return out.join(' ') || '(same)';
}
world.stub(path.join(SRC, 'services/build-runs'), {
  ...realRuns,
  async run(ctx, deps) {
    const key = realRuns.keyOf(ctx.input?.target, ctx.input?.id, ctx.input?.nonce);
    return als.run({ key }, async () => {
      await world.record('handler.enter', { attempt: ctx.attempt, lost: ctx.lostAttempts || 0, resumed: !!ctx.resumeFrom });
      let prev = ctx.resumeFrom || {};
      const checkpoint = async (value) => {
        saves += 1;
        const n = saves;
        const label = labelOf(prev, value);
        await world.kill(`save:${n}:before`, { label });
        await ctx.checkpoint(value);
        prev = value;
        await world.record('save', { n, label });
        await world.kill(`save:${n}:after`, { label });
      };
      try {
        const out = await realRuns.run({ ...ctx, checkpoint }, deps);
        await world.record('handler.exit', { outcome: 'returned', acted: out?.acted ?? null });
        return out;
      } catch (err) {
        await world.record('handler.exit', { outcome: 'threw', message: String(err?.message || err).slice(0, 300), stopped: !!err?.stopped });
        throw err;
      }
    });
  },
});

const config = { ...spec.config, databaseUrl: spec.databaseUrl };
require(path.join(SRC, 'db/pool')).getPool(config);
const platform = require(path.join(SRC, 'workflow/platform.ts'));
const setup = require(path.join(SRC, 'workflow/setup.ts'));
// The pipeline itself, loaded now, so a child handed a run starts at once.
require(path.join(SRC, 'services/homeroom-bot'));
require(path.join(SRC, 'routes/sessions'));
process.on('unhandledRejection', (err) => { console.error('unhandled rejection:', err?.stack || err?.message || err); });

// The outside world's own connections are left open to the end: what a
// fake was doing for a turn when the stop came (a dispatch) is cut by the
// exit, as a real process's is, never failed by this process closing them.
async function stopAndExit() {
  await platform.stopWorkflow().catch(() => {});
  await world.record('stopped', {}).catch(() => {});
  process.exit(0);
}

process.on('message', async (m) => {
  // The next build's kill point, in a process that already runs: its
  // counters start again from zero.
  if (m?.arm) {
    killAt = m.arm.killAt || null;
    killMode = m.arm.killMode || 'kill';
    for (const fn of resets) fn();
    process.send({ armed: true });
  }
  if (m?.start) {
    for (const fn of resets) fn();
    killAt = m.start.killAt || null;
    killMode = m.start.killMode || 'kill';
    try {
      await setup.setupWorkflowProcess(config);
      await platform.startWorkflow(config, { loops: true });
      process.send({ ready: true });
    } catch (err) {
      console.error(err);
      process.exit(1);
    }
  }
  if (m?.stop) {
    stopping ||= stopAndExit();
  }
});
// The test that forked it is gone (it timed out, or was killed): so is this.
process.on('disconnect', () => process.exit(0));
process.send({ loaded: true });
