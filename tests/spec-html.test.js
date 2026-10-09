// HTML specs (#3699), server half: src/services/spec-html.js.
//
// An HTML spec is stored beside a MARKDOWN PROJECTION of itself, and the
// projection is what every existing reader of spec text gets. These tests pin
// that the projection keeps the shape those readers parse ("# Title", the two
// "## …" halves, "### Questions"), lists each screen's changes in words in the
// User-facing half, keeps screen markup out of that half, and never throws on
// an author who strays from the dialect.
//
// Run with: node --test tests/spec-html.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isHtmlSpec,
  normalizeSpecOutput,
  screenGeometry,
  specChanges,
  specHtmlToMarkdown,
  stripHtmlWrapperFence,
  MAX_SPEC_HTML_CHARS,
} = require('../src/services/spec-html.js');
const { specHasBlockingQuestions } = require('../src/routes/sessions.js');

const SPEC = `<article data-spec>
  <h1>Vote card says how many approvals are left</h1>
  <p>The vote card shows a bar toward the approvals a change needs &amp; who voted.</p>
  <section data-spec-tab="user">
    <figure data-screens>
      <ol data-changes>
        <li data-change="1" data-steps="Dev board → a proposal">The vote card says how many more approvals it needs</li>
        <li data-change="2">It names who approved</li>
      </ol>
      <template data-screen data-size="desktop" data-focus="840 60 440 310">
        <div class="vote-card"><p data-side="before" data-change="1">2 approve</p><div data-side="after" data-change="1">2 more to merge</div></div>
      </template>
      <template data-screen data-size="phone"><div>phone</div></template>
    </figure>
    <h3>Stays the same</h3>
    <ul><li>How votes are counted</li><li>The <strong>Approve</strong> button</li></ul>
    <h3>Questions</h3>
    <ol><li>Should guests see the bar? Default: no.</li></ol>
  </section>
  <section data-spec-tab="tech">
    <figure><svg viewBox="0 0 10 10" role="img"><title>Votes flow into the tally</title><rect width="1" height="1"/></svg><figcaption>Dashed: new code</figcaption></figure>
    <table><tr><th>Rule</th><th>Copy</th></tr><tr><td>At least N</td><td>2 more | to merge</td></tr></table>
    <pre>{ "needed": 4 }</pre>
    <script>alert(1)</script>
  </section>
</article>`;

test('isHtmlSpec: an <article data-spec> document, fenced or not; markdown is not', () => {
  assert.equal(isHtmlSpec(SPEC), true);
  assert.equal(isHtmlSpec('```html\n' + SPEC + '\n```'), true);
  assert.equal(isHtmlSpec('# Title\n\n## User-facing changes\n'), false);
  assert.equal(isHtmlSpec('<article><p>no marker</p></article>'), false);
  assert.equal(isHtmlSpec(null), false);
});

test('stripHtmlWrapperFence unwraps only a whole-document html fence around an article', () => {
  assert.equal(stripHtmlWrapperFence('```html\n' + SPEC + '\n```'), SPEC);
  const notArticle = '```html\n<div>x</div>\n```';
  assert.equal(stripHtmlWrapperFence(notArticle), notArticle);
});

test('projection keeps the markdown spec shape its readers parse', () => {
  const md = specHtmlToMarkdown(SPEC);
  assert.match(md, /^# Vote card says how many approvals are left\n/);
  assert.match(md, /\n## User-facing changes\n/);
  assert.match(md, /\n## Technical implementation\n/);
  assert.ok(md.indexOf('## User-facing changes') < md.indexOf('## Technical implementation'));
  assert.match(md, /a change needs & who voted\./, 'entities decode');
  assert.match(md, /\n### Questions\n/);
  assert.equal(specHasBlockingQuestions(md), true, 'the blocking-questions reader still sees the section');
});

test('projection: changes in words in the User-facing half, markup only in the Technical half', () => {
  const md = specHtmlToMarkdown(SPEC);
  const [user, tech] = md.split('## Technical implementation');
  assert.match(user, /1\. The vote card says how many more approvals it needs \(Dev board → a proposal\)/);
  assert.match(user, /2\. It names who approved/);
  assert.doesNotMatch(user, /data-side|```html|<div/);
  assert.match(tech, /### Screen markup/);
  assert.match(tech, /Desktop 1280×800, close-up 840 60 440 310:/);
  assert.match(tech, /Phone 390×844:/);
  assert.match(tech, /```html\n<div class="vote-card">/);
});

test('projection: diagrams by their title, tables as GFM, pre as a fence, scripts dropped', () => {
  const md = specHtmlToMarkdown(SPEC);
  assert.match(md, /\*Diagram: Votes flow into the tally\*/);
  assert.match(md, /\*Dashed: new code\*/);
  assert.match(md, /\| Rule \| Copy \|\n\| --- \| --- \|\n\| At least N \| 2 more \\\| to merge \|/);
  assert.match(md, /```\n\{ "needed": 4 \}\n```/);
  assert.doesNotMatch(md, /alert\(1\)/);
});

test('projection tolerates broken markup and stray angle brackets', () => {
  const md = specHtmlToMarkdown('<article data-spec><h1>T</h1><section data-spec-tab="user"><p>a < b <b>unclosed');
  assert.match(md, /# T/);
  assert.match(md, /a < b \*\*unclosed/);
});

test('screenGeometry: fixed sizes, bounded height, focus clamped to the screen', () => {
  assert.deepEqual(screenGeometry({ 'data-size': 'phone' }), { kind: 'phone', width: 390, height: 844, focus: null });
  assert.deepEqual(screenGeometry({}), { kind: 'desktop', width: 1280, height: 800, focus: null });
  assert.equal(screenGeometry({ 'data-height': '99999' }).height, 2400);
  assert.equal(screenGeometry({ 'data-height': '10' }).height, 800);
  assert.deepEqual(screenGeometry({ 'data-focus': '1200 700 400 400' }).focus, [1200, 700, 80, 100]);
  assert.equal(screenGeometry({ 'data-focus': 'nonsense' }).focus, null);
});

test('normalizeSpecOutput: markdown passes through; html gets a projection; oversize keeps only the projection', () => {
  assert.deepEqual(normalizeSpecOutput('# T\n'), { markdown: '# T\n', html: null });
  const r = normalizeSpecOutput('```html\n' + SPEC + '\n```');
  assert.equal(r.html, SPEC);
  assert.match(r.markdown, /## User-facing changes/);
  const big = SPEC.replace('</article>', `<p>${'x'.repeat(MAX_SPEC_HTML_CHARS)}</p></article>`);
  const o = normalizeSpecOutput(big);
  assert.equal(o.html, null);
  assert.match(o.markdown, /# Vote card/);
});

// A first version's spec draws up to two finished screens, each with a
// <style> block and inline SVG icons (prompts.js FIRST_VERSION_SCREENS_BRIEF),
// and the build takes their markup as its visual target. It reaches the build
// through the markdown projection's "### Screen markup", whole.
const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M4 12h16"/><circle cx="12" cy="12" r="8"/></svg>';
const DRAWN = (rows, { extra = '' } = {}) => `<article data-spec>
  <h1>A first version</h1>
  <section data-spec-tab="user">
    <figure data-screens>
      <ol data-changes><li data-change="1">The main screen, with the demo data</li></ol>
      <template data-screen data-size="phone" data-height="1300">
        <style>:root{--ground:250 250 249;--accent:15 118 110}.list-row{padding:12px 16px;color:rgb(var(--fg))}</style>
        <div data-side="after" data-change="1"><header>${ICON}<h2>Today</h2></header>
          <ul class="list">${Array.from({ length: rows }, (_, i) => `<li class="list-row">${ICON}<span>Staging demo row ${i}</span></li>`).join('')}</ul>${extra}
        </div>
      </template>
    </figure>
  </section>
  <section data-spec-tab="tech"><p>Build it.</p></section>
</article>`;

test('a drawn screen\'s <style> block and inline SVG reach the build whole, in the projection\'s screen markup', () => {
  const doc = DRAWN(3);
  const md = specHtmlToMarkdown(doc);
  const markup = md.slice(md.indexOf('### Screen markup'));
  assert.match(markup, /Phone 390×1300:/);
  assert.ok(markup.includes('<style>:root{--ground:250 250 249;--accent:15 118 110}.list-row{padding:12px 16px;color:rgb(var(--fg))}</style>'));
  assert.equal(markup.split(ICON).length - 1, 4, 'every icon, as drawn');
  assert.ok(markup.includes('<div data-side="after" data-change="1">'));
  // And none of it in the half a non-developer reads.
  assert.doesNotMatch(md.slice(0, md.indexOf('## Technical implementation')), /<svg|<style/);
  assert.equal(normalizeSpecOutput(doc).html, doc, 'the document itself is stored as written');
  // The viewer draws it with both kept: a screen loses only what would load,
  // run or navigate (frontend/src/lib/spec-html.ts cleanScreenMarkup).
  const viewer = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'frontend', 'src', 'lib', 'spec-html.ts'), 'utf8');
  const dropped = /const SCREEN_DROP = '([^']*)'/.exec(viewer)[1].split(',');
  for (const kept of ['style', 'svg', 'path', 'circle', 'rect']) assert.ok(!dropped.includes(kept), `${kept} stays in a screen`);
});

test('screenStats measures each drawn screen and flags one past twice its budget, cutting nothing', () => {
  const { screenStats, SCREEN_CHAR_BUDGET } = require('../src/services/spec-html.js');
  assert.equal(SCREEN_CHAR_BUDGET, 20000);
  const [small] = screenStats(DRAWN(3));
  assert.deepEqual(Object.keys(small), ['size', 'height', 'chars', 'svgs', 'shapes', 'overBudget']);
  assert.equal(small.size, 'phone');
  assert.equal(small.height, 1300);
  assert.equal(small.svgs, 4);
  assert.equal(small.shapes, 8);
  assert.equal(small.overBudget, false);
  assert.ok(small.chars > 500 && small.chars < SCREEN_CHAR_BUDGET);
  const painting = DRAWN(3, { extra: `<svg viewBox="0 0 400 400">${'<path d="M0 0L1 1"/>'.repeat(2000)}</svg>` });
  const [big] = screenStats(painting);
  assert.equal(big.overBudget, true);
  assert.ok(big.chars > 2 * SCREEN_CHAR_BUDGET);
  assert.equal(big.shapes, 2008);
  assert.ok(normalizeSpecOutput(painting).html.includes('M0 0L1 1'), 'measured, never cut');
  assert.deepEqual(screenStats('# A markdown spec'), []);
  assert.deepEqual(screenStats(null), []);
});

// ── specChanges: the spec's before and after list, as the shots read it ──

const CHANGES_SPEC = `<article data-spec>
  <h1>T</h1>
  <section data-spec-tab="user">
    <figure data-screens>
      <ol data-changes>
        <li data-change="1" data-steps="Dev board &rarr; a proposal">The vote card &amp; its bar</li>
        <li data-change="2" data-steps="Communities → project → Workshop">It names who approved</li>
      </ol>
      <template data-screen data-size="phone" data-persona="Guest"><div data-side="after" data-change="1">phone</div></template>
      <template data-screen data-size="desktop"><div data-change="2">desktop</div></template>
    </figure>
    <h3>Questions</h3>
    <ol><li>Should guests see the bar? Default: no.</li></ol>
  </section>
  <section data-spec-tab="tech"><p>Build it.</p></section>
</article>`;

test('specChanges: one entry per <li>, text decoded and collapsed, steps verbatim, the screens that mark it', () => {
  assert.deepEqual(specChanges(CHANGES_SPEC), [
    {
      n: '1',
      text: 'The vote card & its bar',
      steps: 'Dev board → a proposal',
      screens: [{ size: 'phone', persona: 'guest' }],
    },
    {
      n: '2',
      text: 'It names who approved',
      steps: 'Communities → project → Workshop',
      screens: [{ size: 'desktop', persona: null }],
    },
  ], 'each screen lists only where its markup carries the entry\'s data-change');
});

test('specChanges: an entry no screen marks gets every screen, in document order', () => {
  const doc = `<article data-spec><section data-spec-tab="user"><figure data-screens>
    <ol data-changes><li data-change="1" data-steps="A → B">Both screens show it</li></ol>
    <template data-screen data-size="desktop"></template>
    <template data-screen data-size="phone" data-persona="full_admin"></template>
  </figure></section></article>`;
  const [entry] = specChanges(doc);
  assert.deepEqual(entry.screens, [
    { size: 'desktop', persona: null },
    { size: 'phone', persona: 'full_admin' },
  ]);
});

test('specChanges: nothing readable is still no exception; the first list only', () => {
  assert.deepEqual(specChanges('# A markdown spec'), [], 'markdown is not an HTML spec');
  assert.deepEqual(specChanges(null), []);
  assert.deepEqual(
    specChanges('<article data-spec><h1>T</h1><section data-spec-tab="user"><p>no list</p></section></article>'),
    [],
  );
  assert.deepEqual(specChanges('<article data-spec><ol data-changes></ol></article>'), [], 'an empty list');
  // A plain <ol> elsewhere (Questions) is not the changes list; a second
  // <ol data-changes> is never read.
  const two = CHANGES_SPEC.replace('<ol data-changes>\n        <li data-change="1"',
    '<ol data-changes><li data-change="0">Early</li></ol><ol data-changes>\n        <li data-change="1"');
  assert.deepEqual(specChanges(two).map((e) => e.n), ['0'],
    'the first list is the one read, whole; the second is never read');
});

