// Profile on the web: the drawer row is no longer gated on the native
// bridge, and a signed-out visitor gets a sign-in prompt instead of a
// generic failure.
//
// The bug this pins: #profile worked perfectly in an ordinary browser —
// /challenges-api/me/* scopes to the platform session server-side since
// the topochain merge — but the drawer entry was revealed only when the
// bridge reported the `getProfileInfo` capability. On the web the screen
// therefore existed and was unreachable. The capability probe was the ONLY
// thing hiding it.
//
// Second half: those routes require a session (requireSessionUser), so an
// anonymous visitor got an opaque `HTTP 401` funnelled into "Could not
// load your profile — check your connection", which blames the network for
// what is really "you aren't signed in".
//
// Run with: node --test tests/topochain-profile-web.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const indexHtml = read('public/index.html');
const nativeChrome = read('public/js/native-chrome.js');
const profileJs = read('public/js/profile.js');

// ─── The drawer row ships visible ───────────────────────────────────────

test('drawer-row-profile carries no `hidden` class', () => {
  const anchor = indexHtml.slice(
    indexHtml.indexOf('<a id="drawer-row-profile"'),
    indexHtml.indexOf('</a>', indexHtml.indexOf('<a id="drawer-row-profile"'))
  );
  assert.ok(anchor, 'the profile anchor must exist');
  const classAttr = (anchor.match(/class="([^"]*)"/) || [])[1] || '';
  assert.ok(!/\bhidden\b/.test(classAttr),
    'the row must ship visible — a `hidden` class puts it back behind the bridge');
});

test('native-chrome no longer gates the profile row on getProfileInfo', () => {
  const fn = nativeChrome.slice(
    nativeChrome.indexOf('_initDrawerRows()'),
    nativeChrome.indexOf('// ── Platform login handoff')
  );
  assert.ok(fn.length, '_initDrawerRows must still exist');
  assert.doesNotMatch(fn, /has\(['"]getProfileInfo['"]\)/,
    'the capability probe was the only thing keeping #profile off the web');
  // The drawer-close wiring is the reason the function still exists.
  assert.match(fn, /drawer-row-profile/);
  assert.match(fn, /HeaderMenu\.close\(\)/);
});

test('the stale "hidden unless the bridge reports getProfileInfo" comments are gone', () => {
  // Comments that describe behaviour the code no longer has are worse than
  // no comment: the next reader trusts them.
  const anchorComment = indexHtml.slice(
    Math.max(0, indexHtml.indexOf('<a id="drawer-row-profile"') - 700),
    indexHtml.indexOf('<a id="drawer-row-profile"')
  );
  assert.doesNotMatch(anchorComment, /Hidden unless/i);
  assert.doesNotMatch(
    nativeChrome.slice(0, nativeChrome.indexOf('const NativeChrome')),
    /shown\s*\n?\/\/\s*when the bridge reports getProfileInfo/,
    'the module header must not still claim the row is capability-gated');
});

test('the screen-host comments no longer describe an external leaderboard', () => {
  // The screen reads from this platform's own database now; the external
  // deployment it used to proxy is retired. Anchored on #profile-screen
  // alone since the leaderboard merge: the sibling #challenges-screen
  // <main> this used to start from is gone, folded into the Leaderboard
  // screen's Challenges tab.
  const hosts = indexHtml.slice(
    indexHtml.indexOf('<main id="profile-screen"') - 900,
    indexHtml.indexOf('<main id="profile-screen"') + 400
  );
  assert.doesNotMatch(hosts, /public leaderboard service/);
  assert.doesNotMatch(hosts, /using the bridge's\s*\n?\s*getProfileInfo participant id/);
  assert.match(hosts, /in-process/,
    'the comments should say where the data actually comes from');
});

// ─── Signed-out state ───────────────────────────────────────────────────

test('_fetchJson carries the HTTP status onto the thrown Error', () => {
  // Without this, _load() cannot tell 401 (not signed in) from 500.
  const fn = profileJs.slice(
    profileJs.indexOf('async _fetchJson('),
    profileJs.indexOf('async _load(')
  );
  assert.match(fn, /err\.status\s*=\s*res\.status/);
});

test('_load renders the signed-out state for an anonymous visitor', () => {
  const fn = profileJs.slice(
    profileJs.indexOf('async _load('),
    profileJs.indexOf('// ── rendering')
  );
  // Cheap pre-check: the SPA boots anonymously, so skip the round-trip.
  assert.match(fn, /App\.user/, 'checks for a session before fetching');
  assert.match(fn, /signedOut:\s*true/);
  // And the 401 branch, for a session that lapsed while the screen was open.
  assert.match(fn, /err\.status === 401/);
});

test('a 401 replaces stale data rather than leaving the last user on screen', () => {
  const fn = profileJs.slice(
    profileJs.indexOf('async _load('),
    profileJs.indexOf('// ── rendering')
  );
  const branch = fn.slice(fn.indexOf('err.status === 401'));
  // `_data = { signedOut: true }` unconditionally — NOT `if (!_data)`,
  // which would keep showing the previous user's rank after logout.
  assert.match(branch.slice(0, 300), /Profile\._data = \{ signedOut: true \}/);
});

test('the signed-out render offers a sign-in link, not the connection error', () => {
  const fn = profileJs.slice(profileJs.indexOf('_render() {'));
  const branch = fn.slice(fn.indexOf('d.signedOut'), fn.indexOf('if (d.error)'));
  assert.match(branch, /Sign in to see your profile/);
  assert.match(branch, /#login/, 'links to the in-SPA login route');
  // The generic copy must survive for REAL failures.
  assert.match(fn, /Could not load your profile/);
});

test('the signed-out branch is checked before the generic error branch', () => {
  const fn = profileJs.slice(profileJs.indexOf('_render() {'));
  assert.ok(fn.indexOf('d.signedOut') < fn.indexOf('if (d.error)'),
    'otherwise a signed-out visitor still sees the connection-error copy');
});

// ─── The editable profile (issue #982) ──────────────────────────────────
//
// The screen grew an identity card and an edit sheet, and its completed
// list stopped being the organiser's flag. These pin the parts a later
// refactor could quietly undo.

test('the identity card renders picture, name and the way in to editing', () => {
  const fn = profileJs.slice(
    profileJs.indexOf('_renderIdentityCard() {'),
    profileJs.indexOf('// ── completed challenges')
  );
  assert.ok(fn.length, '_renderIdentityCard must exist');
  assert.match(fn, /profile-edit-btn/);
  assert.match(fn, /Profile\.showEditSheet\(\)/);
  assert.match(fn, /Your builder profile/);
  assert.match(fn, /#leaderboard\/users\//, 'the builder-profile link goes to the kudos page');
});

test('the bio is a text node, never innerHTML', () => {
  // It is deliberately plain text, not markdown — nothing renders it
  // through marked/DOMPurify, so it must never reach innerHTML.
  const code = profileJs.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /innerHTML/,
    'this module builds DOM with _el()/textContent only');
  assert.match(profileJs, /whitespace-pre-line/, 'newlines in a bio still render');
});

test('outbound handle links are scheme-guarded and rel-protected', () => {
  const fn = profileJs.slice(
    profileJs.indexOf('_renderIdentityCard() {'),
    profileJs.indexOf('// ── completed challenges')
  );
  assert.match(fn, /Profile\._safeHref\(/,
    'escaping alone would not stop a javascript: href');
  assert.match(fn, /rel = 'noopener noreferrer'/);
  assert.match(fn, /encodeURIComponent\(links\.github\)/);
  assert.match(profileJs, /\^https\?:\\\/\\\//, '_safeHref pins http(s) only');
});

test('the username is shown read-only, with the reason', () => {
  const fn = profileJs.slice(profileJs.indexOf('showEditSheet() {'));
  assert.match(fn, /profile-edit-username/);
  assert.match(fn, /userInput\.readOnly = true/);
  assert.match(fn, /userInput\.disabled = true/);
  assert.match(fn, /can’t be changed/,
    'a greyed-out field with no explanation reads as a bug');
  // Nothing may ever PATCH it.
  const save = profileJs.slice(profileJs.indexOf('async _save('));
  assert.doesNotMatch(save.slice(0, 2500), /username:/);
});

test('the edit sheet degrades when the native sheet kit is absent', () => {
  const fn = profileJs.slice(profileJs.indexOf('showEditSheet() {'));
  // Same `|| null` shape Settings.showTermsSheet handles — but the editor
  // must still be reachable, so it falls back to rendering inline.
  assert.match(fn, /window\.PlatformUI && PlatformUI\.sheet/);
  assert.match(fn, /if \(!Profile\._sheet\)/);
  assert.match(fn, /insertBefore\(panel, root\.firstChild\)/);
});

test('the photo is downscaled client-side before upload', () => {
  const fn = profileJs.slice(
    profileJs.indexOf('async _prepareAvatar('),
    profileJs.indexOf('async _decodeImage(')
  );
  assert.ok(fn.length, '_prepareAvatar must exist');
  // The server ships no image decoder, so this is load-bearing, not polish.
  assert.match(fn, /toBlob/);
  assert.match(fn, /AVATAR_MAX_PX/);
  assert.match(fn, /AVATAR_MAX_BYTES/);
  assert.match(fn, /while \(blob && blob\.size > Profile\.AVATAR_MAX_BYTES/,
    'one re-encode is not enough — shrink until it fits');
  // Centre crop, so a portrait photo is not squashed into the circle.
  assert.match(fn, /bitmap\.width - side/);
  assert.match(fn, /bitmap\.height - side/);
});

test('object URLs for a staged photo are revoked', () => {
  assert.match(profileJs, /URL\.revokeObjectURL/);
  const fn = profileJs.slice(profileJs.indexOf('_clearPendingAvatar() {'));
  assert.match(fn.slice(0, 400), /revokeObjectURL\(Profile\._pendingAvatarUrl\)/);
});

test('nothing is written until Save, and the avatar goes first', () => {
  const fn = profileJs.slice(
    profileJs.indexOf('async _save('),
    profileJs.indexOf('async _errText(')
  );
  const avatarAt = fn.indexOf("'/api/me/avatar'");
  const patchAt = fn.indexOf("'/api/me/profile'");
  assert.ok(avatarAt > 0 && patchAt > avatarAt,
    'the byte upload is the one that can fail — do it before the text write');
  assert.match(fn, /method: 'PATCH'/);
  assert.match(fn, /application\/octet-stream/);
  // And the post-write truth is re-read, not guessed at locally.
  assert.match(fn, /Profile\._refreshUser\(\)/);
});

test('field-level server errors keep the sheet open', () => {
  const fn = profileJs.slice(profileJs.indexOf('async _save('));
  assert.match(fn, /body\.details/);
  assert.match(fn, /if \(pinned\) \{ saveBtn\.disabled = false; return; \}/,
    'losing the user’s other edits to one bad handle would be its own bug');
});

test('the completed list is the viewer’s own, and every row links out', () => {
  assert.doesNotMatch(profileJs, /challenges\.filter\(\(c\) => c\.completed\)/,
    'c.completed is an ORGANISER flag — that filter showed 28 of production’s '
    + '34 live challenges to every signed-in person as their own completions');
  assert.match(profileJs, /\/api\/me\/challenges\/completed/);
  const fn = profileJs.slice(
    profileJs.indexOf('_renderCompleted(root, payload) {'),
    profileJs.indexOf('_relativeDate(iso) {')
  );
  assert.match(fn, /card\.href = '#leaderboard\/challenges\/'/);
  assert.match(fn, /See all challenges/);
  assert.match(fn, /No completed challenges yet/);
  assert.match(fn, /Browse challenges/, 'the empty state offers a way forward');
});

test('the stale "organiser flag" comments are gone', () => {
  // A comment describing behaviour the code no longer has is worse than no
  // comment: the next reader trusts it.
  const header = profileJs.slice(0, profileJs.indexOf('const Profile = {'));
  assert.match(header, /ORGANISER flag/,
    'the header must explain what the list means now, and what it used to mean');
  assert.doesNotMatch(header, /completed challenges from the in-process/,
    'the old header described the /challenges-api grid read that is gone');
});

test('the drawer row can show the viewer’s picture', () => {
  const app = read('public/js/app.js');
  assert.match(indexHtml, /id="drawer-avatar"/);
  assert.match(indexHtml, /id="drawer-profile-glyph"/);
  // Ships hidden with NO src, so a signed-out shell requests nothing.
  const img = indexHtml.slice(indexHtml.indexOf('<img id="drawer-avatar"'));
  assert.match(img.slice(0, 200), /class="hidden/);
  assert.doesNotMatch(img.slice(0, 200), /\ssrc=/);
  assert.match(app, /applyUserAvatar\(\) \{/);
  assert.match(app, /App\.applyUserAvatar\(\);/, 'called on sign-in');
});

test('?shot=profile-edit opens the sheet for the screenshot capture', () => {
  const fn = profileJs.slice(
    profileJs.indexOf('_maybeOpenShot() {'),
    profileJs.indexOf('showEditSheet() {')
  );
  assert.match(fn, /shot !== 'profile-edit'/);
  assert.match(fn, /Profile\._shotFired = true/, 'one-shot, so a refresh does not reopen it');
  // Pure UI state with no writes — an env gate would starve the "before"
  // side of the capture forever.
  assert.doesNotMatch(fn, /staging/i);
  // The declared checks are a CAPPED resource: src/services/app-manifest.js
  // keeps only the first MAX_TESTS (10) entries, so an entry's POSITION in
  // the array decides whether it ever runs. Two things follow, and both are
  // pinned here because both are easy to get silently wrong:
  //   - new entries go at the TOP (one appended to the 225-long tail is
  //     dropped and proves nothing);
  //   - every slot spent EVICTS an older check, so this change spends two,
  //     not one per assertion — the screen check carries its identity-card
  //     assertion as `expectText` rather than buying a third slot.
  const appManifest = require('../src/services/app-manifest');
  const live = appManifest.read(path.join(__dirname, '..')).tests;
  assert.ok(live.some((t) => String(t.path).includes('shot=profile-edit')),
    'a state link that stops rendering must fail checks, not regress silently');
  const mine = live.filter((t) => t.name.includes('#982'));
  assert.equal(mine.length, 2, 'two slots, deliberately — see above');
});

test('the profile checks assert on the changed screen, not on "/"', () => {
  const appManifest = require('../src/services/app-manifest');
  const live = appManifest.read(path.join(__dirname, '..')).tests;
  const mine = live.filter((t) => t.name.includes('#982'));
  for (const t of mine) {
    assert.match(t.path, /#profile$/,
      'the self-app is hash-routed — a bare pathname boots the home feed');
    assert.ok(t.expectSelector, `${t.name} must assert on a real element`);
  }
  // The screen check proves BOTH halves of the change in one slot: the
  // corrected completed list (the selector) and the identity card above it
  // (the text, which only the card renders).
  const screen = mine.find((t) => t.path === '/#profile');
  assert.match(screen.expectSelector, /data-completed-challenge/);
  assert.equal(screen.expectText, 'Edit profile');
});

test('spending profile slots did not evict a still-needed check', () => {
  // The home-panels widget suite requires its own zero-state entry to stay
  // inside the cap. Prepending here is what could push it out, so assert it
  // from this side too rather than only discovering it in that file.
  const appManifest = require('../src/services/app-manifest');
  const live = appManifest.read(path.join(__dirname, '..')).tests;
  assert.ok(live.some((t) => t.path === '/?demo=1&challenges=none'),
    'the #947 challenges-widget zero-state check must still run');
});

test('the fallback circle picks a letter, not whatever character is first', () => {
  // A display name is free text: "[Staging demo] admin" or "…hello" would
  // otherwise put a bracket or an ellipsis in the circle.
  const fn = profileJs.slice(
    profileJs.indexOf('_initial() {'),
    profileJs.indexOf('_avatarEl(')
  );
  assert.match(fn, /\[\\p\{L\}\\p\{N\}\]/u,
    'match the first letter-or-digit');
  assert.match(fn, /u\.displayName, u\.username/, 'display name first, then the handle');
  assert.match(fn, /return '\?'/, 'and a last resort that is never blank');
});
