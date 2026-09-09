// Tests for the silent-turn guards (src/routes/sessions.js): a Mayor
// turn must never end with nothing visible. Covers the three pure
// helpers behind the fix diagnosed from production session 2383:
//
// - salvageAssistantText — synthesizes assistant text when the model's
//   reply was ONLY a suggest_answers/suggest_replies tool_use with no
//   text block (the observed bug: questions/chips were dropped and the
//   turn ended silently).
// - needsEmptyReplyFallback — the broadened "would this turn end with
//   nothing visible?" condition (the old check required
//   toolUses.length === 0, so a lone tool_use slipped through).
// - describeTurnError — the user-facing mapping for mid-turn provider
//   errors persisted by the chat handler's catch.
//
// Run with: node --test tests/silent-turn-fallback.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  salvageAssistantText,
  needsEmptyReplyFallback,
  shouldRepromptForDataSummary,
  buildDataSummaryReprompt,
  DATA_SUMMARY_FALLBACK_TEXT,
  describeTurnError,
} = require('../src/routes/sessions.js');

// ---- salvageAssistantText ----

test('salvage: existing text is returned verbatim, suggestions ignored', () => {
  const suggestions = [{ question: 'Which theme?', answers: ['Dark', 'Light'] }];
  assert.equal(salvageAssistantText('Already said something', suggestions, null), 'Already said something');
  // Untrimmed-but-nonempty text passes through untouched.
  assert.equal(salvageAssistantText('  hi  ', null, null), '  hi  ');
});

test('salvage: suggestions-only reply becomes the numbered questions', () => {
  const suggestions = [
    { question: 'Which theme?', answers: ['Dark', 'Light'] },
    { question: 'Mobile too?', answers: ['Yes', 'No'] },
  ];
  assert.equal(
    salvageAssistantText('', suggestions, null),
    '1. Which theme?\n2. Mobile too?'
  );
});

test('salvage: single question still gets a number', () => {
  const suggestions = [{ question: 'Which theme?', answers: ['Dark'] }];
  assert.equal(salvageAssistantText('   ', suggestions, null), '1. Which theme?');
});

test('salvage: suggestions with empty question labels fall back to a generic ask', () => {
  // sanitizeSuggestedAnswers keeps entries whose answers survived even
  // when the question label trimmed to '' — the chips still render.
  const suggestions = [{ question: '', answers: ['Dark', 'Light'] }];
  assert.equal(
    salvageAssistantText('', suggestions, null),
    'I have a couple of clarifying questions. Pick an answer below.'
  );
});

test('salvage: pills-only reply gets the generic next-step line', () => {
  assert.equal(
    salvageAssistantText('', null, ['Build it', 'Revise the spec']),
    'What would you like to do next?'
  );
});

test('salvage: suggestions win over pills when both are present', () => {
  const suggestions = [{ question: 'Which theme?', answers: ['Dark'] }];
  assert.equal(salvageAssistantText('', suggestions, ['Build it']), '1. Which theme?');
});

test('salvage: nothing to salvage returns empty string', () => {
  assert.equal(salvageAssistantText('', null, null), '');
  assert.equal(salvageAssistantText(null, null, null), '');
  assert.equal(salvageAssistantText(undefined, [], []), '');
});

// ---- needsEmptyReplyFallback ----

test('fallback: fires for a lone suggest_answers with unusable input', () => {
  assert.equal(needsEmptyReplyFallback('', [{ name: 'suggest_answers' }]), true);
});

test('fallback: fires for a dangling data tool_use (data-loop cap break)', () => {
  assert.equal(needsEmptyReplyFallback('', [{ name: 'list_github_issues' }]), true);
  assert.equal(needsEmptyReplyFallback('', [{ name: 'get_github_issue' }]), true);
  assert.equal(needsEmptyReplyFallback('', [{ name: 'web_fetch' }]), true);
});

test('fallback: fires when there are no tool uses at all', () => {
  assert.equal(needsEmptyReplyFallback('', []), true);
  assert.equal(needsEmptyReplyFallback('   ', null), true);
});

test('fallback: does NOT fire when a dispatch tool is present', () => {
  assert.equal(needsEmptyReplyFallback('', [{ name: 'dispatch_scout' }]), false);
  assert.equal(needsEmptyReplyFallback('', [{ name: 'dispatch_claude_code' }]), false);
  // Even alongside other tool_uses.
  assert.equal(
    needsEmptyReplyFallback('', [{ name: 'list_github_issues' }, { name: 'dispatch_claude_code' }]),
    false
  );
});

test('fallback: does NOT fire when text survived', () => {
  assert.equal(needsEmptyReplyFallback('All good.', []), false);
  assert.equal(needsEmptyReplyFallback('All good.', [{ name: 'suggest_replies' }]), false);
});

test('fallback: tolerates malformed tool-use entries', () => {
  assert.equal(needsEmptyReplyFallback('', [null, undefined, {}]), true);
});

// ---- shouldRepromptForDataSummary (session 2426) ----

const RAW_SUGGEST_ONLY = [{ type: 'tool_use', id: 'tu_1', name: 'suggest_replies', input: { replies: ['Dig deeper'] } }];

test('reprompt: fires for a tool-only reply after a serviced data round', () => {
  assert.equal(
    shouldRepromptForDataSummary('', [{ name: 'suggest_replies', id: 'tu_1' }], 1, RAW_SUGGEST_ONLY),
    true
  );
});

test('reprompt: fires for a fully empty reply after a data round with raw content', () => {
  // stop_reason end_turn with a lone (unusable) tool block but no text.
  assert.equal(shouldRepromptForDataSummary('   ', [], 2, RAW_SUGGEST_ONLY), true);
});

test('reprompt: does NOT fire when no data tools were serviced this turn', () => {
  assert.equal(
    shouldRepromptForDataSummary('', [{ name: 'suggest_replies', id: 'tu_1' }], 0, RAW_SUGGEST_ONLY),
    false
  );
});

test('reprompt: does NOT fire when the reply has text', () => {
  assert.equal(
    shouldRepromptForDataSummary('Here is what I found.', [{ name: 'suggest_replies', id: 'tu_1' }], 1, RAW_SUGGEST_ONLY),
    false
  );
});

test('reprompt: does NOT fire on dispatch turns — phase-2 produces output', () => {
  assert.equal(
    shouldRepromptForDataSummary('', [{ name: 'dispatch_claude_code', id: 'tu_1' }], 1, RAW_SUGGEST_ONLY),
    false
  );
});

test('reprompt: does NOT fire without replayable raw content', () => {
  assert.equal(shouldRepromptForDataSummary('', [{ name: 'suggest_replies', id: 'tu_1' }], 1, []), false);
  assert.equal(shouldRepromptForDataSummary('', [{ name: 'suggest_replies', id: 'tu_1' }], 1, null), false);
});

// ---- buildDataSummaryReprompt ----

test('reprompt build: replays the reply verbatim and closes every tool_use', () => {
  const toolUses = [
    { id: 'tu_1', name: 'suggest_replies' },
    { id: 'tu_2', name: 'get_prod_status' }, // dangling data call (cap break)
  ];
  const raw = [
    { type: 'tool_use', id: 'tu_1', name: 'suggest_replies', input: {} },
    { type: 'tool_use', id: 'tu_2', name: 'get_prod_status', input: {} },
  ];
  const msgs = buildDataSummaryReprompt(raw, toolUses);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'assistant');
  assert.equal(msgs[0].content, raw);
  assert.equal(msgs[1].role, 'user');
  const results = msgs[1].content.filter((b) => b.type === 'tool_result');
  assert.deepEqual(results.map((b) => b.tool_use_id), ['tu_1', 'tu_2']);
  // The instruction text comes last so it reads after the tool closes.
  const last = msgs[1].content[msgs[1].content.length - 1];
  assert.equal(last.type, 'text');
  assert.match(last.text, /summarize/i);
  assert.match(last.text, /Do not call any tools/);
});

test('reprompt build: tolerates malformed tool-use entries', () => {
  const msgs = buildDataSummaryReprompt(RAW_SUGGEST_ONLY, [null, {}, { id: 'tu_1', name: 'suggest_replies' }]);
  const results = msgs[1].content.filter((b) => b.type === 'tool_result');
  assert.deepEqual(results.map((b) => b.tool_use_id), ['tu_1']);
  // Still ends with the instruction even when no tool_use had an id.
  const bare = buildDataSummaryReprompt(RAW_SUGGEST_ONLY, null);
  assert.equal(bare[1].content.length, 1);
  assert.equal(bare[1].content[0].type, 'text');
});

test('reprompt fallback text is explicit about the unsummarized fetch', () => {
  assert.match(DATA_SUMMARY_FALLBACK_TEXT, /fetched the data/);
  assert.notEqual(DATA_SUMMARY_FALLBACK_TEXT, 'What would you like to do next?');
});

// ---- describeTurnError ----

test('errors: 429 with a readable limit message passes through verbatim', () => {
  const err = Object.assign(new Error('Daily limit reached ($20.00). Resets at midnight UTC.'), { status: 429 });
  assert.equal(describeTurnError(err), 'Daily limit reached ($20.00). Resets at midnight UTC.');
});

test('errors: opaque 429 gets a rate-limit framing', () => {
  const err = Object.assign(new Error('Request rejected'), { status: 429 });
  assert.equal(describeTurnError(err), 'The AI provider rate-limited this request: Request rejected');
});

test('errors: 529 maps to the overloaded line', () => {
  const err = Object.assign(new Error('upstream unavailable'), { status: 529 });
  assert.equal(describeTurnError(err), 'The AI provider is overloaded right now. Try again in a minute.');
});

test('errors: "overloaded" in the message maps even without a status code', () => {
  const err = new Error('Overloaded');
  assert.equal(describeTurnError(err), 'The AI provider is overloaded right now. Try again in a minute.');
});

test('errors: statusCode is honored as an alias for status', () => {
  const err = Object.assign(new Error('Too many requests, budget exhausted'), { statusCode: 429 });
  assert.equal(describeTurnError(err), 'Too many requests, budget exhausted');
});

test('errors: generic errors pass their message through', () => {
  assert.equal(describeTurnError(new Error('socket hang up')), 'socket hang up');
});

test('errors: non-Error inputs are tolerated', () => {
  assert.equal(describeTurnError('plain string failure'), 'plain string failure');
  assert.equal(describeTurnError(null), 'Unknown error');
  assert.equal(describeTurnError(undefined), 'Unknown error');
});
