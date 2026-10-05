// @mentions in rendered markdown (#3952).
//
// DevChat.renderMarkdown — the one renderer issue bodies, issue comments,
// change descriptions, specs and the session discussion share — now chips an
// `@name` as the chat's mention chip, self-tinted when it is the reader's
// own name, and leaves code, links and existing chips alone. The REAL
// shipped module runs in a vm sandbox with the real `marked`, a pass-through
// DOMPurify (the tests feed it input the sanitizer would keep anyway — the
// sanitizer allowlist itself is pinned by tests/spec-markdown.test.js) and a
// small but real DOM shim, because the pass walks text nodes.
//
// The two decorate passes that re-decorate renderMarkdown's output on the
// chat surfaces (features/messages/channels.ts decorateRefs,
// public/js/group-chat.js decorateMentionsAndRefs) must render one chip, not
// nested ones — asserted here against the real decorateRefs.
//
// Run with: node --test tests/dev-chat-mentions.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { marked } = require('marked');
const { loadTsx } = require('./lib/render-tsx');

const DEV_CHAT_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend/src/features/dev-chat/dev-chat.js'), 'utf8');
const GROUP_CHAT_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public/js/group-chat.js'), 'utf8');

// ─── Minimal DOM shim ──────────────────────────────────────────────────────
// Enough of the DOM for the mention pass: parse sanitized HTML into a tree,
// walk it, replace text nodes, serialize back. Void elements are not pushed
// on the open-tag stack.

function makeDom() {
  const VOID = new Set(['br', 'hr', 'img']);
  class TextNode {
    constructor(v) { this.nodeType = 3; this.nodeValue = String(v); this.parentNode = null; }
    get textContent() { return this.nodeValue; }
  }
  class Fragment {
    constructor() { this.__isFragment = true; this.childNodes = []; }
    appendChild(n) { n.parentNode = this; this.childNodes.push(n); return n; }
    removeChild(n) {
      const i = this.childNodes.indexOf(n);
      if (i >= 0) { this.childNodes.splice(i, 1); n.parentNode = null; }
      return n;
    }
  }
  class Element {
    constructor(tag) {
      this.nodeType = 1;
      this.tagName = String(tag).toUpperCase();
      this.childNodes = [];
      this.attributes = {};
      this.className = '';
      this.parentNode = null;
    }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    getAttribute(k) { return this.attributes[k]; }
    appendChild(n) {
      if (n && n.__isFragment) { for (const c of n.childNodes.slice()) this.appendChild(c); return n; }
      if (n.parentNode) n.parentNode.removeChild(n);
      n.parentNode = this; this.childNodes.push(n); return n;
    }
    removeChild(n) {
      const i = this.childNodes.indexOf(n);
      if (i >= 0) { this.childNodes.splice(i, 1); n.parentNode = null; }
      return n;
    }
    replaceChild(newNode, oldNode) {
      const nodes = newNode && newNode.__isFragment ? newNode.childNodes.slice() : [newNode];
      for (const x of nodes) { if (x.parentNode) x.parentNode.removeChild(x); }
      const i = this.childNodes.indexOf(oldNode);
      if (i < 0) return;
      this.childNodes.splice(i, 1, ...nodes);
      for (const x of nodes) x.parentNode = this;
      oldNode.parentNode = null;
    }
    set textContent(v) { this.childNodes = [new TextNode(v)]; if (this.childNodes[0]) this.childNodes[0].parentNode = this; }
    get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
    set innerHTML(v) {
      this.childNodes = [];
      for (const c of parseHTML(String(v)).childNodes.slice()) this.appendChild(c);
    }
    get innerHTML() { return this.childNodes.map(serialize).join(''); }
  }
  function decodeEntities(s) {
    return String(s)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  }
  function parseHTML(html) {
    const frag = new Fragment();
    const stack = [frag];
    const tagRe = /<(\/?)([a-zA-Z0-9]+)((?:\s+[a-zA-Z-]+="[^"]*")*)\s*(\/?)>/g;
    let last = 0; let m;
    const pushText = (raw) => {
      if (raw) stack[stack.length - 1].appendChild(new TextNode(decodeEntities(raw)));
    };
    while ((m = tagRe.exec(html))) {
      if (m.index > last) pushText(html.slice(last, m.index));
      if (m[1] === '/') {
        if (stack.length > 1) stack.pop();
      } else {
        const node = new Element(m[2]);
        const attrRe = /([a-zA-Z-]+)="([^"]*)"/g; let am;
        while ((am = attrRe.exec(m[3]))) {
          if (am[1] === 'class') node.className = am[2];
          else node.setAttribute(am[1], am[2]);
        }
        stack[stack.length - 1].appendChild(node);
        if (m[4] !== '/' && !VOID.has(m[2].toLowerCase())) stack.push(node);
      }
      last = tagRe.lastIndex;
    }
    if (last < html.length) pushText(html.slice(last));
    return frag;
  }
  function escAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }
  function escText(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function serialize(node) {
    if (node.nodeType === 3) return escText(node.nodeValue);
    if (node.__isFragment) return node.childNodes.map(serialize).join('');
    const tag = node.tagName.toLowerCase();
    let attrs = '';
    if (node.className) attrs += ` class="${escAttr(node.className)}"`;
    for (const [k, v] of Object.entries(node.attributes)) attrs += ` ${k}="${escAttr(v)}"`;
    return `<${tag}${attrs}>${node.childNodes.map(serialize).join('')}</${tag}>`;
  }
  return {
    createElement: (t) => new Element(t),
    createTextNode: (v) => new TextNode(v),
    createDocumentFragment: () => new Fragment(),
  };
}

function loadRenderer({ withDocument = true, app } = {}) {
  const dom = makeDom();
  const sandbox = {
    marked,
    DOMPurify: { addHook() {}, sanitize(html) { return html; } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, URL, URLSearchParams, AbortController,
    location: { search: '', protocol: 'http:', host: 'localhost' },
    navigator: {},
    App: app || { user: { id: 1, username: 'alice' } },
  };
  if (withDocument) {
    sandbox.document = { ...dom, addEventListener() {}, getElementById: () => null,
      querySelector: () => null, querySelectorAll: () => [], body: { appendChild() {} } };
    sandbox.window = { matchMedia: () => ({ matches: false }), addEventListener() {} };
  }
  // No window either: the SSG prerender evaluates the module graph bare.
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${DEV_CHAT_SRC}\n;globalThis.__M = DevChat;`, sandbox);
  return { DevChat: sandbox.__M, document: sandbox.document };
}

// group-chat.js in the SAME sandbox: renderMessageBody decorates
// renderMarkdown's output, which now arrives already chipped.
function loadWithGroupChat() {
  const dom = makeDom();
  const sandbox = {
    marked,
    DOMPurify: { addHook() {}, sanitize(html) { return html; } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, URL, URLSearchParams, AbortController,
    location: { search: '', protocol: 'http:', host: 'localhost' },
    navigator: {},
    App: { user: { id: 1, username: 'alice' } },
    document: { ...dom, addEventListener() {}, getElementById: () => null,
      querySelector: () => null, querySelectorAll: () => [], body: { appendChild() {} } },
    window: { matchMedia: () => ({ matches: false }), addEventListener() {} },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    `${DEV_CHAT_SRC}\nglobalThis.__DevChatRef = DevChat;\n${GROUP_CHAT_SRC}`
      + '\n;globalThis.__M = { GroupChat, renderMessageBody, decorateMentionsAndRefs, document, DevChat };',
    sandbox,
  );
  return sandbox.__M;
}

const countChips = (html) => (html.match(/<span class="gc-mention/g) || []).length;

// ── 1. The chip ──

test('an @name in a paragraph is chipped, matched or not', () => {
  const { DevChat } = loadRenderer();
  assert.equal(
    DevChat.renderMarkdown('hey @bob, look at this'),
    '<p class="dc-p">hey <span class="gc-mention">@bob</span>, look at this</p>',
  );
  // A name that resolves to nobody is still chipped — the chip is display.
  assert.match(DevChat.renderMarkdown('ask @nobody_here'), /<span class="gc-mention">@nobody_here<\/span>/);
});

test("the reader's own name wears the self tint", () => {
  const { DevChat } = loadRenderer({ app: { user: { id: 1, username: 'Alice' } } });
  assert.match(DevChat.renderMarkdown('ping @alice and @bob'),
    /<span class="gc-mention gc-mention-self">@alice<\/span>/);
  assert.doesNotMatch(DevChat.renderMarkdown('ping @alice and @bob'),
    /<span class="gc-mention">@alice<\/span>/);
});

test('me@foo.com is an email, not a mention', () => {
  const { DevChat } = loadRenderer();
  assert.doesNotMatch(DevChat.renderMarkdown('mail me@foo.com now'), /gc-mention/);
});

test('"@Homeroom bot" is one chip, as the chat draws it', () => {
  const { DevChat } = loadRenderer();
  const html = DevChat.renderMarkdown('@Homeroom bot could it remind us?');
  assert.match(html, /<span class="gc-mention">@Homeroom bot<\/span> could it remind us\?/);
});

// ── 2. What stays literal ──

test('code blocks, inline code and link text keep their @name as source', () => {
  const { DevChat } = loadRenderer();
  const fenced = DevChat.renderMarkdown('before @bob\n\n```\n@carol\n```\n\nafter @dave');
  assert.match(fenced, /<pre class="dc-code-block"><code>@carol<\/code><\/pre>/);
  assert.equal((fenced.match(/<span class="gc-mention">@/g) || []).length, 2, '@bob and @dave only');
  assert.match(DevChat.renderMarkdown('run `@bob deploy` now'),
    /<code class="dc-inline-code">@bob deploy<\/code>/);
  const linked = DevChat.renderMarkdown('see [@bob](https://example.com/@bob) there');
  assert.match(linked, /<a href="https:\/\/example\.com\/@bob" target="_blank" rel="noopener noreferrer">@bob<\/a>/);
  assert.doesNotMatch(linked, /<span class="gc-mention"/);
});

test('a chip already in the markup is never re-wrapped', () => {
  const { DevChat } = loadRenderer();
  // Raw inline HTML is escaped by the renderer, so an existing chip reaches
  // the pass only from a decorate pass upstream — hand the pass chipped HTML
  // and expect it back untouched.
  const html = DevChat._chipMentions('<p class="dc-p">plain <span class="gc-mention">@bob</span> end</p>');
  assert.equal(html, '<p class="dc-p">plain <span class="gc-mention">@bob</span> end</p>');
  assert.equal(countChips(html), 1, 'one chip in, one chip out');
});

// ── 3. The chat surfaces decorate this output — once ──

test('the group chat body renders one chip, not nested ones', () => {
  const { renderMessageBody, DevChat } = loadWithGroupChat();
  const html = renderMessageBody('hey @bob look');
  assert.equal(countChips(html), 1);
  assert.match(html, /<span class="gc-mention">@bob<\/span>/);
  // The chip is the RENDERER's, cached with the html (the cache key is the
  // text plus flags), not something the decorate pass adds afterwards.
  assert.ok([...DevChat._mdCache.values()].some((e) =>
    Object.values(e.html).some((h) => h.includes('gc-mention'))),
  'the renderer cached the chipped html');
  const bot = renderMessageBody('@Homeroom bot could it remind us?');
  assert.match(bot, /<span class="gc-mention">@Homeroom bot<\/span>/);
  assert.equal((bot.match(/gc-mention/g) || []).length, 1);
});

test('the Messages decorate pass renders once, not nested', () => {
  const { DevChat, document } = loadRenderer();
  const { decorateRefs } = loadTsx('frontend/src/features/messages/channels.ts');
  const html = DevChat.renderMarkdown('hi @bob and PR#7');
  // The renderer already chipped it; decorateRefs must leave the chip as it is.
  assert.match(html, /<span class="gc-mention">@bob<\/span>/);
  const root = document.createElement('div');
  root.innerHTML = html;
  root.ownerDocument = document;
  decorateRefs(root, new Set(), 'carol', null);
  const out = root.innerHTML;
  assert.equal(countChips(out), 1, '@bob stays exactly one chip');
  assert.match(out, /<span class="gc-ref gc-ref-pr" data-ref-type="pr" data-ref-number="7"/, 'refs still decorate');
});

// ── 4. Without a DOM (the SSG prerender), the pass is a no-op ──

test('no DOM: the markdown renders unchanged, unchipped, without throwing', () => {
  const { DevChat } = loadRenderer({ withDocument: false });
  assert.equal(DevChat.renderMarkdown('hey @bob'), '<p class="dc-p">hey @bob</p>');
});
