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
const fs = require('fs');
const path = require('path');

const models = require('../src/services/models');
const prompts = require('../src/services/prompts');
const attachments = require('../src/services/attachments');
const sessions = require('../src/routes/sessions');
const llm = require('../src/services/llm');
const logger = require('../src/services/logger');

// ── Step 1: compact Mayor policy + fixed router model ─────────────────

test('resolveMayorModel resolves a per-user preference, falling back to the sonnet default', () => {
  // No preference (null/undefined, the common case) → documented default.
  assert.equal(models.resolveMayorModel(null), 'claude-sonnet-5');
  assert.equal(models.resolveMayorModel(undefined), 'claude-sonnet-5');
  assert.equal(models.resolveMayorModel(), 'claude-sonnet-5');
  // An allowlisted preference is honored verbatim.
  assert.equal(models.resolveMayorModel('claude-opus-4-8'), 'claude-opus-4-8');
  assert.ok(models.isAllowed(models.resolveMayorModel('claude-opus-4-8')));
  // A bogus/unallowlisted preference degrades to the default rather than
  // reaching the Anthropic API with an invalid model id.
  assert.equal(models.resolveMayorModel('not-a-real-model'), 'claude-sonnet-5');
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
  assert.equal(sessions.MAYOR_SPEC_MAX_CHARS, 100000);
  const huge = 'S'.repeat(sessions.MAYOR_SPEC_MAX_CHARS + 5000);
  const { dynamic } = sessions.buildMayorSystemParts('App', false, huge, false, null);
  assert.ok(dynamic.includes('…[spec middle omitted'), 'oversized spec carries a truncation marker');
  // The inlined spec body itself is bounded (marker + framing add a little).
  assert.ok(dynamic.length < huge.length, 'the prompt is smaller than the raw spec');
});

test('a real-sized spec passes through the Mayor prompt with zero truncation', () => {
  // A meaty but realistic spec (~27k chars) must NOT be truncated at all.
  const realistic = 'Some spec content. '.repeat(1400); // ~28,000 chars
  assert.ok(realistic.length > 20000 && realistic.length < sessions.MAYOR_SPEC_MAX_CHARS);
  const { dynamic } = sessions.buildMayorSystemParts('App', false, realistic, false, null);
  assert.ok(dynamic.includes(realistic), 'spec body appears byte-for-byte, untruncated');
  assert.ok(!dynamic.includes('omitted'), 'no truncation marker for an under-cap spec');

  // Even right up at the 100K cap, still untouched.
  const atCap = 'X'.repeat(sessions.MAYOR_SPEC_MAX_CHARS);
  const clipped = sessions.clipForPrompt(atCap, sessions.MAYOR_SPEC_MAX_CHARS);
  assert.equal(clipped, atCap, 'a spec exactly at the cap is not truncated');

  // One char over triggers truncation.
  const overCap = 'X'.repeat(sessions.MAYOR_SPEC_MAX_CHARS + 1);
  const overClipped = sessions.clipForPrompt(overCap, sessions.MAYOR_SPEC_MAX_CHARS);
  assert.ok(overClipped.includes('…[spec middle omitted'), 'over-cap spec is truncated');
  assert.ok(overClipped.length < overCap.length);
});

test('BUILD_SPEC_MAX_CHARS is 150000 and clipForPrompt keeps head+tail, cutting only the middle', () => {
  assert.equal(sessions.BUILD_SPEC_MAX_CHARS, 150000);
  const big = 'HEAD_MARKER'.padEnd(200000, 'x') + 'TAIL_MARKER';
  const clipped = sessions.clipForPrompt(big, sessions.BUILD_SPEC_MAX_CHARS);
  assert.ok(clipped.startsWith('HEAD_MARKER'), 'head survives');
  assert.ok(clipped.endsWith('TAIL_MARKER'), 'tail survives');
  assert.ok(clipped.includes('…[spec middle omitted'), 'middle-omission marker present');
  assert.ok(clipped.length < big.length);
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

test('MAYOR_DATA_TOOLS_MAX_ITERS is capped at 3 (list → fetch → fetch-url chain)', () => {
  assert.equal(sessions.MAYOR_DATA_TOOLS_MAX_ITERS, 3);
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

// ── Run ceilings removed: no --max-turns, no timeout wrapper ──────────

test('run-cc.sh invokes claude directly with no --max-turns and no timeout wrapper', () => {
  const src = fs.readFileSync(path.join(__dirname, '../worker/run-cc.sh'), 'utf8');
  // Strip comment lines so explanatory prose (e.g. "no --max-turns ceiling")
  // doesn't false-positive; only actual invocation code is checked.
  const code = src
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  assert.ok(!code.includes('--max-turns'), 'no --max-turns flag');
  assert.ok(!/\btimeout\s+["$0-9]/.test(code), 'no timeout wrapper around the claude invocation');
  assert.ok(!code.includes('limit_hit'), 'no limit_hit result field');
  assert.ok(src.includes('claude --print'), 'plain claude --print invocation still present');
});

// ── Wrap-up recap reads the coding agent's real report ─────────────────

function makeStubClient(response) {
  return {
    messages: {
      create: async (params) => {
        makeStubClient.lastParams = params;
        return response;
      },
    },
  };
}

async function withStubClient(response, fn) {
  const stub = makeStubClient(response);
  const prev = llm._setClientForTests(stub);
  try {
    return await fn(stub);
  } finally {
    llm._setClientForTests(prev);
  }
}

function textResponse(text) {
  return { content: [{ type: 'text', text }], usage: { input_tokens: 30, output_tokens: 20 } };
}

test('summarizeRunResult forwards the caveat the coding agent itself reported', async () => {
  const caveat = 'Built the export button, but the CSV download link needs a manual follow-up — S3 credentials were not available in this environment.';
  await withStubClient(textResponse(`I added the export button. ${caveat}`), async (stub) => {
    const recap = await llm.summarizeRunResult({
      toolKind: 'build',
      ccSummary: caveat,
      error: null,
      prContext: { prNumber: 42, prTitle: 'Add CSV export' },
      stagingUrl: 'https://staging.example.test',
      testingBlock: null,
      model: 'claude-sonnet-5',
    });
    assert.ok(recap.text.includes('manual follow-up'), 'the caveat text survives into the recap');
    assert.equal(recap.model, 'claude-sonnet-5');
  });
});

test('summarizeRunResult sends only the bounded facts + report — never a full conversation', async () => {
  await withStubClient(textResponse('I updated the settings page.'), async (stub) => {
    await llm.summarizeRunResult({
      toolKind: 'build',
      ccSummary: 'Updated the settings page to add a dark-mode toggle.',
      error: null,
      prContext: { prNumber: 7, prTitle: 'Dark mode toggle' },
      stagingUrl: null,
      testingBlock: null,
      model: 'claude-haiku-4-5',
    });
  });
  const params = makeStubClient.lastParams;
  assert.equal(params.messages.length, 1, 'a single user message — no replayed conversation history');
  assert.ok(params.messages[0].content.includes('dark-mode toggle'));
  assert.ok(params.max_tokens <= 400, 'bounded output size');
});

test('summarizeRunResult falls back to haiku when no Mayor model is passed', async () => {
  await withStubClient(textResponse('Done.'), async () => {
    const recap = await llm.summarizeRunResult({
      toolKind: 'build', ccSummary: 'Finished the change.', error: null,
      prContext: null, stagingUrl: null, testingBlock: null, model: null,
    });
    assert.equal(recap.model, 'claude-haiku-4-5');
  });
});

test('summarizeRunResult throws when there is nothing to summarize', async () => {
  await withStubClient(textResponse('unused'), async () => {
    await assert.rejects(() => llm.summarizeRunResult({
      toolKind: 'build', ccSummary: '', error: '', prContext: null, stagingUrl: null, testingBlock: null, model: 'claude-sonnet-5',
    }));
  });
});

// ── llm-usage structured logging ────────────────────────────────────────

function fakeStream(finalMessage) {
  return { on() {}, finalMessage: async () => finalMessage };
}

function makeStreamStubClient(finalMessage) {
  return {
    messages: { stream: () => fakeStream(finalMessage) },
    beta: { messages: { stream: () => fakeStream(finalMessage) } },
  };
}

test('streamChat logs a bounded llm-usage line with cache/token/latency fields', async () => {
  const finalMessage = {
    model: 'claude-sonnet-5',
    stop_reason: 'end_turn',
    stop_details: null,
    content: [{ type: 'text', text: 'hi' }],
    usage: {
      input_tokens: 120, output_tokens: 40,
      cache_read_input_tokens: 900, cache_creation_input_tokens: 0,
    },
  };
  const stub = makeStreamStubClient(finalMessage);
  const prevClient = llm._setClientForTests(stub);
  const logCalls = [];
  const prevInfo = logger.info;
  logger.info = (...args) => logCalls.push(args);
  try {
    await llm.streamChat({
      messages: [{ role: 'user', content: 'hello' }],
      systemPrompt: 'sys',
      model: 'claude-sonnet-5',
      role: 'mayor-phase1',
      sessionId: 42,
    });
  } finally {
    logger.info = prevInfo;
    llm._setClientForTests(prevClient);
  }
  const usageCall = logCalls.find((args) => args[0] === 'llm-usage');
  assert.ok(usageCall, 'an llm-usage line was logged');
  const data = usageCall[2];
  assert.equal(data.role, 'mayor-phase1');
  assert.equal(data.model, 'claude-sonnet-5');
  assert.equal(data.session_id, 42);
  assert.equal(data.input_tokens, 120);
  assert.equal(data.output_tokens, 40);
  assert.equal(data.cache_read_input_tokens, 900);
  assert.equal(data.cache_creation_input_tokens, 0);
  assert.equal(typeof data.latency_ms, 'number');
});

test('streamChat still logs llm-usage (with nulls) when no role/sessionId is passed', async () => {
  const finalMessage = {
    model: 'claude-haiku-4-5',
    stop_reason: 'end_turn',
    stop_details: null,
    content: [{ type: 'text', text: 'hi' }],
    usage: { input_tokens: 10, output_tokens: 5 },
  };
  const stub = makeStreamStubClient(finalMessage);
  const prevClient = llm._setClientForTests(stub);
  const logCalls = [];
  const prevInfo = logger.info;
  logger.info = (...args) => logCalls.push(args);
  try {
    await llm.streamChat({ messages: [{ role: 'user', content: 'hi' }], systemPrompt: 'sys', model: 'claude-haiku-4-5' });
  } finally {
    logger.info = prevInfo;
    llm._setClientForTests(prevClient);
  }
  const usageCall = logCalls.find((args) => args[0] === 'llm-usage');
  assert.ok(usageCall);
  assert.equal(usageCall[2].role, null);
  assert.equal(usageCall[2].session_id, null);
  assert.equal(usageCall[2].cache_read_input_tokens, 0, 'missing cache fields default to 0, not undefined');
});
