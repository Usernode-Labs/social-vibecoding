'use strict';

// The review flow's drawn pictures (frontend/src/features/review-flow/
// illustrations.tsx): one outlined object per benefit or group decision, so
// every card in the new Needs you carries a picture even when there are no
// shots to show.
//
// What is pinned, and each is a way it can be quietly wrong:
//
//   1. EVERY KIND DRAWS. Each benefit and decision renders an object, its
//      shadow and its sage part; a kind added to the type without a drawing
//      would throw or draw nothing.
//   2. THE WORDS ARE THE CALLER'S. The label and the token are the strings
//      passed in (already translated); the picture is one image with that
//      label, and nothing in the module is English of its own.
//   3. THE SIZES. A card shows the label, the construction circle and the
//      token; a thumbnail shows the object alone; the hero's replay is a
//      class the stylesheet turns off for reduced motion.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SRC = 'frontend/src/features/review-flow/illustrations.tsx';
const ill = loadTsx(SRC);

const KINDS = [
  ...ill.BENEFIT_KINDS.map((benefit) => ({ benefit })),
  ...ill.DECISION_KINDS.map((decision) => ({ decision })),
];
const nameOf = (k) => k.benefit || k.decision;

function draw(over = {}) {
  return renderToHtml(createElement(ill.Illustration, {
    kind: { benefit: 'speed' },
    label: { main: 'Speed', area: 'Proposals' },
    token: null,
    ground: '#F7E07A',
    width: 358,
    height: 268,
    ...over,
  }));
}

test('the kinds are the nine benefits and four decisions', () => {
  assert.deepEqual([...ill.BENEFIT_KINDS],
    ['fixed', 'stability', 'clarity', 'more', 'results', 'speed', 'effort', 'security', 'behind']);
  assert.deepEqual([...ill.DECISION_KINDS], ['close_issue', 'rename', 'secret_change', 'decision']);
});

test('every kind renders an object with its shadow and its sage part', () => {
  const seen = new Set();
  for (const kind of KINDS) {
    const html = draw({ kind, label: { main: `Label ${nameOf(kind)}`, area: 'Area' } });
    assert.match(html, /^<span class="rf-ill" role="img"/, `${nameOf(kind)}: one image`);
    assert.equal((html.match(/<svg/g) || []).length, 1, `${nameOf(kind)}: one drawing`);
    assert.match(html, /<svg[^>]*aria-hidden="true"/, `${nameOf(kind)}: the drawing itself is hidden`);
    assert.match(html, /filter="url\(#rf-ill-shadow-/, `${nameOf(kind)}: casts the hard shadow`);
    assert.match(html, /class="rf-ill-sage"/, `${nameOf(kind)}: marks what improved in sage`);
    assert.match(html, /fill="#A9CF97"/, `${nameOf(kind)}: the sage is the brand's`);
    // The drawing differs per kind: no two kinds share one picture.
    const body = html.slice(html.indexOf('<svg'), html.indexOf('</svg>'));
    seen.add(body.replace(/rf-ill-shadow-[\w-]+/g, ''));
  }
  assert.equal(seen.size, KINDS.length, 'each kind draws its own object');
});

test('the label is the caller\'s words, and names the image', () => {
  const html = draw({ kind: { benefit: 'fixed' }, label: { main: 'Behoben', area: 'Agenten' } });
  assert.match(html, /aria-label="Behoben, Agenten"/);
  assert.match(html, /class="rf-ill-label"[^>]*>Behoben<span class="rf-ill-area"> · Agenten<\/span>/);
  const plain = draw({ kind: { decision: 'rename' }, label: { main: 'Umbenennen', area: null } });
  assert.match(plain, /aria-label="Umbenennen"/);
  assert.doesNotMatch(plain, /rf-ill-area/, 'no area, no separator');
});

test('a token shows before and after, and is part of the label', () => {
  const html = draw({ token: { before: '259 s', after: '200 s' } });
  assert.match(html, /class="rf-ill-token"/);
  assert.match(html, /class="rf-ill-before"[^>]*>259 s</);
  assert.match(html, /class="rf-ill-after"[^>]*>200 s</);
  assert.match(html, /aria-label="Speed, Proposals, 259 s → 200 s"/);
  assert.doesNotMatch(draw(), /rf-ill-token/, 'no token, no pill');
});

test('a card draws the construction circle; a thumbnail draws the object alone', () => {
  const card = draw();
  assert.match(card, /stroke-dasharray="2 3"/, 'the dotted circle');
  assert.equal((card.match(/<rect[^>]*width="6" height="6"/g) || []).length, 2, 'two anchor handles');
  assert.match(card, /background:#F7E07A/, 'on the caller\'s ground');

  const thumb = draw({ width: 52, height: 52, token: { before: '1', after: '2' } });
  assert.doesNotMatch(thumb, /rf-ill-label|rf-ill-token|stroke-dasharray/);
  assert.match(thumb, /aria-label="Speed, Proposals"/, 'still named for assistive tech');
});

test('the hero replays once, and reduced motion turns it off', () => {
  assert.match(draw({ play: true }), /class="rf-ill rf-ill-play"/);
  assert.doesNotMatch(draw(), /rf-ill-play/);
  const css = read('public/css/app.css');
  const block = css.slice(css.indexOf('.rf-ill {'));
  assert.match(block, /\.rf-ill-play \.rf-ill-sage \{ animation: rf-ill-fill \.(\d+)s/);
  const ms = Number(`0.${block.match(/rf-ill-fill \.(\d+)s/)[1]}`) * 1000;
  assert.ok(ms <= 900, `the replay is short (${ms}ms)`);
  assert.match(block, /prefers-reduced-motion: reduce\)[\s\S]*?\.rf-ill-play \.rf-ill-sage, \.rf-ill-play \.rf-ill-gain \{ animation: none; \}/);
});

test('the module carries no English of its own', () => {
  const code = read(SRC).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  // JSX text children would be the tell: every word comes in through props.
  assert.doesNotMatch(code, />\s*[A-Za-z][a-z]+(\s+[a-z]+)*\s*</, 'no literal words between tags');
  assert.doesNotMatch(code, /aria-label="[^"]/, 'the label is built from props');
});
