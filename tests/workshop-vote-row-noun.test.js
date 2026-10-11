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
// sheets, a vote row is a change. (Requests left the feed with the reel
// redesign, so the sheets no longer have a word for one at all.)
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
  // The Ask tab's field and its hint, and the caption with no summary.
  assert.match(SRC, /\{t\('project:needsYou\.ask\.fieldLabel'\)\}<\/label>/);
  assert.equal(message('project:needsYou.ask.fieldLabel'), 'Ask about this change');
  assert.match(SRC, /\{summary \|\| t\('project:needsYou\.noSummary\.change'\)\}/);
  assert.equal(message('project:needsYou.noSummary.change'), 'No plain-language summary was written for this change.');
  // The end card counts changes, as the cards above it do.
  assert.equal(message('project:needsYou.end.reviewedAll', { count: 4 }), 'You reviewed all 4 changes that were waiting on you.');
});

test('the feed is changes and group decisions alone: no request wording is left in it', () => {
  // Requests nobody has picked up left the queue (they are the group's to
  // take, offered on the Hub and the Workshop), and with them every word the
  // sheets had for one.
  const ids = SHEET_TEXTS.map(([key]) => key);
  for (const gone of ['needsYou.comments.countRequest_one', 'needsYou.comments.titleRequest', 'needsYou.ask.titleRequest',
    'needsYou.noSummary.request', 'needsYou.eyebrow.request', 'needsYou.rail.take', 'needsYou.by.filed']) {
    assert.ok(!ids.includes(gone), `${gone} is gone`);
  }
  assert.doesNotMatch(SRC, /project:needsYou\.[\w.]*[Rr]equest\b/, 'and nothing asks for one');
  assert.ok(!SHEET_TEXTS.some(([, text]) => /\bthis request\b/.test(text)), 'no sheet calls a row "this request"');
});
