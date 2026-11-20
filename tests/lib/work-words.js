'use strict';

// A standing's words, as the server sends them (11 Nov 2026, one model).
//
// The server words every standing once (src/services/work-state.js
// phrasesOf, over the one table src/services/work-stages.json) and ships the
// phrase ids as `words`: the stage as its requester reads it, as anyone else
// does, and its second line. The client only draws them
// (frontend/src/lib/work-state.ts stageWords, lineWords). A test that hands a
// screen a work state by its stage, why, reason and line uses `withWords` to
// give it the words the server would have sent with it, so a fixture is the
// contract's shape.
//
// 19 Nov 2026 (review B5): this used to be a table kept by hand beside the
// server's, which had fallen four line codes behind it (`credit_wait`,
// `github_stuck`, `fixing_check`, `bot_fix_failed` read as no words at all,
// and their stage words as the plain stage's). It asks the server now, so a
// fixture can never say words the server would not have sent with that
// stage and line. tests/lib/stored-row.js goes one step further and builds
// the whole stored row (shapeOf, forViewer).

const workState = require('../../src/services/work-state');

/** The words the server sends with a work state. */
function wordsOf(item) {
  return workState.phrasesOf({ why: null, reason: null, line: null, ...item });
}

/** A work state with the words the server sends with it (a fixture in the contract's shape). */
function withWords(item) {
  return item && item.stage ? { ...item, words: wordsOf(item) } : item;
}

module.exports = { wordsOf, withWords };
