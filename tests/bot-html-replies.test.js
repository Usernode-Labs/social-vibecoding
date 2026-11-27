'use strict';

// Task 2020: the Homeroom bot's chat answer, laid out. For a reply longer
// than two short lines the bot also writes the same answer as a small HTML
// fragment; the chat draws it in place of the words, cleaned and framed with
// scripts off, and the words stay the message everything else reads.
// Pinned here, without a database or a browser:
//
//   1. The server keeps a fragment bounded: unfenced, no invisible
//      characters, no em dash, some markup, under its size.
//   2. The reply tool and the prompt ask for it, in the colour names the
//      chat sets, with the room it needs.
//   3. A turn sends it beside the words, and only beside the words as they
//      were written: a claim in either is checked, and a cut drops it.
//   4. The chat reads it off the message, cleans it against an allowlist,
//      and draws it in a frame that runs nothing and loads nothing, in the
//      bubble's own tokens; the words are its fallback.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mayor = require('../src/services/homeroom-bot-mayor');
const replyHtml = require('../src/services/homeroom-bot-html');
const { CHAT_LIMITS } = require('../src/services/bot-profiles');
const realDm = require('../src/services/homeroom-bot-dm');
const { message: catalog } = require('./lib/platform-i18n');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── 1. What the server stores ────────────────────────────────────────────

test('a reply\'s fragment is stored unfenced, without invisible characters or em dashes, and only with markup', () => {
  assert.equal(replyHtml.cleanReplyHtml('```html\n<h3>Plan</h3>\n<p>Two steps — then done.</p>\n```'),
    '<h3>Plan</h3>\n<p>Two steps, then done.</p>');
  assert.equal(replyHtml.cleanReplyHtml('<p>A​B</p>'), '<p>AB</p>');
  assert.equal(replyHtml.cleanReplyHtml('  <ul><li>One</li></ul>  '), '<ul><li>One</li></ul>');
  assert.equal(replyHtml.cleanReplyHtml('Only words, no markup.'), null, 'the words already say it');
  assert.equal(replyHtml.cleanReplyHtml(''), null);
  assert.equal(replyHtml.cleanReplyHtml(null), null);
  assert.equal(replyHtml.cleanReplyHtml(42), null);
  assert.equal(replyHtml.cleanReplyHtml(`<p>${'x'.repeat(replyHtml.MAX_REPLY_HTML_CHARS)}</p>`), null,
    'a fragment too long is dropped whole: a cut one would be broken markup');
});

test('the words a fragment shows: no styles, scripts or comments, tags as spaces, entities read', () => {
  assert.equal(replyHtml.htmlWords('<style>p{color:red}</style><h3>Plan</h3><p>Filed &amp; done</p><!-- note --><script>x()</script>'),
    'Plan Filed & done');
  assert.equal(replyHtml.htmlWords(''), '');
  assert.equal(replyHtml.htmlWords(null), '');
});

// ── 2. The tool and the prompt ask for it ────────────────────────────────

test('the reply tool takes the answer laid out, in the colour names the chat sets, and the prompt asks for it', () => {
  const reply = mayor.TOOLS.find((t) => t.function.name === 'reply').function.parameters;
  assert.deepEqual(Object.keys(reply.properties), ['text', 'html', 'cards', 'suggestions'], 'the words stream first');
  assert.deepEqual(reply.required, ['text'], 'the words are always sent');
  const description = reply.properties.html.description;
  assert.equal(description, mayor.REPLY_HTML_DESCRIPTION);
  assert.match(description, /^For any reply longer than two short lines: the same answer, laid out, as an HTML fragment\./);
  assert.match(description, /no scripts \(they never run\), no buttons or forms/);
  assert.match(description, /It says exactly what text says, no more/);
  assert.match(description, /Small talk, short answers and a line under a draft have no html\./);
  assert.match(description, new RegExp(`under ${replyHtml.MAX_REPLY_HTML_CHARS} characters`));
  assert.doesNotMatch(description, /—/);
  // The names it may colour with are exactly the ones the chat sets.
  const named = [...description.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]);
  const frame = read('frontend/src/features/messages/bot-html.tsx');
  const set = [...frame.matchAll(/\['(--[a-z0-9-]+)', '--[a-z0-9-]+', '[^']+'\]/g)].map((m) => m[1]);
  assert.deepEqual(named, set);

  const prompt = mayor.systemPrompt({ username: 'evan' });
  assert.ok(prompt.includes('- Any reply longer than two short lines also goes in the reply tool\'s html field, laid out as its description\n'
    + '  says, beside the same words in text.'));
  assert.doesNotMatch(prompt.slice(0, prompt.indexOf('PLATFORM RULES')), /—/);
});

test('a chat round has the room for the words and their laid-out copy', () => {
  assert.equal(CHAT_LIMITS.outputTokens, 8000);
  assert.equal(CHAT_LIMITS.retryOutputTokens, 16000);
  assert.equal(mayor.MAX_OUTPUT_TOKENS, CHAT_LIMITS.outputTokens);
  assert.equal(mayor.RETRY_OUTPUT_TOKENS, CHAT_LIMITS.retryOutputTokens);
});

// ── 3. A turn sends it beside the words ──────────────────────────────────

const callOf = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

function scripted(steps) {
  let i = 0;
  return async () => {
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    return { content: '', toolCalls: step };
  };
}

function botTurn(chat, text = 'How should I lay out the leaderboard?') {
  const sent = [];
  const pool = { async query() { return { rows: [] }; } };
  const run = mayor.runDmTurn(pool, {}, {
    bot: { id: 2, username: 'homeroom_bot' },
    user: { id: 9, username: 'evan' },
    settings: { mode: 'live', perPerson: 2 },
    conversationId: 41,
    message: { id: 70, content: text },
    deps: {
      chat, apiKey: 'sk-test', openMcp: async () => null, seesImages: false, sleep: async () => {},
      dmSvc: { ...realDm, async sendDm(_pool, args) { sent.push(args); return { messageId: 900 + sent.length, conversationId: 41 }; } },
    },
  });
  return { run, sent };
}

const WORDS = 'Two ways to lay it out.\n\n1. A table of scores.\n2. A podium for the top three.';
const LAID_OUT = '<h3>Two ways to lay it out</h3><ol><li>A table of scores.</li><li>A podium for the top three.</li></ol>';

test('a reply sends its laid-out copy beside its words, and one without a copy sends the words alone', async () => {
  const turn = botTurn(scripted([[callOf('r', 'reply', { text: WORDS, html: `\`\`\`html\n${LAID_OUT}\n\`\`\`` })]]));
  await turn.run;
  assert.equal(turn.sent.length, 1);
  assert.equal(turn.sent[0].content, WORDS, 'the words stay the message');
  assert.equal(turn.sent[0].metadata.kind, 'chat');
  assert.equal(turn.sent[0].metadata.html, LAID_OUT);

  const plain = botTurn(scripted([[callOf('r', 'reply', { text: 'Hi Evan!' })]]), 'hi');
  await plain.run;
  assert.equal(plain.sent[0].content, 'Hi Evan!');
  assert.equal('html' in plain.sent[0].metadata, false);

  const junk = botTurn(scripted([[callOf('r', 'reply', { text: WORDS, html: 'no markup at all' })]]));
  await junk.run;
  assert.equal('html' in junk.sent[0].metadata, false, 'a copy with no markup is not one');
});

test('a claim in the laid-out copy is checked like one in the words, and a cut drops the copy', async () => {
  // The words are fine; the copy says a request was filed, which no tool did.
  const claim = '<p>I\'ve filed it for you.</p>';
  assert.deepEqual(
    (await mayor.claimProblems({ query: async () => ({ rows: [] }) }, { user: { id: 9 }, appIds: new Set() },
      mayor.checkedWords({ besides: [], reply: { text: 'Here is the plan.', html: claim } }))).map((p) => p.kind),
    ['filed'],
  );
  const turn = botTurn(scripted([
    [callOf('a', 'reply', { text: 'Here is the plan.', html: claim })],
    [callOf('b', 'reply', { text: 'Here is the plan.', html: claim })],
  ]));
  await turn.run;
  assert.equal(turn.sent.length, 1);
  assert.equal('html' in turn.sent[0].metadata, false, 'the copy would still say what the words no longer do');
  // #6583: a record-backed claim is cut with no fixed "I haven't…" line.
  assert.doesNotMatch(turn.sent[0].content, /I haven't filed anything/);

  // Put right on the second pass: the copy goes.
  const fixed = botTurn(scripted([
    [callOf('a', 'reply', { text: 'Here is the plan.', html: claim })],
    [callOf('b', 'reply', { text: WORDS, html: LAID_OUT })],
  ]));
  await fixed.run;
  assert.equal(fixed.sent[0].metadata.html, LAID_OUT);
});

test('the copy goes only beside the words as the reply wrote them', () => {
  const ctx = { besides: [], reply: { text: WORDS, html: LAID_OUT } };
  assert.equal(mayor.replyHtmlFor(ctx, WORDS), LAID_OUT);
  assert.equal(mayor.replyHtmlFor(ctx, `A walkthrough written beside a call.\n\n${WORDS}`), null, 'words beside a call lead it');
  assert.equal(mayor.replyHtmlFor({ ...ctx, checkedProblems: [{ kind: 'filed' }] }, WORDS), null, 'a claim was cut');
  assert.equal(mayor.replyHtmlFor({ besides: [], reply: { text: WORDS } }, WORDS), null);
  assert.equal(mayor.replyHtmlFor(ctx, ''), null);
  assert.equal(mayor.checkedWords({ besides: [], reply: { text: 'Words.' } }), 'Words.');
});

// ── 4. The chat draws it ─────────────────────────────────────────────────

const botMessage = (homeroomBot, extra = {}) => ({
  id: 5, conversationId: 41, content: WORDS, createdAt: '2026-11-06T10:00:00.000Z',
  sender: { id: 2, username: 'homeroom_bot', bot: true }, attachments: [], objects: [], reactions: [],
  metadata: { homeroomBot }, ...extra,
});

test('the chat reads the copy off a message, only a bot\'s chat answer\'s', () => {
  const api = loadTsx('frontend/src/features/messages/api.ts');
  assert.equal(api.normalizeBotMeta({ homeroomBot: { kind: 'chat', html: LAID_OUT } }).homeroomBot.html, LAID_OUT);
  assert.equal('html' in api.normalizeBotMeta({ homeroomBot: { kind: 'chat', html: '  ' } }).homeroomBot, false);
  assert.equal('html' in api.normalizeBotMeta({ homeroomBot: { kind: 'chat', html: 7 } }).homeroomBot, false);
  assert.equal('html' in api.normalizeBotMeta({ homeroomBot: { kind: 'chat', html: `<p>${'x'.repeat(60001)}</p>` } }).homeroomBot, false);

  const frame = loadTsx('frontend/src/features/messages/bot-html.tsx');
  assert.equal(frame.botReplyHtml(botMessage({ kind: 'chat', html: LAID_OUT })), LAID_OUT);
  assert.equal(frame.botReplyHtml(botMessage({ kind: 'activity', html: LAID_OUT })), null, 'a card keeps its own drawing');
  assert.equal(frame.botReplyHtml(botMessage({ kind: 'chat', html: LAID_OUT }, { sender: { id: 9, username: 'evan' } })), null, 'only the bot\'s');
  assert.equal(frame.botReplyHtml(botMessage({ kind: 'chat' })), null);
});

test('the frame runs nothing and loads nothing, and is in the bubble\'s own tokens and font', () => {
  const frame = loadTsx('frontend/src/features/messages/bot-html.tsx');
  // Artifacts, stage 1: the answer is drawn in the one frame, static
  // (frontend/src/features/artifact/frame.tsx), under the one policy with no
  // origin named. Its own frame is never same-origin with the chat: the
  // helper inside it says its size (tests/artifact-frame.test.js draws it).
  assert.equal(frame.REPLY_SANDBOX, undefined, 'no sandbox of its own');
  assert.equal(frame.replyCsp, undefined, 'no policy of its own');
  const source = read('frontend/src/features/messages/bot-html.tsx');
  assert.doesNotMatch(source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ''), /allow-same-origin|contentDocument|<iframe/,
    'nothing reaches into the frame, and the frame is the shared one');
  // #6972: the reply's frame asks to be pictured once it has its size, so a
  // comment taken on it shows the reply instead of an empty gap.
  const oneFrame = /<ArtifactFrame\b[\s\S]*?\/>/.exec(source);
  assert.ok(oneFrame, 'the frame is the shared one');
  assert.match(oneFrame[0], /mode="helper"/);
  assert.match(oneFrame[0], /\bpictured=\{measured\}/, 'a comment\'s picture asks the reply to draw itself');

  for (const tag of ['script', 'form', 'input', 'button', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'video', 'audio', 'animate', 'set']) {
    assert.ok(frame.REPLY_PURIFY.FORBID_TAGS.includes(tag), tag);
  }
  assert.deepEqual(frame.REPLY_PURIFY.ADD_TAGS, ['style']);
  assert.equal(frame.REPLY_PURIFY.FORCE_BODY, true, 'a leading <style> block is kept');
  // Nothing is left to load from an address: a refused load is a console error on the chat's page.
  assert.equal(frame.withoutOutsideUrls('@import url(https://x.example/a.css); .a{background:url("https://x.example/b.png")} .b{background:url(data:image/png;base64,AAAA)}'),
    ' .a{background:none} .b{background:url(data:image/png;base64,AAAA)}');
  assert.equal(frame.withoutOutsideUrls("background-image: url('/img/x.png')"), 'background-image: none');
  for (const step of [
    /querySelectorAll\('style'\)\)\) el\.textContent = withoutOutsideUrls/,
    /querySelectorAll\('\[style\]'\)\)\) el\.setAttribute\('style', withoutOutsideUrls/,
    /querySelectorAll\('img'\)\)\) \{\n\s+el\.removeAttribute\('srcset'\);\n\s+if \(!isData\(el\.getAttribute\('src'\)\)\) el\.remove\(\);/,
    /querySelectorAll\('image, feImage'\)/,
    /if \(ref && !ref\.trim\(\)\.startsWith\('#'\)\) el\.removeAttribute\(name\);/,
  ]) assert.match(source, step);
  assert.equal(frame.linkable('https://example.com/a'), true);
  assert.equal(frame.linkable('/app/gym-1a2b3c/dev/changes/12'), true);
  for (const bad of ['javascript:alert(1)', '//evil.example', 'data:text/html,x', 'mailto:a@b.c', '', null]) assert.equal(frame.linkable(bad), false, String(bad));

  const look = {
    vars: Object.fromEntries(frame.REPLY_TOKENS.map(([name, , fallback]) => [name, fallback])),
    dark: true, font: "'Geist', ui-sans-serif, system-ui, sans-serif", size: '17px',
  };
  // The brand font is written in as data: a frame with an origin of its
  // own cannot fetch this site's file, and the policy names no origin.
  const geist = 'data:font/woff2;base64,d09GMgABAAAAAA==';
  const doc = frame.replyFrameDoc('<p>Hi</p>', look, geist);
  assert.match(doc, /^<!doctype html><html><head><meta charset="utf-8"><style>/);
  assert.match(doc, /:root\{--ink:#0a0a0a;--ink-2:#3a3a3c;[^}]*;color-scheme:dark\}/);
  assert.match(doc, /@font-face\{font-family:'Geist';src:url\('data:font\/woff2;base64,d09GMgABAAAAAA=='\) format\('woff2'\)/);
  assert.doesNotMatch(doc, /https?:\/\//, 'no address anywhere in the document');
  assert.doesNotMatch(frame.replyFrameDoc('<p>Hi</p>', look, null), /@font-face/, 'no face until the font was read');
  assert.doesNotMatch(frame.replyFrameDoc('<p>Hi</p>', look, "data:font/woff2;base64,AA')}body{x:url('https://x.example"), /@font-face|x\.example/, 'only a plain data: font');
  assert.match(doc, /body\{color:var\(--ink\);font-family:'Geist', ui-sans-serif, system-ui, sans-serif;font-size:17px;line-height:1\.4\}/);
  assert.match(doc, /<body><div class="reply" dir="auto"><p>Hi<\/p><\/div><\/body><\/html>$/);
  assert.doesNotMatch(doc, /<script/i);
  const plain = frame.replyFrameDoc('<p>Hi</p>', { ...look, dark: false, font: 'system-ui, sans-serif' }, geist);
  assert.doesNotMatch(plain, /@font-face/, 'no font file unless the chat draws in Geist');
  assert.match(plain, /color-scheme:light/);
  // A token value cannot close the block it is written into.
  const odd = frame.replyFrameDoc('<p>Hi</p>', { ...look, vars: { '--ink': 'red}</style><script>x()</script>' } }, geist);
  assert.doesNotMatch(odd, /<\/style><script>/);

  // The tokens it sets are the chat's own.
  const css = read('public/css/app.css');
  for (const [, token] of frame.REPLY_TOKENS) assert.ok(css.includes(`${token}:`), token);
});

test('until it is cleaned and measured the words are drawn: never an empty bubble', () => {
  const frame = loadTsx('frontend/src/features/messages/bot-html.tsx');
  // No page to clean it on (as on the server's render): the words alone.
  assert.equal(frame.cleanReplyHtml(LAID_OUT), null);
  const html = renderToHtml(createElement(frame.BotHtmlReply, { html: LAID_OUT, fallback: createElement('p', { className: 'words' }, 'The words') }));
  assert.equal(html, '<p class="words">The words</p>');

  const row = read('frontend/src/features/messages/message-row.tsx');
  assert.match(row, /const richHtml = head \? null : botReplyHtml\(message\);/);
  assert.match(row, /richHtml \? <BotHtmlReply html=\{richHtml\} fallback=\{markdown\} \/> : markdown;/);
  // Dedupe step 2: the bubble is drawn by the shared row (MessageRowView),
  // which takes the rich case as a prop.
  assert.match(row, /rich=\{!!richHtml && !translatedBody && !editing\}/);
  assert.match(read('frontend/src/features/messages/message-row-view.tsx'), /rich \? 'messages-bubble messages-bubble-rich' : 'messages-bubble'/);
  assert.match(read('public/css/app.css'), /\.messages-bubble\.messages-bubble-rich \{ width: 100%; max-width: min\(100%, 720px\); \}/);
  const source = read('frontend/src/features/messages/bot-html.tsx');
  assert.match(source, /\{measured \? null : fallback\}/, 'the words until it has its size');
  assert.match(source, /pointerEvents: 'none'/, 'the row keeps its long press and scroll');
  assert.doesNotMatch(source, /gray-|indigo-/);

  assert.equal(catalog('messages:row.botHtml.frameTitle'), 'Homeroom bot\'s answer, laid out');
});

test('phone review #97 and #29: the frame keeps the chat\'s leading, and a block of code is a block that scrolls', () => {
  const frame = loadTsx('frontend/src/features/messages/bot-html.tsx');
  const look = {
    vars: Object.fromEntries(frame.REPLY_TOKENS.map(([name, , fallback]) => [name, fallback])),
    dark: false, font: 'system-ui, sans-serif', size: '17px',
  };
  // The plain messages' 17 on 22.1 is the frame's too, read off the words' own classes.
  assert.match(frame.replyFrameDoc('<p>Hi</p>', { ...look, leading: '22.1px' }), /font-size:17px;line-height:22\.1px\}/);
  assert.match(frame.replyFrameDoc('<p>Hi</p>', look), /font-size:17px;line-height:1\.4\}/, 'unread, the frame\'s own');
  assert.doesNotMatch(frame.replyFrameDoc('<p>Hi</p>', { ...look, leading: '1px}</style><script>' }), /<\/style><script>/);
  const source = read('frontend/src/features/messages/bot-html.tsx');
  assert.match(source, /const WORDS_CLASS = 'messages-markdown gc-msg-content';/);
  assert.match(source, /leading = \/\^\\d\+\(\\\.\\d\+\)\?px\$\/\.test\(words\.lineHeight\) \? words\.lineHeight : undefined;/);
  assert.match(source, /'pre\{margin:0 0 \.6em;padding:10px 12px;border-radius:8px;background:var\(--surface-2\);overflow-x:auto;white-space:pre;line-height:1\.5\}/);
});

test('phone review #30: a card under a reply is drawn before its questions and buttons', () => {
  const row = read('frontend/src/features/messages/message-row.tsx');
  const card = row.indexOf('<BotRichCard message={message}');
  const question = row.indexOf('<BotQuestion message={message}');
  assert.ok(card > 0 && question > 0 && card < question, 'the card, then the pills that close the reply');
});
