'use strict';
// THE THREAD PAGE IN THE STANDARD LOOK (20 Nov 2026): a request's or a change's
// page is drawn in the standard look as "Paper, simplified, with brand
// styling" draws it. scripts/thread-look.js writes that look's rules a second
// time, scoped to html:not([data-skin]) and to #dev-topic-thread, into one
// block of app.css, before the looks' compiled section and the brand look's own. This suite holds the block to the generator's
// output, so a rule changed under the brand look cannot leave the standard
// look's page behind, and holds what the block may and may not reach.
// test:changed: when public/css/app.css (the block is generated from the brand look's rules there)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build, twin, voteTwin, START, END } = require('../scripts/thread-look');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
const block = css.slice(css.indexOf(START) + START.length, css.indexOf(END)).replace(/\/\*[\s\S]*?\*\//g, '');

test('the block is what the generator writes from the brand look\'s rules today', () => {
  assert.ok(css.includes(START) && css.includes(END), 'the block is in app.css');
  assert.equal(build(css), css, 'run: node scripts/thread-look.js');
});

test('every rule of the block is the standard look\'s, inside the thread page, and names no other look', () => {
  const selectors = block.replace(/\{[^{}]*\}/g, '\n').split(/,\s*\n|\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('@') && l !== '}');
  assert.ok(selectors.length > 150, 'the look is carried over');
  for (const one of selectors) {
    assert.ok(one.startsWith('html:not([data-skin])'), `"${one.slice(0, 90)}" is the standard look's`);
    assert.match(one, /#dev-topic-thread|#gc-thread|\[data-vote-look="thread"\]/, `"${one.slice(0, 90)}" stays inside the thread page`);
    assert.doesNotMatch(one, /data-skin="/, `"${one.slice(0, 90)}" names a look`);
    if (one.includes('[data-vote-look=')) {
      assert.ok(one.startsWith('html:not([data-skin])'), `"${one.slice(0, 90)}" reaches the picker only outside every skin`);
    }
  }
});

test('the portaled vote picker is painted with the page\'s own colours', () => {
  // The picker is portaled out of the page, so the scoped rules cannot reach
  // it: its frame carries data-vote-look="thread" (dev-card.tsx) and the
  // carried rules are written again on that marker.
  const rule = (sel) => {
    const at = block.indexOf(`${sel} {`);
    assert.ok(at >= 0, `the block has ${sel}`);
    const open = block.indexOf('{', at);
    return block.slice(open + 1, block.indexOf('}', open)).replace(/\s+/g, ' ').trim();
  };
  const MARK = '[data-vote-look="thread"]';
  const HOST = `:is(.dev-vote-pop, .dev-vote-sheet, .dev-ws-vote-form):where(${MARK})`;
  assert.match(rule(`.dev-vote-pop:where(${MARK})`), /background: var\(--bl-card\)/,
    'the picker is the page card');
  assert.match(rule(`${HOST} .dev-vote-switch`),
    /background: var\(--bl-page\)/, 'the switch track is the page ground');
  assert.match(rule(`${HOST} .dev-vote-switch-yes[aria-pressed="true"]`),
    /background: var\(--bl-sun\)/, 'Yes is the page sun');
  assert.match(rule(`html:not([data-skin]):not(.dark):not([data-app-tone="dark"]) ${HOST} .dev-vote-switch-yes[aria-pressed="true"]`),
    /box-shadow: inset 0 0 0 1px var\(--bl-on-sun\)/, 'the light look gives Yes the ink outline');
  const send = rule(`${HOST} .dev-vote-reason-send-yes`);
  assert.match(send, /background: var\(--bl-sun\)/);
  assert.match(send, /box-shadow: var\(--bl-pill-edge\)/, 'Vote yes is the page pill');
  assert.match(rule(`${HOST} :is(.dev-vote-switch-label, .dev-vote-uncounted, .dev-vote-reason-label)`),
    /color: var\(--bl-label\)/, 'the labels are the page label ink');
  assert.match(rule(`${HOST} .dev-vote-reason-box`),
    /var\(--bl-field-edge\)/, 'the line box is the page field');
  // The look's tokens reach the marker itself, so the page's dark and
  // high-contrast token rules follow it there too.
  const lightRoot = block.split('\n').find((l) => l.includes(`[data-vote-look="thread"]`) && l.includes('--bl-card: #ffffff'));
  assert.ok(lightRoot && lightRoot.includes('--bl-sun: #ffee6f'), 'the light tokens are declared on the marker');
  assert.ok(lightRoot.startsWith('html:not([data-skin])'), 'and only outside every skin');
});

test('how a selector reaches the portaled picker', () => {
  assert.equal(voteTwin('html:not([data-skin]) #dev-topic-thread'), 'html:not([data-skin]) [data-vote-look="thread"]',
    'the page\'s tokens and typeface land on the marker');
  assert.equal(voteTwin('html:not([data-skin]).dark #dev-topic-thread'), 'html:not([data-skin]).dark [data-vote-look="thread"]');
  assert.equal(voteTwin('html:not([data-skin]) :where(#dev-topic-thread) .dev-vote-pop'),
    'html:not([data-skin]) .dev-vote-pop:where([data-vote-look="thread"])', 'the marker goes on the picker\'s frame');
  assert.equal(voteTwin('html:not([data-skin]) :where(#dev-topic-thread) :is(.dev-vote-pop, .dev-vote-sheet, .dev-ws-vote-form) .dev-vote-switch'),
    'html:not([data-skin]) :is(.dev-vote-pop, .dev-vote-sheet, .dev-ws-vote-form):where([data-vote-look="thread"]) .dev-vote-switch');
  assert.equal(voteTwin('html:not([data-skin]) :where(#dev-topic-thread) .dev-thread-card'), null, 'an unrelated rule is left alone');
});

test('dev-card.tsx marks the picker only when its button stands inside the thread page', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-board', 'card', 'dev-card.tsx'), 'utf8');
  assert.match(src, /const threadLook = !!btnRef\.current\?\.closest\('#dev-topic-thread'\);/);
  assert.match(src, /const voteLook = threadLook \? 'thread' : \(boardLook \? 'board' : undefined\);/,
    'the thread page\'s marker is chosen first; the All items board\'s is only the fallback');
  assert.equal((src.match(/data-vote-look=\{voteLook\}/g) || []).length, 2,
    'the popover and the phone sheet both carry it');
});

test('colours are the look\'s tokens: no rule of the block writes one outside a token', () => {
  for (const m of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = m[2].replace(/--[a-z0-9-]+\s*:[^;]*;?/g, '');
    assert.doesNotMatch(body, /#[0-9a-fA-F]{3,8}\b/, `${m[1].trim().slice(0, 90)} writes a colour of its own`);
  }
});

test('how a selector is carried over', () => {
  assert.equal(twin('html[data-skin="brand"].dark .gc-vote-btn'), 'html:not([data-skin]).dark :where(#dev-topic-thread) .gc-vote-btn');
  assert.equal(twin('html[data-skin="brand"]'), 'html:not([data-skin]) #dev-topic-thread', 'the look\'s tokens become the page\'s own');
  assert.equal(twin('html[data-skin="brand"] #gc-thread-rail .x'), 'html:not([data-skin]) #gc-thread-rail .x');
  assert.equal(twin('html[data-skin="brand"] body'), null, 'the page behind is not the thread\'s');
  assert.equal(twin('html[data-skin="brand"] #platform-tabs .platform-tab'), null, 'another screen is left out');
  assert.equal(twin('html[data-skin] .x'), null, 'a rule that is not the brand look\'s is left out');
});
