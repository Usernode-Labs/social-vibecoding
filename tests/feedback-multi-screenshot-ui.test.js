// #3027: "I want to send two photos — one before saving and one after saving —
// but I can only send one." The Send feedback dialog now holds up to three
// images. Each one is its own removable thumbnail, uploads on its own, and
// every uploaded id goes with the submit; the add buttons step aside once the
// limit is reached and come back when one is removed.
//
// Behavioural, not a source regex: the controller runs in a vm over a small
// fake DOM (the harness shape tests/feedback-draft-persistence.test.js uses,
// plus the child-node handling thumbnails need), with ScreenshotSelect and
// fetch stubbed at their seams.
//
// Run with: node --test tests/feedback-multi-screenshot-ui.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const CONTROLLER_TEXT = fs.readFileSync(
  path.join(ROOT, 'frontend', 'src', 'features', 'dialogs', 'feedback-controller.js'),
  'utf8'
);
const DIALOG_TEXT = fs.readFileSync(
  path.join(ROOT, 'frontend', 'src', 'features', 'dialogs', 'feedback.tsx'),
  'utf8'
);
const FEEDBACK_SRC = CONTROLLER_TEXT
  .replace(/^import .*$/gm, '')
  .replace(/^export /gm, '')
  + '\n;globalThis.Feedback = Feedback;\n';

function makeEl(tag, id = '') {
  const listeners = {};
  const classes = new Set();
  const attrs = {};
  const el = {
    tagName: String(tag).toUpperCase(),
    id,
    dataset: {},
    style: {},
    value: '',
    textContent: '',
    innerHTML: '',
    placeholder: '',
    disabled: false,
    readOnly: false,
    checked: false,
    files: null,
    src: '',
    alt: '',
    type: '',
    children: [],
    parentNode: null,
    get className() { return [...classes].join(' '); },
    set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
    classList: {
      add: (...cs) => cs.forEach((c) => classes.add(c)),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      contains: (c) => classes.has(c),
      toggle: (c, on) => {
        const next = on === undefined ? !classes.has(c) : !!on;
        if (next) classes.add(c); else classes.delete(c);
        return next;
      },
    },
    addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    fire(ev, arg) { return Promise.all((listeners[ev] || []).map((fn) => fn(arg))); },
    setAttribute: (k, v) => { attrs[k] = String(v); },
    removeAttribute: (k) => { delete attrs[k]; if (k === 'src') el.src = ''; },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    hasAttribute: (k) => k in attrs,
    appendChild(child) {
      if (child.parentNode) child.remove();
      el.children.push(child);
      child.parentNode = el;
      return child;
    },
    remove() {
      const p = el.parentNode;
      if (!p) return;
      p.children.splice(p.children.indexOf(el), 1);
      el.parentNode = null;
    },
    querySelector: () => makeEl('span'),
    querySelectorAll: () => [],
    focus() {},
    click() { return el.fire('click', { target: el, currentTarget: el }); },
  };
  return el;
}

function makeHarness({ offline = false, uploadPlan = null, prepareFile = null, feedbackQueue = null } = {}) {
  const els = new Map();
  const fetchCalls = [];
  const revoked = [];
  let uploads = 0;
  const sandbox = {
    console: { ...console, warn: () => {}, debug: () => {} },
    URLSearchParams,
    URL: {
      createObjectURL: (blob) => `blob:${blob.name}`,
      revokeObjectURL: (u) => { revoked.push(u); },
    },
    location: { search: '', hash: '', pathname: '/' },
    document: {
      getElementById: (id) => {
        if (!els.has(id)) els.set(id, makeEl('div', id));
        return els.get(id);
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      createElement: (tag) => makeEl(tag),
      body: { appendChild: () => {} },
      activeElement: null,
    },
    fetch: async (url, opts = {}) => {
      fetchCalls.push({ url, opts });
      if (url === '/api/feedback/screenshot') {
        uploads += 1;
        const plan = uploadPlan ? uploadPlan(uploads, opts.body) : null;
        if (plan && plan.throws) throw new TypeError('Failed to fetch');
        if (plan && plan.status) return { ok: false, status: plan.status, json: async () => (plan.body || {}) };
        return { ok: true, status: 200, json: async () => ({ id: String(uploads).repeat(32) }) };
      }
      if (url === '/api/feedback/title') return { ok: true, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ url: 'https://example.invalid/1' }) };
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    AppView: {
      appData: null,
      issueStateAvailable: () => false,
      collectIssueState: async () => null,
      close: () => {},
    },
    ScreenshotSelect: {
      isSupported: () => false,
      prepareFile: prepareFile || (async (file) => file),
    },
    Offline: { isOffline: () => offline },
    PlatformUI: { pullToRefresh: () => {}, toast: () => {} },
    FeedbackQueue: feedbackQueue || undefined,
    App: {},
    alert: () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(FEEDBACK_SRC, sandbox);
  sandbox.init();
  sandbox.App.currentApp = null;
  sandbox.App.currentTab = 'home';
  sandbox.App.user = { id: 7 };

  const el = (id) => sandbox.document.getElementById(id);
  const flush = async () => {
    for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));
  };
  const list = () => el('feedback-screenshot-preview').children;
  const thumbImg = (item) => item.children.find((c) => c.tagName === 'IMG');
  const thumbRemove = (item) => item.children.find((c) => c.tagName === 'BUTTON');

  return {
    sandbox,
    el,
    fetchCalls,
    revoked,
    flush,
    list,
    thumbImg,
    thumbRemove,
    open() { sandbox.Feedback._open({}); },
    close() { sandbox.Feedback._reset(); },
    // What the OS picker hands back: one or several files at once.
    async pick(...names) {
      const input = el('feedback-screenshot-input');
      input.files = names.map((name) => ({ name, size: 10, type: 'image/png' }));
      await input.fire('change');
      await flush();
    },
    type(text) {
      el('feedback-text').value = text;
      el('feedback-text').fire('input');
    },
    async submit() {
      el('feedback-submit').fire('click');
      await flush();
    },
    filed: () => fetchCalls.filter((c) => c.url === '/api/feedback').map((c) => JSON.parse(c.opts.body)),
    uploads: () => fetchCalls.filter((c) => c.url === '/api/feedback/screenshot'),
    pickerHidden: () => el('feedback-screenshot-picker-btn').classList.contains('hidden'),
  };
}

test('the picker accepts several files at once', () => {
  const input = DIALOG_TEXT.slice(DIALOG_TEXT.indexOf('id="feedback-screenshot-input"'));
  assert.match(input.slice(0, input.indexOf('/>')), /\bmultiple\b/);
});

test('three images each get a thumbnail and an upload, then the add buttons step aside', async () => {
  const h = makeHarness();
  h.open();
  assert.equal(h.list().length, 0);
  assert.equal(h.pickerHidden(), false);
  assert.match(h.el('feedback-screenshot-count').textContent, /up to 3 images/);

  await h.pick('before.png');
  assert.equal(h.list().length, 1);
  assert.equal(h.pickerHidden(), false, 'room for more after one');
  assert.match(h.el('feedback-screenshot-count').textContent, /1 of 3/);

  await h.pick('after.png');
  await h.pick('third.png');
  assert.equal(h.list().length, 3);
  assert.deepEqual(h.list().map((item) => h.thumbImg(item).src), ['blob:before.png', 'blob:after.png', 'blob:third.png']);
  assert.equal(h.uploads().length, 3, 'each image is its own upload');
  assert.equal(h.pickerHidden(), true, 'no fourth slot');
  assert.equal(h.el('feedback-screenshot-btn').classList.contains('hidden'), true);
  assert.match(h.el('feedback-screenshot-count').textContent, /3 of 3/);
  assert.equal(h.el('feedback-screenshot-preview').classList.contains('hidden'), false);

  h.type('Tier list changed after saving');
  await h.submit();
  assert.equal(h.filed().length, 1);
  assert.deepEqual(h.filed()[0].screenshotIds, ['1'.repeat(32), '2'.repeat(32), '3'.repeat(32)]);
  assert.equal(h.filed()[0].screenshotId, undefined);
});

test('each thumbnail has its own labelled remove button, and removing one frees a slot', async () => {
  const h = makeHarness();
  h.open();
  await h.pick('a.png', 'b.png', 'c.png');
  assert.equal(h.list().length, 3);
  const labels = h.list().map((item) => h.thumbRemove(item).getAttribute('aria-label'));
  assert.deepEqual(labels, ['Remove image 1', 'Remove image 2', 'Remove image 3']);

  await h.thumbRemove(h.list()[1]).click();
  assert.equal(h.list().length, 2);
  assert.deepEqual(h.list().map((item) => h.thumbImg(item).src), ['blob:a.png', 'blob:c.png']);
  assert.ok(h.revoked.includes('blob:b.png'), 'the removed preview frees its object URL');
  assert.equal(h.pickerHidden(), false, 'a slot opened up');
  assert.equal(h.thumbRemove(h.list()[1]).getAttribute('aria-label'), 'Remove image 2', 'labels renumber');

  h.type('Two pictures left');
  await h.submit();
  assert.deepEqual(h.filed()[0].screenshotIds, ['1'.repeat(32), '3'.repeat(32)], 'the removed one is not sent');
});

test('picking more files than there is room for keeps the first ones and says so', async () => {
  const h = makeHarness();
  h.open();
  await h.pick('one.png');
  await h.pick('two.png', 'three.png', 'four.png', 'five.png');
  assert.equal(h.list().length, 3);
  assert.equal(h.uploads().length, 3, 'nothing past the limit is uploaded');
  assert.match(h.el('feedback-status').textContent, /up to 3 images/i);
});

test('one bad file in a multi-pick does not cost the others', async () => {
  const h = makeHarness({
    prepareFile: async (file) => {
      if (file.name === 'bad.gif') { const err = new Error('type'); err.code = 'invalid-type'; throw err; }
      return file;
    },
  });
  h.open();
  await h.pick('good.png', 'bad.gif', 'fine.png');
  assert.equal(h.list().length, 2);
  assert.match(h.el('feedback-status').textContent, /PNG or JPEG/);
});

test('an upload the server refuses drops only that thumbnail', async () => {
  const h = makeHarness({ uploadPlan: (n) => (n === 2 ? { status: 400, body: { error: 'Screenshot must be a PNG or JPEG image' } } : null) });
  h.open();
  await h.pick('a.png');
  await h.pick('b.png');
  assert.equal(h.list().length, 1, 'the refused image is gone, the first stays');
  assert.equal(h.thumbImg(h.list()[0]).src, 'blob:a.png');
  assert.match(h.el('feedback-status').textContent, /PNG or JPEG/);
});

test('closing the dialog clears every thumbnail, and the next open starts empty', async () => {
  const h = makeHarness();
  h.open();
  await h.pick('a.png', 'b.png');
  h.close();
  assert.equal(h.list().length, 0);
  assert.equal(h.el('feedback-screenshot-preview').classList.contains('hidden'), true);
  h.open();
  assert.equal(h.list().length, 0);
  assert.equal(h.pickerHidden(), false);
});

test('offline, every image not yet uploaded goes to the outbox as bytes; uploaded ones as ids', async () => {
  const queued = [];
  const feedbackQueue = {
    MAX_ENTRIES: 10,
    init: () => {},
    count: async () => queued.length,
    takeFailed: async () => null,
    enqueue: async (entry) => { queued.push(entry); return entry; },
  };
  let online = true;
  const h = makeHarness({
    feedbackQueue,
    uploadPlan: (n) => (n === 1 ? null : { throws: true }),
  });
  h.sandbox.Offline.isOffline = () => !online;
  h.open();
  await h.pick('uploaded.png');
  await h.pick('stuck.png');
  assert.equal(h.list().length, 2, 'a network failure keeps the bytes and the thumbnail');
  online = false;
  h.type('Saved for later with two pictures');
  await h.submit();
  assert.equal(queued.length, 1);
  // Arrays built inside the vm are another realm's; compare their contents.
  assert.deepEqual([...queued[0].payload.screenshotIds], ['1'.repeat(32)]);
  assert.deepEqual([...queued[0].screenshots.map((b) => b.name)], ['stuck.png']);
});

test('submit waits while any image is still uploading', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = makeHarness();
  const realFetch = h.sandbox.fetch;
  h.sandbox.fetch = async (url, opts) => {
    if (url === '/api/feedback/screenshot') await gate;
    return realFetch(url, opts);
  };
  h.open();
  const picking = h.pick('slow.png');
  await h.flush();
  h.type('Waiting on a picture');
  await h.submit();
  assert.equal(h.filed().length, 0, 'nothing filed mid-upload');
  assert.match(h.el('feedback-status').textContent, /still uploading/i);
  release();
  await picking;
});

test('closing mid multi-pick stops attaching (and uploading) the rest', async () => {
  let h;
  let prepared = 0;
  h = makeHarness({
    prepareFile: async (file) => {
      prepared += 1;
      // The person closes the dialog while the first file is being prepared.
      if (prepared === 1) h.close();
      return file;
    },
  });
  h.open();
  await h.pick('a.png', 'b.png', 'c.png');
  assert.equal(h.uploads().length, 0, 'nothing is uploaded for a dialog that is gone');
  assert.equal(h.list().length, 0);
  h.open();
  assert.equal(h.list().length, 0, 'the next open starts empty');
});
