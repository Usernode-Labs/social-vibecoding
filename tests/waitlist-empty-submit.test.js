// The stage-2 survey refuses a submission that says nothing (#1539).
//
// Every question on that form is optional and the endpoint accepts an empty
// body, so pressing Save with nothing filled in stored nothing and answered
// with the same "thanks" panel a full set of answers gets. The one thing the
// form exists to collect could be skipped by pressing the button, and nothing
// said so.
//
// The rule is "at least one", never "this particular one": each question stays
// optional, and a chip, a select, a handle or the follow tick all count.
//
// The guard is on SUBMIT rather than a disabled button, because every field on
// this screen is uncontrolled by design (more.tsx's header comment explains
// why) — a live-disabled control would mean lifting all sixteen into React
// state to answer a question that only matters once.
//
// Run with: node --test tests/waitlist-empty-submit.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const MORE = 'frontend/src/features/auth/more.tsx';

/** The shape onSubmit builds when nothing at all has been filled in. */
const EMPTY = {
  made_url: undefined,
  made_note: undefined,
  group_name: undefined,
  group_size: undefined,
  group_role: undefined,
  group_tools: [],
  group_need: undefined,
  had_loss: undefined,
  loss_product: undefined,
  loss_kind: [],
  loss_story: undefined,
  farcaster: undefined,
  discord: undefined,
  telegram: undefined,
  other_handle: undefined,
  followed_claim: false,
};

test('an untouched form has no answer in it', () => {
  const { hasAnyAnswer } = loadTsx(MORE);
  assert.equal(hasAnyAnswer(EMPTY), false);
  // Whitespace is not an answer either — the fields are trimmed on the way in,
  // but the helper must not depend on that having happened.
  assert.equal(hasAnyAnswer({ ...EMPTY, group_need: '   ' }), false);
});

test('any single answer is enough, whatever shape it takes', () => {
  const { hasAnyAnswer } = loadTsx(MORE);
  // Free text …
  assert.equal(hasAnyAnswer({ ...EMPTY, loss_story: 'They shut it down.' }), true);
  // … a select …
  assert.equal(hasAnyAnswer({ ...EMPTY, group_size: '50-200' }), true);
  // … a chip row …
  assert.equal(hasAnyAnswer({ ...EMPTY, group_tools: ['discord'] }), true);
  // … a single-choice chip …
  assert.equal(hasAnyAnswer({ ...EMPTY, had_loss: 'yes' }), true);
  // … or just the follow tick, which is a claim and still an answer.
  assert.equal(hasAnyAnswer({ ...EMPTY, followed_claim: true }), true);
});

test('the submit path checks before it posts, and says so in the status line', () => {
  const src = fs.readFileSync(path.join(ROOT, MORE), 'utf8');
  const submit = src.slice(src.indexOf('const onSubmit'));
  const guard = submit.indexOf('if (!hasAnyAnswer(answers))');
  const post = submit.indexOf("fetch('/api/public/waitlist/more/");
  assert.ok(guard !== -1, 'the guard is in the submit handler');
  assert.ok(guard < post, 'nothing is posted until the check has run');
  assert.match(submit, /Answer at least one question before saving\./);
  assert.match(submit, /tone: 'warn'/,
    'an empty save is a nudge, not an error the server returned');
  // The spinner must not be left running by the early return.
  assert.ok(submit.indexOf('setSaving(true)') > guard,
    'saving is only entered once the submission is going to happen');
});
