'use strict';

// #5452: a vote lands in the Kudos My history tab the moment the server
// saved it, without a page refresh. (It landed in Me › Your votes too, until
// 5 Nov 2026: that screen is the Homeroom bot tab's History now, read fresh
// each time it is shown.)
//
// A vote button answers ahead of the row being written (a deciding vote can
// hold its POST for seconds), so the three call sites that cast a vote each
// drop the Kudos My history cache, only after the server has said yes:
//
//   - AppView.castVote (public/js/app-view.js): the change page's vote;
//   - AppView.castIssueVote: a group decision's vote;
//   - approveChange (frontend/src/features/messages/api.ts): the Yes on a
//     Homeroom bot's ready card, through the window bridge.
//
// Run with: node --test tests/vote-refreshes-your-votes.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// The body of an app-view.js method: from its head to the `},` that closes it
// at two-space depth, the slice the other source assertions in this suite use.
function appViewMethod(view, head) {
  const at = view.indexOf(head);
  assert.ok(at > -1, `${head.trim()} is found`);
  return view.slice(at, view.indexOf('\n  },\n', at));
}

test('castVote tells the Kudos history, only after the server took the vote', () => {
  const fn = appViewMethod(
    read('public/js/app-view.js'),
    '  async castVote(sessionId, vote, expectedEpoch = null, opts = null) {',
  );
  assert.match(fn, /window\.Leaderboard\?\.invalidateHistory\?\.\(\);/);
  assert.doesNotMatch(fn, /profileProposals/, 'the Your work screen is gone');
  const refused = fn.indexOf('return false;', fn.indexOf('if (!res.ok)'));
  const ordinary = fn.indexOf('Leaderboard?.invalidateHistory', fn.indexOf('await AppView.refreshDevData(\'vote\');'));
  assert.ok(ordinary > refused, 'an ordinary refusal returns before it');
  // The network catch is the function's last one; the reason resolver's own
  // try/catch sits ahead of the vote and must not be mistaken for it.
  const caught = fn.lastIndexOf('} catch {');
  assert.ok(caught > -1 && ordinary < caught, 'and never in the catch: a vote that did not reach the server lists nothing');
});

test('castIssueVote does the same, only on an ok response', () => {
  const fn = appViewMethod(
    read('public/js/app-view.js'),
    '  async castIssueVote(issueId, vote, opts = null) {',
  );
  assert.match(fn, /window\.Leaderboard\?\.invalidateHistory\?\.\(\);/);
  const refused = fn.indexOf('PlatformUI.toast(PlatformI18n.errorText(data) ||');
  const called = fn.indexOf('Leaderboard?.invalidateHistory');
  const caught = fn.indexOf('} catch (err) {');
  assert.ok(refused > -1, 'the refusal branch is found');
  assert.ok(called > refused, 'never on a refused vote');
  assert.ok(caught > -1 && called < caught, 'and never in the catch');
});

test('approveChange tells the Kudos history under response.ok, through the window bridge', () => {
  const src = read('frontend/src/features/messages/api.ts');
  const at = src.indexOf('export async function approveChange(');
  assert.ok(at > -1);
  const body = src.slice(at, src.indexOf('\n}\n', at));
  // The ok return stays the one-line shape the B7 check pins, so the
  // announcement goes through a helper called just before it.
  assert.match(body, /if \(response\.ok\) announceApprovalVote\(\);/);
  const called = body.indexOf('announceApprovalVote()');
  const okReturn = body.indexOf('if (response.ok) return { ok: true');
  assert.ok(okReturn > -1, 'the one-line ok return is kept');
  assert.ok(called > -1 && called < okReturn, 'only once the server has said yes');
  const helper = src.indexOf('function announceApprovalVote()');
  assert.ok(helper > -1, 'the announcement helper exists');
  const helperBody = src.slice(helper, src.indexOf('\n}\n', helper));
  assert.match(helperBody, /\(window as any\)\.Leaderboard\?\.invalidateHistory\?\.\(\);/, 'the window bridge, not an import');
  assert.doesNotMatch(helperBody, /profileProposals/, 'the Your work screen is gone');
});
