'use strict';

// The platform's Markdown renderer (frontend/src/lib/platform-markdown.js):
// its rendered-markdown cache, and the boxes its wide output scrolls in.
//
// Every surface that shows text a person or Homeroom bot wrote renders it
// through PlatformMarkdown.render, and a transcript renders every message
// again whenever anything about it changes. Uncached, each render was a full
// marked + DOMPurify pass over text that had not changed, paid on a phone
// many times a second (the emulated-iPhone audit that #3104 ran on Messages).
// The cache came with the dev chat's smoothness work and moved here with the
// renderer when that chat retired. Pinned by behaviour:
//
//   - a cached render is byte-identical to an uncached one, and every option
//     that changes the output is part of the key;
//   - an unchanged text is parsed and sanitized once;
//   - the one piece of renderer state no option names bypasses the cache;
//   - the cache is bounded, least-recently-used first, and a new marked or
//     DOMPurify empties it;
//   - the no-library fallback is never cached.
//
// And #3559: a fenced block and a wide table scroll sideways inside their own
// box, so no conversation they sit in is held wider than the screen.
//
// Run with: node --test tests/platform-markdown.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Marked } = require('marked');
const { englishPlatformI18n } = require('./lib/platform-i18n');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'lib', 'platform-markdown.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');

/**
 * platform-markdown.js in a vm, as the shell evaluates it: a classic script.
 * `marked` is the real library behind a counting wrapper; DOMPurify is a
 * stand-in that records its config into the output, so a key that forgot
 * the sanitizer's inputs would show up as a mismatch.
 */
function loadMarkdown({ markdown = true } = {}) {
  const counts = { parse: 0, sanitize: 0 };
  const sandbox = { console, PlatformI18n: englishPlatformI18n() };
  if (markdown) {
    // Its OWN marked: the renderers the module registers close over the
    // module that registered them, so two harnesses sharing the library's
    // singleton would each read the other's per-parse flags.
    const instance = new Marked();
    sandbox.marked = {
      use: (...a) => instance.use(...a),
      parse: (...a) => { counts.parse += 1; return instance.parse(...a); },
    };
    sandbox.DOMPurify = {
      addHook() {},
      sanitize(html, cfg) {
        counts.sanitize += 1;
        return `${html}<!--${cfg.ALLOWED_TAGS.includes('img') ? 'img' : 'noimg'}-->`;
      },
    };
  }
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { PlatformMarkdown: sandbox.PlatformMarkdown, sandbox, counts };
}

const SAMPLES = [
  'plain **bold** text',
  'line one\nline two\n\n- [ ] a task\n- [x] done',
  '# Title\n\n1. one\n2. two\n\n| a | b |\n|---|---|\n| 1 | 2 |',
  'see ![shot](https://example.com/a.png) and [a link](https://example.com)',
  '[![img](https://example.com/b.png)](https://example.com/page)\n<img src="https://example.com/c.png" alt="c">',
  '```js:src/app.js\nconst x = 1 < 2;\n```\nand `code`',
];
const OPTION_SETS = [{}, { breaks: false }, { images: true }, { breaks: false, images: true }, { breaks: true }];

test('a cached render is byte-identical to an uncached one, for every option the output depends on', () => {
  const { PlatformMarkdown } = loadMarkdown();
  const reference = loadMarkdown().PlatformMarkdown;
  for (let round = 0; round < 3; round += 1) {
    for (const text of SAMPLES) {
      for (const opts of OPTION_SETS) {
        const expected = reference.render(text, { ...opts, cache: false });
        assert.equal(PlatformMarkdown.render(text, opts), expected,
          `round ${round}, ${JSON.stringify(opts)}: ${JSON.stringify(text)}`);
      }
    }
  }
});

test('every option that changes the output is part of the key', () => {
  const { PlatformMarkdown } = loadMarkdown();
  const text = 'first line\nsecond line\n\n![shot](https://example.com/a.png)';
  const outs = OPTION_SETS.slice(0, 4).map((opts) => PlatformMarkdown.render(text, opts));
  // Soft breaks, inline images and the sanitizer's image allowlist each
  // change the html, so the four combinations are four different answers,
  // and asking again in a different order still gets each its own.
  assert.equal(new Set(outs).size, 4, 'four option sets, four renders');
  const again = OPTION_SETS.slice(0, 4).reverse().map((opts) => PlatformMarkdown.render(text, opts));
  assert.deepEqual(again.reverse(), outs);
  // `breaks: true` and the default are the same render.
  assert.equal(PlatformMarkdown.render(text, { breaks: true }), outs[0]);
});

test('an unchanged text is parsed and sanitized once, however often a transcript republishes', () => {
  const { PlatformMarkdown, counts } = loadMarkdown();
  const first = PlatformMarkdown.render('hello **world**');
  assert.equal(counts.parse, 1);
  for (let i = 0; i < 50; i += 1) assert.equal(PlatformMarkdown.render('hello **world**'), first);
  assert.equal(counts.parse, 1, 'fifty republishes, one parse');
  assert.equal(counts.sanitize, 1, 'and one sanitize');
  PlatformMarkdown.render('hello **world**', { breaks: false });
  assert.equal(counts.parse, 2, 'another option set is another render');
  PlatformMarkdown.render('hello **world**', { cache: false });
  assert.equal(counts.parse, 3, '`cache: false` always renders');
});

test('the one piece of renderer state no option names bypasses the cache instead of being keyed wrong', () => {
  const { PlatformMarkdown, counts } = loadMarkdown();
  const text = '![shot](https://example.com/a.png)';
  PlatformMarkdown.render(text, { images: true });
  assert.equal(counts.parse, 1);
  // Raised only mid-parse by the `link` renderer; were it ever set on entry,
  // the image would render without its full-size link, which no key says.
  PlatformMarkdown._renderImageWithinLink = true;
  const inside = PlatformMarkdown.render(text, { images: true });
  assert.equal(counts.parse, 2, 'not answered from the cache');
  assert.doesNotMatch(inside, /dc-inline-img-link/, 'and rendered for the state it was asked in');
  assert.equal(PlatformMarkdown._renderImageWithinLink, false, 'the flag is still lowered afterwards');
  assert.match(PlatformMarkdown.render(text, { images: true }), /dc-inline-img-link/,
    'the cached entry was not overwritten by the bypass');
  assert.equal(counts.parse, 2);
});

test('the cache is bounded, least-recently-used first, and a new marked/DOMPurify empties it', () => {
  const { PlatformMarkdown, sandbox, counts } = loadMarkdown();
  PlatformMarkdown._MD_CACHE_MAX_ENTRIES = 3;
  for (const t of ['a', 'b', 'c']) PlatformMarkdown.render(t);
  PlatformMarkdown.render('a'); // touch: now the most recent
  PlatformMarkdown.render('d'); // evicts the least recent, 'b'
  assert.deepEqual([...PlatformMarkdown._mdCache.keys()], ['c', 'a', 'd']);
  const before = counts.parse;
  PlatformMarkdown.render('a');
  assert.equal(counts.parse, before, '`a` survived because it was used');
  PlatformMarkdown.render('b');
  assert.equal(counts.parse, before + 1, '`b` was evicted');

  PlatformMarkdown._MD_CACHE_MAX_ENTRIES = 1500;
  PlatformMarkdown._MD_CACHE_MAX_CHARS = 200;
  PlatformMarkdown.render('x'.repeat(150));
  assert.ok(PlatformMarkdown._mdCacheChars <= 200, `character budget holds (${PlatformMarkdown._mdCacheChars})`);

  PlatformMarkdown._MD_CACHE_MAX_CHARS = 6000000;
  PlatformMarkdown.render('stable');
  const parses = counts.parse;
  const other = new Marked();
  sandbox.marked = { use: (...a) => other.use(...a), parse: (...a) => { counts.parse += 1; return other.parse(...a); } };
  PlatformMarkdown.render('stable');
  assert.equal(counts.parse, parses + 1, 'a different marked on the page is a cold cache');
});

test('the no-library fallback is never cached', () => {
  const { PlatformMarkdown } = loadMarkdown({ markdown: false });
  const out = PlatformMarkdown.render('# raw');
  assert.match(out, /dc-md-fallback/);
  assert.ok(!PlatformMarkdown._mdCache || PlatformMarkdown._mdCache.size === 0);
});

test('#3559: a fenced block and a wide table scroll sideways inside their own box', () => {
  // overflow-wrap cannot reach a <pre>, which never wraps, so a long code
  // line scrolls inside the block rather than being wrapped.
  const code = CSS.match(/\.dc-code-block \{[^}]*\}/)[0];
  assert.match(code, /overflow-x: auto;/, 'a long code line scrolls inside the block');
  assert.doesNotMatch(code, /white-space|overflow-wrap/, 'and is never wrapped');
  assert.match(CSS, /\.dc-table \{[^}]*display: block; overflow-x: auto; \}/, 'a wide table scrolls inside itself');
});

test('phone review #29: a fence written at the end of a line of words still opens a block', () => {
  const { PlatformMarkdown } = loadMarkdown();
  const fences = PlatformMarkdown.fencesOnOwnLines;
  // The bot's habit: "Below it, two lines: ```js", then the code. Left as it
  // was, marked read a code span: "js" its first word, the lines joined.
  const glued = 'Below it, two lines: ```js\nconst a = 1;\nconst b = 2;\n```\nAfter.';
  assert.equal(fences(glued), 'Below it, two lines:\n```js\nconst a = 1;\nconst b = 2;\n```\nAfter.');
  const html = PlatformMarkdown.render(glued, { cache: false });
  assert.match(html, /<div class="dc-code-header">js<\/div><pre class="dc-code-block"><code>const a = 1;\nconst b = 2;<\/code><\/pre>/);
  assert.doesNotMatch(html, /dc-inline-code/);
  // A block it opened that way also closes at a fence ending a line of code.
  assert.equal(fences('Below: ```js\nconst a = 1;```\nAfter.'), 'Below:\n```js\nconst a = 1;\n```\nAfter.');
  // Everything else is left as written: a block opened on its own line keeps
  // every line in it, a one-line span stays a span, a fence that ends the
  // text opens nothing, and text with no fence is the same string.
  for (const kept of [
    'Text\n```js\nconst a = `x`;\nfoo ```\n```',
    'Code: ```js const a = 1;``` ok',
    'ends with ```',
    'Use `x` and ``y``\nnext',
  ]) assert.equal(fences(kept), kept, JSON.stringify(kept));
  assert.match(PlatformMarkdown.render('Code: ```js const a = 1;``` ok', { cache: false }), /<code class="dc-inline-code">js const a = 1;<\/code>/);
  // Windows line ends keep theirs.
  assert.equal(fences('Below: ```js\r\nx\r\n```'), 'Below:\r\n```js\r\nx\r\n```');
});
