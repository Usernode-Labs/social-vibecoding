'use strict';

// #3624 stage 2: how much the Homeroom bot works on at once.
//
// Live work (every app but a paused one) is started one request at a time:
// never two reads on one app (the bot has one session per app) unless one
// is a follow-up on its own proposal (#3703, below), at most `perPerson`
// for one person, at most `liveAtOnce` in all. The lane (bot-lane) grants
// those slots from its candidates and the slots its requests hold, with the
// picks in src/workflow/rules/bot-loop.ts; each look is a work item of its
// request's machine (bot-request), so a long build on one app never holds
// up an answer on another. tests/workflow-bot-loop-postgres.test.js drives
// the two machines; this file pins the picks, the candidates' rules, and
// what a look and a build's start report back.
//
// Run with: node --test tests/homeroom-bot-at-once.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const bot = require('../src/services/homeroom-bot');
const rules = require('../src/workflow/rules/bot-loop.ts');
const request = require('../src/workflow/bot-request/machine.ts');

const row = (id, appId, personId, extra = {}) => ({
  id, app_id: appId, issue_number: id, priority: 1, reason: 'new', person_id: personId, ...extra,
});
// A slot a request holds (bot-request data.slot), as the lane reads it.
const slot = (kind, appId, person) => ({ kind, appId, person });

test('pickLive: one per app, at most perPerson for anybody, at most `slots` in all, in queue order', () => {
  const candidates = [
    row(1, 10, 7), row(2, 10, 7), // two on app 10: only the first
    row(3, 11, 7), row(4, 12, 7), // a third app for person 7: over their 2
    row(5, 13, 8), row(6, 14, null), // person 8, and an issue nobody on Homeroom filed
  ];
  const picks = rules.pickLive(candidates, { inUse: [], slots: 6, perPerson: 2 });
  assert.deepEqual(picks.map((p) => p.id), [1, 3, 5, 6]);
  assert.deepEqual(picks.map((p) => p.person), ['u7', 'u7', 'u8', 'a14'], 'nobody filed it: it counts as its app');

  // What already runs counts: person 7 has a read going, on app 13.
  const more = rules.pickLive(candidates, { inUse: [slot('read', 13, 'u7')], slots: 6, perPerson: 2 });
  assert.deepEqual(more.map((p) => p.id), [1, 6]);

  // The platform ceiling (the lane hands in what is left of liveAtOnce).
  assert.deepEqual(rules.pickLive(candidates, { slots: 1, perPerson: 2 }).map((p) => p.id), [1]);
  assert.deepEqual(rules.pickLive(candidates, { slots: 0, perPerson: 2 }), []);
});

// ── #3703: a reply on the bot's own proposal ─────────────────────────────
//
// evan asked a question in the discussion of the bot's proposal on his Ear
// Trainer project and heard nothing for eleven minutes: the reply was
// queued at once, but the project's one live slot was building another
// request, and when it freed a newer request was taken first. A follow-up
// runs on the proposal's own session, so it no longer waits for the app's.

const followUp = (id, appId, personId, extra = {}) => row(id, appId, personId, {
  priority: 2, reason: 'changed', follow_up_session_id: 5000 + id, ...extra,
});

test('pickLive: a follow-up on the bot\'s own proposal neither waits for its app nor holds it', () => {
  // The app's session is reading another request: the reply still starts.
  let picks = rules.pickLive([followUp(1, 10, 7), row(2, 10, 7)], {
    inUse: [slot('read', 10, 'u7')], slots: 6, perPerson: 2,
  });
  assert.deepEqual(picks.map((p) => [p.id, p.followUp]), [[1, true]]);

  // It takes no app: the app's next request can start beside it.
  picks = rules.pickLive([followUp(1, 10, 7), row(2, 10, 8), row(3, 10, 8)], { slots: 6, perPerson: 2 });
  assert.deepEqual(picks.map((p) => [p.id, p.followUp]), [[1, true], [2, false]], 'and still one request per app');

  // It is still one of its person's slots, and one of the platform's.
  assert.deepEqual(rules.pickLive([followUp(1, 10, 7)], {
    inUse: [slot('read', 20, 'u7'), slot('followUp', 21, 'u7')], slots: 6, perPerson: 2,
  }), []);
  assert.deepEqual(rules.pickLive([followUp(1, 10, 7)], { slots: 0, perPerson: 2 }), []);

  // Only a read holds its app's session: a follow-up or a build running
  // there leaves it free for the app's next request.
  assert.deepEqual(rules.pickLive([row(2, 10, 8)], { inUse: [slot('followUp', 10, 'u9')], slots: 6, perPerson: 2 }).map((p) => p.id), [2]);
  assert.deepEqual(rules.pickLive([row(2, 10, 8)], { inUse: [slot('build', 10, 'u9')], slots: 6, perPerson: 2 }).map((p) => p.id), [2]);
});

test('a look refused for now backs off its own request, doubling to a ceiling; a platform fault pauses the lane the same way', () => {
  // The backoff lives on the request (bot-request data.backoff), so a
  // follow-up refused a turn holds back that request alone, not its app.
  assert.equal(rules.backoffMs(1), rules.BACKOFF_BASE_MS);
  assert.equal(rules.backoffMs(2), rules.BACKOFF_BASE_MS * 2, 'doubling');
  assert.equal(rules.backoffMs(40), rules.BACKOFF_CEILING_MS, 'and never past its ceiling');
  assert.equal(rules.BACKOFF_CEILING_MS, 60 * 60 * 1000);
  assert.equal(rules.faultMs(1), rules.FAULT_BASE_MS);
  assert.equal(rules.faultMs(3), rules.FAULT_BASE_MS * 4);
  assert.equal(rules.faultMs(40), rules.FAULT_CEILING_MS);
  assert.equal(bot.BACKOFF_BASE_MS, rules.BACKOFF_BASE_MS, 'the module that does the reads names the same');
});

test('the lane\'s read candidates say which rows are follow-ups, let only them past what holds the app, and take them first', () => {
  const s = rules.READ_CANDIDATES_SQL;
  // Only requests owed a look and waiting for a slot, and never one whose
  // grant is on its way.
  assert.match(s, /JOIN wf_instances w ON w\.machine = 'bot-request' AND w\.key = 'request:' \|\| q\.app_id \|\| ':' \|\| q\.issue_number\s+AND w\.state = 'queued'/);
  assert.match(s, /AND NOT EXISTS \(SELECT 1 FROM wf_events g\s+WHERE g\.machine = 'bot-request' AND g\.key = w\.key\s+AND g\.type = 'Granted' AND g\.status = 'pending'\)/);
  // Not on a paused app, nor held for its payer's week, nor backed off.
  assert.match(s, /AND NOT \(a\.slug = ANY\(\$2::text\[\]\)\)/);
  assert.match(s, /AND \(q\.held_until IS NULL OR q\.held_until <= NOW\(\)\)/);
  assert.match(s, /AND \(q\.wait_until IS NULL OR q\.wait_until <= NOW\(\)\)/);
  // One turn for a burst: a person still writing on the request or on the
  // bot's change for it is read once they pause (SETTLE_MS).
  assert.match(s, /m\.created_at > NOW\(\) - make_interval\(secs => 20\)/);
  assert.match(s, /OR \(fu\.id IS NOT NULL AND m\.thread_type = 'session' AND m\.thread_ref = fu\.id\)/);
  // Plant Pal #1 and #3: a request whose live build waits or runs is read
  // once that build ends, whatever queued it.
  assert.match(s, /AND NOT EXISTS \(\s+SELECT 1 FROM homeroom_bot_runs b\s+WHERE b\.app_id = q\.app_id AND b\.issue_number = q\.issue_number/);
  // The bot's own proposal on the issue, still up for a vote: what runTriage
  // follows up on (live.openBotProposal, runFollowUp).
  assert.match(s, /cs\.user_id = \$1\s+AND q\.issue_number = ANY\(cs\.linked_issues\)\s+AND cs\.status = 'promoted' AND cs\.is_headless = FALSE/);
  assert.match(s, /fu\.id AS follow_up_session_id/);
  assert.match(s, /ORDER BY \(q\.priority = 0\) DESC, \(fu\.id IS NOT NULL\) DESC, q\.priority, q\.enqueued_at/,
    'a Run now first, then a reply on the bot\'s proposal, then the rest in their order');
});

/** A pool that answers a look's queries (lookAt, then runTriage). */
function lookPool({ settings, apps = [] }) {
  const log = [];
  return {
    log,
    async query(sql, params) {
      const s = String(sql);
      log.push({ s, params });
      if (/SELECT key, value FROM platform_settings/.test(s)) return { rows: settings };
      if (/FROM users WHERE username = \$1/.test(s)) return { rows: [{ id: 77, username: 'homeroom_bot', weekly_limit_cents: 15000 }] };
      if (/SELECT is_synthetic FROM users/.test(s)) return { rows: [{ is_synthetic: true }] };
      if (/FROM apps WHERE id = \$1/.test(s)) return { rows: apps.filter((a) => a.id === Number(params[0])) };
      return { rows: [] };
    },
  };
}

// Every app but a paused one is live, so these need no setting to be.
const APPS = ['a1', 'a2', 'a3', 'a4'].map((slug, i) => ({ id: 101 + i, slug, name: slug, repo_url: `https://github.com/o/${slug}`, self_hosted: false, status: 'running' }));

test('a follow-up whose proposal has gone is put back untouched, to be taken in the app\'s own turn', async () => {
  const pool = lookPool({ settings: [{ key: bot.KEY_MODE, value: 'shadow' }], apps: APPS });
  const deps = {
    github: {
      isEnabled: () => true,
      async fetchPublicIssue() { return { issue: { number: 4, title: 'x', state: 'open' } }; },
    },
    limits: { async checkBudget() { return { ok: true }; } },
    dm: { async recordRequester() { return null; } },
    ws: {}, sessionLifecycle: {}, domain: 'app.onhomeroom.com',
  };
  // The proposal merged between the grant and the look: openBotProposal
  // finds none.
  const out = await bot.lookAt({}, pool, {
    input: { appId: 103, issueNumber: 4, n: 1, kind: 'followUp', owed: { reason: 'changed', priority: 2 } },
    deps,
  });
  assert.deepEqual(out, { outcome: 'requeue', reason: 'changed', priority: 2 }, 'owed again as it was');
  assert.ok(!pool.log.some((l) => /INSERT INTO homeroom_bot_runs|homeroom_bot_queue SET|DELETE FROM homeroom_bot_queue/.test(l.s)),
    'no run recorded, and the queue row is its machine\'s to move');
  assert.ok(!pool.log.some((l) => /FROM chat_sessions\s+WHERE user_id = \$1 AND app_id = \$2 AND status IN \('active', 'paused'\)/.test(l.s)),
    'and the app\'s own session, which another request may be using, untouched');
  assert.ok(pool.log.some((l) => /SELECT id, status, pr_number FROM chat_sessions/.test(l.s)), 'it did look for the proposal');
});

// ── A project's next request is read while its build runs ───────────────
//
// A live ready verdict used to be built inside the turn that read it, so
// the project's one slot was held for the whole build (up to 50 minutes,
// 110 on the platform's repository) and every other request on it waited
// unread. Now the build waits on its run and gets a slot of its own (a
// `build` slot its request holds while bot-build runs it): up to
// BUILDS_PER_PROJECT builds per project at a time, each on a session and
// branch of its own, reading beside them.

const waitingBuild = (id, appId, issueNumber, personId) => ({
  id, app_id: appId, issue_number: issueNumber, run_id: id, person_id: personId,
});

test('three builds per project at once: Homeroom\'s own requests stopped waiting in a line', () => {
  assert.equal(rules.BUILDS_PER_PROJECT, 3);
  assert.equal(bot.BUILDS_PER_PROJECT, rules.BUILDS_PER_PROJECT);
});

test('pickLiveBuilds: up to perProject builds per project, counting those running, perPerson and slots counted', () => {
  const rows = [
    waitingBuild(900, 10, 1, 7), waitingBuild(901, 10, 2, 8), waitingBuild(902, 10, 5, 9), waitingBuild(903, 10, 6, 9),
    waitingBuild(904, 11, 3, 8), waitingBuild(905, 12, 4, 7),
  ];
  assert.deepEqual(rules.pickLiveBuilds(rows, { slots: 9, perPerson: 2 }).map((p) => p.id), [900, 901, 902, 904, 905],
    'three on project 10 at once; its fourth waits');
  const building = (n) => Array.from({ length: n }, (_, i) => slot('build', 10, `u${90 + i}`));
  assert.deepEqual(rules.pickLiveBuilds(rows, { inUse: building(2), slots: 9, perPerson: 2 }).map((p) => p.id), [900, 904, 905],
    'each build already under way counts against its project');
  assert.deepEqual(rules.pickLiveBuilds(rows, { inUse: building(3), slots: 9, perPerson: 2 }).map((p) => p.id), [904, 905],
    'a project with three under way starts no fourth');
  assert.deepEqual(rules.pickLiveBuilds(rows, { inUse: [slot('read', 10, 'u90')], slots: 9, perPerson: 2 }).map((p) => p.id), [900, 901, 902, 904, 905],
    'a read on the project is not one of its builds');
  assert.deepEqual(rules.pickLiveBuilds(rows, { slots: 9, perPerson: 2, perProject: 1 }).map((p) => p.id), [900, 904, 905],
    'perProject is the limit it reads');
  assert.deepEqual(rules.pickLiveBuilds(rows, { inUse: [slot('read', 50, 'u7'), slot('read', 51, 'u7')], slots: 9, perPerson: 2 }).map((p) => p.id),
    [901, 902, 903, 904], 'what runs for a person counts, reading or building: #1 waits, so #6 is project 10\'s third');
  assert.deepEqual(rules.pickLiveBuilds(rows, { slots: 9, perPerson: 1 }).map((p) => p.id), [900, 901, 902],
    'and perPerson still holds across projects');
  assert.deepEqual(rules.pickLiveBuilds(rows, { slots: 1, perPerson: 2 }).map((p) => p.id), [900]);
});

test('the lane\'s build candidates are requests whose build waits for a slot, not held, not on a paused app, oldest first', () => {
  const s = rules.BUILD_CANDIDATES_SQL;
  assert.match(s, /WHERE w\.machine = 'bot-request' AND w\.state = 'building' AND w\.data->'build'->>'phase' = 'waiting'/);
  assert.match(s, /AND \(w\.data->'build'->>'heldUntil' IS NULL OR \(w\.data->'build'->>'heldUntil'\)::timestamptz <= NOW\(\)\)/,
    'a build held for its payer\'s week takes no slot until the week resets');
  assert.match(s, /AND NOT \(a\.slug = ANY\(\$1::text\[\]\)\)/);
  assert.match(s, /AND NOT EXISTS \(SELECT 1 FROM wf_events g\s+WHERE g\.machine = 'bot-request' AND g\.key = w\.key\s+AND g\.type = 'Granted'/,
    'one ready run, one build: a grant on its way is never granted twice');
  assert.match(s, /ORDER BY w\.data->'build'->>'since', w\.key/);
});

test('a waiting build whose request the bot already proposed is not built (Plant Pal #1, #3)', async () => {
  const log = [];
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      log.push({ s, params });
      if (/FROM chat_sessions/.test(s) && /AND \(status IN \('promoted', 'merging'\) OR \(status = 'merged' AND merged_at >= \$4::timestamptz\)\)/.test(s)) {
        return { rows: [{ id: 6190 }] };
      }
      return { rows: [] };
    },
  };
  const github = { isEnabled: () => true, async fetchPublicIssue() { return { issue: { number: 1, state: 'open' } }; } };
  const run = { id: 777, issue_number: 1, build_note: 'build it', created_at: '2026-10-03T16:55:03Z' };
  const app = { id: 2034, slug: 'plant-pal-1ad9b5', repo_url: 'https://github.com/usernode-bot/plant-pal-1ad9b5' };
  const out = await bot.buildOne(pool, {}, { bot: { id: 330 }, app, run, settings: {}, deps: { github } });
  assert.deepEqual(out, { ran: false, reason: 'has_proposal' });
  const looked = log.find((l) => /FROM chat_sessions/.test(l.s));
  assert.deepEqual(looked.params, [2034, 330, 1, '2026-10-03T16:55:03Z'], 'the bot\'s own, on this request, since this verdict');
  assert.match(looked.s, /user_id = \$2 AND \$3 = ANY\(linked_issues\) AND is_headless = FALSE/);
  const skipped = log.find((l) => /SET live_build_waiting_at = NULL, build_ok = FALSE, build_error = \$2/.test(l.s));
  assert.deepEqual(skipped.params, [777, 'skipped: the request already has a proposal (6190)'],
    'recorded as skipped, which the cards and the tray read as stopped');
  assert.ok(!log.some((l) => /build_session_id = \$2/.test(l.s)), 'and nothing was built');

  // Unread, it is not built either: it keeps waiting for the next pass.
  const failing = {
    async query(sql) {
      if (/FROM chat_sessions/.test(String(sql))) throw new Error('connection lost');
      log.push({ s: String(sql) });
      return { rows: [] };
    },
  };
  log.length = 0;
  assert.deepEqual(await bot.buildOne(failing, {}, { bot: { id: 330 }, app, run, settings: {}, deps: { github } }),
    { ran: false, reason: 'infra', detail: 'proposal_unreadable' });
  assert.ok(!log.some((l) => /live_build_waiting_at = NULL/.test(l.s)), 'still waiting');
});

test('a waiting build is not built while another build of its request is under way', async () => {
  const log = [];
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      log.push({ s, params });
      // Another run's build of the request, its session open (requestBuilding).
      if (/JOIN chat_sessions bs ON bs\.id = b\.build_session_id/.test(s)) return { rows: [{ id: 7450 }] };
      return { rows: [] };
    },
  };
  const github = { isEnabled: () => true, async fetchPublicIssue() { return { issue: { number: 31, state: 'open' } }; } };
  const run = { id: 1268, issue_number: 31, build_note: 'build it', created_at: '2026-10-09T17:20:00Z' };
  const app = { id: 3120, slug: 'homestead', repo_url: 'https://github.com/usernode-bot/homestead' };
  const out = await bot.buildOne(pool, {}, { bot: { id: 330 }, app, run, settings: {}, deps: { github } });
  assert.deepEqual(out, { ran: false, reason: 'being_built' });
  const looked = log.find((l) => /JOIN chat_sessions bs ON bs\.id = b\.build_session_id/.test(l.s));
  assert.deepEqual(looked.params.slice(0, 3), [3120, 31, 1268], 'another run of this request, not this one');
  assert.equal(looked.params[4], null, 'one under way at all: this one has not started');
  assert.match(looked.s, /bs\.status IN \('active', 'paused'\)/, 'open: active in a turn, paused between them');
  assert.match(looked.s, /b\.build_ok IS NULL AND b\.proposal_session_id IS NULL/, 'its outcome not in yet');
  const skipped = log.find((l) => /SET live_build_waiting_at = NULL, build_ok = FALSE, build_error = \$2/.test(l.s));
  assert.deepEqual(skipped.params, [1268, 'skipped: the request is already being built (7450)'], 'a skip, read as stopped');
  assert.ok(!log.some((l) => /build_session_id = \$2/.test(l.s)), 'and nothing was built');
});


test('a ready verdict waits on its run, and its request owes the build', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/services/homeroom-bot.js'), 'utf8');
  const act = src.slice(src.indexOf('async function actOnVerdict('), src.indexOf('async function queueLiveBuild('));
  assert.match(act, /await queueLiveBuild\(pool, \{ runId, appId: app\.id \}\);\n\s+acted = 'build_queued';/);
  assert.doesNotMatch(act, /buildAndPropose/, 'never built inside the turn that read it');
  // Inside a look, its end says the build is owed (the look's own result);
  // anywhere else its request hears it now (bot-request BuildOwed).
  const queue = src.slice(src.indexOf('async function queueLiveBuild('), src.indexOf('// ── B6: a first version\'s plan, before it is built'));
  assert.match(queue, /if \(look\) \{ look\.out\.build = Number\(runId\); return; \}\n\s+await platform\(\)\.botBuildOwed\(/);
  // A newer verdict on the issue replaces a build still waiting.
  assert.match(src, /SET live_build_waiting_at = NULL, build_error = 'superseded: a later verdict on the same issue'/);
  // Once its session exists, the run is its build's, and no longer waits.
  assert.match(src, /SET build_session_id = \$2, live_build_waiting_at = NULL\s+WHERE id = \$1/);
});

test('Run now never starts a second turn on a request already being worked on', async () => {
  const appended = [];
  const asked = [];
  const pool = { async query(sql, params) {
    const s = String(sql);
    asked.push(s);
    if (/SELECT id, slug FROM apps WHERE slug = \$1/.test(s)) return { rows: [{ id: 101, slug: 'a1' }] };
    if (/INSERT INTO wf_events/.test(s)) { appended.push(params); return { rows: [{ id: appended.length }] }; }
    return { rows: [] };
  } };
  const out = await bot.enqueueNow(pool, { slug: 'a1', issueNumber: 5, actorId: 1 });
  assert.deepEqual(out, { ok: true, item: { app_id: 101, issue_number: 5, priority: 0, reason: 'admin' } });
  assert.deepEqual(appended.map((p) => [p[0], p[1], p[3], JSON.parse(p[4]).reason, JSON.parse(p[4]).priority, JSON.parse(p[4]).requestedBy]),
    [['bot-request', rules.requestKey(101, 5), 'Owed', 'admin', 0, 1]], 'its request is owed a look, first in line');
  assert.ok(!asked.some((s) => /homeroom_bot_queue/.test(s)), 'the queue row is its machine\'s projection, never written here');

  // A look already under way is left to finish: the debt waits for after it,
  // and no second look starts beside it.
  const machine = request.botRequest({ staging: false });
  const now = new Date('2026-10-17T12:00:00Z');
  const owed = { reason: 'new', priority: 1, payer: null, requestedBy: null, changedBy: null, threadSeenAt: null, enqueuedAt: now.toISOString(), heldUntil: null };
  const reading = {
    name: 'reading',
    data: {
      appId: 101, issueNumber: 5, owed: null, build: null, n: 1, backoff: null, fix: null, spentRetry: null,
      lastRead: null, carried: null, older: null, slot: { grant: 1, kind: 'read', person: 'u7', appId: 101 },
      look: { n: 1, kind: 'read', sessionId: 9, owed, startedAt: now.toISOString(), interrupted: false },
    },
  };
  const payload = machine.events.get('Owed')({ appId: 101, issueNumber: 5, reason: 'admin', priority: 0, requestedBy: 1 });
  const event = { id: 1, type: 'Owed', payload, source: { kind: 'admin' }, actor: null, requestKey: 'run-now', appId: 101, causedBy: null };
  const ctx = { machine: request.MACHINE, key: rules.requestKey(101, 5), appId: 101, version: 3, now };
  const r = machine.entryFor('reading', 'Owed').to(reading, event, {}, ctx);
  assert.equal(r.next.name, 'reading', 'the look under way goes on');
  assert.equal(r.next.data.look.n, 1);
  assert.equal(r.next.data.owed.reason, 'admin', 'and the Run now is looked at after it');
  assert.ok(!(r.work || []).length, 'no second turn');

  const route = require('node:fs').readFileSync(require.resolve('../src/routes/admin.js'), 'utf8');
  assert.match(route, /res\.status\(202\)\.json\(\{ item: result\.item, \.\.\.\(result\.running \? \{ running: true \} : \{\}\) \}\);/);
});

/** A pool that answers a build's start (startBuild), its run waiting. */
function buildPool({ settings = [{ key: bot.KEY_MODE, value: 'shadow' }], run }) {
  const log = [];
  return {
    log,
    async query(sql, params) {
      const s = String(sql);
      log.push({ s, params });
      if (/SELECT key, value FROM platform_settings/.test(s)) return { rows: settings };
      if (/FROM users WHERE username = \$1/.test(s)) return { rows: [{ id: 77, username: 'homeroom_bot', weekly_limit_cents: 15000 }] };
      if (/SELECT is_synthetic FROM users/.test(s)) return { rows: [{ is_synthetic: true }] };
      if (/FROM apps WHERE id = \$1/.test(s)) return { rows: APPS.filter((a) => a.id === Number(params[0])) };
      if (/SELECT \* FROM homeroom_bot_runs WHERE id = \$1/.test(s)) return { rows: run && run.id === Number(params[0]) ? [run] : [] };
      return { rows: [] };
    },
  };
}
const waitingRun = (id, appId, issueNumber) => ({
  id, app_id: appId, issue_number: issueNumber, mode: 'live', verdict: 'ready', build_note: 'build it',
  build_ok: null, build_session_id: null, proposal_session_id: null, live_build_waiting_at: new Date().toISOString(),
});

test('a spent weekly budget holds a build waiting its turn too, and its person hears it once', async () => {
  // Before, the budget was checked before a read only, so a build started
  // on a spent budget.
  const pool = buildPool({ run: waitingRun(900, 101, 1) });
  const told = [];
  const out = await bot.startBuild({}, pool, {
    // Who the build is for: the lane's person key, as its grant names it.
    appId: 101, issueNumber: 1, runId: 900, replyTo: { machine: 'bot-request', key: rules.requestKey(101, 1) }, person: 'u7',
    deps: {
      limits: { async checkBudget() { return { error: 'Weekly limit reached', reason: 'weekly_limit' }; } },
      dm: {
        async overWeeklyAllowance() { return false; },
        async requesterOf() { return { userId: 7 }; },
        async notePausedForWeek(_pool, { userId }) { told.push(userId); return { messageId: 1 }; },
      },
    },
  });
  assert.deepEqual(out, { outcome: 'budget' }, 'its request waits for its slot again, and the lane pauses');
  assert.ok(!pool.log.some((l) => /build_session_id = \$2|INSERT INTO chat_sessions/.test(l.s)), 'no build starts');
  assert.deepEqual(told, [7], 'the person whose build was next is told (the DM keeps it to once a week)');
});

test('a budget that runs out for another reason holds the build without telling anybody it is for the week', async () => {
  const pool = buildPool({ run: waitingRun(900, 101, 1) });
  const told = [];
  const out = await bot.startBuild({}, pool, {
    appId: 101, issueNumber: 1, runId: 900, replyTo: null,
    deps: {
      limits: { async checkBudget() { return { error: 'Global daily limit reached', reason: 'global_limit' }; } },
      dm: {
        async overWeeklyAllowance() { return false; },
        async requesterOf() { return { userId: 7 }; },
        async notePausedForWeek(_p, { userId }) { told.push(userId); },
      },
    },
  });
  assert.deepEqual(out, { outcome: 'budget' });
  assert.deepEqual(told, []);
});

// bot.build is not resumable: an attempt cut off after it asked bot-build
// for the build, before it said so, is followed by one that finds the run
// no longer waiting. It reports the build under way, so its request keeps
// its slot and hears the build's end.
test('a build an earlier attempt already asked for is reported under way, not skipped', async () => {
  const started = { ...waitingRun(900, 101, 1), build_session_id: 4100, live_build_waiting_at: null };
  const deps = { platform: { async buildsUnderWay(target) { assert.equal(target, 'live'); return [{ key: 'run:900@abc', id: 900 }]; } } };
  assert.deepEqual(await bot.startBuild({}, buildPool({ run: started }), { appId: 101, issueNumber: 1, runId: 900, replyTo: null, deps }),
    { outcome: 'requested', key: 'run:900@abc' });
});

test('a build whose run no longer waits starts nothing', async () => {
  const built = { ...waitingRun(900, 101, 1), build_session_id: 4100, live_build_waiting_at: null };
  assert.deepEqual(await bot.startBuild({}, buildPool({ run: built }), { appId: 101, issueNumber: 1, runId: 900, replyTo: null }),
    { outcome: 'skipped', why: 'not_waiting' }, 'built already, or replaced by a newer verdict');
  assert.deepEqual(await bot.startBuild({}, buildPool({ run: waitingRun(900, 101, 1) }), { appId: 101, issueNumber: 2, runId: 900, replyTo: null }),
    { outcome: 'skipped', why: 'gone' }, 'a run of another request');
  assert.deepEqual(await bot.startBuild({}, buildPool({ settings: [{ key: bot.KEY_MODE, value: 'off' }], run: waitingRun(900, 101, 1) }),
    { appId: 101, issueNumber: 1, runId: 900, replyTo: null }), { outcome: 'skipped', why: 'off' });
});
