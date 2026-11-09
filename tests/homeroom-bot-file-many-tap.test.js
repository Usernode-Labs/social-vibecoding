'use strict';

// #6305: File on all under a many-project card. A pick names a row and the
// project it files on; a pick that names anything else is refused and
// nothing files. Only the person the card was offered to may decide it, and
// only once. Nothing files before the tap.

const test = require('node:test');
const assert = require('node:assert/strict');

const fileManySvc = require('../src/services/homeroom-bot-file-many');
const card = require('../src/services/homeroom-bot-cards/file-many');

const ROWS = [
  { named: 'Game Corner', match: 'exact', slug: 'game-corner', name: 'Game Corner', choices: [], done: 'Game Corner already lets guests play.', disabled: null, ticked: false },
  { named: 'Block World', match: 'guess', slug: null, name: 'Block World', choices: [{ slug: 'block-game', name: 'block-game' }], done: null, disabled: null, ticked: false },
  { named: 'ViaTales', match: 'exact', slug: 'viatales', name: 'ViaTales', choices: [], done: null, disabled: null, ticked: true },
  { named: 'Sam Shop', match: 'exact', slug: 'sam-shop', name: 'Sam Shop', choices: [], done: null, disabled: 'not_member', ticked: false },
];

test('#6305: a pick is an index and a slug', () => {
  assert.deepEqual(fileManySvc.parsePick('2:viatales'), { index: 2, slug: 'viatales' });
  assert.equal(fileManySvc.parsePick('viatales'), null);
  assert.equal(fileManySvc.parsePick('2:not a slug!'), null);
  assert.equal(fileManySvc.parsePick(''), null);
});

test('#6305: a pick may file only on the row\'s match or one of its choices', () => {
  assert.deepEqual(fileManySvc.validPicks(ROWS, ['0:game-corner', '2:viatales']).map((p) => p.slug), ['game-corner', 'viatales']);
  // The "Did you mean" row files on the project that was picked.
  assert.deepEqual(fileManySvc.validPicks(ROWS, ['1:block-game']).map((p) => p.slug), ['block-game']);
  // A slug the row does not offer is refused, and so is a row they cannot file on.
  assert.equal(fileManySvc.validPicks(ROWS, ['0:viatales']), null);
  assert.equal(fileManySvc.validPicks(ROWS, ['3:sam-shop']), null);
  // An index that is not a row.
  assert.equal(fileManySvc.validPicks(ROWS, ['9:viatales']), null);
  // The same row twice is one pick.
  assert.equal(fileManySvc.validPicks(ROWS, ['2:viatales', '2:viatales']).length, 1);
  assert.equal(fileManySvc.validPicks(ROWS, []), null);
});

/** A pool whose card claim answers as the message's metadata would. */
function poolWith({ state = 'open', forUserId = 7 } = {}) {
  const updates = [];
  return {
    updates,
    query: async (sql, params = []) => {
      if (/UPDATE conversation_messages/.test(sql)) {
        updates.push({ sql, params });
        if (state !== 'open' || String(params[1]) !== String(forUserId)) return { rows: [] };
        return { rows: [{ metadata: { homeroomBot: { card: { type: 'file_many', state, forUserId, title: 'T', details: 'D', rows: ROWS } } } }] };
      }
      return { rows: [] };
    },
  };
}

const message = { id: 21, conversationId: 11, botId: 900, threadRootId: null };

test('#6305: only the person it was offered to decides the card', async () => {
  const out = await card.decide({ query: async () => ({ rows: [] }) }, {}, {
    user: { id: 8 }, card: { type: 'file_many', state: 'open', forUserId: 7, rows: ROWS }, action: 'file', value: ['2:viatales'], message,
  });
  assert.equal(out.ok, false);
  assert.equal(out.status, 403);
});

test('#6305: File on all with nothing ticked is refused', async () => {
  const out = await card.decide(poolWith(), {}, {
    user: { id: 7 }, card: { type: 'file_many', state: 'open', forUserId: 7, rows: ROWS }, action: 'file', value: [], message,
  });
  assert.equal(out.ok, false);
  assert.equal(out.status, 400);
});

test('#6305: Not now puts the whole card away', async () => {
  const out = await card.decide(poolWith(), {}, {
    user: { id: 7 }, card: { type: 'file_many', state: 'open', forUserId: 7, rows: ROWS }, action: 'dismiss', value: null, message,
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.patch, { state: 'dropped' });
});

test('#6305: a card that is already decided files nothing more', async () => {
  const out = await card.decide(poolWith({ state: 'filed' }), {}, {
    user: { id: 7 }, card: { type: 'file_many', state: 'filed', forUserId: 7, rows: ROWS }, action: 'file', value: ['2:viatales'], message,
  });
  assert.equal(out.ok, false);
  assert.equal(out.status, 409);
  assert.match(out.error, /already decided/);
});

test('#6305: the card reads back to the model as one offer on several projects', () => {
  const line = card.historyLine({ state: 'filed', rows: [{ name: 'ViaTales', issueNumber: 41 }, { name: 'Game Corner' }] });
  assert.match(line, /one request on 2 projects: ViaTales, Game Corner/);
  assert.match(line, /filed #41/);
  assert.match(card.historyLine({ state: 'open', rows: [{ name: 'ViaTales' }] }), /not filed yet/);
});
