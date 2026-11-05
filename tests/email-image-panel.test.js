'use strict';

// frontend/src/features/admin/email-templates/image-panel.tsx: the Visual
// tab's image panel and the HTML tab's Upload image button. Effects and the
// upload itself do not run under a static render, so the panel is rendered in
// each state it can be in, and the snippet it makes is run through the same
// insertAfterBlock and server check the editor and the save use.
//
// Run with: node --test tests/email-image-panel.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { englishTemplate } = require('../src/db/email-template-seeds');
const { validateEmailHtml } = require('../src/services/mail/html-safety');

const ROOT = path.join(__dirname, '..');
const DIR = 'frontend/src/features/admin/email-templates';
const ADMIN_UI = new Proxy({}, {
  get: (_t, key) => (['btn', 'badge'].includes(key) ? new Proxy({}, { get: (_u, k) => `${key}-${String(k)}` }) : String(key)),
});
const stubs = { '../admin-console.js': { AdminUI: ADMIN_UI } };
const panel = loadTsx(`${DIR}/image-panel.tsx`, { stubs });
const visual = loadTsx(`${DIR}/visual-tab.tsx`, { stubs });
const runs = loadTsx(`${DIR}/html-runs.ts`);

const URL_ = 'https://app.onhomeroom.com/email-images/0123456789abcdef0123456789abcdef';

test('the image panel: upload or address, alt text, width, and Add image', () => {
  const html = renderToHtml(createElement(panel.ImagePanel, { onInsert() {}, onCancel() {} }));
  assert.match(html, /role="group" aria-label="Add an image"/);
  assert.match(html, /<input[^>]*type="file"[^>]*accept="image\/png,image\/jpeg,image\/gif,image\/webp"/);
  assert.doesNotMatch(html, /svg/i, 'SVG is never offered');
  assert.match(html, /Or its web address/);
  assert.match(html, /<input[^>]*type="url"/);
  assert.match(html, />Alt text</);
  assert.match(html, /Leave it empty for an image that is only decoration/);
  assert.match(html, />Width in pixels</);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Add image</, 'nothing to add until there is an address');
  assert.match(html, />Cancel</);
  assert.doesNotMatch(html, /role="status"|role="alert"/);
});

test('upload progress and errors are shown inline', () => {
  const busy = renderToHtml(createElement(panel.ImagePanel, { onInsert() {}, onCancel() {}, initial: { progress: 42 } }));
  assert.match(busy, /<p role="status"[^>]*>Uploading… 42%<\/p>/);
  assert.match(busy, /<input[^>]*type="file"[^>]*disabled=""/, 'one upload at a time');
  assert.match(busy, /<button[^>]*disabled=""[^>]*>Add image</);
  const refused = renderToHtml(createElement(panel.ImagePanel, {
    onInsert() {}, onCancel() {}, initial: { src: URL_, error: 'Choose a PNG, JPEG, GIF or WebP image. SVG and other files cannot be used in email.' },
  }));
  assert.match(refused, /<p role="alert"[^>]*>Choose a PNG, JPEG, GIF or WebP image\./);
  assert.match(refused, new RegExp(`value="${URL_}"`));
  assert.doesNotMatch(refused, /<button[^>]*disabled=""[^>]*>Add image</);

  const button = renderToHtml(createElement(panel.UploadImageButton, { onTag() {} }));
  assert.match(button, /<button[^>]*>Upload image<\/button>/);
  assert.match(button, /<input[^>]*class="hidden"[^>]*type="file"/);
  const uploading = renderToHtml(createElement(panel.UploadImageButton, { onTag() {}, initial: { progress: 7, error: null } }));
  assert.match(uploading, /<button[^>]*disabled=""[^>]*>Uploading…<\/button>/);
  assert.match(uploading, /Uploading… 7%/);
  const failed = renderToHtml(createElement(panel.UploadImageButton, { onTag() {}, initial: { error: 'The image must be 1 MB or smaller.' } }));
  assert.match(failed, /role="alert"[^>]*>The image must be 1 MB or smaller\./);
});

test('the tag it makes is what the server accepts: https, an alt, a width, escaped', () => {
  assert.equal(panel.imageProblem(URL_), null);
  for (const bad of ['http://x.example/a.png', 'data:image/png;base64,AAAA', '/email-images/x', 'javascript:alert(1)', '']) {
    assert.match(panel.imageProblem(bad), /https:\/\//, bad);
  }
  assert.equal(panel.widthProblem(''), null);
  assert.equal(panel.widthProblem('480'), null);
  for (const bad of ['0', '-3', '12.5', '480px', '9999']) assert.match(panel.widthProblem(bad), /whole number/, bad);

  const tag = panel.imageTag({ src: URL_, alt: 'Our "team" <3', width: '480' });
  assert.equal(tag, `<img src="${URL_}" alt="Our &quot;team&quot; &lt;3" width="480" style="display:block;max-width:100%;height:auto;border:0">`);
  assert.equal(panel.imageTag({ src: URL_, alt: '', width: '' }), `<img src="${URL_}" alt="" style="display:block;max-width:100%;height:auto;border:0">`);
  assert.deepEqual(validateEmailHtml(panel.imageSnippet({ src: URL_, alt: 'x', width: '10' })), { ok: true });
  assert.equal(panel.insertAt('<p>a</p><p>b</p>', 8, 8, '<img>'), '<p>a</p><img><p>b</p>');
  assert.equal(panel.insertAt('abc', 1, 2, 'X'), 'aXc', 'a selection is replaced');
});

test('the Visual tab inserts the image after the block in its own paragraph; that block shows the image and is not text to retype', () => {
  const source = englishTemplate('password_reset').html;
  const model = visual.openModel(source);
  const snippet = panel.imageSnippet({ src: URL_, alt: 'A photo', width: '320' });
  const next = runs.insertAfterBlock(source, model.blocks[0], snippet);
  assert.equal(next, source.slice(0, model.blocks[0].outerEnd) + snippet + source.slice(model.blocks[0].outerEnd));
  const after = visual.openModel(next);
  assert.equal(after.blocks.length, model.blocks.length, 'the image paragraph is not an editable block');
  assert.ok(!after.blocks.some((b) => b.html.includes('<img')));
  const drawn = visual.decorate(next, { editable: true });
  assert.ok(drawn.includes(snippet), 'the frame draws the image as written');
  assert.equal(visual.undecorate(drawn), next);
  // A paragraph holding text and an image stays as written too.
  const mixed = `<p>Look ${panel.imageTag({ src: URL_, alt: '', width: '' })}</p>`;
  assert.equal(visual.openModel(mixed).blocks.length, 0);
});

test('the toolbar Image button opens the panel; the HTML tab has Upload image for full admins only', () => {
  const src = fs.readFileSync(path.join(ROOT, DIR, 'visual-tab.tsx'), 'utf8');
  assert.match(src, /<ImagePanel /);
  assert.match(src, /insertAfterCurrent\(imageSnippet\(fields\), 'image'\)/);
  assert.match(src, /insertAfterBlock\(m\.source, m\.blocks\[index\], snippet\)/);
  assert.doesNotMatch(src, /coming in the next part/i);
  const editor = fs.readFileSync(path.join(ROOT, DIR, 'editor.tsx'), 'utf8');
  assert.match(editor, /\{readOnly \? null : <UploadImageButton /);
});
