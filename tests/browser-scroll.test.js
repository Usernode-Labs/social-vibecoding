const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx } = require('./lib/render-tsx');
const { createBrowserScroll, allowsPageScroll, pageScroller, strandedPan, MOBILE_PAGE_QUERY } =
  loadTsx('frontend/src/lib/browser-scroll.ts');

function fixture() {
  const elements = {};
  const add = (id, hidden = false) => {
    const el = { id, hidden, scrollTop: 0, dataset: {},
      classList: { contains: (name) => name === 'hidden' && el.hidden } };
    return (elements[id] = el);
  };
  const html = { scrollTop: 0, dataset: {}, classList: { contains: () => false } };
  const doc = { documentElement: html, scrollingElement: html, getElementById: (id) => elements[id] || null };
  const win = { navigator: {}, history: { scrollRestoration: 'auto' }, mobile: true, standalone: false, dispatchEvent() {},
    matchMedia(q) { return { matches: q === MOBILE_PAGE_QUERY ? win.mobile : win.standalone }; } };
  win.self = win.top = win;
  const controller = createBrowserScroll(doc, win);
  const scroll = (top) => { html.scrollTop = top; controller.onScroll({ target: doc }); };
  return { add, doc, win, html, controller, scroll };
}

test('mobile browser pages use the document; native, installed, desktop and embedded shells do not', () => {
  const { doc, win } = fixture();
  assert.equal(allowsPageScroll(win, doc), true);
  win.mobile = false;
  assert.equal(allowsPageScroll(win, doc), false);
  win.mobile = true;
  win.standalone = true;
  assert.equal(allowsPageScroll(win, doc), false);
  win.standalone = false;
  win.navigator.standalone = true;
  assert.equal(allowsPageScroll(win, doc), false);
  win.navigator.standalone = false;
  win.top = {};
  assert.equal(allowsPageScroll(win, doc), false);
  win.top = win;
  doc.documentElement.classList.contains = (name) => name === 'in-native-webview';
  assert.equal(allowsPageScroll(win, doc), false);
});

test('screen positions survive navigation even when hiding a page clamps document scroll', () => {
  const { add, doc, html, controller, scroll } = fixture();
  const home = add('home-screen');
  const browse = add('browse-screen', true);
  controller.sync();
  assert.equal(controller.scrollElement(home), html);
  scroll(640);
  home.hidden = true;
  browse.hidden = false;
  html.scrollTop = 0; // outgoing content is now display:none
  controller.onScroll({ target: doc });
  controller.sync();
  assert.equal(controller.scrollElement(browse), html);
  assert.equal(html.scrollTop, 0);
  scroll(120);
  browse.hidden = true;
  home.hidden = false;
  controller.sync();
  assert.equal(html.scrollTop, 640);
  assert.equal(controller.scrollElement(browse), browse, 'hidden screens never borrow the current page');
});

test('opening a guest app bounds its iframe and returning restores the directory', () => {
  const { add, html, controller, scroll } = fixture();
  add('auth-landing-screen');
  const landing = add('auth-landing-scroll');
  controller.sync();
  scroll(720);
  landing.hidden = true;
  controller.sync();
  assert.equal(html.dataset.browserScroller, undefined);
  assert.equal(html.scrollTop, 0);
  landing.hidden = false;
  controller.sync();
  assert.equal(html.dataset.browserScroller, 'auth-landing-scroll');
  assert.equal(html.scrollTop, 720);
});

test('an anonymous page takes precedence over the cached signed-in screen', () => {
  const { add, doc } = fixture();
  add('home-screen');
  add('auth-landing-screen');
  const landing = add('auth-landing-scroll');
  assert.equal(pageScroller(doc, 'home-screen'), landing);
});

test('the router wins over a still-visible outgoing app during zoom-out', () => {
  const { add, doc } = fixture();
  add('home-screen');
  add('app-view').dataset.appSurface = 'app';
  assert.equal(pageScroller(doc), null);
  assert.equal(pageScroller(doc, 'home-screen').id, 'home-screen');
});

test('Dev feeds scroll the page; parked feeds inside an app or chat do not', () => {
  const { add, doc } = fixture();
  const app = add('app-view');
  const content = add('app-content');
  const feed = add('dev-forum-scroll');
  app.dataset.appSurface = 'platform';
  assert.equal(pageScroller(doc), feed);
  app.dataset.appSurface = 'app';
  assert.equal(pageScroller(doc), null);
  app.dataset.appSurface = 'platform';
  content.hidden = true;
  assert.equal(pageScroller(doc), null);
  content.hidden = false;
  feed.hidden = true;
  assert.equal(pageScroller(doc), null);
});

test('resizing transfers the position between the document and the bounded screen', () => {
  const { add, doc, win, html, controller, scroll } = fixture();
  const home = add('home-screen');
  controller.sync();
  assert.equal(win.history.scrollRestoration, 'manual');
  scroll(320);
  win.mobile = false;
  controller.sync();
  assert.equal(win.history.scrollRestoration, 'auto');
  assert.equal(home.scrollTop, 320);
  assert.equal(controller.scrollElement(home), home);
  home.scrollTop = 160;
  controller.onScroll({ target: home });
  win.mobile = true;
  controller.sync();
  assert.equal(controller.scrollElement(home), doc.scrollingElement);
  assert.equal(html.scrollTop, 160);
});

// ── #2771: a pan the installed app was left with ─────────────────────

function installed() {
  const f = fixture();
  let kb = false;
  f.html.clientHeight = 844;
  f.html.classList.contains = (name) => name === 'un-kb' && kb;
  f.win.standalone = true; // display-mode: standalone — the bounded shell
  f.win.innerHeight = 844;
  f.win.visualViewport = { scale: 1, height: 844 };
  f.win.scrollY = 0;
  f.win.scrollTo = (x, y) => { f.win.scrollY = y; };
  f.setKeyboard = (on) => { kb = on; f.win.visualViewport.height = on ? 500 : 844; };
  return f;
}

test('an installed app puts a stranded document pan back once the keyboard is gone', () => {
  const { add, doc, win, html, controller, setKeyboard } = installed();
  add('home-screen');
  controller.sync();
  assert.equal(html.dataset.browserScroller, undefined, 'installed apps keep the bounded shell');

  // Keyboard up: iOS pans the document to reveal the field. Leave it be.
  setKeyboard(true);
  html.scrollTop = 300;
  controller.onScroll({ target: doc });
  assert.equal(html.scrollTop, 300, 'a pan while the keyboard is up is the browser doing its job');

  // Keyboard down, pan left behind: the tab bar is off the bottom edge.
  setKeyboard(false);
  controller.settle();
  assert.equal(html.scrollTop, 0);
  assert.equal(win.scrollY, 0);

  // Any later stray pan is undone on the scroll that makes it.
  html.scrollTop = 40;
  controller.onScroll({ target: doc });
  assert.equal(html.scrollTop, 0);
});

test('the pan reset never touches a paging document, a zoom, a desktop or a frame', () => {
  const { add, doc, win, html, controller, scroll } = fixture();
  add('home-screen');
  controller.sync();
  assert.equal(html.dataset.browserScroller, 'home-screen');
  scroll(500);
  controller.settle();
  assert.equal(html.scrollTop, 500, 'a mobile browser tab pages the document on purpose');

  const f = installed();
  assert.equal(strandedPan(f.win, f.doc, 120), true);
  assert.equal(strandedPan(f.win, f.doc, 0), false);
  f.win.visualViewport.scale = 2;
  assert.equal(strandedPan(f.win, f.doc, 120), false, 'pinch zoom pans on purpose');
  f.win.visualViewport.scale = 1;
  f.win.mobile = false;
  assert.equal(strandedPan(f.win, f.doc, 120), false, 'desktop is out of scope');
  f.win.mobile = true;
  f.win.top = {};
  assert.equal(strandedPan(f.win, f.doc, 120), false, 'an embedded shell is its parent\'s business');
  f.win.top = f.win;
  f.setKeyboard(true);
  assert.equal(strandedPan(f.win, f.doc, 120), false);
  void doc; void win;
});
