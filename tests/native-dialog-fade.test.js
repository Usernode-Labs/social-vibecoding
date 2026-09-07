// #1566: exercise the real modal/alert presenters with a controlled frame and
// transition clock. A child transform or the keyboard's `top` transition must
// never remove the backdrop before BOTH opacity fades have finished.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const SRC = read('public/usernode-native/v1/native.js');
const CSS = read('public/usernode-native/v1/native.css');

function section(start) {
  const at = SRC.indexOf(start);
  assert.ok(at >= 0, `presenter section exists: ${start}`);
  return SRC.slice(at, SRC.indexOf('\n  /* ', at));
}

function harness() {
  const frames = new Map();
  const timers = new Map();
  const commits = [];
  let nextId = 0;
  const document = { activeElement: null };

  class Element {
    constructor(tag) {
      this.tagName = tag;
      this.className = '';
      this.style = {};
      this.children = [];
      this.parentNode = null;
      this.listeners = new Map();
      this.classList = {
        contains: (cls) => this.className.split(/\s+/).includes(cls),
        add: (cls) => { if (!this.classList.contains(cls)) this.className += ` ${cls}`; },
        remove: (cls) => { this.className = this.className.split(/\s+/).filter((c) => c !== cls).join(' '); },
      };
    }
    appendChild(el) {
      if (el.parentNode) el.parentNode.removeChild(el);
      this.children.push(el);
      el.parentNode = this;
      return el;
    }
    removeChild(el) {
      this.children.splice(this.children.indexOf(el), 1);
      el.parentNode = null;
    }
    setAttribute(name, value) { this[name] = value; }
    querySelector(selector) {
      return this.children.find((el) => selector === '[autofocus]' && el.autofocus) || null;
    }
    focus() { document.activeElement = this; }
    addEventListener(type, fn, options) {
      const listeners = this.listeners.get(type) || [];
      listeners.push({ fn, once: !!options?.once });
      this.listeners.set(type, listeners);
    }
    removeEventListener(type, fn) {
      this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item.fn !== fn));
    }
    emit(type, details = {}) {
      const event = { target: this, ...details };
      for (const { fn, once } of [...(this.listeners.get(type) || [])]) {
        if (once) this.removeEventListener(type, fn);
        fn(event);
      }
      this.parentNode?.emit(type, event);
    }
    get offsetWidth() {
      commits.push({ el: this, opacity: computed(this).opacity });
      return 270;
    }
  }

  function computed(el) {
    return { opacity: el.renderedOpacity ?? el.style.opacity ?? (el.classList.contains('un-in') ? '1' : '0') };
  }
  document.createElement = (tag) => new Element(tag);
  document.body = new Element('body');
  document.activeElement = new Element('button');
  const context = vm.createContext({
    document,
    window: { addEventListener() {} },
    activePopover: null,
    onBackdropDismiss: (el, fn) => el.addEventListener('click', fn),
    getComputedStyle(el) {
      const style = computed(el);
      commits.push({ el, opacity: style.opacity });
      return style;
    },
    requestAnimationFrame(fn) { frames.set(++nextId, fn); return nextId; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(fn, ms) { timers.set(++nextId, { fn, ms }); return nextId; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(section('  var modalStack = []') + section('  function alertDialog(options)'), context);
  return {
    document, commits, timers,
    modal: context.presentModal,
    alert: context.alertDialog,
    frame() {
      const pending = [...frames.values()];
      frames.clear();
      for (const fn of pending) fn();
    },
    timeout() {
      const pending = [...timers.values()];
      timers.clear();
      for (const { fn } of pending) fn();
    },
  };
}

function present(h, kind) {
  let completions = 0;
  let close;
  if (kind === 'modal') {
    const modal = h.modal({ content: 'Dialog', onDismiss() { completions++; } });
    close = () => modal.dismiss();
  } else {
    h.alert({ title: 'Alert', buttons: [{ label: 'OK', handler() { completions++; } }] });
  }
  const [backdrop, card] = h.document.body.children;
  if (kind === 'alert') {
    const button = card.children.at(-1).children[0];
    close = () => button.emit('click');
  }
  return { card, backdrop, close, completions: () => completions };
}

for (const kind of ['modal', 'alert']) {
  test(`${kind}: commits BOTH hidden layers before their shared entrance frame`, () => {
    const h = harness();
    const { card, backdrop } = present(h, kind);
    for (const el of [card, backdrop]) {
      assert.ok(h.commits.some((commit) => commit.el === el && commit.opacity === '0'),
        'the backdrop needs an initial style too, including a microtask-origin presentation');
    }
    assert.equal(card.classList.contains('un-in'), false);
    h.frame();
    assert.equal(card.classList.contains('un-in'), true);
    assert.equal(backdrop.style.opacity, '1');
  });

  test(`${kind}: ignores child/keyboard/scale transitions and waits for both fades`, () => {
    const h = harness();
    const p = present(h, kind);
    h.frame();
    p.close();
    assert.equal(p.card.style.pointerEvents, 'none');
    assert.equal(p.backdrop.style.pointerEvents, 'none');
    const child = h.document.createElement('button');
    p.card.appendChild(child);
    child.emit('transitionend', { propertyName: 'opacity' });
    p.card.emit('transitionend', { propertyName: 'top' });
    p.card.emit('transitionend', { propertyName: 'transform' });
    assert.equal(p.completions(), 0);
    assert.equal(h.document.body.children.length, 2);
    p.card.emit('transitionend', { propertyName: 'opacity' });
    assert.equal(p.completions(), 0, 'the backdrop has not finished yet');
    p.backdrop.emit('transitionend', { propertyName: 'opacity' });
    assert.equal(p.completions(), 1);
    assert.equal(h.document.body.children.length, 0);
    assert.equal(h.timers.size, 0, 'completion releases the fallback timer');
    p.close();
    h.timeout();
    assert.equal(p.completions(), 1, 'dismissal is idempotent');
  });

  test(`${kind}: the backdrop finishing first cannot pre-empt the card`, () => {
    const h = harness();
    const p = present(h, kind);
    h.frame();
    p.close();
    p.backdrop.emit('transitionend', { propertyName: 'opacity' });
    assert.equal(p.completions(), 0);
    p.card.emit('transitionend', { propertyName: 'opacity' });
    assert.equal(p.completions(), 1);
  });

  test(`${kind}: closing before the first frame cannot re-open or steal focus`, () => {
    const h = harness();
    const previousFocus = h.document.activeElement;
    const p = present(h, kind);
    p.close();
    h.frame();
    h.timeout();
    assert.equal(p.card.classList.contains('un-in'), false);
    assert.notEqual(p.backdrop.style.opacity, '1');
    assert.equal(h.document.activeElement, previousFocus);
    assert.equal(p.completions(), 1);
    assert.equal(h.document.body.children.length, 0);
  });

  test(`${kind}: a late entrance event cannot end the exit`, () => {
    const h = harness();
    const p = present(h, kind);
    h.frame();
    p.card.renderedOpacity = p.backdrop.renderedOpacity = '0.5';
    p.close();
    p.card.emit('transitionend', { propertyName: 'opacity' });
    p.backdrop.emit('transitionend', { propertyName: 'opacity' });
    assert.equal(p.completions(), 0, 'both layers are still visible');
    p.card.renderedOpacity = p.backdrop.renderedOpacity = '0';
    p.card.emit('transitionend', { propertyName: 'opacity' });
    p.backdrop.emit('transitionend', { propertyName: 'opacity' });
    assert.equal(p.completions(), 1);
  });

  test(`${kind}: missing transition events still release both layers together`, () => {
    const h = harness();
    const p = present(h, kind);
    h.frame();
    p.close();
    assert.equal(p.completions(), 0);
    h.timeout();
    assert.equal(p.completions(), 1);
    assert.equal(h.document.body.children.length, 0);
  });
}

test('modal, alert and backdrop share the same fade token, including reduced motion', () => {
  for (const selector of ['.un-backdrop.un-backdrop-fade', '.un-modal', '.un-alert']) {
    const at = CSS.indexOf(`\n${selector} {`);
    const rule = CSS.slice(at, CSS.indexOf('\n}', at));
    assert.match(rule, /opacity var\(--un-dialog-fade-duration\) ease/);
  }
  assert.match(CSS, /--un-dialog-fade-duration: 180ms;/);
  const reduced = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.un-modal,\s*\.un-alert\s*\{\s*transition: opacity var\(--un-dialog-fade-duration\) ease;/);
});
