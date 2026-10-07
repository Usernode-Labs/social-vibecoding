'use strict';

// The per-change metadata call (title, description and the plain-English
// summary every voter reads first) runs on Claude Sonnet 5.5.
//
//   - Sonnet 5.5 thinks by default and the thinking counts against
//     max_tokens, so the call asks for low effort and leaves room for it:
//     the old 512 ended the call before the JSON was written.
//   - It opts into the server-side refusal fallback, through the beta
//     endpoint, so a safety classifier declining a change about auth or
//     security re-runs it on a fallback model instead of losing the summary.
//   - A refusal that survives the fallback throws, which the caller turns
//     into its deterministic title (services/pr-metadata.js).
//   - A fallback-served answer reports the model that actually answered,
//     so the spend is priced at its rates.
//
// Run with: node --test tests/llm-pr-metadata-model.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const llm = require('../src/services/llm');

const ANSWER = '{"title":"Show who voted","body":"- List voters","summary":"You can see who voted."}';

function reply(overrides = {}) {
  return {
    model: 'claude-sonnet-5-5',
    stop_reason: 'end_turn',
    stop_details: null,
    content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: ANSWER }],
    usage: { input_tokens: 900, output_tokens: 120 },
    ...overrides,
  };
}

// A client with both surfaces; each create() records which one it used.
function client(responses, { withBeta = true } = {}) {
  const calls = [];
  const create = (kind) => async (params) => {
    calls.push({ kind, params });
    return responses.shift();
  };
  const c = { calls, messages: { create: create('plain') } };
  if (withBeta) c.beta = { messages: { create: create('beta') } };
  return c;
}

async function withClient(c, fn) {
  llm._setClientForTests(c);
  try { return await fn(); } finally { llm._setClientForTests(null); }
}

test('the metadata call runs on Sonnet 5.5 at low effort with room past its thinking', async () => {
  const c = client([reply()]);
  const out = await withClient(c, () => llm.generatePrMetadata({ userRequest: 'show voters', ccSummary: 'done' }));
  assert.equal(llm.PR_METADATA_MODEL, 'claude-sonnet-5-5');
  assert.equal(c.calls.length, 1);
  const { params } = c.calls[0];
  assert.equal(params.model, 'claude-sonnet-5-5');
  assert.ok(params.max_tokens >= 4000, 'room for thinking before the JSON');
  assert.deepEqual(params.output_config, { effort: 'low' });
  assert.equal(params.thinking, undefined, 'Sonnet 5.5 rejects thinking: disabled; effort is the control');
  assert.equal(out.summary, 'You can see who voted.');
  assert.equal(out.model, 'claude-sonnet-5-5');
});

test('it opts into the server-side refusal fallback through the beta endpoint', async () => {
  const c = client([reply()]);
  await withClient(c, () => llm.generatePrMetadata({ userRequest: 'x', ccSummary: 'y' }));
  assert.equal(c.calls[0].kind, 'beta');
  assert.deepEqual(c.calls[0].params.betas, [llm.FALLBACK_BETA]);
  assert.equal(c.calls[0].params.fallbacks, 'default');
});

test('a client without the beta namespace keeps the plain call', async () => {
  const c = client([reply()], { withBeta: false });
  await withClient(c, () => llm.generatePrMetadata({ userRequest: 'x', ccSummary: 'y' }));
  assert.equal(c.calls[0].kind, 'plain');
  assert.equal(c.calls[0].params.fallbacks, undefined);
  assert.equal(c.calls[0].params.betas, undefined);
});

test('a refusal throws so the caller keeps its deterministic title', async () => {
  const c = client([reply({ stop_reason: 'refusal', content: [] })]);
  await assert.rejects(
    () => withClient(c, () => llm.generatePrMetadata({ userRequest: 'x', ccSummary: 'y' })),
    /refused/,
  );
});

test('a fallback-served answer is billed at the model that answered', async () => {
  const served = reply({
    model: 'claude-opus-5-5',
    usage: { input_tokens: 900, output_tokens: 120, iterations: [{ type: 'fallback_message' }] },
  });
  const c = client([served]);
  const out = await withClient(c, () => llm.generatePrMetadata({ userRequest: 'x', ccSummary: 'y' }));
  assert.equal(out.model, 'claude-opus-5-5');
});

test('#4098: the prompt asks for the explanation blocks as data, and says most changes need none', async () => {
  const c = client([reply()]);
  const out = await withClient(c, () => llm.generatePrMetadata({ userRequest: 'x', ccSummary: 'y' }));
  const { system } = c.calls[0].params;
  assert.match(system, /blocks: an array of at most TWO objects/);
  assert.match(system, /Most changes need none/);
  assert.match(system, /"kind": "comparison"/);
  assert.match(system, /"kind": "steps"/);
  assert.match(system, /"kind": "table"/);
  assert.match(system, /"terms"\?: \[\{"term": "\.\.\.", "meaning": "\.\.\."\}\]/, 'the definitions the request asked for');
  assert.match(system, /The summary must stand on its own without them/);
  assert.match(system, /\{"title": "\.\.\.", "body": "\.\.\.", "summary": "\.\.\.", "blocks": \[\.\.\.\]\}/, 'the response line names them');
  assert.deepEqual(out.blocks, [], 'an answer without them is no blocks');
});

test('#4098: blocks in the answer come back validated', async () => {
  const answer = JSON.stringify({
    title: 'Verified votes', body: '- x',
    summary: 'Votes on public apps count only from verified people.',
    blocks: [{ kind: 'steps', steps: ['Votes', 'Asked for a phone', 'Verifies', 'The vote counts'], extra: true }],
  });
  const c = client([reply({ content: [{ type: 'text', text: answer }] })]);
  const out = await withClient(c, () => llm.generatePrMetadata({ userRequest: 'x', ccSummary: 'y' }));
  assert.deepEqual(out.blocks, [{ kind: 'steps', steps: ['Votes', 'Asked for a phone', 'Verifies', 'The vote counts'] }]);
});
