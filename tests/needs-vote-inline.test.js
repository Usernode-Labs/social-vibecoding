'use strict';

// #3613: on Needs you, the line for the group is written INLINE, on the vote
// sheet, in the card's own vote format — not in a prompt card castVote raised
// after "Vote yes" was pressed.
//
// The form is EXECUTED (tests/lib/render-tsx.js): a real Needs you row, built
// by the Communities feed's own adapter (needs-reel.tsx `reelRows`), is drawn
// through `NeedsVoteForm`, which is what the sheet renders when Vote is
// pressed. renderToStaticMarkup runs no effects and no clicks, so the press
// itself (Vote → toggleSheet('vote') → this form) and the send (the line goes
// to castVote as `reason`, so castVote never asks) are pinned from source.
//
// Run with: node --test tests/needs-vote-inline.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const WORKSHOP = read('frontend/src/features/dev-board/workshop/workshop.tsx');
const APP_VIEW = read('public/js/app-view.js');

const { reelRows } = loadTsx('frontend/src/features/workshop/needs-reel.tsx');
const { NeedsVoteForm } = loadTsx('frontend/src/features/dev-board/workshop/workshop.tsx');

const item = {
  kind: 'proposal', id: 42, title: 'Dark mode', summary: 'Adds a dark theme.', author: 'ada',
  number: 7, epoch: 3, at: null, yes: 1, no: 0,
  app: { slug: 'demo-app', name: 'Demo', icon_url: null, icon_emoji: null },
};
const noop = () => {};
const form = (over) => renderToHtml(createElement(NeedsVoteForm, {
  row: reelRows([item])[0], side: 'yes', line: '',
  onSide: noop, onLine: noop, onBoxKey: noop, onCancel: noop, onSend: noop,
  ...(over || {}),
}));

test('pressing Vote on a Needs you row opens the sheet, and the sheet holds the inline form', () => {
  assert.match(WORKSHOP, /data-ws-rail-btn="vote"[\s\S]{0,400}?onClick=\{\(\) => toggleSheet\('vote'\)\}/, 'Vote opens the vote sheet');
  const sheet = WORKSHOP.slice(WORKSHOP.indexOf('data-ws-sheet="vote"'), WORKSHOP.indexOf('dev-ws-keys-hint'));
  assert.match(sheet, /<NeedsVoteForm\b/, 'and the sheet draws the form');
  assert.ok(!/data-ws-answer-btn="(yes|no)"/.test(sheet), 'not the bare Yes/No pair that led to the prompt card');
});

test('the form is the card\'s vote picker: the switch, the line for the group, Cancel and the send', () => {
  const html = form();
  assert.match(html, /^<div class="dev-ws-vote-form" data-ws-vote-form="" data-side="yes">/);
  assert.match(html, /class="dev-vote-switch"/, 'the card\'s Yes/No switch');
  assert.match(html, /class="dev-vote-switch-opt dev-vote-switch-yes" aria-pressed="true"[^>]*data-act="castVote"/, 'Yes on by default, voting with castVote');
  assert.match(html, /<label class="dev-vote-reason-label" for="dev-ws-vote-reason-needs-proposal-42">Add a line for the group, if you like\.<\/label>/,
    'the line for the group is right there, labelled as on a card');
  assert.match(html, /<textarea id="dev-ws-vote-reason-needs-proposal-42"[^>]*class="dev-vote-reason-box"/, 'with its box inline');
  assert.match(html, /class="dev-vote-reason-cancel">Cancel</);
  assert.match(html, /class="dev-vote-reason-send dev-vote-reason-send-yes">Vote yes</);
  assert.ok(!/role="dialog"/.test(html), 'nothing in the form is a dialog of its own');
});

test('on No the box asks what is not working, and the send waits for a line', () => {
  const empty = form({ side: 'no' });
  assert.match(empty, /What’s not working for you\? One line is plenty\./);
  assert.match(empty, /class="dev-vote-reason-send dev-vote-reason-send-no" disabled="">Vote no</, 'a No needs its line');
  const filled = form({ side: 'no', line: 'Too dark' });
  assert.match(filled, /class="dev-vote-reason-send dev-vote-reason-send-no">Vote no</);
});

test('#3984: the rail waits in the one word every surface uses, and takes no press while it waits', () => {
  // While the vote is on its way the rail button is disabled and labelled
  // "Voting…" — the same word the chat pill and the card's face use — so a
  // slow round-trip reads as busy rather than as a button doing nothing.
  const rail = WORKSHOP.slice(
    WORKSHOP.indexOf('data-ws-rail-btn="vote"'),
    WORKSHOP.indexOf('data-ws-rail-btn="description"')
  );
  assert.match(rail, /disabled=\{!voted && !!sending\[row\.key\]\}/);
  assert.match(rail, /sending\[row\.key\] \? 'Voting…' : 'Vote'/);
  assert.ok(!WORKSHOP.includes('Sending…'), 'no second word for this state');
});

test('the sheet sends its line with the vote, so castVote does not ask again', () => {
  assert.match(WORKSHOP, /answer\(voteSide, undefined, voteTrimmed \|\| null\)/, 'the form sends its side and its line');
  assert.match(WORKSHOP, /const opts = reason === undefined \? \{ onSend \} : \{ onSend, reason \};/,
    'a line (or null) rides in the options bag; only the swipe leaves it out');
  // castVote asks only when the bag has no `reason` key at all.
  const resolve = APP_VIEW.slice(APP_VIEW.indexOf('  async _resolveVoteReason(vote, opts)'), APP_VIEW.indexOf('  async castVote(sessionId'));
  assert.match(resolve, /hasOwnProperty\.call\(o, 'reason'\)[\s\S]*return AppView\._askVoteReason\(vote\);/);
  // Y and N turn the switch rather than voting by themselves.
  assert.match(WORKSHOP, /\(k === 'y' \|\| k === 'Y'\) && sheet === 'vote'\) \{ setVoteSide\('yes'\); return; \}/);
  assert.match(WORKSHOP, /\(k === 'n' \|\| k === 'N'\) && sheet === 'vote'\) \{ setVoteSide\('no'\); return; \}/);
});

// #22: on a project that is just yours, the Yes line is a note: "for the
// group" spoke to a group a solo project does not have. The form reads who
// the row's project is for from the hub's shared community read
// (community-card.tsx useCommunity), handed in here as that import so the
// answer can be set. The No side is unchanged, its line included.
test('#22: on a solo project the Yes line is a note, asked of the row\'s own project; No is unchanged', () => {
  const real = loadTsx('frontend/src/features/dev-board/workshop/community-card.tsx');
  const asked = [];
  let audience = 'solo';
  const { NeedsVoteForm: SoloForm } = loadTsx('frontend/src/features/dev-board/workshop/workshop.tsx', {
    stubs: {
      './community-card': {
        ...real,
        useCommunity: (slug) => { asked.push(slug); return { audience }; },
      },
    },
  });
  const draw = (over) => renderToHtml(createElement(SoloForm, {
    row: reelRows([item])[0], slug: 'open-project', side: 'yes', line: '',
    onSide: noop, onLine: noop, onBoxKey: noop, onCancel: noop, onSend: noop,
    ...(over || {}),
  }));

  const yes = draw();
  assert.match(yes, /<label class="dev-vote-reason-label" for="dev-ws-vote-reason-needs-proposal-42">Add a note, if you like\.<\/label>/);
  assert.doesNotMatch(yes, /for the group/);
  assert.deepEqual(asked.slice(-1), ['demo-app'], 'the row\'s project, not the page\'s');

  const no = draw({ side: 'no' });
  assert.match(no, /What’s not working for you\? One line is plenty\./);
  assert.match(no, /class="dev-vote-reason-send dev-vote-reason-send-no" disabled="">Vote no</, 'No still needs its line');

  audience = 'invited';
  assert.match(draw(), /Add a line for the group, if you like\./, 'a group keeps its wording');
  assert.match(WORKSHOP, /<NeedsVoteForm\s+row=\{row\}\s+slug=\{slug\}/, 'the sheet hands the form the page\'s project for rows without their own');
});
