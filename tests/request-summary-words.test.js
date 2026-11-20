'use strict';

// #6962: a request's summary is drawn with its formatting.
//
// Homeroom bot's summary stands in for the asker's words at the top of a
// request's page. It used to be escaped and split one paragraph per line,
// so a summary carrying a heading, a list or bold showed its markers raw.
// It now goes through the same renderer as the asker's words when it has
// any markdown to render, and keeps its exact old markup when it does not.
//
// The draft pane before filing (`features/messages/request-draft-pane.tsx`)
// already renders through MessageMarkdown, which calls
// PlatformMarkdown.render(…, { breaks: true }); the page's summary calls it
// through `translatedWords` with `{ images: true }`. Both are checked here
// so the chat preview and the page after filing agree.
//
// Run with: node --test tests/request-summary-words.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Marked } = require('marked');
const { englishPlatformI18n } = require('./lib/platform-i18n');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const HEAD = 'frontend/src/features/dev-board/topic/request-head.tsx';
const MARKDOWN_SRC = read('frontend', 'src', 'lib', 'platform-markdown.js');

/**
 * platform-markdown.js in a vm, as the shell evaluates it: a classic script.
 * The real marked library backs it; DOMPurify is a pass-through that keeps
 * every element marked produced, so the structure under test survives.
 * (DOMPurify's own allowlist is held by tests/platform-markdown.test.js.)
 */
function loadPlatformMarkdown() {
  const sandbox = { console, PlatformI18n: englishPlatformI18n() };
  const instance = new Marked();
  sandbox.marked = {
    use: (...a) => instance.use(...a),
    parse: (...a) => instance.parse(...a),
  };
  sandbox.DOMPurify = { addHook() {}, sanitize: (html) => html };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(MARKDOWN_SRC, sandbox);
  return sandbox.PlatformMarkdown;
}

/**
 * `request-head.tsx`'s exported helpers. The module is loaded with no window
 * (its imports register listeners for the shell); each call runs with a
 * window holding the renderer, where the page finds it.
 */
function loadHead(PlatformMarkdown) {
  const mod = loadTsx(HEAD, { cache: false });
  const inPage = (fn) => (...args) => {
    const previous = global.window;
    global.window = { PlatformMarkdown };
    try {
      return fn(...args);
    } finally {
      global.window = previous;
    }
  };
  return { hasMarkdown: inPage(mod.hasMarkdown), summaryWords: inPage(mod.summaryWords) };
}

const FILED = [
  '## What is asked',
  '',
  'Show a filed request the way it was written.',
  '',
  '- headings as headings',
  '- lists as lists',
  '',
  '1. first',
  '2. second',
  '',
  '**Bold** matters, and *italic* does too.',
].join('\n');

test('hasMarkdown is false for prose with no formatting, a multiplication star, or a bare URL', () => {
  const { hasMarkdown } = loadHead(loadPlatformMarkdown());
  for (const text of [
    'Nothing to format here.',
    'First line\nsecond line\n\nA second paragraph.',
    '5 * 3 = 15',
    'See https://example.com/page for the story',
    'issue #6962 is fine',
  ]) {
    assert.equal(hasMarkdown(text), false, text);
  }
});

test('hasMarkdown is true for a heading, a bullet, a numbered item, bold, italic or a link', () => {
  const { hasMarkdown } = loadHead(loadPlatformMarkdown());
  for (const text of ['## What is asked', '- one', '1. one', '**bold**', '*it*', '[a](https://x)']) {
    assert.equal(hasMarkdown(text), true, text);
  }
});

test('a plain summary keeps exactly the markup it had: escaped, a paragraph per line', () => {
  const { summaryWords } = loadHead(loadPlatformMarkdown());
  assert.equal(summaryWords('First line\nSecond <line>'),
    '<div class="dev-issue-body"><p>First line</p><p>Second &lt;line&gt;</p></div>');
});

test('a filed request\'s summary is drawn as headings, lists and bold, with no raw markers', () => {
  const { summaryWords } = loadHead(loadPlatformMarkdown());
  const html = summaryWords(FILED);
  assert.match(html, /^<div class="dev-issue-body">/);
  assert.match(html, /<h4 class="dc-h4">What is asked<\/h4>/, 'the heading is a heading');
  assert.match(html, /<ul class="dc-ul">[\s\S]*?<li>headings as headings<\/li>/, 'bullets are a list');
  assert.match(html, /<ol class="dc-ol">[\s\S]*?<li>first<\/li>/, 'numbers are a list');
  assert.match(html, /<strong>Bold<\/strong>/, 'bold is bold');
  assert.match(html, /<em>italic<\/em>/, 'italic is italic');
  assert.doesNotMatch(html, /\*\*|## |^- /m, 'no marker is left in the words');
});

test('the draft pane\'s renderer call gives the same elements, so the preview and the page agree', () => {
  const PlatformMarkdown = loadPlatformMarkdown();
  const { summaryWords } = loadHead(PlatformMarkdown);
  const page = summaryWords(FILED);
  // features/messages/format.tsx MessageMarkdown, which the draft pane draws with.
  const pane = PlatformMarkdown.render(FILED, { breaks: true });
  for (const element of ['<h4 class="dc-h4">What is asked</h4>', '<ul class="dc-ul">', '<ol class="dc-ol">', '<strong>Bold</strong>']) {
    assert.ok(page.includes(element), `the page has ${element}`);
    assert.ok(pane.includes(element), `the pane has ${element}`);
  }
});

test('the draft pane draws details with MessageMarkdown, and the words get more space between paragraphs', () => {
  const pane = read('frontend', 'src', 'features', 'messages', 'request-draft-pane.tsx');
  assert.match(pane, /import \{ MessageMarkdown \} from '\.\/format';/);
  assert.match(pane, /<MessageMarkdown content=\{details\}/);
  assert.match(read('frontend', 'src', 'features', 'messages', 'format.tsx'),
    /window\.PlatformMarkdown\.render\(content, \{ breaks: true \}\)/);
  const css = read('public', 'css', 'app.css');
  assert.match(css, /\.dev-request-ask-text p,\n\.dev-request-ask-text \.dc-p \{ margin: 0 0 8px; \}/);
  assert.match(css, /\.dev-request-ask-text :is\(\.dc-h3, \.dc-h4, \.dc-h5\):first-child \{ margin-top: 0; \}/);
});
