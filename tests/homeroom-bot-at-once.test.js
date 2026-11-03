'use strict';

// #3624 stage 2: how much the Homeroom bot works on at once.
//
// Live work (every app but a paused one) is started one request at a time:
// at most `readsPerApp` reads on one app, each on a read slot of its own
// (a triage session no other read uses while it runs; it was one read per
// app, behind one session, until 3 Nov 2026), a follow-up on the bot's own
// proposal beside them (#3703, below), at most `perPerson` for one person,
// at most `liveAtOnce` in all. The lane (bot-lane) grants
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

// ── 3 Nov 2026: several reads on one project at once ─────────────────────
//
// On Homeroom's own board every new request waited behind the one being
// read ("Homeroom is reading request #6070 first, one read per project at a
// time"); one once had 35 requests ahead of it. A read only reads the code
// and costs a few cents. Each read now runs on a READ SLOT of its project,
// one of its triage sessions (homeroom-bot.js ensureBotSession), up to
// `readsPerApp` at once, and the lane never grants a slot another read holds.

const readSlot = (appId, person, k) => ({ kind: 'read', appId, person, readSlot: k, legacy: false });

test('pickLive: up to readsPerApp reads on one project at once, each on a read slot of its own, the oldest first', () => {
  const four = [row(1, 10, 7), row(2, 10, 8), row(3, 10, 9), row(4, 10, 6)];
  let picks = rules.pickLive(four, { slots: 9, perPerson: 3, readsPerApp: 3 });
  assert.deepEqual(picks.map((p) => [p.id, p.readSlot]), [[1, 0], [2, 1], [3, 2]], 'three at once; the fourth waits');
  // One at a time when the setting is 1, as it always was.
  picks = rules.pickLive(four, { slots: 9, perPerson: 3, readsPerApp: 1 });
  assert.deepEqual(picks.map((p) => [p.id, p.readSlot]), [[1, 0]]);
  assert.deepEqual(rules.pickLive(four, { slots: 9, perPerson: 3 }).map((p) => p.id), [1], 'and one when it is not passed');
  // The slots already taken are never granted again: the free ones are, lowest first.
  picks = rules.pickLive(four, { inUse: [readSlot(10, 'u90', 1)], slots: 9, perPerson: 3, readsPerApp: 3 });
  assert.deepEqual(picks.map((p) => [p.id, p.readSlot]), [[1, 0], [2, 2]]);
  assert.deepEqual(rules.pickLive(four, { inUse: [0, 1, 2].map((k) => readSlot(10, `u9${k}`, k)), slots: 9, perPerson: 3, readsPerApp: 3 }), [],
    'a project reading three starts no fourth');
  // Lowered below what runs: nothing more starts until enough end, then on
  // the lowest slot free.
  assert.deepEqual(rules.pickLive(four, { inUse: [readSlot(10, 'u90', 0), readSlot(10, 'u91', 2)], slots: 9, perPerson: 3, readsPerApp: 2 }), []);
  assert.deepEqual(rules.pickLive(four, { inUse: [readSlot(10, 'u90', 2)], slots: 9, perPerson: 3, readsPerApp: 1 }), []);
  assert.deepEqual(rules.pickLive(four, { inUse: [readSlot(10, 'u90', 2)], slots: 9, perPerson: 3, readsPerApp: 2 })
    .map((p) => [p.id, p.readSlot]), [[1, 0]]);
  // Each project counts its own; liveAtOnce (`slots`) and perPerson still hold across them.
  const two = [row(1, 10, 7), row(2, 10, 7), row(3, 11, 7), row(4, 10, 8)];
  assert.deepEqual(rules.pickLive(two, { slots: 9, perPerson: 2, readsPerApp: 3 }).map((p) => [p.id, p.readSlot]), [[1, 0], [2, 1], [4, 2]],
    'person 7 at two: #3 on project 11 waits, and #4 takes project 10\'s third slot');
  assert.deepEqual(rules.pickLive(four, { slots: 2, perPerson: 3, readsPerApp: 3 }).map((p) => p.id), [1, 2]);
  // A follow-up runs on its proposal's session: no read slot, and it takes none.
  picks = rules.pickLive([followUp(5, 10, 7), ...four], { inUse: [0, 1, 2].map((k) => readSlot(10, `u9${k}`, k)), slots: 9, perPerson: 3, readsPerApp: 3 });
  assert.deepEqual(picks.map((p) => [p.id, p.followUp, p.readSlot]), [[5, true, null]]);
  assert.equal(rules.MAX_READS_PER_APP, 6);
  assert.equal(rules.LANE_DEFAULTS.readsPerApp, 3);
});

test('pickLive: a read an older release may be running holds its whole project, and one it may run is granted only on an idle one', () => {
  // An older release runs every read on its project's newest triage
  // session, whatever its grant names, so such a read takes all the slots.
  const four = [row(1, 10, 7), row(2, 10, 8), row(3, 11, 9)];
  const legacy = { kind: 'read', appId: 10, person: 'u90', readSlot: null, legacy: true };
  assert.deepEqual(rules.pickLive(four, { inUse: [legacy], slots: 9, perPerson: 3, readsPerApp: 3 }).map((p) => p.id), [3]);
  // How the lane reads a slot: a read with no slot, or one whose request an
  // older version last wrote, is legacy; one this version wrote is not.
  assert.deepEqual(rules.slotOfRow({ app_id: 10, machine_version: 2, slot: { kind: 'read', appId: 10, person: 'u7', readSlot: 1 } }),
    { kind: 'read', appId: 10, person: 'u7', readSlot: 1, legacy: false });
  assert.equal(rules.slotOfRow({ app_id: 10, machine_version: 2, slot: { kind: 'read', appId: 10, person: 'u7' } }).legacy, true, 'no slot: an older grant');
  assert.equal(rules.slotOfRow({ app_id: 10, machine_version: 1, slot: { kind: 'read', appId: 10, person: 'u7', readSlot: 1 } }).legacy, true,
    'written by an older version: its grant may have been applied there');
  assert.equal(rules.slotOfRow({ app_id: 10, machine_version: null, slot: { kind: 'read', appId: 10, person: 'u7', readSlot: 0 } }).legacy, true);
  assert.deepEqual(rules.slotOfRow({ app_id: 10, machine_version: 1, slot: { kind: 'build', appId: 10, person: 'u7' } }),
    { kind: 'build', appId: 10, person: 'u7' }, 'a build holds no read slot');
  // A candidate an older version last wrote may be run by an older release:
  // granted only while nothing reads its project, and then it holds it.
  const old = (id, appId, personId) => row(id, appId, personId, { machine_version: 1 });
  assert.deepEqual(rules.pickLive([old(1, 10, 7), row(2, 10, 8)], { slots: 9, perPerson: 3, readsPerApp: 3 }).map((p) => [p.id, p.readSlot]), [[1, 0]]);
  assert.deepEqual(rules.pickLive([row(2, 10, 8), old(1, 10, 7)], { slots: 9, perPerson: 3, readsPerApp: 3 }).map((p) => p.id), [2],
    'with a read on its project, it waits');
  assert.deepEqual(rules.pickLive([old(1, 10, 7)], { inUse: [readSlot(10, 'u90', 2)], slots: 9, perPerson: 3, readsPerApp: 3 }), []);
  // What the queue says of a project with no read slot free.
  assert.deepEqual([...rules.projectsFullOfReads([readSlot(10, 'u1', 0), readSlot(10, 'u2', 1), readSlot(11, 'u3', 0), legacy], 2)].sort(), [10]);
  assert.deepEqual([...rules.projectsFullOfReads([readSlot(12, 'u1', 0), { ...legacy, appId: 13 }, { kind: 'build', appId: 14, person: 'u1' }], 3)].sort(), [13]);
  assert.equal(rules.READ_SLOTS_SINCE, 2);
});

test('the lane grants each read its read slot, and the triage session only with slot 0', () => {
  const lane = require('../src/workflow/bot-lane/machine.ts');
  const m = lane.botLane({ staging: false });
  const now = new Date('2026-11-03T12:00:00Z');
  const data = { grants: 0, fault: null, budget: null, refresh: { due: '2026-11-03T13:00:00.000Z', asked: [], soon: null, n: 1, running: null } };
  const read = (n, personId) => ({ app_id: 10, issue_number: n, priority: 1, reason: 'new', person_id: personId, follow_up_session_id: null, triage_session_id: 500, machine_version: 2 });
  const facts = (readsPerApp) => ({
    settings: { mode: 'live', pausedApps: [], liveAtOnce: 12, perPerson: 3, readsPerApp }, acting: true, inUse: [],
    reads: [read(1, 7), read(2, 8), read(3, 9), read(4, 6)], builds: [], nextEligible: null, raised: {},
  });
  const look = (f) => m.entryFor('open', 'Look').to({ name: 'open', data }, { id: 1, type: 'Look', payload: {}, source: { kind: 'system' } }, f,
    { machine: lane.MACHINE, key: lane.KEY, appId: null, version: 1, now });
  const grants = (out) => out.messages.map((g) => [g.event.payload.issueNumber, g.event.payload.readSlot, g.event.payload.sessionId]);
  assert.deepEqual(grants(look(facts(3))), [[1, 0, 500], [2, 1, null], [3, 2, null]],
    'three at once; slot 0 on the project\'s triage session, the others on sessions their looks find or make');
  assert.deepEqual(grants(look(facts(1))), [[1, 0, 500]], 'one at a time at 1');
  const src = require('node:fs').readFileSync(require.resolve('../src/workflow/bot-lane/machine.ts'), 'utf8');
  assert.match(src, /readsPerApp: f\.settings\.readsPerApp,/, 'the setting the lane reads');
  assert.ok(rules.LANE_SETTING_KEYS.includes(rules.KEY_READS_PER_APP));
  assert.equal(rules.laneSettings([{ key: rules.KEY_READS_PER_APP, value: '9' }]).readsPerApp, 6, 'clamped to its ceiling');
  assert.equal(rules.laneSettings([{ key: rules.KEY_READS_PER_APP, value: '0' }]).readsPerApp, 1, 'and its floor');
  assert.equal(rules.laneSettings([]).readsPerApp, 3);
  assert.equal(rules.KEY_READS_PER_APP, bot.KEY_READS_PER_APP, 'the module that does the reads names the same');
  assert.equal(bot.MAX_READS_PER_APP, rules.MAX_READS_PER_APP);
});

test('a read\'s request keeps the read slot its grant names and hands it to its look; an older release leaves its requests alone', () => {
  const machine = request.botRequest({ staging: false });
  assert.ok(machine.version >= rules.READ_SLOTS_SINCE, 'a request this version writes runs its reads on their slots');
  const now = new Date('2026-11-03T12:00:00Z');
  const owed = { reason: 'new', priority: 1, payer: null, requestedBy: null, changedBy: null, threadSeenAt: null, enqueuedAt: now.toISOString(), heldUntil: null };
  const data = { appId: 10, issueNumber: 3, owed, look: null, build: null, slot: null, n: 0, backoff: null, fix: null, spentRetry: null, lastRead: null, carried: null };
  const ctx = { machine: request.MACHINE, key: rules.requestKey(10, 3), appId: 10, version: 2, now };
  const fromLane = { kind: 'message', from: { machine: rules.BOT_LANE, key: rules.LANE_KEY, eventId: 1 } };
  const grant = (p) => machine.entryFor('queued', 'Granted').to({ name: 'queued', data },
    { id: 1, type: 'Granted', payload: machine.events.get('Granted')({ appId: 10, issueNumber: 3, grant: 4, kind: 'read', sessionId: null, person: 'u7', ...p }),
      source: fromLane, actor: null, requestKey: 'g', appId: 10, causedBy: null }, {}, ctx);
  let out = grant({ readSlot: 2 });
  assert.equal(out.next.name, 'reading');
  assert.equal(out.next.data.slot.readSlot, 2);
  assert.equal(out.work[0].input.readSlot, 2, 'its look reads on slot 2\'s session');
  out = grant({});
  assert.equal(out.next.data.slot.readSlot, undefined, 'an older lane\'s grant names none');
  assert.equal(out.work[0].input.readSlot, null);
  assert.equal(grant({ readSlot: 6 }).work[0].input.readSlot, null, 'past the ceiling is none');
  assert.equal(grant({ readSlot: -1 }).work[0].input.readSlot, null);
});

test('each read slot is a session of its own: slot 0 the triage session as it was, a further one marked with its slot from its insert', async () => {
  const asked = [];
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      asked.push({ s, params });
      if (/INSERT INTO chat_sessions/.test(s)) return { rows: [{ id: 9100 + asked.length, branch_name: 'main', status: 'paused', source: params[5] }] };
      return { rows: [] };
    },
  };
  const app = { id: 10, slug: 'homeroom', name: 'Homeroom', repo_url: 'https://github.com/o/homeroom', self_hosted: true };
  const s2 = await bot.ensureBotSession(pool, { openrouterDefaultCodexModel: 'z-ai/glm-5.3-flash' }, { id: 77 }, app, { slot: 2 });
  const find = asked.find((q) => /FROM chat_sessions cs/.test(q.s));
  assert.deepEqual(find.params, [77, 10, 'homeroom_bot_read:2'], 'slot 2\'s own session, found by its mark');
  assert.match(find.s, /cs\.source = \$3\s+AND cs\.status IN \('active', 'paused'\) AND cs\.branch_name = 'main'/);
  const made = asked.find((q) => /INSERT INTO chat_sessions/.test(q.s));
  assert.equal(made.params[5], 'homeroom_bot_read:2', 'marked in the statement that makes it, so slot 0 never reads it as its own');
  assert.equal(made.params[2], 'Homeroom bot triage 3');
  assert.equal(s2.app_slug, 'homeroom');
  assert.equal(rules.readSessionSource(2), 'homeroom_bot_read:2');

  asked.length = 0;
  await bot.ensureBotSession(pool, {}, { id: 77 }, app);
  const zero = asked.find((q) => /FROM chat_sessions cs/.test(q.s));
  assert.deepEqual(zero.params, [77, 10]);
  assert.ok(zero.s.includes(`AND (cs.source IS NULL OR cs.source NOT LIKE '${rules.READ_SESSION_SOURCE}:%')`), 'slot 0 leaves every other slot\'s out');
  assert.match(zero.s, /AND NOT EXISTS \(SELECT 1 FROM homeroom_bot_look_sessions l WHERE l\.session_id = cs\.id\)/);
  const plain = asked.find((q) => /INSERT INTO chat_sessions/.test(q.s));
  assert.equal(plain.params[5], null, 'slot 0\'s is made as it always was, with no mark');
  assert.equal(plain.params[2], 'Homeroom bot triage');
  // The lane's slot 0 session is the same rule's.
  assert.ok(rules.READ_CANDIDATES_SQL.includes(`AND (cs.source IS NULL OR cs.source NOT LIKE '${rules.READ_SESSION_SOURCE}:%')`));
  // A slot nobody could hold is slot 0.
  asked.length = 0;
  await bot.ensureBotSession(pool, {}, { id: 77 }, app, { slot: 9 });
  assert.deepEqual(asked.find((q) => /FROM chat_sessions cs/.test(q.s)).params, [77, 10]);
});

test('a look reads on its read slot\'s session (lookAt: the grant\'s readSlot, a follow-up none)', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/services/homeroom-bot.js'), 'utf8');
  const look = src.slice(src.indexOf('async function lookAt('), src.indexOf('// What the machine decides from, out of what the look returned and did.'));
  assert.match(look, /readSlot: input\.kind === 'followUp' \? null : loopRules\.readSlotOf\(input\.readSlot\),/);
  assert.match(src, /session = await ensureBotSession\(pool, config, bot, app, \{ slot: item\.readSlot \?\? 0 \}\);/);
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
