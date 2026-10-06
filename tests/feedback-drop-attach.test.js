// #4065: dragging files onto the Suggest an improvement window attaches them
// exactly as its own buttons do. Feedback._dropFiles partitions a drop the way
// the pickers offer: supported images through the screenshot path, the first
// clip through the video path, everything else ignored — and a dropped video
// replaces an attached one only after the new one passes its own checks.
//
// Behavioural, in the same vm fake-DOM harness tests/feedback-multi-screenshot-ui.test.js
// uses, extended with the two seams the video path needs: an XMLHttpRequest
// for the clip upload, and a <video> element that answers its metadata load.
//
// Run with: node --test tests/feedback-drop-attach.test.js

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
const CSS_TEXT = fs.readFileSync(path.join(ROOT, 'public', 'css', 'app.css'), 'utf8');
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
    replaceChildren(...kids) {
      for (const c of el.children.slice()) c.parentNode = null;
      el.children.length = 0;
      for (const k of kids) el.appendChild(k);
    },
    remove() {
      const p = el.parentNode;
      if (!p) return;
      p.children.splice(p.children.indexOf(el), 1);
      el.parentNode = null;
    },
    querySelector(sel) {
      // The controller writes the button labels through a stable child
      // ([data-screenshot-label], [data-video-label]); hand the same node
      // back each time so those writes land.
      if (!el._qs) el._qs = {};
      if (!el._qs[sel]) {
        const c = makeEl('span');
        c.parentNode = el;
        el.children.push(c);
        el._qs[sel] = c;
      }
      return el._qs[sel];
    },
    querySelectorAll: () => [],
    focus() {},
    click() { return el.fire('click', { target: el, currentTarget: el }); },
  };
  return el;
}

function makeHarness({ offline = false, uploadPlan = null, prepareFile = null, videoPlan = null } = {}) {
  const els = new Map();
  const fetchCalls = [];
  const videoUploads = [];
  const revoked = [];
  let uploads = 0;
  // The metadata a <video> created inside the vm reports when its src lands:
  // the decodability-and-duration probe reads exactly this.
  let videoSeconds = 12;
  const sandbox = {
    console: { ...console, warn: () => {}, debug: () => {} },
    setImmediate,
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
      createElement: (tag) => {
        const el = makeEl(tag);
        if (String(tag).toLowerCase() === 'video') {
          Object.defineProperty(el, 'src', {
            get() { return el._src || ''; },
            set(v) {
              el._src = v;
              // A real decoder answers a tick later; '' is the probe's own
              // teardown, not a load.
              if (!v) return;
              setImmediate(() => {
                if (typeof el.onloadedmetadata === 'function') {
                  el.duration = videoSeconds;
                  el.onloadedmetadata();
                }
              });
            },
          });
        }
        return el;
      },
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
    // The clip upload rides an XMLHttpRequest (fetch gives no progress).
    XMLHttpRequest: function () {
      const xhr = this;
      xhr.upload = {};
      xhr.open = (method, url) => { xhr._url = url; };
      xhr.setRequestHeader = () => {};
      xhr.send = (blob) => {
        videoUploads.push({ url: xhr._url, blob });
        const plan = videoPlan ? videoPlan(videoUploads.length, blob) : null;
        if (plan && plan.throws) { setImmediate(() => xhr.onerror && xhr.onerror()); return; }
        xhr.status = plan && plan.status ? plan.status : 200;
        xhr.response = plan && plan.body ? plan.body : { id: `vid${videoUploads.length}`.padEnd(32, '0') };
        setImmediate(() => xhr.onload && xhr.onload());
      };
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
    FeedbackQueue: undefined,
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
    for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
  };
  const list = () => el('feedback-screenshot-preview').children;
  const thumbImg = (item) => item.children.find((c) => c.tagName === 'IMG');
  const videoThumb = () => {
    const preview = el('feedback-video-preview');
    const item = preview.children[0] || null;
    return item ? item.children.find((c) => c.tagName === 'VIDEO') : null;
  };

  return {
    sandbox,
    el,
    fetchCalls,
    videoUploads,
    revoked,
    flush,
    list,
    thumbImg,
    videoThumb,
    setVideoSeconds: (s) => { videoSeconds = s; },
    open() { sandbox.Feedback._open({}); },
    close() { sandbox.Feedback._reset(); },
    // What the card's drop handler hands over: the same File-like objects
    // an OS drag carries.
    async drop(...files) {
      sandbox.Feedback._dropFiles(files);
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
    statusHidden: () => el('feedback-status').classList.contains('hidden'),
  };
}

const img = (name, type = 'image/png') => ({ name, size: 10, type });
const clip = (name, type = 'video/mp4') => ({ name, size: 1000, type });

test('the card hands a drop to the controller and wears the composer\'s highlight', () => {
  assert.match(DIALOG_TEXT, /onDrop=\{\(event\) => \{[\s\S]*?Feedback\._dropFiles\(\[\.\.\.event\.dataTransfer\.files\]\)/);
  // The overlay anchors to the card, so the card carries the relative flag
  // the other dialogs with an absolutely-positioned element use.
  assert.match(DIALOG_TEXT, /<DialogCard\s*\n\s*size="sm"\s*\n\s*relative/);
  assert.match(DIALOG_TEXT, /feedback-drop-overlay">Drop files to attach</);
  assert.match(DIALOG_TEXT, /feedback-card-dragging/);
  assert.match(CSS_TEXT, /\.feedback-card-dragging \{ outline: 2px solid var\(--accent\)/);
  assert.match(CSS_TEXT, /\.feedback-drop-overlay \{[\s\S]*?pointer-events: none/);
});

test('two dropped images each get a thumbnail and an upload, like picked ones', async () => {
  const h = makeHarness();
  h.open();
  assert.equal(h.list().length, 0);
  await h.drop(img('before.png'), img('after.png'));
  assert.equal(h.list().length, 2);
  assert.deepEqual(h.list().map((item) => h.thumbImg(item).src), ['blob:before.png', 'blob:after.png']);
  assert.equal(h.uploads().length, 2, 'each image is its own upload');
  h.type('Two dropped pictures');
  await h.submit();
  assert.deepEqual(h.filed()[0].screenshotIds, ['1'.repeat(32), '2'.repeat(32)]);
});

test('a dropped video takes the Add video path: thumbnail, upload, videoId on submit', async () => {
  const h = makeHarness();
  h.open();
  await h.drop(clip('moment.mp4'));
  const thumb = h.videoThumb();
  assert.ok(thumb, 'the clip has a thumbnail row');
  assert.match(thumb.src, /blob:moment\.mp4#t=0\.1/);
  assert.equal(h.videoUploads.length, 1);
  assert.equal(h.videoUploads[0].url, '/api/feedback/video');
  assert.equal(h.el('feedback-video-btn').querySelector('[data-video-label]').textContent, 'Replace video');
  h.type('A clip of what happened');
  await h.submit();
  assert.equal(h.filed()[0].videoId, 'vid1'.padEnd(32, '0'));
});

test('more images dropped than fit: the first ones attach and the existing note is shown', async () => {
  const h = makeHarness();
  h.open();
  await h.drop(img('one.png'), img('two.png'), img('three.png'), img('four.png'), img('five.png'));
  assert.equal(h.list().length, 3);
  assert.equal(h.uploads().length, 3, 'nothing past the limit is uploaded');
  assert.match(h.el('feedback-status').textContent, /up to 3 images/i);
  assert.match(h.el('feedback-status').textContent, /only the first 3 were added/);
});

test('a PDF and a second clip in the same drop are ignored, nothing said', async () => {
  const h = makeHarness();
  h.open();
  await h.drop(
    { name: 'notes.pdf', size: 500, type: 'application/pdf' },
    clip('first.mp4'),
    clip('second.webm', 'video/webm'),
  );
  assert.equal(h.list().length, 0, 'no image thumbnails for the PDF');
  assert.equal(h.videoUploads.length, 1, 'only the first clip uploads');
  assert.equal(h.videoUploads[0].blob.name, 'first.mp4');
  assert.equal(h.statusHidden(), true, 'ignored files say nothing');
});

test('one drop can carry both: images to the screenshot row, the clip to Add video', async () => {
  const h = makeHarness();
  h.open();
  await h.drop(img('a.png'), clip('clip.webm', 'video/webm'), img('b.png', 'image/jpeg'));
  assert.equal(h.list().length, 2);
  assert.ok(h.videoThumb());
  assert.equal(h.uploads().length, 2);
  assert.equal(h.videoUploads.length, 1);
});

test('a dropped video replaces an attached one only after the new one passes', async () => {
  const h = makeHarness();
  h.open();
  await h.drop(clip('good.mp4'));
  assert.equal(h.videoUploads.length, 1);
  assert.equal(h.el('feedback-video-btn').querySelector('[data-video-label]').textContent, 'Replace video');

  // Too long: the same check Add video applies. The previous clip stays.
  h.setVideoSeconds(90);
  await h.drop(clip('too-long.mov', 'video/quicktime'));
  assert.equal(h.videoUploads.length, 1, 'the refused clip never uploads');
  assert.match(h.videoThumb().src, /blob:good\.mp4#t=0\.1/, 'the previous clip is still shown');
  assert.match(h.el('feedback-status').textContent, /60 seconds/);

  h.type('Kept the first clip');
  await h.submit();
  assert.equal(h.filed()[0].videoId, 'vid1'.padEnd(32, '0'), 'the previous clip travels with the submit');
});

test('a generic-MIME drop is read by extension, like a picked file', async () => {
  const h = makeHarness();
  h.open();
  await h.drop(img('photo.png', ''), clip('recording.mp4', ''));
  assert.equal(h.list().length, 1);
  assert.ok(h.videoThumb());
});