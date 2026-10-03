'use strict';

// The bridge's own QR transaction card follows the viewer's Homeroom theme
// (follow-up to #3688).
//
// The card is the one piece of UI the hosted bridge draws itself: a desktop
// browser with no wallet to relay to gets a "scan this with the mobile app"
// overlay from sendTransaction. Its light/dark look came from a
// `prefers-color-scheme` media query, and inside the platform frame that
// follows the OS, not the shell (#3257): a viewer who picked Dark on a
// light-mode OS got a white card over a dark app. It now reads
// `usernode.theme`, follows `usernode:theme-changed` while open, and falls
// back to the OS only when no platform theme is known.
//
// Like tests/new-app-theme.test.js, this runs the real bridge blocks (the
// QR modal, then the theme block) in a vm against a stub window and
// document, rather than pinning source text.
//
// Run with: node --test tests/bridge-qr-theme.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const BRIDGE = read('public/usernode-bridge/v1/bridge.js');
function block(name) {
  const begin = `/* __USERNODE_${name}_BEGIN__ */`;
  const end = `/* __USERNODE_${name}_END__ */`;
  assert.ok(BRIDGE.includes(begin) && BRIDGE.includes(end), `the ${name} block is delimited`);
  return BRIDGE.slice(BRIDGE.indexOf(begin), BRIDGE.indexOf(end));
}
const QR_MODAL = block('QR_MODAL');
const THEME = block('THEME');

function element(tagName) {
  return {
    tagName: tagName.toUpperCase(),
    id: '',
    className: '',
    textContent: '',
    style: {},
    attributes: {},
    children: [],
    parentNode: null,
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; },
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    removeChild(child) {
      this.children = this.children.filter((c) => c !== child);
      child.parentNode = null;
      return child;
    },
  };
}

function find(node, id) {
  if (node.id === id) return node;
  for (const child of node.children) {
    const hit = find(child, id);
    if (hit) return hit;
  }
  return null;
}

// A page in a vm: the real QR modal block and theme block, in bridge order,
// against a stub window and document. `framed` puts it in the shell's frame.
function runBridge({ search = '', osLight = false, framed = true } = {}) {
  const listeners = {};
  const mediaListeners = [];
  const posted = [];
  // The look each card had when it was attached: it must never paint in the
  // wrong one first.
  const attached = [];
  const media = {
    matches: osLight,
    addEventListener(type, fn) { if (type === 'change') mediaListeners.push(fn); },
  };
  const parent = { postMessage(msg) { posted.push(msg); } };
  const win = {
    location: { search },
    usernode: {},
    matchMedia(query) {
      assert.equal(query, '(prefers-color-scheme: light)');
      return media;
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatchEvent(ev) { (listeners[ev.type] || []).forEach((fn) => fn(ev)); return true; },
  };
  win.parent = framed ? parent : win;
  const head = element('head');
  const body = element('body');
  const append = body.appendChild;
  body.appendChild = function (child) {
    attached.push(child.getAttribute('data-un-theme'));
    return append.call(this, child);
  };
  const context = vm.createContext({
    window: win,
    document: {
      head,
      body,
      createElement: element,
      getElementById: (id) => find(head, id) || find(body, id),
    },
    // The encoder is not under test; the card only needs a canvas from it.
    QR: { encode: () => ({ size: 21, grid: [] }), toCanvas: () => element('canvas') },
    URLSearchParams,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    JSON,
    Math,
    Date,
    String,
  });
  vm.runInContext(QR_MODAL, context);
  vm.runInContext(THEME, context);
  const fromShell = (data) => (listeners.message || []).forEach((fn) => fn({ source: parent, data }));
  return {
    // sendTransaction's QR branch opens the card with this.
    open() { context.showQrModal({ type: 'tx', to: 'ut1dest', amount: 1, memo: '' }, {}); },
    close() { context.hideQrModal(); },
    get overlay() { return body.children.find((c) => c.className === '__un-qr-overlay') || null; },
    get look() { return this.overlay && this.overlay.getAttribute('data-un-theme'); },
    get css() { return find(head, '__usernode-qr-styles').textContent; },
    attached,
    themeListeners: () => (listeners['usernode:theme-changed'] || []).length,
    mediaListeners: () => mediaListeners.length,
    shellChanges(theme) { fromShell({ __usernode_theme: 'changed', value: { theme } }); },
    shellAnswers(theme) {
      const ask = posted.find((m) => m.__usernode_theme === 'get');
      assert.ok(ask, 'the bridge asked the shell');
      fromShell({ __usernode_theme: 'response', id: ask.id, value: { theme } });
    },
    osChanges(light) { media.matches = light; mediaListeners.forEach((fn) => fn({ matches: light })); },
  };
}

test('in the platform frame the card opens in the platform theme, whatever the OS says', () => {
  let page = runBridge({ search: '?token=t&un-theme=dark', osLight: true });
  page.open();
  assert.equal(page.look, 'dark', 'the platform\'s Dark beats a light OS');
  assert.deepEqual(page.attached, ['dark'], 'already dark when it is attached: no light flash');

  page = runBridge({ search: '?token=t&un-theme=light', osLight: false });
  page.open();
  assert.equal(page.look, 'light', 'the platform\'s Light beats a dark OS');
});

test('an open card follows a platform change live, and an OS flip does not override it', () => {
  const page = runBridge({ search: '?un-theme=light', osLight: true });
  page.open();
  page.shellChanges('dark');
  assert.equal(page.look, 'dark', 'the drawer\'s change reaches a card that is already open');
  page.osChanges(true);
  assert.equal(page.look, 'dark', 'the OS does not override a known platform theme');
  page.shellChanges('light');
  assert.equal(page.look, 'light', 'and back');
});

test('a frame opened without ?un-theme= uses the OS only until the shell answers', () => {
  const page = runBridge({ search: '', osLight: false });
  page.open();
  assert.equal(page.look, 'dark', 'nothing known yet: the OS (dark) decides');
  page.shellAnswers('light');
  assert.equal(page.look, 'light', 'the answer to the bridge\'s ask takes over');
});

test('outside Homeroom the OS decides, live, and the old default (dark) holds', () => {
  const page = runBridge({ framed: false, osLight: true });
  page.open();
  assert.equal(page.look, 'light', 'standalone on a light OS');
  page.osChanges(false);
  assert.equal(page.look, 'dark', 'an OS flip while open');

  const plain = runBridge({ framed: false, osLight: false });
  plain.open();
  assert.equal(plain.look, 'dark', 'no light preference: dark, as the card always was');
});

test('a closed card is left alone, the next one opens in the current theme, and listeners are wired once', () => {
  const page = runBridge({ search: '?un-theme=light' });
  page.open();
  page.close();
  assert.equal(page.overlay, null);
  page.shellChanges('dark');
  page.open();
  assert.equal(page.look, 'dark');
  assert.equal(page.themeListeners(), 1, 'one theme listener however many cards open');
  assert.equal(page.mediaListeners(), 1, 'one OS listener too');

  const idle = runBridge({ search: '?un-theme=light' });
  assert.equal(idle.themeListeners(), 0, 'an app that never pays by QR gets no listener');
  assert.equal(idle.mediaListeners(), 0);
});

test('the stylesheet keys the light look off the card\'s theme, not a media query', () => {
  const page = runBridge({ search: '?un-theme=light' });
  page.open();
  const css = page.css;
  assert.doesNotMatch(css, /prefers-color-scheme/, 'a media query would follow the OS over the platform');
  assert.match(css, /^\.__un-qr-card\{background:#1a1f2e;color:#e7edf7;/m, 'dark is the base look');
  assert.match(css, /^\.__un-qr-overlay\[data-un-theme=light\] \.__un-qr-card\{background:#fff;color:#0b1220;/m,
    'light, keyed off the attribute the bridge sets');
  assert.match(css, /^\.__un-qr-overlay\[data-un-theme=light\] \.__un-qr-cancel\{border-color:rgba\(0,0,0,0\.15\)\}/m,
    'the Cancel button\'s hairline too');
});

test('both bridge copies carry it', () => {
  assert.equal(read('public/usernode-bridge.js'), BRIDGE, 'the unversioned mirror matches');
});
