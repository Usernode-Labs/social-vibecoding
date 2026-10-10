'use strict';

// #2480: one noun for a vote row across the Workshop's row sheets.
//
// A vote row is a CHANGE everywhere the Workshop talks about it — the item
// summary ("No plain-language summary was written for this change."), the
// Ask sheet's title and its screen-reader label ("Ask about this change") —
// except in the Comments sheet, whose subtitle read "on this proposal". Same
// row, same sheet stack, two words for it, and "proposal" is also the name
// of a different thing on this board (the card in the review lane).
//
// The rule this pins is the vocabulary, not one string: within the Workshop
// sheets, a vote row is a change and an issue is an issue.
//
// Out of scope, deliberately: dev-card.tsx's "Edit this proposal title"
// tooltip. That is the CARD, not a Workshop row sheet, and there the thing
// being edited really is the pull request's title.
//
// Run with: node --test tests/workshop-vote-row-noun.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { message } = require('./lib/platform-i18n');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend/src/features/dev-board/workshop/workshop.tsx'), 'utf8'
);
// The sheets' words are catalog entries now (frontend/locales/en/project.json,
// under `needsYou.`), so the vocabulary is checked there as well.
const SHEET_TEXTS = Object.entries(JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'frontend/locales/en/project.json'), 'utf8'
))).filter(([key]) => key.startsWith('needsYou.')).map(([key, entry]) => [key, entry.text]);

test('no Workshop row sheet calls a vote row a proposal', () => {
  const hits = [...SRC.matchAll(/\bthis proposal\b/g)]
    .map((m) => SRC.slice(0, m.index).split('\n').length);
  assert.deepEqual(hits, [],
    `a vote row is a "change" in these sheets; lines: ${hits.join(', ')}`);
  assert.ok(SHEET_TEXTS.length > 50, 'the sheets\' entries are found');
  // "Open the proposal" names the page the link opens, which is the proposal's.
  assert.deepEqual(SHEET_TEXTS.filter(([, text]) => /\bthis proposal\b/.test(text)).map(([key]) => key), []);
});

test('the sheets that name a vote row all say "change"', () => {
  // The Comments sheet subtitle — the one that disagreed.
  assert.match(SRC, /row\.kind === 'vote' \? 'project:needsYou\.comments\.countChange' : 'project:needsYou\.comments\.countRequest'/);
  assert.match(SRC, /row\.kind === 'vote' \? 'project:needsYou\.comments\.titleChange' : 'project:needsYou\.comments\.titleRequest'/);
  assert.equal(message('project:needsYou.comments.countChange', { count: 3 }), '<0>3 comments</0><1>on this change</1>');
  assert.equal(message('project:needsYou.comments.titleChange'), '<0>Comments</0><1>on this change</1>');
  // The two that were already right, kept so the pair cannot drift apart.
  assert.match(SRC, /kind === 'vote' \? t\('project:needsYou\.ask\.titleChange'\) : t\('project:needsYou\.ask\.titleRequest'\)/);
  assert.equal(message('project:needsYou.ask.titleChange'), 'Ask about this change');
  assert.match(SRC, /\{t\('project:needsYou\.ask\.fieldLabel'\)\}<\/label>/);
  assert.equal(message('project:needsYou.ask.fieldLabel'), 'Ask about this change');
  assert.match(SRC, /isVote \? t\('project:needsYou\.noSummary\.change'\) : t\('project:needsYou\.noSummary\.request'\)/);
  assert.equal(message('project:needsYou.noSummary.change'), 'No plain-language summary was written for this change.');
  assert.equal(message('project:needsYou.description.noSummary'), 'No plain-language summary was written for this change.');
});

test('an issue row is still an issue', () => {
  assert.equal(message('project:needsYou.comments.countRequest', { count: 1 }), '<0>1 comment</0><1>on this request</1>');
  assert.equal(message('project:needsYou.comments.titleRequest'), '<0>Comments</0><1>on this request</1>');
  assert.equal(message('project:needsYou.ask.titleRequest'), 'Ask about this request');
  assert.equal(message('project:needsYou.noSummary.request'), 'This request has no description.');
  assert.equal(message('project:needsYou.description.noDescription'), 'This request has no description.');
});
