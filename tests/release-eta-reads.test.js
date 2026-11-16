// The reads that carry `release` to the surfaces (#4309 follow-up): each one
// asks services/release-watch.js releasesFor about the changes it shows going
// live, and nothing else. Its SQL keeps only merged, not-live changes of the
// self-hosted app, so a child app's change and one still being merged come
// back without one and keep their words (tests/release-eta-surfaces.test.js).
//
// Fake pools: the Postgres suites for these reads skip without
// TEST_DATABASE_URL, and these pin only what this change added to them.
//
// Run with: node --test tests/release-eta-reads.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const releaseWatch = require('../src/services/release-watch');

const MIN = 60 * 1000;
const NOW = Date.now();

// One pool for every read below: `answer(sql, params)` first, then the two
// queries releasesFor makes. Change 50 is the Homeroom merge waiting for its
// release; anything else asked about is not one (a child app's, or still
// being merged), as the SQL would say.
function pool(answer) {
  const queries = [];
  return {
    queries,
    asked: () => queries.filter((q) => /cs\.id = ANY\(\$1::int\[\]\)/.test(q.sql)).map((q) => q.params[0]),
    async query(sql, params) {
      sql = String(sql);
      queries.push({ sql, params });
      const rows = answer(sql, params);
      if (rows !== undefined) return { rows, rowCount: rows.length };
      if (/cs\.id = ANY\(\$1::int\[\]\)/.test(sql)) {
        return { rows: params[0].includes(50) ? [{ id: 50, merged_at: new Date(NOW - MIN) }] : [] };
      }
      if (/FROM apps a\s+LEFT JOIN LATERAL/.test(sql)) {
        return { rows: [{ id: 1, main_sha: null, last_deploy_at: new Date(NOW - 3 * MIN), release_stall: null,
          release_run: null, newest_at: new Date(NOW - MIN) }] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

// Released 3 minutes ago, merged 1 minute ago: the release gap (4 minutes)
// is past by the time the merge's image is built (5), so 5 minutes off.
const EXPECTED = () => ({ state: 'next', etaAt: new Date(NOW + 5 * MIN).toISOString() });
const APP = (over = {}) => ({
  id: 3, slug: 'usernode-2d5619', name: 'Homeroom', created_by: 1, self_hosted: true,
  collab_visibility: 'public', view_visibility: 'public', moderation_suspended_at: null, ...over,
});

test.beforeEach(() => releaseWatch._forTest.resetOutlook());

test('the bot DM\'s ready cards: a Homeroom merge going live says when', async () => {
  const dm = require('../src/services/homeroom-bot-dm');
  const card = (message_id, session_id, status, app) => ({ message_id, session_id, status, live_at: null, ...app });
  const p = pool((sql) => (/FROM homeroom_bot_dm_messages d/.test(sql) ? [
    card(1, 50, 'merged', APP()),
    card(2, 60, 'merged', APP({ id: 4, slug: 'notes', name: 'Notes', self_hosted: false })),
    card(3, 70, 'merging', APP()),
  ] : undefined));
  const states = await dm.readyStates(p, { user: { id: 4 } });
  assert.deepEqual(states.map((s) => [s.messageId, s.state, s.release || null]), [
    [1, 'going_live', EXPECTED()],
    [2, 'going_live', null],
    [3, 'going_live', null],
  ]);
  assert.deepEqual(p.asked(), [[50]], 'only a merged change of the self-hosted app is asked about');
});

test('the bot DM\'s activity cards: one going live says when', async () => {
  const activity = require('../src/services/homeroom-bot-activity');
  const at = new Date(NOW - 30 * MIN);
  const card = (message_id, proposal_session_id, slug) => ({
    message_id, app_id: 3, issue_number: message_id, created_at: at, first_at: at, began: at, slug, name: slug,
    look_at: null, started_at: null, earlier_runs: null, next_at: null,
    run_id: message_id, verdict: 'ready', build_ok: true, build_error: null, cap_suppressed: false, run_at: at,
    proposal_session_id, proposal_pr_number: null, build_waiting_at: null, build_status: 'merged',
    proposal_status: 'merging', proposal_at: at, told: true, needs_look: false,
  });
  const p = pool((sql) => {
    if (/WITH stamped AS/.test(sql)) return [card(31, 50, 'usernode-2d5619'), card(32, 60, 'notes')];
    if (/FROM apps\s+WHERE slug = ANY/.test(sql)) return [APP(), APP({ id: 4, slug: 'notes', self_hosted: false })];
    return undefined;
  });
  const { cards } = await activity.cardsFor(p, { user: { id: 4 }, deps: { dm: { readyStates: async () => [] } } });
  assert.deepEqual(cards.map((c) => [c.messageId, c.outcome, c.release || null]), [
    [31, 'going_live', EXPECTED()],
    [32, 'going_live', null],
  ]);
  assert.deepEqual(p.asked(), [[50, 60]], 'the SQL, not the caller, tells a child app\'s apart');
});

test('a request\'s track going live says when, for a merge of Homeroom itself', async () => {
  const track = require('../src/services/homeroom-bot-track');
  const going = (sessionId) => ({ ...track.trackOf({
    job: { key: `x#${sessionId}`, appSlug: 'usernode-2d5619', appName: 'Homeroom', issueNumber: sessionId, proposalId: sessionId },
    work: { stage: 'going_live', line: null, whoseMove: null, since: new Date(NOW - 20 * MIN).toISOString() },
  }) });
  // The reader adds it as the change's own pill reads it (release-watch.js releasesFor).
  const src = require('node:fs').readFileSync(require.resolve('../src/services/homeroom-bot-track.js'), 'utf8');
  assert.match(src, /const going = \[\.\.\.out\.values\(\)\]\.filter\(\(t\) => t\.work\.stage === 'going_live' && t\.proposalId\);/);
  assert.match(src, /\.releasesFor\(pool, going\.map\(\(t\) => t\.proposalId\)\)/);
  // And a track carries it through as given.
  const withRelease = track.trackOf({
    job: { key: 'x#1', appSlug: 'usernode-2d5619', appName: 'Homeroom', issueNumber: 1, proposalId: 50, release: EXPECTED() },
    work: { stage: 'going_live', line: null, whoseMove: null, since: null },
  });
  assert.deepEqual(withRelease.release, EXPECTED());
  assert.equal(going(51).release, undefined, 'none unless the reader found one');
});

test('a project\'s chat: the requester\'s card, approved and merged into Homeroom, says when', async () => {
  const chat = require('../src/services/homeroom-bot-chat');
  const state = (chat_message_id, session_id, session_status) => ({
    chat_message_id, kind: 'filed', issue_number: chat_message_id, app_id: 3, queued: false, queue_waiting: false,
    queue_reason: null, first_version: false, issue_status: 'open', run_id: 7, verdict: 'ready', build_ok: true, build_error: null,
    cap_suppressed: false, proposal_session_id: session_id, build_waiting_at: null, build_status: null,
    session_id, session_status, check_state: 'passing', session_live_at: null,
  });
  const p = pool((sql) => (/FROM chat_bot_requests r/.test(sql)
    ? [state(5, 50, 'merged'), state(6, 70, 'merging'), state(8, 80, 'promoted')] : undefined));
  const rows = [5, 6, 8].map((id) => ({ chat_message_id: id, kind: 'filed', issue_number: id, title: 'Dark mode', session_id: null, app_id: 3 }));
  // A filed request's card reads its stored work state: the two merges are
  // going live, and the third is up for a vote.
  const works = new Map([[5, { stage: 'going_live' }], [6, { stage: 'going_live' }], [8, { stage: 'up_for_vote' }]]);
  const deps = {
    dm: { botAccount: async () => ({ id: 99 }), typicalMinutes: async () => null, approvalState: async () => null },
    workState: { ensure: async () => {}, forRequests: async () => works },
  };
  const cards = await chat.cardsOf(p, { appId: 3, user: { id: 4 }, rows, deps });
  assert.deepEqual(cards.map((c) => [c.messageId, c.state && c.state.stage, (c.state && c.state.release) || null]), [
    [5, 'approved', EXPECTED()],
    [6, 'approved', null],
    [8, 'proposed', null],
  ]);
  assert.deepEqual(p.asked(), [[50, 70]], 'approved cards only');
});

test('the leaderboard\'s change lists ask about the rows going live', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'routes', 'kudos.js'), 'utf8');
  assert.equal((src.match(/await withReleases\(pool, rows\);/g) || []).length, 2, 'Top changes and a person\'s changes');
  assert.match(src, /row\.status === 'merging' && row\.session_id != null/);
});
