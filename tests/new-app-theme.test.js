'use strict';

// #3688: a new app comes with a light and a dark look, and follows the
// viewer's Homeroom theme by default, live.
//
// The platform already tells an app its theme (#3257): the hosted bridge
// publishes `usernode.theme` and fires `usernode:theme-changed`, pinned in
// tests/app-theme-forwarding.test.js. Nothing in the bridge or the kit
// changes here. What this pins is what NEW apps are made from:
//
//   1. every starter, Empty included, ships the theme script right after the
//      bridge tag and no hard-coded `class="dark"`. Run against the real
//      bridge block, the script paints the platform theme before first paint,
//      follows it live, and uses the OS preference only outside Homeroom;
//   2. the conventions' recommended snippet behaves the same way;
//   3. Empty's screen has both looks: no dark-only colour outside a `dark:`
//      variant (Empty used to be dark-only), and its own Tailwind build
//      compiles the `dark:` half;
//   4. what the agent building the first real version reads says to keep
//      both: the scaffolded CLAUDE.md, the conventions, and the bot's
//      first-version triage note.
//
// Existing apps are left alone on purpose (the requester's decision): only
// a repository created from now on gets any of this.
//
// Run with: node --test tests/new-app-theme.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const appTemplates = require('../src/services/app-templates');
const { getTemplateFiles } = require('../src/services/template');
const prompts = require('../src/services/prompts');
const bot = require('../src/services/homeroom-bot');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const flat = (s) => s.replace(/\s+/g, ' ');

const BRIDGE = read('public/usernode-bridge/v1/bridge.js');
const BRIDGE_THEME = BRIDGE.slice(
  BRIDGE.indexOf('/* __USERNODE_THEME_BEGIN__ */'),
  BRIDGE.indexOf('/* __USERNODE_THEME_END__ */'),
);
const BRIDGE_TAG = '<script src="/usernode-bridge/v1/bridge.js"></script>';

function generate(template) {
  return getTemplateFiles('Demo App', 'demo-app-abc123', 'postgres://x', null, { template });
}
const file = (files, p) => {
  const found = files.find((f) => f.path === p);
  assert.ok(found, `${p} is generated`);
  return found.content;
};

// The first inline <script> after the bridge tag, which must come before
// anything but whitespace and comments, and inside <head>: it has to run
// after the bridge seeds `usernode.theme` and before the body paints.
function themeScriptOf(html, label) {
  const at = html.indexOf(BRIDGE_TAG);
  assert.ok(at !== -1, `${label}: the bridge tag`);
  const rest = html.slice(at + BRIDGE_TAG.length);
  const open = rest.indexOf('<script>');
  assert.ok(open !== -1, `${label}: a theme script after the bridge`);
  assert.equal(rest.slice(0, open).replace(/<!--[\s\S]*?-->/g, '').trim(), '',
    `${label}: the theme script is the very next thing after the bridge tag`);
  const head = html.indexOf('</head>');
  if (head !== -1) assert.ok(at + BRIDGE_TAG.length + open < head, `${label}: in <head>, before first paint`);
  return rest.slice(open + '<script>'.length, rest.indexOf('</script>', open));
}

// A page in a vm: the real bridge theme block, then the page's theme script,
// against a stub window and <html>. `framed` puts it in the shell's frame.
function runPage(script, { search = '', osDark = false, framed = true } = {}) {
  const listeners = {};
  const mediaListeners = [];
  const posted = [];
  const classes = new Set();
  const media = {
    matches: osDark,
    addEventListener(type, fn) { if (type === 'change') mediaListeners.push(fn); },
  };
  const parent = { postMessage(msg) { posted.push(msg); } };
  const win = {
    location: { search },
    usernode: {},
    matchMedia(query) {
      assert.equal(query, '(prefers-color-scheme: dark)');
      return media;
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatchEvent(ev) { (listeners[ev.type] || []).forEach((fn) => fn(ev)); return true; },
  };
  win.parent = framed ? parent : win;
  const root = {
    classList: {
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
      contains: (name) => classes.has(name),
    },
    style: {},
  };
  const context = vm.createContext({
    window: win,
    document: { documentElement: root },
    URLSearchParams,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    Math,
    Date,
    String,
  });
  vm.runInContext(BRIDGE_THEME, context);
  vm.runInContext(script, context);
  const fromShell = (data) => (listeners.message || []).forEach((fn) => fn({ source: parent, data }));
  return {
    get dark() { return classes.has('dark'); },
    get scheme() { return root.style.colorScheme; },
    // The shell pushes a change (the drawer, an OS flip in System mode).
    shellChanges(theme) { fromShell({ __usernode_theme: 'changed', value: { theme } }); },
    // The shell answers the bridge's load-time ask.
    shellAnswers(theme) {
      const ask = posted.find((m) => m.__usernode_theme === 'get');
      assert.ok(ask, 'the bridge asked the shell');
      fromShell({ __usernode_theme: 'response', id: ask.id, value: { theme } });
    },
    osChanges(dark) { media.matches = dark; mediaListeners.forEach((fn) => fn({ matches: dark })); },
  };
}

function assertFollowsThePlatform(script, label) {
  // Before first paint, from the frame URL, whatever the OS says.
  let page = runPage(script, { search: '?token=t&un-theme=dark', osDark: false });
  assert.equal(page.dark, true, `${label}: dark from ?un-theme= before any message`);
  assert.equal(page.scheme, 'dark', `${label}: form controls and scrollbars follow too`);
  page = runPage(script, { search: '?token=t&un-theme=light', osDark: true });
  assert.equal(page.dark, false, `${label}: the platform's Light beats a dark OS`);
  assert.equal(page.scheme, 'light');

  // Live, with no reload, both ways; an OS flip does not override it.
  page.shellChanges('dark');
  assert.equal(page.dark, true, `${label}: follows a change while open`);
  page.osChanges(false);
  assert.equal(page.dark, true, `${label}: the OS does not override the platform`);
  page.shellChanges('light');
  assert.equal(page.dark, false, `${label}: and back`);

  // A frame loaded without the parameter takes the shell's answer.
  page = runPage(script, { search: '', osDark: false });
  assert.equal(page.dark, false);
  page.shellAnswers('dark');
  assert.equal(page.dark, true, `${label}: the answer to the bridge's ask applies`);

  // Outside Homeroom there is no platform theme: the OS decides, live.
  page = runPage(script, { framed: false, osDark: true });
  assert.equal(page.dark, true, `${label}: standalone follows the OS`);
  page.osChanges(false);
  assert.equal(page.dark, false, `${label}: and its changes`);
}

// ── 1. Every starter ships it ────────────────────────────────────────────

for (const id of appTemplates.TEMPLATE_IDS) {
  test(`the ${id} starter follows the viewer's Homeroom theme, before first paint and live`, () => {
    const html = file(generate(id), 'public/index.html');
    assert.doesNotMatch(html, /<html[^>]*\bclass="[^"]*\bdark\b/, 'no look is hard-coded on <html>');
    const body = /<body class="([^"]*)"/.exec(html);
    assert.ok(body, 'the body carries the page ground');
    const tokens = body[1].split(/\s+/);
    // A light ground and a dark one: a `dark:` variant beside it, or (Empty,
    // #3737) the design kit's ground token, which has a value in each look
    // (tests/template-design-kit.test.js).
    assert.ok(tokens.some((c) => /^bg-/.test(c))
      && (tokens.some((c) => /^dark:bg-/.test(c)) || tokens.includes('bg-ground')),
    'a light ground and a dark one');
    assertFollowsThePlatform(themeScriptOf(html, id), id);
  });
}

// ── 2. The conventions' snippet is the same wiring ───────────────────────

test('the conventions\' recommended snippet behaves like the starters\'', () => {
  const section = prompts.getConventionSection('the-platforms-light-dark-theme-inside-the-app-frame');
  assert.ok(section, 'the light/dark section is served');
  const block = /```html\n([\s\S]*?)```/.exec(section.content);
  assert.ok(block, 'the section shows the wiring');
  assertFollowsThePlatform(themeScriptOf(block[1], 'conventions'), 'conventions');
});

// ── 3. Empty has both looks ──────────────────────────────────────────────

// A colour that only reads on a dark page, written without a `dark:` (or any
// other) variant: a dark ground or hairline, or light text. Mid greys such
// as text-zinc-500 read on both and are fine bare.
const COLOUR = /(?<![\w:/-])(bg|from|via|to|border|divide|ring|text)-(zinc|violet)-(\d+)(?:\/\d+)?(?![\w-])/g;
function darkOnly(kind, hue, shade) {
  const n = Number(shade);
  if (kind === 'text') return (hue === 'zinc' && n <= 300) || (hue === 'violet' && n >= 200 && n <= 400);
  return hue === 'zinc' && n >= 700;
}

for (const id of appTemplates.TEMPLATE_IDS) {
  test(`the ${id} starter's screen has no dark-only colour outside a dark: variant`, () => {
    const src = generate(id)
      .filter((f) => /^public\/.*\.(html|js)$/.test(f.path))
      .map((f) => f.content.replace(/<!--[\s\S]*?-->/g, ''))
      .join('\n');
    const bad = [...src.matchAll(COLOUR)].filter((m) => darkOnly(m[1], m[2], m[3])).map((m) => m[0]);
    assert.deepEqual(bad, [], 'each needs a light counterpart, with this one moved under dark:');
  });
}

test('Empty\'s own Tailwind build compiles both looks', (t) => {
  const pkg = require.resolve('tailwindcss/package.json', { paths: [ROOT, path.join(ROOT, 'frontend')] });
  const cli = path.join(path.dirname(pkg), 'lib', 'cli.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'new-app-theme-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const f of generate('empty')) {
    if (!/^(public\/|styles\/|tailwind\.config\.js$)/.test(f.path)) continue;
    fs.mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
    fs.writeFileSync(path.join(dir, f.path), f.content);
  }
  // As the app's own `npm run build` does, from the app's root.
  execFileSync(process.execPath, [cli, '-c', 'tailwind.config.js', '-i', 'styles/tailwind-input.css', '-o', 'out.css'],
    { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  const css = fs.readFileSync(path.join(dir, 'out.css'), 'utf8');
  // #3737: Empty's screen is built from the design kit's tokens, which take
  // their dark values from the class the theme script sets, not the OS.
  assert.match(css, /\.bg-ground \{[^}]*background-color: rgb\(var\(--ground\)/, 'the ground');
  assert.match(css, /:root \{\s*--ground: [\d ]+;/, 'its light value');
  assert.match(css, /\.dark \{\s*--ground: [\d ]+;/,
    'its dark value, keyed off the class the theme script sets, not the OS');
  assert.match(css, /\.rounded-2xl \{/, 'class names the screen\'s markup names compile too');
  assert.doesNotMatch(css, /prefers-color-scheme/, 'darkMode stays class-based');
});

// ── 4. What the first real version is built from says so ────────────────

for (const id of appTemplates.TEMPLATE_IDS) {
  test(`the ${id} starter's CLAUDE.md tells the agent to keep both looks`, () => {
    const claude = flat(file(generate(id), 'CLAUDE.md'));
    assert.match(claude, /follows the viewer's Homeroom theme, switching live/);
    // #3737: Empty's screen gets both from its design kit's colour tokens.
    assert.match(claude, id === 'empty'
      ? /Keep that script, and give everything you build both looks \(the design kit's colour tokens carry both\)/
      : /Keep that script, and give everything you build both looks \(Tailwind's `dark:` variants\)/);
    assert.match(claude, /unless one fixed look is the point of this app/, 'where relevant to the app');
    assert.match(claude, /Unless a request asks for one, add no theme picker/, 'the platform setting is the default');
    assert.match(claude, /The platform's light\/dark theme inside the app frame/, 'points at the conventions');
  });
}

test('Empty\'s README and Tailwind config describe the platform theme, not a fixed dark page', () => {
  const files = generate('empty');
  assert.match(flat(file(files, 'README.md')), /in a light and a dark look that follow the viewer's Homeroom theme/);
  const cfg = file(files, 'tailwind.config.js');
  assert.match(cfg, /darkMode: 'class'/);
  assert.match(flat(cfg), /sets from the viewer's Homeroom theme/);
  assert.doesNotMatch(cfg, /<html class="dark">/);
});

test('the conventions make both looks the default for new apps, and only for new apps', () => {
  const section = flat(prompts.getConventionSection('the-platforms-light-dark-theme-inside-the-app-frame').content);
  assert.match(section, /### New apps: a light and a dark look, following the platform/);
  assert.match(section, /Every new app is built with both a light and a dark look\. It opens in the viewer's Homeroom theme \(`usernode\.theme`\), switches live on `usernode:theme-changed`/);
  assert.match(section, /Keep the template's theme `<script>`/);
  assert.match(section, /No theme picker by default\./);
  assert.match(section, /Only where it is relevant\./);
  assert.match(section, /Existing apps keep what they have\.[^.]*\. Do not convert it as a drive-by\./);
  const notice = flat(prompts.getConventionSection('starter-template-notice-meant-to-be-deleted').content);
  assert.match(notice, /the bridge `<script>` with the theme `<script>` right after it: the first real version keeps the template's light and dark looks/);
});

test('the bot plans a project\'s first version with both looks', () => {
  const seed = 'Issue #1: First version of Seed swap\n\nA place to swap seeds.';
  const first = flat(bot.triagePromptFor({ seed, issueNumber: 1, firstVersion: true }));
  assert.match(first, /Plan it with a light and a dark look that follow the viewer's Homeroom theme and switch live when it changes/);
  assert.match(first, /keep the template's theme script and give every screen both looks/);
  assert.match(first, /Say which in `build_note`, list a single look under `assumptions` when you choose one, and never ask about it\./,
    'it reaches the spec and the build through the plan, and is never a question');
  // Only a first version: an existing app's requests are planned as before.
  const later = flat(bot.triagePromptFor({ seed, issueNumber: 1 }));
  assert.doesNotMatch(later, /Plan it with a light and a dark look/);
});
