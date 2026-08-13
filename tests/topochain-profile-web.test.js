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
// The shell's markup SOURCE. public/index.html is a generated artifact now
// (the React + shadcn chassis swap), and JSX comments never reach it — so
// assertions about the explanatory comments around a screen have to read the
// source they actually live in.
const shellSource = read('frontend/src/Shell.tsx');
// #1079 chunk B moved the drawer (#header-menu-panel) out of Shell.tsx into its
// own island — same markup, same comments, new file.
const menuSource = read('frontend/src/features/header/header-menu.tsx');
const nativeChrome = read('public/js/native-chrome.js');
const profileJs = read('frontend/src/features/profile/profile.js');
// #1083 chunk F did the same for the screen itself: <main id="profile-screen">
// and its host div moved out of Shell.tsx into this island, which is also where
// the renderer now lives (./profile.js beside it). Shell.tsx keeps the comment
// describing where the screen's data comes from, above the <ProfileScreen /> it
// renders in the region's place — so the comment assertions below read both.
const profileIsland = read('frontend/src/features/profile/index.tsx');
// #1191 slice 6 finished the conversion: #profile-root is React-owned end to
// end now, so this module's DOM builders are gone. What it decides — which of
// the six load states the screen is in, how a completed row reads, what goes in
// the fallback circle — moved into profile-store.js, which is plain JS on
// purpose so this suite can still read it. The markup moved into three .tsx
// files. Assertions follow the code.
const profileStoreJs = read('frontend/src/features/profile/profile-store.js');
const profileViewTsx = read('frontend/src/features/profile/profile-view.tsx');
const profileSheetTsx = read('frontend/src/features/profile/profile-edit-sheet.tsx');
const profilePublicTsx = read('frontend/src/features/profile/public-profile-card.tsx');

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
  const profileAt = menuSource.indexOf('id="drawer-row-profile"');
  assert.ok(profileAt > 0, 'the drawer row must still live in the menu island');
  const anchorComment = menuSource.slice(Math.max(0, profileAt - 900), profileAt);
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
  //
  // Two files since chunk F: the comment sits in Shell.tsx above
  // <ProfileScreen />, the host markup it describes sits in the island. Both
  // are checked, so moving the prose to either side keeps this honest.
  const shellAt = shellSource.indexOf('<ProfileScreen />');
  assert.ok(shellAt > 0, 'the shell must still render the profile screen');
  const islandAt = profileIsland.indexOf('id="profile-screen"');
  assert.ok(islandAt > 0, 'the island must still host #profile-screen');
  const hosts = shellSource.slice(Math.max(0, shellAt - 1200), shellAt)
    + profileIsland.slice(0, islandAt + 400);
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
  const branch = profileViewTsx.slice(
    profileViewTsx.indexOf("view.kind === 'signedOut'"),
    profileViewTsx.indexOf("view.kind === 'error'")
  );
  assert.match(branch, /Sign in to see your profile/);
  assert.match(branch, /#login/, 'links to the in-SPA login route');
  // The generic copy must survive for REAL failures.
  assert.match(profileViewTsx, /Could not load your profile/);
});

test('the signed-out branch is checked before the generic error branch', () => {
  // Twice over: in buildProfileView, which decides the kind, and in the
  // component, which renders it. Either order flipping puts the
  // connection-error copy in front of a visitor who is merely logged out.
  const build = profileStoreJs.slice(profileStoreJs.indexOf('export function buildProfileView'));
  assert.ok(build.indexOf('d.signedOut') < build.indexOf('d.error'),
    'otherwise a signed-out visitor still sees the connection-error copy');
  assert.ok(profileViewTsx.indexOf("view.kind === 'signedOut'")
    < profileViewTsx.indexOf("view.kind === 'error'"));
});

// ─── The editable profile (issue #982) ──────────────────────────────────
//
// The screen grew an identity card and an edit sheet, and its completed
// list stopped being the organiser's flag. These pin the parts a later
// refactor could quietly undo.

test('the identity card renders picture, name and the way in to editing', () => {
  const fn = profileViewTsx.slice(
    profileViewTsx.indexOf('function IdentityCard('),
    profileViewTsx.indexOf('function PublicControls(')
  );
  assert.ok(fn.length, 'IdentityCard must exist');
  assert.match(fn, /IdentityAvatar/, 'the picture, or the initial-in-a-circle fallback');
  assert.match(fn, /profile-edit-btn/);
  assert.match(fn, /Profile\.showEditSheet\(\)/);
  const chips = profileStoreJs.slice(profileStoreJs.indexOf('export function identityView'));
  assert.match(chips, /Your builder profile/);
  assert.match(chips, /#leaderboard\/users\//, 'the builder-profile link goes to the kudos page');
});

test('the bio is a text node, never innerHTML', () => {
  // It is deliberately plain text, not markdown — nothing renders it
  // through marked/DOMPurify, so it must never reach innerHTML.
  // dangerouslySetInnerHTML is the React spelling of the same mistake.
  for (const [name, src] of [
    ['profile.js', profileJs],
    ['profile-store.js', profileStoreJs],
    ['profile-view.tsx', profileViewTsx],
    ['profile-edit-sheet.tsx', profileSheetTsx],
    ['public-profile-card.tsx', profilePublicTsx],
  ]) {
    const code = src.replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /innerHTML/, `${name} must render text as text`);
  }
  assert.match(profileViewTsx, /whitespace-pre-line/, 'newlines in a bio still render');
});

test('outbound handle links are scheme-guarded and rel-protected', () => {
  const fn = profileStoreJs.slice(profileStoreJs.indexOf('export function identityView'));
  assert.match(fn, /safeHref\(href\)/,
    'escaping alone would not stop a javascript: href');
  assert.match(fn, /encodeURIComponent\(links\.github\)/);
  assert.match(profileStoreJs, /\^https\?:\\\/\\\//, 'safeHref pins http(s) only');
  // Only the chips built from a user-supplied handle are external; the
  // in-app builder link is not, which is why the flag rides on the chip.
  assert.match(fn, /external: true/);
  assert.match(profileViewTsx, /rel: 'noopener noreferrer'/);
});

test('the username is shown read-only, with the reason', () => {
  assert.match(profileSheetTsx, /id="profile-edit-username"/);
  assert.match(profileSheetTsx, /\breadOnly\b/);
  assert.match(profileSheetTsx, /\bdisabled\b/);
  assert.match(profileSheetTsx, /can’t be changed/,
    'a greyed-out field with no explanation reads as a bug');
  // Nothing may ever PATCH it.
  const save = profileJs.slice(profileJs.indexOf('async _save('));
  assert.doesNotMatch(save.slice(0, 2500), /username:/);
});

test('the edit sheet degrades when the native sheet kit is absent', () => {
  // The lift goes through lib/kit-surface.ts now, which returns null when the
  // kit is missing or refuses — the same `|| null` shape
  // Settings.showTermsSheet handles. The editor must still be reachable, so
  // the panel simply stays where React rendered it: inside #profile-root.
  assert.match(profileSheetTsx, /adoptKitSurface\(\{/);
  assert.match(profileSheetTsx, /kind: 'sheet'/);
  assert.match(profileSheetTsx, /home: 'placeholder'/,
    'its home is #profile-root — that IS the no-kit presentation');
  assert.match(profileSheetTsx, /setAdopted\(!!adoption\)/);
  // And the card chrome the kit shell would have drawn goes on by hand when
  // it did not, through classList — never a rendered className, which would
  // drop platform-sheet-adopted on the next render.
  assert.match(profileSheetTsx, /useClassToggle\(panelRef, 'rounded-xl', !adopted\)/);
  assert.match(profileViewTsx, /<ProfileEditSheet/,
    'rendered inside #profile-root, above the identity card');
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
  assert.match(fn, /if \(pinned\) return \{ fieldErrors \};/,
    'losing the user’s other edits to one bad handle would be its own bug');
  // The sheet pins them per field and stays mounted — _dismissSheet is only
  // reached on the success path.
  assert.match(profileSheetTsx, /setFieldErrors\(result\.fieldErrors\)/);
  assert.match(profileSheetTsx, /if \(result\.ok\) return;/);
});

test('the completed list is the viewer’s own, and every row links out', () => {
  assert.doesNotMatch(profileJs, /challenges\.filter\(\(c\) => c\.completed\)/,
    'c.completed is an ORGANISER flag — that filter showed 28 of production’s '
    + '34 live challenges to every signed-in person as their own completions');
  assert.match(profileJs, /\/api\/me\/challenges\/completed/);
  const shaping = profileStoreJs.slice(profileStoreJs.indexOf('export function completedView'));
  assert.match(shaping, /href: '#leaderboard\/challenges\/'/);
  const fn = profileViewTsx.slice(
    profileViewTsx.indexOf('function Completed('),
    profileViewTsx.indexOf('function TokenCard(')
  );
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
    profileJs.indexOf('async _prepareAvatar(')
  );
  assert.match(fn, /shot !== 'profile-edit'/);
  assert.match(fn, /Profile\._shotFired = true/, 'one-shot, so a refresh does not reopen it');
  // Pure UI state with no writes — an env gate would starve the "before"
  // side of the capture forever.
  assert.doesNotMatch(fn, /staging/i);
  // Declared checks used to be a CAPPED resource — the reader kept only the
  // first MAX_TESTS entries, so an entry's POSITION decided whether it ever
  // ran and each new one evicted an older. #1019 removed that cap: every
  // declared check runs, and the only bound left is MAX_DECLARED_TESTS.
  //
  // The surviving invariant is that the reader actually KEEPS these entries
  // (it still drops malformed ones) and that the manifest hasn't grown past
  // the ceiling and started shedding its tail again.
  const appManifest = require('../src/services/app-manifest');
  const meta = appManifest.readTestsWithMeta(
    JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dapp.json'), 'utf8'))
  );
  assert.equal(meta.ceilingDropped, 0,
    `dapp.json declares more than ${appManifest.MAX_DECLARED_TESTS} valid checks — `
    + 'checks past the ceiling never run');
  const live = meta.tests;
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
  const fn = profileStoreJs.slice(
    profileStoreJs.indexOf('export function initialOf('),
    profileStoreJs.indexOf('export function avatarUrlOf(')
  );
  assert.match(fn, /\[\\p\{L\}\\p\{N\}\]/u,
    'match the first letter-or-digit');
  assert.match(fn, /u\.displayName, u\.username/, 'display name first, then the handle');
  assert.match(fn, /return '\?'/, 'and a last resort that is never blank');
});

test('the profile no longer fetches the season challenge list via the old route', () => {
  // #981: this screen stops paying for the season-wide grid it used to
  // filter client-side. /challenges-api/me/* and /challenges-api/seasons
  // must survive; the retired /challenges-api/challenges read must not.
  const body = profileJs.slice(profileJs.indexOf('const Profile'));
  assert.doesNotMatch(body, /\/challenges-api\/challenges/,
    'the old season-grid fetch must not come back');
  assert.match(profileJs, /\/challenges-api\/seasons/,
    'the season lookup stays — it scopes both /me/* reads and names the season');
  assert.match(profileJs, /\/challenges-api\/me\/ranking/);
  assert.match(profileJs, /\/challenges-api\/me\/breakdown/);
});
