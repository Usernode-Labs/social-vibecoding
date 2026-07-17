// Tests for generateIssueTitle's multi-issue-aware prompt (#658).
//
// The model's behaviour can't be unit-tested, so the assertion surface
// is the prompt text sent to the API: it must keep the imperative
// verb-first single-issue style, carry the multi-issue instruction in
// both its shared-topic and no-shared-topic forms, guard against
// treating one problem with several symptoms as multi-issue, and embed
// the (surrogate-stripped, trimmed) description. Return handling is
// asserted too: trimmed title on success, throw on an empty response.
//
// Run with: node --test tests/issue-title-multi.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const llm = require('../src/services/llm');

// Minimal stub for the non-streaming messages.create surface that
// generateIssueTitle uses (llm-fallback.test.js stubs the streaming
// surface; this call is a plain one-shot create).
function makeStubClient(response) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params);
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
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: 40, output_tokens: 12 },
  };
}

test('prompt keeps the imperative verb-first single-issue style', async () => {
  await withStubClient(textResponse('Fix broken thing'), async (stub) => {
    await llm.generateIssueTitle({ description: 'The button is broken' });
    assert.equal(stub.calls.length, 1);
    const { model, max_tokens, messages } = stub.calls[0];
    assert.equal(model, 'claude-haiku-4-5');
    assert.equal(max_tokens, 60);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'user');
    const prompt = messages[0].content;
    assert.match(prompt, /imperative action starting with a verb/);
    assert.match(prompt, /Fix broken leaderboard sort/);
    assert.match(prompt, /not a noun phrase or description/);
    assert.match(prompt, /5-10 words/);
    assert.match(prompt, /no quotes/);
  });
});

test('prompt carries the multi-issue instruction in both forms', async () => {
  await withStubClient(textResponse('Fix multiple things'), async (stub) => {
    await llm.generateIssueTitle({ description: 'A is broken, also B is broken' });
    const prompt = stub.calls[0].messages[0].content;
    // The core rule: don't title only the first problem.
    assert.match(prompt, /more than one distinct problem/);
    assert.match(prompt, /instead of describing only the first/);
    // Shared-topic form (topic named, problems gisted).
    assert.match(prompt, /share a topic/);
    assert.match(prompt, /Fix multiple leaderboard issues: broken sort and stale totals/);
    // No-shared-topic form (each problem gisted briefly).
    assert.match(prompt, /Fix multiple issues: leaderboard sort, dark-mode persistence, export 404/);
    // Relaxed length cap for multi-issue titles only.
    assert.match(prompt, /up to 15 words/);
  });
});

test('prompt guards against treating one problem with several symptoms as multi-issue', async () => {
  await withStubClient(textResponse('Fix one thing'), async (stub) => {
    await llm.generateIssueTitle({ description: 'It flickers, then hangs, then crashes' });
    const prompt = stub.calls[0].messages[0].content;
    assert.match(prompt, /single problem described with several symptoms/);
    assert.match(prompt, /still counts as one problem/);
    assert.match(prompt, /do not use the multi-issue form/);
  });
});

test('prompt embeds the surrogate-stripped, trimmed description', async () => {
  // A lone high surrogate must be stripped and surrounding whitespace
  // trimmed before the description lands in the prompt.
  const description = '  Broken \uD800 export button  ';
  await withStubClient(textResponse('Fix export button'), async (stub) => {
    await llm.generateIssueTitle({ description });
    const prompt = stub.calls[0].messages[0].content;
    assert.ok(prompt.endsWith('FEEDBACK:\nBroken  export button'));
    assert.ok(!prompt.includes('\uD800'));
  });
});

test('returns the trimmed response text as the title, with usage and model', async () => {
  await withStubClient(textResponse('  Fix multiple leaderboard issues: sort and totals  '), async () => {
    const res = await llm.generateIssueTitle({ description: 'sort broken, totals stale' });
    assert.equal(res.title, 'Fix multiple leaderboard issues: sort and totals');
    assert.equal(res.model, 'claude-haiku-4-5');
    assert.deepEqual(res.usage, { input_tokens: 40, output_tokens: 12 });
  });
});

test('an empty response still throws', async () => {
  await withStubClient(textResponse('   '), async () => {
    await assert.rejects(
      llm.generateIssueTitle({ description: 'something broke' }),
      /Empty issue title response/
    );
  });
});
