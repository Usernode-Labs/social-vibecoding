'use strict';

// #15: the bar over a starter shown while a first version is built
// (frontend/src/features/app-frame/starter-bar.tsx).
//
// Evan, first-session run-through, 5 October 2026: "Show the starter for now"
// on the App tab framed the starter, and nothing led back to the screen that
// said the app was being built, with its step and its chat, for the rest of
// the visit. The starter is framed under a bar now, "This is the starter for
// now. Back to the first version", whose button calls AppView.hideStarter.
// tests/app-frame-identity.test.js drives AppView's half (what it publishes,
// and what Back puts on screen) and pins where the bar sits in the frame host.
//
// Run with: node --test tests/app-starter-bar.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const BAR = 'frontend/src/features/app-frame/starter-bar.tsx';

const bar = loadTsx(BAR);

test('the bar says it is the starter, and its button goes back to the first version', () => {
  assert.equal(bar.STARTER_NOTE, 'This is the starter for now.');
  assert.equal(bar.STARTER_BACK, 'Back to the first version');
  for (const words of [bar.STARTER_NOTE, bar.STARTER_BACK]) assert.doesNotMatch(words, /—/, words);
  const html = renderToHtml(createElement(bar.StarterBarView, { slug: 'plant-pal' }));
  assert.match(html, /^<div id="app-starter-bar" data-app-starter="plant-pal" class="shrink-0 [^"]*">This is the starter for now\. <button type="button" id="app-starter-back" class="[^"]*">Back to the first version<\/button><\/div>$/);
  // Drawn from the tokens the app's tone re-inks inside #app-frame-host
  // (app.css, "THE BAR TAKES THE APP'S TONE"): the sheet's own surface, its
  // muted ink and its hairline, with the accent for the one action.
  assert.match(html, /class="shrink-0 bg-\[color:var\(--bg-primary\)\] px-6 pb-2\.5 pt-3 text-center text-\[13px\] leading-5 text-\[color:var\(--text-muted\)\] shadow-\[inset_0_-1px_0_var\(--app-sheet-line\)\]"/);
  assert.match(html, /<button type="button" id="app-starter-back" class="font-semibold text-\[color:var\(--accent\)\] hover:underline un-touch-target">/);
});

test('its button calls AppView.hideStarter with its app', () => {
  const calls = [];
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const prev = globalThis.window;
  globalThis.window = { AppView: { hideStarter: (slug) => calls.push(slug) } };
  try {
    const el = bar.StarterBarView({ slug: 'plant-pal' });
    const button = [].concat(el.props.children).find((c) => c && c.type === 'button');
    assert.ok(button, 'the bar has its button');
    button.props.onClick();
    assert.deepEqual(calls, ['plant-pal']);
    // No AppView (a context without the shell): nothing is called, nothing throws.
    globalThis.window = {};
    button.props.onClick();
  } finally {
    if (had) globalThis.window = prev;
    else delete globalThis.window;
  }
});

test('only over its own app\'s mounted frame, and nothing in the prerender', () => {
  const { starterBarFor } = bar;
  assert.equal(starterBarFor({ slug: 'plant-pal' }, { slug: 'plant-pal' }), 'plant-pal');
  assert.equal(starterBarFor({ slug: 'plant-pal' }, { slug: 'other-app' }), '', 'another app is framed');
  assert.equal(starterBarFor({ slug: 'plant-pal' }, { slug: '' }), '', 'no frame is mounted');
  assert.equal(starterBarFor({ slug: '' }, { slug: 'plant-pal' }), '', 'no starter shown');
  // The stores start empty, so the shipped document carries no bar, and the
  // shell's id inventory is unchanged (its ids are drawn only once shown).
  assert.equal(renderToHtml(createElement(bar.StarterBar)), '');
  const store = read('frontend/src/features/app-frame/starter-store.js');
  assert.match(store, /export const starterStore = createStore\(\{ slug: '' \}\);/);
  const inventory = read('tests/baselines/shell-markup.json');
  assert.doesNotMatch(inventory, /app-starter-/);
});
