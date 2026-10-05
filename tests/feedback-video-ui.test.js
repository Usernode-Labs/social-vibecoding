// #3940: "Add video upload support to Feedback." One short screen recording
// per report, beside the up-to-three images: the same upload route and the
// same removable thumbnail row, previewed as a playable <video>. Three
// limits are checked before any bytes move — the format (magic bytes, the
// rule the server applies too), the 16 MB cap, and a 60-second duration read
// from the file's own metadata — and the upload's progress fills the
// thumbnail's status line while it travels.
//
// Behavioural, not a source regex: the controller runs in a vm over the same
// small fake DOM tests/feedback-multi-screenshot-ui.test.js uses, extended
// with an XMLHttpRequest stub (the video upload is XHR, so its progress can
// be driven) and a capture of the duration-probe <video> elements the
// controller creates (metadata arrives when the test says so).
//
// Run with: node --test tests/feedback-video-ui.test.js

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
    duration: NaN,
    controls: false,
    playsInline: false,
    muted: false,
    preload: '',
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

// What the OS picker hands back for a recording: enough of a File that the
// controller's magic-byte sniff (`slice(0, 12).arrayBuffer()`) and size check
// see real bytes.
const HEADS = {
  mp4: [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d],
  webm: [0x1a, 0x45, 0xdf, 0xa3, 0x2f, 0x42, 0x85, 0x81, 0x02, 0xf9, 0x42, 0x85],
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d],
};
function videoFile(name, { type = 'mp4', size = 1024 } = {}) {
  const bytes = Uint8Array.from(HEADS[type] || HEADS.mp4);
  return {
    name,
    size,
    type: type === 'mp4' ? 'video/mp4' : type === 'webm' ? 'video/webm' : type,
    slice: () => ({ arrayBuffer: async () => bytes.buffer }),
  };
}

function makeHarness({ offline = false, feedbackQueue = null } = {}) {
  const els = new Map();
  const fetchCalls = [];
  const xhrs = [];
  const createdVideos = [];
  const revoked = [];
  const eventTarget = () => {
    const listeners = {};
    return {
      addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
      fire: (ev, arg) => Promise.all((listeners[ev] || []).map((fn) => fn(arg))),
    };
  };
  class FakeXHR {
    constructor() {
      this.status = 0;
      this.responseText = '';
      this.upload = eventTarget();
      this.events = eventTarget();
      xhrs.push(this);
    }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(name, value) { this.headers = { ...(this.headers || {}), [name]: value }; }
    send(body) { this.sent = body; }
    addEventListener(ev, fn) { this.events.addEventListener(ev, fn); }
    async respond(status, body) {
      this.status = status;
      this.responseText = JSON.stringify(body);
      await this.events.fire('load', {});
    }
    async failNetwork() { await this.events.fire('error', {}); }
    async progress(loaded, total) {
      await this.upload.fire('progress', { lengthComputable: true, loaded, total });
    }
  }
  const sandbox = {
    console: { ...console, warn: () => {}, debug: () => {} },
    URLSearchParams,
    URL: {
      createObjectURL: (blob) => `blob:${blob.name}`,
      revokeObjectURL: (u) => { revoked.push(u); },
    },
    XMLHttpRequest: FakeXHR,
    location: { search: '', hash: '', pathname: '/' },
    document: {
      getElementById: (id) => {
        if (!els.has(id)) els.set(id, makeEl('div', id));
        return els.get(id);
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      createElement: (tag) => {
        const child = makeEl(tag);
        if (String(tag).toLowerCase() === 'video') createdVideos.push(child);
        return child;
      },
      body: { appendChild: () => {} },
      activeElement: null,
    },
    fetch: async (url, opts = {}) => {
      fetchCalls.push({ url, opts });
      if (url === '/api/feedback/screenshot') {
        return { ok: true, status: 200, json: async () => ({ id: String(fetchCalls.length).repeat(32) }) };
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
    ScreenshotSelect: { isSupported: () => false, prepareFile: async (file) => file },
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
  const thumbMedia = (item) => item.children.find((c) => c.tagName === 'IMG' || c.tagName === 'VIDEO');
  const thumbRemove = (item) => item.children.find((c) => c.tagName === 'BUTTON');
  const videoBtn = () => el('feedback-video-btn');
  return {
    sandbox,
    el,
    fetchCalls,
    xhrs,
    createdVideos,
    revoked,
    flush,
    list,
    thumbMedia,
    thumbRemove,
    open() { sandbox.Feedback._open({}); },
    close() { sandbox.Feedback._reset(); },
    async pick(...names) {
      const input = el('feedback-screenshot-input');
      input.files = names.map((name) => ({ name, size: 10, type: 'image/png' }));
      await input.fire('change');
      await flush();
    },
    // The video picker: one file (the input is not multiple), then the
    // duration probe's metadata arrives unless the test withholds it. Pass
    // opts.duration to set the length the recording reports; opts.type
    // changes the bytes the sniff sees. The change handler is NOT awaited to
    // completion — a live upload keeps it pending until the test answers the
    // XHR — so pickVideo drives the flow and lets the refusals settle in the
    // flush rounds.
    async pickVideo(name, opts = {}) {
      const file = videoFile(name, opts);
      const input = el('feedback-video-input');
      input.files = [file];
      input.fire('change');
      await flush();
      const probe = createdVideos[createdVideos.length - 1];
      if (createdVideos.length > 0 && Number.isNaN(probe.duration)) {
        probe.duration = opts.duration === undefined ? 12 : opts.duration;
        await probe.fire('loadedmetadata');
        await flush();
      }
      return file;
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
    videoBtnHidden: () => videoBtn().classList.contains('hidden'),
    pickerHidden: () => el('feedback-screenshot-picker-btn').classList.contains('hidden'),
  };
}

const VIDEO_ID = '76'.repeat(16);

test('the dialog declares the video pill and a single-file, video-only input', () => {
  const btnAt = DIALOG_TEXT.indexOf('id="feedback-video-btn"');
  assert.ok(btnAt > 0, 'the pill exists');
  const btn = DIALOG_TEXT.slice(btnAt, btnAt + 500);
  assert.match(btn, /Attach video/);
  const inputAt = DIALOG_TEXT.indexOf('id="feedback-video-input"');
  assert.ok(inputAt > 0, 'the input exists');
  const inputTag = DIALOG_TEXT.slice(inputAt, DIALOG_TEXT.indexOf('/>', inputAt));
  assert.match(inputTag, /accept="video\/mp4,video\/webm"/);
  assert.doesNotMatch(inputTag, /\bmultiple\b/, 'one recording per report');
});

test('one video beside up to three images: the pill steps aside and comes back', async () => {
  const h = makeHarness();
  h.open();
  assert.equal(h.videoBtnHidden(), false, 'the pill starts visible');
  assert.match(h.el('feedback-screenshot-count').textContent, /up to 3 images and one video/);

  await h.pick('before.png', 'after.png', 'third.png');
  assert.equal(h.list().length, 3);
  assert.equal(h.videoBtnHidden(), true, 'no room left, the pill steps aside');

  await h.thumbRemove(h.list()[2]).click();
  assert.equal(h.videoBtnHidden(), false, 'a slot opened up');

  await h.pickVideo('clip.mp4');
  assert.equal(h.list().length, 3, 'the recording takes the open slot');
  assert.equal(h.thumbMedia(h.list()[2]).tagName, 'VIDEO', 'a video entry is previewed as a <video>');
  assert.equal(h.thumbRemove(h.list()[2]).getAttribute('aria-label'), 'Remove video 3');
  assert.equal(h.videoBtnHidden(), true, 'one recording is the whole allowance');
  assert.equal(h.pickerHidden(), true, 'the row is full: two images and the recording');

  await h.thumbRemove(h.list()[2]).click();
  assert.equal(h.videoBtnHidden(), false, 'removing the recording brings the pill back');
  assert.ok(h.revoked.includes('blob:clip.mp4'), 'the removed preview frees its object URL');
});

test('a recording longer than a minute is refused before anything uploads', async () => {
  const h = makeHarness();
  h.open();
  await h.pickVideo('long.mp4', { duration: 90 });
  assert.equal(h.xhrs.length, 0, 'no bytes moved');
  assert.equal(h.list().length, 0);
  assert.match(h.el('feedback-status').textContent, /60 seconds/);
});

test('a file that is not a recording by its bytes is refused', async () => {
  const h = makeHarness();
  h.open();
  await h.pickVideo('renamed.mp4', { type: 'png' });
  assert.equal(h.xhrs.length, 0, 'nothing uploaded');
  assert.equal(h.list().length, 0);
  assert.match(h.el('feedback-status').textContent, /MP4 or WebM/);
});

test('a recording over the size cap is refused', async () => {
  const h = makeHarness();
  h.open();
  await h.pickVideo('huge.mp4', { size: 16 * 1024 * 1024 + 1 });
  assert.equal(h.xhrs.length, 0, 'nothing uploaded');
  assert.equal(h.list().length, 0);
  assert.match(h.el('feedback-status').textContent, /larger than 16 MB/);
});

test('a WebM is accepted like an MP4', async () => {
  const h = makeHarness();
  h.open();
  await h.pickVideo('clip.webm', { type: 'webm' });
  assert.equal(h.list().length, 1);
  assert.equal(h.xhrs.length, 1, 'uploaded through the same route');
  await h.xhrs[0].respond(200, { id: VIDEO_ID });
  h.type('A stuck recording');
  await h.submit();
  assert.deepEqual(h.filed()[0].screenshotIds, [VIDEO_ID]);
});

test('the upload reports its progress and the id lands with the submit', async () => {
  const h = makeHarness();
  h.open();
  await h.pick('still.png');
  await h.pickVideo('clip.mp4');
  assert.equal(h.xhrs.length, 1);
  const xhr = h.xhrs[0];
  assert.equal(xhr.method, 'POST');
  assert.equal(xhr.url, '/api/feedback/screenshot');
  assert.equal(xhr.headers['Content-Type'], 'application/octet-stream');
  assert.ok(xhr.sent, 'the bytes travel in the request body');
  await xhr.progress(45, 100);
  assert.match(h.list()[1].children.find((c) => c.tagName === 'SPAN').textContent, /Uploading… 45%/);
  await xhr.respond(200, { id: VIDEO_ID });
  assert.equal(h.list()[1].children.find((c) => c.tagName === 'SPAN').textContent, '');
  h.type('Here is what happens');
  await h.submit();
  assert.deepEqual(h.filed()[0].screenshotIds, ['1'.repeat(32), VIDEO_ID]);
});

test('a video the server refuses drops only that thumbnail', async () => {
  const h = makeHarness();
  h.open();
  await h.pick('kept.png');
  await h.pickVideo('clip.mp4');
  await h.xhrs[0].respond(400, { error: 'Video must be an MP4 or WebM file' });
  assert.equal(h.list().length, 1, 'the refused recording is gone, the image stays');
  assert.equal(h.thumbMedia(h.list()[0]).src, 'blob:kept.png');
  assert.match(h.el('feedback-status').textContent, /MP4 or WebM/);
});

test('a video removed mid-upload is never submitted', async () => {
  const h = makeHarness();
  h.open();
  await h.pickVideo('clip.mp4');
  const xhr = h.xhrs[0];
  await xhr.progress(10, 100);
  await h.thumbRemove(h.list()[0]).click();
  assert.equal(h.list().length, 0);
  await xhr.respond(200, { id: VIDEO_ID });
  h.type('Withdrawn the recording');
  await h.submit();
  const filed = h.filed()[0] || {};
  assert.equal((filed.screenshotIds || []).includes(VIDEO_ID), false,
    'the removed recording has no id to attach');
});

test('submit waits while the recording is still uploading', async () => {
  const h = makeHarness();
  h.open();
  // The pick resolves once the duration probe answers; the XHR is left
  // unanswered, so the upload is still in flight.
  await h.pickVideo('clip.mp4');
  assert.equal(h.xhrs.length, 1);
  h.type('One moment');
  await h.submit();
  assert.equal(h.filed().length, 0, 'nothing filed mid-upload');
  assert.match(h.el('feedback-status').textContent, /still uploading/i);
  await h.xhrs[0].respond(200, { id: VIDEO_ID });
  await h.submit();
  assert.equal(h.filed().length, 1);
  assert.deepEqual(h.filed()[0].screenshotIds, [VIDEO_ID]);
});

test('offline, a recording the network refused keeps its bytes for the outbox', async () => {
  const queued = [];
  const feedbackQueue = {
    MAX_ENTRIES: 10,
    init: () => {},
    count: async () => queued.length,
    takeFailed: async () => null,
    enqueue: async (entry) => { queued.push(entry); return entry; },
  };
  let online = true;
  const h = makeHarness({ feedbackQueue });
  h.sandbox.Offline.isOffline = () => !online;
  h.open();
  await h.pickVideo('recording.mp4');
  await h.xhrs[0].failNetwork();
  assert.equal(h.list().length, 1, 'the bytes and the thumbnail stay');
  assert.match(
    h.list()[0].children.find((c) => c.tagName === 'SPAN').textContent,
    /back online/,
  );
  online = false;
  h.type('Saved for later with a recording');
  await h.submit();
  assert.equal(queued.length, 1);
  assert.deepEqual([...queued[0].screenshots.map((b) => b.name)], ['recording.mp4']);
  assert.deepEqual([...queued[0].payload.screenshotIds || []], [], 'nothing was uploaded');
});
