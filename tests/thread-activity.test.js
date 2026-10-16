// Tests for the topic-thread parity work (dev card list polish):
//
//   1. notifications.listForUser / serialize carry the chat message's
//      thread scope (threadType / threadRef) so the client drawer can
//      route a mention/reply/reaction click to the topic view instead
//      of general chat.
//   2. A promote's announcement goes into the proposal's own thread
//      ({ type: 'session', ref }) only, carrying the vote metadata for the
//      inline vote buttons. A channel carries no activity, so there is no
//      general-chat line beside it. The line is the proposal machine's.
//
// Like session-done-notifications.test.js, the pool is an in-memory
// mock that pattern-matches SQL.
//
// Run with: node --test tests/thread-activity.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// ── 1. notifications: thread fields ─────────────────────────────────────

const notifications = require('../src/services/notifications');

test('listForUser selects thread_type/thread_ref off the chat message', async () => {
  let capturedSql = null;
  const pool = {
    query: async (sql) => {
      capturedSql = String(sql);
      return {
        rows: [{
          id: 1, kind: 'mention', read_at: null, created_at: 'now',
          app_id: 5, app_slug: 'demo', app_name: 'Demo',
          chat_message_id: 99, message_content: 'hey @alice',
          thread_type: 'issue', thread_ref: 42,
          session_id: null, pr_title: null, pr_number: null,
          headless_issue_number: null, branch_name: null,
          source_username: 'bob', detail: null,
        }],
      };
    },
  };
  const rows = await notifications.listForUser(pool, 1);
  assert.match(capturedSql, /cm\.thread_type, cm\.thread_ref/);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].thread_type, 'issue');
  assert.equal(rows[0].thread_ref, 42);
});

test('serialize exposes threadType/threadRef (null when unscoped)', () => {
  const base = {
    id: 1, kind: 'mention', read_at: null, created_at: 'now',
    app_id: 5, app_slug: 'demo', app_name: 'Demo',
    chat_message_id: 99, message_content: 'hey',
    session_id: null, pr_title: null, pr_number: null,
    headless_issue_number: null, branch_name: null,
    source_username: 'bob', detail: null,
  };
  const threaded = notifications.serialize({
    ...base, thread_type: 'session', thread_ref: 10,
  });
  assert.equal(threaded.threadType, 'session');
  assert.equal(threaded.threadRef, 10);

  // A general-chat mention (or a pre-thread row hydrated without the
  // columns) serializes to explicit nulls — the client falls back to
  // the Dev → Chat navigation.
  const general = notifications.serialize(base);
  assert.equal(general.threadType, null);
  assert.equal(general.threadRef, null);
});

// ── 2. the promote's announcement ────────────────────────────────────────
// The line is the proposal machine's (src/workflow/proposal/machine.ts):
// written in the transition that puts the proposal in review once GitHub
// has opened or readied its pull request (review.open reported), not by the
// promote route. Driven here through the machine's transition table, with
// no database or runtime.

test('promote announces in the proposal thread, and nowhere thread-less', () => {
  const { proposal, sessionKey, WORK } = require('../src/workflow/proposal/machine.ts');
  const m = proposal({ idleMs: 0, exemptFixtures: false, reviewCheckMs: 0, staleNotifyMs: 0, staleGraceMs: 0 });
  const row = {
    id: 10, appId: 5, appSlug: 'demo', selfHosted: false, repo: { owner: 'o', repo: 'r' }, userId: 1,
    ownerName: 'alice', ownerSynthetic: false, status: 'active', imported: false, headless: false, prNumber: 7,
    prTitle: 'Add feature', branch: 'dev/alice-1', head: null, reviewedHead: null, importedHead: null, epoch: 0,
    promotedAt: null, createdAt: '2026-10-01T00:00:00Z', staleNotifiedAt: null, lastActivityAt: null,
    linkedIssues: [], agentSessionId: null, explicitApproval: false, explicitReason: null, mergeAttemptAt: null,
    shots: false, fixture: false, activeTurn: false, workedOn: false, moving: false, shotsRunning: false,
    buildHold: false, pendingSecret: false,
  };
  const state = {
    name: 'proposing',
    data: { sessionId: 10, appId: 5, imported: false, slot: 'held', answer: null, reason: null, claim: null,
      promoting: { n: 1, by: 1, byName: 'alice', prior: 'active', expectedHead: null, viaAgent: false },
      pr: { running: 'open:1', next: null }, n: 1 },
  };
  const event = {
    id: 51, type: 'WorkSucceeded',
    payload: { workId: 'w1', workKey: 'open:1', kind: WORK.open, result: { prNumber: 7, prTitle: 'Add feature', head: 'a'.repeat(40) } },
    source: { kind: 'service', workId: 'w1' },
  };
  const facts = { row, caps: null, gate: null, interestAt: null, electorate: null };
  const ctx = { now: new Date('2026-10-02T00:00:00Z'), key: sessionKey(10) };
  const entry = m.entryFor('proposing', 'WorkSucceeded');
  assert.equal(entry.guard(state, event, facts, ctx), true);
  const out = entry.to(state, event, facts, ctx);
  assert.equal(out.next.name, 'in_review');

  const promos = out.writes.filter((w) => w.type === 'line' && /promoted PR #7/.test(w.content));
  assert.equal(promos.length, 1, 'one thread post, no channel line');
  const [threaded] = promos;
  assert.equal(threaded.sessionId, 10, 'the proposal\'s own thread');
  assert.equal(threaded.msgType, 'vote');
  assert.deepEqual(threaded.metadata, { vote: { sessionId: 10, prNumber: 7 } });
  assert.match(threaded.content, /^alice promoted PR #7/);

  // Every line the machine writes is a session-thread row.
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/workflow/proposal/machine.ts'), 'utf8');
  assert.match(src, /INSERT INTO chat_messages \(app_id, content, msg_type, metadata, thread_type, thread_ref\)\n\s+VALUES \(\$1, \$2, \$3, \$4, 'session', \$5\)/);
});
