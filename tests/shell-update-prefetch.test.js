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
//
// Points 1-4 are executed, not grepped: both methods touch only `App`,
// `document`, `navigator` and `MessageChannel`, so they run in a vm against
// stubs. The worker half is source-pinned (it lives in sw.js's browser-only
// branch, which Node never evaluates) and proven end-to-end by hand against a
// real service worker: cached BUILD-1, deployed BUILD-2, posted the message,
// cache held BUILD-2.
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
${sliceMethod(appJs, '_ensureShellPrefetch(sha) {')},
${sliceMethod(appJs, 'renderPlatformVersionPill(info) {')}
})`;

// A minimal world: the pill's slot, a controller that hands us its port, and
// a setTimeout we fire by hand so the 30s bail-out is testable in no time.
function harness({ controller = true, postThrows = false } = {}) {
  const slot = { innerHTML: '' };
  const timers = [];
  const posted = [];
  let port = null;

  const ctx = {
    console,
    Date,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    document: {
      getElementById: (id) => (id === 'platform-version-pill-slot' ? slot : null),
    },
    navigator: {
      serviceWorker: controller ? {
        controller: {
          postMessage: (msg, transfer) => {
            if (postThrows) throw new Error('port refused');
            posted.push(msg);
            port = transfer && transfer[0];
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
    _lastVersionInfo: null,
    SHELL_PREFETCH_TIMEOUT_MS: 30_000,
    ImproveStatus: { refreshDeployDot() { App.dotRefreshes = (App.dotRefreshes || 0) + 1; } },
  }, vm.runInContext(METHODS, ctx));
  ctx.App = App;

  return {
    App,
    slot,
    posted,
    timers,
    /** The worker's answer, delivered down the port the page transferred. */
    reply: (data) => port.postMessage(data),
    /** Fire the longest pending timer — the bail-out. */
    fireTimeouts: () => { const t = timers.splice(0); t.forEach(({ fn }) => fn()); },
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

test('it still carries drawer-ver--stale, so the Improve dot stays lit', () => {
  // The platform HAS moved past this tab; only the offer to switch is
  // waiting. ImproveStatus.refreshDeployDot selects on the class alone for
  // exactly this reason — see tests/header-status-pane.test.js.
  const h = harness();
  h.App.loadedPlatformSha = BOOTED;
  h.App.renderPlatformVersionPill(STALE);
  assert.match(h.slot.innerHTML, /drawer-ver--stale/);

  const improveStatus = read('frontend/src/features/improve/improve-status.js');
  assert.match(improveStatus, /'#improve-footer \.drawer-ver--stale'/,
    'the dot selector is tag-agnostic, or it would blink off mid-download');
  assert.match(appCss, /\.drawer-ver--fetching \{/,
    'and the downloading row has a style of its own');
});

// ─── 3. Ready: the reload is real now ───────────────────────────────────

test('the worker reporting success turns the row into the reload button', () => {
  const h = harness();
  h.App.loadedPlatformSha = BOOTED;
  h.App._lastVersionInfo = STALE;
  h.App.renderPlatformVersionPill(STALE);
  h.reply({ ok: true });

  assert.equal(h.App.shellUpdate.state, 'ready');
  // Repainted from the reply itself — nothing waits for the next poll.
  assert.match(h.slot.innerHTML, /<button/);
  assert.match(h.slot.innerHTML, /onclick="location\.reload\(\)"/);
  assert.match(h.slot.innerHTML, /the new build is ready/);
  assert.ok(!h.slot.innerHTML.includes('drawer-ver--fetching'));
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
  h.reply({ ok: true });
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
  const handler = swJs.slice(swJs.indexOf('async function prefetchShellAssets()'));
  assert.ok(handler, 'the worker defines the prefetch');

  const body = handler.slice(0, handler.indexOf("self.addEventListener('fetch'"));
  assert.match(body, /caches\.open\(SHELL_CACHE\)/,
    'into the cache the navigate/shell strategies read');
  assert.match(body, /SHELL_ASSETS\.map/, 'every precached asset, not just the document');
  assert.match(body, /cache:\s*'reload'/,
    "bypasses the HTTP cache — a 'no-cache' revalidation could 304 the old build back");
  assert.match(body, /cache\.put\(path, res\.clone\(\)\)/);
  assert.match(body, /results\.every\(\(r\) => r\.status === 'fulfilled'\)/,
    'a PARTIAL refresh is the split-build state shellFromCacheThisLoad exists to prevent');
  assert.match(body, /type === 'prefetch-shell'/, 'reachable by message');
  assert.match(body, /port\.postMessage\(\{ ok \}\)/, 'and answers the page');
  assert.match(body, /if \(!shellPrefetch\)/,
    'concurrent asks from several tabs share one run');
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
