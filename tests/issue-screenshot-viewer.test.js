'use strict';

// #3908: a screenshot on a request's page opens in the app's own image
// viewer, over the page, instead of following its file link out of it.
//
// The pictures are sanitised markdown (DevChat.renderMarkdown with
// `images: true` wraps each in `a.dc-inline-img-link`), so they cannot carry
// a handler; the surface around them delegates the tap through
// features/image-viewer/image-viewer.tsx `useInlineImageViewer`. Two
// surfaces draw a request's pictures: its body
// (features/dev-board/topic/topic-head.tsx TopicBodySections) and its GitHub
// discussion (features/dev-board/issue-comments.tsx). nav-link.js's
// external-link router must leave a scope's picture links to that handler.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderComponent, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const VIEWER = 'frontend/src/features/image-viewer/image-viewer.tsx';
const HEAD_TSX = 'frontend/src/features/dev-board/topic/topic-head.tsx';
const COMMENTS_TSX = 'frontend/src/features/dev-board/issue-comments.tsx';

// The markup DevChat.renderMarkdown builds for an inline picture
// (tests/issue-discussion-images.test.js pins it there).
const PICTURE = '<a class="dc-inline-img-link" href="https://app.example/issue-images/7" target="_blank" '
  + 'rel="noopener noreferrer" aria-label="View image full size">'
  + '<img class="dc-inline-img" src="https://app.example/issue-images/7" alt="Screenshot" loading="lazy"></a>';

// Just enough of an element for `inlineImageAt`: closest() by the one
// selector it asks for, contains(), getAttribute() and querySelector('img').
function el(tag, attrs = {}, parent = null) {
  const node = {
    tag,
    attrs,
    parent,
    children: [],
    getAttribute: (name) => (Object.hasOwn(attrs, name) ? attrs[name] : null),
    closest(selector) {
      assert.equal(selector, 'a.dc-inline-img-link', 'only the renderer\'s own picture link is taken');
      for (let at = node; at; at = at.parent) {
        if (at.tag === 'a' && /\bdc-inline-img-link\b/.test(at.attrs.class || '')) return at;
      }
      return null;
    },
    contains(other) {
      for (let at = other; at; at = at.parent) if (at === node) return true;
      return false;
    },
    querySelector(selector) {
      assert.equal(selector, 'img');
      const walk = (n) => {
        for (const c of n.children) {
          if (c.tag === 'img') return c;
          const deeper = walk(c);
          if (deeper) return deeper;
        }
        return null;
      };
      return walk(node);
    },
  };
  if (parent) parent.children.push(node);
  return node;
}

function tree() {
  const scope = el('section', { 'data-image-viewer-scope': '' });
  const p = el('p', {}, scope);
  const link = el('a', { class: 'dc-inline-img-link', href: '/issue-images/abc' }, p);
  const img = el('img', { class: 'dc-inline-img', src: '/issue-images/abc', alt: 'Screenshot 2' }, link);
  // An image the author linked somewhere on purpose: no picture-link class.
  const authored = el('a', { href: 'https://example.com/notes' }, p);
  const authoredImg = el('img', { class: 'dc-inline-img', src: 'https://example.com/a.png', alt: 'A' }, authored);
  const text = el('span', {}, p);
  return { scope, link, img, authored, authoredImg, text };
}

const click = (target, over = {}) => ({
  button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false,
  target,
  prevented: 0,
  preventDefault() { this.prevented += 1; this.defaultPrevented = true; },
  ...over,
});

test('a tap on a screenshot in the scope finds the picture; anything else is left alone', () => {
  const { inlineImageAt, INLINE_IMAGE_LINK } = loadTsx(VIEWER);
  assert.equal(INLINE_IMAGE_LINK, 'a.dc-inline-img-link');
  const t = tree();
  assert.deepEqual(inlineImageAt(t.img, t.scope), { src: '/issue-images/abc', alt: 'Screenshot 2' },
    'the picture itself (what a tap lands on)');
  assert.deepEqual(inlineImageAt(t.link, t.scope), { src: '/issue-images/abc', alt: 'Screenshot 2' },
    'and its link (a keyboard activation)');
  assert.equal(inlineImageAt(t.authoredImg, t.scope), null, 'an authored link keeps its destination');
  assert.equal(inlineImageAt(t.text, t.scope), null, 'text is not a picture');
  assert.equal(inlineImageAt(null, t.scope), null);

  // React bubbles a portal's clicks through the component tree: a picture
  // that is not in the scope's own DOM is another surface's.
  const elsewhere = tree();
  assert.equal(inlineImageAt(elsewhere.img, t.scope), null);

  // The sanitiser drops an href it does not allow; the picture's src is the
  // same file.
  const bare = tree();
  delete bare.link.attrs.href;
  assert.equal(inlineImageAt(bare.img, bare.scope).src, '/issue-images/abc');
});

test('the scope opens the viewer on a plain tap and leaves a modified click to the link', () => {
  const { useInlineImageViewer } = loadTsx(VIEWER);
  let hook = null;
  function Probe() {
    hook = useInlineImageViewer();
    return null;
  }
  renderToHtml(createElement(Probe));
  assert.deepEqual(Object.keys(hook.scope).sort(), ['data-image-viewer-scope', 'onClick']);
  assert.equal(hook.scope['data-image-viewer-scope'], '', 'the marker nav-link.js and the declared checks read');
  assert.equal(hook.viewer, null, 'nothing until a tap: the prerendered document never has it');

  const t = tree();
  const plain = click(t.img, { currentTarget: t.scope });
  hook.scope.onClick(plain);
  assert.equal(plain.prevented, 1, 'the file link is not followed: the viewer opens over the page');

  for (const over of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
    const e = click(t.img, { currentTarget: t.scope, ...over });
    hook.scope.onClick(e);
    assert.equal(e.prevented, 0, `${Object.keys(over)[0]}: a new tab or a download on purpose`);
  }
  const claimed = click(t.img, { currentTarget: t.scope, defaultPrevented: true });
  hook.scope.onClick(claimed);
  assert.equal(claimed.prevented, 0, 'an inner surface that took the tap already keeps it');

  const authored = click(t.authoredImg, { currentTarget: t.scope });
  hook.scope.onClick(authored);
  assert.equal(authored.prevented, 0, 'an image linked somewhere on purpose goes there');
});

test('the request\'s body is a viewer scope, and so is its GitHub discussion', () => {
  const body = renderComponent(HEAD_TSX, 'TopicBodySections', {
    body: { issueBodyHtml: `<div class="dev-issue-body"><p class="dc-p">${PICTURE}</p></div>` },
  });
  assert.match(body, /<section class="dev-topic-sheet dev-topic-about" data-topic-sheet="about" data-image-viewer-scope="">[\s\S]*class="dc-inline-img-link"/,
    'the About sheet around the request\'s words takes the tap');
  assert.doesNotMatch(body, /data-image-viewer=""/, 'no viewer until a tap');

  const comments = renderComponent(COMMENTS_TSX, 'IssueCommentsView', {
    comments: [{ key: '1', author: 'reporter', bot: false, createdAt: '', bodyHtml: `<p class="dc-p">${PICTURE}</p>` }],
    truncated: false,
    htmlUrl: null,
  });
  assert.match(comments, /<div class="dev-topic-gh-thread" data-image-viewer-scope="">[\s\S]*class="dc-inline-img-link"/);
  assert.equal(renderComponent(COMMENTS_TSX, 'IssueCommentsView', { comments: [], truncated: false, htmlUrl: null }), '',
    'no comments is still no section');

  // Each renders its own viewer, which portals to <body>.
  const head = read(HEAD_TSX);
  const sections = head.slice(head.indexOf('export function TopicBodySections('));
  assert.match(sections, /const images = useInlineImageViewer\(\);[\s\S]*\{images\.viewer\}[\s\S]*data-topic-sheet="about" \{\.\.\.images\.scope\}>/);
  const thread = read(COMMENTS_TSX);
  assert.match(thread, /const images = useInlineImageViewer\(\);\n[\s\S]*if \(!comments\.length\) return null;[\s\S]*<div className="dev-topic-gh-thread" \{\.\.\.images\.scope\}>\n\s*\{images\.viewer\}/,
    'the hook runs before the early return, as hooks must');
});

test('a screenshot hosted elsewhere opens in a new tab from the viewer rather than replacing the page', () => {
  const { isRemoteFile } = loadTsx(VIEWER);
  assert.equal(isRemoteFile('/issue-images/abc'), false, 'no window: nothing is remote');
  const before = global.window;
  try {
    global.window = { location: { href: 'https://app.example/#app/x/dev/issues/1', origin: 'https://app.example' } };
    assert.equal(isRemoteFile('/issue-images/abc'), false);
    assert.equal(isRemoteFile('https://app.example/issue-images/abc'), false);
    assert.equal(isRemoteFile('https://github.com/user-attachments/assets/1'), true);
  } finally {
    if (before === undefined) delete global.window; else global.window = before;
  }
  const src = read(VIEWER);
  // #4055: a same-origin picture's Download became a button that saves it;
  // one hosted elsewhere keeps its link, in a new tab.
  assert.match(src, /\{remote \? \(\n\s*<a\n\s*href=\{src\}\n\s*target="_blank"\n\s*rel="noopener noreferrer"[\s\S]*?data-image-viewer-download=""\n\s*>\n\s*Open original\n\s*<\/a>/);
});

test('the installed app leaves a scope\'s picture links to the viewer', () => {
  const nav = read('public/js/nav-link.js');
  assert.match(nav, /anchor\.matches\('\[data-image-viewer-scope\] a\.dc-inline-img-link'\)\) return;/);
});

test('a preview can open both pictures, and a declared check sees each wired to the viewer', () => {
  const issues = read('src/routes/issues.js');
  assert.match(issues, /900010: \[\n\s*\.\.\.stampLadder\(\),[\s\S]{0,200}!\[Screenshot from a phone\]\(\/icons\/v3\/icon-192\.png\)/);
  // Folded into the #2349 check on the same route rather than declared
  // again (tests/dev-board-fold.test.js pins the count): the body's picture
  // is still the full-size file's link, now inside a viewer scope, and the
  // discussion's picture is in one too.
  const dapp = JSON.parse(read('dapp.json'));
  const check = dapp.tests.find((t) => /\/dev\/issues\/900010$/.test(t.path) && /#3908/.test(t.name));
  assert.ok(check, 'the screenshot issue\'s check names this change');
  assert.match(check.expectSelector, /^#gc-thread-head:has\(\.dev-topic-gh-thread\[data-image-viewer-scope\] \.dc-inline-img-link > \[alt="Screenshot from a phone"\]\) /);
  assert.match(check.expectSelector, / \.dev-topic-about\[data-image-viewer-scope\] \.dc-inline-img-link\[href\]\[target="_blank"\] > \.dc-inline-img$/);
  assert.equal(check.expectText, '[Mock] issue with an attached screenshot');
});
