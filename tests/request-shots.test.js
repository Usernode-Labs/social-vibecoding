'use strict';

// A request's screenshots on its page (#4481, #4482).
//
//   - #4482: a C comment's pin is data on its screenshot's link, the
//     `#pin=x,y&note=…` fragment (frontend/src/features/comment-pin/pin-data.ts),
//     and the request's page draws it over the picture as a layer the reader
//     can hide (features/dev-board/topic/request-shots.ts, used by
//     request-head.tsx `RequestWords`). The picture stays clean.
//   - #4481: with the experimental C switch on for the device, the blocks
//     that hold a screenshot leave the four-line fold and are always shown
//     under it.
//
// What is pinned, and each is a way it can be quietly wrong:
//
//   1. THE DATA. A pin survives the link both ways, whatever the words say,
//      and a link that is not a point on the picture is no pin.
//   2. THE LAYER. Only a picture with a pin gets one; the words go in as
//      text; the note sits where there is room; the button toggles it.
//   3. THE LIFT. Only with the switch, only the blocks with a screenshot,
//      and the words are what is left.
//   4. NOTHING ELSE MOVES. Without a pin or the switch, or without a parser,
//      the markup is returned byte for byte.
//
// There is no HTML parser under node, so the DOM half runs against the
// small one below: just the calls request-shots.ts makes.
//
// Run with: node --test tests/request-shots.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const PIN_DATA = 'frontend/src/features/comment-pin/pin-data.ts';
const SHOTS = 'frontend/src/features/dev-board/topic/request-shots.ts';
const HEAD = 'frontend/src/features/dev-board/topic/request-head.tsx';

const pins = loadTsx(PIN_DATA);
const shots = loadTsx(SHOTS);

// ── A small DOM ───────────────────────────────────────────────────────

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, e) => ENTITIES[e]);
const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');
const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/ /g, '&nbsp;');

class Text {
  constructor(doc, value) {
    this.nodeType = 3;
    this.ownerDocument = doc;
    this.nodeValue = value;
    this.parentNode = null;
  }
}

class El {
  constructor(doc, tag) {
    this.nodeType = 1;
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.attrs = new Map();
    this.childNodes = [];
    this.parentNode = null;
  }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  hasAttribute(name) { return this.attrs.has(name); }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  appendChild(child) { return this.insertBefore(child, null); }
  insertBefore(child, ref) {
    if (child.parentNode) child.parentNode.removeChild(child);
    const at = ref ? this.childNodes.indexOf(ref) : -1;
    this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild(child) {
    const at = this.childNodes.indexOf(child);
    if (at >= 0) this.childNodes.splice(at, 1);
    child.parentNode = null;
    return child;
  }
  cloneNode(deep) {
    assert.equal(deep, false, 'only shallow clones are asked for');
    const copy = new El(this.ownerDocument, this.tagName);
    for (const [k, v] of this.attrs) copy.attrs.set(k, v);
    return copy;
  }
  get textContent() {
    return this.childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join('');
  }
  set textContent(value) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.appendChild(new Text(this.ownerDocument, String(value)));
  }
  get innerHTML() { return this.childNodes.map(serialize).join(''); }
  // `tag.class` only: what togglePinShot asks for.
  closest(selector) {
    const [tag, cls] = selector.split('.');
    for (let at = this; at && at.nodeType === 1; at = at.parentNode) {
      if (at.tagName === tag.toUpperCase() && ` ${at.getAttribute('class') || ''} `.includes(` ${cls} `)) return at;
    }
    return null;
  }
  contains(other) {
    for (let at = other; at; at = at.parentNode) if (at === this) return true;
    return false;
  }
}

function serialize(node) {
  if (node.nodeType === 3) return escText(node.nodeValue);
  const tag = node.tagName.toLowerCase();
  const attrs = [...node.attrs].map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('');
  if (VOID.has(tag)) return `<${tag}${attrs}>`;
  return `<${tag}${attrs}>${node.innerHTML}</${tag}>`;
}

/** Parses well-formed markup (what a sanitiser writes) into a <body>. */
function parse(html) {
  const doc = { createElement: (tag) => new El(doc, tag) };
  const body = new El(doc, 'body');
  const open = [body];
  const token = /<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|([^<]+)/g;
  let m;
  while ((m = token.exec(html))) {
    const top = open[open.length - 1];
    if (m[1]) {
      const at = open.map((e) => e.tagName).lastIndexOf(m[1].toUpperCase());
      if (at > 0) open.length = at;
    } else if (m[2]) {
      const el = new El(doc, m[2]);
      const attr = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let a;
      while ((a = attr.exec(m[3] || ''))) el.setAttribute(a[1].toLowerCase(), decode(a[2] ?? a[3] ?? a[4] ?? ''));
      top.appendChild(el);
      if (!VOID.has(el.tagName.toLowerCase())) open.push(el);
    } else {
      top.appendChild(new Text(doc, decode(m[4])));
    }
  }
  return body;
}

// ── Fixtures: the markup DevChat.renderMarkdown writes ────────────────

const ID = '0123456789abcdef0123456789abcdef';
const SRC = `https://app.example/issue-images/${ID}`;
// What the renderer makes of `![alt](src)`: the picture, its own link to the full file.
const picture = (src, alt = 'Screenshot') => {
  const s = src.replace(/&/g, '&amp;');
  return `<a class="dc-inline-img-link" href="${s}" target="_blank" rel="noopener noreferrer" aria-label="View image full size">`
    + `<img class="dc-inline-img" src="${s}" alt="${alt}" loading="lazy"></a>`;
};
const words = (...blocks) => `<div class="dev-issue-body">${blocks.join('\n')}</div>`;
const PINNED = `${SRC}${pins.pinFragment({ x: 0.4213, y: 0.318, note: 'Make it bigger' })}`;
const SHOT_BLOCK = (src = SRC) => `<p class="dc-p"><strong>Screenshot:</strong><br>${picture(src)}</p>`;

// ── 1. The data ───────────────────────────────────────────────────────

test('a pin goes onto the link and comes back off it, whatever its words say', () => {
  const back = (pin) => pins.readPin(`${SRC}${pins.pinFragment(pin)}`);
  assert.equal(pins.pinFragment({ x: 0.42134, y: 0.318, note: 'Make it bigger' }), '#pin=0.4213,0.318&note=Make%20it%20bigger');
  for (const note of [
    'Make it bigger',
    'Fix (this) & that, see #2 [here]!',
    'a=b&c=d#frag',
    "Größer bitte, l'été 🎉 漢字",
    '*stars* and _under_ (and) 100%',
  ]) {
    const pin = back({ x: 0.25, y: 0.75, note });
    assert.deepEqual({ ...pin }, { x: 0.25, y: 0.75, note: pins.fitNote(note) }, note);
    assert.equal(pin.note, note, `${note}: short words come back as they went`);
  }
  // Markdown's parentheses and a fragment's `&` and `#` are escaped on the link.
  const fragment = pins.pinFragment({ x: 0.5, y: 0.5, note: 'Fix (this) & that #2' });
  assert.doesNotMatch(fragment.slice(1), /[()#\s]|&(?!note=)/);

  const long = 'word '.repeat(60).trim(); // 299 characters
  const cut = back({ x: 0, y: 1, note: long });
  assert.equal(cut.note, pins.fitNote(long));
  assert.equal(Array.from(cut.note).length, pins.NOTE_MAX);
  assert.match(cut.note, /…$/);
  assert.equal(back({ x: 0.1, y: 0.1, note: 'a'.repeat(300) }).note, `${'a'.repeat(279)}…`);

  const wide = '🎉'.repeat(300);
  const fitted = back({ x: 0.5, y: 0.5, note: wide });
  assert.equal(fitted.note, pins.fitNote(wide));
  assert.ok(pins.encodeNote(fitted.note).length <= pins.NOTE_ENCODED_MAX, 'the encoded note fits the body');

  assert.deepEqual({ ...back({ x: 0.5, y: 0.5, note: '' }) }, { x: 0.5, y: 0.5, note: '' }, 'no words, still a pin');
  assert.equal(pins.pinFragment({ x: 0.5, y: 0.5, note: '  ' }), '#pin=0.5,0.5');
});

test('a link that is not a point on the picture carries no pin', () => {
  for (const url of [
    SRC,
    `${SRC}#`,
    `${SRC}#top`,
    `${SRC}#pin=`,
    `${SRC}#pin=1.2,0.5`,
    `${SRC}#pin=0.5,1.0001`,
    `${SRC}#pin=-0.1,0.5`,
    `${SRC}#pin=0.5,-0`,
    `${SRC}#pin=a,b`,
    `${SRC}#pin=0.5`,
    `${SRC}#pin=0.5,0.5,0.5`,
    `${SRC}#pin=.5,.5`,
    `${SRC}#pin=1e-1,0.5`,
    null,
    undefined,
    '',
  ]) assert.equal(pins.readPin(url), null, String(url));
  assert.deepEqual({ ...pins.readPin(`${SRC}#pin=1,0&note=%E0%A4%A`) }, { x: 1, y: 0, note: '' }, 'a broken note is dropped, not the pin');
});

// ── 2. The layer ──────────────────────────────────────────────────────

test('the note sits right of the pin and above the point, flipping near the right edge and the top', () => {
  const { pinPlacement } = shots;
  assert.deepEqual({ ...pinPlacement({ x: 0.4213, y: 0.318 }) }, { x: '42.13%', y: '31.8%', side: 'right', rise: 'up' });
  assert.equal(pinPlacement({ x: 0.6, y: 0.5 }).side, 'right');
  assert.equal(pinPlacement({ x: 0.61, y: 0.5 }).side, 'left', 'in the right 40%, the note goes left');
  assert.equal(pinPlacement({ x: 0.5, y: 0.25 }).rise, 'up');
  assert.equal(pinPlacement({ x: 0.5, y: 0.2 }).rise, 'down', 'near the top, it hangs below');
  assert.deepEqual({ ...pinPlacement({ x: 1, y: 0 }) }, { x: '100%', y: '0%', side: 'left', rise: 'down' });
});

test('a pinned picture gets the comment as a layer over it and a button; the picture is untouched', () => {
  const html = words('<p class="dc-p">The header is too small.</p>', `<p class="dc-p"><strong>Screenshot:</strong><br>${picture(PINNED)}</p>`);
  const out = shots.requestShots(html, { parse });
  assert.equal(out.shots, '', 'no lift without the switch');
  const escaped = PINNED.replace(/&/g, '&amp;');
  assert.equal(out.words, words(
    '<p class="dc-p">The header is too small.</p>',
    '<p class="dc-p"><strong>Screenshot:</strong><br>'
      + '<span class="pin-shot" data-pin-shot="">'
      + `<a class="dc-inline-img-link" href="${escaped}" target="_blank" rel="noopener noreferrer" aria-label="View image full size">`
      + `<img class="dc-inline-img" src="${escaped}" alt="Screenshot" loading="lazy"></a>`
      + '<button class="pin-shot-toggle touch-target-32" type="button" data-shown="true">Hide comment</button>'
      + '<span class="pin-shot-layer" aria-hidden="true">'
      + '<span class="pin-shot-mark" data-side="right" data-rise="up" style="--pin-x: 42.13%; --pin-y: 31.8%">'
      + '<span class="pin-shot-pin"></span><span class="pin-shot-note">Make it bigger</span></span></span>'
      + '</span></p>',
  ));
});

test('the note is text, never markup, and a pin with no words is a pin alone', () => {
  const note = '<img src=x onerror=alert(1)> & <b>bold</b>';
  const src = `${SRC}${pins.pinFragment({ x: 0.8, y: 0.1, note })}`;
  const out = shots.requestShots(words(`<p>${picture(src)}</p>`), { parse });
  assert.match(out.words, /data-side="left" data-rise="down"/);
  assert.match(out.words, /<span class="pin-shot-note">&lt;img src=x onerror=alert\(1\)&gt; &amp; &lt;b&gt;bold&lt;\/b&gt;<\/span>/);
  assert.equal((out.words.match(/<img/g) || []).length, 1, 'the only picture is the screenshot');

  const bare = shots.requestShots(words(`<p>${picture(`${SRC}${pins.pinFragment({ x: 0.5, y: 0.5, note: '' })}`)}</p>`), { parse });
  assert.match(bare.words, /<span class="pin-shot-mark"[^>]*><span class="pin-shot-pin"><\/span><\/span>/);
  assert.doesNotMatch(bare.words, /pin-shot-note/);
});

test('a picture with several comments\' pins numbers each, with its own note and place, under one button', () => {
  const frag = pins.pinsFragment([
    { x: 0.2, y: 0.5, n: 1, note: 'First thing' },
    { x: 0.9, y: 0.1, n: 2, note: 'Second thing' },
  ]);
  assert.deepEqual(pins.readPins(`${SRC}${frag}`), [
    { x: 0.2, y: 0.5, n: 1, note: 'First thing' },
    { x: 0.9, y: 0.1, n: 2, note: 'Second thing' },
  ]);
  const out = shots.requestShots(words(`<p>${picture(`${SRC}${frag}`)}</p>`), { parse });
  assert.match(out.words, /<button class="pin-shot-toggle touch-target-32" type="button" data-shown="true" data-many="">Hide comments<\/button>/);
  assert.match(out.words, /<span class="pin-shot-mark" data-side="right" data-rise="up" style="--pin-x: 20%; --pin-y: 50%"><span class="pin-shot-pin">1<\/span><span class="pin-shot-note">First thing<\/span><\/span>/);
  assert.match(out.words, /<span class="pin-shot-mark" data-side="left" data-rise="down" style="--pin-x: 90%; --pin-y: 10%"><span class="pin-shot-pin">2<\/span><span class="pin-shot-note">Second thing<\/span><\/span>/);
  assert.equal(shots.pinToggleLabel(false, true), 'Show comments');
  // A number that is not a small whole number is no number, and a note before any pin belongs to none.
  assert.deepEqual(pins.readPins(`${SRC}#note=stray&pin=0.5,0.5&n=x&note=ok`), [{ x: 0.5, y: 0.5, n: null, note: 'ok' }]);
});

test('only pictures with a pin are wrapped: a plain screenshot, a bad pin and another link stay as they were', () => {
  const plain = picture(SRC);
  const bad = picture(`${SRC}#pin=1.5,0.5&note=x`);
  const authored = '<a href="https://example.com/notes"><img src="https://example.com/a.png" alt="A"></a>';
  const bareImg = `<img class="dc-inline-img" src="${PINNED.replace(/&/g, '&amp;')}" alt="Screenshot 2" loading="lazy">`;
  const out = shots.requestShots(words(`<p>${plain}<br>${bad}<br>${authored}<br>${bareImg}</p>`), { parse });
  assert.equal((out.words.match(/class="pin-shot"/g) || []).length, 1);
  assert.ok(out.words.includes(`<p>${plain}<br>${bad}<br>${authored}<br><span class="pin-shot" data-pin-shot=""><img class="dc-inline-img"`),
    'the three unpinned pictures are byte for byte, and a picture with no link of its own is wrapped itself');
});

test('the corner button hides the comment and shows it again, and nothing else is a toggle', () => {
  const out = shots.requestShots(words(`<p>${picture(PINNED)}</p>`), { parse });
  const scope = parse(out.words);
  const shot = scope.childNodes[0].childNodes[0].childNodes[0];
  assert.equal(shot.getAttribute('class'), 'pin-shot');
  const [link, button, layer] = shot.childNodes;
  assert.equal(button.tagName, 'BUTTON');

  assert.equal(shots.togglePinShot(button, scope), true);
  assert.equal(button.getAttribute('data-shown'), 'false');
  assert.equal(button.textContent, 'Show comment');
  assert.equal(shots.togglePinShot(button, scope), true);
  assert.equal(button.getAttribute('data-shown'), 'true');
  assert.equal(button.textContent, 'Hide comment');

  assert.equal(shots.togglePinShot(link.childNodes[0], scope), false, 'the picture opens the viewer, as before');
  assert.equal(shots.togglePinShot(layer, scope), false);
  assert.equal(shots.togglePinShot(button, parse('<p></p>')), false, 'another surface\'s button is not this one\'s');
  assert.equal(shots.togglePinShot(null, scope), false);
  assert.equal(button.getAttribute('data-shown'), 'true');

  // The layer is hidden by the button's state alone, and it follows the button.
  const css = read('public/css/app.css');
  assert.match(css, /\.pin-shot-toggle\[data-shown="false"\] \+ \.pin-shot-layer \{ opacity: 0; visibility: hidden; \}/);
  assert.match(css, /\.pin-shot \{ position: relative; display: block; width: fit-content; max-width: 100%; margin: 6px 0; \}/);
  assert.match(css, /\.pin-shot-pin \{[^}]*border-radius: 50% 50% 50% 0;[^}]*background: var\(--accent\);[^}]*transform: translateY\(-100%\);/,
    'the square corner on the point');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\n\s+\.pin-shot-layer \{ transition: none; \}/);
});

// ── 3. The lift ───────────────────────────────────────────────────────

test('with the switch, the blocks that hold a screenshot leave the words, in the renderer\'s box', () => {
  const ask = '<p class="dc-p">The header is too small.</p>';
  const after = '<p class="dc-p"><strong>Saved offline:</strong> today</p>';
  const html = words(ask, SHOT_BLOCK(), after);
  const out = shots.requestShots(html, { lift: true, parse });
  assert.equal(out.words, words(ask, '', after));
  assert.equal(out.shots, words(SHOT_BLOCK()));

  const two = `<p class="dc-p"><strong>Screenshots:</strong><br>${picture(`${SRC}1`, 'Screenshot 1')}<br>${picture(PINNED, 'Screenshot 2')}</p>`;
  const both = shots.requestShots(words(ask, two), { lift: true, parse });
  assert.equal(both.words, words(ask, ''));
  assert.match(both.shots, /^<div class="dev-issue-body"><p class="dc-p"><strong>Screenshots:<\/strong><br><a [^>]*><img [^>]*alt="Screenshot 1"[^>]*><\/a><br><span class="pin-shot"/,
    'one block, both pictures, and the pinned one keeps its layer');

  const only = shots.requestShots(words(SHOT_BLOCK()), { lift: true, parse });
  assert.deepEqual({ ...only }, { words: '', shots: words(SHOT_BLOCK()) }, 'nothing left to fold');

  const loose = shots.requestShots(`${ask}\n${SHOT_BLOCK()}`, { lift: true, parse });
  assert.deepEqual({ ...loose }, { words: `${ask}\n`, shots: SHOT_BLOCK() }, 'markup with no box of its own');
});

test('with the switch, a picture that is not a screenshot stays in the words', () => {
  const other = `<p>${picture('https://example.com/diagram.png', 'A diagram')}</p>`;
  const html = words('<p>See</p>', other);
  assert.equal(shots.requestShots(html, { lift: true, parse }).words, html);
  assert.equal(shots.requestShots(html, { lift: true, parse }).shots, '');
});

// ── 4. Nothing else moves ─────────────────────────────────────────────

test('without a pin or the switch, or without a parser, the markup is returned as it came', () => {
  const html = words('<p class="dc-p">Words &amp; more</p>', SHOT_BLOCK());
  let parsed = 0;
  const counting = (h) => { parsed += 1; return parse(h); };
  for (const out of [
    shots.requestShots(html, { parse: counting }),
    shots.requestShots(words('<p>Just words</p>'), { lift: true, parse: counting }),
    shots.requestShots('', { lift: true, parse: counting }),
  ]) assert.equal(out.shots, '');
  assert.equal(shots.requestShots(html, { parse: counting }).words, html);
  assert.equal(parsed, 0, 'nothing to change, nothing parsed');

  const pinned = words(`<p>${picture(PINNED)}</p>`);
  assert.deepEqual({ ...shots.requestShots(pinned, { lift: true, parse: () => null }) }, { words: pinned, shots: '' });
  assert.equal(typeof DOMParser, 'undefined', 'node has no DOMParser');
  assert.deepEqual({ ...shots.requestShots(pinned, { lift: true }) }, { words: pinned, shots: '' }, 'a server render draws the markup as given');
  // A pin's text with no picture under it changes nothing.
  const said = words('<p>The link ended in #pin=0.5,0.5 and /issue-images/ was in it</p>');
  assert.equal(shots.requestShots(said, { lift: true, parse }).words, said);
});

// ── The words on the page ─────────────────────────────────────────────

function withSwitch(on, run) {
  const before = { window: global.window, DOMParser: global.DOMParser };
  global.window = { localStorage: { getItem: (key) => (on && key === 'usernode:suggest-shortcut' ? '1' : null) } };
  global.DOMParser = class { parseFromString(html) { return { body: parse(html) }; } };
  try {
    return run();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete global[k]; else global[k] = v;
    }
  }
}

test('the page folds the words and, with the switch, shows the screenshots after the fold', () => {
  const { RequestWords } = loadTsx(HEAD);
  const html = words('<p class="dc-p">The header is too small.</p>', `<p class="dc-p"><strong>Screenshot:</strong><br>${picture(PINNED)}</p>`);

  const off = withSwitch(false, () => renderToHtml(createElement(RequestWords, { html })));
  assert.match(off, /^<div class="dev-request-ask"><div class="dev-request-ask-text line-clamp-4" data-request-words=""><div class="dev-issue-body">[\s\S]*class="pin-shot"[\s\S]*<\/div><\/div><\/div>$/,
    'switch off: the screenshot stays in the words, with its comment');
  assert.doesNotMatch(off, /data-request-shots/);

  const on = withSwitch(true, () => renderToHtml(createElement(RequestWords, { html })));
  assert.equal(on, '<div class="dev-request-ask">'
    + '<div class="dev-request-ask-text line-clamp-4" data-request-words=""><div class="dev-issue-body"><p class="dc-p">The header is too small.</p>\n</div></div>'
    + `<div class="dev-request-shots" data-request-shots="">${shots.requestShots(html, { lift: true, parse }).shots}</div>`
    + '</div>');

  const only = withSwitch(true, () => renderToHtml(createElement(RequestWords, { html: words(SHOT_BLOCK()) })));
  assert.equal(only, `<div class="dev-request-ask"><div class="dev-request-shots" data-request-shots="">${words(SHOT_BLOCK())}</div></div>`,
    'a request that is only a screenshot has no fold to open');

  // No parser (the server render): today's markup, byte for byte.
  const plain = renderToHtml(createElement(RequestWords, { html }));
  assert.equal(plain, `<div class="dev-request-ask"><div class="dev-request-ask-text line-clamp-4" data-request-words="">${html}</div></div>`);
  assert.equal(renderToHtml(createElement(RequestWords, { html: '' })), '');
});

test('the words read the switch once, take the toggle\'s click, and keep the viewer\'s scope', () => {
  const src = read(HEAD);
  assert.match(src, /import \{ suggestShortcutEnabled \} from '\.\.\/\.\.\/improve\/suggest-settings';/);
  assert.doesNotMatch(src, /suggest-shortcut'/, 'the settings, not the shortcut and its listeners');
  assert.match(src, /const \[lift\] = useState\(\(\) => suggestShortcutEnabled\(\)\);/);
  assert.match(src, /const \{ words, shots \} = useMemo\(\(\) => requestShots\(html, \{ lift \}\), \[html, lift\]\);/);
  assert.match(src, /const inner = useInnerHtml\(words\);\n\s+const shotsInner = useInnerHtml\(shots\);/,
    'the same wrapper while the string is the same, so a hidden comment stays hidden');
  assert.match(src, /if \(togglePinShot\(event\.target, event\.currentTarget\)\) event\.preventDefault\(\);/);
  assert.match(src, /<div className="dev-request-ask" onClick=\{togglePin\}>/);
  assert.match(src, /<div className="min-w-0 flex-1" \{\.\.\.images\.scope\}>[\s\S]*<RequestWords html=\{r\.bodyHtml\} \/>/,
    'the words are still inside the image viewer\'s scope');
});
