'use strict';

// #6423, #6428: a build whose plan names files another open change touches
// (a person's change, one up for a vote, or a running build's branch) is
// never held for it: it builds now and says once, in the request's thread,
// what it shares. Append-only shared files say Homeroom combines them, and
// a failed diff read, or a running build with no commits yet, says nothing.
// A build held for an overlap before #6428 starts on the next pass.

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
  created_from_issue_number: 6404, linked_issues: [6404],
};

const kinds = (pool) => pool.state.posts.map((p) => p.kind);

test('an overlap in a file that is not append-only starts the build and posts the parallel note', async () => {
  const pool = buildPool({ sessions: [OPEN] });
  const deps = depsFor(pool, { diffs: { 'dev/other': ['src/features/ai/lists.tsx'] } });
  const out = await start(deps, pool);
  assert.notEqual(out.outcome, 'held', 'never held for another change');
  assert.equal(out.outcome, 'fault', 'it went on to the build (the stubbed issue is unreadable)');
  assert.deepEqual(kinds(pool), ['overlap_parallel']);
  assert.equal(pool.said.length, 1, 'one note in the request\'s thread');
  assert.equal(pool.said[0], 'This and PR #6404 both touch `src/features/ai/lists.tsx`. '
    + 'Building now; whichever merges second gets an automatic sync with main.');
});

test('the note is said once across rechecks', async () => {
  const pool = buildPool({ sessions: [OPEN] });
  const deps = depsFor(pool, { diffs: { 'dev/other': ['src/features/ai/lists.tsx'] } });
  await start(deps, pool);
  const second = await start(deps, pool);
  assert.notEqual(second.outcome, 'held');
  assert.equal(pool.state.posts.length, 1, 'one post for the run');
  assert.equal(pool.said.length, 1, 'said once, not on every start');
});

test('a running build or a person\'s open change never holds another build', async () => {
  // A running build's session, read by its branch's diff (it has no pull
  // request yet), and a person's change that is not up for a vote.
  const building = { ...OPEN, id: 502, branch_name: 'dev/building', pr_number: null, created_from_issue_number: 6410, linked_issues: [6410] };
  const person = { ...OPEN, id: 503, branch_name: 'dev/person', pr_number: null, created_from_issue_number: null, linked_issues: [] };
  for (const [session, subject] of [[building, 'the change for request #6410'], [person, 'another open change']]) {
    const pool = buildPool({ sessions: [session] });
    const deps = depsFor(pool, { diffs: { [session.branch_name]: ['src/features/ai/lists.tsx'] } });
    const out = await start(deps, pool);
    assert.equal(out.outcome, 'fault', `${subject}: it went on to the build`);
    assert.match(pool.said[0], new RegExp(`^This and ${subject} both touch`));
  }
  // One up for a vote is not built on: sharing files alone never stacks.
  const pool = buildPool({ sessions: [{ ...OPEN, status: 'promoted' }] });
  const deps = depsFor(pool, { diffs: { 'dev/other': ['src/features/ai/lists.tsx'] } });
  const out = await start(deps, pool);
  assert.equal(out.outcome, 'fault');
  assert.deepEqual(kinds(pool), ['overlap_parallel'], 'beside it, not on top of it');
});

test('a running build whose branch has no commits yet is skipped', async () => {
  const pool = buildPool({ sessions: [{ ...OPEN, pr_number: null }] });
  const deps = depsFor(pool, { diffs: { 'dev/other': [] } });
  const out = await start(deps, pool);
  assert.equal(out.outcome, 'fault', 'it went on to the build');
  assert.equal((pool.said || []).length, 0, 'and nothing is said');
});

test('a build with an append-only overlap goes ahead, and says Homeroom combines it', async () => {
  const pool = buildPool({
    sessions: [OPEN],
    run: waitingRun({ build_note: 'The plan: add a row to `tests/baselines/test-durations.json`.' }),
  });
  const deps = depsFor(pool, { diffs: { 'dev/other': ['tests/baselines/test-durations.json'] } });
  const out = await start(deps, pool, { runId: 900 });
  assert.equal(out.outcome, 'fault', 'it went on to the build (the stubbed issue is unreadable)');
  assert.equal(pool.said.length, 1);
  assert.match(pool.said[0], /, which Homeroom combines on its own\. /);
  assert.match(pool.said[0], /automatic sync with main/);
});

test('a failed diff read counts as no overlap: the build goes ahead', async () => {
  const pool = buildPool({ sessions: [OPEN] });
  const deps = depsFor(pool, { failDiffs: true });
  const out = await start(deps, pool);
  assert.equal(out.outcome, 'fault', 'nothing could be compared');
  assert.equal((pool.said || []).length, 0, 'and nothing is said');
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
  // Only a request's dependency stacks a build, and nothing passes one yet.
  assert.match(startSrc, /await overlapFor\(pool, \{ app, run, issueNumber: Number\(issueNumber\), deps \}\)/);
});

// The bot-request machine's own side (#6428): it holds no build for an
// overlap, and a build stored or reported held for one before is waiting
// for its slot, nothing more.
const requestMachine = require('../src/workflow/bot-request/machine.ts');

const CTX = (now) => ({ machine: requestMachine.MACHINE, key: rules.requestKey(101, 1), appId: 101, version: 2, now });
const OLD_HOLD = {
  heldUntil: '2026-11-06T12:00:00Z', heldFor: 'overlap',
  overlap: { since: '2026-11-06T10:00:00Z', until: '2026-11-06T12:00:00Z', sessionId: 501, runId: null, prNumber: 6404 },
};

function buildingState(build = {}, slot = { grant: 4, kind: 'build', person: 'u7', appId: 101 }) {
  return {
    name: 'building',
    data: {
      appId: 101, issueNumber: 1, owed: null, look: null, n: 1, backoff: null, fix: null, spentRetry: null,
      lastRead: null, carried: null, slot,
      build: { runId: 900, phase: 'waiting', since: '2026-11-06T09:00:00Z', key: null, ...build },
    },
  };
}
const event = (type, payload, source = { kind: 'system' }) => ({
  id: 1, type, payload, source, actor: null, requestKey: 'k', appId: 101, causedBy: null,
});

test('a build held for an overlap before #6428 starts on the next pass', () => {
  const machine = requestMachine.botRequest({ staging: false });
  const out = machine.entryFor('building', 'Granted').to(buildingState(OLD_HOLD, null),
    event('Granted', { appId: 101, issueNumber: 1, grant: 5, kind: 'build', sessionId: null, person: 'u7' },
      { kind: 'message', from: { machine: rules.BOT_LANE, key: rules.LANE_KEY } }),
    {}, CTX(new Date('2026-11-06T11:00:00Z')));
  const build = out.next.data.build;
  assert.equal(build.phase, 'starting', 'granted before its old deadline');
  assert.equal(build.heldUntil, null);
  assert.ok(!('heldFor' in build) && !('overlap' in build), 'the old hold\'s fields are gone');
  assert.equal(build.since, '2026-11-06T09:00:00Z', 'it kept its place in line');
  assert.deepEqual(Object.keys(out.work[0].input).sort(), ['appId', 'issueNumber', 'n', 'person', 'runId']);
});

test('an older build\'s start that held it for an overlap leaves it waiting for its slot, not held', () => {
  const machine = requestMachine.botRequest({ staging: false });
  const result = { outcome: 'held', heldFor: 'overlap', until: '2026-11-06T12:00:00Z', since: '2026-11-06T10:00:00Z' };
  const out = machine.entryFor('building', 'WorkSucceeded').to(buildingState({ phase: 'starting' }),
    event('WorkSucceeded', { kind: requestMachine.WORK.build, workKey: 'build:0', result }), {}, CTX(new Date('2026-11-06T10:00:00Z')));
  const build = out.next.data.build;
  assert.equal(out.next.data.slot, null, 'its building slot goes back');
  assert.equal(build.phase, 'waiting');
  assert.ok(!build.heldUntil, 'no deadline holds it');
  assert.ok(!('heldFor' in build) && !('overlap' in build));
  assert.equal(out.timer, undefined, 'no clock set for it');
  assert.ok(out.messages.some((m) => m.to?.machine === rules.BOT_LANE && m.event.type === 'Released'), 'the lane looks again');
});

test('a hold for the payer\'s week still holds, and a freed week lifts any build hold', () => {
  const machine = requestMachine.botRequest({ staging: false });
  const now = new Date('2026-11-06T10:00:00Z');
  const held = machine.entryFor('building', 'WorkSucceeded').to(buildingState({ phase: 'starting' }),
    event('WorkSucceeded', { kind: requestMachine.WORK.build, workKey: 'build:0', result: { outcome: 'held', until: '2026-11-09T00:00:00Z' } }),
    {}, CTX(now));
  assert.equal(held.next.data.build.heldUntil, '2026-11-09T00:00:00.000Z', 'held until the week resets');
  assert.ok(held.timer, 'and looked at again then');
  for (const build of [{ heldUntil: '2026-11-09T00:00:00Z', heldFor: 'allowance' }, OLD_HOLD]) {
    const out = machine.entryFor('building', 'AllowanceFreed').to(buildingState(build, null),
      event('AllowanceFreed', { appId: 101, issueNumber: 1 }), {}, CTX(now));
    assert.equal(out.next.data.build.heldUntil, null, `${build.heldFor}: lifted`);
    assert.ok(!('heldFor' in out.next.data.build));
    assert.ok(out.messages.some((m) => m.to?.machine === rules.BOT_LANE), 'the lane looks at it again');
  }
  assert.equal(machine.events.has('OverlapEnded'), false, 'no event lifts an overlap hold: there is none');
});
