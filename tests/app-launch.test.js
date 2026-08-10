// Eager app launch (#931).
//
// Tapping an app used to animate in an EMPTY #app-view and pop the app in
// afterwards: renderAppTab only built the iframe once AppView.open had
// resolved two SEQUENTIAL fetches (detail, then token), which is strictly
// longer than the 380ms zoom. The fix mounts the frame inside the
// transition's reveal callback, behind a cover showing the app's own icon
// and name, and cross-fades the cover out when the frame loads.
//
// That introduces three things worth pinning down, because each has a
// failure mode that is invisible in a screenshot:
//   1. The token mint must be single-flight with a short freshness window,
//      or the three call sites (prewarm, beginLaunch, open) mint three
//      tokens — and, worse, the eager iframe src stops matching the one
//      renderAppTab builds.
//   2. renderAppTab must ADOPT the already-loading frame exactly once. Not
//      adopting means two document loads (the pop-in is back, plus double
//      the app's boot cost); adopting more than once means a status flip or
//      a token refresh silently stops re-rendering.
//   3. Every async branch (load, error, the three ladder rungs, the
//      post-mint src assignment) must be inert once superseded, or a
//      launch the user has navigated away from paints over the screen they
//      actually landed on.
//
// app-view.js is a plain browser script (`const AppView = {…}`), so it goes
// into a vm context with a DOM stub whose innerHTML setter registers the
// ids it finds — same harness family as ensure-staging-preview.test.js.
//
// Run with: node --test tests/app-launch.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');

// ── Controllable clock ──────────────────────────────────────────────────
// Drives BOTH the ladder's setTimeouts and Date.now (the mint's freshness
// window), so a test can sit at t=0 for the mint cases and step through
// 500 / 2000 / 20000ms for the reveal cases without real waiting.
function makeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    get now() { return now; },
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { fn, at: now + (Number(ms) || 0) });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    pending() { return timers.size; },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let pick = null;
        for (const [id, t] of timers) {
          if (t.at <= target && (!pick || t.at < pick.t.at)) pick = { id, t };
        }
        if (!pick) break;
        timers.delete(pick.id);
        now = pick.t.at;
        pick.t.fn();
      }
      now = target;
    },
  };
}

// ── DOM stub ────────────────────────────────────────────────────────────
// Elements are registered by scanning assigned HTML for id="…", so
// getElementById('app-iframe') / ('app-launch-cover') work after a mount,
// with the class list, dataset and src the markup declared.
function makeDom() {
  const els = new Map();

  const makeClassList = (initial) => {
    const set = new Set(String(initial || '').split(/\s+/).filter(Boolean));
    return {
      add: (...c) => c.forEach((x) => set.add(x)),
      remove: (...c) => c.forEach((x) => set.delete(x)),
      contains: (c) => set.has(c),
      toggle: (c, v) => (v === undefined ? (set.has(c) ? set.delete(c) : set.add(c)) : (v ? set.add(c) : set.delete(c))),
    };
  };

  function mkEl(id, attrs = {}) {
    const el = {
      id,
      isConnected: true,
      tagName: (attrs.tagName || 'div').toUpperCase(),
      dataset: attrs.dataset || {},
      style: {},
      classList: makeClassList(attrs.class),
      onload: null,
      onerror: null,
      _src: attrs.src === undefined ? null : attrs.src,
      _text: '',
      _html: '',
      htmlWrites: 0,
      get src() { return el._src || ''; },
      set src(v) { el._src = String(v); },
      getAttribute(name) {
        if (name === 'src') return el._src;
        return null;
      },
      setAttribute() {},
      removeAttribute() {},
      set textContent(v) { el._text = String(v); },
      get textContent() { return el._text; },
      set innerHTML(v) {
        el.htmlWrites += 1;
        el._html = String(v);
        register(String(v));
      },
      get innerHTML() { return el._html; },
      insertAdjacentHTML(_pos, html) {
        el._html += String(html);
        register(String(html));
      },
      appendChild() {},
      addEventListener() {},
      removeEventListener() {},
      remove() {
        el.isConnected = false;
        if (els.get(el.id) === el) els.delete(el.id);
      },
      querySelector: () => null,
      querySelectorAll: () => ({ forEach() {} }),
    };
    els.set(id, el);
    return el;
  }

  // Every tag carrying an id becomes a stub element; data-* attributes and
  // class/src come along so the launch code's reads see what it wrote.
  function register(html) {
    const tagRe = /<([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
    let m;
    while ((m = tagRe.exec(html)) !== null) {
      const [, tagName, attrs] = m;
      const idM = /\bid="([^"]+)"/.exec(attrs);
      if (!idM) continue;
      const dataset = {};
      const dataRe = /\bdata-([a-zA-Z-]+)="([^"]*)"/g;
      let d;
      while ((d = dataRe.exec(attrs)) !== null) {
        dataset[d[1].replace(/-([a-z])/g, (_x, c) => c.toUpperCase())] = d[2];
      }
      const classM = /\bclass="([^"]*)"/.exec(attrs);
      const srcM = /\bsrc="([^"]*)"/.exec(attrs);
      mkEl(idM[1], {
        tagName,
        dataset,
        class: classM ? classM[1] : '',
        src: srcM ? srcM[1] : undefined,
      });
    }
  }

  // The shell elements that exist in index.html before any launch.
  ['app-content', 'app-view', 'home-screen', 'back-btn', 'app-viewer',
    'app-viewer-frame'].forEach((id) => mkEl(id));

  return {
    els,
    mkEl,
    document: {
      getElementById: (id) => els.get(id) || null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach() {} }),
      addEventListener() {},
      createElement: (tag) => mkEl(`created-${tag}-${els.size}`, { tagName: tag }),
      head: { appendChild() {} },
      body: { appendChild() {} },
    },
  };
}

const RUNNING = {
  slug: 'notes',
  name: 'Notes',
  status: 'running',
  url: 'https://notes.apps.example',
  icon_emoji: '📝',
};

function makeAppView({ fetchImpl, apps = [RUNNING], offline = false, reduceMotion = false } = {}) {
  const clock = makeClock();
  const dom = makeDom();
  const fetches = [];
  class FakeDate extends Date {
    static now() { return clock.now; }
  }
  const sandbox = {
    console,
    relTime: () => 'now',
    Date: FakeDate,
    App: {
      user: { id: 1 },
      currentApp: null,
      // The visibility seam (#1078). app-view.js no longer writes
      // `.hidden` onto a screen root directly — it publishes through
      // App._setScreenVisible, which either forwards to the React store (for
      // a root React owns) or does this classList toggle. Nothing in
      // app-view.js is React-owned yet, so the stub is the legacy branch.
      REACT_SCREEN_IDS: [],
      _setScreenVisible(id, visible) {
        dom.document.getElementById(id)?.classList.toggle('hidden', !visible);
      },
      _isScreenVisible(id) {
        const el = dom.document.getElementById(id);
        return !!el && !el.classList.contains('hidden');
      },
    },
    Home: {
      _apps: apps,
      iconTileFor(app) {
        if (app.icon_url) return { kind: 'image', html: '<img>' };
        if (app.icon_emoji) return { kind: 'emoji', html: `<span>${app.icon_emoji}</span>` };
        return { kind: 'letter', html: String(app.name || '?').charAt(0).toUpperCase() };
      },
    },
    Offline: { isOffline: () => offline },
    document: dom.document,
    fetch: (url, opts) => {
      fetches.push(String(url));
      return fetchImpl(String(url), opts);
    },
    resolveDevHost: (u) => u,
    matchMedia: () => ({ matches: reduceMotion }),
    location: { origin: 'https://platform.example', search: '', hash: '' },
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id),
    setInterval: () => 0,
    clearInterval: () => {},
    URL,
    URLSearchParams,
    AbortController,
    alert: () => {},
    addEventListener() {},
    localStorage: { getItem: () => null, setItem() {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  return { AppView, dom, clock, fetches, sandbox };
}

const okToken = (token = 'tok-1') => async (url) => {
  if (url.startsWith('/api/iframe-token')) {
    return { ok: true, json: async () => ({ token }) };
  }
  return { ok: true, json: async () => ({ app: { ...RUNNING } }) };
};

// A fetch whose token responses resolve only when the test says so.
function deferredToken() {
  const gates = [];
  const impl = (url) => {
    if (url.startsWith('/api/iframe-token')) {
      return new Promise((resolve) => {
        gates.push(() => resolve({ ok: true, json: async () => ({ token: 'tok-late' }) }));
      });
    }
    return Promise.resolve({ ok: true, json: async () => ({ app: { ...RUNNING } }) });
  };
  return { impl, release: () => gates.splice(0).forEach((g) => g()) };
}

const flush = () => new Promise((r) => setImmediate(r));

// ── 1. Single-flight, short-TTL mint ────────────────────────────────────

test('overlapping mints for one app share a single fetch', async () => {
  const { AppView, fetches } = makeAppView({ fetchImpl: okToken() });
  const [a, b] = await Promise.all([
    AppView._mintToken('notes'),
    AppView._mintToken('notes'),
  ]);
  assert.equal(a, 'tok-1');
  assert.equal(b, 'tok-1', 'the second caller joins the first mint');
  assert.equal(fetches.filter((u) => u.startsWith('/api/iframe-token')).length, 1);
});

test('a mint inside the freshness window makes no request at all', async () => {
  const { AppView, fetches, clock } = makeAppView({ fetchImpl: okToken() });
  await AppView._mintToken('notes');
  clock.advance(30_000);
  assert.equal(await AppView._mintToken('notes'), 'tok-1');
  assert.equal(fetches.length, 1, 'served from the freshness cache');
  assert.equal(AppView.hasFreshToken('notes'), true);

  // …and expires, so a launch minutes later still gets a live token.
  clock.advance(31_000);
  assert.equal(AppView.hasFreshToken('notes'), false);
  await AppView._mintToken('notes');
  assert.equal(fetches.length, 2, 're-mints once the window lapses');
});

test('a different app always mints its own app-scoped token', async () => {
  const { AppView, fetches } = makeAppView({ fetchImpl: okToken() });
  await AppView._mintToken('notes');
  await AppView._mintToken('other');
  assert.equal(fetches.length, 2);
  assert.equal(AppView.hasFreshToken('notes'), false, 'only the newest slug is cached');
  assert.equal(AppView.hasFreshToken('other'), true);
});

test('_mintToken never touches the held iframeToken (prewarm must not repoint it)', async () => {
  const { AppView } = makeAppView({ fetchImpl: okToken() });
  AppView.iframeToken = 'open-app-token';
  AppView.iframeTokenSlug = 'currently-open';
  await AppView._mintToken('some-app-being-hovered');
  assert.equal(AppView.iframeToken, 'open-app-token');
  assert.equal(AppView.iframeTokenSlug, 'currently-open',
    'hovering another app must not steal the open app’s token binding');
});

test('a failed mint clears both token fields and does not poison the next attempt', async () => {
  let ok = false;
  const { AppView, fetches } = makeAppView({
    fetchImpl: async (url) => (url.startsWith('/api/iframe-token')
      ? { ok, json: async () => ({ token: 'tok-2' }) }
      : { ok: true, json: async () => ({ app: { ...RUNNING } }) }),
  });
  AppView.iframeToken = 'stale';
  AppView.iframeTokenSlug = 'notes';
  await AppView.refreshToken('notes');
  assert.equal(AppView.iframeToken, null, 'a rejected mint drops the stale token');
  assert.equal(AppView.iframeTokenSlug, null);
  assert.equal(AppView.hasFreshToken('notes'), false, 'nothing cached on failure');

  ok = true;
  await AppView.refreshToken('notes');
  assert.equal(fetches.length, 2, 'the failure did not leave an in-flight entry behind');
  assert.equal(AppView.iframeToken, 'tok-2');
  assert.equal(AppView.iframeTokenSlug, 'notes');
});

// ── 1b. The Home lookup ─────────────────────────────────────────────────

// The vm harness sets `sandbox.window = sandbox`, so `window.Home` resolves
// in these tests even though it is undefined in a real browser: home.js's
// `const Home = {…}` is a classic-script top-level LEXICAL binding, not a
// window property (see App.resyncCurrentView, which documents the same
// trap). A launch path gated on `window.Home` therefore passes every unit
// test and is dead on the actual platform — hence a source guard.
test('the launch path reads Home as a bareword, not off window', () => {
  // The anti-pattern is a GUARD on window.Home (`window.Home && …`,
  // `window.Home ? …`); the last-resort fallback inside AppView._home is
  // fine, since the lexical read is tried first.
  assert.doesNotMatch(SRC, /window\.Home\s*(&&|\?)/,
    'window.Home is undefined in the browser — resolve Home lexically');
  assert.match(SRC, /typeof Home !== 'undefined'/, 'the lexical read is the primary path');
});

test('the cover falls back to a letter tile when Home is unavailable', () => {
  const { AppView, sandbox } = makeAppView({ fetchImpl: okToken() });
  delete sandbox.Home;
  const html = AppView._launchCoverHtml({ slug: 'notes', name: 'Notes' });
  assert.match(html, /data-icon="letter"/);
  assert.match(html, />\s*N\s*</, 'first letter of the app name');
});

// ── 2. beginLaunch preconditions ────────────────────────────────────────

test('beginLaunch only takes over when the App tab would be a plain app iframe', () => {
  const cases = [
    ['unknown app', { apps: [] }, undefined],
    ['not running', { apps: [{ ...RUNNING, status: 'creating' }] }, undefined],
    ['no url yet', { apps: [{ ...RUNNING, url: null }] }, undefined],
    ['self-hosted (defaults to the Dev tab)', { apps: [{ ...RUNNING, self_hosted: true }] }, undefined],
    ['staging demo tile', { apps: [{ ...RUNNING, demo: true }] }, undefined],
    ['offline', { offline: true }, undefined],
    ['explicit non-app tab', {}, 'dev'],
  ];
  for (const [label, opts, tab] of cases) {
    const { AppView, dom } = makeAppView({ fetchImpl: okToken(), ...opts });
    assert.equal(AppView.beginLaunch('notes', tab), false, `${label}: declines`);
    assert.equal(dom.els.get('app-content').htmlWrites, 0, `${label}: leaves #app-content alone`);
    assert.equal(dom.els.get('app-iframe'), undefined, `${label}: mounts no frame`);
  }
});

// ── 3. The launch surface ───────────────────────────────────────────────

test('beginLaunch mounts the app frame and its cover, and points it at the app in the same tick', async () => {
  const { AppView, dom } = makeAppView({ fetchImpl: okToken() });
  // Prewarm landed, so no await stands between the tap and the request.
  await AppView._mintToken('notes');

  assert.equal(AppView.beginLaunch('notes'), true);

  const iframe = dom.els.get('app-iframe');
  assert.ok(iframe, 'frame mounted');
  assert.equal(iframe.src, 'https://notes.apps.example/?token=tok-1',
    'src assigned synchronously, with the app-scoped token');
  assert.equal(iframe.style.opacity, undefined, 'not revealed yet (opacity comes from the markup)');
  assert.match(dom.els.get('app-content').innerHTML, /style="opacity:0"/,
    'the frame is mounted transparent so the cover can cross-fade it in');

  const cover = dom.els.get('app-launch-cover');
  assert.ok(cover, 'cover mounted over the frame');
  assert.equal(cover.dataset.pinned, undefined, 'a real launch is revealable');
  assert.match(dom.els.get('app-content').innerHTML, /data-icon="emoji"/,
    'cover shows the app’s own icon tile');
  assert.match(dom.els.get('app-content').innerHTML, /Notes/, 'and its name');
  assert.equal(dom.els.get('app-launch-cover-spinner').classList.contains('hidden'), true,
    'spinner is held back until the wait is long enough to need one');

  // Recorded so renderAppTab can prove the frame it finds is the frame it
  // would have built. (Compared field by field: the object comes from the
  // vm context, so it isn't deepStrictEqual to a host-realm literal.)
  assert.equal(AppView._launchAdopt.launchId, AppView._launchId);
  assert.equal(AppView._launchAdopt.slug, 'notes');
  assert.equal(AppView._launchAdopt.src, iframe.src);
});

test('without a warm token the frame mounts src-less and is pointed at the app once the mint settles', async () => {
  const { impl, release } = deferredToken();
  const { AppView, dom } = makeAppView({ fetchImpl: impl });

  assert.equal(AppView.beginLaunch('notes'), true);
  const iframe = dom.els.get('app-iframe');
  // src="" would resolve against the PARENT document and load the platform
  // shell inside its own app frame — the attribute must be absent.
  assert.equal(iframe.getAttribute('src'), null, 'no src attribute before the mint settles');
  assert.doesNotMatch(dom.els.get('app-content').innerHTML, /src="/, 'and none in the markup');
  assert.equal(AppView._launchAdopt, null, 'nothing to adopt yet');

  release();
  await flush();
  assert.equal(iframe.src, 'https://notes.apps.example/?token=tok-late');
  assert.equal(AppView._launchAdopt.src, iframe.src);
});

test('a launch superseded before its mint settles never touches the DOM', async () => {
  const { impl, release } = deferredToken();
  const { AppView, dom } = makeAppView({ fetchImpl: impl });
  AppView.beginLaunch('notes');
  const iframe = dom.els.get('app-iframe');
  AppView._teardownLaunch(); // e.g. the user hit Back

  release();
  await flush();
  assert.equal(iframe.getAttribute('src'), null, 'the stale launch did not load the app');
  assert.equal(AppView._launchAdopt, null);
});

// ── 4. The reveal ladder ────────────────────────────────────────────────

test('the cover cross-fades out when the frame loads', () => {
  const { AppView, dom, clock } = makeAppView({ fetchImpl: okToken() });
  AppView._tokenFresh = { slug: 'notes', token: 'tok-1', at: 0 };
  AppView.beginLaunch('notes');
  const iframe = dom.els.get('app-iframe');
  const cover = dom.els.get('app-launch-cover');

  iframe.onload();
  assert.equal(iframe.style.opacity, '1', 'app faded in');
  assert.equal(cover.classList.contains('app-launch-cover--out'), true, 'cover faded out');
  assert.equal(AppView.iframeFocused, true, 'same focus bookkeeping the old render did');
  assert.equal(cover.isConnected, true, 'still in the DOM for the length of the fade');

  clock.advance(AppView.LAUNCH_FADE_MS + 40);
  assert.equal(cover.isConnected, false, 'and removed once the fade finishes');
});

test('an errored frame is revealed too — the app renders its own error page', () => {
  const { AppView, dom } = makeAppView({ fetchImpl: okToken() });
  AppView._tokenFresh = { slug: 'notes', token: 'tok-1', at: 0 };
  AppView.beginLaunch('notes');
  dom.els.get('app-iframe').onerror();
  assert.equal(dom.els.get('app-iframe').style.opacity, '1');
  assert.equal(dom.els.get('app-launch-cover').classList.contains('app-launch-cover--out'), true);
});

test('the ladder adds a spinner at 500ms, reveals at 2s, and explains itself at 20s', () => {
  const { impl } = deferredToken(); // mint never settles: no src, no load event
  const { AppView, dom, clock } = makeAppView({ fetchImpl: impl });
  AppView.beginLaunch('notes');
  const cover = dom.els.get('app-launch-cover');
  const spinner = dom.els.get('app-launch-cover-spinner');

  clock.advance(499);
  assert.equal(spinner.classList.contains('hidden'), true, 'no spinner for a fast launch');
  clock.advance(2);
  assert.equal(spinner.classList.contains('hidden'), false, 'spinner once the wait is noticeable');

  clock.advance(1600);
  assert.equal(cover.classList.contains('app-launch-cover--out'), false,
    'the 2s cap must NOT strip the cover off a frame with no src — that is the blank window');
  assert.equal(cover.isConnected, true);

  clock.advance(20_000);
  assert.match(cover.textContent + dom.els.get('app-launch-cover-note').textContent,
    /taking longer than expected/, 'the wait is acknowledged rather than left silent');
});

test('the 2s cap reveals a frame that is loading but has not fired load', () => {
  const { AppView, dom, clock } = makeAppView({ fetchImpl: okToken() });
  AppView._tokenFresh = { slug: 'notes', token: 'tok-1', at: 0 };
  AppView.beginLaunch('notes');
  const cover = dom.els.get('app-launch-cover');
  clock.advance(1999);
  assert.equal(cover.classList.contains('app-launch-cover--out'), false);
  clock.advance(2);
  assert.equal(cover.classList.contains('app-launch-cover--out'), true, 'revealed at the cap');
});

test('a superseded launch’s load event and timers are inert', () => {
  const { AppView, dom, clock } = makeAppView({ fetchImpl: okToken() });
  AppView._tokenFresh = { slug: 'notes', token: 'tok-1', at: 0 };
  AppView.beginLaunch('notes');
  const iframe = dom.els.get('app-iframe');
  const cover = dom.els.get('app-launch-cover');

  AppView._launchId += 1; // a newer navigation took over

  iframe.onload();
  assert.notEqual(iframe.style.opacity, '1', 'stale load did not reveal');
  assert.equal(cover.classList.contains('app-launch-cover--out'), false);
  clock.advance(30_000);
  assert.equal(cover.isConnected, true, 'stale timers did nothing either');
});

test('reduced motion swaps the cross-fade for an instant swap', () => {
  const { AppView, dom } = makeAppView({ fetchImpl: okToken(), reduceMotion: true });
  AppView._tokenFresh = { slug: 'notes', token: 'tok-1', at: 0 };
  AppView.beginLaunch('notes');
  dom.els.get('app-iframe').onload();
  assert.equal(dom.els.get('app-launch-cover'), undefined, 'cover removed outright, no fade');
});

// ── 5. One-shot adoption in renderAppTab ────────────────────────────────

function launchThenRender(overrides = {}) {
  const { AppView, dom, clock, fetches } = makeAppView({ fetchImpl: okToken() });
  AppView._tokenFresh = { slug: 'notes', token: 'tok-1', at: 0 };
  AppView.beginLaunch('notes');
  const content = dom.els.get('app-content');
  const writesAfterLaunch = content.htmlWrites;
  AppView.appData = { ...RUNNING, ...overrides };
  return { AppView, dom, clock, fetches, content, writesAfterLaunch };
}

test('the first App-tab render adopts the launched frame instead of reloading it', () => {
  const { AppView, dom, content, writesAfterLaunch } = launchThenRender();
  const iframe = dom.els.get('app-iframe');
  const srcBefore = iframe.src;

  AppView.renderAppTab();

  assert.equal(content.htmlWrites, writesAfterLaunch, '#app-content untouched');
  assert.equal(dom.els.get('app-iframe'), iframe, 'same frame element');
  assert.equal(iframe.src, srcBefore, 'and the document load was not restarted');
});

test('every later render rebuilds, so status flips and token refreshes still work', () => {
  const { AppView, content, writesAfterLaunch } = launchThenRender();
  AppView.renderAppTab();
  AppView.renderAppTab();
  assert.equal(content.htmlWrites, writesAfterLaunch + 1, 'the adoption offer is one-shot');
});

test('a render for a different app rebuilds rather than adopting', () => {
  const { AppView, content, writesAfterLaunch } = launchThenRender({ slug: 'other', url: 'https://other.example' });
  AppView.renderAppTab();
  assert.equal(content.htmlWrites, writesAfterLaunch + 1);
});

test('a render whose src differs (deep link) rebuilds rather than adopting', () => {
  const { AppView, dom, content, writesAfterLaunch } = launchThenRender();
  AppView.pendingInnerPath = '/t/123';
  AppView.renderAppTab();
  assert.equal(content.htmlWrites, writesAfterLaunch + 1, 'rebuilt');
  assert.match(dom.els.get('app-iframe').src, /\/t\/123\?token=tok-1$/, 'at the deep-linked path');
});

test('the rebuilt frame keeps the sandbox/allow contract in one place', () => {
  const { AppView, content } = launchThenRender();
  AppView.renderAppTab();
  AppView.renderAppTab();
  assert.match(content.innerHTML,
    /sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-pointer-lock"/);
  assert.match(content.innerHTML, /allow="clipboard-write; pointer-lock"/);
});

test('a non-running render retires the launch generation', () => {
  const { AppView } = launchThenRender({ status: 'error' });
  const before = AppView._launchId;
  AppView.renderAppTab();
  assert.ok(AppView._launchId > before, 'pending launch callbacks go inert');
  assert.equal(AppView._launchAdopt, null);
});

// ── 6. AppView.open parallelization ─────────────────────────────────────

test('open mints the token alongside the detail fetch instead of after it', async () => {
  let detailResolve;
  const { AppView, fetches } = makeAppView({
    fetchImpl: (url) => {
      if (url.startsWith('/api/iframe-token')) {
        return Promise.resolve({ ok: true, json: async () => ({ token: 'tok-1' }) });
      }
      return new Promise((r) => { detailResolve = () => r({ ok: true, json: async () => ({ app: { ...RUNNING } }) }); });
    },
  });
  ['startActivityTracking', 'startTokenRefresh', 'refreshVersionPill', 'renderForkBadge']
    .forEach((m) => { AppView[m] = () => {}; });

  const p = AppView.open('notes');
  await flush();
  assert.equal(fetches.length, 2, 'both requests are in flight before either resolves');
  assert.ok(fetches.some((u) => u.startsWith('/api/iframe-token')));
  assert.ok(fetches.some((u) => u === '/api/apps/notes'));

  detailResolve();
  await p;
  assert.equal(AppView.iframeToken, 'tok-1');
  assert.equal(AppView.appData.slug, 'notes');
});

test('open tears the launch down when the server will not confirm the app', async () => {
  const { AppView, dom } = makeAppView({
    fetchImpl: async (url) => (url.startsWith('/api/iframe-token')
      ? { ok: true, json: async () => ({ token: 'tok-1' }) }
      : { ok: false, json: async () => ({}) }),
  });
  // A launch is already mounted off the cached list record.
  AppView._tokenFresh = { slug: 'notes', token: 'tok-1', at: 0 };
  AppView.beginLaunch('notes');
  const cover = dom.els.get('app-launch-cover');
  const launchIdBefore = AppView._launchId;

  await AppView.open('notes');

  assert.equal(AppView.appData, null,
    'the stub record is dropped so switchTab lands on "App not available"');
  assert.ok(AppView._launchId > launchIdBefore, 'launch retired');
  assert.equal(AppView._launchAdopt, null);
  // The cover is left standing until renderAppTab replaces #app-content —
  // what matters is that nothing will reveal an orphan frame under it.
  dom.els.get('app-iframe').onload();
  assert.equal(cover.classList.contains('app-launch-cover--out'), false);
});

// ── 7. Screenshot state ─────────────────────────────────────────────────

test('?shot=app-launching paints a pinned cover with no app behind it', () => {
  const { AppView, dom, clock } = makeAppView({ fetchImpl: okToken() });
  AppView.showLaunchCoverShot();

  const cover = dom.els.get('app-launch-cover');
  assert.ok(cover, 'cover painted');
  assert.equal(cover.dataset.pinned, 'true', 'pinned — nothing may reveal it away');
  assert.equal(dom.els.get('app-iframe'), undefined, 'no frame, so no real origin is loaded');
  assert.equal(dom.els.get('app-launch-cover-spinner').classList.contains('hidden'), false,
    'spinner visible: the shot is the loading state');
  assert.equal(dom.els.get('app-view').classList.contains('hidden'), false);
  assert.equal(dom.els.get('home-screen').classList.contains('hidden'), true);
  assert.match(dom.els.get('app-content').innerHTML, /app-icon-tile/, 'real icon tile');

  // Pinned means the reveal path is a no-op even if something calls it.
  AppView._revealLaunch();
  clock.advance(1000);
  assert.equal(cover.isConnected, true);
});

test('?shot=app-launching still renders against an empty database', () => {
  const { AppView, dom } = makeAppView({ fetchImpl: okToken(), apps: [] });
  AppView.showLaunchCoverShot();
  assert.match(dom.els.get('app-content').innerHTML, /Staging demo app/,
    'falls back to a self-contained stub record');
  assert.match(dom.els.get('app-content').innerHTML, /Opening…/, 'and the dapp.json check’s text');
});

// ── 8. The anonymous landing viewer ─────────────────────────────────────

test('mountViewerCover covers the landing viewer’s long-lived frame without replacing it', () => {
  const { AppView, dom, clock } = makeAppView({ fetchImpl: okToken() });
  const host = dom.els.get('app-viewer');
  const frame = dom.els.get('app-viewer-frame');
  const timers = [];
  let current = true;

  AppView.mountViewerCover(host, frame, RUNNING, { timers, isCurrent: () => current });

  assert.equal(host.htmlWrites, 0, 'the frame element survives — appended, not re-rendered');
  assert.equal(frame.style.opacity, '0', 'frame starts transparent');
  const cover = dom.els.get('app-viewer-cover');
  assert.ok(cover, 'cover appended to the viewer host');

  frame._src = 'https://notes.apps.example';
  frame.onload();
  assert.equal(frame.style.opacity, '1');
  assert.equal(cover.classList.contains('app-launch-cover--out'), true);
  clock.advance(AppView.LAUNCH_FADE_MS + 40);
  assert.equal(cover.isConnected, false);
});

test('the landing viewer’s cover honours its own generation counter', () => {
  const { AppView, dom, clock } = makeAppView({ fetchImpl: okToken() });
  const frame = dom.els.get('app-viewer-frame');
  const timers = [];
  let current = true;
  AppView.mountViewerCover(dom.els.get('app-viewer'), frame, RUNNING, { timers, isCurrent: () => current });
  const cover = dom.els.get('app-viewer-cover');

  current = false; // viewer closed
  frame._src = 'https://notes.apps.example';
  frame.onload();
  assert.notEqual(frame.style.opacity, '1', 'a late load cannot repaint a closed viewer');
  clock.advance(30_000);
  assert.equal(cover.isConnected, true, 'and its ladder is inert');
});
