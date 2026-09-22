'use strict';

// #2641: "Long GLM responses seem to be getting truncated" — reported by an
// admin, twice in a row, on responses that were "not even that long".
//
// They were being truncated, in src/routes/sessions.js, by this line:
//
//     toolResultText: summaryParts.join('\n\n').slice(0, 4000)
//
// `summaryParts` is described in its own declaration as what "we feed back
// to the Mayor as tool_result content", and for a coding turn that is
// exactly what it is — so bounding it is right, because an unbounded agent
// summary crowds out the Mayor's context.
//
// A DIRECT SESSION TURN is not that. It is the single-provider OpenRouter
// path, whose own comment in sessions.js says "no Anthropic Mayor, wrap-up,
// or quick-reply generation runs around it" — so there is no prompt to
// protect. The branch above unshifts the agent's own text onto
// `summaryParts`:
//
//     summaryParts.unshift(directChatReply ? ccText : `What the agent did:…`)
//
// and the caller hands the result straight to an INSERT into
// `chat_session_messages.content` — a TEXT column, no limit of its own —
// as the assistant's message, for the person who asked. So the prompt bound
// was cutting a user-facing answer at 4000 characters, which is roughly six
// hundred words: "not even that long".
//
// The cap is keyed on `directSessionTurn` rather than on `directChatReply`
// (which additionally requires `!hasChanges`) because a direct turn that
// COMMITTED something persists its summary exactly as directly, and a long
// build summary was being cut the same way.
//
// These are source-level assertions because the function they live in is a
// ~1400-line turn driver that needs a worker, a container and a database to
// run. What can be pinned without all that is the shape of the decision:
// that the bound is named, that it still applies to the Mayor's tool
// result, and that it does not apply to the direct reply.
//
// Run with: node --test tests/long-reply-truncation.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(root, 'src', 'routes', 'sessions.js'), 'utf8');

test('the bound is a named constant, not a number sprinkled through the file', () => {
  assert.match(SRC, /const MAYOR_TOOL_RESULT_CHAR_MAX = 4000;/);
  // The literal must not survive anywhere it used to cap a summary: a
  // second copy is how one of these gets fixed and the other does not.
  const stray = SRC.match(/summaryParts\.join\([^)]*\)\.slice\(0, 4000\)/g) || [];
  assert.deepEqual(stray, [], 'a raw 4000 still caps a summary somewhere');
});

test('a direct session turn is NOT cut at the prompt bound', () => {
  // The whole fix: on the direct path the joined text is used as-is.
  assert.match(SRC, /const toolResultText = \(directSessionTurn\s*\n\s*\? summaryText\s*\n\s*: summaryText\.slice\(0, MAYOR_TOOL_RESULT_CHAR_MAX\)\) \|\| fallbackSummary;/,
    'the direct reply must bypass the slice, not be sliced more politely');
});

test('the bound is lifted for the whole direct path, not only a chat answer', () => {
  // Review's finding, and the reason the condition is `directSessionTurn`
  // rather than `directChatReply`. The latter requires `!hasChanges`, so a
  // direct turn that COMMITTED something would have kept the cap — and the
  // caller persists its summary just as directly, with no Mayor in between.
  // A long build summary was cut in exactly the same way as a long answer.
  assert.match(SRC, /const directChatReply = directSessionTurn && !hasChanges && !isError;/,
    'directChatReply still exists, and is still the narrower thing');
  const decision = SRC.slice(SRC.indexOf('const toolResultText = ('), SRC.indexOf('|| fallbackSummary;'));
  assert.doesNotMatch(decision, /directChatReply/,
    'the cap decision must not be keyed on whether files changed');

  // And the reason it is safe: this path has no Mayor to protect.
  assert.match(SRC, /no Anthropic\n\s*\/\/ Mayor, wrap-up, or quick-reply generation runs around it/,
    'the single-provider contract is what makes this not a prompt');
});

test('the Mayor tool result and the scout summary keep the bound', () => {
  // The bound is not wrong — it is a prompt bound, and both of these really
  // are prompts. Removing it here would be the over-correction.
  const uses = SRC.match(/MAYOR_TOOL_RESULT_CHAR_MAX/g) || [];
  assert.ok(uses.length >= 3, `expected the constant and both bounded sites (${uses.length})`);
  assert.match(SRC, /slice\(0, MAYOR_TOOL_RESULT_CHAR_MAX\)\s*\n\s*\|\| \(isError \? 'Scout did not complete successfully\.'/,
    'scout still bounds what it hands the Mayor');
});

test('the assistant message column has no length of its own to respect', () => {
  // The reason lifting the bound is safe rather than merely nicer: the
  // destination is TEXT. If this ever became a VARCHAR, an uncapped reply
  // would start failing the INSERT instead of arriving truncated.
  const schema = fs.readFileSync(path.join(root, 'src', 'db', 'schema.sql'), 'utf8');
  const table = schema.slice(
    schema.indexOf('CREATE TABLE IF NOT EXISTS chat_session_messages'),
    schema.indexOf(');', schema.indexOf('CREATE TABLE IF NOT EXISTS chat_session_messages')),
  );
  assert.match(table, /content\s+TEXT NOT NULL/,
    'an uncapped reply is only safe while this column is unbounded');
});

// What this change deliberately does NOT do, recorded so the next reader
// does not "finish the job".
test('the 300-character progress preview is untouched, and is a different thing', () => {
  // codex-openrouter.js emits agent_message with BOTH a short `text` (the
  // activity line that scrolls past while the turn runs) and the complete
  // `fullText`. The preview is meant to be short. It is not the answer, and
  // worker.js already stores the full version as the turn result.
  const agent = fs.readFileSync(path.join(root, 'src', 'agents', 'codex-openrouter.js'), 'utf8');
  assert.match(agent, /text: String\(txt\)\.slice\(0, 300\),\s*\n\s*fullText: String\(txt\),/,
    'the preview and the full text must stay two separate fields');
  const worker = fs.readFileSync(path.join(root, 'src', 'services', 'worker.js'), 'utf8');
  assert.match(worker, /ev\.kind === 'agent_message' && ev\.fullText != null/);
  assert.match(worker, /state\.lastResultText = ev\.fullText;/,
    'the turn result reads the full text, never the preview');
});
