// The first-run terms-consent gate (issues #1297, #1328), as wiring.
//
// New accounts reached the full shell without ever seeing the published
// terms — the only entry points were the profile token-gated notice and a
// Settings row that renders inside the native app only, so consent stayed
// null forever. #1297 added a trigger module riding the shell bundle
// (frontend/src/features/settings/terms-first-run.js) that checks
// /challenges-api/terms/current on the authed boot and presents
// Settings.showTermsSheet in a first-run mode: Accept posts 'accepted',
// Decline posts 'refused'.
//
// #1328 hardened the mobile side, where the WebView keeps one document
// alive for days so "next page load" meant "next app restart": the ask is
// SEQUENCED after the "Set up your device" sheet in the same launch
// (NativeChrome.firstRunSheetSettled), presented as a BLOCKING modal on
// native (no backdrop/Escape/Close — Accept and Decline are the only
// exits), and RE-EVALUATED on throttled foreground/online transitions
// until the current version is answered. Web keeps the dismissible sheet,
// once per document.
//
// There is no DOM harness for these files, so — like
// tests/feedback-offline-ui.test.js — this pins the seams as source text.
// The text assertions are not decoration: the dapp.json checks for
// /?shot=terms-consent and /?shot=terms-consent-blocking match on these
// exact strings, so a reword that breaks them fails here, next to the
// code, instead of in a proposal check.
//
// Run with: node --test tests/terms-first-run.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const triggerJs = read('frontend', 'src', 'features', 'settings', 'terms-first-run.js');
const settingsJs = read('frontend', 'src', 'features', 'settings', 'settings.js');
const mountTs = read('frontend', 'src', 'features', 'settings', 'mount.ts');
const appJs = read('public', 'js', 'app.js');
const nativeChromeJs = read('public', 'js', 'native-chrome.js');
const dapp = JSON.parse(read('dapp.json'));

// The `showTermsSheet` body, sliced at anchors that BOTH exist and that
// stop at the method's own last line. The end anchor used to be
// `_renderUsernodeBody(readError, loading)`, a method #1079 replaced with
// the publish/view split — `indexOf` returned -1, so `slice` silently ran
// to the end of the file. That is harmless for an `includes('app_version:')`
// check and fatal for the /token/i guard below, since settings.js mentions
// CLI and iframe auth tokens ~96 times elsewhere.
const SHEET_LAST_LINE = 'this._termsSheetOpen = !!sheet;';
const sheetBody = settingsJs.slice(
  settingsJs.indexOf('async showTermsSheet('),
  settingsJs.indexOf(SHEET_LAST_LINE) + SHEET_LAST_LINE.length);

// ─── The trigger module ──────────────────────────────────────────────────

test('the trigger rides the settings bundle, not a new public/js script', () => {
  // From the chassis island, which is in the shell's entry — NOT from
  // ./mount.ts, which is inside the lazy settings chunk now: a boot listener
  // that only exists once the screen has been opened would never fire.
  const indexTsx = read('frontend', 'src', 'features', 'settings', 'index.tsx');
  assert.match(indexTsx, /import '\.\/terms-first-run\.js';/);
  assert.doesNotMatch(mountTs, /import '\.\/terms-first-run\.js';/,
    'the trigger must not ride the lazy chunk');
  // Belt: nothing added it to the service worker's precache either.
  assert.ok(!read('public', 'sw.js').includes('terms-first-run'),
    'no SHELL_ASSETS entry — the module is bundled, not a shell script');
});

test('prompts only when the current version was never answered', () => {
  // 'accepted' AND 'refused' both count as an answer — a recorded decline
  // is what stops the nagging, and a new published version (no consent row
  // yet) naturally re-prompts. An answer also memoizes (#1328) so the
  // native foreground re-check stops asking this document.
  assert.match(triggerJs,
    /payload\.consent\.status !== null\) \{\s*\n\s*TermsFirstRun\._answered = true;/);
  // 404 = nothing published = nothing to ask about — but NOT an answer,
  // so a native re-check notices a later publish without a restart.
  assert.match(triggerJs, /if \(res\.status === 404\) return;/);
});

test('screenshot/demo routes and snapshot boots are skipped', () => {
  assert.match(triggerJs, /params\.get\('shot'\) \|\| params\.get\('demo'\)/);
  assert.match(triggerJs, /_sessionFromSnapshot\) return;/);
});

test('boot pattern: init now if authed, else the once-per-document sv:authed', () => {
  assert.match(triggerJs, /window\.App && window\.App\.user\) TermsFirstRun\.maybePrompt\(\);/);
  assert.match(triggerJs,
    /addEventListener\('sv:authed',\s*\(\) => TermsFirstRun\.maybePrompt\(\), \{ once: true \}\)/);
});

test('the native launch SEQUENCES device setup → terms, never skip-until-restart (#1328)', () => {
  // Waits out the device-permissions run, then that sheet's DISMISSAL,
  // then a ghost-click window — all via the PUBLIC accessors, never the
  // underscore-privates. The old behaviour (return when the sheet was
  // presented, deferring consent to the next app restart) is the #1328 bug.
  assert.match(triggerJs, /await NativeChrome\.maybeShowFirstRunPermissions\(\);/);
  assert.match(triggerJs, /NativeChrome\.firstRunSheetPresented\(\)/);
  assert.match(triggerJs, /await NativeChrome\.firstRunSheetSettled\(\);/);
  assert.match(triggerJs, /SETTLE_DELAY_MS/);
  assert.ok(!triggerJs.includes('_firstRunSheetPresented'),
    'the trigger must not reach into the underscore-private flag');
  assert.ok(!triggerJs.includes('_firstRunSettledPromise'),
    'the trigger must not reach into the underscore-private promise');
  assert.match(nativeChromeJs,
    /firstRunSheetPresented\(\) \{\s*\n\s*return NativeChrome\._firstRunSheetPresented === true;/);
  assert.match(nativeChromeJs,
    /firstRunSheetSettled\(\) \{\s*\n\s*return NativeChrome\._firstRunSettledPromise \|\| Promise\.resolve\(\);/);
  // Settlement resolves on EVERY dismissal — including a ghost-click one
  // that leaves the one-shot marker unwritten — and only a presented
  // sheet installs the promise.
  assert.match(nativeChromeJs, /settled\(\);\s*\n\s*\},/);
  assert.match(nativeChromeJs,
    /NativeChrome\._firstRunSheetPresented = true;\s*\n\s*NativeChrome\._firstRunSettledPromise = settledPromise;/);
});

test('the trigger presents first-run mode, blocking on native only (#1328)', () => {
  // Passing the payload through avoids fetching /terms/current twice;
  // `blocking` derives from the bridge's isNative flag, so web keeps the
  // dismissible sheet. The callbacks are what replace the once-per-document
  // latch: an answer memoizes, a teardown allows a later re-offer.
  assert.match(triggerJs, /window\.usernode\.isNative === true/);
  assert.match(triggerJs, /firstRun: true,\s*\n\s*blocking: native,\s*\n\s*payload,/);
  assert.match(triggerJs, /onAnswered: \(\) => \{ TermsFirstRun\._answered = true; \}/);
  assert.match(triggerJs, /onClosed: \(\) => \{ TermsFirstRun\._presented = false; \}/);
});

test('warm-entry re-check: native-gated, throttled, on foreground and online (#1328)', () => {
  // The mobile WebView document persists across background/foreground for
  // days — the re-check is what stops a fresh consent requirement (or a
  // failed boot fetch) from waiting for an app restart. Web stays
  // once-per-document: _recheck bails out unless native.
  assert.match(triggerJs, /_recheck\(\) \{\s*\n\s*if \(!TermsFirstRun\._isNative\(\)\) return;/);
  assert.match(triggerJs, /document\.visibilityState === 'hidden'\) return;/);
  assert.match(triggerJs,
    /Date\.now\(\) - TermsFirstRun\._lastCheckAt <\s*\n\s*TermsFirstRun\.RECHECK_MIN_MS\) return;/);
  assert.match(triggerJs,
    /addEventListener\('visibilitychange',\s*\n\s*\(\) => TermsFirstRun\._recheck\(\)\)/);
  assert.match(triggerJs, /addEventListener\('online', \(\) => TermsFirstRun\._recheck\(\)\)/);
  // The overlay/in-flight/answered guards replace the old _ran latch.
  assert.match(triggerJs,
    /TermsFirstRun\._inFlight \|\| TermsFirstRun\._presented \|\|\s*\n\s*TermsFirstRun\._answered\) return;/);
  assert.ok(!triggerJs.includes('_ran'),
    'the once-per-document latch is gone — guards + memo replaced it');
});

test('every dead end is silent — console.warn at most, never console.error', () => {
  // A console.error on any route fails proposal checks.
  assert.ok(!/console\.error\(/.test(triggerJs),
    'the trigger must never call console.error');
  assert.match(triggerJs, /console\.warn\('\[terms-first-run\]/);
});

// ─── The sheet's first-run + blocking modes (settings.js) ────────────────

test('first-run mode adds the intro line and a Decline that records refusal', () => {
  assert.match(settingsJs,
    /Reviewing the terms is part of joining the platform\./);
  assert.match(settingsJs, /postConsent\('refused',/);
  // Decline exists only in first-run framing; the settings/profile entry
  // points keep their current Accept + Close shape.
  const declineAt = settingsJs.indexOf("'Decline'");
  assert.ok(declineAt > 0, 'the Decline button label must exist');
  const guard = settingsJs.lastIndexOf('if (firstRun) {', declineAt);
  assert.ok(guard > 0 && declineAt - guard < 900,
    'the Decline button must be gated on firstRun');
});

test('blocking mode is a NON-dismissible modal with no Close (#1328)', () => {
  // Only meaningful while unanswered — an accepted version renders no
  // consent buttons, so a non-dismissible overlay would have no exit.
  assert.match(settingsJs, /const blocking = opts\.blocking === true && !accepted;/);
  // The kit modal is the only presenter with a non-dismissible mode
  // (presentSheet is always drag/backdrop dismissible).
  assert.match(settingsJs,
    /PlatformUI\.modal\(\{\s*\n\s*contentEl: panel,\s*\n\s*dismissible: false,/);
  // No Close button in blocking mode; degraded-kit fallback keeps the
  // dismissible sheet rather than presenting nothing.
  assert.match(settingsJs, /if \(!blocking\) \{\s*\n\s*const closeBtn/);
  assert.match(settingsJs,
    /if \(!sheet\) \{[\s\S]{0,220}PlatformUI\.sheet\(\{ contentEl: panel, onDismiss: onClosed \}\)/);
});

test('accept keeps its behaviour, and both answers share one in-flight lock', () => {
  assert.match(settingsJs, /postConsent\('accepted',/);
  assert.match(settingsJs, /consentButtons\.forEach\(\(b\) => \{ b\.disabled = true; \}\);/);
  // Any successful answer — accept OR decline — reports back to the
  // trigger's memo, and only a success dismisses; a failed POST re-enables
  // the buttons with the overlay still up (what makes blocking safe on a
  // flaky connection).
  assert.match(settingsJs,
    /sheet\.dismiss\(\);\s*\n\s*if \(typeof opts\.onAnswered === 'function'\) opts\.onAnswered\(status\);/);
  // No app_version rides along — that field belongs to the mobile client.
  assert.ok(!sheetBody.includes('app_version:'),
    'the web sheet must not send app_version');
});

test('the first-run copy carries no token language (issue #1550)', () => {
  // Feedback triage item #41: the consent ask narrated a reward mechanism.
  // The intro's second sentence ("Your token allocation stays paused until
  // you accept.") and the Decline toast ("Your token allocation stays
  // paused. ...") are gone; the first sentence stays verbatim, and the
  // consent intent — read the published terms, then accept or decline, and
  // a decline is reversible — is carried by the replacements.
  assert.match(settingsJs,
    /'Reviewing the terms is part of joining the platform\. Please ' \+\s*\n\s*'read the full terms, then choose whether to accept\.'/);
  assert.match(settingsJs,
    /PlatformUI\.toast\(\s*\n\s*'You can accept the terms later from your profile'\)/);
  // The whole dialog, not just the two strings: nothing it renders may
  // mention tokens again. Scoped to the sheet — settings.js elsewhere is
  // full of CLI and iframe auth tokens, which this must not trip on.
  assert.ok(sheetBody.length > 1000 && sheetBody.length < 12000,
    'the sheet-body slice must be bounded by anchors that both exist');
  assert.ok(!/token/i.test(sheetBody),
    'the terms dialog must not mention tokens');
  // The backend gate is unchanged — only the copy stopped narrating it.
  assert.match(settingsJs, /postConsent\('refused',/);
});

test('a pre-fetched payload skips the fetch (what makes the shots write-free)', () => {
  assert.match(settingsJs, /let payload = opts\.payload \|\| null;/);
  assert.match(settingsJs, /if \(!payload\) \{/);
});

// ─── Single presenter (#1361) ─────────────────────────────────────────────

test('exactly one boot trigger auto-presents the terms sheet (#1361)', () => {
  // #1297 was implemented twice in parallel (#1315 and #1318 both merged),
  // each riding sv:authed — at login the two presented two stacked sheets.
  // The fix removed the settings.js copy (maybePromptTerms, its localStorage
  // stamp and its module-scope sv:authed listener); the ONLY auto-trigger is
  // terms-first-run.js. Manual entry points (About & legal, the profile
  // notice) stay user-initiated.
  assert.ok(!settingsJs.includes('maybePromptTerms'),
    'the duplicate #1315 auto-prompt must not return to settings.js');
  assert.ok(!settingsJs.includes('sv-terms-prompted'),
    'the once-per-browser localStorage stamp went with it');
  assert.ok(!settingsJs.includes("addEventListener('sv:authed'"),
    'settings.js must not hook the authed boot — only terms-first-run.js does');
});

test('showTermsSheet never stacks a second terms overlay (#1361)', () => {
  // Return-early, not dismiss-and-replace — a blocking native modal must
  // never be displaced by a later plain open. Checked at entry AND again
  // after the fetch awaits, so a concurrent call can't slip through.
  const guards = sheetBody.match(/if \(this\._termsSheetOpen\) return;/g) || [];
  assert.equal(guards.length, 2, 'guard at entry and again before presenting');
  // Only an actually-presented overlay latches, and every teardown —
  // programmatic dismiss included — clears the flag via the wrapped
  // onDismiss, which still chains the caller's own onClosed.
  assert.match(sheetBody, /this\._termsSheetOpen = !!sheet;/);
  assert.match(sheetBody,
    /Settings\._termsSheetOpen = false;\s*\n\s*if \(typeof opts\.onClosed === 'function'\) opts\.onClosed\(\);/);
});

// ─── The screenshot states (?shot=terms-consent[-blocking]) ──────────────

test('the shots present both variants from a fixed payload, no fetch', () => {
  const shot = appJs.slice(
    appJs.indexOf('_applyTermsConsentShot() {'),
    appJs.indexOf('_applyLaunchShot() {'));
  assert.ok(shot.length > 100, 'located _applyTermsConsentShot');
  assert.match(shot,
    /shot !== 'terms-consent' && shot !== 'terms-consent-blocking'\) return;/);
  // The blocking modal is otherwise derived from the bridge's isNative
  // flag, so this link is its only URL-reachable state.
  assert.match(shot, /const blocking = shot === 'terms-consent-blocking';/);
  assert.match(shot, /firstRun: true,/);
  assert.match(shot, /blocking,/);
  assert.match(shot, /consent: \{ status: null, accepted: false, responded_at: null \}/);
  assert.ok(!shot.includes('fetch('), 'the shot must not fetch');
  // Once-per-document: it presents an overlay that would stack.
  assert.match(appJs, /App\._applyTermsConsentShot\(\);/);
});

test('the dapp.json checks cover title, Accept and Decline on both shot routes', () => {
  const sheetChecks = (dapp.tests || []).filter((t) => t.path === '/?shot=terms-consent');
  assert.equal(sheetChecks.length, 3);
  const sheetTexts = sheetChecks.map((t) => t.expectText);
  assert.ok(sheetTexts.includes('Staging Demo Terms of Service'));
  assert.ok(sheetTexts.includes('Accept the terms'));
  assert.ok(sheetTexts.includes('Decline'));
  for (const c of sheetChecks) assert.match(c.expectSelector, /\.un-sheet/);

  const modalChecks = (dapp.tests || []).filter(
    (t) => t.path === '/?shot=terms-consent-blocking');
  assert.equal(modalChecks.length, 3);
  const modalTexts = modalChecks.map((t) => t.expectText);
  assert.ok(modalTexts.includes('Staging Demo Terms of Service'));
  assert.ok(modalTexts.includes('Accept the terms'));
  assert.ok(modalTexts.includes('Decline'));
  for (const c of modalChecks) assert.match(c.expectSelector, /\.un-modal/);
});
