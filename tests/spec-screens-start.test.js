// Newcomer run five, item 8: a first version's build starts from the screens
// its spec drew (services/spec-screens-start.js). These pin the mapping (a
// spec's screens and the Empty starter's files in, the starting files out),
// what it refuses to carry into a running app, the commit it makes in the
// worker's checkout, and what the build prompt is told.
//
// Run with: node --test tests/spec-screens-start.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const start = require('../src/services/spec-screens-start');
const live = require('../src/services/homeroom-bot-live');
const template = require('../src/services/template');
const specHtml = require('../src/services/spec-html');

const starter = template.getTemplateFiles('Club Votes', 'club-votes-abc123', 'postgres://x');
const fileOf = (files, p) => (files.find((f) => f.path === p) || {}).content;
const STARTER = {
  index: fileOf(starter, 'public/index.html'),
  inputCss: fileOf(starter, 'styles/tailwind-input.css'),
};

const SCREEN_1 = `<style>
:root { --ground: 250 248 245; --accent: #1d4ed8; --on-accent: 255 255 255; --ballot: 220 38 38; --radius: 14px; }
.app { padding: 16px; --fg: 1 2 3; }
[data-side="after"] { display: block; }
.poll-row { display: flex; gap: 12px; border-radius: var(--radius); }
.chip { --chip: 9 9 9; color: rgb(var(--ballot)); }
@media (min-width: 600px) { .app { padding: 24px; } }
</style>
<div data-side="after" data-change="1"><div class="app">
  <h1 class="text-title">Club Votes</h1>
  <ul class="list"><li class="list-row poll-row"><svg viewBox="0 0 24 24"><path d="M4 12h16"/></svg><span>Pick the next book</span><span class="chip">3 votes</span></li></ul>
  <button class="btn-primary">New poll</button>
</div></div>`;
const SCREEN_2 = `<style>
:root { --accent: 0 0 0; --seat: 1 1 1; }
.poll-row { display: flex; gap: 12px; border-radius: var(--radius); }
.poll-detail { padding: 16px; }
</style><div data-side="after" data-change="2"><section class="poll-detail"><h2 class="text-heading">Pick the next book</h2><a href="https://example.com/rules">Rules</a></section></div>`;

function spec(...screens) {
  return `<article data-spec><h1>Club Votes</h1><section data-spec-tab="user"><figure data-screens><ol data-changes>${
    screens.map((_, i) => `<li data-change="${i + 1}">Screen ${i + 1}</li>`).join('')}</ol>${
    screens.map((m) => `<template data-screen data-size="phone" data-height="1200">${m}</template>`).join('')
  }</figure><p>What it does.</p></section><section data-spec-tab="tech"><p>How.</p></section></article>`;
}

function rootBlock(css, selector) {
  const at = css.indexOf(`${selector} {`, css.indexOf('@layer base'));
  return css.slice(at, css.indexOf('}', at) + 1);
}

// ── The mapping ──────────────────────────────────────────────────────────

test('the spec\'s screens become the starter\'s main screen, its stylesheet and its tokens', () => {
  const out = start.mapScreens({ specHtml: spec(SCREEN_1, SCREEN_2), files: STARTER });
  assert.equal(out.placed, true, out.why);
  assert.deepEqual(out.screens, [1, 2]);
  assert.deepEqual(out.skipped, []);
  assert.deepEqual(out.files.map((f) => f.path).sort(), [start.INDEX_PATH, start.SCREENS_CSS_PATH, start.INPUT_CSS_PATH].sort());

  const index = fileOf(out.files, start.INDEX_PATH);
  // The starter's placeholder screen is gone; everything around it stays.
  assert.ok(!index.includes(start.NOTICE) && !/<main\b/i.test(index));
  for (const kept of ['usernode-dev-console@1', '/usernode-bridge/v1/bridge.js', 'usernode:theme-changed', '<body class="min-h-screen bg-ground text-fg">']) {
    assert.ok(index.includes(kept), kept);
  }
  assert.match(index, /href="\/tailwind\.css">\n {2}<link rel="stylesheet" href="\/screens\.css">/);
  // Screen 1 is the page, as drawn, without the drawing's marks.
  assert.match(index, /<div data-spec-screen="1">\s*<div><div class="app">/);
  assert.ok(index.includes('<button class="btn-primary">New poll</button>'));
  assert.ok(index.includes('<path d="M4 12h16"/>'), 'its inline icon, as drawn');
  assert.ok(!/data-side|data-change=/.test(index));
  assert.ok(!/<style\b/i.test(index), 'its styles moved to public/screens.css');
  // Screen 2 is inert, for the build to move.
  assert.match(index, /<template data-spec-screen="2">\s*<div data-spec-screen="2">\s*<div><section class="poll-detail">/);
  assert.ok(index.includes(start.SENTINEL));

  const css = fileOf(out.files, start.SCREENS_CSS_PATH);
  assert.ok(css.includes('--radius: 14px'), 'a custom property that is not a colour stays');
  // App bench run 193: each screen is one centred column on a wider window,
  // and the drawing's own rules come after it, so they win where they differ.
  assert.match(start.SCREEN_COLUMN_CSS, /\[data-spec-screen\] \{\n {2}width: 100%;\n {2}max-width: 42rem;\n {2}margin-inline: auto;\n\}/);
  assert.ok(css.includes(start.SCREEN_COLUMN_CSS), 'the column opens the screens\' stylesheet');
  assert.ok(css.indexOf(start.SCREEN_COLUMN_CSS) < css.indexOf('--radius: 14px'), 'before the drawing\'s rules');
  assert.equal(css.split(start.SCREEN_COLUMN_CSS).length, 2, 'once, however many screens');
  assert.ok(!/--(?:ground|accent|ballot)\s*:/.test(css), 'the colour tokens moved to the kit');
  assert.match(css, /\[data-spec-screen\] \{\s*display: block;/, 'a selector on the marks names the wrapper');
  assert.ok(css.includes('.chip { --chip: 9 9 9;'), 'a token scoped to one part stays where it was');
  assert.ok(css.includes('@media (min-width: 600px)'));
  assert.equal((css.match(/\.poll-row \{/g) || []).length, 1, 'screen 2 repeats no rule screen 1 has');
  assert.ok(css.includes('.poll-detail'));

  const input = fileOf(out.files, start.INPUT_CSS_PATH);
  const light = rootBlock(input, ':root');
  assert.match(light, /--ground: 250 248 245;/);
  assert.match(light, /--accent: 29 78 216;/, 'a hex kit token is written as the kit writes it');
  assert.match(light, /--ballot: 220 38 38;/, 'a token the kit has not got is added');
  assert.match(light, /--seat: 1 1 1;/, 'and one only screen 2 sets');
  assert.match(light, /--fg: 1 2 3;/, 'the outermost element\'s tokens are the page\'s');
  assert.ok(!/--accent: 0 0 0/.test(input), 'screen 1 wins a token both set');
  assert.equal(rootBlock(input, '.dark'), rootBlock(STARTER.inputCss, '.dark'), 'the dark look is the build\'s to set');
  assert.deepEqual(new Set(out.tokens), new Set(['ground', 'accent', 'on-accent', 'ballot', 'fg', 'seat']));
});

test('the mapped starter still compiles to the kit\'s classes and the drawn tokens', () => {
  const out = start.mapScreens({ specHtml: spec(SCREEN_1), files: STARTER });
  assert.equal(out.placed, true);
  const input = fileOf(out.files, start.INPUT_CSS_PATH);
  // The kit's components are untouched; only :root values changed.
  assert.equal(input.replace(/:root \{[\s\S]*?\}/, ''), STARTER.inputCss.replace(/:root \{[\s\S]*?\}/, ''));
  assert.equal((input.match(/^@tailwind /gm) || []).length, 3);
});

test('a starter already mapped is recognised, not mapped again', () => {
  const out = start.mapScreens({ specHtml: spec(SCREEN_1, SCREEN_2), files: STARTER });
  const again = start.mapScreens({ specHtml: null, files: { index: fileOf(out.files, start.INDEX_PATH), inputCss: STARTER.inputCss } });
  assert.deepEqual(again, { placed: true, already: true, screens: [1, 2] });
  const one = start.mapScreens({ specHtml: spec(SCREEN_1), files: STARTER });
  assert.deepEqual(start.mapScreens({ specHtml: null, files: { index: fileOf(one.files, start.INDEX_PATH) } }).screens, [1]);
});

test('nothing is placed without screens, on anything but the untouched starter, or without the kit', () => {
  assert.equal(start.mapScreens({ specHtml: null, files: STARTER }).placed, false);
  assert.equal(start.mapScreens({ specHtml: '# A markdown spec', files: STARTER }).placed, false);
  const built = STARTER.index.replace(/usernode-starter-notice@1/g, 'gone');
  assert.match(start.mapScreens({ specHtml: spec(SCREEN_1), files: { ...STARTER, index: built } }).why, /untouched starter/);
  assert.equal(start.mapScreens({ specHtml: spec(SCREEN_1), files: { ...STARTER, index: null } }).placed, false);
  assert.match(start.mapScreens({ specHtml: spec(SCREEN_1), files: { ...STARTER, inputCss: '@tailwind base;' } }).why, /tokens/);
  // A game or list starter's own page carries no starter notice.
  for (const t of ['tier-list', 'game-blocks']) {
    let files;
    try { files = template.getTemplateFiles('X', 'x-1', 'postgres://x', null, { template: t }); } catch { continue; }
    const out = start.mapScreens({ specHtml: spec(SCREEN_1), files: { index: fileOf(files, 'public/index.html'), inputCss: fileOf(files, 'styles/tailwind-input.css') } });
    assert.equal(out.placed, false, t);
  }
});

test('a screen that could run or load anything is refused whole', () => {
  const bad = {
    script: '<div><script>alert(1)</script></div>',
    handler: '<button onclick="go()">Go</button>',
    jsUrl: '<a href="javascript:go()">Go</a>',
    image: '<img src="https://example.com/a.png">',
    protoRelative: '<img src="//example.com/a.png">',
    cssUrl: '<style>.a{background:url(https://example.com/a.png)}</style><div class="a"></div>',
    importCss: '<style>@import "x.css";</style><div></div>',
    frame: '<iframe srcdoc="x"></iframe>',
    link: '<link rel="stylesheet" href="/x.css"><div></div>',
    before: '<div data-side="before">old</div><div data-side="after">new</div>',
    placeholder: '<template data-screen data-from="1"></template>',
    empty: '   ',
    huge: `<div>${'x'.repeat(start.MAX_SCREEN_CHARS)}</div>`,
  };
  for (const [name, markup] of Object.entries(bad)) assert.ok(start.unsafeWhy(markup), name);
  for (const ok of [
    '<img src="data:image/png;base64,AAAA" alt="">',
    '<a href="https://example.com">Rules</a>',
    '<a href="#top">Top</a>',
    '<svg viewBox="0 0 24 24"><use href="#i"/></svg>',
    '<style>.a{background:url(data:image/svg+xml;utf8,x)}</style>',
    '<p>Sign on at 9am: one vote each</p>',
  ]) assert.equal(start.unsafeWhy(ok), null, ok);

  const first = start.mapScreens({ specHtml: spec(bad.handler, SCREEN_2), files: STARTER });
  assert.equal(first.placed, false);
  assert.match(first.why, /screen 1 .*event handler/);
  const second = start.mapScreens({ specHtml: spec(SCREEN_1, bad.script), files: STARTER });
  assert.equal(second.placed, true);
  assert.deepEqual(second.screens, [1]);
  assert.deepEqual(second.skipped.map((s) => s.n), [2]);
  assert.ok(!/<script>alert/.test(fileOf(second.files, start.INDEX_PATH)));
});

test('the CSS helpers', () => {
  assert.equal(start.channels('15 118 110'), '15 118 110');
  assert.equal(start.channels('#fff'), '255 255 255');
  assert.equal(start.channels('rgb(1, 2, 3)'), '1 2 3');
  assert.equal(start.channels('rgb(1 2 3)'), '1 2 3');
  assert.equal(start.channels('300 0 0'), null);
  assert.equal(start.channels('var(--x)'), null);
  assert.equal(start.topLevel('a { b: c; }  }'), null, 'unbalanced');
  assert.deepEqual(start.topLevel('/* { */ a { content: "}"; }').map((p) => p.prelude), ['/* { */ a']);
  const lifted = start.liftTokens(':root { --accent: hsl(1 2% 3%); --line: 1 1 1; color: red; }');
  assert.deepEqual(lifted.dropped, ['accent'], 'a kit token that is not a colour would break the kit');
  assert.deepEqual([...lifted.tokens], [['line', '1 1 1']]);
  assert.match(lifted.css, /:root \{\n {2}color: red;\n\}/);
  assert.equal(start.setKitTokens('.x { }', new Map([['a', '1 1 1']])), null);
  assert.equal(start.retargetMarks('[data-side="after"] .a, [data-change=\'2\'] b'), '[data-spec-screen] .a, [data-spec-screen] b');
  assert.equal(start.stripMarks('<div class="a" data-side="after" data-change="1"><br/></div>'), '<div class="a"><br/></div>');
});

// ── The commit, in the worker's checkout ─────────────────────────────────

function gitRepo(branch = 'dev/bot-1') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-screens-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '--quiet', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  for (const [p, c] of [[start.INDEX_PATH, STARTER.index], [start.INPUT_CSS_PATH, STARTER.inputCss]]) {
    fs.mkdirSync(path.join(dir, path.dirname(p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), c);
  }
  git('add', '-A');
  git('commit', '--quiet', '-m', 'starter');
  git('checkout', '--quiet', '-b', branch);
  return { dir, git };
}

// A worker whose scripts run in a local checkout, as the platform's run in
// the worker's (worker.js runBenchCapture: node, in the checkout, with env).
function fakeWorker(dir) {
  const calls = { scripts: [], pushes: [] };
  return {
    calls,
    async runBenchCapture(containerName, { source, env = {}, scriptPath }) {
      calls.scripts.push({ containerName, scriptPath, env });
      const file = path.join(dir, '..', `${path.basename(dir)}-${path.basename(scriptPath)}`);
      fs.writeFileSync(file, source);
      return execFileSync(process.execPath, [file], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
    },
    async execPushFromWorker(sessionId, branchName) {
      calls.pushes.push({ sessionId, branchName });
      return { sha: 'x' };
    },
  };
}

test('startFromScreens commits the starting files on the session branch and pushes them', async () => {
  const { dir, git } = gitRepo();
  const worker = fakeWorker(dir);
  const out = await start.startFromScreens({
    worker, containerName: 'w-1', sessionId: 7, branchName: 'dev/bot-1', specHtml: spec(SCREEN_1, SCREEN_2), env: {},
  });
  assert.deepEqual(out.screens, [1, 2]);
  assert.equal(out.sha, git('rev-parse', 'HEAD'));
  assert.equal(git('log', '-1', '--format=%s %an'), `${start.COMMIT_MESSAGE} usernode-bot`);
  assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').split('\n').sort(),
    [start.INDEX_PATH, start.SCREENS_CSS_PATH, start.INPUT_CSS_PATH].sort());
  assert.equal(git('status', '--porcelain'), '');
  assert.deepEqual(worker.calls.pushes, [{ sessionId: 7, branchName: 'dev/bot-1' }]);
  assert.ok(worker.calls.scripts.every((s) => /^\/tmp\/usernode-[a-z0-9-]+\.js$/.test(s.scriptPath)), 'paths runBenchCapture accepts');

  // A run resumed after it finds them in place, and commits nothing more.
  const again = await start.startFromScreens({
    worker, containerName: 'w-1', sessionId: 7, branchName: 'dev/bot-1', specHtml: null, env: {},
  });
  assert.deepEqual(again, { screens: [1, 2], already: true });
  assert.equal(git('rev-list', '--count', 'HEAD'), '2');
  assert.equal(worker.calls.pushes.length, 1);
});

test('startFromScreens writes nothing on another branch, when off, or without screens', async () => {
  const { dir, git } = gitRepo('elsewhere');
  const worker = fakeWorker(dir);
  const args = { worker, containerName: 'w-1', sessionId: 7, branchName: 'dev/bot-1', specHtml: spec(SCREEN_1) };
  assert.equal(await start.startFromScreens({ ...args, env: {} }), null);
  assert.equal(git('rev-list', '--count', 'HEAD'), '1');
  assert.equal(git('status', '--porcelain'), '');
  assert.equal(worker.calls.pushes.length, 0);

  git('checkout', '--quiet', '-b', 'dev/bot-1');
  const before = worker.calls.scripts.length;
  assert.equal(await start.startFromScreens({ ...args, env: { HOMEROOM_BOT_SPEC_SCREENS: '0' } }), null);
  assert.equal(worker.calls.scripts.length, before, 'off: not even a read');
  assert.equal(await start.startFromScreens({ ...args, specHtml: '# markdown', env: {} }), null);
  assert.equal(await start.startFromScreens({ ...args, worker: {}, env: {} }), null);
  assert.equal(git('rev-list', '--count', 'HEAD'), '1');
  assert.equal(worker.calls.pushes.length, 0);
});

test('startFromScreens never throws', async () => {
  const worker = {
    runBenchCapture: async () => { throw new Error('worker gone'); },
    execPushFromWorker: async () => { throw new Error('no'); },
  };
  assert.equal(await start.startFromScreens({
    worker, containerName: 'w', sessionId: 1, branchName: 'b', specHtml: spec(SCREEN_1), env: {},
  }), null);
});

// ── What the build is told ───────────────────────────────────────────────

test('the build prompt says the screens are in place, only when they are', () => {
  const base = { seed: 'ISSUE', buildNote: 'plan', spec: '# S', firstVersion: true };
  const placed = { screens: [1, 2], tokens: ['accent', 'ballot'], skipped: [], sha: 'abc' };
  const text = live.buildPrompt({ ...base, startingScreens: placed });
  assert.ok(text.includes('THE SPEC\'S SCREENS ARE IN PLACE'));
  assert.ok(text.includes('Do not draw, restyle or rewrite them'));
  assert.ok(text.includes('<template data-spec-screen="2">'));
  assert.ok(text.includes('including the tokens the drawing added (--ballot)'));
  assert.ok(!text.includes('--accent)'), 'a kit token is not listed as added');
  // Run 189: a drawn count ("Open questions, 5") and a drawn status line
  // shipped in the markup, so the loading and error states showed them.
  const flat = text.replace(/\s+/g, ' ');
  assert.ok(flat.includes('Every value drawn there is sample data, not only the rows: a count in a heading ("Open questions, 5")'));
  assert.ok(flat.includes('Empty each in the markup, keeping its element, and set it from real data'));
  assert.ok(flat.includes('The loading, empty and error states never show a drawn value.'));
  assert.ok(!live.buildPrompt(base).includes('SCREENS ARE IN PLACE'));
  assert.ok(!live.buildPrompt({ ...base, firstVersion: false, startingScreens: placed }).includes('SCREENS ARE IN PLACE'));
  const one = live.buildPrompt({ ...base, startingScreens: { screens: [1], tokens: [], skipped: [{ n: 2, why: 'x' }] } });
  assert.ok(one.includes('screen 2 could not be carried over'));
  assert.ok(!one.includes('<template data-spec-screen="2">'));
  assert.ok(live.buildPrompt({ ...base, startingScreens: { screens: [1, 2], already: true } }).includes('SCREENS ARE IN PLACE'));
});

test('the build reads the spec without the screens\' markup once every one is in place', () => {
  const md = specHtml.specHtmlToMarkdown(spec(SCREEN_1, SCREEN_2));
  assert.match(md, /### Screen markup/);
  assert.ok(md.includes('Pick the next book'));
  const shorter = live.specForBuild(md, { screens: [1, 2] });
  assert.ok(shorter.length < md.length);
  assert.ok(!shorter.includes('```html'));
  assert.ok(shorter.includes('## User-facing changes') && shorter.includes('What it does.'));
  assert.match(shorter, /### Screen markup\n\nAlready in the repository/);
  assert.equal(live.specForBuild(md, { screens: [1] }), md, 'a screen still to draw keeps its drawing');
  assert.equal(live.specForBuild(md, null), md);
  assert.equal(live.specForBuild('# plain', { screens: [1] }), '# plain');
});

test('a build turn that added nothing after the platform\'s commit changed nothing', () => {
  const routed = { result: { pushOk: true, ahead: 1, sha: 'abc' } };
  live.pastStartingScreens(routed, { sha: 'abc' });
  assert.equal(routed.result.ahead, 0);
  const built = { result: { pushOk: true, ahead: 2, sha: 'def' } };
  live.pastStartingScreens(built, { sha: 'abc' });
  assert.equal(built.result.ahead, 2);
  const none = { result: { pushOk: true, ahead: 1, sha: 'abc' } };
  live.pastStartingScreens(none, null);
  assert.equal(none.result.ahead, 1);
  assert.doesNotThrow(() => live.pastStartingScreens(null, { sha: 'abc' }));
});
