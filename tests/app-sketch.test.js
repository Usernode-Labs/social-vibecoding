'use strict';

// The first session's sketch (src/services/app-sketch.js): a new project's
// main screen, drawn from its description in about half a minute, shown on
// the made screen (frontend/src/features/first-session/made.tsx) and
// committed as the app's starting screen. What is pinned here:
//
//   1. SAFE. The markup is model output from a user's words, so only the
//      sketch vocabulary survives: no script, handler, link, URL, style,
//      id, image or SVG; text escaped; every element closed.
//   2. ONE VOCABULARY. Every class it keeps is one the app's own Tailwind
//      build compiles (checked by compiling it), and the preview's plain
//      CSS has a rule for each.
//   3. ITS ACCENT IS READABLE. Whatever colour the model asks for, the
//      accent written to the app meets 4.5:1 in both looks.
//   4. THE APP STARTS FROM IT. The repository's first commit carries the
//      sketch as its screen, its accent, its "## Design" notes and
//      design/sketch.*; the first version's request and prompts keep it.
//
// Run with: node --test tests/app-sketch.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sketch = require('../src/services/app-sketch');
const { getTemplateFiles } = require('../src/services/template');
const capture = require('../worker/usernode-bench-capture');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const DESIGN = sketch.normalizeDesign({
  job: 'Log the club\'s Sunday runs and see the week\'s miles',
  primaryAction: 'Log a run',
  accentName: 'tomato red',
  accent: { light: '#e5533d', dark: '#ff8a75' },
  signature: 'A route strip showing this Sunday\'s loop',
  layout: ['Title and this week\'s miles', 'Log a run', 'Recent runs'],
  words: { run: 'run', distance: 'miles' },
});
const HTML = sketch.sanitizeSketchHtml(`
<header class="flex flex-col gap-1"><h1 class="text-title">Sunday Run Club</h1><p class="text-body text-muted">Twelve of us, every Sunday at eight.</p></header>
<section class="card flex items-center justify-between"><div><p class="text-small text-muted">This week</p><p class="text-title tabular-nums">42 miles</p></div><button class="btn-primary">Log a run</button></section>
<section><h2 class="section-label">Recent runs</h2><ul class="list"><li class="list-row justify-between"><span>Priya, 5.2 miles</span><span class="text-small text-muted">Sunday</span></li></ul></section>`);
const ROW = { design: DESIGN, html: HTML, model: 'claude-haiku-4-5', ready_at: '2026-10-04T10:00:00Z' };

// ── 1. Safe ──────────────────────────────────────────────────────────────

test('the sanitizer keeps the vocabulary and nothing else', () => {
  const dirty = `
    <h1 class="text-title bogus-class bg-red-500" id="x" style="color:red" onclick="steal()">Hi &amp; <b>welcome</b></h1>
    <script>alert(1)</script><style>body{display:none}</style>
    <img src="https://evil.test/x.png" onerror="steal()"><svg><a xlink:href="javascript:1"><text>svg text</text></a></svg>
    <a href="https://evil.test" class="btn-primary">Visit</a>
    <iframe src="https://evil.test">frame text</iframe>
    <form action="https://evil.test"><input type="password" name="pw" value="x" formaction="https://evil.test"><button type="submit" formaction="x">Send</button></form>
    <p title="&quot;><script>x</script>">quote</p>
    <div><span>never closed
    <!-- a comment --><![CDATA[ x ]]>
    <p>Run ☀️ club 🏃‍♀️</p>`;
  const out = sketch.sanitizeSketchHtml(dirty);
  for (const bad of ['<script', '<style', '<img', '<svg', '<a ', '<iframe', '<form', 'onclick', 'onerror', 'style=', 'id=',
    'href', 'src=', 'formaction', 'password', 'evil.test', 'bogus-class', 'bg-red-500', 'svg text', 'frame text', 'alert(1)',
    '<!--', 'CDATA', '☀', '🏃']) {
    assert.ok(!out.includes(bad), `${bad} is gone: ${out}`);
  }
  assert.match(out, /<h1 class="text-title">Hi &amp; <b>welcome<\/b><\/h1>/, 'allowed tag and class kept, text escaped');
  assert.match(out, /Visit/, 'the text of a dropped link stays');
  assert.match(out, /<input type="text" value="x">/, 'an input type outside the list is text');
  assert.match(out, /<button type="button">Send<\/button>/, 'a button never submits');
  assert.match(out, /<p title="&quot;&gt;&lt;script&gt;x&lt;\/script&gt;">quote<\/p>/, 'attribute values are escaped');
  assert.match(out, /<div><span>never closed\s*<p>Run\s+club\s*<\/p><\/span><\/div>$/, 'every element is closed');
});

test('the sanitizer never throws, and answers nothing for markup too large to be a sketch', () => {
  for (const input of [null, undefined, '', 42, '<', '</p>', '<<<>>>', '<p class=', '<p class="a'.repeat(1000)]) {
    assert.equal(typeof sketch.sanitizeSketchHtml(input), 'string');
  }
  assert.equal(sketch.sanitizeSketchHtml(`<p>${'x'.repeat(30 * 1024)}</p>`), '');
  // Nesting is capped, so a deep tree cannot grow the page without bound.
  const deep = sketch.sanitizeSketchHtml('<div>'.repeat(100) + 'deep');
  assert.ok((deep.match(/<div>/g) || []).length <= 24);
});

test('a reply is used only when it has a design and something to look at', () => {
  const reply = `Here you go:\n${JSON.stringify({ design: { ...DESIGN }, html: HTML })}\nThanks`;
  const parsed = sketch.parseSketchReply(reply);
  assert.equal(parsed.design.job, DESIGN.job);
  assert.equal(parsed.html, HTML);
  assert.equal(sketch.parseSketchReply('not json'), null);
  assert.equal(sketch.parseSketchReply(JSON.stringify({ design: { job: '' }, html: HTML })), null, 'no job');
  assert.equal(sketch.parseSketchReply(JSON.stringify({ design: DESIGN, html: '<h1>Hi</h1>' })), null, 'too little on it');
  assert.equal(sketch.parseSketchReply(JSON.stringify({ design: DESIGN, html: '<script>a b c d e f g h i j</script>' })), null);
  // The design is kept to known fields, and a bad colour is dropped.
  const odd = sketch.normalizeDesign({ job: 'x', accent: { light: 'red', dark: '#ABCDEF' }, extra: 'no', layout: 'not a list' });
  assert.deepEqual(odd.accent, { light: null, dark: '#abcdef' });
  assert.deepEqual(odd.layout, []);
  assert.equal('extra' in odd, false);
});

test('the page is served sandboxed, with no script and no network, and framed only by Homeroom', () => {
  assert.match(sketch.SKETCH_CSP, /^sandbox;/, 'a sandbox with nothing allowed: no script, an opaque origin');
  assert.match(sketch.SKETCH_CSP, /default-src 'none'/);
  assert.match(sketch.SKETCH_CSP, /style-src 'unsafe-inline'/);
  assert.match(sketch.SKETCH_CSP, /frame-ancestors 'self'/);
  const routes = read('src/routes/apps.js');
  assert.match(routes, /router\.get\('\/api\/apps\/:slug\/sketch\.html'/);
  assert.match(routes, /'Content-Security-Policy': appSketch\.SKETCH_CSP,/);
  assert.match(routes, /'X-Content-Type-Options': 'nosniff',/);
  const made = read('frontend/src/features/first-session/made.tsx');
  assert.match(made, /<iframe\s+title=\{`A sketch of \$\{made\.name\}`\}\s+src=\{`\/api\/apps\/\$\{encodeURIComponent\(made\.slug\)\}\/sketch\.html\?theme=/);
  assert.match(made, /sandbox=""/, 'framed with nothing allowed');
  const doc = sketch.sketchDocument({ name: 'A <b>name</b>', design: DESIGN, html: HTML, theme: 'dark' });
  assert.match(doc, /<title>A &lt;b&gt;name&lt;\/b&gt;: a sketch<\/title>/);
  assert.doesNotMatch(doc, /<script|<link|https?:\/\//);
});

// ── 2. One vocabulary ────────────────────────────────────────────────────

test('every class the sketch may use has a rule in the preview\'s stylesheet', () => {
  const css = sketch.sketchCss(DESIGN);
  const missing = [...sketch.SKETCH_CLASSES].filter((c) => !css.includes(`.${c.replace(/[/:.]/g, (ch) => `\\${ch}`)}{`)
    && !new RegExp(`[.,]${c.replace(/[-/]/g, '\\$&')}[,{]`).test(css));
  assert.deepEqual(missing, []);
});

test('the app\'s own Tailwind build compiles every class the sketch may use', (t) => {
  const pkg = require.resolve('tailwindcss/package.json', { paths: [ROOT] });
  const cli = path.join(path.dirname(pkg), 'lib', 'cli.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-sketch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const every = [...sketch.SKETCH_CLASSES].map((c) => `<div class="${c}">x</div>`).join('\n');
  const files = getTemplateFiles('Run Club', 'run-club-abc', 'postgres://x', null, { sketch: { ...ROW, html: every } });
  for (const f of files) {
    if (!/^(public\/|styles\/|tailwind\.config\.js$)/.test(f.path)) continue;
    fs.mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
    fs.writeFileSync(path.join(dir, f.path), f.content);
  }
  require('node:child_process').execFileSync(process.execPath,
    [cli, '-c', 'tailwind.config.js', '-i', 'styles/tailwind-input.css', '-o', 'out.css'], { cwd: dir, stdio: 'ignore' });
  const out = fs.readFileSync(path.join(dir, 'out.css'), 'utf8');
  const selector = (c) => `.${c.replace(/[/:.]/g, (ch) => `\\${ch}`)}`;
  const missing = [...sketch.SKETCH_CLASSES].filter((c) => !new RegExp(`${selector(c).replace(/[\\.[\]/]/g, '\\$&')}\\s*[,{]`).test(out));
  assert.deepEqual(missing, [], 'compiled by the app');
  // And the two agree where it shows: the type scale and the kit.
  assert.match(out, /\.text-title \{\s*font-size: 1\.75rem;\s*line-height: 2\.25rem;\s*font-weight: 700;/);
  assert.match(sketch.sketchCss(DESIGN), /\.text-title\{font-size:1\.75rem;line-height:2\.25rem;font-weight:700\}/);
  assert.match(out, /\.list-row \{[^}]*min-height: 2\.75rem;/);
  assert.match(sketch.sketchCss(DESIGN), /\.list-row\{display:flex;min-height:2\.75rem;/);
});

test('the preview\'s base tokens are the starter\'s', () => {
  const css = getTemplateFiles('X', 'x', 'postgres://x').find((f) => f.path === 'styles/tailwind-input.css').content;
  for (const [look, selector] of [['light', ':root {'], ['dark', '.dark {']]) {
    const block = css.slice(css.indexOf(selector), css.indexOf('}', css.indexOf(selector)));
    for (const [name, value] of Object.entries(sketch.BASE_TOKENS[look])) {
      assert.match(block, new RegExp(`--${name}: ${value};`), `${look} --${name}`);
    }
  }
});

// ── 3. Its accent is readable ────────────────────────────────────────────

test('any accent is fitted to 4.5:1 in both looks, and an unusable one leaves the kit\'s', () => {
  const math = capture.colorMath();
  const rgb = (s) => { const [r, g, b] = s.split(' ').map(Number); return { r, g, b, a: 1 }; };
  for (const hex of ['#e5533d', '#ffff00', '#00ff00', '#111111', '#7c3aed', '#ffffff', '#000000', '#38bdf8']) {
    const tokens = sketch.accentTokens({ accent: { light: hex, dark: hex } });
    for (const look of ['light', 'dark']) {
      const base = sketch.BASE_TOKENS[look];
      const accent = rgb(tokens[look].accent);
      assert.ok(math.ratio(accent, rgb(base.ground)) >= 4.5, `${hex} ${look} on ground`);
      assert.ok(math.ratio(accent, rgb(base.surface)) >= 4.5, `${hex} ${look} on surface`);
      assert.ok(math.ratio(rgb(tokens[look]['on-accent']), accent) >= 4.5, `${hex} ${look} on-accent`);
    }
  }
  assert.deepEqual(sketch.accentTokens({ accent: { light: null, dark: 'nope' } }), { light: {}, dark: {} });
  assert.deepEqual(sketch.accentTokens(null), { light: {}, dark: {} });
});

// ── 4. The app starts from it ────────────────────────────────────────────

test('the first commit carries the sketch: its screen, its accent, its notes and design/sketch.*', () => {
  const plain = getTemplateFiles('Run Club', 'run-club-abc', 'postgres://x');
  const files = getTemplateFiles('Run Club', 'run-club-abc', 'postgres://x', null, { sketch: ROW });
  const file = (list, p) => list.find((f) => f.path === p)?.content;

  assert.equal(file(plain, 'design/sketch.html'), undefined, 'nothing without a sketch');
  assert.match(file(files, 'design/sketch.html'), /<main class="sketch-screen">[\s\S]*Sunday Run Club/);
  const record = JSON.parse(file(files, 'design/sketch.json'));
  assert.equal(record.job, DESIGN.job);
  assert.equal(record.primaryAction, 'Log a run');
  assert.match(record.note, /The first version keeps its layout, its words and its accent/);

  const index = file(files, 'public/index.html');
  const notice = index.slice(index.indexOf('<!-- usernode-starter-notice@1'), index.indexOf('<!-- /usernode-starter-notice@1 -->'));
  assert.match(notice, /A sketch of Run Club/);
  assert.match(notice, /Sunday Run Club/);
  assert.doesNotMatch(notice, /Welcome to your new app!|What's already working/);
  assert.match(index, /<section class="flex flex-col items-center gap-5" hidden>/, 'the Press! example is hidden');
  assert.match(index, /<p class="text-center text-small text-muted" hidden>Built on Homeroom\./);
  assert.match(index, /id="press-btn"/, 'kept in the DOM: the page\'s script looks it up');

  const css = file(files, 'styles/tailwind-input.css');
  const tokens = sketch.accentTokens(DESIGN);
  assert.match(css, new RegExp(`:root \\{[^}]*--accent: ${tokens.light.accent};`));
  assert.match(css, new RegExp(`\\.dark \\{[^}]*--accent: ${tokens.dark.accent};`));
  assert.notEqual(tokens.light.accent, sketch.BASE_TOKENS.light.accent);

  const notes = file(files, 'CLAUDE.md');
  assert.match(notes, /- \*\*Palette:\*\* accent: tomato red, from the sketch/);
  assert.match(notes, /- \*\*Signature element:\*\* A route strip showing this Sunday's loop/);
  assert.match(notes, /- \*\*Sketch:\*\* `design\/sketch\.html` is the sketch this app's creator was shown/);

  // The sketch's own markup is never what gets hidden.
  const lookalike = getTemplateFiles('Run Club', 'run-club-abc', 'postgres://x', null,
    { sketch: { ...ROW, html: '<section class="flex flex-col items-center gap-5"><p class="text-body">Mine</p></section>' } });
  const lookalikeIndex = file(lookalike, 'public/index.html');
  assert.match(lookalikeIndex, /<section class="flex flex-col items-center gap-5"><p class="text-body">Mine<\/p><\/section>/);
  assert.match(lookalikeIndex, /<section class="flex flex-col items-center gap-5" hidden>\s*<div class="w-full px-1">/);

  // A "$" in the model's words is text, not a replacement pattern.
  const dollars = getTemplateFiles('Run Club', 'run-club-abc', 'postgres://x', null,
    { sketch: { ...ROW, design: { ...DESIGN, signature: 'A $& jar and $1 tips' } } });
  assert.match(file(dollars, 'CLAUDE.md'), /- \*\*Signature element:\*\* A \$& jar and \$1 tips/);

  // Everything else is the starter, unchanged.
  const others = (list) => list.filter((f) => !['public/index.html', 'styles/tailwind-input.css', 'CLAUDE.md'].includes(f.path)
    && !f.path.startsWith('design/'));
  assert.deepEqual(others(files), others(plain));
  // No tells: no hex, no emoji, no eyebrows in what the app ships.
  const tells = capture.lintTells(files.map((f) => ({ path: f.path, text: f.content })));
  assert.equal(tells.hexColours.count, 0, JSON.stringify(tells.hexColours.values));
  assert.equal(tells.emojiIcons.count, 0);
  assert.equal(tells.uppercaseEyebrows.count, 0);
});

test('a starter of its own keeps its screen and gets the design files only', () => {
  const appTemplates = require('../src/services/app-templates');
  const other = appTemplates.TEMPLATE_IDS.find((k) => k !== appTemplates.DEFAULT_TEMPLATE);
  assert.ok(other, 'a starter of its own exists');
  const plain = getTemplateFiles('Run Club', 'run-club-abc', 'postgres://x', null, { template: other });
  const files = getTemplateFiles('Run Club', 'run-club-abc', 'postgres://x', null, { template: other, sketch: ROW });
  assert.deepEqual(files.filter((f) => !f.path.startsWith('design/')), plain);
  assert.deepEqual(files.filter((f) => f.path.startsWith('design/')).map((f) => f.path), ['design/sketch.html', 'design/sketch.json']);
});

test('creation waits a little for the sketch, and one that is late is committed on its own', () => {
  const creator = read('src/services/app-creator.js');
  assert.match(creator, /const sketch = await appSketch\.whenReady\(pool, appId\)\.catch\(\(\) => null\);/);
  assert.match(creator, /template: templateOf\(appRow\), sketch \}\);/);
  assert.match(creator, /appSketch\.commitWhenReady\(pool, \{ appId, name, owner: botUsername, repo: slug \}\);/);
  assert.equal(sketch.SKETCH_WAIT_MS, 30 * 1000);
  const routes = read('src/routes/apps.js');
  assert.match(routes, /if \(req\.body\.from === 'first-session' && !repoUrlNormalized\s+&& require\('\.\.\/services\/homeroom-bot-dm'\)\.normalizeBrief\(req\.body\.brief\)\) \{\s+await require\('\.\.\/services\/app-sketch'\)\.startSketch\(pool, \{/);
});

test('the first version is asked to keep the sketch', () => {
  const dm = require('../src/services/homeroom-bot-dm');
  const withSketch = dm.firstVersionIssue({ name: 'Run Club', username: 'ada', brief: 'Log our runs', sketch: DESIGN });
  assert.match(withSketch.body, /\*\*Design target:\*\* the sketch ada was shown when they made it, `design\/sketch\.html`/);
  assert.match(withSketch.body, /keep its layout, its words and its accent, and list any change under Assumptions/);
  assert.match(withSketch.body, /Its main screen's job: Log the club's Sunday runs/);
  const without = dm.firstVersionIssue({ name: 'Run Club', username: 'ada', brief: 'Log our runs' });
  assert.doesNotMatch(without.body, /Design target/);
  assert.match(read('src/services/homeroom-bot.js'), /When the request names a design target \(`design\/sketch\.html`, described in `design\/sketch\.json`\)/);
  assert.match(require('../src/services/prompts').FIRST_VERSION_SPEC_DESIGN_BRIEF, /If the repository has `design\/sketch\.json`, its creator was already shown that sketch/);
  assert.match(require('../src/services/homeroom-bot-live').FIRST_VERSION_DESIGN_LINES.join(' '), /If the repository has `design\/sketch\.html` and `design\/sketch\.json`/);
});

test('the made screen says what is true: the bot builds it, or the description is its first request', () => {
  const { loadTsx } = require('./lib/render-tsx');
  const made = loadTsx('frontend/src/features/first-session/made.tsx');
  assert.equal(made.buildLine(null, 'running', false), 'Your description is its first request.');
  assert.equal(made.buildNote(true), 'Homeroom bot messages you when it\'s ready to try.');
  assert.equal(made.buildNote(false), 'You or anyone you invite can build it from there.');
  assert.equal(made.sketchCaption('Run Club', true), 'A sketch from your description. Homeroom bot builds the real Run Club from it.');
  assert.match(made.sketchCaption('Run Club', false), /^A sketch from your description\. Nothing on it works yet: the real Run Club is built from it, by you or anyone you invite\.$/);
});
