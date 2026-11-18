'use strict';

// 18 Nov 2026: every long reply of Homeroom bot's comes laid out, from its
// final words. Production, 6 to 18 Nov: 56 of 74 chat replies were longer
// than two short lines and 11 carried a copy (the voice's: 60 of ~525).
// Pinned here, without a database or a network:
//
//   1. The words test every copy is held to (homeroom-bot-html.js
//      matchesWords): it says what the words say, adds no number and no
//      repeat, and drops none of them.
//   2. The layout pass (homeroom-bot-layout.js): one bounded request, no
//      reasoning, a ceiling sized from the words, a time limit; a copy that
//      is late, broken or unfaithful leaves the words.
//   3. The chat's turn: the model's own copy is kept while its words still
//      match; any other long reply is laid out, in time or after the words
//      are sent; and its record says which (homeroom_bot_dm_turns).
//   4. The voice does the same in a project's threads.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const replyHtml = require('../src/services/homeroom-bot-html');
const layout = require('../src/services/homeroom-bot-layout');
const mayor = require('../src/services/homeroom-bot-mayor');
const voice = require('../src/services/homeroom-bot-voice');
const realDm = require('../src/services/homeroom-bot-dm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const WORDS = 'Two ways to lay it out.\n\n1. A table of scores.\n2. A podium for the top three.';
const LAID_OUT = '<h3>Two ways to lay it out</h3><ol><li>A table of scores.</li><li>A podium for the top three.</li></ol>';
const LONG = [
  'Your change is building now, and its 2 checks run as soon as the build is done.',
  '',
  'Here is what it changes:',
  '- The leaderboard gets a podium for the top three players.',
  '- Every score below them stays in the table, sorted from high to low.',
].join('\n');
const LONG_HTML = '<h3>What it changes</h3><p>Your change is building now, and its 2 checks run as soon as the build is done.</p>'
  + '<p>Here is what it changes:</p><ul><li>The leaderboard gets a podium for the top three players.</li>'
  + '<li>Every score below them stays in the table, sorted from high to low.</li></ul>';

// ── 1. The words test ────────────────────────────────────────────────────

test('a copy matches the words only when it says what they say, no more and no less', () => {
  assert.equal(replyHtml.matchesWords(LAID_OUT, WORDS), true);
  assert.equal(replyHtml.matchesWords(LONG_HTML, LONG, { novel: 6 }), true, 'a short heading of its own is allowed');
  assert.equal(replyHtml.matchesWords(LAID_OUT, `A walkthrough written beside a call, about the three options.\n\n${WORDS}`), false,
    'words that lead the answer are not in the copy');
  assert.equal(replyHtml.matchesWords('<p>Filed as request #13.</p>', 'Filed as request #12.'), false, 'never a number of its own');
  assert.equal(replyHtml.matchesWords(`${LAID_OUT}${LAID_OUT}`, WORDS), false, 'never a repeat the words dropped');
  assert.equal(replyHtml.matchesWords('<p>It is live and every vote was counted twice by the group.</p>', 'It is live.'), false,
    'never a sentence the words do not say');
  assert.equal(replyHtml.matchesWords('<p>See <a href="https://example.test/x">the plan</a>.</p>', 'See [the plan](https://example.test/x).'), true,
    'a link is read by its label, not its address');
  assert.equal(replyHtml.matchesWords('<p>I have filed it for you, and it is building.</p>', 'I haven\'t filed it for you, and it is building.'), false,
    'never a "not" taken out');
  assert.equal(replyHtml.matchesWords('<p>It is not live yet, and it builds next.</p>', 'It is live yet, and it builds next.'), false,
    'or put in');
  assert.equal(replyHtml.matchesWords('', WORDS), false);
  assert.equal(replyHtml.matchesWords(LAID_OUT, ''), false);
});

test('a reply is laid out when it is longer than about two short lines', () => {
  assert.equal(replyHtml.wantsLayout('Hi Evan!'), false);
  assert.equal(replyHtml.wantsLayout('One line.\nAnother line.'), false);
  assert.equal(replyHtml.wantsLayout(WORDS), true, 'three lines');
  assert.equal(replyHtml.wantsLayout('x'.repeat(replyHtml.LAYOUT_MIN_CHARS + 1)), true);
  assert.equal(replyHtml.wantsLayout(''), false);
});

test('the reply tool\'s description and the layout pass share one set of style rules', () => {
  assert.ok(replyHtml.REPLY_HTML_DESCRIPTION.includes(replyHtml.REPLY_HTML_STYLE));
  assert.ok(layout.layoutSystem().includes(replyHtml.REPLY_HTML_STYLE));
  assert.match(layout.layoutSystem(), /must say exactly what they say: every sentence, name, number, request number and link/);
  assert.match(layout.layoutSystem(), /Never add, drop, reword, sum up or explain\./);
  assert.doesNotMatch(layout.layoutSystem(), /—/);
});

// ── 2. The layout pass ───────────────────────────────────────────────────

const callOf = (name, args) => ({ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } });

function fakeChat(answer, seen = []) {
  return async (req) => {
    seen.push(req);
    if (typeof answer === 'function') return answer(req);
    return { content: '', toolCalls: [callOf('layout', { html: answer })], usage: { inputTokens: 300, outputTokens: 120, costUsd: 0.0002 } };
  };
}

test('one bounded request: no reasoning, temperature 0, its one tool, a ceiling from the words and a time limit', async () => {
  const seen = [];
  const out = await layout.layOut({ text: LONG, chat: fakeChat(LONG_HTML, seen), apiKey: 'sk', model: 'deepseek/deepseek-v4.1-flash-1017', config: {} });
  assert.deepEqual([out.code, out.html], ['layout', LONG_HTML]);
  assert.deepEqual(out.usage, { inputTokens: 300, outputTokens: 120, costUsd: 0.0002 });
  assert.equal(seen.length, 1, 'asked once');
  const req = seen[0];
  assert.equal(req.reasoning, 'none');
  assert.equal(req.temperature, 0);
  assert.deepEqual(req.toolChoice, { type: 'function', function: { name: 'layout' } });
  assert.equal(req.maxOutputTokens, layout.layoutTokens(LONG));
  assert.equal(req.timeoutMs, layout.TIMEOUT_MS);
  assert.equal(req.messages[1].content, LONG, 'from the final words alone');
  // The ceiling: room for markup, never more than a long table needs.
  assert.equal(layout.layoutTokens('x'), layout.MIN_TOKENS);
  assert.equal(layout.layoutTokens('x'.repeat(8000)), layout.MAX_TOKENS);
  assert.ok(layout.MAX_TOKENS <= 3000);
  assert.ok(layout.WAIT_MS <= 4000, 'the reply never waits more than a few seconds');
});

test('a copy that fails, is broken, or says other words leaves the words', async () => {
  const timeout = await layout.layOut({ text: LONG, model: 'm', chat: async () => { throw Object.assign(new Error('slow'), { code: 'timeout' }); } });
  assert.deepEqual([timeout.html, timeout.code], [null, 'timeout']);
  const error = await layout.layOut({ text: LONG, model: 'm', chat: async () => { throw new Error('boom'); } });
  assert.equal(error.code, 'error');
  assert.equal((await layout.layOut({ text: LONG, model: 'm', chat: fakeChat('no markup at all') })).code, 'unusable');
  const added = LONG_HTML.replace('2 checks', '3 checks');
  assert.equal((await layout.layOut({ text: LONG, model: 'm', chat: fakeChat(added) })).code, 'unfaithful', 'a number of its own');
  assert.equal((await layout.layOut({ text: 'Hi Evan!', model: 'm', chat: fakeChat(LONG_HTML) })).code, 'short');
  assert.equal((await layout.layOut({ text: LONG, model: 'm', chat: null })).code, 'off');
  // The claims checker's guarantees hold for the copy too: a copy it finds a
  // claim in, or cannot check, is not sent.
  assert.equal((await layout.layOut({ text: LONG, model: 'm', chat: fakeChat(LONG_HTML), check: async () => false })).code, 'claims');
  assert.equal((await layout.layOut({ text: LONG, model: 'm', chat: fakeChat(LONG_HTML), check: async () => { throw new Error('db'); } })).code, 'claims');
  assert.equal((await layout.layOut({ text: LONG, model: 'm', chat: fakeChat(LONG_HTML), check: async () => true })).code, 'layout');
  const src = read('src/services/homeroom-bot-mayor.js');
  assert.match(src, /check: async \(made\) => !\(await claims\.checkReply\(pool, ctx, replyHtml\.htmlWords\(made\)\)\)\.length,/);
  assert.match(read('src/services/homeroom-bot-voice.js'), /check: async \(made\) => !\(await claims\.checkReply\(pool, ctx, replyHtml\.htmlWords\(made\)\)\)\.length,/);
  // An answer in its words rather than its tool call is read too.
  assert.equal(layout.answerOf({ content: '```html\n<p>x</p>\n```', toolCalls: [] }), '```html\n<p>x</p>\n```');
});

test('the reply waits for its copy a few seconds at most; a later one is handed back to put on the message', async () => {
  let release;
  const slow = () => new Promise((resolve) => { release = () => resolve({ content: '', toolCalls: [callOf('layout', { html: LONG_HTML })] }); });
  const { now, later } = await layout.layOutInTime({ text: LONG, model: 'm', chat: slow }, { waitMs: 5 });
  assert.equal(now, null, 'not in time: the words go');
  release();
  assert.equal((await later).html, LONG_HTML, 'and the copy follows');
  const fast = await layout.layOutInTime({ text: LONG, model: 'm', chat: fakeChat(LONG_HTML) }, { waitMs: 1000 });
  assert.equal(fast.now.html, LONG_HTML);
});

// ── 3. The chat's turn ───────────────────────────────────────────────────

test('the model\'s own copy is kept while its words still say what the reply says', () => {
  const ctx = { besides: [], reply: { text: WORDS, html: LAID_OUT } };
  assert.equal(mayor.replyHtmlFor(ctx, WORDS), LAID_OUT, 'the words as it wrote them');
  assert.equal(mayor.replyHtmlFor(ctx, `${WORDS}\n`), LAID_OUT, 'or words the copy still matches');
  assert.equal(mayor.replyHtmlFor(ctx, `A walkthrough written beside a call, about the three options.\n\n${WORDS}`), null);
  assert.equal(mayor.replyHtmlFor({ ...ctx, checkedProblems: [{ kind: 'filed' }] }, WORDS), null, 'never once a claim was cut');
  const echo = { besides: [], reply: { text: `${WORDS}\n\nThe draft: show a podium and a table of every score.`, html: `${LAID_OUT}<p>The draft: show a podium and a table of every score.</p>` } };
  assert.equal(mayor.replyHtmlFor(echo, WORDS), null, 'a draft\'s echo taken out of the words is still in the copy');
});

test('a turn whose model was handed to it lays out only with the transport handed with it', () => {
  const t = { chat: async () => ({}) };
  assert.equal(mayor.layoutTransport(t, {}), t.chat, 'the turn\'s own, in production');
  assert.equal(mayor.layoutTransport(t, { chat: async () => ({}) }), null, 'a test or a replay: never the network');
  const handed = async () => ({});
  assert.equal(mayor.layoutTransport(t, { chat: async () => ({}), layoutChat: handed }), handed);
  assert.equal(mayor.layoutTransport(t, { layoutChat: false }), null);
});

test('how a reply\'s copy went, as its turn records it', async () => {
  const t = () => ({ chat: null, user: { id: 9 }, message: { id: 70 }, model: 'm', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, failures: [] });
  const own = await mayor.answerHtml(t(), { reply: { html: LAID_OUT } }, { text: WORDS, html: LAID_OUT, laysOut: true });
  assert.deepEqual([own.status, own.model, own.html], ['model', 'kept', LAID_OUT]);
  const short = await mayor.answerHtml(t(), { reply: {} }, { text: 'Hi!', html: null, laysOut: true });
  assert.deepEqual([short.status, short.model], ['short', 'none']);
  const offer = await mayor.answerHtml(t(), { reply: {} }, { text: LONG, html: null, laysOut: false });
  assert.equal(offer.status, 'none', 'an offer\'s line is never laid out');
  const made = t();
  const laid = await mayor.answerHtml(made, { reply: { html: '<p>other</p>' } }, {
    text: LONG, html: null, laysOut: true, deps: { layoutChat: fakeChat(LONG_HTML) },
  });
  assert.deepEqual([laid.status, laid.model, laid.html], ['layout', 'dropped', LONG_HTML]);
  assert.deepEqual(made.usage, { inputTokens: 300, outputTokens: 120, costUsd: 0.0002 }, 'its cost is the turn\'s');
  const broke = t();
  const failed = await mayor.answerHtml(broke, { reply: {} }, {
    text: LONG, html: null, laysOut: true, deps: { layoutChat: fakeChat(LONG_HTML.replace('2 checks', '9 checks')) },
  });
  assert.deepEqual([failed.status, failed.html], ['failed', null]);
  assert.deepEqual(broke.failures, ['layout:unfaithful'], 'why is one of the turn\'s failures');
  const late = await mayor.answerHtml(t(), { reply: {} }, {
    text: LONG, html: null, laysOut: true, deps: { layoutChat: () => new Promise(() => {}), layoutWaitMs: 1 },
  });
  assert.equal(late.status, 'late');
  assert.ok(late.later instanceof Promise);
});

function scripted(steps) {
  let i = 0;
  return async () => {
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    return { content: '', toolCalls: step };
  };
}

function botTurn(chat, deps = {}) {
  const sent = [];
  const queries = [];
  const patched = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/INSERT INTO homeroom_bot_dm_turns/.test(sql)) return { rows: [{ id: 501 }] };
      return { rows: [], rowCount: 0 };
    },
  };
  const run = mayor.runDmTurn(pool, {}, {
    bot: { id: 2, username: 'homeroom_bot' },
    user: { id: 9, username: 'evan' },
    settings: { mode: 'live', perPerson: 2 },
    conversationId: 41,
    message: { id: 70, content: 'How should I lay out the leaderboard?' },
    deps: {
      chat, apiKey: 'sk-test', openMcp: async () => null, seesImages: false, sleep: async () => {},
      dmSvc: {
        ...realDm,
        async sendDm(_pool, args) { sent.push(args); return { messageId: 900 + sent.length, conversationId: 41 }; },
        async setQuestionState(_pool, messageId, patch) { patched.push({ messageId, patch }); },
      },
      ...deps,
    },
  });
  return { run, sent, queries, patched };
}

const turnRow = (queries) => {
  const q = queries.find((x) => /INSERT INTO homeroom_bot_dm_turns/.test(x.sql));
  return q ? { htmlStatus: q.params[12], htmlModel: q.params[13], cost: q.params[8] } : null;
};

test('a long answer with no copy goes laid out from its final words, and its turn says so', async () => {
  const turn = botTurn(scripted([[{ id: 'r', type: 'function', function: { name: 'reply', arguments: JSON.stringify({ text: LONG }) } }]]), {
    layoutChat: fakeChat(LONG_HTML),
  });
  await turn.run;
  assert.equal(turn.sent.length, 1);
  assert.equal(turn.sent[0].content, LONG, 'the words stay the message');
  assert.equal(turn.sent[0].metadata.html, LONG_HTML);
  assert.deepEqual(turnRow(turn.queries), { htmlStatus: 'layout', htmlModel: 'none', cost: 0.0002 });
});

test('a copy that comes after the words goes on the message, and its turn says it came late', async () => {
  let release;
  const slow = () => new Promise((resolve) => {
    release = () => resolve({ content: '', toolCalls: [callOf('layout', { html: LONG_HTML })], usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.0001 } });
  });
  const turn = botTurn(scripted([[{ id: 'r', type: 'function', function: { name: 'reply', arguments: JSON.stringify({ text: LONG }) } }]]), {
    // The reply's wait ends at once, and the copy lands a moment later.
    layoutChat: slow, layoutSleep: async () => { setTimeout(() => release(), 5); }, awaitLateLayout: true,
  });
  await turn.run;
  assert.equal('html' in turn.sent[0].metadata, false, 'the words went first');
  assert.equal(turnRow(turn.queries).htmlStatus, 'late');
  assert.deepEqual(turn.patched, [{ messageId: 901, patch: { html: LONG_HTML } }], 'the copy follows on the message');
  const update = turn.queries.find((x) => /UPDATE homeroom_bot_dm_turns/.test(x.sql));
  assert.deepEqual(update.params.slice(0, 3), [501, 'late', 0.0001], 'its cost added to its turn');
});

test('a short answer has no copy, and a test\'s scripted model never reaches the network for one', async () => {
  const turn = botTurn(scripted([[{ id: 'r', type: 'function', function: { name: 'reply', arguments: JSON.stringify({ text: 'Hi Evan!' }) } }]]));
  await turn.run;
  assert.equal('html' in turn.sent[0].metadata, false);
  assert.deepEqual(turnRow(turn.queries), { htmlStatus: 'short', htmlModel: 'none', cost: 0 });
  const long = botTurn(scripted([[{ id: 'r', type: 'function', function: { name: 'reply', arguments: JSON.stringify({ text: LONG }) } }]]));
  await long.run;
  assert.equal(turnRow(long.queries).htmlStatus, 'none', 'no layout transport handed to it');
});

// ── 4. The voice ─────────────────────────────────────────────────────────

test('the voice keeps its own copy while the words still match, and lays out the rest', () => {
  const src = read('src/services/homeroom-bot-voice.js');
  assert.equal(voice.threadReplyHtml({ finalReply: { html: LAID_OUT }, text: WORDS, asWritten: WORDS }), LAID_OUT);
  assert.equal(voice.threadReplyHtml({ finalReply: { html: LAID_OUT }, text: `Got it, ${WORDS}`, asWritten: WORDS }), LAID_OUT,
    'a "not done yet" that still matches');
  assert.equal(voice.threadReplyHtml({ finalReply: { html: LAID_OUT }, text: WORDS, asWritten: WORDS, offer: { kind: 'x' } }), null);
  assert.equal(voice.threadReplyHtml({ finalReply: { html: LAID_OUT }, text: WORDS, asWritten: WORDS, checkedProblems: [{ kind: 'filed' }] }), null);
  assert.match(src, /const laid = await require\('\.\/homeroom-bot-mayor'\)\.answerHtml\(t, \{ reply: finalReply \}, \{\n    text, html: ownHtml, laysOut: record\.outcome !== 'fallback' && !ctx\.offer, deps,\n/);
  assert.match(src, /record\.htmlStatus = record\.outcome === 'fallback' \? null : laid\.status;/);
  assert.match(src, /html_status = COALESCE\(\$15, html_status\), html_model = COALESCE\(\$16, html_model\)/);
});

test('a thread reply\'s late copy goes on the message for everybody reading, and on its turn', async () => {
  const queries = [];
  const broadcasts = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/UPDATE chat_messages/.test(sql)) return { rows: [{ id: 77, metadata: { homeroomBot: { kind: 'voice', html: params[1] } }, thread_type: 'issue', thread_ref: 12 }] };
      if (/UPDATE homeroom_bot_voice_turns/.test(sql)) return { rowCount: 0, rows: [] };
      return { rows: [], rowCount: 0 };
    },
  };
  const record = { htmlStatus: 'late', costUsd: 0.001, inputTokens: 10, outputTokens: 20, failures: [] };
  await voice.layLateInThread(pool, {
    app: { id: 3 }, bot: { id: 2 }, messageId: 77, record,
    later: Promise.resolve({ html: LONG_HTML, code: 'layout', usage: { inputTokens: 5, outputTokens: 6, costUsd: 0.0005 } }),
    deps: { ws: { broadcast: (appId, frame) => broadcasts.push({ appId, frame }) } },
  });
  assert.equal(broadcasts.length, 1);
  assert.deepEqual([broadcasts[0].appId, broadcasts[0].frame.type, broadcasts[0].frame.id], [3, 'chat_message_updated', 77]);
  assert.equal(broadcasts[0].frame.metadata.homeroomBot.html, LONG_HTML);
  assert.deepEqual([record.htmlStatus, record.costUsd, record.outputTokens], ['late', 0.0015, 26], 'a turn not finished yet writes it');
  // A late copy that does not match leaves the words, and says why.
  const failed = { failures: [] };
  await voice.layLateInThread(pool, { app: { id: 3 }, bot: { id: 2 }, messageId: 78, record: failed,
    later: Promise.resolve({ html: null, code: 'unfaithful', usage: null }), deps: { ws: { broadcast: () => broadcasts.push(1) } } });
  assert.equal(broadcasts.length, 1, 'nothing put on the message');
  assert.deepEqual([failed.htmlStatus, failed.failures], ['failed', ['layout:unfaithful']]);
  // The thread view draws the late copy in place.
  assert.match(read('public/js/group-chat.js'), /\/\/ 18 Nov 2026: a reply's laid-out copy that came after its words\.\n      botHtml: view\.botHtml,/);
});

// ── The record ───────────────────────────────────────────────────────────

test('both turn records keep how the copy went, in a tracked migration', () => {
  const sql = read('src/db/migrations/bot-reply-html-status.sql');
  for (const table of ['homeroom_bot_dm_turns', 'homeroom_bot_voice_turns']) {
    assert.match(sql, new RegExp(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS html_status TEXT;`));
    assert.match(sql, new RegExp(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS html_model TEXT;`));
  }
  for (const word of ["'model'", "'layout'", "'late'", "'short'", "'failed'", "'none'", "'kept'", "'dropped'"]) {
    assert.ok(sql.includes(word), word);
  }
  const manifest = JSON.parse(read('src/db/migrations/manifest.json'));
  assert.ok(manifest.migrations.some((m) => m.id === 'bot-reply-html-status'));
  assert.match(read('src/services/homeroom-bot-mayor.js'), /failures, fallback, html_status, html_model\)\n       VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9, \$10, \$11, \$12, \$13, \$14\)\n       RETURNING id/);
});
