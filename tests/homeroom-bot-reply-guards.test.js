'use strict';

// #6346: the guards a turn's answer passes, shared by the voice (request
// threads) and the chat's own rounds (src/services/homeroom-bot-mayor.js).
// The voice keeps sending exactly the words it sent before; the chat names
// its own ending instead of update_change.

const test = require('node:test');
const assert = require('node:assert/strict');

const guards = require('../src/services/homeroom-bot-reply-guards');
const voice = require('../src/services/homeroom-bot-voice');
const mayor = require('../src/services/homeroom-bot-mayor');

test('a stand-in word is not an answer, and a short real one is', () => {
  for (const text of ['placeholder', 'TODO', '[TBD]', '...', 'text', 'Reply', '  ???  ', '']) {
    assert.equal(guards.isStandIn(text), true, JSON.stringify(text));
  }
  for (const text of ['No.', 'Yes.', 'Yes: a thread you started from Main still links out.', 'Non, ce n\'est pas le cas.', 'いいえ。']) {
    assert.equal(guards.isStandIn(text), false, JSON.stringify(text));
  }
  assert.deepEqual(guards.STAND_IN_WORDS, ['placeholder', 'todo', 'tbd', 'text', 'reply']);
});

test('the voice and the chat share one copy of the check', () => {
  assert.equal(voice.isStandIn, guards.isStandIn);
});

test('the voice sends exactly the sentences it sent before', () => {
  assert.equal(
    guards.lastRoundNote('queue the change they asked for with update_change'),
    'This is your last round. Answer now with what you have, or queue the change they asked for with update_change. You cannot read anything more.',
  );
  assert.equal(
    guards.standInNote('queue the change with update_change'),
    'That reply is a stand-in, not an answer. Write the real answer to what they said now, or queue the change with update_change.',
  );
  assert.equal(
    guards.readingDoneNote('queue the change with update_change'),
    'Your reading for this turn is done. Answer with what you know, or queue the change with update_change.',
  );
});

test('the chat names its own way to end a turn, and caps its source reads', () => {
  assert.equal(
    guards.lastRoundNote('offer the draft they asked for'),
    'This is your last round. Answer now with what you have, or offer the draft they asked for. You cannot read anything more.',
  );
  assert.equal(
    guards.standInNote('offer the draft they asked for'),
    'That reply is a stand-in, not an answer. Write the real answer to what they said now, or offer the draft they asked for.',
  );
  assert.equal(
    guards.readingDoneNote('offer the draft they asked for'),
    'Your reading for this turn is done. Answer with what you know, or offer the draft they asked for.',
  );
  assert.equal(mayor.MAX_SOURCE_READS_PER_TURN, 8);
});
