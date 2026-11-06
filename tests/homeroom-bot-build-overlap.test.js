'use strict';

// #6423: a build whose plan names files another open change or running
// build touches waits for it (or builds on top), says so once in the
// request's thread, and gives its building slot back; append-only shared
// files, a timeout, and a failed diff read all let it build.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bot = require('../src/services/homeroom-bot');
const rules = require('../src/workflow/rules/bot-loop.ts');

const APP = { id: 101, slug: 'demo', name: 'Demo', repo_url: 'https://github.com/acme/demo', self_hosted: false };

function waitingRun(over = {}) {
  return {
    id: 900, app_id: 101, issue_number: 1, mode: 'live', verdict: 'ready', charged: false,
    build_note: 'The plan: change `src/features/ai/lists.tsx`.',
    build_ok: null, build_session_id: null, proposal_session_id: null,
    live_build_waiting_at: new Date().toISOString(), ...over,
  };
}

/** A pool that answers what a build's start reads, and keeps the notes it posts. */
function buildPool({ run = waitingRun(), sessions = [], posts = [], diffs = {} } = {}) {
  const log = [];
  const state = { posts: [...posts] };
  const pool = {
    log,
    state,
    async query(sql, params = []) {
      const s = String(sql);
      log.push({ s, params });
      if (/SELECT key, value FROM platform_settings/.test(s)) return { rows: [{ key: bot.KEY_MODE, value: 'live' }] };
      if (/FROM users WHERE username = \$1/.test(s)) return { rows: [{ id: 77, username: 'homeroom_bot', weekly_limit_cents: 15000 }] };
      if (/SELECT is_synthetic FROM users/.test(s)) return { rows: [{ is_synthetic: true }] };
      if (/FROM apps WHERE id = \$1/.test(s)) return { rows: [APP] };
      if (/SELECT \* FROM homeroom_bot_runs WHERE id = \$1/.test(s)) return { rows: run && run.id === Number(params[0]) ? [run] : [] };
      if (/FROM homeroom_bot_posts WHERE run_id = \$1 AND kind = \$2/.test(s)) {
        return { rows: state.posts.filter((p) => p.runId === Number(params[0]) && p.kind === params[1]).map(() => ({})) };
      }
      if (/INSERT INTO homeroom_bot_posts/.test(s)) {
        state.posts.push({ appId: Number(params[0]), issueNumber: Number(params[1]), runId: Number(params[2]), kind: params[3] });
        return { rows: [] };
      }
      if (/FROM chat_sessions\s+WHERE app_id = \$1 AND is_headless = FALSE AND branch_name IS NOT NULL/.test(s)) return { rows: sessions };
      if (/FROM wf_instances w/.test(s) && /w\.machine = \$1 AND w\.app_id/.test(s)) return { rows: [] };
      // buildOne's reads: no proposal, no other build; the issue unreadable.
      if (/SELECT id FROM chat_sessions/.test(s)) return { rows: [] };
      if (/SELECT bs\.id FROM homeroom_bot_runs b/.test(s)) return { rows: [] };
      return { rows: [] };
    },
  };
  pool.diffs = diffs;
  return pool;
}

function depsFor(pool, { diffs = {}, failDiffs = false } = {}) {
  return {
    platform: { async buildsUnderWay() { return []; } },
    limits: { async checkBudget() { return {}; } },
    dm: {
      async requesterOf() { return { userId: 7 }; },
      async overWeeklyAllowance() { return false; },
      async personOf() { return null; },
    },
    ws: {
      async sendBotMessage(_pool, _appId, msg) { (pool.said ||= []).push(msg.content); },
      async postOnProposal(_pool, _appId, msg) { (pool.said ||= []).push(msg.content); },
    },
    github: {
      isEnabled: () => true,
      async listChangedFiles(_owner, _repo, basehead) {
        if (failDiffs) throw new Error('compare failed');
        const branch = String(basehead).replace(/^main\.\.\./, '');
        return diffs[branch] || [];
      },
      async fetchPublicIssue() { return null; },
      async username() { return 'homeroom_bot'; },
    },
  };
}

const start = (deps, pool, more = {}) => bot.startBuild({}, pool, {
  appId: 101, issueNumber: 1, runId: 900, replyTo: { machine: 'bot-request', key: rules.requestKey(101, 1) }, person: 'u7',
  deps, ...more,
});

const OPEN = {
  id: 501, status: 'active', branch_name: 'dev/other', pr_number: 6404, waits_for_session_id: null, rebuilt_from_session_id: null,
};

test('a build touching a file an open change touches is held, and says why', async () => {
  const pool = buildPool({ sessions: [OPEN] });
  const deps = depsFor(pool, { diffs: { 'dev/other': ['src/features/ai/lists.tsx'] } });
  const out = await start(deps, pool);
  assert.equal(out.outcome, 'held');
  assert.equal(out.heldFor, 'overlap', 'told apart from the week\'s hold');
  assert.equal(out.overlap.sessionId, 501);
  assert.equal(out.overlap.prNumber, 6404);
  const waited = Date.parse(out.until) - Date.parse(out.since);
  assert.equal(waited, rules.OVERLAP_WAIT_MS, 'the wait is two hours from its start');
  assert.equal(pool.said.length, 1, 'one note in the request\'s thread');
  assert.match(pool.said[0], /This touches `src\/features\/ai\/lists\.tsx`, which PR #6404 is also changing/);
  assert.match(pool.said[0], /2 hours/);
  assert.ok(!pool.log.some((l) => /INSERT INTO chat_sessions/.test(l.s)), 'nothing was built');
});

test('the wait is said once across rechecks', async () => {
  const pool = buildPool({ sessions: [OPEN] });
  const deps = depsFor(pool, { diffs: { 'dev/other': ['src/features/ai/lists.tsx'] } });
  const first = await start(deps, pool);
  const second = await start(deps, pool, { overlapSince: first.since });
  assert.equal(second.outcome, 'held');
  assert.equal(pool.state.posts.length, 1, 'one post for one wait');
  assert.equal(pool.said.length, 1, 'said once, not on every recheck');
});

test('a build with an append-only overlap goes ahead, and says which sync it will need', async () => {
  const pool = buildPool({
    sessions: [{ ...OPEN, pr_number: 6404 }],
    run: waitingRun({ build_note: 'The plan: add a row to `tests/baselines/test-durations.json`.' }),
  });
  const deps = depsFor(pool, { diffs: { 'dev/other': ['tests/baselines/test-durations.json'] } });
  const out = await start(deps, pool, { runId: 900 });
  assert.notEqual(out.outcome, 'held', 'never blocked by the durations list alone');
  assert.equal(out.outcome, 'fault', 'it went on to the build (the stubbed issue is unreadable)');
  assert.equal(pool.said.length, 1);
  assert.match(pool.said[0], /Homeroom combines on its own/);
  assert.match(pool.said[0], /automatic sync with main/);
});

test('a failed diff read counts as no overlap: the build goes ahead', async () => {
  const pool = buildPool({ sessions: [OPEN] });
  const deps = depsFor(pool, { failDiffs: true });
  const out = await start(deps, pool);
  assert.equal(out.outcome, 'fault', 'not held: nothing could be compared');
  assert.equal((pool.said || []).length, 0, 'and nothing is said');
});

test('a wait past two hours builds on main anyway, and says so', async () => {
  const pool = buildPool({ sessions: [OPEN] });
  const deps = depsFor(pool, { diffs: { 'dev/other': ['src/features/ai/lists.tsx'] } });
  const since = new Date(Date.now() - rules.OVERLAP_WAIT_MS - 60_000).toISOString();
  const out = await start(deps, pool, { overlapSince: since });
  assert.notEqual(out.outcome, 'held');
  assert.equal(pool.said.length, 1);
  assert.match(pool.said[0], /has not merged after 2 hours, so I'm building this on main now/);
});

test('a change up for a vote is built on top of, and the note says so', async () => {
  const pool = buildPool({ sessions: [{ ...OPEN, status: 'promoted' }] });
  const deps = depsFor(pool, { diffs: { 'dev/other': ['src/features/ai/lists.tsx'] } });
  const out = await start(deps, pool);
  assert.notEqual(out.outcome, 'held');
  assert.match(pool.said[0], /up for a vote, also changes\. I'm building this on top of it/);
});

test('a woken wait whose change merged says it builds on the new main', async () => {
  const pool = buildPool({ sessions: [] });
  const deps = depsFor(pool, { diffs: {} });
  // The prior wait's session is merged now: read back by its id.
  pool.query = ((orig) => async (sql, params) => {
    if (/SELECT status FROM chat_sessions WHERE id = \$1/.test(String(sql)) && Number(params[0]) === 501) {
      return { rows: [{ status: 'merged' }] };
    }
    return orig.call(pool, sql, params);
  })(pool.query);
  const out = await start(deps, pool, {
    overlapSince: new Date(Date.now() - 60_000).toISOString(),
    priorOverlap: { since: new Date(Date.now() - 60_000).toISOString(), sessionId: 501, runId: null, prNumber: 6404 },
  });
  assert.notEqual(out.outcome, 'held');
  assert.match(pool.said[0], /PR #6404 merged, so I'm building this on the new main/);
});

test('a woken wait whose change was closed says it builds on main now', async () => {
  const pool = buildPool({ sessions: [] });
  const deps = depsFor(pool, { diffs: {} });
  pool.query = ((orig) => async (sql, params) => {
    if (/SELECT status FROM chat_sessions WHERE id = \$1/.test(String(sql)) && Number(params[0]) === 501) {
      return { rows: [{ status: 'archived' }] };
    }
    return orig.call(pool, sql, params);
  })(pool.query);
  const out = await start(deps, pool, {
    priorOverlap: { since: new Date(Date.now() - 60_000).toISOString(), sessionId: 501, runId: null, prNumber: 6404 },
  });
  assert.notEqual(out.outcome, 'held');
  assert.match(pool.said[0], /PR #6404 was closed, so I'm building this on main now/);
});

// The stack is passed down the build's calls, which cannot run in a test
// without a repository: the chain is pinned where it is written.
test('the stack a build on top makes is passed to the build and its session', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const startSrc = read('src/services/homeroom-bot.js');
  assert.match(startSrc, /buildOne\(pool, config, \{ bot, app, run, settings, stackOn, deps/);
  assert.match(startSrc, /^\s+stackOn,$/m, 'buildOne\'s arguments carry it');
  assert.match(startSrc, /'presetSpecHtml', 'stackOn',/, 'and so does the durable build\'s input');
  assert.match(read('src/services/homeroom-bot-live.js'), /stackOn = null,/, 'buildAndPropose takes it');
  const liveSrc = read('src/services/homeroom-bot-live.js');
  assert.match(liveSrc, /waits_for_session_id, imported_pr_base_ref\)/, 'the session waits for the change it is on top of');
  assert.match(liveSrc, /stackOn\?\.branch/, 'its base is that change\'s branch');
  assert.match(read('src/services/github.js'), /base = 'main',/, 'a pull request is opened on that base');
  assert.match(read('src/services/pr-metadata.js'), /base: session\.imported_pr_base_ref/, 'a bot change opens its own that way too');
});

// The bot-request machine's own side of a wait: its hold is told apart from
// the week's, and only the waited-for change ending lifts it.
const requestMachine = require('../src/workflow/bot-request/machine.ts');

function buildingState(now) {
  return {
    name: 'building',
    data: {
      appId: 101, issueNumber: 1, owed: null, look: null, n: 1, backoff: null, fix: null, spentRetry: null,
      lastRead: null, carried: null,
      slot: { grant: 4, kind: 'build', person: 'u7', appId: 101 },
      build: { runId: 900, phase: 'waiting', since: '2026-11-06T09:00:00Z', key: null },
    },
  };
}

test('an overlap hold keeps the build\'s place, releases the slot, and ends at its deadline', () => {
  const machine = requestMachine.botRequest({ staging: false });
  const now = new Date('2026-11-06T10:00:00Z');
  const until = '2026-11-06T12:00:00Z';
  const result = {
    outcome: 'held', heldFor: 'overlap', until, since: '2026-11-06T10:00:00Z',
    with: { sessionId: 501, runId: null, prNumber: 6404 },
  };
  const out = machine.entryFor('building', 'WorkSucceeded').to(buildingState(now), {
    id: 1, type: 'WorkSucceeded',
    payload: { kind: requestMachine.WORK.build, workKey: 'build:0', result },
    source: { kind: 'system' }, actor: null, requestKey: 'b', appId: 101, causedBy: null,
  }, {}, { machine: requestMachine.MACHINE, key: rules.requestKey(101, 1), appId: 101, version: 2, now });
  assert.equal(out.next.data.slot, null, 'its building slot goes back');
  assert.equal(out.next.data.build.phase, 'waiting');
  assert.equal(out.next.data.build.since, '2026-11-06T09:00:00Z', 'it keeps its place in line');
  assert.equal(out.next.data.build.heldFor, 'overlap');
  assert.equal(out.next.data.build.overlap.sessionId, 501);
  assert.equal(out.next.data.build.overlap.prNumber, 6404);
  assert.equal(Date.parse(out.next.data.build.heldUntil), Date.parse(until));
  assert.equal(Date.parse(out.timer.at.toISOString()), Date.parse(until), 'looked at again when the wait runs out');
  assert.ok(out.messages.some((m) => m.to?.machine === rules.BOT_LANE), 'the lane hears its freed slot');
});

test('the change a build waited for ending lifts the hold and looks again', () => {
  const machine = requestMachine.botRequest({ staging: false });
  const now = new Date('2026-11-06T11:00:00Z');
  const s = buildingState(now);
  s.data.build = { ...s.data.build, heldUntil: '2026-11-06T12:00:00Z', heldFor: 'overlap',
    overlap: { since: '2026-11-06T10:00:00Z', until: '2026-11-06T12:00:00Z', sessionId: 501, runId: null, prNumber: 6404 } };
  s.data.slot = null;
  const out = machine.entryFor('building', 'OverlapEnded').to(s, {
    id: 1, type: 'OverlapEnded', payload: { appId: 101, issueNumber: 1 },
    source: { kind: 'system', name: 'overlap' }, actor: null, requestKey: 'o', appId: 101, causedBy: null,
  }, {}, { machine: requestMachine.MACHINE, key: rules.requestKey(101, 1), appId: 101, version: 2, now });
  assert.equal(out.next.data.build.heldUntil, null);
  assert.equal(out.next.data.build.heldFor, null);
  assert.ok(out.messages.some((m) => m.to?.machine === rules.BOT_LANE), 'the lane looks at it again');
});

test('a freed week does not lift an overlap hold', () => {
  const machine = requestMachine.botRequest({ staging: false });
  const now = new Date('2026-11-06T11:00:00Z');
  const s = buildingState(now);
  s.data.build = { ...s.data.build, heldUntil: '2026-11-06T12:00:00Z', heldFor: 'overlap' };
  s.data.slot = null;
  const out = machine.entryFor('building', 'AllowanceFreed').to(s, {
    id: 1, type: 'AllowanceFreed', payload: { appId: 101, issueNumber: 1 },
    source: { kind: 'system', name: 'allowance' }, actor: null, requestKey: 'a', appId: 101, causedBy: null,
  }, {}, { machine: requestMachine.MACHINE, key: rules.requestKey(101, 1), appId: 101, version: 2, now });
  assert.equal(out.next.data.build.heldUntil, '2026-11-06T12:00:00Z', 'still waiting for the other change');
});
