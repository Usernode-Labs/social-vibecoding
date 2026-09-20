// The reload button downloads the update BEFORE it offers to switch to it.
//
// ── What was wrong ─────────────────────────────────────────────────────
//
// The drawer's stale-version row appeared the moment /api/version reported a
// SHA newer than the one this document booted with, and clicking it ran
// `location.reload()`. That is an ordinary navigation, and public/sw.js races
// every navigation against the cached document on NAVIGATE_TIMEOUT_MS — a
// deadline its own header documents as DELIBERATELY SHORTER THAN A ROUND
// TRIP. Losing that race is the designed case, and losing it meant:
//
//   * the OLD /index.html was served from the shell cache,
//   * `shellFromCacheThisLoad` latched, so all ~38 shell assets came from
//     cache too — one load cannot mix two builds, by design,
//   * the new document landed in the cache behind it, for next time.
//
// So the button did a background download of the update and called it a
// switch. Worse, it then went quiet: `loadedPlatformSha` is captured from the
// FIRST /api/version answer each document sees, so the reloaded-but-still-old
// tab recorded the NEW sha as its own baseline, `isStale` went false, and the
// row stopped offering anything. The reload looked like it had worked.
//
// ── The contract this file pins ────────────────────────────────────────
//
//  1. The stale branch asks the worker to pull the new build into the shell
//     cache (`prefetch-shell`), ONCE PER SHA — that branch runs on every 10s
//     poll for as long as the tab is behind.
//  2. While it is coming down the row is a SPAN, not a button: it still says
//     the platform has moved on and still carries `drawer-ver--stale` (which
//     is what lights the Improve dot), but it does not offer a reload that
//     would serve the old document straight back.
//  3. When the worker reports success the row becomes the reload button, and
//     the click is now safe whichever way the navigation race goes: cache and
//     network hold the same build.
//  4. Every failure mode still ends at a reload button — a refused port, a
//     worker that never answers, no worker at all. A tab with no way forward
//     would be worse than today's behaviour, which is what 'failed' restores.
//  5. PULL-TO-REFRESH GOES THROUGH THE SAME DOOR. The drawer's button was
//     never the only reload: App._refreshOrReload upgrades a pull to a full
//     reload whenever the platform has moved on, and it called
//     location.reload() directly. On a phone the pull IS how people refresh,
//     so the guard that made the button honest was being walked straight past
//     by the gesture most likely to be used. The pull now waits for the same
//     prefetch to settle, and — like the button — reloads anyway when it
//     fails, so a pull can never become a dead gesture.
//  6. A TAB LEFT OPEN ACROSS THE DEPLOY SWITCHES ITSELF (#2545). The cold
//     stale boot already did (#1669); a tab that fell behind later only got
//     the button, so the platform "updated" whenever its owner next found it.
//     It now reloads at the first QUIET MOMENT — hidden, or untouched for
//     SHELL_AUTO_RELOAD_QUIET_MS with no sheet or modal up — on the same
//     terms as the cold boot: a complete prefetch, no draft, the session
//     latch. Never from `failed`, never with a child app's frame on screen,
//     never under the `?shot=` painting. The button stays for every case the
//     automatic switch declines.
//
// Points 1-4 and 6 are executed, not grepped: the methods touch only `App`,
// `document`, `navigator`, `Date` and `MessageChannel`, so they run in a vm
// against stubs. The worker half is source-pinned (it lives in sw.js's
// browser-only branch, which Node never evaluates) and proven end-to-end by
// hand against a real service worker: cached BUILD-1, deployed BUILD-2,
// posted the message, cache held BUILD-2.
//
// Run with: node --test tests/shell-update-prefetch.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const appJs = read('public/js/app.js');
const swJs = read('public/sw.js');
const appCss = read('public/css/app.css');
const sw = require('../public/sw.js');

// Slice one method out of app.js's object literal by name (same shape as
// tests/platform-update-nudge.test.js): `indent` is the method's own
// indentation, so the terminating line is its close and not a nested block's.
function sliceMethod(src, signature, indent = '  ') {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} is defined in the source`);
  const close = `\n${indent}}`;
  const end = src.indexOf(close, start);
  assert.ok(end > start, `${signature} terminates at its own indent`);
  return src.slice(start, end + close.length);
}

const METHODS = `({
${sliceMethod(appJs, '_isShellQuiet() {')},
${sliceMethod(appJs, '_switchToPrefetchedShellIfQuiet() {')},
${sliceMethod(appJs, '_hasUnsavedShellInput() {')},
${sliceMethod(appJs, '_reloadPrefetchedShellIfSafe(sha, { force = false, quiet = false } = {}) {')},
${sliceMethod(appJs, '_ensureShellPrefetch(sha) {')},
${sliceMethod(appJs, 'async loadVersion() {')},
${sliceMethod(appJs, 'async platformMovedOn() {')},
${sliceMethod(appJs, '_refreshOrReload(refresh) {')},
${sliceMethod(appJs, '_announceRefreshIntent() {')},
${sliceMethod(appJs, 'renderPlatformVersionPill(info) {')}
})`;

// A minimal world: the pill's slot, a controller that hands us its port, a
// setTimeout we fire by hand so the 30s bail-out is testable in no time, and
// a clock we advance by hand so the quiet window is too.
//
// The tab starts BUSY — its owner touched it this instant — because that is
// the state every offer-shaped assertion below was written against, and it
// keeps "the button is there" and "the tab switched itself" from being the
// same test. `pause()` is how a test makes the moment quiet.
function harness({
  controller = true, postThrows = false, serverSha = null, controls = [],
} = {}) {
  const slot = { innerHTML: '' };
  const timers = [];
  const posted = [];
  const reloads = [];
  const session = new Map();
  let port = null;
  const clock = { now: 1_700_000_000_000 };
  class FakeDate extends Date {
    static now() { return clock.now; }
  }
  const doc = {
    hidden: false,
    surfaces: [],
    getElementById: (id) => (id === 'platform-version-pill-slot' ? slot : null),
    querySelectorAll: () => controls,
    querySelector: (selector) => {
      assert.equal(selector, '.un-backdrop, [id$="-overlay"][data-open]',
        'the quiet check asks for a presented surface by the two marks one leaves');
      return doc.surfaces[0] || null;
    },
  };

  const ctx = {
    console,
    Date: FakeDate,
    Promise,
    // /api/version, as pull-to-refresh sees it. `serverSha` null means the
    // endpoint is not part of the test and must not be called.
    fetch: async (url) => {
      assert.equal(url, '/api/version');
      assert.ok(serverSha, 'this harness was not given a server answer');
      return { ok: true, json: async () => ({ sha: serverSha }) };
    },
    location: { reload: () => { reloads.push(Date.now()); } },
    sessionStorage: {
      getItem: (key) => session.get(key) || null,
      setItem: (key, value) => { session.set(key, String(value)); },
    },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    document: doc,
    navigator: {
      serviceWorker: controller ? {
        controller: {
          postMessage: (msg, transfer) => {
            if (postThrows) throw new Error('port refused');
            posted.push(msg);
            // KEEP the port when a message carries no transfer. A real
            // postMessage does not revoke a MessageChannel the page already
            // handed over, and not every message wants a reply — a pull posts
            // `refresh-intent` with no port at all, and clobbering here made
            // the drawer's in-flight prefetch unanswerable.
            if (transfer && transfer[0]) port = transfer[0];
          },
        },
      } : {},
    },
    MessageChannel: class {
      constructor() {
        const p1 = { onmessage: null };
        this.port1 = p1;
        this.port2 = { postMessage: (data) => p1.onmessage && p1.onmessage({ data }) };
      }
    },
  };
  vm.createContext(ctx);

  const App = Object.assign({
    loadedPlatformSha: null,
    shellUpdate: null,
    _shellAutoReloadSha: null,
    _shellReloadStarted: null,
    _shellPrefetchSettled: null,
    _lastVersionInfo: null,
    _platformUpdateShot: false,
    _dirtyShellControls: null,
    currentApp: null,
    currentTab: 'app',
    SHELL_PREFETCH_TIMEOUT_MS: 30_000,
    SHELL_AUTO_RELOAD_KEY: 'usernode-shell-auto-reload',
    SHELL_AUTO_RELOAD_QUIET_MS: 10_000,
    SHELL_SURFACE_UP_SELECTOR: '.un-backdrop, [id$="-overlay"][data-open]',
    _lastShellInteractionAt: clock.now,
    ImproveStatus: { refreshDeployDot() { App.dotRefreshes = (App.dotRefreshes || 0) + 1; } },
  }, vm.runInContext(METHODS, ctx));
  ctx.App = App;

  return {
    App,
    slot,
    posted,
    timers,
    reloads,
    session,
    /** The worker's answer, delivered down the port the page transferred. */
    reply: (data) => port.postMessage(data),
    /** Fire the longest pending timer — the bail-out. */
    fireTimeouts: () => { const t = timers.splice(0); t.forEach(({ fn }) => fn()); },
    /** Time passes with nobody touching the tab. */
    pause: (ms) => { clock.now += ms; },
    /** The owner touches the tab — what the foot-of-file listeners record. */
    touch: () => { App._lastShellInteractionAt = clock.now; },
    /** The tab goes to the background (or comes back). */
    hide: (hidden = true) => { doc.hidden = hidden; },
    /** A sheet, panel or modal is presented over the screen (or dismissed). */
    surface: (up = true) => { doc.surfaces = up ? [{ className: 'un-backdrop' }] : []; },
    /** The version poll fires: what loadVersion does on its 10s timer. */
    poll: () => App.renderPlatformVersionPill(App._lastVersionInfo),
  };
}

const STALE = {
  sha: '1111111bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  repoUrl: 'https://github.com/Usernode-Labs/social-vibecoding',
};
const BOOTED = '0000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

// ─── 1. The ask ─────────────────────────────────────────────────────────

test('a tab that has fallen behind asks the worker for the new build', () => {
  const h = harness();
  h.App.loadedPlatformSha = BOOTED;
  h.App.renderPlatformVersionPill(STALE);

  // Field-by-field, not deepEqual: these objects are built inside the vm
  // realm, so they fail a prototype-identity check for reasons that have
  // nothing to do with the behaviour under test.
  assert.equal(h.posted.length, 1, 'the stale row is what triggers the download');
  assert.equal(h.posted[0].type, 'prefetch-shell');
  assert.equal(h.posted[0].sha, STALE.sha,
    'the worker must know which build counts as success');
  assert.equal(h.App.shellUpdate.sha, STALE.sha);
  assert.equal(h.App.shellUpdate.state, 'fetching');
});

test('and asks ONCE, though the stale branch runs on every 10s poll', () => {
  const h = harness();
  h.App.loadedPlatformSha = BOOTED;
  for (let i = 0; i < 5; i++) h.App.renderPlatformVersionPill(STALE);
  assert.equal(h.posted.length, 1, 'one full shell refetch per deploy, not one per poll');

  // …but a SECOND deploy while the first is still in flight is a different
  // build, and must be fetched.
  h.App.renderPlatformVersionPill({ ...STALE, sha: '2222222ccccccccccccccccccccccccccccccccc' });
  assert.equal(h.posted.length, 2);
  assert.equal(h.posted[1].sha, '2222222ccccccccccccccccccccccccccccccccc');
  assert.equal(h.App.shellUpdate.sha, '2222222ccccccccccccccccccccccccccccccccc');
});

test('a settled attempt is not retried — a failure is one refetch, not a loop', () => {
  const h = harness();
  h.App.loadedPlatformSha = BOOTED;
  h.App.renderPlatformVersionPill(STALE);
  h.reply({ ok: false });
  assert.equal(h.App.shellUpdate.state, 'failed');
  for (let i = 0; i < 5; i++) h.App.renderPlatformVersionPill(STALE);
  assert.equal(h.posted.length, 1,
    'a tab that stays behind must not refetch the whole shell every ten seconds');
});

test('a deploy in flight is not a build to download — only a landed one is', () => {
  const h = harness();
  h.App.loadedPlatformSha = BOOTED;
  h.App.renderPlatformVersionPill({ ...STALE, deployProgress: { deploying: true, sha: 'abc' } });
  assert.equal(h.posted.length, 0, 'nothing to prefetch: the new build is not being served yet');
});

// ─── 2. Downloading: says so, offers nothing ────────────────────────────

test('while the build is coming down the row is a span, not a reload button', () => {
  const h = harness();
  h.App.loadedPlatformSha = BOOTED;
  h.App.renderPlatformVersionPill(STALE);

  assert.match(h.slot.innerHTML, /<span/, 'a span…');
  assert.ok(!h.slot.innerHTML.includes('<button'), '…never a button');
  assert.ok(!h.slot.innerHTML.includes('location.reload()'),
    'the click that used to serve the old document back is not offered yet');
  assert.match(h.slot.innerHTML, /drawer-ver--fetching/);
  assert.match(h.slot.innerHTML, /updating…/);
});

test('it reports `downloading`, so the Improve indicator stays lit', () => {
  // The platform HAS moved past this tab; only the offer to switch is waiting.
  //
  // This used to be asserted through the row's CLASS: `--stale` covered both
  // downloading and ready, and refreshDeployDot selected it tag-agnostically
  // so the dot would not blink off for the seconds a download takes. The state
  // is named at its source now (App.platformUpdateState), which keeps the dot
  // lit across both AND lets the button tell them apart — a spinner while the
  // build comes down, a refresh glyph once it is here.
  const h = harness();
  h.App.loadedPlatformSha = BOOTED;
  h.App.renderPlatformVersionPill(STALE);
  assert.match(h.slot.innerHTML, /drawer-ver--stale/, 'the row still styles itself as stale');
  assert.equal(h.App.platformUpdateState, 'downloading',
    'and the state it publishes distinguishes the download from the offer');

  const improveStatus = read('frontend/src/features/improve/improve-status.js');
  assert.match(improveStatus, /window\.App\?\.platformUpdateState/,
    'the indicator reads the named state rather than sniffing the rendered row');
  // Comment-stripped: the note there names the old selector to say what it
  // stopped reading and why.
  assert.doesNotMatch(improveStatus.replace(/^\s*\/\/.*$/gm, ''), /#improve-footer/,
    'and no longer depends on where the version rows are rendered');
  assert.match(appCss, /\.drawer-ver--fetching \{/,
    'and the downloading row has a style of its own');
});

test('every branch of the version row names the update state it represents', () => {
  // The button's glyph is derived from this, so a branch that forgot to name
  // its state would leave a spinner or a refresh arrow up after the thing it
  // described had finished.
  const h = harness();
  h.App.loadedPlatformSha = BOOTED;

  h.App.renderPlatformVersionPill({ ...STALE, sha: BOOTED });
  assert.equal(h.App.platformUpdateState, 'idle', 'on the current build');

  h.App.renderPlatformVersionPill({ ...STALE, deployProgress: { deploying: true, sha: 'abc' } });
  assert.equal(h.App.platformUpdateState, 'deploying', 'while a build rolls out');

  h.App.renderPlatformVersionPill({ ...STALE, sha: null });
  assert.equal(h.App.platformUpdateState, 'idle', 'with no SHA to compare against');
});

// ─── 3. Ready: the reload is real now ───────────────────────────────────

test('the worker reporting success turns the row into the reload button', () => {
  // The tab is busy (its owner touched it this instant), so the automatic
  // switch of section 3b stands aside and the offer is what shows.
  const h = harness();
  h.App.loadedPlatformSha = BOOTED;
  h.App._lastVersionInfo = STALE;
  h.App.renderPlatformVersionPill(STALE);
  h.reply({ ok: true, sha: STALE.sha });

  assert.equal(h.App.shellUpdate.state, 'ready');
  assert.equal(h.reloads.length, 0, 'not under somebody\'s hands');
  // Repainted from the reply itself — nothing waits for the next poll.
  assert.match(h.slot.innerHTML, /<button/);
  assert.match(h.slot.innerHTML, /onclick="location\.reload\(\)"/);
  assert.match(h.slot.innerHTML, /the new build is ready/);
  assert.ok(!h.slot.innerHTML.includes('drawer-ver--fetching'));
});

test('a stale cached boot switches to the complete prefetched build exactly once', async () => {
  const h = harness({ serverSha: STALE.sha });
  h.App.loadedPlatformSha = BOOTED;

  await h.App.loadVersion();
  assert.equal(h.posted.length, 1);
  assert.equal(h.posted[0].sha, STALE.sha);
  assert.equal(h.reloads.length, 0, 'the old document stays up while its replacement downloads');

  h.reply({ ok: true, sha: STALE.sha });
  assert.equal(h.reloads.length, 1, 'a cold stale boot repairs itself without a hidden Settings action');
  assert.equal(h.session.get(h.App.SHELL_AUTO_RELOAD_KEY), STALE.sha,
    'the target is latched across the reload');

  // A duplicated reply cannot schedule another navigation in this document.
  h.reply({ ok: true, sha: STALE.sha });
  assert.equal(h.reloads.length, 1);
});

test('automatic switching never discards a draft', async () => {
  const draft = {
    tagName: 'TEXTAREA', type: 'textarea', value: 'half-written reply',
    defaultValue: '', disabled: false, isContentEditable: false,
  };
  const h = harness({ serverSha: STALE.sha, controls: [draft] });
  h.App.loadedPlatformSha = BOOTED;

  await h.App.loadVersion();
  h.reply({ ok: true, sha: STALE.sha });
  assert.equal(h.reloads.length, 0);
  assert.equal(h.App.shellUpdate.state, 'ready');
  assert.match(h.slot.innerHTML, /<button/,
    'the explicit reload offer remains available after the draft is safe');

  // Nor does the quiet switch, however long the pause: a draft is a draft.
  h.pause(h.App.SHELL_AUTO_RELOAD_QUIET_MS);
  h.poll();
  assert.equal(h.reloads.length, 0, 'thinking about a reply is not a quiet moment');
  // Sent — the field is empty — and the next poll takes the update up.
  draft.value = '';
  h.poll();
  assert.equal(h.reloads.length, 1, 'the draft deferred the switch; it did not cancel it');
});

test('the cross-reload latch turns a repeated stale boot into a visible offer, not a loop', async () => {
  const h = harness({ serverSha: STALE.sha });
  h.App.loadedPlatformSha = BOOTED;
  h.session.set(h.App.SHELL_AUTO_RELOAD_KEY, STALE.sha);

  await h.App.loadVersion();
  h.reply({ ok: true, sha: STALE.sha });
  assert.equal(h.reloads.length, 0);
  assert.match(h.slot.innerHTML, /<button/);

  // The quiet switch reads the same latch: a document this tab already
  // reloaded itself onto, and is somehow still behind, is offered — not
  // reloaded again ten seconds later, and again ten seconds after that.
  h.pause(h.App.SHELL_AUTO_RELOAD_QUIET_MS);
  h.poll();
  h.hide();
  h.App._switchToPrefetchedShellIfQuiet();
  assert.equal(h.reloads.length, 0, 'latched is latched, on both automatic paths');
  assert.match(h.slot.innerHTML, /<button/);
});

// ─── 3b. A tab open across the deploy switches at a quiet moment (#2545) ─

// Every test here is a tab that booted current (loadVersion has answered
// BOOTED once) and finds the platform on STALE later — the shape of the tab
// belonging to whoever just watched the merge land.
function tabOpenAcrossDeploy(opts) {
  const h = harness(opts);
  h.App.loadedPlatformSha = BOOTED;
  h.App._lastVersionInfo = STALE;
  h.App.renderPlatformVersionPill(STALE);
  return h;
}

test('a tab that becomes stale later switches itself once it has been quiet', () => {
  const h = tabOpenAcrossDeploy();
  h.reply({ ok: true, sha: STALE.sha });
  assert.equal(h.reloads.length, 0, 'the build landed under a busy tab: the button, for now');
  assert.match(h.slot.innerHTML, /<button/);

  // Still busy at the next poll…
  h.pause(h.App.SHELL_AUTO_RELOAD_QUIET_MS - 1);
  h.poll();
  assert.equal(h.reloads.length, 0);

  // …and quiet at the one after. This is the whole of #2545: nobody found
  // a button in Settings; the tab is on the new build by itself.
  h.pause(1);
  h.poll();
  assert.equal(h.reloads.length, 1, 'switched at the first quiet poll');
  assert.equal(h.session.get(h.App.SHELL_AUTO_RELOAD_KEY), STALE.sha,
    'through the same latch as the cold boot, so a served-again old document is offered, not looped');

  // Once is once: the poll keeps firing until the reload tears the page down.
  h.poll();
  h.poll();
  assert.equal(h.reloads.length, 1);
});

test('a touch inside the quiet window starts it over', () => {
  const h = tabOpenAcrossDeploy();
  h.reply({ ok: true, sha: STALE.sha });
  h.pause(h.App.SHELL_AUTO_RELOAD_QUIET_MS - 1);
  h.touch();
  h.pause(h.App.SHELL_AUTO_RELOAD_QUIET_MS - 1);
  h.poll();
  assert.equal(h.reloads.length, 0, 'the last touch is what the window is measured from');
  h.pause(1);
  h.poll();
  assert.equal(h.reloads.length, 1);
});

test('a quiet tab switches the moment the build lands, with no poll to wait for', () => {
  const h = tabOpenAcrossDeploy();
  h.pause(h.App.SHELL_AUTO_RELOAD_QUIET_MS);
  h.reply({ ok: true, sha: STALE.sha });
  assert.equal(h.reloads.length, 1, 'the settle itself is the first try');
});

test('a hidden tab is a quiet tab, whatever its owner was doing a second ago', () => {
  const h = tabOpenAcrossDeploy();
  h.reply({ ok: true, sha: STALE.sha });
  assert.equal(h.reloads.length, 0);

  // What the visibilitychange listener at the foot of app.js does.
  h.hide();
  h.App._switchToPrefetchedShellIfQuiet();
  assert.equal(h.reloads.length, 1, 'nobody is looking, and the tab comes back current');
});

test('a sheet, panel or modal on screen holds the switch until it is dismissed', () => {
  const h = tabOpenAcrossDeploy();
  h.reply({ ok: true, sha: STALE.sha });
  h.surface();
  h.pause(h.App.SHELL_AUTO_RELOAD_QUIET_MS);
  h.poll();
  assert.equal(h.reloads.length, 0, 'reading a sheet is not a quiet moment, however still the hands');
  assert.match(h.slot.innerHTML, /<button/, 'the offer stands meanwhile');

  h.surface(false);
  h.poll();
  assert.equal(h.reloads.length, 1);
});

test('a child app on screen holds the switch, hidden or not, until the tab leaves it', () => {
  const h = tabOpenAcrossDeploy();
  h.App.currentApp = 'some-app';
  h.App.currentTab = 'app';
  h.reply({ ok: true, sha: STALE.sha });
  h.pause(h.App.SHELL_AUTO_RELOAD_QUIET_MS);
  h.poll();
  h.hide();
  h.App._switchToPrefetchedShellIfQuiet();
  assert.equal(h.reloads.length, 0,
    'the frame\'s state is the one thing the shell cannot see, so it is never discarded on a guess');

  // Its Dev board is the shell's own screen; leaving the frame is enough.
  h.App.currentTab = 'dev';
  h.App._switchToPrefetchedShellIfQuiet();
  assert.equal(h.reloads.length, 1);
});

test('a failed prefetch is never switched to automatically, however quiet', () => {
  const h = tabOpenAcrossDeploy();
  h.reply({ ok: false });
  assert.equal(h.App.shellUpdate.state, 'failed');
  h.pause(h.App.SHELL_AUTO_RELOAD_QUIET_MS);
  h.poll();
  h.hide();
  h.App._switchToPrefetchedShellIfQuiet();
  assert.equal(h.reloads.length, 0,
    'that reload may serve the old document back — a loop with a latch on it, not an update');
  assert.match(h.slot.innerHTML, /onclick="location\.reload\(\)"/, 'so it stays a button');
});

test('the screenshot painting of the ready state is never reloaded out from under the camera', () => {
  const h = tabOpenAcrossDeploy();
  h.reply({ ok: true, sha: STALE.sha });
  h.App._platformUpdateShot = true;
  h.pause(h.App.SHELL_AUTO_RELOAD_QUIET_MS);
  h.hide();
  h.App._switchToPrefetchedShellIfQuiet();
  assert.equal(h.reloads.length, 0, '?shot=platform-update-ready is a picture, not a state');
});

test('a field somebody typed into is a draft even when its framework hides the difference', () => {
  // A React-controlled input keeps defaultValue in step with value, so the
  // value-versus-default comparison sees nothing. The `input` events it
  // fired are recorded in _dirtyShellControls by the foot-of-file listener.
  const composer = {
    tagName: 'TEXTAREA', type: 'textarea', value: 'half a message', defaultValue: 'half a message',
    disabled: false, isContentEditable: false,
  };
  const h = tabOpenAcrossDeploy({ controls: [composer] });
  h.App._dirtyShellControls = new WeakSet([composer]);
  h.reply({ ok: true, sha: STALE.sha });
  h.pause(h.App.SHELL_AUTO_RELOAD_QUIET_MS);
  h.poll();
  assert.equal(h.reloads.length, 0, 'typed into and still holding something: a draft');

  // Sent: the framework emptied it. Typed into once is not a draft forever.
  composer.value = '';
  composer.defaultValue = '';
  h.poll();
  assert.equal(h.reloads.length, 1);
});

test('the foot of app.js records what quiet is measured against', () => {
  const foot = appJs.slice(appJs.indexOf('App._noteShellInteraction ='));
  assert.ok(foot.length > 0, 'the interaction listener is installed at the foot of app.js');
  // A person's inputs, capture-phase and passive — noting a gesture must
  // never delay or cancel it.
  assert.match(foot, /\['pointerdown', 'keydown', 'touchstart', 'wheel'\]/);
  assert.match(foot, /App\._noteShellInteraction, \{ capture: true, passive: true \}/);
  // Typing is remembered per control, for the draft check above.
  assert.match(foot, /App\._dirtyShellControls = new WeakSet\(\)/);
  assert.match(foot, /addEventListener\('input', \(event\) => \{\s*\n\s*if \(event\.target\) App\._dirtyShellControls\.add\(event\.target\);/);
  // And going hidden is tried at once rather than at the next poll.
  assert.match(foot, /addEventListener\('visibilitychange', \(\) => \{\s*\n\s*if \(document\.hidden\) App\._switchToPrefetchedShellIfQuiet\(\);/);
  // Guarded like the listeners above it: several unit tests load app.js into
  // bare vm sandboxes with no `document` at all.
  assert.match(foot, /if \(typeof document !== 'undefined' && document\.addEventListener\) \{\s*\n\s*App\._dirtyShellControls = new WeakSet\(\)/);
});

// ─── 4. Every failure still ends at a way forward ───────────────────────

test('a worker that answers no still offers the reload, with an honest tip', () => {
  const h = harness();
  h.App.loadedPlatformSha = BOOTED;
  h.App._lastVersionInfo = STALE;
  h.App.renderPlatformVersionPill(STALE);
  h.reply({ ok: false });

  assert.equal(h.App.shellUpdate.state, 'failed');
  assert.match(h.slot.innerHTML, /onclick="location\.reload\(\)"/,
    'this is the pre-change behaviour, which is strictly better than no button');
  assert.match(h.slot.innerHTML, /two tries/, 'and the tip says so');
});

test('a success reply for another build is refused', () => {
  const h = harness();
  h.App.loadedPlatformSha = BOOTED;
  h.App._lastVersionInfo = STALE;
  h.App.renderPlatformVersionPill(STALE);
  h.reply({ ok: true, sha: '3333333ddddddddddddddddddddddddddddddddd' });

  assert.equal(h.App.shellUpdate.state, 'failed');
  assert.match(h.slot.innerHTML, /onclick="location\.reload\(\)"/,
    'an old or rollout-crossed worker cannot claim the requested build is ready');
});

test('a worker that never answers is bailed out of, not waited on forever', () => {
  const h = harness();
  h.App.loadedPlatformSha = BOOTED;
  h.App._lastVersionInfo = STALE;
  h.App.renderPlatformVersionPill(STALE);
  assert.equal(h.App.shellUpdate.state, 'fetching');

  h.fireTimeouts();
  assert.equal(h.App.shellUpdate.state, 'failed');
  assert.match(h.slot.innerHTML, /onclick="location\.reload\(\)"/);
});

test('a reply that arrives after the bail-out does not un-settle the row', () => {
  const h = harness();
  h.App.loadedPlatformSha = BOOTED;
  h.App._lastVersionInfo = STALE;
  h.App.renderPlatformVersionPill(STALE);
  h.fireTimeouts();
  h.reply({ ok: true, sha: STALE.sha });
  assert.equal(h.App.shellUpdate.state, 'failed',
    'settle() is one-way; a late success must not reshape a row already acted on');
});

test('an uncontrolled document offers the reload immediately', () => {
  // No worker is serving this page a cached build either, so a reload
  // already goes to the network. Waiting for a reply nobody will send would
  // strand the only way forward behind a 30s timeout.
  const h = harness({ controller: false });
  h.App.loadedPlatformSha = BOOTED;
  h.App.renderPlatformVersionPill(STALE);

  assert.equal(h.App.shellUpdate.sha, STALE.sha);
  assert.equal(h.App.shellUpdate.state, 'ready');
  assert.match(h.slot.innerHTML, /onclick="location\.reload\(\)"/);
});

test('a controller that refuses the port fails closed to the same button', () => {
  const h = harness({ postThrows: true });
  h.App.loadedPlatformSha = BOOTED;
  h.App.renderPlatformVersionPill(STALE);
  assert.equal(h.App.shellUpdate.state, 'failed');
  assert.match(h.slot.innerHTML, /onclick="location\.reload\(\)"/);
});

// ─── 5. The worker's half of the message ────────────────────────────────

test('sw.js answers prefetch-shell by refetching the whole shell', () => {
  const handler = swJs.slice(swJs.indexOf('async function prefetchShellAssets('));
  assert.ok(handler, 'the worker defines the prefetch');

  const body = handler.slice(0, handler.indexOf("self.addEventListener('fetch'"));
  assert.match(body, /caches\.open\(SHELL_CACHE\)/,
    'into the cache the navigate/shell strategies read');
  // The fetching itself is precacheShell — shared with install(), because a
  // deployed document loads its assets from build-scoped URLs (/b/<sha>/…)
  // that only the freshly fetched document can name. The prefetch hands it
  // the cache and asks for the HTTP cache to be bypassed.
  assert.match(body, /await precacheShell\(cache, \{[\s\S]*?reload: true,[\s\S]*?expectedBuild,[\s\S]*?documentLast: true/,
    'every precached asset, at the URLs the NEW document loads them from');
  const precache = swJs.slice(swJs.indexOf('async function precacheShell('),
    swJs.indexOf("self.addEventListener('install'"));
  assert.match(precache, /const \[documentPath, \.\.\.assets\] = SHELL_ASSETS;/,
    'the document first — its build id decides the asset URLs');
  assert.match(precache, /assets\.map\(async \(path\)/, 'then every other precached asset');
  assert.match(precache, /reload \? \{ cache: 'reload' \} : undefined/,
    "bypasses the HTTP cache — a 'no-cache' revalidation could 304 the old build back");
  assert.match(precache, /if \(expectedBuild && build !== expectedBuild\)/,
    'a response from the wrong rollout pod cannot satisfy the request');
  assert.match(precache, /queueShellDocumentWrite\(cache, document\)/,
    'the fixed document key is promoted through the ordered write queue');
  assert.match(precache, /cache\.put\(url, res\.clone\(\)\)/);
  assert.ok(precache.indexOf('cache.put(url, res.clone())')
    < precache.indexOf('queueShellDocumentWrite(cache, document)'),
    'the document becomes active only after every asset it names was stored');
  assert.match(body, /results\.every\(\(r\) => r\.status === 'fulfilled'\)/,
    'a PARTIAL refresh is the split-build state shellFromCacheThisLoad exists to prevent');
  assert.match(body, /type === 'prefetch-shell'/, 'reachable by message');
  assert.match(body, /shellPrefetches\.has\(expectedBuild\)/,
    'concurrent asks from several tabs share one run per requested build');
  assert.match(body, /port\.postMessage\(\{ ok, sha: expectedBuild \|\| null \}\)/,
    'the reply identifies the build whose download settled');
});

test('the document is refreshed under the key the navigation actually reads', () => {
  // networkFirstNavigate serves cache.match('/index.html') for EVERY route,
  // and writes that same fixed key. Refreshing per-request-URL would leave
  // the one key that is read still stale — which is the bug this whole
  // change is about, one level down.
  assert.equal(sw.SHELL_ASSETS[0], '/index.html');
  const navigate = swJs.slice(swJs.indexOf('async function networkFirstNavigate'));
  assert.match(navigate.slice(0, 3000), /matchCache: \(\) => cache\.match\('\/index\.html'\)/);
});

// ─── 6. Pull-to-refresh uses the same door ──────────────────────────────
//
// A pull has ONE moment to get this right. There is no 10s poll behind it and
// no row to re-read: the gesture either lands on the new build or it silently
// serves the old one back and latches the whole load onto it.

const PULLED = { current: 0 };
const pull = (h) => h.App._refreshOrReload(() => { PULLED.current += 1; });

// Every pull also posts `refresh-intent`, which shuts the worker's boot lane
// so the refresh reaches the network instead of last visit's cached answer.
// The tests below are about the DOWNLOAD, so they read the prefetch asks
// alone; the announcement has its own test at the end.
const prefetches = (h) => h.posted.filter((m) => m.type === 'prefetch-shell');

test('a pull announces itself to the worker before it does anything else', async () => {
  const h = harness({ serverSha: BOOTED });
  h.App.loadedPlatformSha = BOOTED;
  await pull(h);
  assert.equal(h.posted[0]?.type, 'refresh-intent',
    'the announcement goes out first, or the reads it covers have already left');
  assert.equal(h.posted.filter((m) => m.type === 'refresh-intent').length, 1,
    'exactly once per pull');
});

test('a pull with no worker at all still refreshes', async () => {
  const h = harness({ serverSha: BOOTED, controller: false });
  h.App.loadedPlatformSha = BOOTED;
  const before = PULLED.current;
  await pull(h);
  assert.equal(PULLED.current, before + 1, 'the data refresh is not conditional on a worker');
  assert.equal(h.posted.length, 0, 'and nothing was posted to a worker that is not there');
});

test('a worker that refuses the message never breaks the pull', async () => {
  const h = harness({ serverSha: BOOTED, postThrows: true });
  h.App.loadedPlatformSha = BOOTED;
  const before = PULLED.current;
  await pull(h);
  assert.equal(PULLED.current, before + 1, 'a refused announcement is not a failed refresh');
});

test('a pull with the platform still where it was reloads nothing', async () => {
  const h = harness({ serverSha: BOOTED });
  h.App.loadedPlatformSha = BOOTED;
  await pull(h);
  assert.equal(prefetches(h).length, 0, 'nothing to download');
  assert.equal(h.reloads.length, 0, 'and nothing to reload onto');
});

test('a pull on a moved-on platform downloads the build BEFORE reloading', async () => {
  const h = harness({ serverSha: STALE.sha });
  h.App.loadedPlatformSha = BOOTED;

  const settled = pull(h);
  // One turn of the loop is enough for the fetch and the prefetch ask; the
  // reload must NOT have happened yet — that is the whole point.
  await new Promise((r) => setImmediate(r));
  assert.equal(prefetches(h).length, 1, 'the worker was asked for the new build');
  assert.equal(h.reloads.length, 0,
    'reloading here is the exact mistake: sw.js would race it and serve the old document back');

  h.reply({ ok: true, sha: STALE.sha });
  await Promise.race([settled, new Promise((r) => setImmediate(r))]);
  assert.equal(h.reloads.length, 1, 'and only once the cache holds the new build');
});

test('the pull still reloads when the download fails — never a dead gesture', async () => {
  const h = harness({ serverSha: STALE.sha });
  h.App.loadedPlatformSha = BOOTED;

  const settled = pull(h);
  await new Promise((r) => setImmediate(r));
  h.reply({ ok: false });
  await Promise.race([settled, new Promise((r) => setImmediate(r))]);
  assert.equal(h.reloads.length, 1,
    "'failed' is the pre-change behaviour, and a pull that does nothing is worse");
});

test('a worker that never answers bails the pull out on the same timeout', async () => {
  const h = harness({ serverSha: STALE.sha });
  h.App.loadedPlatformSha = BOOTED;

  const settled = pull(h);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.reloads.length, 0);
  assert.ok(h.timers.some((t) => t.ms === 30_000),
    'bounded by SHELL_PREFETCH_TIMEOUT_MS, so the spinner cannot hang forever');

  h.fireTimeouts();
  await Promise.race([settled, new Promise((r) => setImmediate(r))]);
  assert.equal(h.reloads.length, 1);
});

test('the pull joins a download the drawer already started, rather than restarting it', async () => {
  // Both doors are open at once whenever the drawer is on screen. Two full
  // shell refetches over a phone connection for one deploy is exactly what
  // the per-SHA idempotence exists to stop.
  const h = harness({ serverSha: STALE.sha });
  h.App.loadedPlatformSha = BOOTED;
  h.App._lastVersionInfo = STALE;
  h.App.renderPlatformVersionPill(STALE);
  assert.equal(prefetches(h).length, 1);

  const settled = pull(h);
  await new Promise((r) => setImmediate(r));
  assert.equal(prefetches(h).length, 1, 'one download, two waiters');
  assert.equal(h.reloads.length, 0, 'and the pull waits on it like anyone else');

  h.reply({ ok: true, sha: STALE.sha });
  await Promise.race([settled, new Promise((r) => setImmediate(r))]);
  assert.equal(h.reloads.length, 1);
});

test('a pull after the download already settled reloads without asking again', async () => {
  const h = harness({ serverSha: STALE.sha });
  h.App.loadedPlatformSha = BOOTED;
  h.App._lastVersionInfo = STALE;
  h.App.renderPlatformVersionPill(STALE);
  h.reply({ ok: true, sha: STALE.sha });
  assert.equal(h.App.shellUpdate.state, 'ready');

  const settled = pull(h);
  await Promise.race([settled, new Promise((r) => setImmediate(r))]);
  assert.equal(prefetches(h).length, 1, 'the build is already in the cache');
  assert.equal(h.reloads.length, 1);
});

test('the data refresh runs on every pull, moved on or not', async () => {
  const before = PULLED.current;
  const h = harness({ serverSha: BOOTED });
  h.App.loadedPlatformSha = BOOTED;
  await pull(h);
  assert.equal(PULLED.current, before + 1, 'a pull is a data refresh first');
});
