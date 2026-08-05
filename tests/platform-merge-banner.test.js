// #962 — the platform-wide "Platform updating…" banner must signal a
// REAL merge and nothing else.
//
// Background: the banner (App.PlatformUpdating in public/js/app.js,
// #platform-updating-banner in public/index.html) used to carry a
// second, non-blocking "resolving merge conflicts" mode (#239), armed
// off the auto-conflict-resolver's vote_update { resolving: true }.
// That broadcast fires whenever an eligible proposal's branch needs a
// worker `git merge origin/main` — routine drift housekeeping that in
// production ended WITHOUT a merge about 7 times in 10 — so every
// signed-in person was told a merge had hit conflicts and would retry
// while nothing was merging and nothing was paused.
//
// This file pins the narrowed contract:
//
//  1. ARMING — handleVoteUpdate arms the banner only on
//     { merging: true, selfHosted: true }, and still unlatches on the
//     abort counter-event.
//  2. NO RESOLVING MODE — none of the retired members survive anywhere
//     in the shipped client, so the mode can't be half-revived.
//  3. RESTORE — a payload from the retired mode (or any payload with no
//     usable fromSha) is DISCARDED rather than restored. Exercised for
//     real against the shipped method, not just grepped: a restored
//     banner with no SHA to flip away from would sit until the stuck
//     timer.
//  4. MARKUP — the Dismiss button that only the resolving mode used is
//     gone; the merge banner's own parts are untouched.
//  5. SIGNAL MOVED, NOT DELETED — the per-proposal "Resolving
//     conflicts…" badge still derives from the same server broadcasts.
//
// Run with: node --test tests/platform-merge-banner.test.js

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

// Comments in these methods legitimately NAME the retired behaviour to
// explain why it's gone, so assertions about what the code does run
// against comment-stripped source.
const stripComments = (src) => src.replace(/^\s*\/\/.*$/gm, '');

const handleVoteUpdate = sliceMethod(appJs, 'handleVoteUpdate(data) {', '  ');
const handleVoteUpdateCode = stripComments(handleVoteUpdate);
const restoreSrc = sliceMethod(appJs, 'restoreFromSessionStorage() {', '    ');

// The retired #239 surface, in full. Every one of these must be gone —
// a leftover caller with no callee is a runtime TypeError, and a
// leftover callee is a mode waiting to be re-armed.
const RETIRED = [
  'beginResolving',
  'endResolving',
  '_clearResolvingState',
  'showResolving',
  'showResolveFailed',
  'dismissResolveFailure',
  '_clearResolveFailedTimer',
  'startResolvePolling',
  'stopResolvePolling',
  'armResolveStuckTimer',
  'disarmResolveStuckTimer',
  'resolvingSession',
  'resolvePollTimer',
  'resolveStuckTimer',
  'resolveFailedTimer',
  'RESOLVE_POLL_MS',
  'RESOLVE_FAILED_HIDE_MS',
];

// ─── 1. Arming: a real merge, and only a real merge ─────────────────

test('handleVoteUpdate arms the banner only on merging + selfHosted', () => {
  // The arm itself, with both guards intact.
  assert.match(handleVoteUpdateCode, /if \(data\.merging && data\.selfHosted\) \{/,
    'armed on the promoted → merging broadcast for the self-app');
  assert.match(handleVoteUpdateCode, /App\.PlatformUpdating\.begin\(\{/);
  assert.match(handleVoteUpdateCode, /sessionId: data\.sessionId/,
    'begin() carries the sessionId verifyMergeStillInFlight() checks');

  // The abort counter-event still unlatches — without it a failed
  // self-app merge holds every tab read-only until the stuck timer.
  assert.match(
    handleVoteUpdateCode,
    /if \(data\.merging === false && !data\.merged && data\.selfHosted\) \{\s*\n\s*App\.PlatformUpdating\.cancel\(\);\s*\n\s*\}/,
    'cancel() is the whole body of the counter-event branch'
  );

  // `begin` / `cancel` are the ONLY banner calls this handler makes.
  const bannerCalls = handleVoteUpdateCode.match(/App\.PlatformUpdating\.(\w+)\(/g) || [];
  assert.deepEqual(
    [...new Set(bannerCalls.map((c) => c.replace(/^App\.PlatformUpdating\./, '').replace(/\($/, '')))].sort(),
    ['begin', 'cancel']
  );
});

test('handleVoteUpdate never branches on the resolver lifecycle', () => {
  // The resolver's `resolving` broadcasts still arrive (the proposal
  // badges read them) — this handler simply must not act on them.
  assert.doesNotMatch(handleVoteUpdateCode, /data\.resolving/,
    'the banner tracks the merge, not the branch-sync housekeeping');
  assert.doesNotMatch(handleVoteUpdateCode, /resolutionOutcome/);
});

// ─── 2. The retired mode is gone from the whole client ──────────────

test('no member of the retired #239 resolving mode survives in the client', () => {
  for (const name of RETIRED) {
    assert.doesNotMatch(appJs, new RegExp(`\\b${name}\\b`),
      `${name} is gone from public/js/app.js`);
  }
});

test('PlatformUpdating keeps exactly the members the merge banner needs', () => {
  for (const kept of [
    'begin(', 'cancel(', 'end(', 'show(', 'hide(', 'observeVersion(',
    'restoreFromSessionStorage(', 'verifyMergeStillInFlight(',
    'startFastPolling(', 'armStuckTimer(', 'installFetchWrap(',
    '_setBannerTone(',
  ]) {
    assert.ok(appJs.includes(kept), `${kept} is still defined`);
  }
  // The write block is the banner's actual teeth — it must stay keyed
  // on isActive() (i.e. on a real merge), never on anything softer.
  assert.match(appJs, /isActive\(\) \{\s*\n\s*return !!this\.fromSha;/);
  assert.match(appJs, /self\.isActive\(\) && method !== 'GET' && method !== 'HEAD'/);
});

// ─── 3. Restore discards anything that isn't a live merge ───────────

// Build a standalone PlatformUpdating-shaped object around the SHIPPED
// restoreFromSessionStorage, with the collaborators it calls stubbed so
// the test observes real control flow rather than a regex.
function makeRestorer(stored) {
  const store = new Map();
  if (stored !== undefined) store.set('usernode:platform_updating', stored);
  const sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    removeItem: (k) => store.delete(k),
  };
  const factory = new Function('sessionStorage', 'console', 'fetch', `
    return {
      SS_KEY: 'usernode:platform_updating',
      STUCK_AFTER_MS: 5 * 60 * 1000,
      fromSha: null,
      since: null,
      sessionId: null,
      calls: [],
      isActive() { return !!this.fromSha; },
      show(stuck) { this.calls.push('show:' + !!stuck); },
      startFastPolling() { this.calls.push('poll'); },
      armStuckTimer() { this.calls.push('stuck'); },
      verifyMergeStillInFlight() { this.calls.push('verify'); },
      ${restoreSrc}
    };
  `);
  const fetchStub = () => { throw new Error('restore must not hit the network'); };
  const obj = factory(sessionStorage, { log() {} }, fetchStub);
  return { obj, store };
}

test('restoreFromSessionStorage discards a retired resolving-mode payload', () => {
  // The exact shape a tab running the pre-#962 build left behind.
  const { obj, store } = makeRestorer(JSON.stringify({
    mode: 'resolving', sessionId: 3047, appSlug: 'usernode-2d5619', since: Date.now(),
  }));
  obj.restoreFromSessionStorage();

  assert.equal(obj.isActive(), false, 'no banner, so no write block');
  assert.deepEqual(obj.calls, [], 'nothing shown, polled or armed');
  assert.equal(store.size, 0, 'the stale payload is cleared, not left to re-fire');
});

test('restoreFromSessionStorage discards a payload with no usable fromSha', () => {
  for (const payload of [
    JSON.stringify({ since: Date.now(), sessionId: 7 }),   // fromSha absent
    JSON.stringify({ fromSha: null, since: Date.now() }),  // fromSha null
    JSON.stringify({ fromSha: '', since: Date.now() }),    // fromSha empty
  ]) {
    const { obj, store } = makeRestorer(payload);
    obj.restoreFromSessionStorage();
    assert.equal(obj.isActive(), false, `no banner for ${payload}`);
    assert.deepEqual(obj.calls, [], `nothing armed for ${payload}`);
    assert.equal(store.size, 0, `payload cleared for ${payload}`);
  }
});

test('restoreFromSessionStorage still restores a live merge banner', () => {
  const since = Date.now() - 1000;
  const { obj, store } = makeRestorer(JSON.stringify({
    fromSha: 'abc1234', since, appSlug: 'usernode-2d5619', sessionId: 3047,
  }));
  obj.restoreFromSessionStorage();

  assert.equal(obj.isActive(), true, 'the banner comes back mid-merge');
  assert.equal(obj.fromSha, 'abc1234');
  assert.equal(obj.sessionId, 3047, 'sessionId survives so the merge can be verified');
  assert.deepEqual(obj.calls, ['show:false', 'poll', 'stuck', 'verify'],
    'shown un-stuck, fast poll + stuck timer armed, merge re-verified');
  assert.equal(store.size, 1, 'a live payload is kept for the next reload');
});

test('restoreFromSessionStorage restores an aged merge banner as stuck', () => {
  const { obj } = makeRestorer(JSON.stringify({
    fromSha: 'abc1234', since: Date.now() - 6 * 60 * 1000, sessionId: 3047,
  }));
  obj.restoreFromSessionStorage();
  assert.ok(obj.calls.includes('show:true'), 'past STUCK_AFTER_MS → red + Reload');
});

test('restoreFromSessionStorage tolerates junk in sessionStorage', () => {
  for (const junk of [undefined, 'not json', 'null', '"a string"', '42']) {
    const { obj } = makeRestorer(junk);
    assert.doesNotThrow(() => obj.restoreFromSessionStorage());
    assert.equal(obj.isActive(), false);
  }
});

// ─── 4. Markup: the resolving-only Dismiss button is gone ───────────

test('index.html drops the Dismiss button and keeps the merge banner intact', () => {
  assert.doesNotMatch(indexHtml, /platform-updating-dismiss/,
    'the Dismiss button existed only for the resolving mode`s red variant');
  assert.doesNotMatch(indexHtml, /dismissResolveFailure/,
    'no inline onclick pointing at a method that no longer exists');

  for (const id of [
    'platform-updating-banner',
    'platform-updating-spinner',
    'platform-updating-text',
    'platform-updating-reload',
  ]) {
    assert.ok(indexHtml.includes(`id="${id}"`), `${id} is still in the shell`);
  }
  // Announcement semantics are unchanged — one fewer variant, same role.
  assert.match(indexHtml, /id="platform-updating-banner"[\s\S]{0,400}?role="status"[\s\S]{0,60}?aria-live="polite"/);
});

// ─── 5. The signal moved to the proposal, it wasn't deleted ─────────

test('the per-proposal resolving badge still derives from the same fields', () => {
  // Persisted snapshot (a card rendered mid-resolve after a reload)…
  const fromSnapshot = MergeStatus.lifecycle({ status: 'promoted', merge_conflict_state: 'resolving' });
  assert.equal(fromSnapshot.key, 'resolving');
  assert.equal(fromSnapshot.label, 'Resolving conflicts…');
  assert.equal(fromSnapshot.spinner, true);

  // …and the feed's process-local flag from GET /api/apps/:slug/promoted.
  assert.equal(MergeStatus.lifecycle({ status: 'promoted', resolving: true }).key, 'resolving');

  // The state badge still has a home on the card.
  assert.ok(MergeStatus.STATE_BADGE_KEYS.includes('resolving'));
  assert.ok(MergeStatus.STATE_BADGE_KEYS.includes('conflict_failed'));

  // And a genuine merge still outranks everything, which is the one
  // state the platform-wide banner now mirrors.
  assert.equal(MergeStatus.lifecycle({ status: 'merging', merge_conflict_state: 'resolving' }).key, 'merging');
});
