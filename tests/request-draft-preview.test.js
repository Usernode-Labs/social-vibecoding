'use strict';

// #6248: a request draft the bot offers to file can be previewed before it is
// filed. The card under the bot's reply opens the AI tab's own column, the
// place a design's preview opens, and the pane reads the saved row's whole
// description (the message clips it at 1200 characters).
//
// What this pins:
//   1. The store: one preview at a time, a design's or a draft's; which place
//      a preview stands beside (a design's thread, or Main for a draft said
//      there); invalid ids change nothing; each open counts (seq).
//   2. The pane as the column: the message's copy until the saved row comes,
//      set as a document (the whole title, then the words), and at its foot
//      where the request will go with File it and Not now, the card's own
//      tap (25 Nov 2026; it was read-only before).
//   3. What a draft carries besides its words, as the client reads it and as
//      the pane decides whether there is a list to draw beside them.
//   4. The head card keeps the words a pane said for the open it said them
//      for: a draft's title used to be cleared as soon as it was said.
//
// Run with: node --test tests/request-draft-preview.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const fs = require('node:fs');
const path = require('node:path');

const { message } = require('./lib/platform-i18n');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// The store moved into ./detail.ts (#6230, 3 Nov 2026); ./preview.ts is the
// design card's and the pane's spelling of it. detailEntry() reads the entry
// the store keeps, without React.
const detail = loadTsx('frontend/src/features/ai/detail.ts');
const preview = loadTsx('frontend/src/features/ai/preview.ts');

test('a design keeps its thread; a draft is said in a thread or in Main', () => {
  preview.openPreview({ conversationId: 4, rootId: 9, version: 2 });
  let open = detail.detailEntry();
  assert.equal(open.kind, 'design');
  assert.equal(open.ref.conversationId, 4);
  assert.equal(open.ref.rootId, 9);

  preview.openDraftPreview({ conversationId: 4, rootId: 9, actionId: 42 });
  open = detail.detailEntry();
  assert.equal(open.kind, 'draft');
  assert.equal(open.ref.rootId, 9, 'a draft said in its own thread');

  preview.openDraftPreview({ conversationId: 4, rootId: null, actionId: 43 });
  open = detail.detailEntry();
  assert.equal(open.ref.rootId, undefined, 'a draft said in Main');
  assert.equal(open.ref.actionId, 43);
});

test('openPreview opens a design; openDraftPreview opens a draft, in a thread or in Main', () => {
  preview.openPreview({ conversationId: 4, rootId: 9, version: 2 });
  let open = detail.detailEntry();
  assert.deepEqual(
    { kind: open.kind, actionId: open.ref.actionId, rootId: open.ref.rootId, version: open.version, copy: open.payload?.draft ?? null },
    { kind: 'design', actionId: undefined, rootId: 9, version: 2, copy: null },
  );

  const copy = { title: 'Add a search box', project: 'Plant pal', details: 'Search notes by their text.', appSlug: 'plant-pal' };
  preview.openDraftPreview({ conversationId: 4, rootId: 9, actionId: 42, copy });
  open = detail.detailEntry();
  assert.deepEqual(
    { kind: open.kind, actionId: open.ref.actionId, rootId: open.ref.rootId, version: open.version, copy: open.payload?.draft ?? null },
    { kind: 'draft', actionId: 42, rootId: 9, version: null, copy },
  );

  preview.openDraftPreview({ conversationId: 4, rootId: null, actionId: 43, copy });
  open = detail.detailEntry();
  assert.equal(open.ref.rootId, undefined, 'a draft said in Main');
  assert.equal(open.ref.actionId, 43);
});

test('invalid ids change nothing; each open bumps seq', () => {
  preview.openDraftPreview({ conversationId: 4, rootId: null, actionId: 8 });
  const first = detail.detailEntry();
  preview.openDraftPreview({ conversationId: 4, rootId: null, actionId: 8 });
  assert.equal(detail.detailEntry().seq, first.seq + 1, 'the same draft opened again is drawn again');

  const before = detail.detailEntry();
  preview.openDraftPreview({ conversationId: 0, rootId: null, actionId: 9 });
  preview.openDraftPreview({ conversationId: 4, rootId: null, actionId: 0 });
  preview.openDraftPreview({ conversationId: 4, rootId: -1, actionId: 9 });
  assert.equal(detail.detailEntry(), before, 'nothing valid changed');

  preview.closePreview();
  assert.equal(detail.detailEntry(), null);
});

test('the pane draws the message’s copy as a document, with File it and Not now at its foot', () => {
  const api = { readRequestDraft: () => new Promise(() => {}), decideBotAction: () => new Promise(() => {}) };
  const { RequestDraftPane } = loadTsx('frontend/src/features/messages/request-draft-pane.tsx', { stubs: { './api': api } });
  const copy = { title: 'Add a search box', project: 'Plant pal', details: 'Search notes by their text.', appSlug: 'plant-pal' };
  const html = renderToHtml(createElement(RequestDraftPane, { actionId: 42, copy, onClose: () => {} }));
  assert.match(html, /data-request-draft-pane="42"/);
  assert.match(html, new RegExp(`aria-label="${message('messages:draft.pane.label')}"`));
  // The whole title opens the words, once, and wraps (it was clipped to one line in the header).
  assert.match(html, /<h2 class="request-draft-title" data-draft-title="">Add a search box<\/h2>/);
  assert.equal(html.match(/Add a search box/g).length, 1);
  assert.match(html, new RegExp(message('messages:draft.pane.sub', { project: 'Plant pal' })));
  assert.match(html, /<div class="request-draft-words"><div class="messages-markdown gc-msg-content">Search notes by their text\.<\/div><\/div>/);
  // Until the saved row is read there is nothing to list beside the words: one column.
  assert.doesNotMatch(html, /data-draft-rail|data-draft-extras/);
  // The foot: where it goes, then the card's two buttons, Not now before File it.
  assert.match(html, /<p class="request-draft-goes">Goes on <b>Plant pal<\/b> as a new request\. Nothing is filed until you press File it\.<\/p>/);
  assert.ok(html.includes(`role="group" aria-label="${message('messages:draft.pane.question', { project: 'Plant pal' })}"`), 'the pair of buttons is named by its question');
  assert.match(html, /data-draft-action="not-now"><span>Not now<\/span><\/button><button type="button" class="messages-bot-primary" data-draft-action="file"><span>File it<\/span>/);
  assert.doesNotMatch(html, /data-bot-refused/, 'nothing was refused');
  assert.match(html, /data-draft-close="close"/);

  const phone = renderToHtml(createElement(RequestDraftPane, { actionId: 42, copy, onClose: () => {}, closeAs: 'back' }));
  assert.match(phone, /data-draft-close="back"/);
  assert.doesNotMatch(phone, /data-draft-close="close"/);
});

test('the pane’s buttons make the card’s own tap, close on a yes, and say why on a refusal', () => {
  const pane = read('frontend/src/features/messages/request-draft-pane.tsx');
  assert.match(pane, /api\.decideBotAction\(actionId, choice\)\.then\(\(\) => \{ onClose\?\.\(\); \}/);
  assert.match(pane, /setRefused\(refusalOf\(error\)\);/);
  assert.match(pane, /<OfferRefused refusal=\{refused\} \/>/);
  assert.match(pane, /onClick=\{\(\) => decide\('yes'\)\} data-draft-action="file"/);
  assert.match(pane, /onClick=\{\(\) => decide\('no'\)\} data-draft-action="not-now"/);
});

test('what a draft carries besides its words: read with anything malformed left out, and listed only when there is something', () => {
  const { draftExtras } = loadTsx('frontend/src/features/messages/api.ts');
  const { draftHasExtras } = loadTsx('frontend/src/features/messages/request-draft-pane.tsx');
  const none = { files: [], undecided: [], doneWhen: [], related: [], where: { request: null, saw: null } };
  assert.deepEqual(draftExtras(undefined), none);
  assert.deepEqual(draftExtras({ undecided: 'no', related: [{ number: 0, title: 'x' }, 'y'], where: { request: { number: 'x' } } }), none);
  const read = draftExtras({
    files: [{ name: ' site.zip ', size: 4300800 }, { name: '', size: 3 }, null],
    undecided: [' Same window or a new one ', '', 7],
    doneWhen: ['The bar has the button'],
    related: [{ number: 6230, title: 'One column', relation: 'build_together', why: 'the same column' }, { number: 4, title: 'Other', relation: 'made_up' }],
    where: { request: { number: 15, name: 'Homeroom', slug: 'homeroom' }, saw: 'the draft bar' },
  });
  assert.deepEqual(read, {
    files: [{ name: 'site.zip', size: 4300800 }],
    undecided: ['Same window or a new one'],
    doneWhen: ['The bar has the button'],
    related: [
      { number: 6230, title: 'One column', relation: 'build_together', why: 'the same column' },
      { number: 4, title: 'Other', relation: null, why: null },
    ],
    where: { request: { number: 15, name: 'Homeroom', slug: 'homeroom' }, saw: 'the draft bar' },
  });
  assert.equal(draftHasExtras(null), false);
  assert.equal(draftHasExtras(none), false, 'nothing to list: the words keep the whole pane');
  assert.equal(draftHasExtras({ ...none, undecided: ['One'] }), true);
  assert.equal(draftHasExtras({ ...none, where: { request: null, saw: 'the draft bar' } }), true);
  // #7136: a file it carries is enough to draw the list beside the words.
  assert.equal(draftHasExtras({ ...none, files: [{ name: 'site.zip', size: 9 }] }), true);
  // Each relation the server can send has its own whole message.
  for (const id of ['same', 'partOf', 'dependsOn', 'buildTogether']) assert.ok(message(`messages:draft.pane.relation.${id}`));
});

test('the two columns follow the pane’s own width, and the list goes under the words in a narrow one', () => {
  const css = read('public/css/app.css');
  assert.match(css, /\.request-draft-scroll \{[^}]*container-type: inline-size;/);
  assert.match(css, /\.request-draft-grid \{ display: grid; grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(css, /@container \(min-width: 640px\) \{\n  \.request-draft-grid \{ padding: 26px 24px; \}\n  \.request-draft-grid\[data-draft-rail\] \{ grid-template-columns: minmax\(0, 1fr\) 220px; column-gap: 24px; \}/);
  assert.match(css, /\.request-draft-main \{ min-width: 0; max-width: 68ch; \}/);
});

test('the head card keeps a pane’s words for the open they were said for', () => {
  const card = read('frontend/src/features/detail/detail-card.tsx');
  // No effect clears the label: it ran after the pane's own had said it.
  assert.doesNotMatch(card, /useEffect\(\(\) => \{ setLabel\(null\); \}/);
  assert.match(card, /const \[said, setSaid\] = useState<\{ seq: number; label: DetailLabel \| null \}>\(\{ seq, label: null \}\);/);
  assert.match(card, /const label = said\.seq === seq \? said\.label : null;/);
  // `say` is new with each open, so the pane says its words again for it.
  assert.match(card, /\}, \[seq\]\);\n  const label = said\.seq === seq/);
});

test('#7136: the pane lists the files a draft carries, first in the rail, with their sizes', () => {
  const pane = read('frontend/src/features/messages/request-draft-pane.tsx');
  // One more panel, drawn before the others: what it carries onto the request
  // is the first thing a person checks before filing a zip.
  assert.match(pane, /<Panel kind="files" label=\{t\('messages:draft\.pane\.files'\)\} note=\{t\('messages:draft\.pane\.filesNote'\)\}>/);
  assert.ok(pane.indexOf('data-draft-panel="files"') === -1, 'the panel is the primitive, not hand-written markup');
  assert.ok(pane.indexOf('kind="files"') < pane.indexOf('kind="undecided"'), 'before Still undecided');
  assert.match(pane, /\{file\.name\}\n\s*<small>\{fileSize\(file\.size\)\}<\/small>/);
  // It says what happens to them, in a line under the list.
  assert.match(pane, /\{note \? <p className="request-draft-note">\{note\}<\/p> : null\}/);
  // Every word is a catalog entry with a description, never a literal.
  assert.ok(message('messages:draft.pane.files') === 'Files it carries');
  assert.match(message('messages:draft.pane.filesNote'), /anyone who can see it sees their names, and its build can open them/);
  // The note's own size and colour come from the shell's tokens.
  assert.match(read('public/css/app.css'), /\.request-draft-panel \.request-draft-note \{ margin: 6px 2px 0; font-size: 12px; line-height: 17px; color: var\(--text-muted\); \}/);
});
