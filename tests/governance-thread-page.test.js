// #6440: a governance vote opens as a thread, like a request and a change.
//
// The page is the request page's sheet (features/group-chat/thread-shell.tsx
// `RequestShell`, its decision layout), with the vote as its root post
// (features/dev-board/topic/governance-head.tsx) and its Votes card under it
// (topic/thread-changes.tsx `GovVote`). What each kind says is
// topic/governance-model.ts's.
//
// Run with: node --test tests/governance-thread-page.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadTsx, renderComponent } = require('./lib/render-tsx');

const MODEL = 'frontend/src/features/dev-board/topic/governance-model.ts';
const HEAD = 'frontend/src/features/dev-board/topic/governance-head.tsx';
const SHELL = 'frontend/src/features/group-chat/thread-shell.tsx';

const row = (patch) => ({
  id: 4812,
  kind: 'rename',
  status: 'open',
  title: 'Rename the project to "Garden Notes"',
  description: '',
  payload: { oldName: 'Plant Tracker', newName: 'Garden Notes' },
  created_by: 7,
  created_by_username: 'mira',
  created_at: '2026-11-06T09:00:00Z',
  up_count: 2,
  down_count: 0,
  my_vote: null,
  votes_required: 3,
  merge_window_ends_at: null,
  ...patch,
});

const view = (r, patch = {}) => {
  const { governanceView } = loadTsx(MODEL);
  return {
    ...governanceView(r, {
      username: 'mira',
      appName: 'Plant Tracker',
      // AppView's pill for an open vote (statusPillState, kind 'gov').
      pill: { tier: 1, key: 'vote', label: 'Up for a vote', tone: 'neutral', yes: 2, no: 0, majority: 3, advisory: 0, lock: false },
    }),
    ...patch,
  };
};

test('a governance vote is drawn in the request page’s sheet, named as a decision', () => {
  const html = renderComponent(SHELL, 'ThreadShell', {
    fill: true, withHeader: true, readOnly: false, notice: '', placeholder: 'Reply…', maxLength: 4000, decision: true,
  });
  assert.match(html, /^<div class="dev-request dev-decision platform-kb-column">/, 'the decision layout of the same sheet');
  assert.match(html, /aria-label="Decision"/);
  assert.match(html, /<div id="gc-thread-head"><\/div><div id="gc-thread-messages"><\/div>/);
  assert.match(html, /class="messages-composer messages-composer-thread chat-composer-bar platform-safe-bar"/, 'the replies composer');
});

test('each kind says what it does in its own words, with its number in the bar', () => {
  const cases = [
    ['rename', row({}), 'project:topic.decision.bar.rename', 'rename', /From <strong>Plant Tracker<\/strong> to <strong>Garden Notes<\/strong>\./],
    ['secret_change', row({ kind: 'secret_change', id: 4790, title: 'Set FEATURE_FLAG', payload: { key: 'FEATURE_FLAG', action: 'set', hasValue: true } }),
      'project:topic.decision.bar.secret', 'secret', /Sets the secret <code[^>]*>FEATURE_FLAG<\/code>\. Its value is never shown\./],
    ['maintenance_campaign', row({ kind: 'maintenance_campaign', id: 4813, title: 'Refresh every app', payload: { instructions: 'Rebuild the shared images.' } }),
      'project:topic.decision.bar.campaign', 'campaign', /Rebuild the shared images\./],
    ['featured_illustration', row({ kind: 'featured_illustration', id: 4814, title: 'Change the featured illustration',
      payload: { current: { url: '/current.png' }, proposed: { url: '/proposed.png' }, remove: false } }),
    'project:topic.decision.bar.illustration', 'illustration', /data-illustration-side="current"[\s\S]*data-illustration-side="proposed"/],
  ];
  for (const [kind, r, kickerId, content, contentMatch] of cases) {
    const v = view(r);
    assert.equal(v.kicker.id, kickerId, `${kind}: the bar names the kind`);
    assert.deepEqual(v.kicker.values, { number: r.id }, `${kind}: with its number, the one in its address`);
    assert.equal(v.content.kind, content, `${kind}: the root post's content`);
    const bar = renderComponent(HEAD, 'GovernanceBar', { g: v });
    assert.match(bar, /data-gov-kicker=""/, `${kind}: the bar's kicker`);
    assert.match(bar, /data-gov-status="vote"/, `${kind}: its status beside the kicker`);
    const head = renderComponent(HEAD, 'GovernanceHead', { row: r, view: v });
    assert.match(head, new RegExp(`<article class="messages-message dev-request-root" data-gov-root="${r.id}">`), `${kind}: the vote is the root post`);
    assert.match(head, contentMatch, `${kind}: the root post says what it does`);
    assert.match(head, new RegExp(`data-gov-vote="${r.id}"`), `${kind}: its Votes card`);
    assert.match(head, /data-done="false"/, `${kind}: an open vote offers one`);
    assert.match(head, /data-close-vote="up"/, `${kind}: with Yes`);
    assert.match(head, /data-close-vote="down"/, `${kind}: and No`);
  }
});

test('a secret change names its key and never its value, whatever the row carries', () => {
  const r = row({
    kind: 'secret_change', id: 4790, title: 'Set FEATURE_FLAG',
    payload: { key: 'FEATURE_FLAG', action: 'set', valueEnc: 'ciphertext-do-not-show', value: 'super-secret-value', hasValue: true },
  });
  const v = view(r);
  assert.deepEqual(Object.keys(v.content).sort(), ['action', 'key', 'kind'], 'the model has no field a value could sit in');
  const head = renderComponent(HEAD, 'GovernanceHead', { row: r, view: v });
  assert.doesNotMatch(head, /ciphertext-do-not-show|super-secret-value/);
  assert.match(head, /FEATURE_FLAG/);
});

test('a vote that has ended says how, and offers no vote', () => {
  const endings = [
    ['applied', { payload: { oldName: 'Plant Tracker', newName: 'Garden Notes', appliedAt: '2026-11-06T10:00:00Z', appliedBy: 'group-vote' } }, /Passed and applied/],
    ['applying', { merge_window_ends_at: '2026-11-06T09:00:00Z', up_count: 3 }, /It is being applied now/],
    ['refused', { payload: { newName: 'Garden Notes', appliedAt: '2026-11-06T10:00:00Z', appliedBy: 'refused:checks' } }, /Rejected/],
    ['withdrawn', { payload: { newName: 'Garden Notes', withdrawnAt: '2026-11-06T10:00:00Z' } }, /Withdrawn/],
    ['superseded', { payload: { newName: 'Garden Notes', supersededAt: '2026-11-06T10:00:00Z' } }, /No longer needed/],
  ];
  for (const [outcome, patch, line] of endings) {
    const r = row({ ...patch });
    const v = view(r);
    assert.equal(v.votes.outcome, outcome, `${outcome}: the page knows how it ended`);
    assert.equal(v.votes.open, false, `${outcome}: not counting`);
    const head = renderComponent(HEAD, 'GovernanceHead', { row: r, view: v });
    assert.match(head, new RegExp(`data-gov-outcome="${outcome}"`), `${outcome}: the card says which ending`);
    assert.match(head, /data-done="true"/, `${outcome}: done`);
    assert.doesNotMatch(head, /data-close-vote/, `${outcome}: no vote to cast`);
    assert.doesNotMatch(head, /Waiting for votes/i, `${outcome}: never says it is waiting after it ended`);
    assert.match(head, line, `${outcome}: the ending in words`);
  }
});

test('the Votes card shows the tally, the votes needed and the viewer’s own vote', () => {
  const v = view(row({ up_count: 2, votes_required: 3, my_vote: 'up' }));
  assert.deepEqual(v.votes, { yes: 2, need: 3, mine: 'yes', open: true, outcome: 'open' });
  const head = renderComponent(HEAD, 'GovernanceHead', { row: row({ up_count: 2, votes_required: 3, my_vote: 'up' }), view: v });
  assert.match(head, /2 of 3 yes/, 'the tally and the votes the rule needs');
  assert.match(head, /aria-pressed="true" data-close-vote="up"/, 'the viewer’s own Yes');
});

test('a reopen vote and a thread move are drawn on the page they are about', () => {
  const { governanceView } = loadTsx(MODEL);
  const reopen = governanceView(row({ kind: 'reopen_issue', id: 5001, payload: { issueNumber: 12 } }), {});
  // Their own page is not drawn: the server names the page (`row.home`) and
  // the router forwards there. The model still reads the vote's own words.
  assert.equal(reopen.content.kind, 'close');
  assert.equal(reopen.content.number, 12, 'the request it would bring back');
});
