'use strict';

// #6016 (item 2): the links in a dev chat open the right thing, clicked.
//
// #5944 (#5693) fixed a dev chat opened from Messages, where the proposal
// badge, "Already proposed", "Open proposal card" and a request chip did
// nothing: they called `AppView.openTopic`, which drew the page into the
// app screen that is hidden behind the Messages pane. The tests that guarded
// it read source text or called one function by hand, so a click that
// reached a different handler, or none, still passed.
//
// This suite runs the real code from the click to the place it lands:
//
//   - frontend/src/features/dev-chat/dev-chat.js, with public/js/app-view.js
//     (its real `openTopic`), public/js/merge-status.js and
//     public/js/nav-link.js (the shell's document-wide link listener), in a
//     vm, publishing its view models;
//   - the real transcript and session-header components rendering those
//     models. The JSX runtime is wrapped so every element with an `onClick`
//     is kept, and pressing a button calls the handler React would call. The
//     control is found by what the markup shows (`data-open-vote`,
//     `data-issue-chip`, `#dc-pr-header-link`, the "Already proposed" label);
//   - an agent's reply through the real `renderMarkdown` (a real `marked`)
//     and the transcript's real `linkRefsInHtml`. Its anchors are clicked in
//     a small DOM: the rendered transcript is parsed into `#dc-messages`, a
//     click event goes through nav-link's capture listener and the dev
//     chat's own delegated listener (`initScrollTracking`), and if none of
//     them prevents it the browser's default runs: a same-page `#…` href
//     becomes the hash, a `target="_blank"` one opens a new tab;
//   - where it lands, through the real router (public/js/app.js). From
//     Messages the hash goes through `App.restoreFromHash`. On the project
//     page `AppView.openTopic` runs for real, and `App.switchTab`, one level
//     below it, is the recorded boundary: it is app.js's screen swap, which
//     needs the whole shell. What it was handed is turned into an address
//     by the router's own serializer, `App._appUrl`. Both places must land
//     on the same canonical address.
//
// Run with: node --test tests/dev-chat-links.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Marked } = require('marked');

const { englishPlatformI18n } = require('./lib/platform-i18n');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { makeHtmlDocument } = require('./lib/html-dom');
const { makeTranscriptBridge } = require('./lib/dev-transcript-html');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const DEV_CHAT_SRC = read('frontend/src/features/dev-chat/dev-chat.js');
const APP_VIEW_SRC = read('public/js/app-view.js');
const MERGE_STATUS_SRC = read('public/js/merge-status.js');
const NAV_LINK_SRC = read('public/js/nav-link.js');
const APP_SRC = read('public/js/app.js');

const SLUG = 'demo-app';
const ORIGIN = 'https://app.onhomeroom.test';

// ── Rendering that keeps the click handlers ─────────────────────────────
//
// renderToStaticMarkup drops event handlers, and there is no DOM here for
// React to attach them to. Every host element is built through the JSX
// runtime, so a wrapped runtime sees each one's props, handler included,
// while the markup is still React's own.

const fromFrontend = (spec) => require(require.resolve(spec, { paths: [path.join(ROOT, 'frontend')] }));
const clickable = [];
function recordingRuntime() {
  const real = fromFrontend('react/jsx-runtime');
  const wrap = (fn) => (type, props, key) => {
    if (typeof type === 'string' && props && typeof props.onClick === 'function') {
      clickable.push({ type, props });
    }
    return fn(type, props, key);
  };
  return { ...real, jsx: wrap(real.jsx), jsxs: wrap(real.jsxs) };
}
let api = null;
function components() {
  if (api) return api;
  const stubs = { 'react/jsx-runtime': recordingRuntime() };
  api = {
    transcript: loadTsx('tests/fixtures/dev-transcript-api.ts', { stubs }),
    header: loadTsx('tests/fixtures/dev-session-header-api.ts', { stubs }),
  };
  return api;
}

/** Render with the browser globals the components read, then restore them. */
function withBrowser(h, fn) {
  const prev = { window: globalThis.window, document: globalThis.document };
  // `controller()` is `window.DevChat`; `linkRefsInHtml` needs a document.
  globalThis.window = { DevChat: h.DevChat, App: h.sandbox.App };
  globalThis.document = makeHtmlDocument();
  try { return fn(); } finally {
    if (prev.window === undefined) delete globalThis.window; else globalThis.window = prev.window;
    if (prev.document === undefined) delete globalThis.document; else globalThis.document = prev.document;
  }
}

/** The transcript as rendered, and the controls in it a person can press. */
function renderTranscript(h) {
  const { transcript } = components();
  clickable.length = 0;
  const html = withBrowser(h, () => {
    transcript.transcriptStore.set(h.t.state());
    return renderToHtml(createElement(transcript.DevChatTranscript, {}));
  });
  return { html, controls: clickable.splice(0) };
}

function renderHeader(h) {
  const { header } = components();
  clickable.length = 0;
  const html = withBrowser(h, () => {
    header.sessionHeaderStore.set(JSON.parse(JSON.stringify(h.DevChat._sessionHeaderView())));
    return renderToHtml(createElement(header.SessionHeader, {}));
  });
  return { html, controls: clickable.splice(0) };
}

/** Press a rendered button, as React would on a click. */
function press(h, control) {
  assert.ok(control, 'the control is rendered with a click handler');
  assert.ok(!control.props.disabled, 'the control is not disabled');
  withBrowser(h, () => control.props.onClick({
    preventDefault() {}, stopPropagation() {}, currentTarget: null, target: null,
  }));
}

const textOf = (children) => [].concat(children ?? []).map((c) => (
  c && typeof c === 'object' ? textOf(c.props?.children) : String(c ?? '')
)).join('');

// ── A DOM just big enough to click an anchor ────────────────────────────
//
// tests/lib/html-dom.js parses the markup; this adds what a click needs:
// attributes read back, `matches`/`closest` for the selectors the listeners
// on the way use, listeners, and an anchor's resolved `href`.

function makeClickDom(pageHref) {
  const doc = makeHtmlDocument();
  const proto = Object.getPrototypeOf(doc.createElement('div'));
  const compound = (el, sel) => {
    const m = /^([a-zA-Z][\w-]*)?((?:\.[\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/.exec(sel);
    if (!m) throw new Error(`selector not supported by this shim: ${sel}`);
    if (!el || el.nodeType !== 1) return false;
    if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
    for (const part of m[2].match(/\.[\w-]+|\[[^\]]+\]/g) || []) {
      if (part[0] === '.') {
        if (!(el.getAttribute('class') || '').split(/\s+/).includes(part.slice(1))) return false;
      } else {
        const [, name, value] = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(part);
        const got = el.getAttribute(name);
        if (got == null || (value !== undefined && got !== value)) return false;
      }
    }
    return true;
  };
  const matchOne = (el, sel) => {
    const parts = sel.trim().split(/\s+/);
    if (!compound(el, parts.pop())) return false;
    let node = el.parentNode;
    while (parts.length && node) {
      if (compound(node, parts[parts.length - 1])) parts.pop();
      node = node.parentNode;
    }
    return parts.length === 0;
  };
  Object.assign(proto, {
    getAttribute(name) { const a = this.attrs.find((x) => x[0] === name); return a ? a[1] : null; },
    removeAttribute(name) { this.attrs = this.attrs.filter((x) => x[0] !== name); },
    matches(sel) { return sel.split(',').some((s) => matchOne(this, s)); },
    closest(sel) {
      for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (n.matches(sel)) return n;
      return null;
    },
    addEventListener(type, fn, opts) {
      (this.listeners || (this.listeners = [])).push({ type, fn, capture: opts === true || !!opts?.capture });
    },
    removeEventListener() {},
  });
  Object.defineProperty(proto, 'href', {
    get() { const v = this.getAttribute('href'); return v == null ? '' : new URL(v, pageHref).href; },
  });
  Object.defineProperty(proto, 'dataset', { get() { return {}; } });
  const docListeners = [];
  doc.addEventListener = (type, fn, opts) => docListeners.push({ type, fn, capture: opts === true || !!opts?.capture });
  doc.removeEventListener = () => {};

  /**
   * A primary click on `target`: capture from the document down, bubble
   * back up. Returns the event, so the default action can be decided.
   */
  doc.click = (target) => {
    const ancestors = [];
    for (let n = target; n && n.nodeType === 1; n = n.parentNode) ancestors.push(n);
    const event = {
      type: 'click', target, button: 0, defaultPrevented: false, stopped: false,
      metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; },
    };
    const run = (list, capture) => {
      for (const l of list || []) if (l.type === 'click' && l.capture === capture && !event.stopped) l.fn(event);
    };
    run(docListeners, true);
    for (const n of [...ancestors].reverse()) run(n.listeners, true);
    for (const n of ancestors) run(n.listeners, false);
    run(docListeners, false);
    return event;
  };
  return doc;
}

/** Find an element by its text, depth first. */
function findByText(node, tag, text) {
  for (const child of node.childNodes || []) {
    if (child.nodeType !== 1) continue;
    const own = child.childNodes.filter((c) => c.nodeType === 3).map((c) => c.nodeValue).join('');
    if (child.tagName === tag.toUpperCase() && own === text) return child;
    const deeper = findByText(child, tag, text);
    if (deeper) return deeper;
  }
  return null;
}

// ── The router: where a click lands ─────────────────────────────────────
//
// public/js/app.js in a context like tests/change-addresses.test.js's. Its
// screen-changing calls, `navigateToApp` and `switchTab`, are recorded: they
// open a project and swap screens, which needs the whole shell. What they
// are handed, and the address the router settles on, is what is asserted.

function loadRouter({ hash = '', currentApp = null } = {}) {
  const location = { origin: ORIGIN, href: `${ORIGIN}/${hash}`, pathname: '/', search: '', hash };
  const applyUrl = (value) => {
    const next = new URL(value, `${ORIGIN}${location.pathname}${location.search}${location.hash}`);
    Object.assign(location, { pathname: next.pathname, search: next.search, hash: next.hash, href: next.href });
  };
  const history = { state: null, pushState(_s, _t, v) { applyUrl(v); }, replaceState(_s, _t, v) { applyUrl(v); } };
  const element = {
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, removeAttribute() {}, appendChild() {},
  };
  const document = {
    visibilityState: 'visible', title: '', addEventListener() {},
    getElementById() { return element; }, querySelector() { return null; },
    createElement() { return { ...element }; }, head: element,
  };
  const AppView = {
    appData: null, pendingInnerPath: null,
    launchRecordFor() { return null; }, beginLaunch() { return true; },
    open() { return new Promise(() => {}); }, close() {},
    _getViewMode() { return 'workshop'; },
  };
  const window = { location, history, addEventListener() {}, AppView };
  vm.runInContext(APP_SRC, vm.createContext({
    window, document, location, history, AppView,
    PlatformUI: { transition(fn) { fn(); }, pullToRefresh() {} },
    URL, URLSearchParams, AbortController,
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    navigator: {}, console, setTimeout, clearTimeout, fetch: async () => ({ ok: false }),
  }));
  const App = window.App;
  const calls = [];
  App.currentApp = currentApp;
  App.currentTab = currentApp ? 'dev' : null;
  App.currentSubTab = currentApp ? 'forum' : null;
  App.navigateToApp = (...args) => { calls.push(['navigateToApp', ...JSON.parse(JSON.stringify(args))]); };
  App.switchTab = (...args) => { calls.push(['switchTab', ...JSON.parse(JSON.stringify(args))]); };
  return { App, location, calls };
}

/** The real router, given the hash a click set. */
function routeHash(hash, currentApp) {
  const r = loadRouter({ hash, currentApp });
  r.App.restoreFromHash();
  return { address: r.location.pathname, calls: r.calls };
}

/** The address the router serializes for a `switchTab` call. */
function addressOfSwitch([tab, ref, subTab]) {
  return loadRouter().App._appUrl(SLUG, tab, ref, subTab);
}

// ── The dev chat itself ─────────────────────────────────────────────────

function makeDevChat(context) {
  const t = makeTranscriptBridge();
  const pageHref = context === 'project' ? `${ORIGIN}/app/${SLUG}/dev/sessions/41` : `${ORIGIN}/#messages`;
  const dom = makeClickDom(pageHref);
  const host = dom.createElement('div');
  host.setAttribute('id', 'dc-messages');
  Object.assign(host, { scrollTop: 0, scrollHeight: 0, clientHeight: 0 });
  const opened = [];
  const switched = [];
  const sandbox = {
    console, URLSearchParams, URL,
    location: { search: '', hash: '', href: pageHref, origin: ORIGIN },
    App: {
      user: { id: 1, username: 'ada' },
      currentApp: context === 'project' ? SLUG : null,
      // One level below `AppView.openTopic`: the shell's screen swap.
      switchTab: (...args) => { switched.push(JSON.parse(JSON.stringify(args))); },
    },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    dispatchEvent() {},
    escapeHtml: (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    document: {
      getElementById: (id) => (id === 'dc-messages' ? host : null),
      querySelector: () => null,
      querySelectorAll: () => ({ forEach() {} }),
      addEventListener: (...a) => dom.addEventListener(...a),
      removeEventListener() {},
      createElement: () => ({
        style: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {},
        setAttribute() {}, removeAttribute() {}, querySelector: () => null,
        querySelectorAll: () => ({ forEach() {} }), appendChild() {}, innerHTML: '', textContent: '',
      }),
      body: { appendChild() {}, addEventListener() {} },
    },
    MutationObserver: class { observe() {} disconnect() {} },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert() {},
    // The browser's default for a `target="_blank"` anchor, and window.open.
    open: (url, target) => { opened.push({ url, target }); return null; },
    PlatformUI: {
      isTouch: () => false, hasKit: () => false, toast() {}, alert: async () => ({}),
      confirm: async () => true, transition: (fn) => fn(), attachScreenFx() {}, detachScreenFx() {},
      pullToRefresh: () => ({ detach() {} }), swipeActions: () => ({ detach() {} }), gestures: () => null,
    },
    navigator: { sendBeacon() {} },
    requestAnimationFrame: () => 0,
    setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  // The reply is rendered by the real `marked`; DOMPurify is a pass-through,
  // because the anchors under test are the ones marked and the ref chips
  // write, not what the sanitizer strips.
  const md = new Marked();
  sandbox.marked = { use: (...a) => md.use(...a), parse: (...a) => md.parse(...a) };
  sandbox.DOMPurify = { addHook() {}, sanitize: (html) => html };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  sandbox.UsernodeReact = { devChat: { ...t.bridge, mountSessionHeader() {}, publishSessionHeader() {} } };
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(NAV_LINK_SRC, sandbox);
  vm.runInContext(`${MERGE_STATUS_SRC}\n${APP_VIEW_SRC}\n;globalThis.AppView = AppView;`, sandbox);
  sandbox.AppView._renderTopicHead = () => {};
  sandbox.AppView._loadDevData = async () => {};
  vm.runInContext(`${DEV_CHAT_SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  const DevChat = sandbox.__DevChat;
  return {
    DevChat, sandbox, t, dom, host, opened, switched,
    render(messages, session) {
      DevChat.messages = messages;
      DevChat.currentSession = session;
      // On the project page the board is loaded, and openTopic reads the
      // change's pull request number off it.
      if (context === 'project') {
        sandbox.AppView.appData = { slug: SLUG };
        sandbox.AppView._proposals = [session];
      }
      DevChat.renderMessages();
    },
    /** Click an anchor in the rendered transcript, default action included. */
    clickAnchor(html, text) {
      host.innerHTML = html;
      DevChat.initScrollTracking();
      const anchor = findByText(host, 'a', text);
      assert.ok(anchor, `"${text}" is a link in the reply`);
      const event = dom.click(anchor);
      if (event.defaultPrevented) return;
      const href = anchor.getAttribute('href');
      if (anchor.getAttribute('target') === '_blank') sandbox.open(anchor.href, '_blank');
      else if (href && href.startsWith('#')) sandbox.location.hash = href;
      else sandbox.location.href = anchor.href;
    },
  };
}

const CHANGES = { role: 'system', content: 'Staging deployed!', changesReady: true,
  stagingUrl: 'https://preview.example.org', _slug: 'links001' };
const session = (over) => ({
  id: 41, app_slug: SLUG, status: 'promoted', check_state: 'passing',
  session_title: 'Tidy the board (closes #12)', branch_name: 'dev/ada-1',
  pr_number: 90, pr_url: null, ...over,
});

// Where each context lands for a control that opens a board topic.
const CONTEXTS = [
  {
    name: 'a dev chat opened from Messages',
    context: 'messages',
    // No app view is up: the page's address is followed, and the router
    // opens the project on that topic.
    lands(h, address) {
      assert.deepEqual(h.switched, [], 'nothing is drawn into the hidden app screen');
      assert.match(h.sandbox.location.hash, /^#app\//, 'the click set the page\'s address');
      const routed = routeHash(h.sandbox.location.hash, null);
      assert.equal(routed.calls.length, 1, 'the router acts on it once');
      assert.equal(routed.calls[0][0], 'navigateToApp', 'it opens the project');
      assert.equal(routed.calls[0][1], SLUG);
      assert.equal(routed.calls[0][4], 'topic', 'on the topic');
      assert.equal(routed.address, address, `and settles on ${address}`);
    },
  },
  {
    name: 'a dev chat opened from the project page',
    context: 'project',
    // The app view is up: openTopic swaps the screen in place.
    lands(h, address) {
      assert.equal(h.sandbox.location.hash, '', 'the address is left to the app view');
      assert.equal(h.switched.length, 1, 'the app view switches screens once');
      assert.equal(h.switched[0][0], 'dev');
      assert.equal(h.switched[0][2], 'topic', 'to the topic');
      assert.equal(addressOfSwitch(h.switched[0]), address, `whose address is ${address}`);
    },
  },
];

for (const c of CONTEXTS) {
  test(`${c.name}: the proposal's status badge opens the proposal`, () => {
    const h = makeDevChat(c.context);
    h.render([CHANGES], session());
    const { html, controls } = renderTranscript(h);
    assert.match(html, /<button[^>]*data-open-vote="41"/, 'the badge is a control naming the proposal');
    press(h, controls.find((x) => x.props['data-open-vote'] === 41));
    c.lands(h, `/app/${SLUG}/dev/changes/90`);
  });

  test(`${c.name}: before a pull request, the badge opens the proposal by its id`, () => {
    const h = makeDevChat(c.context);
    h.render([CHANGES], session({ pr_number: null }));
    const { controls } = renderTranscript(h);
    press(h, controls.find((x) => x.props['data-open-vote'] === 41));
    c.lands(h, `/app/${SLUG}/dev/proposals/41`);
  });

  test(`${c.name}: "Already proposed" opens the proposal`, () => {
    const h = makeDevChat(c.context);
    h.render([CHANGES], session());
    const { html, controls } = renderTranscript(h);
    assert.match(html, />Already proposed</);
    press(h, controls.find((x) => /dc-pr-btn-promote/.test(x.props.className || '')
      && /Already proposed/.test(textOf(x.props.children))));
    c.lands(h, `/app/${SLUG}/dev/changes/90`);
  });

  test(`${c.name}: "Open proposal card" in the header opens the proposal`, () => {
    const h = makeDevChat(c.context);
    h.render([], session());
    const { html, controls } = renderHeader(h);
    assert.match(html, /id="dc-pr-header-link"[^>]*>Open proposal card</);
    press(h, controls.find((x) => x.props.id === 'dc-pr-header-link'));
    c.lands(h, `/app/${SLUG}/dev/changes/90`);
  });

  test(`${c.name}: a request chip opens the request`, () => {
    const h = makeDevChat(c.context);
    h.render([CHANGES], session({ status: 'active' }));
    const { html, controls } = renderTranscript(h);
    assert.match(html, /<button[^>]*data-issue-chip="12"[^>]*>Closes #12</);
    press(h, controls.find((x) => x.props['data-issue-chip'] === 12));
    c.lands(h, `/app/${SLUG}/dev/issues/12`);
  });

  // An agent's reply. Its PR#N and #N are in-page addresses: clicking one
  // sets the hash in both places, and the router then opens the project on
  // it (Messages) or swaps to it in place (the project page is already up).
  // A commit lives on the git host: it opens in a new tab.
  const reply = (h) => {
    const commit = `https://git.onhomeroom.com/apps/${SLUG}/commit/abc1234`;
    h.render([
      { role: 'user', content: 'What changed?' },
      { role: 'assistant', content: `Filed as PR#9 beside #14, in commit ${commit}.` },
    ], session({ status: 'active', pr_number: null }));
    return { commit, html: renderTranscript(h).html };
  };
  const refCases = [
    { text: 'PR#9', address: `/app/${SLUG}/dev/changes/9` },
    { text: '#14', address: `/app/${SLUG}/dev/issues/14` },
  ];
  for (const ref of refCases) {
    test(`${c.name}: clicking ${ref.text} in an agent's reply opens it`, () => {
      const h = makeDevChat(c.context);
      const { html } = reply(h);
      h.clickAnchor(html, ref.text);
      assert.deepEqual(h.opened, [], 'it stays in Homeroom');
      const routed = routeHash(h.sandbox.location.hash, c.context === 'project' ? SLUG : null);
      assert.equal(routed.calls.length, 1, 'the router acts on the new hash once');
      assert.equal(routed.calls[0][0], c.context === 'project' ? 'switchTab' : 'navigateToApp',
        c.context === 'project' ? 'the project page swaps to it in place' : 'the project opens on it');
      assert.equal(routed.address, ref.address);
    });
  }

  test(`${c.name}: clicking a commit address in an agent's reply opens it in a new tab`, () => {
    const h = makeDevChat(c.context);
    const { commit, html } = reply(h);
    h.clickAnchor(html, commit);
    assert.deepEqual(h.opened, [{ url: commit, target: '_blank' }], 'the commit opens on the git host, in a new tab');
    assert.equal(h.sandbox.location.hash, '', 'the page itself does not move');
    assert.equal(findByText(h.host, 'a', commit).getAttribute('rel'), 'noopener noreferrer');

    // Inside the Homeroom phone app a new tab cannot open; nav-link hands
    // the address to the system browser instead.
    const native = makeDevChat(c.context);
    const external = [];
    native.sandbox.usernode = { isNative: true, openExternal: async (url) => { external.push(url); } };
    const again = reply(native);
    native.clickAnchor(again.html, again.commit);
    assert.deepEqual(external, [commit], 'the phone app opens it in the system browser');
    assert.deepEqual(native.opened, [], 'and not as a second, dead tab');
  });
}
