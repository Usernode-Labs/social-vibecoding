'use strict';

// Homeroom bot parity, P1: a conversation with the bot gets room.
//
// The owner works in Claude Code and wants the bot, on its cheap model, to
// be as good: room to look things up and to answer at length when asked,
// the answer appearing as it is written, and a line saying what it looked
// at. Pinned here, without a database:
//
//   1. The room: sixteen rounds, 8000 output tokens (16000 on a retry; task
//      2020's laid-out copy rides beside the words), 90
//      seconds a request, an 8000-character reply, and a prompt that allows
//      a long, structured answer when they ask for one. The model is chosen
//      as before.
//   2. Sixteen rounds never pass the transport's 100 messages: the oldest
//      lookups are folded into one note (compactRounds).
//   3. The transport streams when asked (openrouter.js onDelta), and only then.
//   4. The answer as it is written: the reply's text read from its partial
//      arguments, shown at most every 250 ms, on the working card, and the
//      message sent takes its place.
//   5. What it looked at: the reply's metadata `looked`, and its line.
//   6. Words written beside a call are the start of the answer, and a reply
//      that ends in an offer keeps its "Looked at" line and its card.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mayor = require('../src/services/homeroom-bot-mayor');
const realDm = require('../src/services/homeroom-bot-dm');
const openrouter = require('../src/services/openrouter');
const { message: catalog } = require('./lib/platform-i18n');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── 1. The room ──────────────────────────────────────────────────────────

test('a turn has room: sixteen rounds, long answers, a longer clock, on the same model', () => {
  assert.equal(mayor.MAX_ROUNDS, 16);
  assert.equal(mayor.MAX_OUTPUT_TOKENS, 8000);
  assert.equal(mayor.RETRY_OUTPUT_TOKENS, 16000);
  assert.equal(mayor.REQUEST_TIMEOUT_MS, 90_000);
  assert.equal(mayor.MAX_REPLY_CHARS, 8000);
  assert.ok(mayor.RETRY_WITHIN_MS >= 4 * mayor.REQUEST_TIMEOUT_MS / 2, 'a later round is asked again too');
  assert.ok(realDm.TYPING_MAX_MS >= 8 * 60 * 1000, 'the working card lasts as long as a long turn');
  // The transport takes the retry's room.
  const base = { model: 'deepseek/deepseek-v4.1-flash-1017', reasoning: 'low', messages: [], tools: [] };
  assert.equal(openrouter.buildRequest({ ...base, maxOutputTokens: mayor.RETRY_OUTPUT_TOKENS }).max_tokens, 16000);
  // The model is chosen as it was: the platform default, else the cheap one.
  const src = read('src/services/homeroom-bot-mayor.js');
  assert.match(src, /model: require\('\.\/default-model'\)\.fromSettings\(settings, config\) \|\| DEFAULT_MODEL,/);
  assert.equal((src.match(/fromSettings\(settings, config\)/g) || []).length, 1);
});

test('the prompt: short for small talk, room when they ask for analysis, options or detail', () => {
  const prompt = mayor.systemPrompt({ username: 'evan' });
  assert.doesNotMatch(prompt, /120 words/);
  assert.ok(prompt.includes('- Keep small talk and quick answers short: a few sentences. When they ask for analysis, options, a plan, a\n'
    + '  comparison or detail, take the room it needs: a longer answer laid out with short headings, lists or a\n'
    + '  table (Markdown), still in plain words, and lead with the answer itself.'));
  assert.match(prompt, /Finish every turn by calling reply exactly once: plain text \(short unless they asked for more\)/);
  const reply = mayor.TOOLS.find((t) => t.function.name === 'reply').function;
  assert.match(reply.parameters.properties.text.description, /longer and laid out when they ask for analysis, options or detail/);
  assert.doesNotMatch(prompt.slice(0, prompt.indexOf('PLATFORM RULES')), /—/);
});

// ── 2. Sixteen rounds within 100 messages ────────────────────────────────

const callOf = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

function roundsOf(count, calls = 8) {
  const out = [];
  for (let r = 0; r < count; r += 1) {
    const ids = Array.from({ length: calls }, (_, i) => `r${r}c${i}`);
    out.push({ role: 'assistant', content: null, tool_calls: ids.map((id) => callOf(id, 'read_source', { project: 'gym', path: `f${r}-${id}.js` })) });
    for (const id of ids) out.push({ role: 'tool', tool_call_id: id, content: JSON.stringify({ text: `contents of ${id}` }) });
  }
  return out;
}

test('the oldest rounds fold into one note when the next round would not fit', () => {
  const head = [{ role: 'system', content: 'prompt' }, ...Array.from({ length: 24 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }))];
  const messages = [...head, ...roundsOf(8)];
  assert.ok(messages.length + 10 > 100, 'eight rounds of eight calls: no room for a ninth');
  const before = messages.length;
  assert.equal(mayor.compactRounds(messages, { from: head.length }), true);
  assert.ok(messages.length < before && messages.length + 10 <= 100, `${messages.length} messages`);
  assert.deepEqual(messages.slice(0, head.length), head, 'the conversation itself is untouched');
  const note = messages[head.length];
  assert.equal(note.role, 'user');
  assert.ok(note.content.startsWith(mayor.COMPACT_LEAD));
  assert.match(note.content, /- read_source \{"project":"gym","path":"f0-r0c0\.js"\}: \{"text":"contents of r0c0"\}/);
  // The newest rounds stay whole: each tool result follows its call.
  const rest = messages.slice(head.length + 1);
  assert.equal(rest.filter((m) => m.role === 'assistant').length, mayor.KEEP_ROUNDS);
  const calls = new Set(rest.flatMap((m) => (m.tool_calls || []).map((c) => c.id)));
  assert.ok(rest.filter((m) => m.role === 'tool').every((m) => calls.has(m.tool_call_id)));
  // A second fold keeps what the first one said.
  messages.push(...roundsOf(6).map((m) => (m.tool_calls ? { ...m, tool_calls: m.tool_calls.map((c) => ({ ...c, id: `x${c.id}` })) } : { ...m, tool_call_id: `x${m.tool_call_id}` })));
  assert.equal(mayor.compactRounds(messages, { from: head.length }), true);
  assert.match(messages[head.length].content, /f0-r0c0\.js/);
  assert.equal((messages[head.length].content.match(/^\[Homeroom, not from them/gm) || []).length, 1);
  // Room left: nothing to do.
  assert.equal(mayor.compactRounds([...head, ...roundsOf(1)], { from: head.length }), false);
  // Too long in characters folds too.
  const long = [...head, ...roundsOf(4, 1).map((m) => (m.role === 'tool' ? { ...m, content: 'x'.repeat(90_000) } : m))];
  assert.equal(mayor.compactRounds(long, { from: head.length }), true);
  assert.ok(long[head.length].content.length < 5_000);
});

function scripted(steps, seen = []) {
  let i = 0;
  return async (req) => {
    seen.push(req);
    const step = typeof steps === 'function' ? steps(i, req) : steps[Math.min(i, steps.length - 1)];
    i += 1;
    return typeof step === 'string' ? { content: step, toolCalls: [] } : { content: step.content || '', toolCalls: step.calls };
  };
}

function botTurn(chat, { extra = {}, text = 'How does Gym Tracker save a workout?' } = {}) {
  const sent = [];
  const doings = [];
  const pool = {
    async query(sql) {
      if (/SELECT slug, name FROM apps WHERE slug = ANY/.test(String(sql))) return { rows: [{ slug: 'gym', name: 'Gym Tracker' }] };
      return { rows: [] };
    },
  };
  const deps = {
    chat, apiKey: 'sk-test', openMcp: async () => null, seesImages: false, sleep: async () => {},
    dmSvc: { ...realDm, async sendDm(_pool, args) { sent.push(args); return { messageId: 900 + sent.length, conversationId: 41 }; } },
    doing: async (what) => { doings.push(what); },
    ...extra,
  };
  const run = mayor.runDmTurn(pool, {}, {
    bot: { id: 2, username: 'homeroom_bot' },
    user: { id: 9, username: 'evan' },
    settings: { mode: 'live', perPerson: 2 },
    conversationId: 41,
    message: { id: 70, content: text },
    deps,
  });
  return { run, sent, doings };
}

test('a turn that looks things up for sixteen rounds never sends more than 100 messages, and still replies', async () => {
  const seen = [];
  const chat = scripted((i, req) => {
    // #6346: the last round is a required choice of the turn-ending tools,
    // not a forced reply.
    if (req.toolChoice === 'required' || typeof req.toolChoice === 'object') {
      return { calls: [callOf(`reply${i}`, 'reply', { text: 'It saves each set as you finish it.' })] };
    }
    return { calls: Array.from({ length: 8 }, (_, c) => callOf(`r${i}c${c}`, 'my_projects')) };
  }, seen);
  const turn = botTurn(chat);
  await turn.run;
  assert.ok(seen.length >= 10, `${seen.length} requests: it got far more than six rounds`);
  assert.ok(seen.length <= mayor.MAX_ROUNDS);
  for (const req of seen) assert.ok(req.messages.length <= mayor.MAX_MESSAGES, `${req.messages.length} messages`);
  assert.ok(seen.some((req) => req.messages.some((m) => typeof m.content === 'string' && m.content.startsWith(mayor.COMPACT_LEAD))),
    'its oldest lookups were folded to make room');
  // #6346: the last round is told so, and must pick a tool that ends the turn.
  const last = seen.at(-1);
  assert.equal(last.toolChoice, 'required', 'the last round picks a turn-ending tool');
  assert.ok(last.messages.some((m) => m.role === 'user' && /This is your last round\./.test(String(m.content))),
    'the last round is warned');
  const ending = (name) => name === 'reply' || name === 'draw_screen' || name.startsWith('offer_');
  assert.ok(last.tools.every((tl) => ending(tl.function.name)), 'only turn-ending tools are offered');
  assert.ok(last.tools.some((tl) => tl.function.name === 'reply'), 'it can still answer');
  assert.equal(turn.sent.length, 1);
  assert.equal(turn.sent[0].content, 'It saves each set as you finish it.');
  assert.ok(seen.every((req) => req.maxOutputTokens === mayor.MAX_OUTPUT_TOKENS), '8000 tokens a round');
});

// ── 3. The transport streams when asked ──────────────────────────────────

function sseBody(events, { splitAt = 7 } = {}) {
  const text = events.map((e) => (typeof e === 'string' ? `${e}\n\n` : `data: ${JSON.stringify(e)}\n\n`)).join('');
  const bytes = Buffer.from(text, 'utf8');
  return {
    async* [Symbol.asyncIterator]() {
      // Cut mid-line and mid-character, as a network does.
      for (let i = 0; i < bytes.length; i += splitAt) yield bytes.subarray(i, i + splitAt);
    },
  };
}

function fakeFetch(body, seen) {
  return async (url, init) => {
    seen.push(JSON.parse(init.body));
    return { ok: true, status: 200, headers: { get: () => null }, body };
  };
}

const ARGS = '{"text":"Café ☕: it saves\\neach set.","suggestions":["And reps?"]}';
const CHUNKS = [
  ': OPENROUTER PROCESSING',
  { id: 'gen-9', model: 'deepseek/deepseek-v4.1-flash-1017', provider: 'Chutes', choices: [{ delta: { role: 'assistant', content: '' } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'reply', arguments: ARGS.slice(0, 15) } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ARGS.slice(15, 30) } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ARGS.slice(30) } }] }, finish_reason: 'tool_calls' }] },
  { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 40, cost: 0.0001 } },
  'data: [DONE]',
];

test('the transport streams only for a caller that asks, and folds the stream into the same answer', async () => {
  const seen = [];
  const deltas = [];
  const base = { apiKey: 'sk', baseUrl: 'https://openrouter.test/api/v1', model: 'deepseek/deepseek-v4.1-flash-1017', reasoning: 'low', messages: [{ role: 'user', content: 'hi' }], tools: [] };
  const res = await openrouter.streamChat({
    ...base, fetchImpl: fakeFetch(sseBody(CHUNKS), seen),
    onDelta: (state) => { deltas.push(mayor.draftOf(state)); },
  });
  assert.equal(seen[0].stream, true);
  assert.equal(res.finishReason, 'tool_calls');
  assert.equal(res.provider, 'Chutes');
  assert.equal(res.generationId, 'gen-9');
  assert.deepEqual(res.toolCalls, [{ id: 'call_1', type: 'function', function: { name: 'reply', arguments: ARGS } }]);
  assert.deepEqual(res.usage, { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 40, reasoningTokens: 0, costUsd: 0.0001 });
  const shown = deltas.filter((d) => d !== null);
  assert.ok(shown.length >= 3, 'the words arrive in pieces');
  assert.equal(shown.at(-1), 'Café ☕: it saves\neach set.');
  assert.ok(shown.every((d, i) => i === 0 || d.length >= shown[i - 1].length), 'and only grow');

  // Without onDelta: the atomic request, unchanged.
  const atomic = [];
  const json = { id: 'g', model: 'm', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }], usage: {} };
  await openrouter.streamChat({
    ...base,
    fetchImpl: async (url, init) => {
      atomic.push(JSON.parse(init.body));
      return { ok: true, status: 200, headers: { get: () => null }, body: (async function* one() { yield Buffer.from(JSON.stringify(json)); }()) };
    },
  });
  assert.equal(atomic[0].stream, false);
});

test('a provider that repeats a call\'s name and id, or leaves its index out, still makes whole calls', async () => {
  const base = { apiKey: 'sk', baseUrl: 'https://openrouter.test/api/v1', model: 'm/x', reasoning: 'low', messages: [], tools: [], onDelta: () => {} };
  const events = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'reply', arguments: '{"text":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'reply', arguments: '"Hi."}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ id: 'c2', function: { name: 'my_work', arguments: '{' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ function: { arguments: '}' } }] }, finish_reason: 'tool_calls' }] },
  ];
  const res = await openrouter.streamChat({ ...base, fetchImpl: fakeFetch(sseBody(events, { splitAt: 5 }), []) });
  assert.deepEqual(res.toolCalls.map((c) => [c.id, c.function.name, c.function.arguments]), [
    ['c1', 'reply', '{"text":"Hi."}'],
    ['c2', 'my_work', '{}'],
  ]);
});

test('a stream that is cut off, ends at its limit or reports an error fails as an atomic answer would', async () => {
  const base = { apiKey: 'sk', baseUrl: 'https://openrouter.test/api/v1', model: 'm/x', reasoning: 'low', messages: [], tools: [], onDelta: () => { throw new Error('a broken screen never fails the request'); } };
  const ask = (events) => openrouter.streamChat({ ...base, fetchImpl: fakeFetch(sseBody(events), []) }).then(() => null, (err) => err.code);
  assert.equal(await ask([{ choices: [{ delta: { content: 'Half an ans' } }] }]), 'stream_error', 'no finish reason');
  assert.equal(await ask([{ choices: [{ delta: { content: 'Long' }, finish_reason: 'length' }] }, 'data: [DONE]']), 'output_limit');
  assert.equal(await ask([{ error: { code: 502, message: 'upstream' }, choices: [{ delta: {}, finish_reason: 'error' }] }]), 'provider_error');
  assert.equal(await ask([{ choices: [{ delta: { content: 'Fine.' }, finish_reason: 'stop' }] }]), null);
});

// ── 4. The answer as it is written ───────────────────────────────────────

test('the reply\'s text is read from its arguments as they arrive', () => {
  assert.equal(mayor.partialTextField('{"tex'), null);
  assert.equal(mayor.partialTextField('{"text": "'), '');
  assert.equal(mayor.partialTextField('{"text":"Hi \\"you\\"\\nnext'), 'Hi "you"\nnext');
  assert.equal(mayor.partialTextField('{"text":"cut \\'), 'cut ', 'an escape cut off waits for the next read');
  assert.equal(mayor.partialTextField('{"text":"caf\\u00e9 \\u00'), 'café ', 'so does a unicode escape');
  assert.equal(mayor.partialTextField('{"text":"done","cards":[]}'), 'done', 'the string ends at its quote');
  assert.equal(mayor.partialTextField('{"cards":[{"kind":"request"}],"text":"after cards'), 'after cards');
  assert.equal(mayor.partialTextField('{"suggestions":["say \\"text\\": yes"],"text":"real'), 'real', 'only a key, never words inside a string');

  const reply = (args) => ({ content: '', toolCalls: [{ function: { name: 'reply', arguments: args } }] });
  assert.doesNotMatch(mayor.draftOf(reply('{"text":"Sure — here')), /—/, 'as it will be sent: no em dash');
  assert.equal(mayor.draftOf({ content: '', toolCalls: [{ function: { name: 'read_source', arguments: '{' } }] }), '', 'a lookup: no answer this round');
  assert.equal(mayor.draftOf({ content: 'Let me look at the code.', toolCalls: [] }), null, 'a preamble never flashes up');
  const long = 'Here is how it works. '.repeat(20);
  assert.equal(mayor.draftOf({ content: long, toolCalls: [] }), long.trim(), 'words longer than any preamble are the answer');
});

test('#6581: the card says "Writing" once while the answer is written, and carries no words', async () => {
  const said = [];
  const ctx = { deps: { doing: async (what) => { said.push(what); } } };
  const writer = mayor.draftWriter(ctx, { every: 250, wait: async () => {} });
  const reply = (text) => ({ content: '', toolCalls: [{ function: { name: 'reply', arguments: `{"text":"${text}` } }] });
  writer.onDelta(reply('One'));
  await ctx.saying;
  writer.onDelta(reply('One two'));
  writer.onDelta(reply('One two three'));
  await ctx.saying;
  assert.deepEqual(said, [{ kind: 'writing' }], 'one "Writing", with none of the answer\'s words');
  writer.onDelta({ content: 'Let me', toolCalls: [] });
  await ctx.saying;
  assert.equal(said.length, 1, 'a preamble shows nothing');
  // A round that calls another tool writes no answer, and says nothing.
  writer.onDelta({ content: '', toolCalls: [{ function: { name: 'read_source', arguments: '{' } }] });
  await ctx.saying;
  assert.equal(said.length, 1, 'an empty round sends no null');
  // The correction pass writes the answer again: no second "Writing".
  writer.onDelta(reply('Ref'));
  await ctx.saying;
  assert.equal(said.length, 1, 'a rewritten answer sends nothing new');
  writer.close({ clear: true });
  await ctx.saying;
  assert.deepEqual(said, [{ kind: 'writing' }, null], 'a turn that found no answer drops the card');
  writer.onDelta(reply('Again, after'));
  await ctx.saying;
  assert.equal(said.length, 2, 'nothing once the message is on its way');
  // A turn with no working card writes nothing.
  assert.equal(mayor.draftWriter({ deps: {} }), null);
});

test('a turn streams its answer to the working card, and the message sent takes its place', async () => {
  const words = 'Gym Tracker saves a workout when you tap Finish: each set is kept as you go, then the whole workout.';
  const args = JSON.stringify({ text: words });
  const seen = [];
  const chat = async (req) => {
    seen.push(req);
    if (seen.length === 1) return { content: '', toolCalls: [callOf('c1', 'my_projects')] };
    // The transport calls onDelta as the arguments arrive.
    for (const at of [12, 40, 80, args.length]) {
      req.onDelta({ content: '', toolCalls: [{ index: 0, function: { name: 'reply', arguments: args.slice(0, at) } }] });
    }
    return { content: '', toolCalls: [callOf('c2', 'reply', { text: words })] };
  };
  const turn = botTurn(chat);
  await turn.run;
  assert.equal(typeof seen[0].onDelta, 'function', 'every request is streamed');
  const writing = turn.doings.filter((d) => d?.kind === 'writing');
  assert.ok(writing.length >= 1);
  assert.ok(writing.every((d) => d.text === undefined), 'the card carries none of the answer\'s words');
  assert.equal(turn.sent.length, 1);
  assert.equal(turn.sent[0].content, words, 'the message is what counts');
  // Asked not to (a caller with no working card), nothing streams.
  const plain = [];
  const quiet = botTurn(async (req) => { plain.push(req); return { content: '', toolCalls: [callOf('c', 'reply', { text: 'Hi.' })] }; }, { extra: { streamDraft: false } });
  await quiet.run;
  assert.equal(plain[0].onDelta, undefined);
});

// Step 4 (11 Nov 2026, #6405, #6581): a typing event carries the step, never
// the answer's words. With no words on the card, a retried model call can
// neither stream an answer again nor wipe words it showed.
test('a typing event carries the step, never the answer\'s words', () => {
  assert.ok(realDm.DOING_KINDS.includes('writing'));
  assert.deepEqual(realDm.typingDoing({ kind: 'writing', text: '  Hello  ' }), { kind: 'writing' }, 'the words are dropped');
  assert.deepEqual(realDm.typingDoing({ kind: 'writing', text: '' }), { kind: 'writing' });
  assert.deepEqual(realDm.typingDoing({ kind: 'writing' }), { kind: 'writing' }, '#6581: no words, so the card says "Writing"');
  for (const text of ['word '.repeat(2000), '漢字かな'.repeat(1500), '🙂'.repeat(4000)]) {
    const doing = realDm.typingDoing({ kind: 'writing', text, from: 20 });
    assert.deepEqual(doing, { kind: 'writing' });
    const event = { type: 'conversation_typing', conversationId: 41, userId: 2, typing: true, threadRootId: 12345, doing };
    assert.ok(Buffer.byteLength(JSON.stringify(event), 'utf8') < 200, 'a step, not an answer');
  }
  // The code that cut and stitched an answer's tail is gone.
  assert.equal(realDm.draftTail, undefined);
  assert.equal(realDm.MAX_DRAFT_CHARS, undefined);
});

// ── 5. What it looked at ─────────────────────────────────────────────────

test('what a turn looked at, in plain words, each once, code read as one line per project', () => {
  const ctx = {};
  mayor.noteLookup(ctx, 'progress', {}, { rightNow: [] });
  mayor.noteLookup(ctx, 'request_detail', { project: 'Gym Tracker', number: 12 }, { project: 'gym', projectName: 'Gym Tracker' });
  mayor.noteLookup(ctx, 'list_source', { project: 'gym' }, { project: 'gym', files: [] });
  mayor.noteLookup(ctx, 'read_source', { project: 'gym', path: 'a.js' }, { project: 'gym', path: 'a.js', text: '' });
  mayor.noteLookup(ctx, 'read_source', { project: 'gym', path: 'b.js' }, { project: 'gym', path: 'b.js', text: '' });
  mayor.noteLookup(ctx, 'read_source', { project: 'gym', path: 'a.js', fromLine: 200 }, { project: 'gym', path: 'a.js', text: '' });
  mayor.noteLookup(ctx, 'get_request', { slug: 'gym', number: 12 }, { result: '{}' });
  mayor.noteLookup(ctx, 'get_discussion', { slug: 'gym', threadType: 'issue', ref: 12 }, { result: '{}' });
  mayor.noteLookup(ctx, 'progress', {}, { rightNow: [] });
  mayor.noteLookup(ctx, 'read_source', { project: 'secret', path: '.env' }, { error: 'That file holds secrets, so it is never read.' });
  mayor.noteLookup(ctx, 'offer_request', { project: 'gym' }, { ok: true });
  mayor.noteLookup(ctx, 'reply', { text: 'x' }, { ok: true });
  const items = mayor.lookedItems(ctx.lookups, {
    names: new Map([['gym', 'Gym Tracker']]),
    extra: [{ what: 'Ran its checks' }, { what: 'Read 23 files in Gym Tracker' }, { what: 'Read 23 files in Gym Tracker' }, 'nope', null],
  });
  assert.deepEqual(items.map((i) => i.what), [
    'Checked how your work is going',
    'Read my notes on Gym Tracker request #12',
    'Read 2 files in Gym Tracker',
    'Read Gym Tracker request #12',
    'Read the discussion on Gym Tracker request #12',
    'Ran its checks',
    'Read 23 files in Gym Tracker',
    'nope',
  ]);
  for (const item of items) assert.doesNotMatch(item.what, /\$|USD|cost|—/);
  assert.equal(mayor.lookedItems([{ tool: 'list_source', project: 'gym' }], { names: new Map([['gym', 'Gym Tracker']]) })[0].what,
    'Looked through the files of Gym Tracker');
  assert.equal(mayor.lookedItems([{ tool: 'read_source', project: 'gym', path: 'a' }])[0].what, 'Read 1 file in gym');
  // #6384: a plan read is said as a plan on its request.
  assert.equal(mayor.lookedItems([{ tool: 'get_spec', project: 'gym', number: 12 }],
    { names: new Map([['gym', 'Gym Tracker']]) })[0].what, 'Read the plan on Gym Tracker request #12');
  const many = Array.from({ length: 40 }, (_, i) => ({ tool: 'get_request', project: 'gym', number: i + 1 }));
  assert.equal(mayor.lookedItems(many).length, 20, 'at most twenty');
});

test('a reply carries `looked` when it looked something up, named and timed; small talk carries none', async () => {
  const chat = scripted([
    { calls: [callOf('a', 'list_source', { project: 'gym' }), callOf('b', 'read_source', { project: 'gym', path: 'src/save.js' })] },
    { calls: [callOf('c', 'reply', { text: 'It saves on Finish.' })] },
  ]);
  const github = {
    async listRepoFiles() { return { files: [{ path: 'src/save.js', size: 10 }] }; },
    async getFileContent() { return 'save()'; },
  };
  // Can read the code: a project they see and build on.
  const access = require('../src/services/app-access');
  const was = access.checkAppAccess;
  access.checkAppAccess = async () => true;
  try {
    const pool = {
      async query(sql) {
        const text = String(sql);
        if (/SELECT slug, name FROM apps WHERE slug = ANY/.test(text)) return { rows: [{ slug: 'gym', name: 'Gym Tracker' }] };
        if (/FROM apps/.test(text)) return { rows: [{ id: 3, slug: 'gym', name: 'Gym Tracker', repo_url: 'https://github.com/o/r', view_visibility: 'public' }] };
        return { rows: [] };
      },
    };
    const sent = [];
    await mayor.runDmTurn(pool, {}, {
      bot: { id: 2, username: 'homeroom_bot' }, user: { id: 9, username: 'evan' }, settings: { mode: 'live', perPerson: 2 },
      conversationId: 41, message: { id: 71, content: 'How does it save?' },
      deps: {
        chat, apiKey: 'sk-test', openMcp: async () => null, seesImages: false, sleep: async () => {}, github,
        botSvc: { ...require('../src/services/homeroom-bot'), parseRepo: () => ({ owner: 'o', repo: 'r' }) },
        dmSvc: { ...realDm, async sendDm(_pool, args) { sent.push(args); return { messageId: 901, conversationId: 41 }; } },
      },
    });
    assert.equal(sent.length, 1);
    const looked = sent[0].metadata.looked;
    assert.deepEqual(looked.items, [{ what: 'Read 1 file in Gym Tracker' }]);
    assert.ok(Number.isInteger(looked.ms) && looked.ms >= 0);
  } finally {
    access.checkAppAccess = was;
  }

  const small = botTurn(scripted([{ calls: [callOf('r', 'reply', { text: 'Hi Evan!' })] }]), { text: 'hi' });
  await small.run;
  assert.equal(small.sent[0].metadata.looked, undefined, 'zero says nothing');

  // A thread tool's own entries, and the time it says it spent.
  const ctx = { lookups: [], looked: [{ what: 'Read 23 files in Gym Tracker' }], lookedMs: 64_000 };
  assert.deepEqual(await mayor.lookedMeta({ async query() { return { rows: [] }; } }, ctx, 1_000),
    { items: [{ what: 'Read 23 files in Gym Tracker' }], ms: 64_000 });
  assert.equal(await mayor.lookedMeta({ async query() { throw new Error('down'); } }, { lookups: [{ tool: 'get_app', project: 'gym' }] }, 2_000).then((m) => m.items[0].what),
    'Read about gym', 'a name it cannot read is its short name');
});

// ── 6. Words written beside a call, and an offer's line (2 Nov 2026) ─────
//
// Tested in a browser: the model wrote a whole walkthrough as plain words in
// a round that also called offer_request, the working card showed it as it
// was written, and the message sent was only the short reply after it, with
// no "Looked at" line although it had read the code.

test('words beside a call are kept as the start of the answer, each said once', () => {
  const walk = 'Here is how the main screen works. '.repeat(12).trim();
  assert.equal(mayor.besideWords(walk), walk);
  assert.equal(mayor.besideWords('Let me read the code first.'), null, 'a preamble is not an answer');
  assert.equal(mayor.besideWords(''), null);
  assert.equal(mayor.answerText([walk], 'Tap File it if you want it.'), `${walk}\n\nTap File it if you want it.`);
  assert.equal(mayor.answerText([], 'Just the reply.'), 'Just the reply.');
  assert.equal(mayor.answerText([walk], ''), walk, 'kept words are an answer when no reply came');
  assert.equal(mayor.answerText([walk], `${walk} And one more thing.`), `${walk} And one more thing.`, 'written again in the reply: once');
  assert.equal(mayor.answerText([walk, walk], 'Done.'), `${walk}\n\nDone.`, 'twice beside calls: once');
  assert.equal(mayor.answerText([walk], 'Here is how the main screen works.'), walk, 'a reply already inside them adds nothing');
});

test('a reply after a walkthrough written beside a call sends the walkthrough, and an offer keeps its "Looked at" line', async () => {
  const walk = 'The main screen has three parts. The header names the rota. The day strip lets you pick your days and Save '
    + 'changes keeps them. The week list says who waters each day. What I would improve: mark today, say who is next, '
    + 'and show the days nobody has picked, so a gap in the week is plain before it is too late to fill it.';
  assert.ok(walk.length > 300);
  const seen = [];
  const chat = async (req) => {
    seen.push(req);
    if (seen.length === 1) {
      req.onDelta({ content: walk, toolCalls: [] });
      return {
        content: walk,
        toolCalls: [
          callOf('a', 'read_source', { project: 'gym', path: 'public/index.html' }),
          callOf('b', 'offer_request', { project: 'gym', title: 'Mark today on the main screen', details: 'Mark today and who is next.', doneWhen: ['Today and who is next show on the main screen.'] }),
        ],
      };
    }
    const args = JSON.stringify({ text: 'Tap File it if you want the first two.' });
    req.onDelta({ content: '', toolCalls: [{ index: 0, function: { name: 'reply', arguments: args.slice(0, 20) } }] });
    return { content: '', toolCalls: [callOf('c', 'reply', { text: 'Tap File it if you want the first two.' })] };
  };
  const access = require('../src/services/app-access');
  const was = access.checkAppAccess;
  access.checkAppAccess = async () => true;
  try {
    const pool = {
      async query(sql) {
        const text = String(sql);
        if (/SELECT slug, name FROM apps WHERE slug = ANY/.test(text)) return { rows: [{ slug: 'gym', name: 'Gym Tracker' }] };
        if (/INSERT INTO bot_cards/.test(text)) return { rows: [{ id: 5 }] };
        if (/FROM apps/.test(text)) return { rows: [{ id: 3, slug: 'gym', name: 'Gym Tracker', repo_url: 'https://github.com/o/r', view_visibility: 'public', community_id: null }] };
        return { rows: [] };
      },
    };
    const sent = [];
    const doings = [];
    await mayor.runDmTurn(pool, {}, {
      bot: { id: 2, username: 'homeroom_bot' }, user: { id: 9, username: 'evan' }, settings: { mode: 'live', perPerson: 2 },
      conversationId: 41,
      // In a private thread already: the offer is its reply there.
      message: { id: 72, content: 'Walk me through the main screen, in detail.', threadRootId: 60 },
      deps: {
        chat, apiKey: 'sk-test', openMcp: async () => null, seesImages: false, sleep: async () => {},
        github: { async getFileContent() { return '<main></main>'; } },
        botSvc: { ...require('../src/services/homeroom-bot'), parseRepo: () => ({ owner: 'o', repo: 'r' }) },
        dmSvc: { ...realDm, async sendDm(_pool, args) { sent.push(args); return { messageId: 902, conversationId: 41 }; } },
        doing: async (what) => { doings.push(what); },
      },
    });
    assert.ok(seen[1].messages.some((m) => m.role === 'user' && m.content === mayor.BESIDE_NOTE), 'the model is told its words were kept');
    assert.equal(sent.length, 1);
    const body = sent[0].content;
    assert.ok(body.startsWith(walk), 'the walkthrough it wrote is the start of the message');
    assert.match(body, /Tap File it if you want the first two\./);
    assert.match(body, /\*\*Gym Tracker\*\* · new request: Mark today on the main screen/);
    assert.equal(sent[0].metadata.kind, 'confirm', 'still the offer, with File it');
    assert.deepEqual(sent[0].metadata.looked.items, [{ what: 'Read 1 file in Gym Tracker' }], 'and the line above it');
    const writing = doings.filter((d) => d?.kind === 'writing');
    assert.ok(writing.length >= 1);
    assert.ok(writing.every((d) => d.text === undefined), '#6581: the card never carries the answer\'s words');
  } finally {
    access.checkAppAccess = was;
  }
});

test('a thread tool\'s card stays under a reply that ends in an offer', async () => {
  const chat = scripted([
    { calls: [
      callOf('a', 'offer_options', { title: 'Ways to remind', options: [{ title: 'A banner' }, { title: 'A calendar file' }] }),
      callOf('b', 'offer_request', { project: 'gym', title: 'Add a reminder banner', doneWhen: ['A reminder banner shows on the main screen.'] }),
    ] },
    { calls: [callOf('c', 'reply', { text: 'Two ways; the first is drafted as a request.' })] },
  ]);
  const access = require('../src/services/app-access');
  const was = access.checkAppAccess;
  access.checkAppAccess = async () => true;
  try {
    const pool = {
      async query(sql) {
        const text = String(sql);
        if (/INSERT INTO bot_cards/.test(text)) return { rows: [{ id: 6 }] };
        if (/FROM apps/.test(text)) return { rows: [{ id: 3, slug: 'gym', name: 'Gym Tracker', repo_url: 'https://github.com/o/r', view_visibility: 'public', community_id: null }] };
        return { rows: [] };
      },
    };
    const sent = [];
    await mayor.runDmTurn(pool, {}, {
      bot: { id: 2, username: 'homeroom_bot' }, user: { id: 9, username: 'evan' }, settings: { mode: 'live', perPerson: 2 },
      conversationId: 41, message: { id: 73, content: 'Ways to remind people?', threadRootId: 61 },
      deps: {
        chat, apiKey: 'sk-test', openMcp: async () => null, seesImages: false, sleep: async () => {},
        github: {},
        dmSvc: { ...realDm, async sendDm(_pool, args) { sent.push(args); return { messageId: 903, conversationId: 41 }; } },
      },
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].metadata.kind, 'confirm');
    assert.equal(sent[0].metadata.card?.type, 'options', 'the options card is under it too');
    assert.deepEqual(sent[0].metadata.card.options.map((o) => o.key), ['A', 'B']);
  } finally {
    access.checkAppAccess = was;
  }
});

// ── The client ───────────────────────────────────────────────────────────

globalThis.window = globalThis.window || {
  App: { user: { id: 9, username: 'evan' } },
  location: { search: '', hash: '#messages/41' },
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  requestAnimationFrame: (fn) => fn(),
  setTimeout, clearTimeout,
};

test('the working card says "Writing" and shows no words: the answer appears once, as its message', () => {
  const store = loadTsx('frontend/src/features/messages/store.ts');
  assert.deepEqual(store.botDoingOf({ kind: 'writing', text: '  It saves  ', from: 3 }), { kind: 'writing' }, 'words are never read off a typing event');
  assert.deepEqual(store.botDoingOf({ kind: 'code', text: 'not here' }), { kind: 'code' });
  assert.equal(store.MAX_BOT_DRAFT_CHARS, undefined);
  assert.equal(store.MAX_BOT_HELD_DRAFT_CHARS, undefined);

  const card = loadTsx('frontend/src/features/messages/bot-working.tsx');
  const bot = { name: 'Homeroom bot', unnamed: false, bot: true };
  const html = renderToHtml(createElement(card.BotWorkingCard, { typist: { ...bot, doing: { kind: 'writing', text: 'It saves **each set**' }, draft: 'held words' } }));
  assert.match(html, /data-bot-working="writing"/);
  assert.match(html, /<span class="min-w-0 truncate" data-bot-working-doing="">Writing<\/span>/);
  assert.doesNotMatch(html, /data-bot-working-draft/, 'the card has nowhere to draw words');
  assert.doesNotMatch(html, /each set|held words/);
  assert.doesNotMatch(html, /gray-|indigo-/);
  assert.equal(card.botDoingLine(catalog, { kind: 'writing', text: 'x' }), 'Writing');
  assert.equal(card.botDraftText, undefined);
});

// 4 Nov 2026 (#6302): the card flashed back to "Thinking" between rounds,
// because each doing event replaced the whole entry. The last step named is
// held on the Typist now; step 4 (11 Nov 2026): and nothing else is.
test('the working card keeps the last step named while the bot thinks, and holds no words', () => {
  const store = loadTsx('frontend/src/features/messages/store.ts');
  const first = store.botTypist(undefined, 'Homeroom bot', store.botDoingOf({ kind: 'writing', text: 'A couple of the names you gave' }));
  assert.deepEqual(first, { name: 'Homeroom bot', unnamed: false, bot: true, doing: { kind: 'writing' } });

  const reading = store.botTypist(first, 'Homeroom bot', store.botDoingOf({ kind: 'request', number: 436 }));
  assert.deepEqual(reading, { name: 'Homeroom bot', unnamed: false, bot: true, doing: { kind: 'request', number: 436 } });

  const thinking = store.botTypist(reading, 'Homeroom bot', store.botDoingOf(undefined));
  assert.deepEqual(thinking.doing, { kind: 'request', number: 436 },
    '#6405: the last step named stays, instead of dropping back to "Thinking"');
  assert.equal(Object.hasOwn(thinking, 'draft'), false, 'no words are held');

  const card = loadTsx('frontend/src/features/messages/bot-working.tsx');
  const heldThinking = renderToHtml(createElement(card.BotWorkingCard, { typist: thinking }));
  assert.match(heldThinking, /data-bot-working="request"/);
  assert.match(heldThinking, /<span class="min-w-0 truncate" data-bot-working-doing="">Reading request #436<\/span>/);
  // A turn that has named nothing yet still shows "Thinking".
  const fresh = renderToHtml(createElement(card.BotWorkingCard, { typist: store.botTypist(undefined, 'Homeroom bot', null) }));
  assert.match(fresh, /data-bot-working="thinking"/);
});

const botMessage = (homeroomBot, extra = {}) => ({
  id: 901, conversationId: 41, content: 'It saves on Finish.', createdAt: '2026-11-01T12:00:00.000Z', deleted: false,
  sender: { id: 2, username: 'homeroom_bot', bot: true }, attachments: [], objects: [], reactions: [],
  metadata: { homeroomBot }, ...extra,
});

test('the reply\'s "Looked at" line: closed, quiet, counted and timed; none for a reply that looked at nothing', () => {
  const api = loadTsx('frontend/src/features/messages/api.ts');
  assert.deepEqual(api.normalizeBotLooked({ items: [{ what: ' Read  request #12 ' }, { what: '' }, 'x', { what: 3 }], ms: 40_400.6 }),
    { items: [{ what: 'Read request #12' }], ms: 40_401 });
  assert.equal(api.normalizeBotLooked({ items: [] }), null);
  assert.equal(api.normalizeBotLooked(null), null);
  assert.equal(api.normalizeBotLooked({ items: Array.from({ length: 30 }, (_, i) => ({ what: `t${i}` })) }).items.length, 20);
  const meta = api.normalizeBotMeta({ homeroomBot: { kind: 'chat', looked: { items: [{ what: 'Read Gym Tracker request #12' }], ms: 5000 } } });
  assert.deepEqual(meta.homeroomBot.looked, { items: [{ what: 'Read Gym Tracker request #12' }], ms: 5000 });

  const line = loadTsx('frontend/src/features/messages/bot-looked.tsx');
  const looked = { items: [{ what: 'Read Gym Tracker request #12' }, { what: 'Read 3 files in <b>Gym</b>' }], ms: 40_000 };
  assert.equal(line.lookedSummary(catalog, looked), 'Looked at 2 things · 40 s');
  assert.equal(line.lookedSummary(catalog, { items: [{ what: 'x' }], ms: 125_000 }), 'Looked at 1 thing · 2 min');
  assert.equal(line.lookedSummary(catalog, { items: [{ what: 'x' }], ms: null }), 'Looked at 1 thing');
  const html = renderToHtml(createElement(line.BotLookedLine, { message: botMessage({ kind: 'chat', looked }) }));
  assert.match(html, /data-bot-looked="2"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /Looked at 2 things · 40 s/);
  assert.doesNotMatch(html, /Read Gym Tracker/, 'closed on first render');
  assert.match(html, /text-\[0\.8125rem\][^"]*text-zinc-500/, '13px and muted');
  assert.doesNotMatch(html, /gray-|indigo-/);
  assert.equal(renderToHtml(createElement(line.BotLookedLine, { message: botMessage({ kind: 'chat' }) })), '');
  assert.equal(renderToHtml(createElement(line.BotLookedLine, { message: botMessage({ kind: 'chat', looked }, { sender: { id: 9, username: 'evan' } }) })), '', 'only the bot\'s');

  const row = read('frontend/src/features/messages/message-row.tsx');
  assert.match(row, /\{!editing \? <BotLookedLine message=\{message\} \/> : null\}\n\s+\{editing \? \(/, 'above the words');
  for (const id of ['summary', 'summaryNoTime']) {
    for (const count of [1, 5]) assert.doesNotMatch(catalog(`messages:botCards.looked.${id}`, { count, time: '4 s' }), /—|messages:/);
  }
  assert.doesNotMatch(catalog('messages:thread.botWorking.writing'), /—|…|messages:/);
});
