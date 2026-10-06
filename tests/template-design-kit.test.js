'use strict';

// #3737 (Rec2): the Empty starter, which every new app's first version is
// built from, is a small design system rather than a bare placeholder. The
// taste benchmark judged first versions built from the old starter and
// found low-contrast text in every app, blank or dishonest loading and error
// states, small tap targets and the usual tells. What is pinned here:
//
//   1. COLOUR TOKENS. The shared stylesheet defines a small set of semantic
//      tokens for the light and the dark look, and every text pair they are
//      meant for passes WCAG AA (4.5:1) in both, computed from the values
//      the starter actually renders with the benchmark's own arithmetic.
//      tailwind.config.js names exactly those tokens through theme.extend,
//      so the stock palettes still exist.
//   2. COMPONENTS. A few, on the tokens: 44 px buttons and fields, a list,
//      a card, a sentence-case section label, a 4-step type scale, and the
//      loading, empty and error states.
//   3. THE SCREEN uses only the kit: no hex, no stock palette, no stock
//      size, none of the tells the benchmark's lint counts; and its
//      leaderboard shows honest states (never "No presses yet" for a
//      failure or while loading).
//   4. CLAUDE.md has a "## Design" section the first build fills in.
//
// Only newly created repositories get this; existing apps keep what they
// have. The rendered page's own measurements (contrast, tap targets) are
// tests/bench-capture-run.test.js, which runs the benchmark's capture.
//
// Run with: node --test tests/template-design-kit.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const appTemplates = require('../src/services/app-templates');
const { getTemplateFiles } = require('../src/services/template');
const capture = require('../worker/usernode-bench-capture');

function generate(template = null) {
  return getTemplateFiles('Demo <App>', 'demo-app-abc123', 'postgres://x', null, { template });
}
const file = (files, p) => {
  const found = files.find((f) => f.path === p);
  assert.ok(found, `${p} is generated`);
  return found.content;
};
const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

// ── 1. Colour tokens ─────────────────────────────────────────────────────

const TOKENS = ['ground', 'surface', 'raised', 'fg', 'muted', 'line', 'accent', 'on-accent', 'danger', 'on-danger', 'focus'];

/** { light: { name: {r,g,b,a} }, dark: {...} } from the stylesheet's :root and .dark blocks. */
function tokensOf(css) {
  const body = stripComments(css);
  const block = (selector) => {
    const m = new RegExp(`(?:^|\\n)\\s*${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(body);
    assert.ok(m, `the stylesheet sets the tokens on ${selector}`);
    const out = {};
    for (const [, name, value] of m[1].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
      const channels = value.trim().split(/\s+/).map(Number);
      assert.equal(channels.length, 3, `--${name} is "R G B"`);
      assert.ok(channels.every((c) => Number.isInteger(c) && c >= 0 && c <= 255), `--${name}: ${value}`);
      out[name] = { r: channels[0], g: channels[1], b: channels[2], a: 1 };
    }
    return out;
  };
  return { light: block(':root'), dark: block('.dark') };
}

// [text, background, minimum]: what each token is meant to be read on.
// Text is WCAG AA for body text; the focus ring is a non-text indicator
// (WCAG 1.4.11, 3:1) against what it is drawn on.
const PAIRS = [
  ['fg', 'ground', 4.5], ['fg', 'surface', 4.5], ['fg', 'raised', 4.5],
  ['muted', 'ground', 4.5], ['muted', 'surface', 4.5], ['muted', 'raised', 4.5],
  ['accent', 'ground', 4.5], ['accent', 'surface', 4.5],
  ['danger', 'ground', 4.5], ['danger', 'surface', 4.5],
  ['on-accent', 'accent', 4.5], ['on-danger', 'danger', 4.5],
  ['focus', 'ground', 3], ['focus', 'surface', 3],
];

test('the starter defines the colour tokens once, for both looks, as channels rather than hex', () => {
  const css = file(generate(), 'styles/tailwind-input.css');
  const looks = tokensOf(css);
  for (const look of ['light', 'dark']) {
    assert.deepEqual(Object.keys(looks[look]).sort(), [...TOKENS].sort(), `${look}: exactly the kit's tokens`);
  }
  assert.ok(css.indexOf('@tailwind utilities;') < css.indexOf(':root'), 'after the three @tailwind lines');
  assert.match(css, /@layer base \{\s*:root \{/, 'in the base layer, so it is always in the build');
  assert.match(css, /Re-theme the app HERE: change the values, keep the names\./, 'the one place to re-theme');
  // A tell the benchmark counts, and what the rule asks the app not to write.
  assert.doesNotMatch(stripComments(css), /#[0-9a-f]{3,8}\b/i, 'no hex literal');
});

test('every text pair the tokens are meant for passes WCAG AA in both looks', () => {
  const math = capture.colorMath();
  const looks = tokensOf(file(generate(), 'styles/tailwind-input.css'));
  const failures = [];
  for (const look of ['light', 'dark']) {
    for (const [fg, bg, need] of PAIRS) {
      const ratio = math.ratio(looks[look][fg], looks[look][bg]);
      if (!(ratio >= need)) failures.push(`${look}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, needs ${need}:1`);
    }
  }
  assert.deepEqual(failures, []);
  // The arithmetic is the benchmark's, and it is right.
  assert.equal(Math.round(math.ratio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }) * 100) / 100, 21);
  assert.equal(Math.round(math.ratio({ r: 118, g: 118, b: 118 }, { r: 255, g: 255, b: 255 }) * 100) / 100, 4.54);
});

test('the pair check catches a palette that regresses', () => {
  const math = capture.colorMath();
  const css = file(generate(), 'styles/tailwind-input.css').replace(/--muted: [\d ]+;/, '--muted: 161 161 170;');
  const looks = tokensOf(css);
  assert.ok(math.ratio(looks.light.muted, looks.light.surface) < 4.5, 'a pale grey helper text on white is caught');
});

/** The generated tailwind.config.js, evaluated as the app's build would. */
function configOf(files) {
  const mod = { exports: {} };
  vm.runInNewContext(file(files, 'tailwind.config.js'), { module: mod, exports: mod.exports });
  return mod.exports;
}

test('tailwind.config.js names the tokens through theme.extend, so the stock palettes stay', () => {
  const files = generate();
  const cfg = configOf(files);
  assert.equal(cfg.darkMode, 'class', 'dark stays the class the theme script sets');
  assert.equal(cfg.theme.colors, undefined, 'extends the palette rather than replacing it');
  assert.deepEqual(Object.keys(cfg.theme.extend.colors).sort(), [...TOKENS].sort());
  for (const name of TOKENS) {
    assert.equal(cfg.theme.extend.colors[name], `rgb(var(--${name}) / <alpha-value>)`, name);
  }
  // A four-step type scale, by name.
  const sizes = cfg.theme.extend.fontSize;
  assert.deepEqual(Object.keys(sizes), ['small', 'body', 'heading', 'title']);
  const px = Object.values(sizes).map(([size]) => parseFloat(size) * 16);
  assert.deepEqual(px, [...px].sort((a, b) => a - b), 'smallest to largest');
  assert.ok(px[0] >= 14, 'the smallest is still readable on a phone');
});

// ── 2. Components ────────────────────────────────────────────────────────

/** The @apply list of each component rule in the stylesheet: { '.btn-primary': 'inline-flex ...' }. */
function componentsOf(css) {
  const layer = stripComments(css).split('@layer components {')[1];
  assert.ok(layer, 'a components layer');
  const out = {};
  for (const [, selectors, body] of layer.matchAll(/([.\w\s,-]+)\{\s*@apply ([^;]+);\s*\}/g)) {
    for (const sel of selectors.split(',').map((s) => s.trim()).filter(Boolean)) {
      out[sel] = `${out[sel] || ''} ${body.replace(/\s+/g, ' ')}`.trim();
    }
  }
  return out;
}

test('the component layer: 44 px controls, a list, a card, a label, and the three states', () => {
  const css = file(generate(), 'styles/tailwind-input.css');
  const c = componentsOf(css);
  assert.deepEqual(Object.keys(c).sort(), ['.btn-primary', '.btn-secondary', '.card', '.field', '.list', '.list-row',
    '.section-label', '.skeleton', '.state-empty', '.state-error'].sort());
  for (const sel of ['.btn-primary', '.btn-secondary']) {
    assert.match(c[sel], /\bmin-h-11\b/, `${sel}: 44 px tall`);
    assert.match(c[sel], /\bmin-w-11\b/, `${sel}: and wide`);
    assert.match(c[sel], /focus-visible:ring-focus/, `${sel}: a visible focus ring`);
  }
  assert.match(c['.btn-primary'], /\bbg-accent\b.*\btext-on-accent\b/);
  assert.match(c['.field'], /\bmin-h-11\b/, 'fields are 44 px tall');
  assert.match(c['.list-row'], /\bmin-h-11\b/);
  assert.match(c['.section-label'], /\btext-small\b/);
  assert.doesNotMatch(c['.section-label'], /uppercase|tracking-/, 'sentence case, never an eyebrow');
  assert.match(c['.skeleton'], /motion-safe:animate-pulse/, 'still under reduced motion');
  assert.match(css, /Never put a card inside a card or a \.list\./);
  assert.match(css, /Never show the empty state while loading or for a failure\./);
  // Every utility a component applies is a token or a layout utility: no
  // stock palette, no hex.
  for (const [sel, list] of Object.entries(c)) {
    assert.doesNotMatch(list, STOCK_COLOUR, `${sel} uses tokens only`);
  }
  // `hidden` wins over a component's display, so el.hidden = true always hides.
  assert.match(css, /\[hidden\]:where\(:not\(\[hidden="until-found"\]\)\) \{\s*display: none !important;/);
});

test('the kit compiles: tokens in both looks, components only when used', (t) => {
  const pkg = require.resolve('tailwindcss/package.json', { paths: [path.join(__dirname, '..')] });
  const cli = path.join(path.dirname(pkg), 'lib', 'cli.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-kit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const f of generate()) {
    if (!/^(public\/|styles\/|tailwind\.config\.js$)/.test(f.path)) continue;
    fs.mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
    fs.writeFileSync(path.join(dir, f.path), f.content);
  }
  require('node:child_process').execFileSync(process.execPath,
    [cli, '-c', 'tailwind.config.js', '-i', 'styles/tailwind-input.css', '-o', 'out.css'], { cwd: dir, stdio: 'ignore' });
  const out = fs.readFileSync(path.join(dir, 'out.css'), 'utf8');
  assert.match(out, /:root \{\s*--ground: 250 250 249;/);
  assert.match(out, /\.dark \{\s*--ground: 12 10 9;/);
  assert.match(out, /\.bg-ground \{\s*--tw-bg-opacity: 1;\s*background-color: rgb\(var\(--ground\) \/ var\(--tw-bg-opacity, 1\)\);/);
  assert.match(out, /\.btn-primary,\s*\.btn-secondary \{[^}]*min-height: 2\.75rem;[^}]*min-width: 2\.75rem;/, '44 px each way');
  assert.match(out, /\.state-error \{/);
  assert.match(out, /\.text-title \{\s*font-size: 1\.75rem;/);
  assert.doesNotMatch(out, /\.field \{/, 'a component the screen does not use is not shipped');
});

// ── 3. The screen ────────────────────────────────────────────────────────

const STOCK_HUES = 'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
const STOCK_COLOUR = new RegExp(`(?<![\\w-])(?:[\\w-]+:)*(?:bg|text|border|ring|ring-offset|divide|outline|from|via|to|fill|stroke|placeholder|caret|accent|decoration|shadow)-(?:(?:${STOCK_HUES})-\\d+|white|black)(?![\\w-])`);

test('the starter screen uses only the kit: tokens, the type scale, no raw hex', () => {
  const html = file(generate(), 'public/index.html');
  const body = stripComments(html.slice(html.indexOf('<body')));
  const classes = [...body.matchAll(/class="([^"]*)"|className = '([^']*)'/g)].flatMap((m) => (m[1] || m[2]).split(/\s+/));
  assert.ok(classes.length > 40, 'the screen was read');
  assert.deepEqual(classes.filter((c) => STOCK_COLOUR.test(c)), [], 'no stock palette colour');
  assert.deepEqual(classes.filter((c) => /^(?:[\w-]+:)*text-(?:(?:xs|sm|base|lg|[2-9]?xl)$|\[)/.test(c)), [],
    'no stock or arbitrary text size: the four-step scale only');
  assert.deepEqual(classes.filter((c) => /^(?:[\w-]+:)*dark:/.test(c)), [], 'the tokens carry both looks');
  assert.doesNotMatch(body, /(?<![\w&%])#[0-9a-f]{3,8}\b/i, 'no hex in the markup or its script');
  assert.match(body, /<body class="min-h-screen bg-ground text-fg">/);
});

test('the benchmark\'s tells lint finds nothing in a new app\'s source', () => {
  const tells = capture.lintTells(generate().map((f) => ({ path: f.path, text: f.content })));
  assert.ok(tells.files >= 3, 'index.html, the stylesheet and the Tailwind config are read');
  assert.equal(tells.emojiIcons.count, 0);
  assert.equal(tells.uppercaseEyebrows.count, 0, JSON.stringify(tells.uppercaseEyebrows.samples));
  assert.equal(tells.arbitraryTextSizes.count, 0);
  assert.equal(tells.hexColours.count, 0, JSON.stringify(tells.hexColours.values));
});

// The leaderboard's script, run against a stand-in for its DOM.
function runLeaderboard(html, fetchImpl) {
  const els = new Map();
  const element = (id, hidden = false) => ({
    id, hidden, textContent: '', className: '', children: [], listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    replaceChildren(...kids) { this.children = kids; },
    append(...kids) { this.children.push(...kids); },
  });
  for (const [, id, rest] of html.matchAll(/<\w+ id="([\w-]+)"([^>]*)>/g)) els.set(id, element(id, /\bhidden\b/.test(rest)));
  const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
  const context = vm.createContext({
    window: { location: { search: '?token=t' } },
    document: {
      getElementById: (id) => els.get(id) || null,
      createElement: (tag) => ({ ...element(null), tag }),
    },
    URLSearchParams,
    fetch: fetchImpl,
    console,
  });
  vm.runInContext(script, context);
  const shown = () => ['leaderboard-loading', 'leaderboard', 'leaderboard-empty', 'leaderboard-error'].filter((id) => !els.get(id).hidden);
  return { els, shown };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
const ok = (body) => Promise.resolve({ ok: true, status: 200, json: async () => body });

test('the leaderboard shows honest states: loading, then the list, empty only when it is, error on failure', async () => {
  const html = file(generate(), 'public/index.html');
  // Before anything answers: the skeleton, nothing else.
  let pending;
  let page = runLeaderboard(html, () => new Promise((resolve) => { pending = resolve; }));
  assert.deepEqual(page.shown(), ['leaderboard-loading'], 'loading first, never a blank or an empty state');
  pending({ ok: true, status: 200, json: async () => ({ leaderboard: [] }) });
  await settle();
  assert.deepEqual(page.shown(), ['leaderboard-empty'], 'empty once it loaded and found nothing');

  // A failure is the error state, never "No presses yet".
  for (const failing of [() => Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'Internal Server Error' }) }),
    () => Promise.reject(new TypeError('Failed to fetch'))]) {
    page = runLeaderboard(html, failing);
    await settle();
    assert.deepEqual(page.shown(), ['leaderboard-error']);
  }
  assert.match(html, /<div id="leaderboard-error"[\s\S]*?Couldn't load the leaderboard[\s\S]*?Pressing still works[\s\S]*?>Retry<\/button>/,
    'what failed, what still works, and Retry');

  // Retry: the skeleton again, then the data.
  let calls = 0;
  page = runLeaderboard(html, () => (calls++ === 0 ? Promise.reject(new Error('offline'))
    : ok({ leaderboard: [{ username: '<img src=x onerror=alert(1)>', presses: '2' }] })));
  await settle();
  assert.deepEqual(page.shown(), ['leaderboard-error']);
  page.els.get('leaderboard-retry').listeners.click();
  assert.deepEqual(page.shown(), ['leaderboard-loading']);
  await settle();
  assert.deepEqual(page.shown(), ['leaderboard']);
  const [row] = page.els.get('leaderboard').children;
  assert.equal(row.children[0].textContent, '1. <img src=x onerror=alert(1)>', 'a name is text, never HTML');
  assert.equal(page.els.get('count').textContent, '2 presses so far');
  assert.doesNotMatch(html.slice(html.lastIndexOf('<script>')), /innerHTML/);
});

// ── 4. CLAUDE.md's design record ─────────────────────────────────────────

test('the starter\'s CLAUDE.md has a short "## Design" section the first build fills in', () => {
  const claude = file(generate(), 'CLAUDE.md');
  const start = claude.indexOf('\n## Design\n');
  assert.ok(start !== -1, 'a "## Design" section');
  assert.ok(claude.indexOf('## About Demo <App>') < start && start < claude.indexOf('## App-specific conventions'),
    'app-specific, after About');
  const section = claude.slice(start, claude.indexOf('## App-specific conventions'));
  const flat = section.replace(/\s+/g, ' ');
  // The slots.
  assert.match(flat, /\*\*Palette:\*\* _\(name the accent, any second colour and the neutrals/);
  assert.match(flat, /\*\*Signature element:\*\* _\(/);
  assert.match(flat, /\*\*Type scale:\*\* `text-title`, `text-heading`, `text-body`, `text-small`/);
  assert.match(flat, /\*\*One fixed look:\*\* _\(only for an app drawn as its own scene/);
  // The rules.
  assert.match(flat, /never a raw hex value or a stock palette class/);
  assert.match(flat, /Tap targets are at least 44 px/);
  assert.match(flat, /use the kit's `field` class/);
  assert.match(flat, /phrase a placeholder like `e\.g\. 5\.0`, never a bare plausible value like `5\.0`, which reads as entered data\./);
  assert.match(flat, /honest loading, empty and error states\. Never show the empty state while loading or after a failure; an error says what failed, what still works, and offers Retry\./);
  assert.match(flat, /Seed obviously fake staging demo data so the populated screen can be seen \("Staging mock data" in the platform conventions\)\./);
  assert.match(flat, /No cards in cards, no uppercase eyebrows, no emoji as icons\./);
  assert.match(flat, /The kit is in `styles\/tailwind-input\.css`/);
  assert.ok(section.trim().split('\n').length <= 40, 'short: the long form belongs in a design skill');
  assert.doesNotMatch(section, /—/, 'no em dashes: the agent copies the voice it is given');
  // The notes above it say the kit is not placeholder, and where a fixed look goes.
  assert.match(claude.replace(/\s+/g, ' '), /The design kit is not placeholder either: build the real app with it, and fill in "## Design" below\./);
  assert.match(claude.replace(/\s+/g, ' '), /both looks \(the design kit's colour tokens carry both\), unless one fixed look is the point of this app, like a game's own scene; then say so under "## Design" below\./);
});

test('a starter other than Empty keeps its notes as they were', () => {
  for (const id of appTemplates.TEMPLATE_IDS.filter((x) => x !== appTemplates.DEFAULT_TEMPLATE)) {
    const claude = file(generate(id), 'CLAUDE.md');
    assert.doesNotMatch(claude, /\n## Design\n/, id);
    assert.match(claude.replace(/\s+/g, ' '), /both looks \(Tailwind's `dark:` variants\), unless one fixed look is the point of this app, like a game's own scene; then say so under "App-specific conventions" below\./, id);
    assert.match(claude.replace(/\s+/g, ' '), /When you build forms, phrase a placeholder like `e\.g\. 5\.0`, never a bare plausible value like `5\.0`, which reads as entered data\./, id);
  }
});
