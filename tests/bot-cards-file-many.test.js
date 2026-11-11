'use strict';

// #6305: the "file_many" card in the chat with Homeroom bot: one row per
// project, a tick each, "Did you mean ...?" choices on the row, the
// already-done sentence, and one File on all that is disabled until a row is
// ticked. The component reads the card defensively; the words live in the
// language catalog and both registries know the type.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const card = read('frontend/src/features/messages/bot-cards/file-many.tsx');
const registry = read('frontend/src/features/messages/bot-cards/registry.ts');
const server = read('src/services/homeroom-bot-cards/index.js');
const messages = JSON.parse(read('frontend/locales/en/messages.json'));

test('#6305: both registries have file_many', () => {
  assert.match(registry, /file_many: FileManyCard/);
  assert.match(server, /file_many: \(\) => require\('\.\/file-many'\)/);
});

test('#6305: the card reads its rows defensively', () => {
  assert.match(card, /Array\.isArray\(card\.rows\)/);
  assert.match(card, /match === 'guess' \|\| row\.match === 'none'/);
  assert.match(card, /slice\(0, 3\)/, 'at most three closest projects');
});

test('#6305: File on all is disabled with no ticks', () => {
  assert.match(card, /disabled=\{busy \|\| !picks\.length\}/);
  assert.match(card, /data-bot-file-many-action="file"/);
  assert.match(card, /data-bot-file-many-action="not-now"/);
});

test('#6305: every word the card says is a catalog entry with a description', () => {
  for (const key of [
    'label_one', 'label_other', 'matches', 'didYouMean', 'noMatch', 'alreadyDone',
    'notMember', 'fileOnAll', 'notNow', 'counts', 'filed', 'failed', 'busy', 'tick',
  ]) {
    const entry = messages[`botCards.fileMany.${key}`];
    assert.ok(entry, `messages:botCards.fileMany.${key} exists`);
    assert.equal(typeof entry.text, 'string');
    assert.ok(entry.text.trim(), `messages:botCards.fileMany.${key} has text`);
    assert.equal(typeof entry.description, 'string');
    assert.ok(entry.description.trim().length > 20, `messages:botCards.fileMany.${key} says where it appears`);
  }
});

test('#6305: a project\'s thread draws the same rows and sends which are ticked', () => {
  const transcript = read('frontend/src/features/group-chat/transcript.tsx');
  const legacy = read('public/js/group-chat.js');
  assert.match(transcript, /offer\.kind === 'file_many'/);
  assert.match(transcript, /FileManyRows/);
  assert.match(legacy, /bot\.offer\.rows/);
  assert.match(legacy, /decideBotOffer\(messageId, choice, rows, offerId\)/);
});
