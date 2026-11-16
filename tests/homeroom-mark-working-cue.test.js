'use strict';

// What the working cue on the Homeroom mark means (#3015, #3075).
//
// The cue (a blue corner spinner, #improve-working-dot, for the viewer's own
// changes only) means one of their changes is building. It said so nowhere.
// The mark says it on hover and keeps its name for a screen reader; the menu
// the mark opens does not repeat it in words, and its update lines are
// unchanged.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, createElement, renderToHtml } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('#3015: the mark says what its green dot means on hover, and keeps its name', () => {
  const mark = read('frontend/src/features/header/platform-mark.tsx');
  assert.equal(message('core:header.changeBuilding'), 'One of your changes is building');
  assert.match(mark, /title=\{working \? t\('core:header\.changeBuilding'\) : undefined\}/, 'only while the dot is showing');
  assert.match(mark, /aria-label=\{t\('core:header\.homeroomMenu'\)\}/);
  assert.equal(message('core:header.homeroomMenu'), 'Homeroom menu', 'the name the empty board\'s note uses is unchanged');
});

test('#3075: the menu no longer says it in words; the mark\'s own spinner stays', () => {
  const actions = loadTsx('frontend/src/features/improve/actions.tsx');
  assert.equal(actions.WORKING_NOTE, undefined, 'the note is gone');
  const src = read('frontend/src/features/improve/actions.tsx');
  assert.doesNotMatch(src, /building right now|data-improve-working-note|The Homeroom mark shows it/);
  assert.match(read('frontend/src/features/header/platform-mark.tsx'), /id="improve-working-dot"/,
    'the corner spinner on the Homeroom mark is kept');

  // A change of the viewer's working prints nothing here, before mount or
  // after; the build lines are unchanged. The store is handed in so the
  // component reads the very instance the test sets.
  const store = loadTsx('frontend/src/features/improve/improve-store.js');
  const wired = loadTsx('frontend/src/features/improve/actions.tsx', { stubs: { './improve-store.js': store } });
  store.improveStore.set({ ...store.improveStore.get(), working: true });
  assert.equal(renderToHtml(createElement(wired.UpdateStatus)), '');
  store.improveStore.set({ ...store.improveStore.get(), deploying: true });
  assert.match(renderToHtml(createElement(wired.UpdateStatus)), /An update to this app is on its way\./);
  store.improveStore.set({ ...store.improveStore.get(), deploying: false, versionState: 'downloading' });
  assert.match(renderToHtml(createElement(wired.UpdateStatus)), /Homeroom is downloading an update\. You can reload once it’s ready\./);
  store.improveStore.set({ ...store.improveStore.get(), versionState: 'ready' });
  // Polish N4: a short line and an Update button, not "Click here".
  assert.match(renderToHtml(createElement(wired.UpdateStatus)), /Homeroom has an update<\/span><span[^>]*>Reload<\/span>/);
});
