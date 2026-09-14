const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx } = require('./lib/render-tsx');
const { createBrowserScroll, allowsPageScroll, pageScroller, MOBILE_PAGE_QUERY } =
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
