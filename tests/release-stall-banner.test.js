// The Dev board's "merged but not released" banner (services/release-watch.js).
//
// The platform's own merges deploy outside the platform: an Actions workflow
// builds the image and publishes a Helm release, Argo CD syncs it, the
// Deployment rolls. When a link in that chain fails the proposal reads
// "merged" on its card while production serves the previous commit — #2589
// did, for half an hour, because one registry connection dropped. The banner
// is one sentence above the cards saying so, with the workflow run to click
// through to when there is one.
//
// Pinned here: the sentence (one spelling per kind), the render (absent while
// nothing is stalled, amber with the commit and the running build named while
// something is, the run link only for a github.com URL), and the writer
// (`AppView._renderReleaseStallNotice` publishes from the promoted list's
// `releaseStall` block beside the two notices already there).
//
// Run with: node --test tests/release-stall-banner.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const APP_VIEW_SRC = read('public', 'js', 'app-view.js');
const MOUNT_SRC = read('frontend', 'src', 'features', 'dev-board', 'mount.ts');
const VOTES_SRC = read('src', 'routes', 'votes.js');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
let api = null;
const mod = () => (api || (api = loadTsx('tests/fixtures/release-stall-api.ts')));

const FRAME_PROPS = {
  selfHosted: true, readOnly: false, canCollaborate: true, showsMembers: false,
  cardCls: 'card', cardHoverCls: 'card-hover',
};

const QUIET = { stalled: false, kind: null, sha: null, prNumber: null, running: null, runUrl: null };
const FAILED = {
  stalled: true, kind: 'workflow_failed', sha: '7817d05', prNumber: 2589, running: '741b8f7',
  runUrl: 'https://github.com/Usernode-Labs/social-vibecoding/actions/runs/35461203746',
};

function bannerHtml(state) {
  const m = mod();
  m.releaseStallStore.set({ ...state });
  const html = renderToHtml(createElement(m.DevBoardFrame, FRAME_PROPS));
  const at = html.indexOf('<div id="dev-release-stall-notice"');
  assert.ok(at >= 0, 'the frame has the banner slot');
  const end = html.indexOf('<div id="dev-body"', at);
  assert.ok(end > at, 'the banner sits above the board body');
  return html.slice(at, end);
}

test('the sentence names the merge, what stopped it and what is running instead', () => {
  const { releaseStallText } = mod();
  assert.equal(releaseStallText(FAILED),
    'PR #2589 (7817d05) merged but was not released: its release workflow failed. '
    + 'The platform is still running 741b8f7. Re-running the failed jobs releases it; so would the next merge.');
  assert.equal(releaseStallText({ ...FAILED, kind: 'workflow_running' }),
    'PR #2589 (7817d05) merged and its release workflow is still running, well past the usual couple of minutes. '
    + 'The platform is still running 741b8f7.');
  assert.equal(releaseStallText({ ...FAILED, kind: 'rollout_missing' }),
    'PR #2589 (7817d05) merged and its release workflow succeeded, but the platform has not rolled onto it. '
    + 'The platform is still running 741b8f7.');
  assert.equal(releaseStallText({ ...FAILED, kind: 'unknown' }),
    'PR #2589 (7817d05) merged but is not running yet, and no release workflow run could be found for it. '
    + 'The platform is still running 741b8f7.');
  // A direct push has no PR to name; a record with no running sha still reads.
  assert.equal(releaseStallText({ kind: 'workflow_failed', sha: '7817d05', prNumber: null, running: null }),
    'Commit 7817d05 landed on main but was not released: its release workflow failed. '
    + 'Re-running the failed jobs releases it; so would the next merge.');
});

test('the initial render is the hidden, empty slot', () => {
  const { releaseStallStore } = mod();
  assert.deepEqual({ ...releaseStallStore.get() }, QUIET);
  const html = bannerHtml(QUIET);
  assert.match(html, /^<div id="dev-release-stall-notice" class="px-3 pt-2 hidden"><\/div>/,
    'absent — not hidden inside — while nothing is stalled, so a board that is fine carries no extra node');
});

test('stalled: amber, above the cards, the commit and the running build named, the run linked', () => {
  const html = bannerHtml(FAILED);
  assert.match(html, /<div id="dev-release-stall-notice" class="px-3 pt-2">/, 'the slot shows');
  assert.match(html, /data-release-stall="workflow_failed"/);
  assert.match(html, /border-amber-500\/40 bg-amber-500\/10/, 'a condition somebody may need to act on: amber');
  assert.match(html, /PR #2589 \(7817d05\) merged but was not released/);
  assert.match(html, /still running 741b8f7/);
  assert.match(html,
    /<a href="https:\/\/github\.com\/Usernode-Labs\/social-vibecoding\/actions\/runs\/35461203746" target="_blank" rel="noopener noreferrer"[^>]*>Open the workflow run<\/a>/);
  assert.doesNotMatch(html, /<button/, 'nothing here is a verb the board can perform; the fix is on GitHub');
  assert.doesNotMatch(html, /\b(bg|text|border)-(gray|indigo)-/);
});

test('without a run there is no link, and the kind still shows', () => {
  const html = bannerHtml({ ...FAILED, kind: 'unknown', runUrl: null });
  assert.match(html, /data-release-stall="unknown"/);
  assert.match(html, /no release workflow run could be found/);
  assert.doesNotMatch(html, /<a /);
});

test('the store is published from the promoted list beside the other two notices', () => {
  assert.match(MOUNT_SRC, /publishReleaseStall\(state\) \{\s*releaseStallStore\.set\(state\);/);
  assert.match(APP_VIEW_SRC,
    /AppView\._renderMainPauseNotice\(\);\s*AppView\._renderReleaseStallNotice\(\);/,
    'published where the pause notice is, on every promoted-list load');
  const fn = APP_VIEW_SRC.slice(APP_VIEW_SRC.indexOf('_renderReleaseStallNotice() {'));
  const body = fn.slice(0, fn.indexOf('\n  },'));
  assert.match(body, /publishReleaseStall\?\.\(\{/);
  assert.match(body, /\/\^https:\\\/\\\/github\\\.com\\\/\/\.test\(rs\.runUrl\)/,
    'the run link is offered only for a github.com URL');
  assert.match(body, /sha: stalled && rs\.sha \? String\(rs\.sha\)\.slice\(0, 7\) : null/, 'abbreviated once, here');
  assert.match(body, /running: stalled && rs\.running \? String\(rs\.running\)\.slice\(0, 7\) : null/);
  // The block is stored off the promoted payload, which the route serializes
  // beside mainCheck.
  assert.match(APP_VIEW_SRC, /releaseStall: promotedData\.releaseStall && typeof promotedData\.releaseStall === 'object'/);
  assert.match(VOTES_SRC,
    /const releaseStall = appRows\[0\]\.self_hosted\s*\?\s*await releaseWatch\.readStall\(pool, appRows\[0\]\.id\)\s*:\s*releaseWatch\.describe\(null\)/,
    'read for the platform\'s own row only; a child app\'s panel gets the quiet block without a query');
  assert.match(VOTES_SRC, /mainCheck,\s*(?:\/\/[^\n]*\n\s*)*releaseStall,/, 'serialized beside mainCheck');
});
