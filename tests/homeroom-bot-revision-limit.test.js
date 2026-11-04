// #6284: Homeroom bot's limit counts only the fixes it makes on its own.
//
// A person's ask (a thread ask, Main Chat's revise, a No vote's reason) is
// recorded as asked, has its own higher cap, and never uses up one of the
// bot's own three. When it stops, the requester, an admin or anybody who
// voted on the change may let it try once more; one grant is one round.
//
// Run with: node --test tests/homeroom-bot-revision-limit.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const followup = require('../src/services/homeroom-bot-followup');
const grants = require('../src/services/homeroom-bot-retry-grants');

// A pool that answers the three reads these pieces make, keyed by their SQL.
function fakePool({ own = 0, asked = 0, usedGrants = 0, openGrant = null, requesterId = null, votes = [] } = {}) {
  return {
    query: async (sql, params) => {
      const text = String(sql);
      if (/COUNT\(\*\) FILTER \(WHERE NOT asked\)/.test(text)) {
        return { rows: [{ own, asked }] };
      }
      if (/FROM homeroom_bot_revision_grants WHERE session_id = \$1/.test(text) && /MAX\(id\)/.test(text)) {
        return { rows: [{ used: usedGrants, open: openGrant }] };
      }
      if (/FROM chat_sessions WHERE id = \$1/.test(text)) {
        return { rows: [{ id: 5, app_id: 9, linked_issues: [7] }] };
      }
      if (/FROM homeroom_bot_requesters/.test(text)) {
        return { rows: requesterId ? [{ user_id: requesterId, username: 'evan' }] : [] };
      }
      if (/FROM pr_votes/.test(text)) {
        return { rows: votes.includes(Number(params[1])) ? [{ 1: 1 }] : [] };
      }
      return { rows: [] };
    },
  };
}

test('the bot makes 3 fixes by itself, and asks have their own higher limit', () => {
  assert.equal(followup.MAX_REVISIONS, 3);
  assert.equal(followup.MAX_ASKED_REVISIONS, 10);
  assert.ok(followup.MAX_ASKED_REVISIONS > followup.MAX_REVISIONS);
  assert.match(followup.askedLimitText(), /10 updates people asked for/);
});

test('asked revise runs never count toward the bot\'s own three', async () => {
  // PR 6254's case: two asks and one own fix. The own count is 1, so two
  // more of the bot's own rounds remain.
  const counts = await followup.revisionCounts(fakePool({ own: 1, asked: 2 }), 5);
  assert.equal(counts.own, 1);
  assert.equal(counts.asked, 2);
  assert.ok(counts.own < followup.MAX_REVISIONS);
  assert.ok(counts.asked < followup.MAX_ASKED_REVISIONS);
});

test('three own fixes reach the limit; a fourth own round is stopped', async () => {
  const counts = await followup.revisionCounts(fakePool({ own: 3, asked: 2 }), 5);
  assert.equal(counts.own, 3);
  assert.ok(!(counts.own < followup.MAX_REVISIONS));
  // With no grant open, the fix round is refused and the change stops.
  assert.equal(counts.openGrant, null);
});

test('an open grant buys exactly one more round', async () => {
  const before = await followup.revisionCounts(fakePool({ own: 3, usedGrants: 1 }), 5);
  assert.ok(!(before.own < followup.MAX_REVISIONS));
  assert.equal(before.openGrant, null);
  const withGrant = await followup.revisionCounts(fakePool({ own: 3, usedGrants: 1, openGrant: 42 }), 5);
  assert.equal(withGrant.openGrant, 42);
  assert.ok(withGrant.own >= followup.MAX_REVISIONS);
  // A second open grant cannot exist: the partial unique index holds one.
  const spent = await followup.revisionCounts(fakePool({ own: 3, usedGrants: 2 }), 5);
  assert.equal(spent.grants, 2);
});

test('the stopped line says how many tries and who can let it try again', () => {
  const mine = followup.stoppedAtLimitText({ failingCount: 77, tries: 3, you: true });
  assert.match(mine, /stopped after 3 tries/);
  assert.match(mine, /You can let it try once more/);
  assert.match(mine, /77 of this change's checks failed/);
  const others = followup.stoppedAtLimitText({ failingCount: 77, tries: 4 });
  assert.match(others, /an admin can let it try again/);
  assert.doesNotMatch(others, /voted/, 'a voter who is neither sees no button');
  assert.match(followup.stoppedHandOffText({ failingCount: 77, tries: 3 }), /stopped after 3 tries/);
});

test('the requester and an admin may grant; a voter or a stranger may not', async () => {
  const pool = fakePool({ requesterId: 11, votes: [12] });
  assert.equal(await grants.mayGrant(pool, { sessionId: 5, user: { id: 11 } }), true);
  assert.equal(await grants.mayGrant(pool, { sessionId: 5, user: { id: 12 } }), false, 'a vote alone does not');
  assert.equal(await grants.mayGrant(pool, { sessionId: 5, user: { id: 13 } }), false);
  assert.equal(await grants.mayGrant(pool, { sessionId: 5, user: { id: 13, isAdmin: true } }), true);
  assert.equal(await grants.mayGrant(pool, { sessionId: 5, user: null }), false);
});

test('a refusal says who can, and that nothing was queued', () => {
  assert.match(grants.grantRefusalText('not_allowed'), /the person who asked for it or an admin can let me try again/);
  assert.match(grants.grantRefusalText('not_allowed'), /Nothing was queued/);
  assert.match(grants.grantRefusalText('already'), /already waiting/);
});

// #6284: the change's Testing card and the Homeroom bot page read the stop
// from the newest run on the head. A limit hand-off and no open grant is
// "stopped", with how many tries and who may let it try again; any other
// hand-off is the ordinary one.
function fixPool({ limitStop = 'own_revisions', own = 3, usedGrants = 1, openGrant = null, requesterId = 11 } = {}) {
  const HEAD = 'a'.repeat(40);
  return {
    query: async (sql, params) => {
      const text = String(sql);
      if (/FROM chat_sessions cs\s+JOIN users u/.test(text)) {
        return { rows: [{ app_id: 9, status: 'promoted', check_state: 'failing', reviewed_head_sha: HEAD, linked_issues: [7], username: 'homeroom_bot' }] };
      }
      if (/FROM homeroom_bot_queue/.test(text)) return { rows: [] };
      if (/FROM homeroom_bot_runs\s+WHERE proposal_session_id = \$1 AND LOWER\(checks_head_sha\)/.test(text)) {
        return { rows: [{ id: 1, limit_stop: limitStop }] };
      }
      if (/COUNT\(\*\) FILTER \(WHERE NOT asked\)/.test(text)) return { rows: [{ own, asked: 0 }] };
      if (/MAX\(id\) FILTER \(WHERE used_at IS NULL\)/.test(text)) return { rows: [{ used: usedGrants, open: openGrant }] };
      if (/FROM chat_sessions WHERE id = \$1/.test(text)) return { rows: [{ id: 5, app_id: 9, linked_issues: [7] }] };
      if (/FROM homeroom_bot_requesters/.test(text)) return { rows: [{ user_id: requesterId, username: 'evan' }] };
      if (/FROM pr_votes/.test(text)) return { rows: [] };
      return { rows: [] };
    },
  };
}

test('a change stopped at its own limit says stopped, with tries and who may grant', async () => {
  const progress = require('../src/services/homeroom-bot-progress');
  const stopped = await progress.changeBotFix(fixPool(), 5, { viewer: { id: 11 } });
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.tries, 4, 'three own rounds plus the one grant spent');
  assert.equal(stopped.canTryAgain, true, 'the requester may');
  const stranger = await progress.changeBotFix(fixPool(), 5, { viewer: { id: 99 } });
  assert.equal(stranger.canTryAgain, false, 'somebody else sees the line and no button');
  const open = await progress.changeBotFix(fixPool({ openGrant: 42 }), 5, { viewer: { id: 11 } });
  assert.equal(open.state, 'queued', 'a granted round is already waiting');
  const ordinary = await progress.changeBotFix(fixPool({ limitStop: null }), 5, { viewer: { id: 11 } });
  assert.equal(ordinary.state, 'handed_off', 'a hand-off for another reason is not a stop');
});

// #6284: "one grant buys exactly one round". The partial unique index holds
// one open grant per change, so pressing again while it waits queues nothing;
// the round spends it (useGrant), and only then could another be made.
function grantPool({ requesterId = 11 } = {}) {
  const state = { open: null, inserted: [] };
  return {
    state,
    query: async (sql) => {
      const text = String(sql);
      if (/linked_issues FROM chat_sessions WHERE id = \$1/.test(text)) return { rows: [{ id: 5, app_id: 9, linked_issues: [7] }] };
      if (/SELECT app_id FROM chat_sessions WHERE id = \$1/.test(text)) return { rows: [{ app_id: 9 }] };
      if (/FROM homeroom_bot_requesters/.test(text)) return { rows: [{ user_id: requesterId, username: 'evan' }] };
      if (/FROM chat_sessions cs\s+JOIN users u/.test(text)) {
        return { rows: [{ app_id: 9, status: 'promoted', check_state: 'failing', reviewed_head_sha: 'a'.repeat(40), linked_issues: [7], username: 'homeroom_bot' }] };
      }
      if (/FROM homeroom_bot_queue/.test(text)) return { rows: [] };
      if (/FROM homeroom_bot_runs\s+WHERE proposal_session_id = \$1 AND LOWER\(checks_head_sha\)/.test(text)) return { rows: [{ id: 1, limit_stop: 'own_revisions' }] };
      if (/COUNT\(\*\) FILTER \(WHERE NOT asked\)/.test(text)) return { rows: [{ own: 3, asked: 0 }] };
      if (/MAX\(id\) FILTER \(WHERE used_at IS NULL\)/.test(text)) return { rows: [{ used: 0, open: state.open }] };
      if (/SELECT id FROM homeroom_bot_revision_grants WHERE session_id = \$1 AND used_at IS NULL/.test(text)) {
        return { rows: state.open ? [{ id: state.open }] : [] };
      }
      if (/INSERT INTO homeroom_bot_revision_grants/.test(text)) {
        state.open = 7; state.inserted.push(true); return { rows: [{ id: 7 }] };
      }
      if (/UPDATE homeroom_bot_revision_grants\s+SET used_at/.test(text)) {
        if (!state.open) return { rows: [] };
        const id = state.open; state.open = null; return { rows: [{ id, granted_by: null }] };
      }
      return { rows: [] };
    },
  };
}

test('one grant buys exactly one open round, and the round spends it', async () => {
  const pool = grantPool();
  const deps = { homeroomBot: { queueChecksFix: async () => ({ queued: true }) } };
  const user = { id: 11 };
  assert.equal(await grants.mayGrant(pool, { sessionId: 5, user }), true);
  assert.deepEqual(await grants.grant(pool, { sessionId: 5, user, deps }), { ok: true, grantId: 7 });
  assert.equal(pool.state.inserted.length, 1, 'one grant stored');
  assert.deepEqual(await grants.grant(pool, { sessionId: 5, user, deps }), { ok: false, why: 'already' },
    'pressed again while it waits: nothing new');
  assert.equal(pool.state.inserted.length, 1);
  assert.deepEqual(await grants.useGrant(pool, 5, 1), { id: 7, granted_by: null }, 'the round spends the grant');
  assert.equal(pool.state.open, null);
});

test('a grant is refused when the change is not stopped', async () => {
  // changeBotFix answers handed_off, so grant() answers not_stopped before
  // it stores anything.
  const out = await grants.grant(fixPool({ limitStop: null }), { sessionId: 5, user: { id: 11 } });
  assert.deepEqual(out, { ok: false, why: 'not_stopped' });
});

test('a stranger cannot grant', async () => {
  const out = await grants.grant(fixPool({ requesterId: 11 }), { sessionId: 5, user: { id: 99 } });
  assert.deepEqual(out, { ok: false, why: 'not_allowed' });
});

test('the Homeroom bot page lists a stopped change under Needs you', () => {
  const progress = require('../src/services/homeroom-bot-progress');
  const { BOT_STANDING } = require('../src/services/ai-work');
  const HEAD = 'a'.repeat(40);
  const open = {
    proposal_status: 'promoted', proposal_at: new Date(Date.now() - 20 * 60000).toISOString(),
    check_state: 'failing', checks_sha: HEAD, reviewed_head_sha: HEAD, fix_stopped: true,
  };  assert.deepEqual(progress.stageOf(open), {
    stage: 'fix_stopped', since: open.checks_at || open.proposal_at,
    doing: 'its checks are failing, and Homeroom bot stopped fixing them', waitingOn: 'them',
  });
  assert.deepEqual(BOT_STANDING.fix_stopped, { group: 'needs', what: 'fix_stopped' });
});


