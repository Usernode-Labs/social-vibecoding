'use strict';

// A maintenance campaign changes its next app only when there is room for it
// (src/workflow/campaign/machine.ts holdFor).
//
// Its proposals skip the promoted caps and the start gate. On 19 Oct 2026 the
// MIT LICENSE campaign opened one every 20 seconds across 129 apps, took the
// platform from 131 to past 175 of its 140 sessions (every start and resume
// refused, a native proposal start included) and the apps namespace to the
// edge of its pod quota with their previews. Pinned here, through the
// machine's transition table with no database:
//
//   1. The rule: below the session limit's warning line, and fewer of its own
//      proposals up for a vote than it keeps open at once.
//   2. Holding: no change is started, the thread is told once, and the check
//      looks again; with room again the next app is changed.
//   3. The facts: the admin's session limit wins over the deploy's, and the
//      hold reaches the campaign page.
//
// Run with: node --test tests/campaign-room.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const machineMod = require('../src/workflow/campaign/machine.ts');
const { campaign, holdFor, campaignKey, CHECK_MS, SAY_AGAIN_MS, DEFAULT_DEPS } = machineMod;

const DEPS = { sessionLimit: 140, roomPercent: 80, maxOpen: 10 };
const T0 = Date.parse('2026-10-19T11:14:00.000Z');
const ctxAt = (ms) => ({ now: new Date(T0 + ms), key: campaignKey(3) });

const app = (appId, state, extra = {}) => ({
  appId, slug: `app-${appId}`, state, n: state === 'waiting' ? 0 : 1, sessionId: null, prNumber: null,
  error: null, resumable: false, ...extra,
});

function running(apps, more = {}) {
  return {
    name: 'running',
    data: {
      campaignId: 3, issueId: 1769, threadAppId: 1, title: 'Add an MIT LICENSE to every existing app (#5120)',
      proposerId: 9, apps, exemplar: null, drained: null, stopped: null, ...more,
    },
  };
}

const facts = (room) => ({ campaign: { id: 3, status: 'running' }, apps: [], green: [], asked: [], appAlive: true, room });

// One app was put up for a vote (ProposalOpened): what the campaign does next.
function afterOpened(room, { deps = DEPS, data = {}, at = 0 } = {}) {
  const m = campaign(deps);
  const s = running([app(1, 'proposing'), app(2, 'waiting'), app(3, 'waiting')], data);
  const e = { id: 1, type: 'ProposalOpened', payload: { appId: 1, sessionId: 501, prNumber: 77 }, source: { kind: 'message', from: { machine: 'proposal' } } };
  const entry = m.entryFor('running', 'ProposalOpened');
  assert.equal(entry.guard(s, e, facts(room), ctxAt(at)), true);
  return entry.to(s, e, facts(room), ctxAt(at));
}

const changes = (out) => (out.work || []).filter((w) => w.kind === 'campaign.change');
const lines = (out) => (out.writes || []).filter((w) => w.type === 'line');

// ─── 1. The rule ────────────────────────────────────────────────────────

test('a campaign waits at the session limit\'s warning line, and at its own window of open proposals', () => {
  // 140 × 80% = 112.
  assert.equal(holdFor({ used: 111, limit: 140, open: 9 }, DEPS), null);
  assert.deepEqual(holdFor({ used: 112, limit: 140, open: 3 }, DEPS),
    { reason: 'platform', used: 112, limit: 140, ceiling: 112, open: 3, maxOpen: 10 });
  assert.equal(holdFor({ used: 50, limit: 140, open: 10 }, DEPS).reason, 'window');
  // The platform's hold is named first: it is the one that blocks people.
  assert.equal(holdFor({ used: 175, limit: 140, open: 47 }, DEPS).reason, 'platform');
  // An admin's raised limit makes room.
  assert.equal(holdFor({ used: 131, limit: 180, open: 3 }, DEPS), null);
  // No facts (a drain, a stop): nothing is held.
  assert.equal(holdFor(null, DEPS), null);
  assert.deepEqual({ ...DEFAULT_DEPS }, { sessionLimit: 100, roomPercent: 80, maxOpen: 10 });
});

// ─── 2. Holding and going on ────────────────────────────────────────────

test('with room the next app is changed, as before', () => {
  const out = afterOpened({ used: 100, limit: 140, open: 1 });
  assert.equal(changes(out).length, 1);
  assert.equal(changes(out)[0].input.appId, 2);
  assert.equal(out.next.data.held ?? null, null);
});

test('at the line no change is started: the hold is recorded, the thread told, and the check set', () => {
  const out = afterOpened({ used: 175, limit: 140, open: 47 });
  assert.equal(out.next.name, 'running');
  assert.equal(changes(out).length, 0, 'nothing more is opened while the platform is full');
  assert.equal(out.next.data.apps.find((a) => a.appId === 2).state, 'waiting');
  assert.equal(out.next.data.held.reason, 'platform');
  assert.equal(out.next.data.held.since, ctxAt(0).now.toISOString());
  const said = lines(out);
  assert.equal(said.length, 1);
  assert.match(said[0].content, /is waiting for room: 175 of 140 sessions are in use, and it changes its next app only below 112\./);
  assert.equal(said[0].issueId, 1769, 'in the thread of the decision that voted it');
  assert.equal(out.timer, undefined, 'the check armed while app 1 went up stays armed');

  // Nothing armed before (the app under way was skipped): the hold arms it.
  const m = campaign(DEPS);
  const s = running([app(2, 'changing'), app(3, 'waiting')]);
  const e = { id: 4, type: 'WorkSucceeded', source: { kind: 'service', workId: 1 },
    payload: { kind: 'campaign.change', workKey: 'app:2:1', workId: 1, result: { skipped: true, reason: 'already has a licence file: LICENSE' } } };
  const entry = m.entryFor('running', 'WorkSucceeded');
  assert.equal(entry.guard(s, e, facts({ used: 175, limit: 140, open: 47 }), ctxAt(0)), true);
  const skipped = entry.to(s, e, facts({ used: 175, limit: 140, open: 47 }), ctxAt(0));
  assert.equal(changes(skipped).length, 0);
  assert.equal(skipped.next.data.held.reason, 'platform');
  assert.deepEqual(skipped.timer, { at: new Date(T0 + CHECK_MS), event: { type: 'Check' } });
});

test('a hold that goes on is not said again within hours, but a different one is', () => {
  const held = { reason: 'window', since: ctxAt(0).now.toISOString(), used: 50, limit: 140, ceiling: 112, open: 10, maxOpen: 10 };
  const said = { reason: 'window', at: ctxAt(0).now.toISOString() };
  const again = afterOpened({ used: 50, limit: 140, open: 10 }, { data: { held, said }, at: 60 * 60 * 1000 });
  assert.equal(lines(again).length, 0, 'the window filling again an hour on says nothing');
  assert.equal(again.next.data.held.since, held.since, 'the hold keeps when it began');
  const later = afterOpened({ used: 50, limit: 140, open: 10 }, { data: { held, said }, at: SAY_AGAIN_MS });
  assert.equal(lines(later).length, 1, 'said again after SAY_AGAIN_MS');
  const other = afterOpened({ used: 130, limit: 140, open: 10 }, { data: { held, said }, at: 60 * 60 * 1000 });
  assert.equal(lines(other).length, 1);
  assert.match(lines(other)[0].content, /waiting for room/);
});

test('the check finds room again: the next app is changed and the hold ends', () => {
  const m = campaign(DEPS);
  const held = { reason: 'platform', since: ctxAt(0).now.toISOString(), used: 175, limit: 140, ceiling: 112, open: 47, maxOpen: 10 };
  const s = running([app(1, 'proposed', { sessionId: 501 }), app(2, 'waiting')], { held, said: { reason: 'platform', at: held.since } });
  const e = { id: 2, type: 'Check', payload: {}, source: { kind: 'timer' } };
  const entry = m.entryFor('running', 'Check');
  const full = entry.to(s, e, facts({ used: 150, limit: 140, open: 9 }), ctxAt(CHECK_MS));
  assert.equal(changes(full).length, 0, 'still full: still waiting');
  assert.deepEqual(full.timer, { at: new Date(T0 + 2 * CHECK_MS), event: { type: 'Check' } }, 'and looks again');
  const room = entry.to(s, e, facts({ used: 100, limit: 140, open: 9 }), ctxAt(2 * CHECK_MS));
  assert.equal(changes(room).length, 1);
  assert.equal(room.next.data.held, null);
});

test('a stop ends the hold', () => {
  const m = campaign(DEPS);
  const held = { reason: 'window', since: ctxAt(0).now.toISOString(), used: 50, limit: 140, ceiling: 112, open: 10, maxOpen: 10 };
  const s = running([app(1, 'proposed', { sessionId: 501 }), app(2, 'waiting')], { held });
  const e = { id: 3, type: 'Stop', payload: { userId: 1, username: 'evan' }, source: { kind: 'route' } };
  const out = m.entryFor('running', 'Stop').to(s, e, facts(null), ctxAt(0));
  assert.equal(out.next.name, 'stopped');
  assert.equal(out.next.data.held, null);
  assert.equal(out.timer, null);
});

// ─── 3. The facts and the page ──────────────────────────────────────────

test('the room is the admin\'s session limit when one is set, else the deploy\'s', async () => {
  const { readFacts } = require('../src/workflow/campaign/facts.ts');
  const tx = (setting) => ({
    async query(sql) {
      if (/FROM maintenance_campaigns mc WHERE mc\.id = \$1 FOR UPDATE/.test(sql)) {
        return { rows: [{ id: 3, issue_id: 1769, title: 'T', status: 'running', target_filter: null, thread_app_id: 1 }] };
      }
      if (/platform_settings WHERE key = 'max_global_sessions'/.test(sql)) {
        assert.match(sql, /status IN \('active', 'promoted'\) AND source IS DISTINCT FROM 'imported'/, 'the start gate\'s own count');
        return { rows: [{ setting, used: 131, open: 4 }] };
      }
      return { rows: [] };
    },
  });
  const check = { id: 9, type: 'Check', payload: {}, source: { kind: 'timer' } };
  assert.deepEqual((await readFacts(tx('180'), 3, check, [], { deployLimit: 140 })).room, { used: 131, limit: 180, open: 4 });
  assert.deepEqual((await readFacts(tx(null), 3, check, [], { deployLimit: 140 })).room, { used: 131, limit: 140, open: 4 });
  assert.deepEqual((await readFacts(tx('0'), 3, check, [], { deployLimit: 140 })).room.limit, 140, 'an unusable setting is ignored');
  const stop = { id: 10, type: 'Stop', payload: {}, source: { kind: 'route' } };
  assert.equal((await readFacts(tx('180'), 3, stop, [], { deployLimit: 140 })).room, null);
});

test('the platform builds the campaign from the deploy\'s limit, the warning line and CAMPAIGN_MAX_OPEN', () => {
  const { campaignDeps } = require('../src/workflow/platform.ts');
  assert.deepEqual(campaignDeps({ maxGlobalSessions: 140, campaignMaxOpen: 10 }, {}),
    { sessionLimit: 140, roomPercent: 80, maxOpen: 10 });
  assert.deepEqual(campaignDeps({ maxGlobalSessions: 140, campaignMaxOpen: 25 }, { PLATFORM_LIMIT_WARN_PERCENT: '70' }),
    { sessionLimit: 140, roomPercent: 70, maxOpen: 25 });
  assert.deepEqual(campaignDeps({ campaignMaxOpen: 'x' }, { PLATFORM_LIMIT_WARN_PERCENT: '0' }),
    { sessionLimit: 100, roomPercent: 80, maxOpen: 10 });
  assert.match(read('src/workflow/platform.ts'), /const campaigns = campaign\(campaignDeps\(config\)\);/);
  assert.match(read('src/config.js'), /campaignMaxOpen: parseInt\(process\.env\.CAMPAIGN_MAX_OPEN \|\| '10', 10\),/);
  assert.match(JSON.stringify(JSON.parse(read('dapp.json'))), /"key":"CAMPAIGN_MAX_OPEN"/);
});

test('the campaign page says why it waits', async () => {
  const fleet = require('../src/services/fleet-maintenance');
  const held = { reason: 'platform', since: '2026-10-19T11:30:00.000Z', used: 175, limit: 140, ceiling: 112, open: 47, maxOpen: 10 };
  const pool = {
    async query(sql, params) {
      if (/SELECT \* FROM maintenance_campaigns WHERE id = \$1/.test(sql)) {
        return { rows: [{ id: 3, issue_id: 1769, title: 'T', instructions: 'i', status: 'running', created_at: 'x', completed_at: null }] };
      }
      if (/FROM wf_instances WHERE machine = 'campaign' AND key = \$1/.test(sql)) {
        assert.deepEqual(params, ['campaign:3']);
        return { rows: [{ held }] };
      }
      return { rows: [] };
    },
  };
  assert.deepEqual((await fleet.campaignStatus(pool, 3)).held, held);
  const page = read('frontend/src/features/admin/admin-campaigns.tsx');
  assert.match(page, /detail\.status === 'running' && detail\.held \?/);
  assert.match(page, /Waiting for room: \$\{detail\.held\.used\} of \$\{detail\.held\.limit\} sessions are in use/);
});

// ─── 4. Resume ──────────────────────────────────────────────────────────

test('a stopped campaign resumes with the apps the stop never reached, under the same room', () => {
  const m = campaign(DEPS);
  const stopped = {
    name: 'stopped',
    data: { ...running([app(1, 'proposed', { sessionId: 501 }), app(2, 'not_reached'), app(3, 'not_reached'), app(4, 'failed')]).data,
      stopped: { at: ctxAt(0).now.toISOString(), by: 'evan' } },
  };
  const e = { id: 5, type: 'Resume', payload: { userId: 1, username: 'evan' }, source: { kind: 'route' } };
  const entry = m.entryFor('stopped', 'Resume');
  assert.equal(entry.guard(stopped, e, facts({ used: 100, limit: 140, open: 1 }), ctxAt(0)), true);

  const go = entry.to(stopped, e, facts({ used: 100, limit: 140, open: 1 }), ctxAt(0));
  assert.equal(go.next.name, 'running');
  assert.equal(go.next.data.stopped, null);
  assert.deepEqual(go.next.data.apps.map((a) => [a.appId, a.state]), [[1, 'proposed'], [2, 'changing'], [3, 'waiting'], [4, 'failed']],
    'what it opened or failed stays; the first unreached app is changed');
  assert.match(lines(go)[0].content, /was resumed by evan: 2 apps left to reach\. It changes one at a time, while there is room\./);

  // No room: resumed, and waiting for it.
  const wait = entry.to(stopped, e, facts({ used: 130, limit: 140, open: 1 }), ctxAt(0));
  assert.equal(wait.next.name, 'running');
  assert.equal(changes(wait).length, 0);
  assert.equal(wait.next.data.held.reason, 'platform');
  assert.deepEqual(wait.timer, { at: new Date(T0 + CHECK_MS), event: { type: 'Check' } });

  // Every app reached before the stop: nothing to resume.
  const all = { name: 'stopped', data: { ...stopped.data, apps: [app(1, 'proposed', { sessionId: 501 })] } };
  assert.deepEqual(entry.guard(all, e, facts(null), ctxAt(0)), { reject: 'nothing_to_resume' });
  // Only a stopped campaign resumes.
  assert.equal(m.entryFor('running', 'Resume').ignore, 'running');
  assert.equal(m.entryFor('done', 'Resume').ignore, 'done');
  assert.equal(m.check({ type: 'Resume', payload: {}, source: { kind: 'route' } }, facts(null), stopped), true);
  assert.notEqual(m.check({ type: 'Resume', payload: {}, source: { kind: 'message', from: { machine: 'proposal' } } }, facts(null), stopped), true);
});

test('a change that reports it stopped, after a resume, is waiting again rather than lost', () => {
  const m = campaign(DEPS);
  const s = running([app(2, 'changing'), app(3, 'waiting')]);
  const e = { id: 6, type: 'WorkSucceeded', source: { kind: 'service', workId: 2 },
    payload: { kind: 'campaign.change', workKey: 'app:2:1', workId: 2, result: { stopped: true } } };
  const out = m.entryFor('running', 'WorkSucceeded').to(s, e, facts({ used: 100, limit: 140, open: 0 }), ctxAt(0));
  assert.equal(out.next.data.apps.find((a) => a.appId === 2).state, 'changing', 'waiting again, and changed again first');
  const stoppedS = { ...s, name: 'stopped' };
  const still = m.entryFor('stopped', 'WorkSucceeded').to(stoppedS, e, facts(null), ctxAt(0));
  assert.equal(still.next.data.apps.find((a) => a.appId === 2).state, 'not_reached');
});

test('an admin resumes from the campaign page, through its own route', () => {
  const routes = read('src/routes/campaigns.js');
  assert.match(routes, /router\.post\('\/api\/campaigns\/:id\/resume', sameOriginBrowserOnly, async \(req, res\) => \{\n\s+try \{\n\s+if \(!req\.user\?\.canAdminWrite\)/);
  assert.match(routes, /platform\(\)\.campaignEvent\(id, 'Resume', \{\}, req\.user\)/);
  assert.match(routes, /\['nothing_to_resume', \[409,/);
  const page = read('frontend/src/features/admin/admin-campaigns.tsx');
  assert.match(page, /write && detail\.status === 'cancelled' && notReached > 0 \?/);
  assert.match(page, /fetch\(`\/api\/campaigns\/\$\{c\.id\}\/resume`, \{ method: 'POST' \}\)/);
  assert.match(page, /Resume campaign \(\$\{notReached\} not reached\)/);
});
