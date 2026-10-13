'use strict';

// #16: the line under a preview's bar.
//
// It used to read "Private preview. Only you can see this until the app's
// users vote your change in." Two things in it were wrong. Other members DO
// open a proposal's preview (to try a change before they vote), so "only
// you" was untrue; and the preview runs on its own copy of the app's
// database (services/staging.js clones it, staging-reap drops it), so
// anything added while trying it never reaches the live app, which the line
// never said. A first-time tester lost the data they entered in a preview
// with no warning.
//
// The line is worded by who the app is for: on a project that is just yours
// it goes live when you vote it in; anywhere else members try it before they
// vote. `solo` rides the staging store (false until a preview says
// otherwise, so the prerendered page carries the group wording), fed by
// stagingBridge.setAudience from AppView.swapToStaging, which
// tests/staging-iframe-identity.test.js drives.
//
// The island is EXECUTED here (tests/lib/render-tsx.js) against the real
// store, handed to it as its './staging-store.js' import so the test and the
// component share one instance.
//
// Run with: node --test tests/staging-preview-banner.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const storeMod = loadTsx('frontend/src/features/staging/staging-store.js');
const overlay = loadTsx('frontend/src/features/staging/staging-overlay.tsx', {
  stubs: { './staging-store.js': storeMod },
});
const bridgeMod = loadTsx('frontend/src/features/staging/staging-bridge.js', {
  stubs: { './staging-store.js': storeMod },
});

const SOLO = "Preview of your change. It goes live when you vote it in. Anything you add here stays in the preview and won't carry over.";
const GROUP = "Preview of this change. Members can try it before they vote. Anything you add here stays in the preview and won't carry over.";

// What renderToStaticMarkup writes for the text: the apostrophe as an entity.
const html = (s) => s.replace(/'/g, '&#x27;');

function render() {
  return renderToHtml(createElement(overlay.StagingOverlay, {}));
}

test('the banner is worded for a group until a preview says the project is just yours', () => {
  bridgeMod.stagingBridge.setAudience(null);
  assert.equal(storeMod.stagingStore.get().solo, false);
  const out = render();
  assert.ok(out.includes(html(GROUP)), 'members can try it before they vote');
  assert.ok(!out.includes(html(SOLO)));
});

test('on a project that is just yours it goes live when you vote it in', () => {
  bridgeMod.stagingBridge.setAudience('solo');
  assert.equal(storeMod.stagingStore.get().solo, true);
  const out = render();
  assert.ok(out.includes(html(SOLO)), 'your change, your vote');
  assert.ok(!out.includes(html(GROUP)));
  bridgeMod.stagingBridge.setAudience('invited');
  assert.ok(render().includes(html(GROUP)), 'a private group is a group');
  bridgeMod.stagingBridge.setAudience('open');
  assert.ok(render().includes(html(GROUP)), 'and so is a public community');
});

test('neither wording claims only you can see it, and both say the data stays behind', () => {
  for (const audience of ['solo', 'invited', 'open', null]) {
    bridgeMod.stagingBridge.setAudience(audience);
    const out = render();
    assert.ok(!/Only you can see this/.test(out), `${audience}: other members open previews too`);
    assert.ok(!/Private preview/.test(out), `${audience}: nor is it private to you`);
    assert.ok(out.includes(html("Anything you add here stays in the preview and won't carry over.")),
      `${audience}: what you add in the preview is the preview's`);
  }
  assert.equal(overlay.previewBannerText(true), SOLO);
  assert.equal(overlay.previewBannerText(false), GROUP);
  bridgeMod.stagingBridge.setAudience(null);
});
