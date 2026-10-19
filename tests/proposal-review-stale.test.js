// The proposal machine's hourly ReviewCheck and the stale rule
// (src/workflow/proposal/machine.ts reviewCheck, facts.ts readInterest).
//
// Two holes kept proposals in review, and in the platform's session budget,
// long after anybody cared about them (19 Oct: 133 of 140 sessions used, 126
// of them proposals in review):
//   - a proposal whose votes were met but whose merge was refused every hour
//     (a conflict nobody resolved, checks nobody fixed) was asked for again
//     and never looked at for going quiet: 5796 was warned on 13 Oct and
//     stayed up;
//   - any vote restarted the clock, one that did not count included.
// Driven through the machine's transition table, with no database or
// runtime; the interest read is driven with a scripted transaction.
//
// Run with: node --test tests/proposal-review-stale.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { mergeGate } = require('../src/services/active-users');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const opened = '2026-06-01T00:00:00.000Z';
const openedMs = Date.parse(opened);
const at = (ms) => new Date(openedMs + ms).toISOString();

function machine() {
  const { proposal } = require('../src/workflow/proposal/machine.ts');
  return proposal({ idleMs: 0, exemptFixtures: false, reviewCheckMs: HOUR, staleNotifyMs: 7 * DAY, staleGraceMs: 3 * DAY });
}

function rowWith(over = {}) {
  return {
    id: 7, appId: 5, appSlug: 'widget', selfHosted: false, repo: null, userId: 3, ownerName: 'alice',
    ownerSynthetic: false, status: 'promoted', imported: false, headless: false, prNumber: 12,
    prTitle: 'Quiet change', branch: 'b', head: 'a'.repeat(40), reviewedHead: 'a'.repeat(40), importedHead: null,
    epoch: 1, promotedAt: opened, createdAt: opened, staleNotifiedAt: null, lastActivityAt: opened,
    linkedIssues: [], agentSessionId: null, explicitApproval: false, explicitReason: null, mergeAttemptAt: null,
    shots: false, fixture: false, activeTurn: false, workedOn: false, moving: false, shotsRunning: false,
    buildHold: false, pendingSecret: false, ...over,
  };
}

function check({ now, gate, interestAt = opened, mergesPaused = false, row = {}, data = {} }) {
  const { sessionKey } = require('../src/workflow/proposal/machine.ts');
  const m = machine();
  const state = {
    name: 'in_review',
    data: { sessionId: 7, appId: 5, imported: false, slot: 'held', promoting: null, answer: null, reason: null,
      claim: null, pr: { running: null, next: [] }, doomed: [], n: 1, ...data },
  };
  const event = { id: 41, type: 'ReviewCheck', payload: {}, source: { kind: 'timer' } };
  const ctx = { now: new Date(openedMs + now), key: sessionKey(7) };
  const facts = { row: rowWith(row), caps: null, gate, interestAt, mergesPaused, electorate: null };
  const entry = m.entryFor('in_review', 'ReviewCheck');
  assert.equal(entry.guard(state, event, facts, ctx), true);
  return entry.to(state, event, facts, ctx);
}

const writesOf = (out, type) => (out.writes || []).filter((w) => w.type === type);
const asks = (out) => (out.messages || []).filter((m) => m.event?.type === 'MergeWanted');

// active=20, one Yes at promotion, nothing against: lazy consensus arms a
// 7-day window, so it becomes mergeable 7 days after promotion.
const lazyGate = (now) => mergeGate(20, 1, 0, opened, openedMs + now);
// A clear majority long after promotion: mergeable, its window long ended.
const metGate = (now) => mergeGate(20, 11, 0, opened, openedMs + now);
// Nothing either way: neither mergeable nor rejectable.
const openGate = (now) => mergeGate(20, 0, 0, opened, openedMs + now);

test('a proposal whose votes are met but whose merge stands still is warned, and still asked for', () => {
  const now = 20 * DAY;
  const out = check({ now, gate: metGate(now), interestAt: at(2 * DAY) });
  assert.equal(out.next.name, 'in_review');
  const warned = writesOf(out, 'staleWarned');
  assert.equal(warned.length, 1, 'warned once its week is up');
  assert.equal(warned[0].blocked, true, 'in the blocked words, not "needs votes"');
  assert.equal(asks(out).length, 1, 'the merge queue is still asked');
});

test('a blocked proposal warned a grace period ago is set aside as stale', () => {
  const now = 20 * DAY;
  const out = check({ now, gate: metGate(now), interestAt: at(2 * DAY), row: { staleNotifiedAt: at(16 * DAY) } });
  assert.equal(out.next.name, 'closed');
  assert.equal(out.next.data.reason, 'stale-pr');
  assert.equal(asks(out).length, 0, 'a closed proposal is not asked for');
});

test('the clock of a met gate runs from when it became mergeable, so the queue has its week first', () => {
  // Mergeable since its window ended at day 7; its only vote is from day 0.
  const justMet = check({ now: 7 * DAY + HOUR, gate: lazyGate(7 * DAY + HOUR) });
  assert.equal(lazyGate(7 * DAY + HOUR).mergeable, true);
  assert.equal(writesOf(justMet, 'staleWarned').length, 0, 'not warned the hour it became mergeable');
  assert.equal(asks(justMet).length, 1);

  const weekOn = check({ now: 14 * DAY + HOUR, gate: lazyGate(14 * DAY + HOUR) });
  assert.equal(writesOf(weekOn, 'staleWarned').length, 1, 'warned a week after it became mergeable');
  assert.equal(asks(weekOn).length, 1);
});

test('a red main pauses every merge on the app: no proposal waiting on it goes quiet', () => {
  const now = 30 * DAY;
  const out = check({ now, gate: metGate(now), interestAt: at(2 * DAY), mergesPaused: true,
    row: { staleNotifiedAt: at(20 * DAY) } });
  assert.equal(out.next.name, 'in_review', 'not set aside while merges are paused');
  assert.equal(writesOf(out, 'staleWarned').length, 0);
  assert.equal(asks(out).length, 1);
  // A proposal that is not mergeable is the proposal's own business: the
  // pause is not read for it and does not hold its clock.
  const quiet = check({ now, gate: openGate(now), mergesPaused: true });
  assert.equal(writesOf(quiet, 'staleWarned').length, 1);
});

test('a counted vote after the warning stands the proposal again, and a met gate is still asked for', () => {
  const now = 20 * DAY;
  const out = check({ now, gate: metGate(now), interestAt: at(19 * DAY), row: { staleNotifiedAt: at(18 * DAY) } });
  assert.equal(writesOf(out, 'staleCleared').length, 1);
  assert.equal(asks(out).length, 1);
});

test('a merge already under way is not asked for again, and the clock still runs', () => {
  const now = 20 * DAY;
  const out = check({ now, gate: metGate(now), interestAt: at(2 * DAY), data: { attempt: { n: 2, stage: 'gate' } } });
  assert.equal(asks(out).length, 0);
  assert.equal(writesOf(out, 'staleWarned').length, 1);
});

test('a proposal nobody has voted on is warned in the words that ask for votes, and nothing is asked', () => {
  const now = 8 * DAY;
  const out = check({ now, gate: openGate(now) });
  const warned = writesOf(out, 'staleWarned');
  assert.equal(warned.length, 1);
  assert.equal(warned[0].blocked, false);
  assert.equal(asks(out).length, 0);
  // Inside its week: left alone.
  const fresh = check({ now: 6 * DAY, gate: openGate(6 * DAY) });
  assert.equal(writesOf(fresh, 'staleWarned').length, 0);
});

test('a proposal someone is working on is left alone', () => {
  const now = 20 * DAY;
  const out = check({ now, gate: metGate(now), interestAt: at(2 * DAY), row: { activeTurn: true } });
  assert.equal((out.writes || []).length, 0);
  assert.equal((out.messages || []).length, 0);
});

// ── The interest read ───────────────────────────────────────────────────

// The interest read's statements, answered by SQL shape and recorded with
// their parameters.
function scriptedTx({ policy = 'anyone', approvers = [], lastCounted = null }) {
  const seen = [];
  const tx = {
    async query(sql, params = []) {
      seen.push({ sql, params });
      if (/SELECT approver_policy, governance_rules FROM apps/.test(sql)) {
        return { rows: [{ approver_policy: policy, governance_rules: null }] };
      }
      if (/FROM app_approvers/.test(sql)) return { rows: approvers.map((id) => ({ user_id: id })) };
      if (/MAX\(pv\.created_at\)/.test(sql)) return { rows: [{ at: lastCounted || opened }] };
      return { rows: [] };
    },
  };
  return { tx, seen };
}

test('only a vote the gate would count restarts the clock', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/workflow/proposal/facts.ts'), 'utf8');
  const body = src.slice(src.indexOf('async function readInterest'), src.indexOf('async function readElectorate'));
  assert.match(body, /counts_toward_session_outcome\(pv\.user_id, pv\.session_id\)/, 'the voter counts toward the outcome');
  assert.match(body, /pv\.vote IN \('yes', 'no'\)/);
  assert.match(body, /\$4::int\[\] IS NULL OR pv\.user_id = ANY\(\$4::int\[\]\)/, 'an invited project counts its approvers only');
  assert.doesNotMatch(body, /approval_epoch/, 'new code that cleared the votes does not make the proposal look forgotten');
});

test('the interest read passes an invited project\'s approver set, and nothing for an open one', async () => {
  const { readInterest } = require('../src/workflow/proposal/facts.ts');
  const row = rowWith();
  const invited = scriptedTx({ policy: 'invited', approvers: [11, 12], lastCounted: at(3 * DAY) });
  assert.equal(await readInterest(invited.tx, row), at(3 * DAY));
  const read = invited.seen.find((q) => /MAX\(pv\.created_at\)/.test(q.sql));
  assert.deepEqual(read.params, [7, opened, opened, [11, 12]]);

  const open = scriptedTx({ policy: 'anyone' });
  await readInterest(open.tx, row);
  assert.equal(open.seen.some((q) => /FROM app_approvers/.test(q.sql)), false);
  assert.deepEqual(open.seen.find((q) => /MAX\(pv\.created_at\)/.test(q.sql)).params, [7, opened, opened, null]);
});
