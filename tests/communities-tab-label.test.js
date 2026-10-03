'use strict';

// #3709 — the Communities tab keeps the word "Communities" wherever it is.
//
// #852 (#3455) made the fourth tab a community: its tile in a ring, and, as
// its label, the community's own name cut short ("Recipe Box"). The owner
// asked for the word back. The tile still says which community the tab is
// on; the label under it, on the phone's bar and on the desktop rail (one
// anchor, which app.css lays out for both), always says Communities.
//
// Pinned, each a way the tab can be quietly wrong again:
//
//   1. ON A COMMUNITY, THE LABEL IS STILL "Communities", and the ring still
//      holds that community's tile, so nothing about WHICH one is lost.
//   2. THE SPOKEN NAME STARTS WITH THE WORD ON SCREEN and names the community
//      after it, so a voice command that says "Communities" still finds it.
//   3. ON ALL COMMUNITIES NOTHING CHANGED: the people glyph, the word, and no
//      label of its own, exactly as the prerender ships it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const HTML = read('public/index.html');
const TAB_BAR = read('frontend/src/features/nav/tab-bar.tsx');
const DAPP = JSON.parse(read('dapp.json'));

const ui = loadTsx('tests/fixtures/tab-bar-api.ts');

const RECIPES = {
  slug: 'recipes', name: 'Recipe Box of the Week', iconUrl: null, iconEmoji: '🍲', iconColor: '#2e6660', needs: 0,
};

const render = (slug) => {
  const before = ui.communityScopeStore.get();
  ui.communityScopeStore.set({ slug, info: slug ? { [slug]: RECIPES } : {} });
  try {
    return renderToHtml(createElement(ui.PlatformTabs, {}));
  } finally {
    ui.communityScopeStore.set(before);
  }
};
const workshopTab = (html) => {
  const at = html.indexOf('id="platform-tab-workshop"');
  assert.ok(at > 0, '#platform-tab-workshop renders');
  return html.slice(html.lastIndexOf('<a', at), html.indexOf('</a>', at) + 4);
};
const labelOf = (tab) => (tab.match(/<span class="platform-tab-label">([^<]*)<\/span>/) || [])[1];
const openTag = (tab) => tab.slice(0, tab.indexOf('>') + 1);

// ── 1. On a community ─────────────────────────────────────────────────

test('on a community the tab still says Communities, under that community\'s tile', () => {
  const tab = workshopTab(render('recipes'));
  assert.equal(labelOf(tab), 'Communities', 'the word, not the community\'s name');
  assert.doesNotMatch(tab, /class="platform-tab-label">Recipe/, 'no part of the name is the label');
  assert.match(tab, /<span class="platform-tab-ring" style="--ring:[^"]+" aria-hidden="true"><span class="app-icon-tile platform-tab-tile"/,
    'the ring still holds the community\'s own tile, so the tab still says which one');
  assert.doesNotMatch(tab, /platform-tab-ring-all/, 'and not the All communities glyph');
});

// ── 2. The spoken name ────────────────────────────────────────────────

test('its accessible name starts with the word on screen and names the community after it', () => {
  const tab = workshopTab(render('recipes'));
  assert.match(openTag(tab), /aria-label="Communities, on Recipe Box of the Week"/,
    'the whole name is spoken, since nothing is cut for room there');
  assert.equal(ui.communitiesAriaLabel({ name: 'Garden' }), 'Communities, on Garden');
  assert.equal(ui.communitiesAriaLabel(null), undefined);
});

// ── 3. All communities ────────────────────────────────────────────────

test('on All communities the tab is unchanged: the glyph, the word, and the shipped markup', () => {
  const tab = workshopTab(render(null));
  assert.equal(labelOf(tab), 'Communities');
  assert.match(tab, /platform-tab-ring platform-tab-ring-all/, 'the people glyph in its ring');
  assert.doesNotMatch(openTag(tab), /aria-label=/, 'its text is its name');
  // The first client render is the shipped document's, or hydration fails.
  assert.equal(tab, workshopTab(HTML).replace(/ aria-current="page"/, ''),
    'the store\'s INITIAL renders exactly the shipped tab');
});

test('nothing in the tab bar puts a community\'s name in a label any more', () => {
  assert.doesNotMatch(TAB_BAR, /shortName\(/, 'the cut-down name is gone from the bar');
  // The declared check on a community's page asks for the same thing.
  const check = DAPP.tests.find((t) => /^The Communities tab wears the community you are in/.test(t.name));
  assert.ok(check, 'the declared check for the tab on a community is still there');
  assert.match(check.expectSelector, /#platform-tab-workshop\[aria-current="page"\]\[aria-label\^="Communities, on "\]/);
});
