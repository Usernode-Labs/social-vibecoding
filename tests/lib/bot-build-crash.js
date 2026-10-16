'use strict';

// A Homeroom bot build through crashes of the process that runs it
// (docs/plans/bot-build-workflow.md, "Verifying it";
// tests/bot-build-crash-postgres.test.js).
//
// The test process is the outside world and the web side. A child process
// (tests/lib/bot-build-crash-child.js) is the workflow side: the real
// workflow runtime with the bot-build machine, the real build-runs.js,
// durable-steps.js, durable-turn.js and the bot's pipeline
// (homeroom-bot.js runLiveBuild / buildLive, homeroom-bot-live.js
// buildAndPropose, bot-review.js runReviewLoop), with only what leaves the
// box faked (tests/fixtures/bot-build-crash-fakes.js): the coding worker,
// GitHub, the promote route's pull request, the model.
//
// What the fakes remember lives here, in the database the test owns (the
// crash_world_* tables), not in the child: a coding turn the child
// dispatched is a row that this process finishes once its time is up, writing
// its journal and pushing its commits to the fake branch whether or not the
// child that dispatched it is still alive. So a turn under way at a kill
// keeps going, and the next child finds it running, or finished and pushed.
//
// A turn whose plan carries `holdUntil` is not finished by its time at all:
//   'followed'  finished only once a process has attached to follow it (a
//               turn.follow effect naming its journal), so the next child
//               always finds it still running;
//   'killed'    finished only once the child that dispatched it has recorded
//               its kill (a killed effect of its pid, no older than the
//               turn's dispatch), which is the point that turns the platform's
//               push proxy down — so its push is always refused.
// Either way a held turn is finished anyway 30 s after it was dispatched, so
// a follower that never comes cannot hold the test open.
//
// Kill points: the child counts the build's durable saves (every write of
// the work item's checkpoint) and the fakes' own points (a turn about to be
// dispatched, a turn dispatched, the promote route between GitHub's pull
// request and the session's row, a post between its row and its GitHub
// comment). Armed with one, the child SIGKILLs itself exactly there.

const crypto = require('node:crypto');
const path = require('node:path');
const zlib = require('node:zlib');
const { fork } = require('node:child_process');

const CHILD = path.join(__dirname, 'bot-build-crash-child.js');
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'bot-build-crash-fakes.js');

const WORLD_SQL = `
  CREATE TABLE IF NOT EXISTS crash_world_plans (app_id INT PRIMARY KEY, plan JSONB NOT NULL);
  CREATE TABLE IF NOT EXISTS crash_world_turns (
    id BIGSERIAL PRIMARY KEY,
    app_id INT, session_id INT NOT NULL, journal TEXT NOT NULL UNIQUE,
    turn_id TEXT, turn_uuid TEXT, step TEXT NOT NULL, mode TEXT NOT NULL, dispatch_n INT NOT NULL DEFAULT 1,
    repo TEXT, branch TEXT, base_sha TEXT, base_ahead INT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'running', stopped BOOLEAN NOT NULL DEFAULT FALSE,
    due_at TIMESTAMPTZ NOT NULL, plan JSONB NOT NULL, lines JSONB, result_sha TEXT, push_ok BOOLEAN,
    pid INT, dispatched_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), finished_at TIMESTAMPTZ);
  CREATE TABLE IF NOT EXISTS crash_world_branches (
    repo TEXT NOT NULL, branch TEXT NOT NULL, sha TEXT NOT NULL, PRIMARY KEY (repo, branch));
  CREATE TABLE IF NOT EXISTS crash_world_commits (
    sha TEXT PRIMARY KEY, parent TEXT, ahead INT NOT NULL, step TEXT);
  CREATE TABLE IF NOT EXISTS crash_world_workspaces (
    session_id INT PRIMARY KEY, container TEXT NOT NULL, head_sha TEXT, head_ahead INT, branch TEXT);
  CREATE TABLE IF NOT EXISTS crash_world_prs (
    id BIGSERIAL PRIMARY KEY, repo TEXT NOT NULL, number INT NOT NULL, branch TEXT NOT NULL,
    session_id INT, state TEXT NOT NULL DEFAULT 'open', UNIQUE (repo, number));
  CREATE TABLE IF NOT EXISTS crash_world_captures (
    id TEXT PRIMARY KEY, container TEXT NOT NULL, state TEXT NOT NULL, output TEXT);
  CREATE TABLE IF NOT EXISTS crash_world_effects (
    id BIGSERIAL PRIMARY KEY, app_id INT, build TEXT, kind TEXT NOT NULL, data JSONB NOT NULL DEFAULT '{}',
    pid INT, at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp());
  CREATE INDEX IF NOT EXISTS crash_world_effects_kind ON crash_world_effects (kind, app_id);
  -- Whether a workflow process is up to take a worker's push (its push proxy):
  -- a child marks it down as it dies, and the test up once the next has started.
  CREATE TABLE IF NOT EXISTS crash_world_platform (id BOOLEAN PRIMARY KEY DEFAULT TRUE, up BOOLEAN NOT NULL DEFAULT TRUE);
  INSERT INTO crash_world_platform (id, up) VALUES (TRUE, TRUE) ON CONFLICT DO NOTHING;`;

const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
// Every repository's main is the same commit, so two runs of one scenario
// end on the same shas when they pushed the same commits.
const MAIN_SHA = sha1('main');

// ── What a finished turn leaves in its journal ──────────────────────────

/** A turn's journal as the worker's runners write it (run-cc.sh, Claude Code on OpenRouter). */
function journalLines({ mode, text, threadId, ahead = 0, sha = '', pushOk = true, stopped = false }) {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: threadId }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it.' }] } }),
  ];
  if (stopped) return [...lines, '__USERNODE_EXIT__ 143'];
  lines.push(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: text, session_id: threadId,
    usage: { input_tokens: 100000, output_tokens: 50000 },
  }));
  if (mode === 'build') lines.push('__USERNODE_PHASE__ commit', '__USERNODE_PHASE__ push', `__USERNODE_PHASE__ ${pushOk ? 'done' : 'push_failed'}`);
  lines.push(`__USERNODE_RESULT__ cc_exit=0 ahead=${ahead} behind=0 sha=${sha} push_ok=${pushOk ? 1 : 0} mode=${mode} agent_thread_id=${threadId}`);
  lines.push('__USERNODE_EXIT__ 0');
  return lines;
}

/**
 * Finish every coding turn whose time is up (or that was stopped, or whose
 * plan's `holdUntil` is satisfied — see the header): its journal is written,
 * and a build turn's commits are made on what it started from and pushed,
 * fast-forward only, as the worker's runner pushes. Runs in the test
 * process, whatever became of the child that dispatched the turn. A turn
 * whose plan says `pushNeedsPlatform` pushes through the platform's push
 * proxy, so its push fails while no workflow process is up
 * (crash_world_platform): it commits, and its journal says push_ok=0.
 * Resolves how many it finished.
 */
async function settleTurns(pool) {
  const client = await pool.connect();
  let n = 0;
  try {
    await client.query('BEGIN');
    const { rows: [{ up: platformUp }] } = await client.query('SELECT up FROM crash_world_platform');
    // A held turn's own trigger (its `holdUntil`), not its time, releases it;
    // the 30 s ceiling finishes it anyway, so a hold is never forever.
    const { rows } = await client.query(
      `SELECT * FROM crash_world_turns WHERE status = 'running' AND (
          stopped
          OR (plan->>'holdUntil' IS NULL AND due_at <= clock_timestamp())
          OR (plan->>'holdUntil' = 'followed' AND EXISTS (
                SELECT 1 FROM crash_world_effects e
                WHERE e.kind = 'turn.follow' AND e.data->>'journal' = crash_world_turns.journal))
          OR (plan->>'holdUntil' = 'killed' AND EXISTS (
                SELECT 1 FROM crash_world_effects e
                WHERE e.kind = 'killed' AND e.pid = crash_world_turns.pid
                  AND e.at >= crash_world_turns.dispatched_at))
          OR (plan->>'holdUntil' IS NOT NULL AND dispatched_at <= clock_timestamp() - interval '30 seconds'))
        ORDER BY id LIMIT 8 FOR UPDATE SKIP LOCKED`);
    for (const t of rows) {
      const plan = t.plan || {};
      let ahead = Number(t.base_ahead) || 0;
      let sha = t.base_sha || '';
      let pushOk = true;
      if (t.mode === 'build' && !t.stopped) {
        const commits = Number(plan.commits) || 0;
        let head = t.base_sha;
        for (let i = 1; i <= commits; i += 1) {
          const next = sha1(`${head}|${t.step}|${t.dispatch_n}|${i}`);
          ahead += 1;
          await client.query(
            'INSERT INTO crash_world_commits (sha, parent, ahead, step) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
            [next, head, ahead, t.step]);
          head = next;
        }
        sha = head;
        if (commits > 0) {
          const { rows: [b] } = await client.query(
            'SELECT sha FROM crash_world_branches WHERE repo = $1 AND branch = $2 FOR UPDATE', [t.repo, t.branch]);
          pushOk = !!b && b.sha === t.base_sha && !plan.pushFails && !(plan.pushNeedsPlatform && !platformUp);
          if (pushOk) {
            await client.query('UPDATE crash_world_branches SET sha = $3 WHERE repo = $1 AND branch = $2', [t.repo, t.branch, head]);
          }
          await client.query(
            `INSERT INTO crash_world_effects (app_id, kind, data) VALUES ($1, $2, $3)`,
            [t.app_id, pushOk ? 'push' : 'push.rejected', JSON.stringify({ step: t.step, sha: head, from: t.base_sha, by: 'turn', branch: t.branch, branchWas: b?.sha || null })]);
        }
        await client.query(
          `UPDATE crash_world_workspaces SET head_sha = $2, head_ahead = $3 WHERE session_id = $1`, [t.session_id, sha, ahead]);
      }
      const lines = journalLines({
        mode: t.mode, text: plan.text || 'Done.', threadId: `thread-${t.session_id}-${t.step}`,
        ahead: t.mode === 'build' ? ahead : 0, sha: t.mode === 'build' ? sha : '', pushOk, stopped: t.stopped,
      });
      await client.query(
        `UPDATE crash_world_turns SET status = 'finished', lines = $2, finished_at = clock_timestamp(),
                result_sha = $3, push_ok = $4 WHERE id = $1`,
        [t.id, JSON.stringify(lines), t.mode === 'build' ? sha : null, pushOk]);
      n += 1;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return n;
}

// ── A capture, as the screenshot step writes it ─────────────────────────

function pngOf(width, height, rgb) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The screenshot step's one line of output: it booted, two screenshots. */
function captureStdout() {
  const out = {
    booted: true,
    error: null,
    steps: { install: { ran: true, ok: true, ms: 5 }, boot: { command: 'npm start' }, emptied: { ok: true } },
    shots: [
      { id: 'phone-light-populated', png: pngOf(4, 8, [250, 250, 250]).toString('base64'), status: 200, consoleErrors: 0 },
      { id: 'phone-dark-populated', png: pngOf(4, 8, [20, 20, 20]).toString('base64'), status: 200, consoleErrors: 0 },
    ],
    ms: 12,
  };
  return `__USERNODE_BENCH_CAPTURE__ ${JSON.stringify(out)}\n`;
}

// ── The child ───────────────────────────────────────────────────────────

/**
 * Fork a workflow child. It loads the platform and its fakes at once and
 * waits; `start({ killAt })` starts its workflow runtime (with the loops),
 * so a lane can keep one child warm and hand it the next run.
 */
function forkChild({ databaseUrl, config, env = {}, label = '' }) {
  let stderr = '';
  const child = fork(CHILD, [], {
    env: {
      ...process.env, ...env,
      BOT_BUILD_CRASH_CHILD: JSON.stringify({ databaseUrl, config, fixture: FIXTURE }),
    },
    execArgv: [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const debug = process.env.BOT_BUILD_CRASH_DEBUG;
  child.stdout.on('data', (d) => { if (debug) process.stdout.write(`[child ${label} ${child.pid}] ${d}`); });
  child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 200000) stderr = stderr.slice(-100000); if (debug) process.stderr.write(`[child ${label} ${child.pid}] ${d}`); });
  let exitInfo = null;
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => {
    exitInfo = { code, signal, at: Date.now() };
    resolve(exitInfo);
  }));
  const loaded = new Promise((resolve, reject) => {
    child.on('message', (m) => { if (m?.loaded) resolve(); });
    exited.then(({ code, signal }) => reject(new Error(`the workflow child exited (${signal || code}) before it loaded\n${stderr.slice(-4000)}`)));
  });
  loaded.catch(() => {});
  return {
    pid: child.pid,
    loaded,
    exited,
    get exitInfo() { return exitInfo; },
    stderr: () => stderr,
    async start({ killAt = null, killMode = 'kill' } = {}) {
      await loaded;
      const ready = new Promise((resolve, reject) => {
        const on = (m) => { if (m?.ready) { child.off('message', on); resolve(); } };
        child.on('message', on);
        exited.then(({ code, signal }) => reject(new Error(`the workflow child exited (${signal || code}) before it was ready\n${stderr.slice(-4000)}`)));
      });
      child.send({ start: { killAt, killMode } });
      await ready;
    },
    // The next build's kill point, for a child already running.
    async arm({ killAt = null, killMode = 'kill' } = {}) {
      const armed = new Promise((resolve, reject) => {
        const on = (m) => { if (m?.armed) { child.off('message', on); resolve(); } };
        child.on('message', on);
        exited.then(({ code, signal }) => reject(new Error(`the workflow child exited (${signal || code}) before it was armed`)));
      });
      child.send({ arm: { killAt, killMode } });
      await armed;
    },
    async kill() {
      if (exitInfo) return exitInfo;
      child.kill('SIGKILL');
      return exited;
    },
    // A clean stop, as a release's SIGTERM gives one: the runtime stops and
    // gives up the leases of what it was running.
    async stop({ graceMs = 20000 } = {}) {
      if (exitInfo) return exitInfo;
      child.send({ stop: true });
      const t = setTimeout(() => child.kill('SIGKILL'), graceMs);
      const info = await exited;
      clearTimeout(t);
      return info;
    },
  };
}

// `signal` (an AbortSignal) stops the wait: once it is aborted, `until`
// resolves null instead of polling on — a wait that lost a race to another
// outcome is not left polling, and its timeout, if it came to one, is never
// thrown.
async function until(check, what, timeoutMs = 30000, everyMs = 40, { signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) return null;
    const v = await check();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

module.exports = {
  WORLD_SQL, MAIN_SHA, sha1, journalLines, settleTurns, captureStdout, pngOf, forkChild, until, FIXTURE,
};
