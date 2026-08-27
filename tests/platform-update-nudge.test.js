// #1015 — the platform-wide "Platform updating…" banner is GONE, and the
// passive stale-version nudge that replaces it must stay.
//
// Background: a self-app merge used to latch a full-width amber
// "Platform updating… sit tight, write actions are paused." bar on every
// signed-in tab (`App.PlatformUpdating` in public/js/app.js,
// #platform-updating-banner in public/index.html). Behind it sat a
// sessionStorage latch, a 2s /api/version poll, a 5-minute red "stuck"
// variant, a forced location.reload() on the SHA flip, and — the actual
// teeth — a window.fetch wrapper that rejected every non-GET request.
//
// That existed because a self-app merge restarted the SINGLE platform
// container. Blue-green deploys (#1008, scripts/platform-rollout.sh)
// keep the live color serving until the new one is health-gated and cut
// over, so the banner paused writes on a platform that was fully
// available — for the length of a Docker build, routinely past its own
// 5-minute "stuck" threshold.
//
// This file pins the post-removal contract:
//
//  1. NO BANNER — no PlatformUpdating member, no sessionStorage key, no
//     banner markup survives anywhere in the shipped client, so the
//     state machine can't be half-revived.
//  2. NO WRITE BLOCK — window.fetch is never reassigned anywhere in the
//     client. This is the one that mattered: a wrapper that rejects
//     writes is invisible until a deploy, so it gets a standing test
//     rather than a code comment.
//  3. HANDLER IS CLEAN — handleVoteUpdate makes no banner calls and
//     still does the per-proposal refresh work it owns.
//  4. THE NUDGE SURVIVED — loadVersion still records the boot SHA and
//     paints the drawer row, and the stale variant still offers a
//     reload. This is what catches a tab up now, so deleting the banner
//     must not have taken it along.
//  5. SIGNAL MOVED, NOT DELETED — the per-proposal "Resolving
//     conflicts…" badge still derives from the same server broadcasts.
//
// Run with: node --test tests/platform-update-nudge.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const appJs = read('public/js/app.js');
const indexHtml = read('public/index.html');
const MergeStatus = require('../public/js/merge-status.js');

// Slice one method out of an object literal by name. `indent` is the
// method's own indentation, so the terminating "},"/"}" line is the
// method's close and not some nested block's.
function sliceMethod(src, signature, indent) {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} is defined in the source`);
  const close = `\n${indent}}`;
  const end = src.indexOf(close, start);
  assert.ok(end > start, `${signature} terminates at its own indent`);
  return src.slice(start, end + close.length);
}

// Comments in the surviving code legitimately NAME the removed banner to
// explain why it's gone, so assertions about what the code DOES run
// against comment-stripped source.
const stripComments = (src) => src.replace(/^\s*\/\/.*$/gm, '');

const appJsCode = stripComments(appJs);
const handleVoteUpdateCode = stripComments(
  sliceMethod(appJs, 'handleVoteUpdate(data) {', '  ')
);

// Every client-side JS file the shell ships. Used for the fetch-wrapper
// sweep — the write block must not come back anywhere, not just in the
// file it used to live in.
const CLIENT_JS = fs.readdirSync(path.join(ROOT, 'public', 'js'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => ({ file: `public/js/${f}`, src: read(`public/js/${f}`) }));

// The retired banner surface, in full. A leftover caller with no callee
// is a runtime TypeError; a leftover callee is a latch waiting to be
// re-armed.
const RETIRED = [
  'PlatformUpdating',
  'installFetchWrap',
  'restoreFromSessionStorage',
  'observeVersion',
  'verifyMergeStillInFlight',
  'startFastPolling',
  'stopFastPolling',
  'armStuckTimer',
  'disarmStuckTimer',
  '_setBannerTone',
  'fastPollTimer',
  'stuckTimer',
  'fetchWrapInstalled',
  'POLL_FAST_MS',
  'STUCK_AFTER_MS',
];

// ─── 1. The banner is gone from the client ──────────────────────────

test('no member of the retired platform-updating banner survives in app.js', () => {
  for (const name of RETIRED) {
    assert.doesNotMatch(appJsCode, new RegExp(`\\b${name}\\b`),
      `${name} is gone from public/js/app.js`);
  }
});

test('the banner sessionStorage latch is gone', () => {
  // The latch is what made the banner survive a reload — and what held
  // a tab read-only when the un-latch broadcast was missed.
  for (const { file, src } of CLIENT_JS) {
    assert.doesNotMatch(src, /usernode:platform_updating/,
      `${file} carries no platform-updating sessionStorage key`);
  }
});

test('the banner markup is gone from the shell', () => {
  for (const id of [
    'platform-updating-banner',
    'platform-updating-spinner',
    'platform-updating-text',
    'platform-updating-reload',
  ]) {
    assert.ok(!indexHtml.includes(`id="${id}"`), `#${id} is gone from the shell`);
  }
  // And the copy itself — the shell's comment explains the removal
  // without quoting the full sentence, so this catches a revival.
  assert.doesNotMatch(indexHtml, /sit tight/);
  assert.doesNotMatch(appJs, /sit tight/);

  // The unrelated banners that share this region of the shell stay.
  assert.ok(indexHtml.includes('id="offline-banner"'),
    'the offline banner is untouched');
  assert.ok(indexHtml.includes('id="view-as-non-admin-banner"'),
    'the view-as-non-admin banner is untouched');
});

// ─── 2. The write block can never come back ─────────────────────────

test('no client module reassigns window.fetch', () => {
  // The banner blocked writes by wrapping window.fetch and rejecting
  // every non-GET/HEAD request. Nothing in the client may wrap fetch
  // for that purpose again — a rejection that only fires during a
  // deploy is exactly the kind of bug that hides until production.
  for (const { file, src } of CLIENT_JS) {
    assert.doesNotMatch(stripComments(src), /window\.fetch\s*=/,
      `${file} must not reassign window.fetch`);
  }
  assert.doesNotMatch(appJsCode, /method !== 'GET' && method !== 'HEAD'/,
    'no write-method gate survives');
});

// ─── 3. handleVoteUpdate no longer touches platform-wide chrome ─────

test('handleVoteUpdate arms no platform-wide banner', () => {
  assert.doesNotMatch(handleVoteUpdateCode, /PlatformUpdating/,
    'the handler makes no banner calls');
  // It must not branch on `selfHosted` at all: the flag still rides on
  // the broadcast, but a platform merge is no longer special to any
  // client surface.
  assert.doesNotMatch(handleVoteUpdateCode, /data\.selfHosted/,
    'a platform merge is no longer special-cased in the client');
});

test('handleVoteUpdate still does the per-proposal refresh work it owns', () => {
  // The removal must not have taken the handler's real job with it.
  assert.match(handleVoteUpdateCode, /refreshDevData\('vote'\)/,
    'the dev tab still refreshes on a vote update');
  assert.match(handleVoteUpdateCode, /refreshCurrentSessionStatus\(data\.sessionId\)/,
    'the open session pill still advances');
  assert.match(handleVoteUpdateCode, /App\.refreshHomeProposals\(\)/,
    'the work drawer still tracks tallies live');
});

// ─── 4. The stale-version nudge that replaces it survived ───────────

test('loadVersion still records the boot SHA and paints the drawer row', () => {
  const fn = sliceMethod(appJs, 'async loadVersion() {', '  ');
  assert.match(fn, /fetch\('\/api\/version'\)/);
  assert.match(fn, /App\.loadedPlatformSha = info\.sha;/,
    'the boot baseline is still captured — platformMovedOn compares against it');
  assert.match(fn, /App\.renderPlatformVersionPill\(info\)/,
    'the drawer row is still painted on every poll');
});

test('the drawer row still offers a reload when this tab is behind', () => {
  const fn = sliceMethod(appJs, 'renderPlatformVersionPill(info) {', '  ');
  // Stale = the served SHA differs from the one this document booted
  // with (and isn't the local-dev sentinel).
  assert.match(fn, /runningSha !== App\.loadedPlatformSha/);
  assert.match(fn, /runningSha !== 'dev'/);
  // …rendered as a tappable reload. This is the whole replacement for
  // the banner's forced reload.
  assert.match(fn, /drawer-ver--stale/);
  assert.match(fn, /onclick="location\.reload\(\)"/);
  // The deploying spinner (driven by /api/version deployProgress) stays
  // too — a deploy in flight is still worth showing, it just no longer
  // means the platform is going away.
  assert.match(fn, /drawer-ver--deploying/);
  assert.match(fn, /App\.ImproveStatus\.refreshDeployDot\(\)/);
});

test('pull-to-refresh still upgrades to a reload on a moved-on platform', () => {
  // The anonymous shell has no drawer, so this is its ONLY path to new
  // client code (also pinned in tests/ptr-version-reload.test.js).
  assert.match(appJsCode, /async platformMovedOn\(\)/);
  assert.match(appJsCode, /_refreshOrReload\(refresh\)/);
  assert.match(appJsCode, /App\.platformMovedOn\(\)/);
});

// ─── 5. The per-proposal signal moved, it wasn't deleted ────────────

test('the per-proposal resolving badge still derives from the same fields', () => {
  // Persisted snapshot (a card rendered mid-resolve after a reload)…
  const fromSnapshot = MergeStatus.lifecycle({ status: 'promoted', merge_conflict_state: 'resolving' });
  assert.equal(fromSnapshot.key, 'resolving');
  assert.equal(fromSnapshot.label, 'Resolving conflicts…');
  assert.equal(fromSnapshot.spinner, true);

  // …and the feed's process-local flag from GET /api/apps/:slug/promoted.
  assert.equal(MergeStatus.lifecycle({ status: 'promoted', resolving: true }).key, 'resolving');

  // The state badges still have a home on the card.
  assert.ok(MergeStatus.STATE_BADGE_KEYS.includes('resolving'));
  assert.ok(MergeStatus.STATE_BADGE_KEYS.includes('conflict_failed'));

  // And a genuine merge still outranks everything — now reported ONLY
  // on the proposal's own badge, never as platform-wide chrome.
  assert.equal(MergeStatus.lifecycle({ status: 'merging', merge_conflict_state: 'resolving' }).key, 'merging');
});
