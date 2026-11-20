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
const { build, twin, START, END } = require('../scripts/thread-look');

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
    assert.match(one, /#dev-topic-thread|#gc-thread/, `"${one.slice(0, 90)}" stays inside the thread page`);
    assert.doesNotMatch(one, /data-skin="/, `"${one.slice(0, 90)}" names a look`);
  }
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
