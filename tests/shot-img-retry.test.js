'use strict';

// A before/after still whose load ended with no picture is asked for again
// (frontend/src/lib/shot-img.ts watchShot, wired in
// frontend/src/features/review-flow/compare.tsx).
//
// 20 Nov: a change's picture sat on its blurred preview, with the alt text
// "The screen after this change" drawn over it, and never sharpened until
// another screen was opened and this one again. WebKit fires neither `load`
// nor `error` when an image's load is cancelled from outside the element
// (ImageLoader::notifyFinished returns early on wasCanceled()), so the
// slot's one recovery, its onError fallback, never ran, and nothing else
// asked again. Opening another screen fixed it only because the slider is
// keyed per screen, so coming back mounted a new <img>.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const shots = loadTsx('frontend/src/lib/shot-img.ts');

// An <img> as the watcher sees it: an event target with `complete` and
// `naturalWidth`. A cancelled load in WebKit is complete with no pixels,
// and no event.
function still({ complete = false, naturalWidth = 0 } = {}) {
  const img = new EventTarget();
  img.complete = complete;
  img.naturalWidth = naturalWidth;
  return img;
}

// Timers the test steps by hand.
function clock() {
  const live = new Map();
  let next = 1;
  return {
    setInterval(fn) { const id = next++; live.set(id, fn); return id; },
    clearInterval(id) { live.delete(id); },
    tick() { for (const fn of [...live.values()]) fn(); },
    get running() { return live.size; },
  };
}

function page() {
  const win = new EventTarget();
  const doc = new EventTarget();
  doc.visibilityState = 'visible';
  return { win, doc };
}

test('a still whose load was cancelled with no event is asked for again', () => {
  assert.equal(typeof shots.watchShot, 'function', 'shot-img.ts watches a still until it shows');
  const timers = clock();
  const { win, doc } = page();
  const img = still();
  const budget = { left: shots.SHOT_RETRIES };
  let retries = 0;
  shots.watchShot(img, budget, () => { retries += 1; }, { win, doc, timers });

  timers.tick();
  assert.equal(retries, 0, 'still loading: left alone');

  // The load is cancelled from outside: complete, no pixels, no event.
  img.complete = true;
  timers.tick();
  assert.equal(retries, 1, 'asked for again');
  assert.equal(budget.left, shots.SHOT_RETRIES - 1, 'one try spent');
  assert.equal(timers.running, 0, 'this element is done; the new one is watched');
});

test('a still that shows is left alone, and stops being watched', () => {
  const timers = clock();
  const { win, doc } = page();
  const img = still();
  let retries = 0;
  shots.watchShot(img, { left: 2 }, () => { retries += 1; }, { win, doc, timers });
  img.complete = true;
  img.naturalWidth = 1170;
  img.dispatchEvent(new Event('load'));
  assert.equal(timers.running, 0, 'no timer left once it shows');
  win.dispatchEvent(new Event('online'));
  timers.tick();
  assert.equal(retries, 0);
});

test('a slot asks again at most its budget, and again when the page comes back', () => {
  const timers = clock();
  const { win, doc } = page();
  const budget = { left: 2 };
  const elements = [];
  // Each retry mounts a new element, watched with the slot's same budget.
  const mount = () => {
    const img = still({ complete: true });
    elements.push(img);
    shots.watchShot(img, budget, mount, { win, doc, timers });
  };
  mount();
  timers.tick();
  timers.tick();
  timers.tick();
  assert.equal(elements.length, 3, 'the first element and two tries');
  assert.equal(budget.left, 0);
  assert.equal(timers.running, 0, 'out of tries: it stops looking');

  // The page is shown again (or back online): a load cut off while it was
  // away is found, and asked for again.
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(elements.length, 4, 'coming back asks again');
});

test('nothing is asked for while the page is hidden', () => {
  const timers = clock();
  const { win, doc } = page();
  const img = still({ complete: true });
  let retries = 0;
  shots.watchShot(img, { left: 2 }, () => { retries += 1; }, { win, doc, timers });
  doc.visibilityState = 'hidden';
  timers.tick();
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(retries, 0, 'a hidden page would only have it cancelled again');
  doc.visibilityState = 'visible';
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(retries, 1);
});

test('the slider watches both sides, and a try is a new element', () => {
  const src = read('frontend/src/features/review-flow/compare.tsx');
  assert.match(src, /import \{[^}]*\bwatchShot\b[^}]*\} from '\.\.\/\.\.\/lib\/shot-img'/);
  assert.match(src, /key=\{`\$\{which\}:\$\{url\}:\$\{watched \? tries\[which\] : 'lens'\}`\}/,
    "each try (and each address) is a new <img>, so the browser asks again");
  assert.match(src, /ref=\{watched \? \(which === 'after' \? watchAfter : watchBefore\) : undefined\}/);
  assert.match(src, /watchShot\(node, budgets\.current\.after,/);
  assert.match(src, /watchShot\(node, budgets\.current\.before,/);
  // The magnifier's copy only lives while it is held, and is not watched.
  assert.match(src, /img\(lensSide === 'after' && after \? 'after' : 'before', lensSide, false\)/);
});
