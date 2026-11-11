// Needs you in the one frame (version 2 of the tour's s26). Needs you is the
// product's review stage (features/review-flow/: one change at a time, its
// plates and strip, Yes | No with Skip or Next, the sheets) on a project's
// page and on #needs. Under a look nothing of it is redrawn: the project
// page's head is the kit's, without buttons, over the project's places, and
// the stage wears the look through the wear map (frontend/looks/looks.json)
// and one block of hand rules in app.css that sets no measure of the stage.
//
// Run with: node --test tests/needs-frame.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const css = read('public/css/app.css');
const hand = css.slice(css.indexOf('THE FRAME IN THE SHELL'), css.indexOf('/* looks:begin'));
const block = hand.slice(hand.indexOf('/* NEEDS YOU, THE REVIEW STAGE'), hand.indexOf('/* SETTINGS (features/settings/index.tsx)'));
const roots = JSON.parse(read('frontend/looks/looks.json')).wear.roots;
const wearers = (name) => [roots[name], ...(roots[name].also || [])];
const wearer = (name, piece) => wearers(name).find((w) => w.to.includes(piece));

test('the place\'s head is the kit\'s title, sentence and places, with no button', () => {
  const page = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(page, /<ProjectFrameHead \{\.\.\.frameHead\} title=\{tab === 'workshop' && weekUp \? weekName\(weekUp\) : pageTitle\(tab\)\} purpose=\{framePurpose\} \/>/);
  assert.match(page, /: tab === 'needs' \? t\('project:frame\.place\.needs', \{ project: projectName \}\)/);
  assert.match(page, /\{ key: 'needs', label: t\('project:places\.list\.needsYou'\), count: owed \}/, 'the tab counts the votes owed');
  const frame = read('frontend/src/features/dev-board/workshop/frame/project-frame.tsx');
  const head = frame.slice(frame.indexOf('export function ProjectFrameHead('), frame.indexOf('/** A person as a face'));
  assert.match(head, /<Head title=\{title\} purpose=\{purpose \|\| undefined\} \/>\s+<PlaceTabs \{\.\.\.head\} \/>/);
  assert.doesNotMatch(frame, /onAsk|useActs|project:frame\.(ask|invite)'/, 'Invite and Ask for a change were the first tour\'s');
  const catalog = JSON.parse(read('frontend/locales/en/project.json'));
  assert.equal(catalog['frame.ask'], undefined);
  assert.equal(catalog['frame.invite'], undefined);
  assert.ok(catalog['frame.place.needs'], 'the sentence under the title stays');
});

test('the stage is the product\'s on both pages: nothing is drawn in its place under a look', () => {
  const page = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(page, /\{tab === 'needs' && slug \? \(/);
  assert.match(page, /<ProjectReviewFlow slug=\{slug\} onDone=\{\(\) => openTab\('status'\)\} \/>/);
  for (const file of ['review-flow/review-flow.tsx', 'review-flow/vote-sheet.tsx', 'review-flow/compare.tsx', 'workshop/index.tsx', 'workshop/vote-filter.tsx']) {
    assert.doesNotMatch(read('frontend/src/features', file), /useSkin|useLiveSkin|isFrameSkin|components\/ui\/kit/, `${file} does not know the look`);
  }
});

test('the stage wears the kit by the wear map, each a wearer of its own', () => {
  assert.ok(wearer('card', '.rf-page'), 'the change\'s page is the look\'s card');
  assert.equal(wearer('card', '.rf-page').to, ':is(.rf-page,.rf-desc-help)');
  assert.notEqual(wearer('card', '.rf-page'), roots.card, 'not folded into the first wearer\'s :is()');
  assert.equal(wearer('ib', '.rf-back').to, ':is(.rf-back,.rf-bar-toggle)', 'its back and its fold are the round button');
  assert.equal(wearer('sub17', '.rf-bar-title').to, ':is(.rf-bar-title,.rf-why-head,.rf-sub h2)');
  const btn = wearer('btn', '.rf-morph');
  assert.equal(btn.to, ':is(.rf-go,.rf-desc-go,.rf-end-btn,.rf-morph,.rf-chip,[data-needs-vote-chip])');
  assert.match(btn.parts.quiet, /\.rf-morph:not\(\[data-rf-morph="next"\]\)/, 'Skip is quiet, Next is the page\'s primary');
  assert.match(btn.parts.quiet, /\.rf-chip:not\(\[aria-checked="true"\]\)/, 'a reason is quiet until chosen');
  assert.match(btn.parts.quiet, /\[data-needs-vote-chip\]:not\(\[aria-pressed="true"\]\)/);
  assert.equal(btn.parts.sm, '[data-needs-vote-chip]');
  assert.equal(btn.parts.off, ':disabled');
  assert.deepEqual(wearer('row', '.rf-help-row'), { to: '.rf-help-row', parts: { t: 'span', go: 'svg:last-child', sm: '' } });
  assert.deepEqual(wearer('inp', '.rf-ask-form'), { to: '.rf-ask-form input', parts: { val: '', focus: ':focus' } });
  // Compiled, a look's own card and button reach the stage.
  assert.match(css, /html\[data-skin="workbench"\] \.fr-card,[^{]*html\[data-skin="workbench"\] :is\(\.rf-page,\.rf-desc-help\)(?:,[^{]*)?\{border-radius:10px/);
  assert.match(css, /html\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\) :is\(\.rf-go,\.rf-desc-go,\.rf-end-btn,\.rf-morph,\.rf-chip,\[data-needs-vote-chip\]\):disabled(?:,[^{]*)?\{opacity:\.45\}/);
});

test('the hand rules give the stage the kit\'s tokens and set none of its measures', () => {
  assert.ok(block.length > 500, 'the block is there');
  const tokens = block.match(/html\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\) :is\(\.rf-run, \.rf-page-wrap\) \{([^}]*)\}/);
  assert.ok(tokens);
  for (const pair of ['--rf-page: var(--fr-solid, var(--fr-surface));', '--rf-fill: var(--fr-sunk);', '--rf-ink: var(--fr-ink);', '--rf-muted: var(--fr-mut);', '--rf-line: var(--fr-line);', 'font-family: var(--fr-f);']) {
    assert.ok(tokens[1].includes(pair), pair);
  }
  assert.match(block, /\.rf-page-wrap \.rf-page \{ background: var\(--rf-page\); color: var\(--rf-ink\); backdrop-filter: none;/, 'solid: one change slides in over another');
  assert.match(block, /\.rf-pair-thumb \{ background: var\(--fr-acc\); \}/, 'the choice is the accent');
  assert.match(block, /\.rf-vrow \.rf-morph \{ height: 52px; padding: 0;/, 'the vote row keeps the height the stage counts on');
  assert.match(block, /\[data-needs-vote-chip\]\.hidden \{ display: none; \}/, 'a worn button\'s display does not bring back a chip with nothing to count');
  // Every rule is for a look, never the New look or the standard one.
  for (const rule of block.split('\n').filter((line) => /^[^\s/].*\{/.test(line))) assert.match(rule, /^html\[data-skin(="[a-z]+")?\]/, rule);
  for (const rule of block.split('\n').filter((line) => /^html\[data-skin\]/.test(line))) assert.match(rule, /^html\[data-skin\]:(where\(:)?not\(\[data-skin="brand"\]\)/, rule);
  // What the stage measures itself by is not restated: the page's column and height, the picture, the strip.
  const sized = block.split('\n').filter((line) => /^html/.test(line) && /\b(width|max-width|min-height|max-height|inset|top|bottom)\s*:/.test(line.slice(line.indexOf('{'))));
  assert.deepEqual(sized, []);
  assert.doesNotMatch(block, /\.rf-(picture|plates|plate-btn|strip|stage|compare|sheet-inner|sheet)\b[^{]*\{/, 'the picture, the strip, the stage and the sheet\'s box are left alone');
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, 'no literal colour');
  assert.doesNotMatch(block, /(margin|padding|border)-(left|right)|[^-](left|right)\s*:/, 'logical sides only');
});
