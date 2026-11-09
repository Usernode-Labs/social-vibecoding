'use strict';

// 5 Nov 2026: Homeroom bot's in-process turns (the chat, the voice, the design
// bot, the look before filing on several projects) run on one turn engine
// (src/services/homeroom-bot-turn-engine.js), each as a profile. These pin
// what the engine itself does with a profile; each profile's own suites pin
// that its turns behave as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const engine = require('../src/services/homeroom-bot-turn-engine');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const tool = (name) => ({ type: 'function', function: { name, parameters: { type: 'object' } } });
const callOf = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

// A profile over a scripted model: each step is words, or a list of calls.
function profileOf(steps, overrides = {}) {
  const asked = [];
  const messages = [{ role: 'system', content: 'sys' }];
  let answer = null;
  const profile = {
    messages,
    ids: null,
    normalize: (calls) => (Array.isArray(calls) ? calls : []),
    parseArgs: (raw) => JSON.parse(raw || '{}'),
    resultChars: 20,
    cut: (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text),
    ask: async (o) => {
      asked.push({ tools: (o.tools || []).map((t) => t.function.name), toolChoice: o.toolChoice, where: o.where, extra: o.extra });
      const step = steps.shift();
      return typeof step === 'string' ? { content: step, toolCalls: [] } : { content: null, toolCalls: step };
    },
    where: (n) => `x${n}`,
    done: () => answer !== null,
    offer: ({ last }) => ({
      note: last ? 'last round' : null,
      tools: last ? [tool('reply')] : [tool('read'), tool('reply')],
      toolChoice: last ? 'required' : 'auto',
      options: { extra: 'kept' },
    }),
    onWords: (res) => { answer = res.content; return 'stop'; },
    call: async (call, name, args) => (name === 'read' ? { text: `file ${args.path} `.repeat(5) } : { ok: true }),
    ...overrides,
  };
  return { profile, asked, messages, answer: () => answer };
}

test('a turn counts its rounds, tells the last one once, and keeps each call and its result, cut', async () => {
  const { profile, asked, messages, answer } = profileOf([
    [callOf('c1', 'read', { path: 'a.js' })],
    [callOf('c2', 'read', { path: 'b.js' })],
    'Done: it already works.',
  ]);
  const state = { rounds: 0, limit: 3 };
  await engine.runRounds(state, profile);
  assert.equal(state.rounds, 3);
  assert.equal(answer(), 'Done: it already works.');
  assert.deepEqual(asked.map((a) => a.where), ['x1', 'x2', 'x3']);
  assert.deepEqual(asked.map((a) => a.toolChoice), ['auto', 'auto', 'required'], 'only the last round is forced');
  assert.deepEqual(asked[2].tools, ['reply'], 'the last round offers only what ends the turn');
  assert.equal(asked[0].extra, 'kept', 'a profile\'s own request options reach the model');
  assert.equal(messages.filter((m) => m.role === 'user' && m.content === 'last round').length, 1, 'told once');
  const toolMessages = messages.filter((m) => m.role === 'tool');
  assert.deepEqual(toolMessages.map((m) => m.tool_call_id), ['c1', 'c2']);
  assert.ok(toolMessages.every((m) => m.content.length <= 20 && m.content.endsWith('…')), 'cut as the profile cuts');
  assert.equal(messages.filter((m) => m.role === 'assistant').length, 2, 'each round of calls is kept as the assistant\'s');
});

test('onWords and afterCalls can stop a turn, and a profile may move its limit', async () => {
  // A stop after calls ends it before the limit.
  const stopped = profileOf([[callOf('c1', 'read')], 'never asked'], { afterCalls: () => 'stop' });
  const s1 = { rounds: 0, limit: 5 };
  await engine.runRounds(s1, stopped.profile);
  assert.equal(s1.rounds, 1);
  assert.equal(stopped.answer(), null);

  // Words that keep going (a nudge) ask again; a profile gives one more round past the limit.
  let nudged = 0;
  const kept = profileOf(['I will look now.', 'It works.'], {
    onWords: (res, round) => {
      if (!nudged) {
        nudged += 1;
        state2.limit = Math.max(state2.limit, round.rounds + 1);
        return 'continue';
      }
      return 'stop';
    },
  });
  const state2 = { rounds: 0, limit: 1 };
  await engine.runRounds(state2, kept.profile);
  assert.equal(state2.rounds, 2, 'the extra round ran past the first limit');
});

test('a one-off round replaces what is offered, how its words are read, and its after-calls step', async () => {
  let after = 0;
  const { profile, asked } = profileOf([[callOf('c1', 'reply', { text: 'Queued.' })], 'Queued it.'], {
    afterCalls: () => { after += 1; return undefined; },
  });
  const state = { rounds: 2, limit: 3 };
  const stop = await engine.runRound(state, profile, {
    tools: [tool('reply')], toolChoice: { type: 'function', function: { name: 'reply' } }, afterCalls: null,
  });
  assert.equal(stop, false);
  assert.equal(after, 0, 'the one-off round skipped the profile\'s after-calls step');
  assert.deepEqual(asked[0].tools, ['reply']);
  assert.equal(state.rounds, 3);
  let heard = null;
  await engine.runRound(state, profile, { tools: [tool('reply')], toolChoice: 'auto', onWords: (res) => { heard = res.content; return 'stop'; } });
  assert.equal(heard, 'Queued it.');
});

test('a turn on the bot\'s included key is debited; any other, or a free one, is not; it never throws', async () => {
  const debited = [];
  const deps = (included) => ({
    managedOpenRouter: { usesIncludedKey: async () => included },
    limits: { recordSpend: async (_pool, botId, cents, opts) => { debited.push({ botId, cents, opts }); } },
  });
  await engine.chargeTurn({}, 9, 0.012345, { deps: deps(true) });
  await engine.chargeTurn({}, 9, 0.5, { deps: deps(false) });
  await engine.chargeTurn({}, 9, 0, { deps: deps(true) });
  await engine.chargeTurn({}, null, 0.5, { deps: deps(true) });
  assert.deepEqual(debited, [{ botId: 9, cents: 1.2345, opts: { byok: false } }]);
  await engine.chargeTurn({}, 9, 0.5, {
    deps: { managedOpenRouter: { usesIncludedKey: async () => { throw new Error('db down'); } } },
  });
});

test('the chat, the voice, the design bot and the look before filing all run on the engine, and debit through it', () => {
  for (const rel of ['src/services/homeroom-bot-mayor.js', 'src/services/homeroom-bot-voice.js', 'src/services/design-bot.js']) {
    const src = read(rel);
    assert.match(src, /turnEngine\.runRounds\(turnRounds, /, `${rel} runs its rounds on the engine`);
    assert.match(src, /turnEngine\.chargeTurn\(pool, /, `${rel} debits through the engine`);
    assert.doesNotMatch(src, /recordSpend\(/, `${rel} keeps no copy of the debit`);
  }
  const look = read('src/services/homeroom-bot-already-done.js');
  assert.match(look, /turnEngine\.runRounds\(\{ rounds: 0, limit: MAX_ROUNDS \}, /);
  assert.match(look, /mayor\.askModel\(t, \{/, 'a look is asked again on a fresh route, as every turn is');
  assert.doesNotMatch(look, /openrouterApiBase/, 'it no longer calls the model on its own');
  assert.match(read('src/services/homeroom-bot-thread-tools/look-into.js'), /homeroom-bot-turn-engine'\)\.chargeTurn\(pool, bot\.id, costUsd, \{/);
});
