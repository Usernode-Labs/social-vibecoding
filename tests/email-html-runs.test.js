'use strict';

// frontend/src/features/admin/email-templates/html-runs.ts: the visual email
// editor's map from an email's HTML source to the text an admin may retype in
// place. The owner's rule is that the design and the conditions always survive
// the visual tab, so these tests hold it to the bytes: every seeded email and
// the seeded layout come back byte for byte when each block is replaced with
// itself, an edit touches its own range and nothing else, and no condition
// marker or table markup is ever inside a block.
//
// The module tokenizes the HTML itself (it cannot import the server's
// src/services/mail/html-safety.js), so the last tests run both tokenizers over
// the seeds and require them to agree on where every tag and block starts and
// ends.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadTsx } = require('./lib/render-tsx');
const { scanHtml } = require('../src/services/mail/html-safety');
const { placeholdersIn } = require('../src/services/mail/template-language');
const { KINDS } = require('../src/services/mail/templates');
const { englishTemplate, translatedTemplate, seededLayout } = require('../src/db/email-template-seeds');
const { translatorFrom } = require('../src/services/push-text');

const runs = loadTsx('frontend/src/features/admin/email-templates/html-runs.ts');
const { editableBlocks, findBlocks, spliceBlock, insertAfterBlock, tokenize } = runs;

// The expanded English html of every seeded kind, waitlist_released first (the
// owner named it), then the layout.
const ORDER = ['waitlist_released', ...KINDS.filter((kind) => kind !== 'waitlist_released')];
const SOURCES = [
  ...ORDER.map((kind) => [kind, englishTemplate(kind).html]),
  ['layout: Homeroom standard', seededLayout('Homeroom standard').html],
];

// Every message prefixed with characters a translator could send, the way
// tests/mail-seed-equivalence.test.js builds its hostile translation.
const ENGLISH = Object.fromEntries(Object.entries(require('../frontend/locales/en/email.json')).map(([k, v]) => [k, v.text]));
const HOSTILE = Object.fromEntries(Object.entries(ENGLISH).map(([key, text]) => [key, `L'"<&>  <7>x</7> &amp; ${text}`]));
const hostile = translatorFrom('fr', HOSTILE, ENGLISH);
const HOSTILE_SOURCES = KINDS
  .map((kind) => [`hostile ${kind}`, (translatedTemplate(kind, hostile) || {}).html])
  .filter(([, html]) => typeof html === 'string');

const MARKER = /\{\{\s*(#if|#unless|else|\/if|\/unless)\b[^}]*\}\}/g;
const STRUCTURE_TAG = /<\/?(table|tbody|thead|tfoot|tr|td|th|p|div|h[1-6]|li|ul|ol|img)\b/i;

test('there are 13 seeded kinds and every one has html', () => {
  assert.equal(KINDS.length, 13);
  for (const [name, html] of SOURCES) assert.equal(typeof html, 'string', name);
});

test('for all 13 seeds and the layout, replacing every block with itself is byte-identical', () => {
  for (const [name, source] of [...SOURCES, ...HOSTILE_SOURCES]) {
    const blocks = editableBlocks(source);
    assert.ok(blocks.length > 0, `${name} has editable text`);
    for (const block of blocks) {
      assert.equal(source.slice(block.start, block.end), block.html, name);
      assert.equal(spliceBlock(source, block, block.html), source, `${name}: ${block.html}`);
    }
    // All at once, last first, so earlier offsets stay true.
    let all = source;
    for (const block of [...blocks].reverse()) all = spliceBlock(all, block, block.html);
    assert.equal(all, source, name);
  }
});

test('editing one block changes only that range', () => {
  for (const [name, source] of SOURCES) {
    const blocks = editableBlocks(source);
    blocks.forEach((block, index) => {
      const html = `${block.html} <strong>edited</strong>`;
      const out = spliceBlock(source, block, html);
      assert.equal(out, source.slice(0, block.start) + html + source.slice(block.end), name);
      // The same blocks are found again, the edited one longer and the ones
      // after it shifted by the difference.
      const again = editableBlocks(out);
      assert.equal(again.length, blocks.length, name);
      const shift = html.length - block.html.length;
      again.forEach((other, j) => {
        if (j < index) assert.deepEqual([other.start, other.end, other.html], [blocks[j].start, blocks[j].end, blocks[j].html]);
        else if (j === index) assert.deepEqual([other.start, other.end, other.html], [block.start, block.end + shift, html]);
        else assert.deepEqual([other.start, other.end, other.html], [blocks[j].start + shift, blocks[j].end + shift, blocks[j].html]);
      });
    });
  }
});

test('{{#if}} tags and table markup are outside every block', () => {
  for (const [name, source] of [...SOURCES, ...HOSTILE_SOURCES]) {
    const blocks = editableBlocks(source);
    for (const block of blocks) {
      assert.doesNotMatch(block.html, MARKER, `${name}: ${block.html}`);
      assert.doesNotMatch(block.html, STRUCTURE_TAG, `${name}: ${block.html}`);
      assert.doesNotMatch(block.html, /<!--/, name);
    }
    for (const m of source.matchAll(MARKER)) {
      const inside = blocks.find((block) => m.index < block.end && m.index + m[0].length > block.start);
      assert.equal(inside, undefined, `${name}: ${m[0]} at ${m.index}`);
    }
    // Blocks never overlap and come in source order.
    for (let i = 1; i < blocks.length; i++) assert.ok(blocks[i - 1].outerEnd <= blocks[i].outerStart, name);
  }
});

test('waitlist_released chip text is editable', () => {
  const source = englishTemplate('waitlist_released').html;
  const texts = editableBlocks(source).map((block) => block.html);
  for (const chip of ['Make an app for your group', 'Use and improve apps together', 'Suggest, preview and vote on changes']) {
    assert.ok(texts.includes(chip), chip);
  }
  // The chips' colour swatches hold only &nbsp;: nothing to retype.
  assert.ok(!texts.includes('&nbsp;'));
  // The headline and the sign-off, with its line break, are editable too.
  assert.ok(texts.includes('Make and share apps with groups and friends.'));
  assert.ok(texts.includes('See you there,<br>Evan from Homeroom'));
});

test('a block holding a condition is reported as structure, not offered for editing', () => {
  const source = englishTemplate('waitlist_released').html;
  const { editable, structure } = findBlocks(source);
  const pill = structure.find((block) => block.html.includes('{{#if hasAccount}}Sign in'));
  assert.ok(pill, 'the button whose label depends on hasAccount is structure');
  assert.ok(!editable.some((block) => block.start < pill.end && block.end > pill.start));
  // project_invite's headline chooses among four sentences.
  const invite = findBlocks(englishTemplate('project_invite').html);
  assert.ok(invite.structure.some((block) => block.html.startsWith('{{#if hasInviter}}')));
});

test('a placeholder inside a block is kept as a token', () => {
  const layout = editableBlocks(seededLayout('Homeroom standard').html);
  const footer = layout.find((block) => block.html === 'Homeroom<br>{{why}}');
  assert.ok(footer);
  assert.deepEqual(footer.placeholders, ['why']);
  assert.deepEqual(footer.tokens, [
    { type: 'text', start: footer.start, end: footer.start + 8, html: 'Homeroom' },
    { type: 'tag', start: footer.start + 8, end: footer.start + 12, html: '<br>', name: 'br', closing: false, attributes: [] },
    { type: 'placeholder', start: footer.start + 12, end: footer.end, html: '{{why}}', name: 'why' },
  ]);
  const button = editableBlocks(englishTemplate('content_report').html).find((block) => block.html.includes('Open in Moderation'));
  assert.deepEqual(button.placeholders, ['url'], 'a placeholder in an inline tag\'s attribute counts');
});

test('spliceBlock refuses an edit that would drop or add code', () => {
  const source = englishTemplate('content_report').html;
  const block = editableBlocks(source).find((b) => b.html.startsWith('Reason: '));
  assert.ok(block);
  const refuse = (html, why) => assert.throws(() => spliceBlock(source, block, html), Error, why);
  refuse(block.html.replace('{{reporter}}', 'someone'), 'dropping a placeholder');
  refuse(`${block.html}{{secret}}`, 'adding a placeholder');
  refuse(`${block.html}{{#if x}}y{{/if}}`, 'adding a condition');
  refuse(`${block.html}<table><tr><td>x</td></tr></table>`, 'adding a table');
  refuse(`${block.html}</p><p>x`, 'closing the block');
  refuse(`${block.html}<img src="x">`, 'an image is not inline text');
  refuse(`${block.html}<b>open`, 'an inline tag left open');
  refuse(`${block.html}</b>`, 'closing a tag it did not open');
  refuse(`${block.html}<!-- x -->`, 'a comment');
  refuse(`${block.html}</`, 'a fragment that would swallow the block\'s end tag');
  refuse(`${block.html} 1 < 2`, 'a bare < is not text the editor writes');
  refuse(`${block.html}{{`, 'an unclosed {{');
  refuse(`${block.html}<b onclick="x">y</b>`, 'an event handler');
  // A stale block: its range no longer holds its html.
  assert.throws(() => spliceBlock(`x${source}`, block, block.html));
  // Allowed: retyped text around the same placeholders, with inline markup.
  const ok = block.html.replace('Reason: ', '<em>Why</em>: <a href="https://x.test" style="color:#0a6ee0">reason</a> ');
  assert.equal(spliceBlock(source, block, ok), source.slice(0, block.start) + ok + source.slice(block.end));
  // A placeholder repeated, or one occurrence of a repeated one dropped, keeps the set.
  assert.doesNotThrow(() => spliceBlock(source, block, `${block.html} {{reporter}}`));
});

test('spliceBlock refuses a structure block', () => {
  const source = englishTemplate('waitlist_released').html;
  const pill = findBlocks(source).structure[0];
  assert.throws(() => spliceBlock(source, pill, pill.html));
});

test('insertAfterBlock puts a snippet after the block and nowhere else', () => {
  const source = englishTemplate('password_reset').html;
  const [first] = editableBlocks(source);
  const snippet = '<p><a href="https://x.test" style="color:#0a6ee0">More</a></p>';
  const out = insertAfterBlock(source, first, snippet);
  assert.equal(out, source.slice(0, first.outerEnd) + snippet + source.slice(first.outerEnd));
  assert.ok(editableBlocks(out).some((block) => block.html.includes('More')));
  // An image is fine as a new paragraph.
  insertAfterBlock(source, first, '<p><img src="https://x.test/a.png" alt="" width="10"></p>');
  for (const bad of ['<p>open', '</p>', '{{#if x}}<p>y</p>{{/if}}', '<table><tr><td>x</td></tr></table>', '<!-- x -->', '<p onload="x">y</p>', '<p>{{']) {
    assert.throws(() => insertAfterBlock(source, first, bad), Error, bad);
  }
  assert.throws(() => insertAfterBlock(`x${source}`, first, snippet), Error, 'stale block');
});

test('blocks in hand-written HTML: nesting, comments, raw text and quoted ">"', () => {
  const html = '<div><p title="a > b">One <b>two</b></p><!-- c --><p>Th<!-- x -->ree</p>'
    + '<style>p{color:red}</style><ul><li>Four</li></ul><p><span>Five<p>Six</p></span></p></div>'
    + '<h2>Seven {{n}}</h2><td><a href="{{u}}">Eight</a> {{#if y}}Nine{{/if}}</td>';
  const { editable, structure } = findBlocks(html);
  assert.deepEqual(editable.map((b) => [b.tag, b.html]), [
    ['p', 'One <b>two</b>'],
    ['li', 'Four'],
    ['p', 'Six'],
    ['h2', 'Seven {{n}}'],
    ['a', 'Eight'],
  ]);
  assert.deepEqual(structure.map((b) => b.tag), ['td']);
  for (const block of editable) assert.equal(html.slice(block.start, block.end), block.html);
});

test('the frontend tokenizer agrees with the server\'s scanHtml on every seed', () => {
  for (const [name, source] of [...SOURCES, ...HOSTILE_SOURCES]) {
    const scan = scanHtml(source);
    assert.ok(scan.ok, name);
    const server = scan.tags.filter((tag) => !tag.inComment).map((tag) => [tag.name, tag.closing, tag.start, tag.end]);
    const ours = tokenize(source).filter((token) => token.type === 'tag').map((token) => [token.name, token.closing, token.start, token.end]);
    assert.deepEqual(ours, server, name);
    const comments = tokenize(source).filter((token) => token.type === 'comment').map((token) => [token.start, token.end]);
    assert.deepEqual(comments, scan.comments.map((c) => [c.start, c.end]), name);
    // Every block's inner range runs from the end of an opening tag the
    // server read to the start of its matching closing tag.
    const { editable, structure } = findBlocks(source);
    for (const block of [...editable, ...structure]) {
      const open = scan.tags.find((tag) => !tag.closing && tag.start === block.outerStart);
      const close = scan.tags.find((tag) => tag.closing && tag.end === block.outerEnd);
      assert.ok(open && close, `${name}: ${block.html}`);
      assert.equal(open.end, block.start);
      assert.equal(close.start, block.end);
      assert.equal(open.name, block.tag);
      assert.equal(close.name, block.tag);
    }
  }
});

test('a block\'s placeholders are the ones the template language reads in it', () => {
  for (const [name, source] of SOURCES) {
    for (const block of editableBlocks(source)) {
      assert.deepEqual([...block.placeholders].sort(), [...placeholdersIn(block.html)].sort(), name);
    }
  }
});
