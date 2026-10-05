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
