// Tests for the dev-chat spec-markdown rendering fixes (F1–F8).
//
// Two layers:
//   1. Rendering assertions — configure `marked` exactly as
//      public/js/dev-chat.js renderMarkdown() does and assert the
//      structural output the fixes guarantee (distinct heading levels,
//      ordered-list `start`, table class, task-item spans, and the
//      per-call `breaks` option). marked's tokenizer is the half that's
//      hard to fake, so we exercise the real library; DOMPurify only
//      strips/keeps tags and is covered by the source guards below.
//   2. Source guards on dev-chat.js — assert the real file still wires
//      the DOMPurify allowlist ('h5', 'start') and passes
//      { breaks: false } at both spec surfaces, so the renderer config
//      under test can't silently drift from what ships.
//   3. buildSpecPreview() — the whitespace-aware truncation (F8).
//
// Run with: node --test tests/spec-markdown.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { marked } = require('marked');
const { buildSpecPreview } = require('../src/routes/sessions.js');

// ── Renderer config mirrored from dev-chat.js renderMarkdown() ──
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
marked.use({
  breaks: true,
  gfm: true,
  renderer: {
    code({ text, lang, escaped }) {
      let language = lang || '', filepath = '';
      if (language.includes(':')) { const i = language.indexOf(':'); filepath = language.slice(i + 1); language = language.slice(0, i); }
      const safe = escaped ? text : esc(text);
      const header = filepath ? `<div class="dc-code-header">${esc(filepath)}</div>` : (language ? `<div class="dc-code-header">${esc(language)}</div>` : '');
      return `${header}<pre class="dc-code-block"><code>${safe}</code></pre>`;
    },
    codespan({ text }) { return `<code class="dc-inline-code">${esc(text)}</code>`; },
    html({ text }) { return esc(text); },
    heading({ tokens, depth }) {
      const inner = this.parser.parseInline(tokens);
      const tag = depth === 1 ? 'h3' : depth === 2 ? 'h4' : 'h5';
      const cls = depth === 1 ? 'dc-h3' : depth === 2 ? 'dc-h4' : 'dc-h5';
      return `<${tag} class="${cls}">${inner}</${tag}>`;
    },
    blockquote({ tokens }) { return `<div class="dc-blockquote">${this.parser.parse(tokens)}</div>`; },
    list(token) {
      const { ordered, start, items } = token;
      const tag = ordered ? 'ol' : 'ul';
      const cls = ordered ? 'dc-ol' : 'dc-ul';
      const startAttr = ordered && start !== 1 && start !== '' ? ` start="${start}"` : '';
      let body = '';
      for (const item of items) body += this.listitem(item);
      return `<${tag} class="${cls}"${startAttr}>${body}</${tag}>`;
    },
    listitem(item) {
      const body = this.parser.parse(item.tokens, !!item.loose);
      if (item.task) {
        const mark = item.checked
          ? '<span class="dc-task-check dc-task-checked" aria-hidden="true">&#10003;</span> '
          : '<span class="dc-task-check" aria-hidden="true">&#9744;</span> ';
        return `<li class="dc-task-item">${mark}${body}</li>`;
      }
      return `<li>${body}</li>`;
    },
    table(token) {
      let header = '';
      for (const cell of token.header) header += this.tablecell(cell);
      let body = '';
      for (const row of token.rows) {
        let rowHtml = '';
        for (const cell of row) rowHtml += this.tablecell(cell);
        body += this.tablerow({ text: rowHtml });
      }
      return `<table class="dc-table"><thead>${this.tablerow({ text: header })}</thead>${body ? `<tbody>${body}</tbody>` : ''}</table>`;
    },
    paragraph({ tokens }) { return `<p class="dc-p">${this.parser.parseInline(tokens)}</p>`; },
  },
});

const render = (md, opts = {}) => marked.parse(md, { breaks: opts.breaks !== undefined ? opts.breaks : true });

// ── 1. Rendering assertions ──

test('headings render at three distinct levels (F3)', () => {
  const html = render('# Title\n## Section\n### Sub');
  assert.match(html, /<h3 class="dc-h3">Title<\/h3>/);
  assert.match(html, /<h4 class="dc-h4">Section<\/h4>/);
  assert.match(html, /<h5 class="dc-h5">Sub<\/h5>/);
});

test('ordered list that does not start at 1 keeps its start attribute (F2)', () => {
  const html = render('3. three\n4. four');
  assert.match(html, /<ol class="dc-ol" start="3">/);
});

test('table is tagged with dc-table so it can be styled outside .dc-msg-content (F1)', () => {
  const html = render('| A | B |\n|---|---|\n| 1 | 2 |');
  assert.match(html, /<table class="dc-table">/);
  assert.match(html, /<th>A<\/th>/);
  assert.match(html, /<td>1<\/td>/);
});

test('task list items render non-interactive span markers, not <input> (F4)', () => {
  const html = render('- [ ] todo\n- [x] done');
  assert.doesNotMatch(html, /<input/);
  assert.match(html, /<li class="dc-task-item"><span class="dc-task-check" aria-hidden="true">&#9744;<\/span> /);
  assert.match(html, /<li class="dc-task-item"><span class="dc-task-check dc-task-checked" aria-hidden="true">&#10003;<\/span> /);
});

test('breaks:false keeps soft newlines as whitespace; breaks:true makes <br> (F5)', () => {
  assert.doesNotMatch(render('line one\nline two', { breaks: false }), /<br/);
  assert.match(render('line one\nline two', { breaks: true }), /line one<br>line two/);
});

test('a single fenced code block with the lang:filepath convention renders fully (F6)', () => {
  const html = render('```js:public/js/dev-chat.js\nconst x = 1;\n```');
  assert.match(html, /<div class="dc-code-header">public\/js\/dev-chat\.js<\/div>/);
  assert.match(html, /<pre class="dc-code-block"><code>const x = 1;<\/code><\/pre>/);
});

test('a malformed (unterminated) fence auto-closes and the rest still parses (F6 regression)', () => {
  // marked auto-closes the fence at EOF, so a missing closing fence
  // localizes damage rather than blanking the document.
  const html = render('Intro.\n\n```js\nconst a = 1;');
  assert.match(html, /<p class="dc-p">Intro\.<\/p>/);
  assert.match(html, /<pre class="dc-code-block"><code>const a = 1;/);
});

// ── 2. Source guards on the shipped renderer ──

const devChatSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'dev-chat.js'), 'utf8');

test('DOMPurify allowlist keeps h5 and ol start (F2/F3)', () => {
  const tags = devChatSrc.match(/ALLOWED_TAGS:\s*\[([\s\S]*?)\]/);
  const attrs = devChatSrc.match(/ALLOWED_ATTR:\s*\[([\s\S]*?)\]/);
  assert.ok(tags, 'ALLOWED_TAGS present');
  assert.ok(attrs, 'ALLOWED_ATTR present');
  assert.match(tags[1], /'h5'/);
  assert.match(attrs[1], /'start'/);
});

test('both spec surfaces render with breaks:false (F5)', () => {
  // preview snippet + viewer body must opt out of chat-style hard breaks.
  const matches = devChatSrc.match(/renderMarkdown\([^,)]+,\s*\{\s*breaks:\s*false\s*\}\)/g) || [];
  assert.ok(matches.length >= 2, `expected >=2 breaks:false render sites, found ${matches.length}`);
});

test('the load-failure fallback uses a <pre> view with a notice (F7)', () => {
  assert.match(devChatSrc, /dc-md-fallback-notice/);
  assert.match(devChatSrc, /class="dc-md-fallback"/);
});

// ── 3. buildSpecPreview (F8) ──

test('buildSpecPreview returns short content untouched', () => {
  assert.equal(buildSpecPreview('short spec'), 'short spec');
});

test('buildSpecPreview truncates on a whitespace boundary and appends an ellipsis (F8)', () => {
  const word = 'alpha ';
  const content = word.repeat(120); // ~720 chars of "alpha " tokens
  const out = buildSpecPreview(content);
  assert.ok(out.endsWith('…'));
  assert.ok(out.length <= 401);
  // The cut must land on a token boundary — no half "alph"/"lpha" fragment.
  const body = out.slice(0, -1);
  assert.ok(/(^|\s)alpha\s*$/.test(body) || body.endsWith('alpha'), `cut mid-word: ${JSON.stringify(body.slice(-12))}`);
});

test('buildSpecPreview respects a custom max', () => {
  const out = buildSpecPreview('one two three four five six', 10);
  assert.ok(out.endsWith('…'));
  assert.ok(out.length <= 11);
});
