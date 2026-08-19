// The first-run terms-consent prompt (issue #1297), as wiring.
//
// New web accounts reached the full shell without ever seeing the published
// terms — the only entry points were the profile token-gated notice and a
// Settings row that renders inside the native app only, so consent stayed
// null forever. The fix is a trigger module riding the shell bundle
// (frontend/src/features/settings/terms-first-run.js) that checks
// /challenges-api/terms/current on the once-per-document `sv:authed` boot
// and presents Settings.showTermsSheet in a new first-run mode: Accept
// posts 'accepted', Decline posts 'refused', a quiet dismissal records
// nothing.
//
// There is no DOM harness for these files, so — like
// tests/feedback-offline-ui.test.js — this pins the seams as source text.
// The text assertions are not decoration: the dapp.json checks for
// /?shot=terms-consent match on these exact strings, so a reword that
// breaks them fails here, next to the code, instead of in a proposal check.
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

// ─── The trigger module ──────────────────────────────────────────────────

test('the trigger rides the settings bundle, not a new public/js script', () => {
  assert.match(mountTs, /import '\.\/terms-first-run\.js';/);
  // Belt: nothing added it to the service worker's precache either.
  assert.ok(!read('public', 'sw.js').includes('terms-first-run'),
    'no SHELL_ASSETS entry — the module is bundled, not a shell script');
});

test('prompts only when the current version was never answered', () => {
  // 'accepted' AND 'refused' both count as an answer — a recorded decline
  // is what stops the nagging, and a new published version (no consent row
  // yet) naturally re-prompts.
  assert.match(triggerJs, /consent\.status !== null\) return;/);
  // 404 = nothing published = nothing to ask about.
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

test('one first-run overlay per launch inside the native app', () => {
  // Waits out the device-permissions run, then defers to it via the PUBLIC
  // accessor — never the underscore-private.
  assert.match(triggerJs, /await NativeChrome\.maybeShowFirstRunPermissions\(\);/);
  assert.match(triggerJs, /NativeChrome\.firstRunSheetPresented\(\)/);
  assert.ok(!triggerJs.includes('_firstRunSheetPresented'),
    'the trigger must not reach into the underscore-private flag');
  assert.match(nativeChromeJs, /firstRunSheetPresented\(\) \{\s*\n\s*return NativeChrome\._firstRunSheetPresented === true;/);
});

test('the trigger presents the sheet in first-run mode with its own payload', () => {
  // Passing the payload through avoids fetching /terms/current twice.
  assert.match(triggerJs, /showTermsSheet\(null, \{ firstRun: true, payload \}\)/);
});

test('every dead end is silent — console.warn at most, never console.error', () => {
  // A console.error on any route fails proposal checks.
  assert.ok(!/console\.error\(/.test(triggerJs),
    'the trigger must never call console.error');
  assert.match(triggerJs, /console\.warn\('\[terms-first-run\]/);
});

// ─── The sheet's first-run mode (settings.js) ────────────────────────────

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

test('accept keeps its behaviour, and both answers share one in-flight lock', () => {
  assert.match(settingsJs, /postConsent\('accepted',/);
  assert.match(settingsJs, /consentButtons\.forEach\(\(b\) => \{ b\.disabled = true; \}\);/);
  // No app_version rides along — that field belongs to the mobile client.
  const sheetBody = settingsJs.slice(
    settingsJs.indexOf('async showTermsSheet('),
    settingsJs.indexOf('_renderUsernodeBody(readError, loading)'));
  assert.ok(!sheetBody.includes('app_version:'),
    'the web sheet must not send app_version');
});

test('a pre-fetched payload skips the fetch (what makes the shot write-free)', () => {
  assert.match(settingsJs, /let payload = opts\.payload \|\| null;/);
  assert.match(settingsJs, /if \(!payload\) \{/);
});

// ─── The screenshot state (?shot=terms-consent) ──────────────────────────

test('the shot presents the first-run sheet from a fixed payload, no fetch', () => {
  const shot = appJs.slice(
    appJs.indexOf('_applyTermsConsentShot() {'),
    appJs.indexOf('_applyLaunchShot() {'));
  assert.ok(shot.length > 100, 'located _applyTermsConsentShot');
  assert.match(shot, /shot !== 'terms-consent'\) return;/);
  assert.match(shot, /firstRun: true,/);
  assert.match(shot, /consent: \{ status: null, accepted: false, responded_at: null \}/);
  assert.ok(!shot.includes('fetch('), 'the shot must not fetch');
  // Once-per-document: it presents an overlay that would stack.
  assert.match(appJs, /App\._applyTermsConsentShot\(\);/);
});

test('the dapp.json checks cover title, Accept and Decline on the shot route', () => {
  const checks = (dapp.tests || []).filter((t) => t.path === '/?shot=terms-consent');
  assert.equal(checks.length, 3);
  const texts = checks.map((t) => t.expectText);
  assert.ok(texts.includes('Staging Demo Terms of Service'));
  assert.ok(texts.includes('Accept the terms'));
  assert.ok(texts.includes('Decline'));
  for (const c of checks) assert.match(c.expectSelector, /\.un-sheet/);
});
