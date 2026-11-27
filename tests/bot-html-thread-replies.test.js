'use strict';

// Task 2020 follow-up: Homeroom bot's answer laid out everywhere it answers,
// not only in its chat (tests/bot-html-replies.test.js). A project's threads
// (a request's or a change's discussion, its channel and topics, a reply
// thread) are answered by homeroom-bot-voice.js and drawn by the group chat's
// transcript; a design thread's plain answer by design-bot.js, drawn as the
// chat's. Pinned here, without a database or a browser:
//
//   1. One description of the copy, for every reply tool that takes it, and
//      the voice's prompt asks for it, with room for it.
//   2. The voice keeps the copy, checks its words for claims, and sends it
//      only beside the words as written, never under an offer.
//   3. A design thread's plain answer (the chat's own turn's, step 6) may
//      carry it; a version's line does not.
//   4. The thread's row reads it only off the bot's own reply, drops it on
//      an edit, and the body draws it in its own box, folded the same way.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const replyHtml = require('../src/services/homeroom-bot-html');
const voice = require('../src/services/homeroom-bot-voice');
const mayor = require('../src/services/homeroom-bot-mayor');
const { THREAD_LIMITS, CHAT_LIMITS } = require('../src/services/bot-profiles');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const LAID_OUT = '<h3>Where it stands</h3><ol><li>Planned</li><li>Building now</li></ol>';

// ── 1. One description, every reply tool ─────────────────────────────────

test('every reply tool that takes the copy describes it the one way, and the voice asks for it with room', () => {
  assert.equal(mayor.REPLY_HTML_DESCRIPTION, replyHtml.REPLY_HTML_DESCRIPTION, 'the chat reads the shared copy');
  assert.match(replyHtml.REPLY_HTML_DESCRIPTION, new RegExp(`under ${replyHtml.MAX_REPLY_HTML_CHARS} characters`));
  for (const type of ['issue', 'session', 'chat', 'category', 'message']) {
    const reply = voice.toolsFor({ type, ref: 1 }, {}).find((t) => t.function.name === 'reply').function.parameters;
    assert.equal(reply.properties.html.description, replyHtml.REPLY_HTML_DESCRIPTION, type);
    assert.deepEqual(reply.required, ['text'], `${type}: the words are always sent`);
    assert.equal(Object.keys(reply.properties)[1], 'html', `${type}: the words stream first`);
  }
  // Step 6: a design thread's reply is the chat's, with the version's summary.
  const designReply = mayor.DESIGN_REPLY_TOOL.function.parameters.properties;
  assert.equal(designReply.html.description, replyHtml.REPLY_HTML_DESCRIPTION);
  assert.equal(require('../src/services/design-bot').TOOLS.some((t) => t.function.name === 'reply'), false);

  const prompt = voice.systemPrompt({ app: { slug: 'x', name: 'X' }, place: { type: 'issue', ref: 1 }, tools: voice.toolsFor({ type: 'issue', ref: 1 }, {}) });
  assert.ok(prompt.includes('- Keep a reply under 100 words unless they ask for detail. No headings in text.'));
  assert.ok(prompt.includes('- Any reply longer than two short lines also goes in the reply tool\'s html field, laid out as its description\n'
    + '  says, beside the same words in text. Everybody in this thread reads it.'));
  assert.doesNotMatch(prompt, /—/);
  assert.equal(THREAD_LIMITS.outputTokens, 4000, 'a thread reply has room for its copy (it was 900)');
  assert.ok(THREAD_LIMITS.outputTokens <= CHAT_LIMITS.outputTokens);
});

// ── 2. The voice sends it beside the words ───────────────────────────────

test('the copy goes only beside the words exactly as the reply wrote them, and never under an offer', () => {
  const finalReply = { text: 'Planned, and building now.', html: LAID_OUT };
  const text = 'Planned, and building now.';
  assert.equal(voice.threadReplyHtml({ finalReply, text, asWritten: text }), LAID_OUT);
  assert.equal(voice.threadReplyHtml({ finalReply, text: `${text} (not done yet)`, asWritten: text }), null, 'changed after it was written');
  assert.equal(voice.threadReplyHtml({ finalReply, text, asWritten: text, checkedProblems: [{ kind: 'filed' }] }), null, 'a claim was cut');
  assert.equal(voice.threadReplyHtml({ finalReply, text, asWritten: text, offer: { kind: 'close_request' } }), null, 'a line above buttons');
  assert.equal(voice.threadReplyHtml({ finalReply: null, text: 'Sorry, I couldn\'t answer just now.', asWritten: null }), null, 'the fallback line');
  assert.equal(voice.threadReplyHtml({ finalReply: { text }, text, asWritten: text }), null);

  const src = read('src/services/homeroom-bot-voice.js');
  // It is kept from the reply call, also while the suggestions are asked for once more.
  assert.match(src, /const html = lifted\.moved \? null : replyHtml\.cleanReplyHtml\(args\.html\);/);
  assert.match(src, /ctx\.pendingReply = \{\n\s+text,\n\s+\.\.\.\(html \? \{ html \} : \{\}\),/);
  assert.match(src, /ctx\.reply = \{ text, suggestions, suggestionsForOthers: forOthers, \.\.\.\(html \? \{ html \} : \{\}\) \};/);
  // Its words are checked with the reply's, on both passes.
  assert.match(src, /await claims\.checkReply\(pool, ctx, replyHtml\.withHtmlWords\(said, shown\)\)/);
  assert.match(src, /ctx\.checkedProblems = await claims\.checkReply\(pool, ctx, replyHtml\.withHtmlWords\(again\?\.text \?\? finalText, again\?\.html\)\);/);
  // The words before anything changes them, and the copy is decided from them.
  assert.match(src, /const asWritten = finalReply\?\.text \? text : null;/);
  assert.match(src, /const ownHtml = threadReplyHtml\(\{ finalReply, text, asWritten, checkedProblems: ctx\.checkedProblems, offer: ctx\.offer \}\);/);
  // 18 Nov 2026: words changed after it was written keep the copy only
  // while it still says them; anything else is laid out from the final
  // words (tests/bot-reply-layout.test.js).
  assert.equal(voice.threadReplyHtml({ finalReply, text: `Got it, ${text}`, asWritten: text }), null,
    'a short reply\'s copy no longer covers the words');
  assert.equal(replyHtml.withHtmlWords('Words.', '<p>I\'ve filed it.</p>'), 'Words.\n\nI\'ve filed it.');
  assert.equal(replyHtml.withHtmlWords('Words.', null), 'Words.');
});

function sayPool() {
  return { queries: [], async query(sql) { this.queries.push(String(sql)); return { rows: [] }; } };
}

async function sayWith(extra) {
  const sent = [];
  const deps = {
    ws: { async sendBotMessage(_pool, _appId, args) { sent.push(args); return { id: 900, createdAt: new Date() }; }, broadcast() {} },
    notifications: { async createMentionNotifications() { return []; } },
  };
  await voice.say(sayPool(), {
    app: { id: 1, slug: 'x' },
    place: { type: 'issue', ref: 7 },
    bot: { id: 2, username: 'homeroom_bot' },
    text: 'Planned, and building now.',
    answer: [{ message: { id: 50, content: 'Where is it?' }, username: 'evan', userId: 9 }],
    suggestions: ['Thanks'], othersSuggestions: ['Can I try it?'],
    deps,
    ...extra,
  });
  return sent;
}

test('say() stores the copy on the bot\'s reply, and none under an offer', async () => {
  const [plain] = await sayWith({ html: LAID_OUT });
  assert.equal(plain.content, 'Planned, and building now.', 'the words stay the message');
  assert.equal(plain.metadata.homeroomBot.kind, 'voice');
  assert.equal(plain.metadata.homeroomBot.html, LAID_OUT);
  const [none] = await sayWith({});
  assert.equal('html' in none.metadata.homeroomBot, false);
  const [offered] = await sayWith({ html: LAID_OUT, offer: { kind: 'close_request', args: {}, forUserId: 9 } });
  assert.equal('html' in offered.metadata.homeroomBot, false, 'an offer keeps its own line and buttons');
});

// ── 3. The design bot's plain answer ─────────────────────────────────────

test('a design thread\'s answer with no new version may come laid out; a version and the not-drawn line never do', () => {
  // Step 6 (#6864): the design thread's answer is the chat's own turn's, laid
  // out as any chat answer is (answerHtml), and checked by the one reply check.
  const src = read('src/services/homeroom-bot-mayor.js');
  assert.match(src, /text, html: ownHtml, laysOut: !fallback && !ctx\.offer && !designShown && !notDrawn, deps,/);
  assert.match(src, /check: async \(made\) => !\(await claims\.checkReply\(pool, ctx, replyHtml\.htmlWords\(made\)\)\)\.length,/);
  // A version's line keeps its words: the version card is its picture.
  const version = src.slice(src.indexOf("kind: 'design_version', appSlug"), src.indexOf("kind: 'design_version', appSlug") + 300);
  assert.ok(version.length > 0);
  assert.doesNotMatch(version, /html/);
});

// ── 4. The thread's row and its body ─────────────────────────────────────

function loadGroupChat() {
  const gcJs = read('public/js/group-chat.js');
  const document = {
    createElement: () => ({ style: {}, set textContent(v) { this._t = v; }, get innerHTML() { return this._t || ''; } }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    body: { appendChild() {} },
  };
  const sandbox = {
    location: { search: '', protocol: 'http:', host: 'localhost' },
    URLSearchParams, document,
    window: { matchMedia: () => ({ matches: false }) },
    navigator: {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    App: { user: { id: 1, username: 'alice' } },
    console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${gcJs}\nglobalThis.__M = { GroupChat };`, sandbox);
  return sandbox.__M.GroupChat;
}

test('a thread row reads the copy only off the bot\'s own reply, and an edit drops it', () => {
  const gc = loadGroupChat();
  const base = { id: 9, msg_type: 'message', username: 'homeroom_bot', content: 'Planned, and building now.', created_at: '2026-11-06T10:00:00Z' };
  assert.equal(gc._messageView({ ...base, metadata: { homeroomBot: { kind: 'voice', html: LAID_OUT } } }).botHtml, LAID_OUT);
  assert.equal(gc._messageView({ ...base, metadata: {} }).botHtml, null, 'a person\'s message');
  assert.equal(gc._messageView({ ...base, metadata: { homeroomBot: { kind: 'live', html: LAID_OUT } } }).botHtml, null, 'only a reply');
  assert.equal(gc._messageView({ ...base, metadata: { homeroomBot: { kind: 'voice', html: LAID_OUT, offer: { id: 1, status: 'open' } } } }).botHtml, null,
    'an offer keeps its line');
  assert.equal(gc._messageView({ ...base, deleted: true, metadata: { homeroomBot: { kind: 'voice', html: LAID_OUT } } }).botHtml, null, 'deleted');
  assert.equal(gc._messageView({ ...base, metadata: { homeroomBot: { kind: 'voice', html: '   ' } } }).botHtml, null);
  assert.equal(gc._messageView({ ...base, metadata: { homeroomBot: { kind: 'voice', html: `<p>${'x'.repeat(60001)}</p>` } } }).botHtml, null);
  assert.match(read('public/js/group-chat.js'), /const patch = \{ bodyHtml: renderMessageBody\(content\), botHtml: null \};/,
    'an edited message\'s copy no longer says what its words do');
});

test('a comparison rides only off the bot\'s own reply, within a laid-out reply\'s length', () => {
  const gc = loadGroupChat();
  const base = { id: 9, msg_type: 'message', username: 'homeroom_bot', content: 'Side by side.', created_at: '2026-11-20T10:00:00Z' };
  const comparison = { title: 'Before and after', html: '<p>Before</p><p>After</p>' };
  const drawn = gc._messageView({ ...base, metadata: { homeroomBot: { kind: 'voice', comparison } } }).botComparison;
  assert.equal(drawn.title, comparison.title);
  assert.equal(drawn.html, comparison.html);
  assert.equal(gc._messageView({ ...base, metadata: {} }).botComparison, null, 'a person\'s message');
  assert.equal(gc._messageView({ ...base, metadata: { homeroomBot: { kind: 'live', comparison } } }).botComparison, null, 'only a reply');
  assert.equal(gc._messageView({ ...base, metadata: { homeroomBot: { kind: 'voice', comparison, offer: { id: 1, status: 'open' } } } }).botComparison, null,
    'an offer keeps its own line');
  assert.equal(gc._messageView({ ...base, deleted: true, metadata: { homeroomBot: { kind: 'voice', comparison } } }).botComparison, null, 'deleted');
  assert.equal(gc._messageView({ ...base, metadata: { homeroomBot: { kind: 'voice', comparison: { ...comparison, html: '   ' } } } }).botComparison, null);
  assert.equal(gc._messageView({ ...base, metadata: { homeroomBot: { kind: 'voice', comparison: { ...comparison, html: `<p>${'x'.repeat(60001)}</p>` } } } }).botComparison, null,
    'no longer than a laid-out reply');
  assert.equal(gc._messageView({ ...base, metadata: { homeroomBot: { kind: 'voice', comparison: { html: '<p>x</p>' } } } }).botComparison, null,
    'a title is required');
});

test('the body draws the copy in its own box, folded the same way, with the words until it is drawn', () => {
  const body = loadTsx('frontend/src/features/group-chat/long-body.tsx');
  // No page to clean it on (as in this render): the words, in the same box.
  const html = renderToHtml(createElement(body.Body, { html: '<p>Planned, and building now.</p>', rich: LAID_OUT }));
  assert.equal(html, '<div class="messages-markdown gc-msg-content"><div class="[&amp;&gt;:first-child]:mt-0 [&amp;&gt;:last-child]:mb-0"><p>Planned, and building now.</p></div></div>');
  assert.equal(renderToHtml(createElement(body.Body, { html: '<p>Hi</p>' })), '<div class="messages-markdown gc-msg-content"><p>Hi</p></div>', 'a plain message as before, at Messages\' reading size');
  // Long, it folds with "Show more" as any body does.
  const folded = renderToHtml(createElement(body.LongBodyView, {
    html: { __html: '' }, content: createElement('span', null, 'drawn'), long: true, expanded: false,
  }));
  assert.match(folded, /^<div class="messages-markdown gc-msg-content max-h-\[22\.5em\] overflow-hidden \[mask-image:[^"]*\]"><span>drawn<\/span><\/div><button[^>]*class="[^"]*gc-msg-more/);

  const src = read('frontend/src/features/group-chat/long-body.tsx');
  assert.match(src, /<BotHtmlReply\n\s+html=\{rich\}\n\s+className="max-w-\[720px\]"\n\s+onSized=\{setDrawn\}/);
  assert.match(src, /\}, \[html, rich, drawn\]\);/, 'measured again once the frame has its size');
  assert.match(read('frontend/src/features/group-chat/transcript.tsx'), /<Body html=\{msg\.bodyHtml\} rich=\{msg\.botHtml\} \/>/);
  assert.match(read('frontend/src/features/group-chat/transcript-store.ts'), /botHtml\?: string \| null;/);
  const frame = read('frontend/src/features/messages/bot-html.tsx');
  assert.match(frame, /useEffect\(\(\) => \{\n\s+if \(height > 0\) onSized\?\.\(height\);\n\s+\}, \[height, onSized\]\);\n\n\s+if \(!clean\) return/,
    'told before the early return, so the hooks keep their order');
});
