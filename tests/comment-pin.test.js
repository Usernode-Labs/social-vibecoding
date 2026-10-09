'use strict';

// Comment mode (#4289 and its follow-ups): C, or "Suggest an improvement"
// when it was used last, turns on a layer where every click leaves a
// comment, each posted as its own request with a screenshot of the page and
// its pin beside it as data (#4482). frontend/src/features/comment-pin/; the
// key and the remembered way in are tests/suggest-shortcut.test.js.
//
// What is pinned, and each is a way it can be quietly wrong:
//
//   1. THE LAYOUT. The box and an open marker's card sit beside their pins by
//      one rule, inside the viewport.
//   2. POSTING. The dialog's requests: every picture, then the request naming
//      them, with the box's title, Kudos and the page's pin; a refusal with a
//      reason stays in the box; offline, a network failure or a server error
//      hands the comment to the dialog, words, title, pictures, pin, Kudos
//      and destination.
//   2b. THE PIN AS DATA. The server writes the pin onto its picture's link by
//      the same rule the request's page reads it back with.
//   3. THE APP'S PICTURE. The bridge draws the app only for the platform's
//      own origin (platform.json, https only), answers that origin alone,
//      draws what is on screen at its scroll position, and puts the app's
//      own `window.snapdom` back.
//   4. THE SEAMS. The dialog takes a handed-over comment; the drawing
//      library is the pinned, recorded copy, byte for byte.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const picture = loadTsx('frontend/src/features/comment-pin/picture.ts');
const post = loadTsx('frontend/src/features/comment-pin/post.ts');
const BRIDGE = read('public/usernode-bridge/v1/bridge.js');
const SNAPSHOT = BRIDGE.split('/* __USERNODE_SNAPSHOT_BEGIN__ */')[1].split('/* __USERNODE_SNAPSHOT_END__ */')[0];

// ── 1. The layout ─────────────────────────────────────────────────────

test('the box sits right of the pin and below it, flipping at the edges and staying inside', () => {
  const vp = { width: 1000, height: 700 };
  const size = { width: 300, height: 160 };
  assert.deepEqual(picture.placeBeside({ x: 100, y: 100 }, size, vp), { x: 114, y: 114 });
  assert.deepEqual(picture.placeBeside({ x: 900, y: 100 }, size, vp), { x: 586, y: 114 }, 'flips left at the right edge');
  assert.deepEqual(picture.placeBeside({ x: 100, y: 650 }, size, vp), { x: 114, y: 476 }, 'flips up at the bottom');
  const tiny = picture.placeBeside({ x: 150, y: 80 }, size, { width: 320, height: 200 });
  assert.ok(tiny.x >= 8 && tiny.x + 300 <= 312 && tiny.y >= 8 && tiny.y + 160 <= 192, 'clamped when neither side fits');
});

test('the picture is the screen\'s own pixels, up to 2x, and never past 3000 on its long side', () => {
  assert.equal(picture.pictureScale(1, { width: 1280, height: 800 }), 1);
  assert.equal(picture.pictureScale(2, { width: 1280, height: 800 }), 2);
  assert.equal(picture.pictureScale(3, { width: 1280, height: 800 }), 2);
  assert.equal(picture.pictureScale(2, { width: 2560, height: 1440 }), 3000 / 2560);
  assert.equal(picture.pictureScale(undefined, { width: 800, height: 600 }), 1);
  assert.equal(picture.inRect({ x: 10, y: 10 }, { x: 0, y: 0, width: 20, height: 20 }), true);
  assert.equal(picture.inRect({ x: 20, y: 10 }, { x: 0, y: 0, width: 20, height: 20 }), false, 'the far edge is outside');
  assert.equal(picture.inRect({ x: 1, y: 1 }, null), false);
});

// ── 2. Posting ────────────────────────────────────────────────────────

test('the request says where the comment was pinned, in words', () => {
  assert.equal(post.whereLine({ inApp: false, screen: '#settings/experimental', at: { tag: 'button', id: 'settings-save', text: 'Save' } }),
    'Pinned with C on Homeroom at #settings/experimental, on button "Save" (#settings-save).');
  assert.equal(post.whereLine({ inApp: true, screen: '/lists/42', at: { tag: 'div', id: '', text: 'Buy milk' } }),
    'Pinned with C in the app at /lists/42, on div "Buy milk".');
  assert.equal(post.whereLine({ inApp: true, screen: '', at: null }), 'Pinned with C in the app at /.');
  assert.equal(post.descriptionFor('  Make it bigger  ', 'Pinned.'), 'Make it bigger\n\nPinned.');
});

function withFetch(responses, fn) {
  const calls = [];
  const prev = globalThis.window;
  globalThis.window = {
    fetch: async (url, init) => {
      calls.push({ url, init });
      const r = responses.shift();
      if (r instanceof Error) throw r;
      return { ok: r.status < 400, status: r.status, json: async () => r.body || {} };
    },
  };
  return Promise.resolve(fn(calls)).finally(() => { globalThis.window = prev; });
}

const blob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });
const base = { text: 'Make it bigger', target: 'app', appSlug: 'demo', shots: [{ blob, pins: [] }], where: 'Pinned with C in the app at /.' };

test('a comment is the dialog\'s two requests: the picture, then the request naming it', () => withFetch([
  { status: 200, body: { id: 'a'.repeat(32) } },
  { status: 200, body: { url: 'u', homeroomBot: { botWillBuild: true } } },
], async (calls) => {
  const out = await post.postComment(base);
  assert.deepEqual(out, { ok: true, botWillBuild: true, url: 'u', title: '', bounty: null });
  assert.equal(calls[0].url, '/api/feedback/screenshot');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/octet-stream');
  assert.equal(calls[0].init.body, blob);
  assert.equal(calls[1].url, '/api/feedback');
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    description: 'Make it bigger\n\nPinned with C in the app at /.',
    target: 'app', appSlug: 'demo', screenshotIds: ['a'.repeat(32)],
  });
}));

test('Homeroom gets no app slug, and a comment without a picture makes one request', () => withFetch([
  { status: 200, body: {} },
], async (calls) => {
  await post.postComment({ ...base, target: 'platform', shots: [] });
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].init.body), { description: 'Make it bigger\n\nPinned with C in the app at /.', target: 'platform' });
}));

test('a picture the server will not take does not cost the words', () => withFetch([
  { status: 400, body: { error: 'Not a PNG or JPEG' } },
  { status: 200, body: {} },
], async (calls) => {
  assert.deepEqual(await post.postComment(base), { ok: true, botWillBuild: false, url: '', title: '', bounty: null });
  assert.equal(JSON.parse(calls[1].init.body).screenshotIds, undefined);
}));

const imageA = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });
const imageB = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1])], { type: 'image/png' });
const full = {
  ...base,
  shots: [{ blob, pins: [{ x: 0.25, y: 0.5, note: 'Make the Join   button\nbigger' }] }],
  images: [imageA, imageB],
  title: '  Bigger Join button  ',
  bounty: true,
  text: 'Make the Join   button\nbigger',
};

test('the box posts every picture first, then its title, Kudos and the page\'s pin beside its picture', () => withFetch([
  { status: 200, body: { id: 'a'.repeat(32) } },
  { status: 200, body: { id: 'b'.repeat(32) } },
  { status: 200, body: { id: 'c'.repeat(32) } },
  { status: 200, body: { url: 'https://github.com/o/r/issues/4490', title: 'Bigger Join button', bounty: { placed: true, remaining: 4 } } },
], async (calls) => {
  const out = await post.postComment(full);
  assert.deepEqual(out, {
    ok: true, botWillBuild: false, url: 'https://github.com/o/r/issues/4490', title: 'Bigger Join button',
    bounty: { placed: true, remaining: 4, error: undefined },
  });
  assert.deepEqual(calls.slice(0, 3).map((c) => c.init.body), [blob, imageA, imageB], 'the page first, then the person\'s own');
  assert.deepEqual(JSON.parse(calls[3].init.body), {
    description: 'Make the Join   button\nbigger\n\nPinned with C in the app at /.',
    target: 'app', appSlug: 'demo', title: 'Bigger Join button', bounty: true,
    screenshotIds: ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)],
    screenshotPins: [{ id: 'a'.repeat(32), x: 0.25, y: 0.5, note: 'Make the Join button bigger' }],
  });
  assert.equal(post.numberFromUrl(out.url), 4490);
  assert.equal(post.numberFromUrl(''), null);
}));

test('no more than three pictures, and a pin only on a picture the server took', () => withFetch([
  { status: 400, body: { error: 'Screenshot too large' } },
  { status: 200, body: { id: 'b'.repeat(32) } },
  { status: 200, body: { id: 'c'.repeat(32) } },
  { status: 200, body: {} },
], async (calls) => {
  await post.postComment({ ...full, images: [imageA, imageB, imageA] });
  assert.equal(calls.length, 4, 'the fourth image is never sent');
  const body = JSON.parse(calls[3].init.body);
  assert.deepEqual(body.screenshotIds, ['b'.repeat(32), 'c'.repeat(32)]);
  assert.equal(body.screenshotPins, undefined, 'the page was refused, so there is nothing to pin');
}));

test('a request of several comments numbers them, and each picture carries its own comments\' pins', () => withFetch([
  { status: 200, body: { id: 'a'.repeat(32) } },
  { status: 200, body: { id: 'b'.repeat(32) } },
  { status: 200, body: { url: 'https://github.com/o/r/issues/4491' } },
], async (calls) => {
  const texts = ['The Join button is too small', '  Pace should say min per km  ', 'And the list wraps'];
  assert.equal(post.numberedWords(texts), '1. The Join button is too small\n\n2. Pace should say min per km\n\n3. And the list wraps');
  assert.equal(post.numberedWords(['  Just one  ', '']), 'Just one', 'one comment reads as it always has');
  const where = post.whereLines([
    { inApp: true, screen: '/runs', at: { tag: 'button', id: '', text: 'Join' } },
    { inApp: true, screen: '/runs', at: null },
  ]);
  assert.equal(where, 'Pinned with C in the app at /runs: 1 on button "Join"; 2 on the page.');
  assert.equal(post.whereLines([
    { inApp: true, screen: '/runs', at: { tag: 'button', id: '', text: 'Join' } },
    { inApp: false, screen: '#home', at: { tag: 'h1', id: 'hi', text: 'Home' } },
  ]), 'Pinned with C: 1 in the app at /runs, on button "Join"; 2 on Homeroom at #home, on h1 "Home" (#hi).');
  assert.equal(post.whereLines([{ inApp: false, screen: '#x', at: null }]), 'Pinned with C on Homeroom at #x.');

  const shotB = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 2])], { type: 'image/png' });
  await post.postComment({
    ...base,
    text: post.numberedWords(texts),
    shots: [
      { blob, pins: [{ x: 0.1, y: 0.2, n: 1, note: texts[0] }, { x: 0.3, y: 0.4, n: 2, note: texts[1] }] },
      { blob: shotB, pins: [{ x: 0.5, y: 0.6, n: 3, note: texts[2] }] },
    ],
    where,
  });
  assert.deepEqual(JSON.parse(calls[2].init.body).screenshotPins, [
    { id: 'a'.repeat(32), x: 0.1, y: 0.2, n: 1, note: 'The Join button is too small' },
    { id: 'a'.repeat(32), x: 0.3, y: 0.4, n: 2, note: 'Pace should say min per km' },
    { id: 'b'.repeat(32), x: 0.5, y: 0.6, n: 3, note: 'And the list wraps' },
  ]);
  assert.equal(post.MAX_COMMENTS, feedbackRoute.MAX_PINS_PER_ISSUE, 'the box stops where the server does');
}));

test('a refusal with a reason stays in the box; failures hand the comment to the dialog', async () => {
  await withFetch([{ status: 200, body: { id: 'x' } }, { status: 400, body: { error: 'Too long.' } }], async () => {
    assert.deepEqual(await post.postComment(base), { ok: false, handover: false, error: 'Too long.' });
  });
  await withFetch([{ status: 200, body: { id: 'x' } }, { status: 503 }], async () => {
    assert.deepEqual(await post.postComment(base), { ok: false, handover: true });
  });
  await withFetch([new TypeError('Failed to fetch')], async () => {
    assert.deepEqual(await post.postComment(base), { ok: false, handover: true });
  });
  await withFetch([{ status: 502 }], async () => {
    assert.deepEqual(await post.postComment(base), { ok: false, handover: true }, 'the picture upload failing too');
  });
});

test('handing over opens the dialog with the words, the pictures, the pin, the title, Kudos and the destination', () => {
  const prev = globalThis.window;
  let got = null;
  globalThis.window = { App: { openFeedbackModal: (opts) => { got = opts; } } };
  try {
    post.handOver({ ...base, target: 'platform' });
    assert.deepEqual(got, { target: 'platform', description: 'Make it bigger\n\nPinned with C in the app at /.', screenshots: [{ blob }] });
    post.handOver(full);
  } finally {
    globalThis.window = prev;
  }
  assert.deepEqual(got, {
    target: 'app',
    description: 'Make the Join   button\nbigger\n\nPinned with C in the app at /.',
    screenshots: [{ blob, pins: [{ x: 0.25, y: 0.5, n: null, note: 'Make the Join button bigger' }] }, { blob: imageA }, { blob: imageB }],
    title: 'Bigger Join button',
    bounty: true,
  });

  const fc = read('frontend/src/features/dialogs/feedback-controller.js');
  assert.match(fc, /if \(opts\.target === 'platform'\) setFeedbackTarget\('platform'\);/);
  assert.match(fc, /feedbackText\.value = typed \? `\$\{typed\}\\n\\n\$\{opts\.description\}` : opts\.description;/,
    'added after anything already typed, never over it');
  assert.match(fc, /void attachScreenshotBlob\(handed\.blob, Array\.isArray\(handed\.pins\) \? handed\.pins : null\);/, 'each picture, its pins beside it');
  assert.match(fc, /feedbackTitle\.value = opts\.title\.trim\(\)\.slice\(0, 200\);\s*titleDirty = true;/,
    'the title the box showed is kept, not dropped as a stale suggestion');
  assert.match(fc, /if \(opts\.bounty === true && !bountyCheckbox\.disabled\) bountyCheckbox\.checked = true;/);
  // The form sends the pins beside the pictures it was handed with.
  assert.match(fc, /const pinned = screenshots\.filter\(\(shot\) => shot\.id && shot\.pins && shot\.pins\.length\)\s*\.flatMap\(/);
  assert.match(fc, /if \(pinned\.length\) body\.screenshotPins = pinned;/);
});

// ── 2b. The pin as data (#4482) ───────────────────────────────────────

const pinData = loadTsx('frontend/src/features/comment-pin/pin-data.ts');
const feedbackRoute = require('../src/routes/feedback.js');

test('the server writes the pin onto its picture\'s link by the rule the page reads it back with', () => {
  const notes = [
    'Make it bigger',
    'Join (the button) & the #list, 100% wider! *really*',
    'Préférences: “quotes” and 日本語 and 🏃‍♀️',
    '  spaced\n\n  out  ',
    'x'.repeat(400),
    '日本語'.repeat(120),
    '',
  ];
  for (const note of notes) {
    const pin = { x: 0.123456, y: 0.98765, note };
    assert.equal(feedbackRoute.pinFragment(pin), pinData.pinFragment(pin), `the same fragment for ${JSON.stringify(note.slice(0, 20))}`);
    const back = pinData.readPin(`https://app.onhomeroom.com/issue-images/${'a'.repeat(32)}${feedbackRoute.pinFragment(pin)}`);
    assert.deepEqual(back, { x: 0.1235, y: 0.9877, note: pinData.fitNote(note) });
    assert.ok(feedbackRoute.pinFragment(pin).length <= 40 + pinData.NOTE_ENCODED_MAX, 'inside the body\'s reserve');
    assert.doesNotMatch(feedbackRoute.pinFragment(pin), /[()\s]/, 'safe inside Markdown\'s parentheses');
  }
  assert.equal(pinData.readPin('https://x/issue-images/abc'), null);
  assert.equal(pinData.readPin('https://x/issue-images/abc#pin=1.2,0.5'), null);
  assert.equal(pinData.readPin('https://x/issue-images/abc#pin=-0.1,0.5'), null);
  assert.equal(pinData.readPin('https://x/issue-images/abc#pin=a,b'), null);
});

test('a post may pin its own screenshots, on the picture, with words and numbers', () => {
  const id = 'a'.repeat(32);
  const ok = feedbackRoute.parseScreenshotPins({ screenshotPins: [{ id, x: 0, y: 1, note: 'Here' }] }, [id]);
  assert.equal(ok.ok, true);
  assert.deepEqual([...ok.pins], [[id, [{ x: 0, y: 1, n: null, note: 'Here' }]]]);
  assert.deepEqual(feedbackRoute.parseScreenshotPins({}, [id]), { ok: true, pins: new Map() });
  const refuse = (pins, ids = [id]) => feedbackRoute.parseScreenshotPins({ screenshotPins: pins }, ids).ok;
  assert.equal(refuse('nope'), false);
  assert.equal(refuse([{ id: 'b'.repeat(32), x: 0.5, y: 0.5 }]), false, 'not one of the attached screenshots');
  assert.equal(refuse([{ id, x: 1.5, y: 0.5 }]), false, 'off the picture');
  assert.equal(refuse([{ id, x: Number.NaN, y: 0.5 }]), false);
  assert.equal(refuse([{ id, x: '0.5', y: 0.5 }]), false);
  assert.equal(refuse([{ id, x: 0.5, y: 0.5, note: 7 }]), false);
  assert.equal(refuse([{ id, x: 0.5, y: 0.5, n: 0 }]), false, 'a number counts from 1');
  assert.equal(refuse([{ id, x: 0.5, y: 0.5, n: 1.5 }]), false);
  assert.equal(feedbackRoute.MAX_PINS_PER_ISSUE, 8);
  assert.equal(refuse(Array.from({ length: 9 }, (_, i) => ({ id, x: 0.1, y: 0.1, n: i + 1 }))), false, 'eight pins at most');
  const several = feedbackRoute.parseScreenshotPins({ screenshotPins: [
    { id, x: 0.1, y: 0.2, n: 1, note: 'One' }, { id, x: 0.3, y: 0.4, n: 2, note: 'Two' },
  ] }, [id]);
  assert.equal(feedbackRoute.buildScreenshotsEmbed([id], 'd', several.pins),
    `\n\n**Screenshot:**\n![Screenshot](https://d/issue-images/${id}#pin=0.1,0.2&n=1&note=One&pin=0.3,0.4&n=2&note=Two)`);
  // Eight long notes share the reserve: the whole fragment stays inside it.
  const eight = feedbackRoute.parseScreenshotPins({ screenshotPins: Array.from({ length: 8 }, (_, i) => ({
    id, x: 0.123456, y: 0.654321, n: i + 1, note: '日本語'.repeat(100),
  })) }, [id]);
  const embed = feedbackRoute.buildScreenshotsEmbed([id, 'b'.repeat(32), 'c'.repeat(32)], 'app.onhomeroom.com', eight.pins);
  assert.ok(embed.length < 1536 - 400, `the embed (${embed.length}) leaves the reserve room for the route's other lines`);
  assert.deepEqual(pinData.readPins(embed.match(/\((https:[^)]+)\)/)[1]).map((p) => p.n), [1, 2, 3, 4, 5, 6, 7, 8]);

  const one = feedbackRoute.buildScreenshotsEmbed([id], 'app.onhomeroom.com', ok.pins);
  assert.equal(one, `\n\n**Screenshot:**\n![Screenshot](https://app.onhomeroom.com/issue-images/${id}#pin=0,1&note=Here)`);
  const two = feedbackRoute.buildScreenshotsEmbed(['c'.repeat(32), id], 'app.onhomeroom.com', ok.pins);
  assert.match(two, new RegExp(`!\\[Screenshot 1\\]\\(https://app\\.onhomeroom\\.com/issue-images/${'c'.repeat(32)}\\)`), 'only the pinned one carries it');
  assert.match(two, new RegExp(`!\\[Screenshot 2\\]\\(https://app\\.onhomeroom\\.com/issue-images/${id}#pin=0,1&note=Here\\)`));
  assert.equal(feedbackRoute.buildScreenshotsEmbed([id], 'd'), feedbackRoute.buildScreenshotEmbed(id, 'd'), 'no pins, the lines as they were');
  const route = read('src/routes/feedback.js');
  assert.match(route, /const parsedPins = parseScreenshotPins\(req\.body, screenshotIds\);\s*if \(!parsedPins\.ok\) return res\.status\(400\)/,
    'checked before anything is filed');
  assert.match(route, /buildScreenshotsEmbed\(screenshotIds, require\('\.\.\/services\/caddy'\)\.USERNODE_DOMAIN, parsedPins\.pins\)/);
});

// ── 3. The app's picture ──────────────────────────────────────────────

const PLATFORM = 'https://app.onhomeroom.com';

function snapshotHarness({ config = { platform_origin: PLATFORM }, top = false, appSnapdom } = {}) {
  const posted = [];
  const injected = [];
  const captures = [];
  let onMessage = null;
  const canvas = { toBlob(cb, type) { cb({ fake: 'blob', type }); } };
  const window = {
    innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 700,
    addEventListener(type, fn) { if (type === 'message') onMessage = fn; },
    fetch: async (url) => ({ ok: !!config, json: async () => config, url }),
    getComputedStyle: () => ({ backgroundColor: 'rgb(255, 251, 230)' }),
  };
  if (appSnapdom !== undefined) window.snapdom = appSnapdom;
  const parent = { postMessage(message, origin) { posted.push({ message, origin }); } };
  window.parent = top ? window : parent;
  const document = {
    head: { appendChild(s) { injected.push(s); s.parentNode = this; } },
    documentElement: {},
    body: { tag: 'body' },
    createElement: () => ({ remove() {} }),
    elementFromPoint: (x, y) => ({ tagName: 'DIV', id: 'row-19', textContent: `Row at ${x},${y}`, getAttribute: () => null }),
  };
  document.head.removeChild = () => {};
  const location = { pathname: '/lists/7', search: '?token=secret' };
  vm.runInNewContext(SNAPSHOT, { window, document, location, Promise, URL, String, Math, Number, Object, isFinite });
  const fakeLib = async (el, opts) => {
    captures.push({ el, opts });
    return { toCanvas: async () => canvas };
  };
  return {
    installed: () => !!onMessage,
    ask(data, origin = PLATFORM, source = parent) { onMessage({ source, origin, data }); },
    loadLibrary() {
      const s = injected.at(-1);
      window.snapdom = fakeLib;
      s.onload();
    },
    flush: () => new Promise((r) => setTimeout(r, 0)),
    posted, injected, captures, window,
  };
}

test('only the platform\'s own origin gets the app\'s picture, and the reply goes to it alone', async () => {
  const h = snapshotHarness();
  h.ask({ __usernode_snapshot: 'render', id: 'p1', scale: 2, x: 40, y: 30 });
  await h.flush(); await h.flush();
  assert.equal(h.injected.length, 1);
  assert.equal(h.injected[0].src, '/usernode-bridge/v1/snapdom.js', 'the hosted copy, from this origin');
  h.loadLibrary();
  for (let i = 0; i < 5; i++) await h.flush();
  assert.equal(h.captures.length, 1);
  assert.equal(h.captures[0].el.tag, 'body');
  assert.deepEqual({ ...h.captures[0].opts.clip }, { x: 0, y: 700, width: 800, height: 600 }, 'what is on screen, at its scroll');
  assert.equal(h.captures[0].opts.scale, 2);
  assert.equal(h.captures[0].opts.dpr, 1, 'the scale is not multiplied by the pixel ratio twice');
  assert.equal(h.posted.length, 1);
  assert.equal(h.posted[0].origin, PLATFORM, 'posted to the platform, never "*"');
  const m = h.posted[0].message;
  assert.equal(m.__usernode_snapshot, 'picture');
  assert.equal(m.id, 'p1');
  assert.equal(m.blob.type, 'image/png');
  assert.equal(m.path, '/lists/7', 'the path, never the query that carries the token');
  assert.equal(m.at.id, 'row-19');
  assert.equal(m.at.text, 'Row at 40,30');
  assert.equal(h.window.snapdom, undefined, 'the library\'s global is gone again');
});

test('anyone else framing the app gets nothing back, not even a refusal', async () => {
  const other = snapshotHarness();
  other.ask({ __usernode_snapshot: 'render', id: 'e1' }, 'https://evil.example');
  for (let i = 0; i < 5; i++) await other.flush();
  assert.equal(other.injected.length, 0, 'nothing is even loaded');
  assert.equal(other.posted.length, 0);

  const notParent = snapshotHarness();
  notParent.ask({ __usernode_snapshot: 'render', id: 'e2' }, PLATFORM, { some: 'other window' });
  for (let i = 0; i < 5; i++) await notParent.flush();
  assert.equal(notParent.posted.length + notParent.injected.length, 0);

  for (const config of [{ platform_origin: 'http://app.onhomeroom.com' }, { platform_origin: 'https://u:p@app.onhomeroom.com' }, null, {}]) {
    const h = snapshotHarness({ config });
    h.ask({ __usernode_snapshot: 'render', id: 'c1' }, config && config.platform_origin ? new URL(config.platform_origin).origin : PLATFORM);
    for (let i = 0; i < 5; i++) await h.flush();
    assert.equal(h.posted.length + h.injected.length, 0, `refused: ${JSON.stringify(config)}`);
  }

  assert.equal(snapshotHarness({ top: true }).installed(), false, 'a top-level page installs nothing');
});

test('an app\'s own window.snapdom is put back as it was', async () => {
  const mine = function appOwn() {};
  const h = snapshotHarness({ appSnapdom: mine });
  h.ask({ __usernode_snapshot: 'render', id: 'k1', scale: 1 });
  for (let i = 0; i < 3; i++) await h.flush();
  h.loadLibrary();
  for (let i = 0; i < 5; i++) await h.flush();
  assert.equal(h.captures.length, 1, 'the bridge drew with the library it loaded');
  assert.equal(h.window.snapdom, mine);
});

test('a library that will not load is answered with an error, to the platform', async () => {
  const h = snapshotHarness();
  h.ask({ __usernode_snapshot: 'render', id: 'f1' });
  for (let i = 0; i < 3; i++) await h.flush();
  h.injected[0].onerror();
  for (let i = 0; i < 5; i++) await h.flush();
  assert.equal(h.posted.length, 1);
  assert.equal(h.posted[0].origin, PLATFORM);
  assert.match(h.posted[0].message.error, /did not load/);
});

// ── 4. The seams ──────────────────────────────────────────────────────

test('the drawing library is the pinned copy, recorded in the vendor README, served to apps', () => {
  const bytes = fs.readFileSync(path.join(ROOT, 'public/usernode-bridge/v1/snapdom.js'));
  const digest = crypto.createHash('sha384').update(bytes).digest('base64');
  assert.equal(digest, 'X1VJfUghgBqHQ1Y6iba5l0ab1AuLfNDhnTt/tiVjeokfy/D/UGmvEiAOQ6fcj1AS');
  assert.ok(read('scripts/vendor-assets.js').includes(digest), 'pinned in the vendoring script');
  assert.ok(read('public/vendor/README.md').includes(digest), 'recorded in the README');
  assert.match(bytes.toString('utf8', 0, 80), /SnapDOM\s*\n\* v3\.1\.1/);
  assert.equal(read('frontend/src/features/comment-pin/picture.ts').match(/LIB_SRC = '([^']+)'/)[1], '/usernode-bridge/v1/snapdom.js');
  assert.match(SNAPSHOT, /var LIB_SRC = "\/usernode-bridge\/v1\/snapdom\.js";/);
});

test('comment mode opens on demand into a host of its own, once, and C asks it to leave', () => {
  const src = read('frontend/src/features/comment-pin/comment-pin.tsx');
  assert.match(src, /mountLegacyPortal\(host, createElement\(CommentMode,/);
  assert.match(src, /if \(openHost \|\| typeof document === 'undefined'\) return;/, 'never a second layer');
  assert.match(src, /if \(openHost\) \{\s*if \(controller\) controller\.exit\(\);/, 'C again is Done');
  // Done keeps words nobody has posted: it asks first, and so do the box's ✕ and Esc.
  assert.match(src, /const unposted = draft \? !draft\.sending && hasWords\(draft\) : !!carry\?\.text\?\.trim\(\);\s*if \(unposted\) \{\s*setConfirm\('exit'\);/);
  assert.match(src, /if \(hasWords\(draft\)\) setConfirm\('discard'\);\s*else discard\(\);/);
  // The box is a dialog while it is up, so a C typed elsewhere stacks nothing on it.
  assert.match(src, /id="comment-pin-box"\s+role="dialog"/);
  // Each picture is drawn without the layer: no marker is ever in one.
  assert.match(src, /const promise = takeBase\(\{\s*host,/);
  // Posted clean, each picture's pins beside it, numbered when there are several.
  assert.match(src, /\.map\(\(\{ c, i \}\) => \(\{ x: c\.pin\.x, y: c\.pin\.y, n: many \? i \+ 1 : null, note: c\.text\.trim\(\) \}\)\);/);
  assert.match(src, /if \(blob\) shots\.push\(\{ blob, pins \}\);/);
  // A comment on the same view shares the earlier picture; another view is another picture, while there is room.
  assert.match(src, /const same = d\.pictures\.find\(\(pic\) => pic\.view === view\.current && pic\.screen === routeOf\(\) && pic\.base !== null\);/);
  assert.match(src, /if \(inUse \+ d\.images\.length >= MAX_PICTURES\) return \{ pictures: d\.pictures, picture: null \};/);
  // Kudos is one line that says who it is for.
  assert.match(src, />Kudos for whoever solves it</);
  // The bar: moved by its handle (four arrows, a move cursor) and kept on the device; it never hides on its own.
  assert.match(src, /const BAR_KEY = 'usernode:comment-bar';/);
  assert.match(src, /<ArrowsMoveIcon className="h-4 w-4" \/>/);
  assert.match(src, /cursor-move touch-none/);
  assert.match(src, /onDoubleClick=\{\(\) => \{ setBarAt\(null\); saveBarAt\(null\); \}\}/);
  assert.doesNotMatch(src, /DUCK_AFTER_MS|ducked|onBarEnter/, 'resting the pointer on the bar never hides it');
  // A finger: a tap is a comment, a drag scrolls.
  assert.match(src, /if \(!t\.moved\) place\(\{ x: e\.clientX, y: e\.clientY \}\);/);
  // The form is called the form.
  assert.doesNotMatch(src, /Detailed/);
  assert.doesNotMatch(read('frontend/src/features/dialogs/feedback.tsx'), />\s*Detailed\s*</);
  // The dialog's rule for when a request can go to the app, read the same way.
  assert.match(src, /!\/github\\\.com\\\/\[\^\/\]\+\\\/\[\^\/\]\+\/\.test\(data\.repo_url \|\| ''\) \|\| data\.self_hosted/);
  assert.match(read('frontend/src/features/dialogs/feedback-controller.js'), /const hasRepo = \/github\\\.com\\\/\[\^\/\]\+\\\/\[\^\/\]\+\/\.test\(repoUrl\);/);
});
