// The Dev board's "merges are paused" banner (services/main-watch.js).
//
// A red main pauses the app's merges. For one afternoon that fact lived only
// inside each card's collapsed requirements ledger while the cards' pills kept
// reading "Passed, merging shortly" — nothing on the board said why nothing
// was merging, and the admin who could have resumed them found the button by
// accident. The banner is one sentence above the cards, for everyone, naming
// the test, and — for an admin — carrying the verb.
//
// Three things are pinned here: the sentence (one spelling, for the frame and
// its callers), the render (absent while merges are not paused, amber with the
// test named while they are, the Resume button only for an admin and only once
// the red is confirmed), and the writer (`AppView._renderMainPauseNotice`
// publishes from the promoted list's `mainCheck` block on the server's rule).
//
// Run with: node --test tests/main-pause-banner.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const APP_VIEW_SRC = read('public', 'js', 'app-view.js');
const FRAME_SRC = read('frontend', 'src', 'features', 'dev-board', 'board-frame.tsx');
const MOUNT_SRC = read('frontend', 'src', 'features', 'dev-board', 'mount.ts');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
let api = null;
const mod = () => (api || (api = loadTsx('tests/fixtures/main-pause-api.ts')));

const FRAME_PROPS = {
  selfHosted: false, readOnly: false, canCollaborate: true, showsMembers: false,
  cardCls: 'card', cardHoverCls: 'card-hover',
};

const QUIET = { paused: false, confirming: false, sha: null, failingTest: null, canResume: false, slug: null };
const PAUSED = {
  paused: true, confirming: false, sha: 'fffffff',
  failingTest: 'shared-sessions returns linked_issues per row', canResume: false, slug: 'usernode-2d5619',
};

function bannerHtml(state) {
  const m = mod();
  m.mainPauseStore.set({ ...state });
  const html = renderToHtml(createElement(m.DevBoardFrame, FRAME_PROPS));
  const at = html.indexOf('<div id="dev-main-pause-notice"');
  assert.ok(at >= 0, 'the frame has the banner slot');
  // The slot and nothing past it: the board body is the next sibling.
  const end = html.indexOf('<div id="dev-body"', at);
  assert.ok(end > at, 'the banner sits above the board body');
  return html.slice(at, end);
}

test('the sentence names the test and says who may end the pause', () => {
  const { mainPauseText } = mod();
  assert.equal(mainPauseText(PAUSED),
    'Merges are paused: main’s unit suite is failing since fffffff: shared-sessions returns linked_issues per row. '
    + 'They resume when a fix lands or an admin resumes them; a proposal already level with main whose own checks passed still merges.');
  assert.equal(mainPauseText({ ...PAUSED, confirming: true }),
    'Main’s unit suite failed once since fffffff: shared-sessions returns linked_issues per row. Re-running to confirm. '
    + 'Merges are paused meanwhile, except for proposals already level with main whose own checks passed.');
  // A run that named no test (a setup failure, a killed run) still reads.
  assert.equal(mainPauseText({ confirming: false, sha: null, failingTest: null }),
    'Merges are paused: main’s unit suite is failing. They resume when a fix lands or an admin resumes them; '
    + 'a proposal already level with main whose own checks passed still merges.');
});

test('the initial render is the hidden, empty slot the shell shipped', () => {
  const { mainPauseStore } = mod();
  assert.deepEqual({ ...mainPauseStore.get() }, QUIET);
  const html = bannerHtml(QUIET);
  assert.match(html, /^<div id="dev-main-pause-notice" class="px-3 pt-2 hidden"><\/div>/,
    'absent — not hidden inside — while merges are not paused, so a board that is fine carries no extra node');
});

test('paused: amber, above the cards, the test named, no button for a non-admin', () => {
  const html = bannerHtml(PAUSED);
  assert.match(html, /<div id="dev-main-pause-notice" class="px-3 pt-2">/, 'the slot shows');
  assert.match(html, /data-main-pause="paused"/);
  // #2443 routed this box through alertVariants' `notice` variant, so the tint
  // is the primitive's alpha spelling now rather than this file's own
  // `border-amber-200 bg-amber-50`. What the assertion is for is unchanged:
  // a condition somebody may need to act on is amber.
  assert.match(html, /border-amber-500\/40 bg-amber-500\/10/, 'a condition somebody may need to act on: amber');
  assert.match(html, /shared-sessions returns linked_issues per row/, 'the culprit, not "main is red"');
  assert.match(html, /since fffffff/);
  assert.doesNotMatch(html, /<button/, 'a viewer who cannot resume is not shown a verb');
  // The tokens are the platform's, not the console's (AGENTS.md: gray-*/indigo-* appear nowhere).
  assert.doesNotMatch(html, /\b(bg|text|border)-(gray|indigo)-/);
});

test('an admin gets the Resume verb — once the red is confirmed, not during the re-run', () => {
  const confirmed = bannerHtml({ ...PAUSED, canResume: true });
  assert.match(confirmed, /<button[^>]*>Resume merges<\/button>/);
  assert.match(confirmed, /title="Resume merges on this app while main’s unit suite is red\./);

  const confirming = bannerHtml({ ...PAUSED, canResume: true, confirming: true });
  assert.match(confirming, /data-main-pause="confirming"/);
  assert.match(confirming, /Re-running to confirm/);
  assert.doesNotMatch(confirming, /<button/,
    'a first red being re-run is not yet a verdict to override; the re-run settles it in minutes');
});

test('the button resolves to the one resume path the per-card ledger uses', () => {
  // One implementation, one toast: the banner calls AppView.resumeMainMerges,
  // which is the same function the requirements ledger's button calls.
  assert.match(FRAME_SRC, /window\.AppView\?\.resumeMainMerges\?\.\(s\.slug, btnRef\.current\)/);
  assert.match(APP_VIEW_SRC, /async resumeMainMerges\(slug, btn\)/, 'the legacy side still owns the call');
  assert.match(APP_VIEW_SRC, /\/api\/apps\/\$\{encodeURIComponent\(slug\)\}\/main-check\/resume/);
});

test('the store is published from the promoted list on the server\'s admin rule', () => {
  // mount.ts exposes the setter; AppView publishes from `mainCheck`, beside the
  // locked notice — the same load, the same moment.
  assert.match(MOUNT_SRC, /publishMainPause\(state\) \{\s*mainPauseStore\.set\(state\);/);
  assert.match(APP_VIEW_SRC, /AppView\._renderLockedNotice\(\);\s*AppView\._renderMainPauseNotice\(\);/,
    'published where the locked notice is, on every promoted-list load');
  const fn = APP_VIEW_SRC.slice(APP_VIEW_SRC.indexOf('_renderMainPauseNotice() {'));
  const body = fn.slice(0, fn.indexOf('\n  },'));
  assert.match(body, /publishMainPause\?\.\(\{/);
  assert.match(body, /paused,\s*confirming: paused && !!mc\.confirming/);
  assert.match(body, /const redSha = paused \? \(mc\.pausedSha \|\| mc\.sha\) : null/,
    'the sha is the red commit the pause is about, not the one a newer merge is re-testing');
  assert.match(body, /sha: redSha \? String\(redSha\)\.slice\(0, 7\) : null/, 'abbreviated once, here');
  assert.match(body, /canResume: paused && !AppView\.readOnly/, 'read-only never carries the verb');
  assert.match(body, /App\.user\.canAdminWrite/, 'the same rule the route enforces');
  // The block is stored off the promoted payload, not re-fetched.
  assert.match(APP_VIEW_SRC, /mainCheck: promotedData\.mainCheck && typeof promotedData\.mainCheck === 'object'/);
});
