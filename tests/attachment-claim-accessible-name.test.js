'use strict';

// #2990: two glyph-only controls with no accessible name.
//
//   1. The group-chat attachment chip's download link
//      (frontend/src/features/group-chat/transcript.tsx, `AttachmentChip`),
//      drawn beside markdown and HTML attachments, whose only child was `↓`.
//   2. The dev card's admin claim-release button
//      (frontend/src/features/dev-board/card/dev-card.tsx, the `claims`
//      extra row), whose only child was `×`.
//
// Both carried a `title` and nothing else. A title is a tooltip, and no
// assistive technology is obliged to fall back to it for a name (#2478,
// tests/dev-plus-accessible-name.test.js), so each announced as its glyph.
// The house fix: an `aria-label` that says exactly what the tooltip says,
// and the glyph itself `aria-hidden` (#2479).
//
// These render the real components and read the attributes off the markup,
// so the label cannot drift from the tooltip without failing here.
//
// Run with: node --test tests/attachment-claim-accessible-name.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { decodeEntities } = require('./helpers/html-tokens');
const { cardHtml, BLANK_CARD } = require('./lib/dev-card-html');

const { Attachments } = loadTsx('frontend/src/features/group-chat/transcript.tsx');

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? decodeEntities(m[1]) : null;
};

/** Every `<tag ...>inner</tag>` whose open tag matches `openRe`. */
function elements(html, tagName, openRe) {
  const re = new RegExp(`(<${tagName}\\b[^>]*>)([\\s\\S]*?)</${tagName}>`, 'g');
  const out = [];
  for (const m of html.matchAll(re)) if (openRe.test(m[1])) out.push({ open: m[1], inner: m[2] });
  return out;
}

test('the attachment download link is named, and the name is its tooltip', () => {
  const items = [
    { id: 'a1', kind: 'markdown', name: 'spec.md', url: '/att/1', size: '2 KB', badge: 'MD' },
    { id: 'a2', kind: 'html', name: 'mock & demo.html', url: '/att/2', size: '3 KB', badge: 'HTML' },
  ];
  const html = renderToHtml(createElement(Attachments, { items }));
  const links = elements(html, 'a', /class="gc-att-action"/).filter((e) => /\sdownload=/.test(e.open));
  assert.equal(links.length, 2, 'both chips draw a download link');
  for (const [i, link] of links.entries()) {
    const label = attr(link.open, 'aria-label');
    assert.equal(label, `Download ${items[i].name}`, 'aria-label names the file');
    assert.equal(label, attr(link.open, 'title'), 'aria-label says what the tooltip says');
    assert.match(link.inner, /^<span aria-hidden="true">↓<\/span>$/, 'the arrow glyph is decorative');
  }
});

test('the claim release × is named, and the name is its tooltip', () => {
  const model = {
    ...BLANK_CARD,
    extra: [{
      t: 'claims', key: 'claims',
      claims: [
        { username: 'ada', userId: 7, issue: 12 },
        { username: "o'brien", userId: 8, issue: 12 },
      ],
    }],
  };
  const html = cardHtml(model);
  const buttons = elements(html, 'button', /title="Release /);
  assert.equal(buttons.length, 2, 'one release control per claim');
  for (const [i, b] of buttons.entries()) {
    const name = model.extra[0].claims[i].username;
    const label = attr(b.open, 'aria-label');
    assert.equal(label, `Release ${name}'s claim (admin)`);
    assert.equal(label, attr(b.open, 'title'), 'aria-label says what the tooltip says');
    assert.match(b.inner, /^<span aria-hidden="true">×<\/span>$/, 'the × glyph is decorative');
  }
});
