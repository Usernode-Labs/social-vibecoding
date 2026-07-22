// Tests for the token-consumption optimization work.
//
// Covers the deterministic, LLM-free machinery that replaced per-turn
// model calls and unbounded context growth:
//   - Mayor policy prompt cap + router model pinning (steps 1)
//   - deterministic completion text / quick replies (step 2)
//   - history / spec / text-attachment / data-tool bounds (step 3)
//   - Anthropic prompt-cache block shape (step 4)
//
// Run with: node --test tests/token-optimization.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const models = require('../src/services/models');
const prompts = require('../src/services/prompts');
const attachments = require('../src/services/attachments');
const sessions = require('../src/routes/sessions');

// ── Step 1: compact Mayor policy + fixed router model ─────────────────

test('Mayor router model is pinned to an allowlisted model (claude-sonnet-5 default)', () => {
  assert.equal(typeof models.MAYOR_MODEL, 'string');
  assert.ok(models.isAllowed(models.MAYOR_MODEL), 'MAYOR_MODEL must be in the allowlist');
  // Absent a MAYOR_MODEL override in this env, it's the documented default.
  if (!process.env.MAYOR_MODEL) assert.equal(models.MAYOR_MODEL, 'claude-sonnet-5');
});

test('getMayorPolicy stays under the 12,000-char cap and interpolates the app name', () => {
  assert.equal(prompts.MAYOR_POLICY_MAX_CHARS, 12000);
  const policy = prompts.getMayorPolicy('Acme Widgets');
  assert.equal(typeof policy, 'string');
  assert.ok(policy.length > 0);
  assert.ok(policy.length <= prompts.MAYOR_POLICY_MAX_CHARS,
    `policy is ${policy.length} chars — over the ${prompts.MAYOR_POLICY_MAX_CHARS} cap`);
  assert.ok(policy.includes('Acme Widgets'), 'app name interpolated');
  assert.ok(!policy.includes('{{APP_NAME}}'), 'no leftover placeholder');
});

test('the Mayor policy is the routing doc, NOT the full app-conventions', () => {
  // The whole point of step 1: the router no longer carries the ~66 KB
  // conventions doc. It must be dramatically smaller than conventions.
  const policy = prompts.getMayorPolicy('X');
  const conventions = prompts.getAppConventions();
  assert.ok(conventions.length > policy.length * 2,
    'conventions should be much larger than the compact policy');
});

// ── Step 4: Mayor system prompt = stable prefix + dynamic suffix ──────

test('buildMayorSystemParts keeps the stable prefix byte-identical across per-turn state', () => {
  const spec = 'Some spec';
  const a = sessions.buildMayorSystemParts('App', false, spec, false, null);
  // Vary everything dynamic: worker busy, different spec, a PR, prod-debug.
  const b = sessions.buildMayorSystemParts('App', true, 'A totally different spec', false,
    { prNumber: 7, prTitle: 'Fix', status: 'active' }, '', '', true);
  assert.equal(a.stable, b.stable, 'stable prefix must not vary within an app');
  assert.notEqual(a.dynamic, b.dynamic, 'dynamic suffix reflects per-turn state');
  // Stable prefix carries the routing policy; dynamic carries live spec.
  assert.ok(a.dynamic.includes('Some spec'));
  assert.ok(!a.stable.includes('Some spec'), 'spec belongs to the dynamic half');
});

test('buildMayorSystemBlocks wraps the stable half in a cache_control breakpoint', () => {
  const blocks = sessions.buildMayorSystemBlocks('App', false, 'spec', false, null);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'text');
  assert.deepEqual(blocks[0].cache_control, { type: 'ephemeral' });
  assert.equal(blocks[1].type, 'text');
  assert.equal(blocks[1].cache_control, undefined, 'dynamic block stays uncached');
  // The two-block concatenation equals the plain-string prompt.
  const plain = sessions.getMayorSystemPrompt('App', false, 'spec', false, null);
  assert.equal(blocks[0].text + blocks[1].text, plain);
});

test('the live spec is clipped to MAYOR_SPEC_MAX_CHARS in the Mayor prompt', () => {
  assert.equal(sessions.MAYOR_SPEC_MAX_CHARS, 24000);
  const huge = 'S'.repeat(sessions.MAYOR_SPEC_MAX_CHARS + 5000);
  const { dynamic } = sessions.buildMayorSystemParts('App', false, huge, false, null);
  assert.ok(dynamic.includes('[spec truncated'), 'oversized spec carries a truncation marker');
  // The inlined spec body itself is bounded (marker + framing add a little).
  assert.ok(dynamic.length < huge.length, 'the prompt is smaller than the raw spec');
});

// ── Step 2: deterministic completion text + quick replies ─────────────

test('buildCompletionText composes build results without an LLM', () => {
  // Success with a summary, PR, and staging URL.
  const full = sessions.buildCompletionText({
    toolKind: 'build', isError: false, ccSummary: 'Added a dark-mode toggle.',
    ccOutcome: 'changes', stagingUrl: 'https://x.test', prNumber: 42,
  });
  assert.ok(full.includes('Added a dark-mode toggle.'));
  assert.ok(full.includes('#42'));
  assert.ok(full.includes('https://x.test'));

  // no_changes and error branches are fixed strings.
  assert.match(
    sessions.buildCompletionText({ toolKind: 'build', ccOutcome: 'no_changes' }),
    /didn't need to change any code/);
  assert.match(
    sessions.buildCompletionText({ toolKind: 'build', isError: true }),
    /didn't complete successfully/);

  // Scout success nudges toward building.
  assert.match(
    sessions.buildCompletionText({ toolKind: 'scout', isError: false }),
    /spec/i);

  // A successful build with nothing to say still returns a non-empty body.
  assert.equal(
    sessions.buildCompletionText({ toolKind: 'build', isError: false, ccSummary: '' }),
    '_Done._');
});

test('buildCompletionQuickReplies returns fixed pills per outcome', () => {
  assert.deepEqual(sessions.buildCompletionQuickReplies({ isError: true }),
    ['Try that again', 'What went wrong?']);
  assert.deepEqual(sessions.buildCompletionQuickReplies({ toolKind: 'scout' }),
    ['Build it', 'Revise the spec', 'What will this change?']);
  assert.deepEqual(sessions.buildCompletionQuickReplies({ toolKind: 'build' }),
    ['Preview the change', 'Propose it to the group', 'Make another tweak']);
});

// ── Step 3: deterministic history / data / attachment bounds ──────────

test('boundMayorHistory caps at MAYOR_HISTORY_MAX_TURNS turns, newest kept, order preserved', () => {
  assert.equal(sessions.MAYOR_HISTORY_MAX_TURNS, 16);
  const rows = [];
  for (let i = 0; i < 40; i++) {
    rows.push({ id: i, role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}` });
  }
  const kept = sessions.boundMayorHistory(rows);
  const turnCount = kept.filter((r) => r.role === 'user' || r.role === 'assistant').length;
  assert.ok(turnCount <= 16, `kept ${turnCount} turns`);
  // Newest row survives and chronological order is preserved.
  assert.equal(kept[kept.length - 1].id, 39);
  for (let i = 1; i < kept.length; i++) assert.ok(kept[i].id > kept[i - 1].id);
});

test('boundMayorHistory always keeps the newest row even when it is oversized', () => {
  const rows = [
    { id: 1, role: 'user', content: 'small' },
    { id: 2, role: 'user', content: 'X'.repeat(sessions.MAYOR_HISTORY_MAX_CHARS + 100) },
  ];
  const kept = sessions.boundMayorHistory(rows);
  assert.equal(kept[kept.length - 1].id, 2, 'newest oversized row still routes');
});

test('boundMayorHistory drops older rows once the char budget is exceeded', () => {
  const big = 'X'.repeat(40000);
  const rows = [
    { id: 1, role: 'user', content: big },
    { id: 2, role: 'assistant', content: big },
    { id: 3, role: 'user', content: 'latest' },
  ];
  const kept = sessions.boundMayorHistory(rows, { maxTurns: 16, maxChars: 60000 });
  // id 1 can't fit alongside id 2 + id 3 under 60k → dropped.
  assert.ok(!kept.some((r) => r.id === 1), 'oldest oversized row dropped by char budget');
  assert.equal(kept[kept.length - 1].id, 3);
});

test('clipToolResult bounds a single result and shares a per-turn budget', () => {
  assert.equal(sessions.MAYOR_TOOL_RESULT_MAX_CHARS, 24000);
  assert.equal(sessions.MAYOR_TOOL_RESULTS_TURN_MAX_CHARS, 48000);

  // A single oversized result is clipped to the per-result cap.
  const budget = { remaining: sessions.MAYOR_TOOL_RESULTS_TURN_MAX_CHARS };
  const one = sessions.clipToolResult('Y'.repeat(50000), budget);
  assert.ok(one.includes('result truncated'));
  assert.ok(one.length <= sessions.MAYOR_TOOL_RESULT_MAX_CHARS + 100);

  // The shared budget decremented; a second big result eats the rest and a
  // third lands on the exhausted-budget notice.
  const two = sessions.clipToolResult('Z'.repeat(50000), budget);
  assert.ok(two.length > 0);
  assert.ok(budget.remaining <= 0, 'budget exhausted after two big fetches');
  const three = sessions.clipToolResult('more data', budget);
  assert.match(three, /per-turn data budget exhausted/);
});

test('MAYOR_DATA_TOOLS_MAX_ITERS is capped at 2', () => {
  assert.equal(sessions.MAYOR_DATA_TOOLS_MAX_ITERS, 2);
});

test('planTextInclusion inlines only the newest turns within window + char budget', () => {
  // 6 turns, each 10k of inlined text. Window 4, budget 60k → all 4 recent.
  const counts = [10000, 10000, 10000, 10000, 10000, 10000];
  const inc = attachments.planTextInclusion(counts, { turnWindow: 4, maxChars: 60000 });
  assert.deepEqual(inc, [false, false, true, true, true, true]);

  // Tighten the char budget so only the two newest fit.
  const inc2 = attachments.planTextInclusion(counts, { turnWindow: 4, maxChars: 25000 });
  assert.deepEqual(inc2, [false, false, false, false, true, true]);
});

test('buildUserMessageContent inlines text only when includeText; else a placeholder', () => {
  const att = { kind: 'text', filename: 'notes.txt', data: Buffer.from('hello world') };

  const inlined = attachments.buildUserMessageContent({
    text: 'see attached', attachments: [att], includeImages: true, includeText: true,
  });
  const inlinedText = inlined.find((b) => b.type === 'text').text;
  assert.ok(inlinedText.includes('hello world'), 'text file inlined verbatim');
  assert.ok(inlinedText.includes('ATTACHED FILE: notes.txt'));

  const replaced = attachments.buildUserMessageContent({
    text: 'see attached', attachments: [att], includeImages: true, includeText: false,
  });
  const replacedText = replaced.find((b) => b.type === 'text').text;
  assert.ok(!replacedText.includes('hello world'), 'stale text file NOT re-inlined');
  assert.ok(replacedText.includes('inlined in an earlier turn'), 'placeholder instead');
});
