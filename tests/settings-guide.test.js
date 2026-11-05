// Settings → User guide (#5973): a page of its own beside Welcome tour, one
// row per stop of the tour plus how a change gets voted in, its words read
// from the catalog. What it says is pinned here where the claim could drift:
// it names the tabs the bar names, and no number of votes, because that is
// each project's own rule.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const SECTION = 'frontend/src/features/settings/sections/guide.tsx';
const CATALOG = JSON.parse(read('frontend/locales/en/settings.json'));
const guideIds = Object.keys(CATALOG).filter((k) => k.startsWith('guide.'));

test('the pane ships hidden, with a row per tour stop and the voting card', () => {
  const html = renderComponent(SECTION, 'GuideSection');
  assert.match(html, /data-settings-section="guide" class="hidden"/);
  assert.match(html, /id="settings-guide-section"/);
  assert.match(html, /id="settings-guide-voting"/);
  const unescape = (s) => s.replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
  const text = unescape(html);
  for (const id of guideIds) {
    assert.ok(text.includes(CATALOG[id].text), `${id} is on the page`);
  }
});

test('it has one row per stop of the tour, in the tour\'s order', () => {
  const steps = read('frontend/src/features/home/tour/tour-steps.ts');
  const stops = [...steps.matchAll(/^\s+id: '([a-z-]+)',$/gm)].map((m) => m[1]);
  assert.deepEqual(stops, ['communities', 'apps', 'app-menu', 'menu-actions', 'meet-bot', 'settings']);
  const src = read(SECTION);
  const rows = [...src.matchAll(/settings:guide\.place\.(\w+)\.title/g)].map((m) => m[1]);
  assert.deepEqual(rows, ['communities', 'apps', 'appMenu', 'suggest', 'bot', 'you']);
});

test('every id the pane asks for exists, as a title and a body', () => {
  const src = read(SECTION);
  for (const m of src.matchAll(/settings:(guide\.[\w.]+)/g)) {
    assert.ok(CATALOG[m[1]], `${m[1]} is in the catalog`);
  }
  for (const id of guideIds.filter((k) => k.endsWith('.title') && k !== 'guide.title')) {
    assert.ok(CATALOG[id.replace(/\.title$/, '.body')], `${id} has a body`);
  }
});

test('it is a registered page under Help & about, right after Welcome tour, and searchable', () => {
  const settings = read('frontend/src/features/settings/settings.js');
  assert.match(settings, /\{ key: 'tour',[^\n]*\n\s+\/\/[^\n]*\n\s+\{ key: 'guide', label: 'settings:nav\.part\.guide', group: 'settings:nav\.group\.helpAbout' \}/);
  assert.match(settings, /guide: 'settings:nav\.keywords\.guide',/);
  assert.equal(message('settings:nav.part.guide'), 'User guide');
  assert.match(read('frontend/src/features/settings/sections/index.tsx'), /<TourSection \/>\s+<GuideSection \/>/);
});

test('the words stay true: the tabs as the bar names them, and no rule it did not verify', () => {
  const all = guideIds.map((id) => CATALOG[id].text).join('\n');
  // The bot's tab is its own, not a row of Messages (AGENTS.md, #6019), and
  // the tab's word is the catalog's.
  assert.equal(message('core:tabs.ai'), 'Homeroom bot');
  assert.equal(message('core:tabs.me'), 'You');
  assert.doesNotMatch(all, /Find it in Messages/);
  // Build it comes out of the presser's own week.
  assert.match(message('settings:guide.vote.build.body'), /any member can press Build it, and the bot's building time comes out of that member's week/);
  // The checks gate going live whatever the vote says.
  assert.match(message('settings:guide.vote.checks.body'), /can't go live until they pass/);
  // No thresholds: how many yeses is each project's own rule.
  assert.doesNotMatch(all, /\b\d+\b\s*(%|percent|votes?|yes|yeses|approvals?|members?|people)/i);
  assert.doesNotMatch(all, /\b(two|three|four|majority)\b\s*(votes?|yes|yeses|approvals?|members?|people)?/i);
});
