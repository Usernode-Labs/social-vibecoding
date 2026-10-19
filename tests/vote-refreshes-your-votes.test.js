'use strict';

// #5452: a vote lands in Your votes the moment the server saved it, without
// a page refresh.
//
// Your votes reads once per open, and a vote button answers ahead of the row
// being written (a deciding vote can hold its POST for seconds), so the
// three call sites that cast a vote each tell the profile screen's controller
// and drop the Kudos My history cache — only after the server has said yes:
//
//   - AppView.castVote (public/js/app-view.js): the change page's vote;
//   - AppView.castIssueVote: a group decision's vote;
//   - approveChange (frontend/src/features/messages/api.ts): the Yes on a
//     Homeroom bot's ready card, through the window bridge so the messages
//     chunk does not pull in the profile screen.
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

test('castVote tells Your votes and the Kudos history, only after the server took the vote', () => {
  const fn = appViewMethod(
    read('public/js/app-view.js'),
    '  async castVote(sessionId, vote, expectedEpoch = null, opts = null) {',
  );
  assert.match(fn, /window\.UsernodeReact\?\.profileProposals\?\.voted\?\.\(\);/);
  assert.match(fn, /window\.Leaderboard\?\.invalidateHistory\?\.\(\);/);
  const refused = fn.indexOf('return false;', fn.indexOf('if (!res.ok)'));
  const called = fn.indexOf('profileProposals?.voted');
  // The network catch is the function's last one; the reason resolver's own
  // try/catch sits ahead of the vote and must not be mistaken for it.
  const caught = fn.lastIndexOf('} catch {');
  assert.ok(refused > -1, 'the refusal branch is found');
  assert.ok(called > refused, 'never on a refused vote');
  assert.ok(caught > -1 && called < caught, 'and never in the catch: a vote that did not reach the server lists nothing');
});

test('castIssueVote does the same, only on an ok response', () => {
  const fn = appViewMethod(
    read('public/js/app-view.js'),
    '  async castIssueVote(issueId, vote, opts = null) {',
  );
  assert.match(fn, /window\.UsernodeReact\?\.profileProposals\?\.voted\?\.\(\);/);
  assert.match(fn, /window\.Leaderboard\?\.invalidateHistory\?\.\(\);/);
  const refused = fn.indexOf("PlatformUI.toast((data.error === 'reason_required'");
  const called = fn.indexOf('profileProposals?.voted');
  const caught = fn.indexOf('} catch (err) {');
  assert.ok(refused > -1, 'the refusal branch is found');
  assert.ok(called > refused, 'never on a refused vote');
  assert.ok(caught > -1 && called < caught, 'and never in the catch');
});

test('approveChange tells Your votes under response.ok, through the window bridge', () => {
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
  assert.match(helperBody, /\(window as any\)\.UsernodeReact\?\.profileProposals\?\.voted\?\.\(\);/,
    'the window bridge, not an import');
  assert.match(helperBody, /\(window as any\)\.Leaderboard\?\.invalidateHistory\?\.\(\);/);
  assert.doesNotMatch(src, /my-proposals/, 'the messages chunk does not pull in the profile screen');
});