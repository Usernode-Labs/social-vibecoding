'use strict';

// #1001 — the two model-backed rungs of the quick-reply ladder, unit-tested
// against a stubbed Anthropic client:
//
//   llm.requireQuickReplies    the pills-only continuation on the turn's own
//                              model (rung 2 — "the Mayor authors its own
//                              pills"), and
//   llm.generateQuickReplies   the cheap Haiku backstop (rung 3),
//
// plus llm.buildQuickReplyContext, the compact digest they share.
//
// The context test is the load-bearing one. Enforcement is only affordable
// because it sends the reply plus a few clipped turns instead of replaying
// the conversation: production's median dev-chat assistant row is 52.3k
// tokens ≈ 26¢ on Opus, so a full replay would double the cost of the
// majority of turns. The size ceiling asserted below is what stops a future
// refactor from quietly reintroducing that.
//
// Run with: node --test tests/quick-reply-generation.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const llm = require('../src/services/llm.js');
const { QUICK_REPLY_RULES_TEXT } = require('../src/services/recovery-pills.js');

const TOOL = {
  name: 'suggest_replies',
  description: 'test double',
  input_schema: { type: 'object', properties: { replies: { type: 'array' } }, required: ['replies'] },
};

// Swap in a fake client, run `fn`, always restore. Records every
// messages.create call so the tests can assert on the request shape (which
// is most of what matters here — these helpers are thin by design).
async function withStub(respond, fn) {
  const calls = [];
  const prev = llm._setClientForTests({
    messages: {
      create: async (params, options) => {
        calls.push({ params, options });
        return respond(params, calls.length);
      },
    },
  });
  try {
    return await fn(calls);
  } finally {
    llm._setClientForTests(prev);
  }
}

const toolUseResponse = (replies) => ({
  content: [{ type: 'tool_use', name: 'suggest_replies', input: { replies } }],
  usage: { input_tokens: 1800, output_tokens: 40 },
  model: 'claude-opus-5',
});

const textResponse = (text) => ({
  content: [{ type: 'text', text }],
  usage: { input_tokens: 1700, output_tokens: 35 },
  model: 'claude-haiku-4-5',
});

// ── buildQuickReplyContext ───────────────────────────────────────────

test('the context carries the reply, the state and the recent turns', () => {
  const ctx = llm.buildQuickReplyContext({
    appName: 'Leaderboard Demo',
    state: 'PR #4243 is open for this session; no spec doc yet',
    transcriptTail: [
      { role: 'user', content: 'Make the leaderboard open on Season 1.' },
      { role: 'assistant', content: 'I will have the coding agent do that.' },
    ],
    replyText: 'The leaderboard now defaults to the Season 1 event.',
  });
  assert.match(ctx, /APP: Leaderboard Demo/);
  assert.match(ctx, /STATE: PR #4243 is open/);
  assert.match(ctx, /User: Make the leaderboard open on Season 1\./);
  assert.match(ctx, /You: I will have the coding agent do that\./);
  assert.match(ctx, /The leaderboard now defaults to the Season 1 event\./);
});

test('the context clips hard enough to stay cheap', () => {
  // 40 rows of 5k chars each plus a 20k reply — i.e. a session far larger
  // than anything a real tail would carry.
  const huge = Array.from({ length: 40 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: 'x'.repeat(5000),
  }));
  const ctx = llm.buildQuickReplyContext({
    appName: 'y'.repeat(500),
    state: 'z'.repeat(2000),
    transcriptTail: huge,
    replyText: 'w'.repeat(20000),
  });
  // 6 rows x 600 chars + 1500 reply + a few hundred of framing. 8k chars is
  // roughly 2k tokens — the budget the cost argument assumes.
  assert.ok(ctx.length < 8000,
    `context must stay small; got ${ctx.length} chars`);
  // And it must not have simply dropped the reply to get there.
  assert.match(ctx, /w{1500}/);
  assert.ok(!ctx.includes('w'.repeat(1501)), 'the reply is clipped, not whole');
});

test('the context tolerates a missing reply and junk rows', () => {
  const ctx = llm.buildQuickReplyContext({
    transcriptTail: [null, undefined, { role: 'system', content: 'ignored' }, {}],
  });
  assert.match(ctx, /APP: this app/);
  assert.match(ctx, /YOUR REPLY: \(none yet/);
  assert.ok(!ctx.includes('ignored'), 'system rows are not conversation');
});

test('only user and assistant rows reach the digest', () => {
  const ctx = llm.buildQuickReplyContext({
    transcriptTail: [
      { role: 'system', content: 'PR #1 created' },
      { role: 'user', content: 'hello there' },
    ],
    replyText: 'hi',
  });
  assert.ok(!ctx.includes('PR #1 created'));
  assert.match(ctx, /User: hello there/);
});

// ── requireQuickReplies — the pills-only continuation ────────────────

test('the continuation pins the one tool and asks for nothing else', async () => {
  await withStub(() => toolUseResponse(['Preview the Season 1 default', 'Propose it to the group']),
    async (calls) => {
      const out = await llm.requireQuickReplies({
        rules: QUICK_REPLY_RULES_TEXT,
        context: 'APP: x',
        model: 'claude-opus-5',
        tool: TOOL,
      });
      assert.equal(calls.length, 1, 'exactly one request — never a loop');
      const { params } = calls[0];
      // IT USED TO BE `{ type: 'tool', name: 'suggest_replies' }`. Fable 5.1
      // removed forced tool use — `any` and `tool` are both a 400 — and this
      // call runs on THE TURN'S OWN MODEL, so a Fable session would have hit
      // it on every turn. Silently: it throws, and resolveTurnPills catches
      // and drops to the Haiku rung, so the only symptom is worse pills on
      // one model. `auto` + a system prompt naming the tool is the
      // documented replacement.
      assert.deepEqual(params.tool_choice, { type: 'auto' },
        'never a forced call again — it is a 400 on Fable 5.1');
      assert.equal(params.tools.length, 1,
        'only suggest_replies is exposed, so the call cannot dispatch anything');
      assert.equal(params.tools[0].strict, true,
        'strict on the TOOL is what replaces the forced call\'s schema '
        + 'guarantee — it is a field of the tool, not of tool_choice');
      assert.match(params.system, /Call suggest_replies now/,
        'and the instruction naming the tool is what replaces the rest of it');
      assert.equal(params.model, 'claude-opus-5',
        "the turn's own served model, so the pills are in the Mayor's voice");
      assert.ok(params.max_tokens <= 500, 'a pills-only reply needs no room to ramble');
      assert.match(params.system, /COMPOSITION RULE/,
        'the shared composition rules are handed to the forced call too');
      // RAW input, for the caller's sanitizer.
      assert.deepEqual(out.replies, { replies: ['Preview the Season 1 default', 'Propose it to the group'] });
      assert.equal(out.model, 'claude-opus-5');
      assert.ok(out.usage.input_tokens > 0, 'usage rides along so the caller can debit');
    });
});

test('a text-free response is the expected shape, not an error', async () => {
  // A pills-only continuation carries no text block. That is precisely why
  // enforcement is a SECOND call: the user-visible text already streamed
  // from the first one, so there is nothing to suppress.
  await withStub(() => ({
    content: [{ type: 'tool_use', name: 'suggest_replies', input: { replies: ['Build the avatar flow'] } }],
    usage: { input_tokens: 1500, output_tokens: 20 },
  }), async () => {
    const out = await llm.requireQuickReplies({ context: 'x', tool: TOOL, model: 'claude-opus-5' });
    assert.deepEqual(out.replies, { replies: ['Build the avatar flow'] });
  });
});

test('the continuation throws when no tool_use comes back', async () => {
  // A refusal, a max_tokens truncation — or, now that the call is not
  // forced, a model that simply answers in prose. All three are this rung's
  // failure and the caller drops to the next one.
  await withStub(() => textResponse('I would rather not.'), async () => {
    await assert.rejects(
      () => llm.requireQuickReplies({ context: 'x', tool: TOOL, model: 'claude-opus-5' }),
      /no tool_use/);
  });
});

test('the continuation refuses to run without a tool shape', async () => {
  // The schema is defined once, in routes/sessions.js, beside its sanitizer.
  await withStub(() => toolUseResponse(['a']), async (calls) => {
    await assert.rejects(
      () => llm.requireQuickReplies({ context: 'x', model: 'claude-opus-5' }),
      /suggest_replies tool shape/);
    assert.equal(calls.length, 0, 'it fails before spending anything');
  });
});

test('the abort signal is forwarded so a timeout really cancels', async () => {
  await withStub(() => toolUseResponse(['a']), async (calls) => {
    const controller = new AbortController();
    await llm.requireQuickReplies({
      context: 'x', tool: TOOL, model: 'claude-opus-5', signal: controller.signal,
    });
    assert.equal(calls[0].options && calls[0].options.signal, controller.signal,
      'a losing race must cancel the request, not just ignore it');
  });
});

// ── generateQuickReplies — the Haiku backstop ────────────────────────

test('the backstop parses schema-clean JSON and runs on Haiku', async () => {
  await withStub(() => textResponse('{"replies":["Retry the push","Why did the push fail?"]}'),
    async (calls) => {
      const out = await llm.generateQuickReplies({
        rules: QUICK_REPLY_RULES_TEXT, context: 'APP: x',
      });
      assert.equal(calls[0].params.model, 'claude-haiku-4-5',
        'a DIFFERENT model from the turn\'s own, so one model failing does not take both rungs down');
      assert.ok(calls[0].params.output_config, 'structured outputs are requested');
      assert.deepEqual(out.replies, { replies: ['Retry the push', 'Why did the push fail?'] },
        'returned in the same { replies } shape the tool call produces');
    });
});

test('the backstop recovers fenced and smart-quoted output', async () => {
  const dirty = '```json\n{“replies”: [“Build the avatar flow”]}\n```';
  await withStub(() => textResponse(dirty), async () => {
    const out = await llm.generateQuickReplies({ context: 'x' });
    assert.deepEqual(out.replies, { replies: ['Build the avatar flow'] });
  });
});

test('the backstop throws on unusable output', async () => {
  for (const body of ['no json here', '{"replies":[]}', '{"replies":"nope"}']) {
    await withStub(() => textResponse(body), async () => {
      await assert.rejects(() => llm.generateQuickReplies({ context: 'x' }),
        `${JSON.stringify(body)} must throw so the caller falls through to the static set`);
    });
  }
});

test('both rungs render the SAME rules text they are handed', async () => {
  // One source of truth (QUICK_REPLY_RULES_TEXT) reaching four surfaces is
  // the mechanism that stops the prompt guidance from drifting apart.
  const systems = [];
  await withStub((params) => {
    systems.push(params.system);
    // The continuation is the one that exposes a tool; the backstop asks
    // for JSON prose. (It used to switch on `tool_choice`, which both now
    // reach — rung 2 sends `auto`.)
    return params.tools
      ? toolUseResponse(['a'])
      : textResponse('{"replies":["a"]}');
  }, async () => {
    await llm.requireQuickReplies({
      rules: QUICK_REPLY_RULES_TEXT, context: 'x', tool: TOOL, model: 'claude-opus-5',
    });
    await llm.generateQuickReplies({ rules: QUICK_REPLY_RULES_TEXT, context: 'x' });
  });
  assert.equal(systems.length, 2);
  for (const s of systems) {
    assert.ok(s.includes(QUICK_REPLY_RULES_TEXT),
      'the rules constant is embedded verbatim, not paraphrased');
  }
});
