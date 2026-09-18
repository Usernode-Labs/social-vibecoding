'use strict';

// #1688: a Yes on an earlier version of a proposal asks "Still yes?".
//
// When the author pushes a new version, the votes on the old one stop
// counting but stay on their rows, and /promoted names the viewer's own as
// `my_prior_vote`. The card's vote button then reads "Still yes?" rather
// than "Vote", and one tap carries the earlier Yes onto this version —
// the button's face, its data attribute and its title all say so. Pins:
//
//   1. `_cardVoteButtonSpecs` hands the prior side on with the Yes spec,
//      only while the viewer has no counted vote;
//   2. the rendered button: face, class and `data-vote-btn`;
//   3. a counted vote, or none at all, draws exactly what it drew before.
//
// Run with: node --test tests/vote-button-prior.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { proposalCardHtml } = require('./lib/dev-card-html');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');

function makeAppView(userId) {
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: userId, canAdminWrite: false } },
    Kudos: { renderButton: () => '<button class="gc-vote-btn">kudos</button>', attach: () => {} },
    ConfirmModal: { show: async () => true },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: 1 };
  AppView._mergedCtx = { majority: 1 };
  AppView._visualsOpen = new Set();
  AppView.__sandbox = sandbox;
  return AppView;
}

const ME = 42;
const proposal = (over) => ({
  id: 7, pr_number: 700, pr_title: 'Tidy the header', username: 'evan',
  user_id: 999, status: 'promoted', yes_count: 1, no_count: 0, approval_epoch: 3,
  created_at: '2026-06-01T00:00:00Z', ...over,
});

test('the model carries the prior side on the Yes spec, only while nothing of the viewer\'s counts', () => {
  const AppView = makeAppView(ME);
  const [yes, no] = AppView._cardVoteButtonSpecs(proposal({ my_vote: null, my_prior_vote: 'yes' }));
  assert.equal(yes.prior, 'yes');
  assert.ok(!('prior' in no), 'the No spec carries nothing extra');
  assert.deepEqual(JSON.parse(JSON.stringify(yes.act)), { fn: 'castVote', args: [7, 'yes', 3] }, 'the same call, same epoch: the server does the carrying');
  const [counted] = AppView._cardVoteButtonSpecs(proposal({ my_vote: 'yes', my_prior_vote: 'yes' }));
  assert.ok(!('prior' in counted), 'a counted vote is not a prior one');
  const [fresh] = AppView._cardVoteButtonSpecs(proposal({ my_vote: null, my_prior_vote: null }));
  assert.ok(!('prior' in fresh));
  const [odd] = AppView._cardVoteButtonSpecs(proposal({ my_vote: null, my_prior_vote: 'maybe' }));
  assert.ok(!('prior' in odd), 'only the two sides');
});

test('the button asks "Still yes?", and says in its title what one tap does', () => {
  const AppView = makeAppView(ME);
  const html = proposalCardHtml(AppView, proposal({ my_vote: null, my_prior_vote: 'yes' }));
  const btn = html.match(/<button[^>]*class="dev-vote-btn[^"]*"[^>]*>[\s\S]*?<\/button>/);
  assert.ok(btn, 'the one vote button');
  assert.match(btn[0], /class="dev-vote-btn dev-vote-btn-prior"/);
  assert.match(btn[0], /data-vote-btn="prior-yes"/);
  assert.match(btn[0], /title="You said yes to an earlier version\. One tap carries it onto this one\."/);
  assert.match(btn[0], />Still yes\?</);
  assert.doesNotMatch(btn[0], />Vote</);
});

test('a counted vote, or none at all, draws what it always drew', () => {
  const AppView = makeAppView(ME);
  const fresh = proposalCardHtml(AppView, proposal({ my_vote: null }));
  assert.match(fresh, /class="dev-vote-btn" data-vote-btn="open"/);
  assert.match(fresh, />Vote</);
  assert.doesNotMatch(fresh, /Still yes|dev-vote-btn-prior/);
  const voted = proposalCardHtml(AppView, proposal({ my_vote: 'yes', my_prior_vote: 'yes' }));
  assert.match(voted, /class="dev-vote-btn dev-vote-btn-yes" data-vote-btn="yes"/);
  assert.doesNotMatch(voted, /Still yes|dev-vote-btn-prior/);
  const priorNo = proposalCardHtml(AppView, proposal({ my_vote: null, my_prior_vote: 'no' }));
  assert.match(priorNo, /class="dev-vote-btn" data-vote-btn="open"/, 'an earlier No is not asked back: it stopped nothing');
});
