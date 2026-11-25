'use strict';

// The detail column belongs to its thread (20 Nov 2026,
// frontend/src/features/ai/detail.ts): what opens beside the thread on screen
// is that thread's, leaving the thread holds it, coming back shows it again,
// and the person's own close forgets it. Everything a thread opened is
// remembered for the head card's picker (frontend/src/features/detail/
// detail-card.tsx), one row per thing whatever its version.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadTsx, ROOT, fs } = require('./lib/render-tsx');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function fresh() {
  // The store lives on the global object; a fresh one per test.
  delete globalThis.__usernodeDetail;
  return loadTsx('frontend/src/features/ai/detail.ts');
}

test('what opens is the thread on screen\'s; a design or a draft is always its own thread\'s', () => {
  const d = fresh();
  d.setDetailOwner('private:7');
  d.openDetail({ kind: 'shots', ref: { changeId: 41 }, payload: { html: '<p>x</p>' } });
  assert.equal(d.detailEntry().owner, 'private:7');
  d.openDetail({ kind: 'design', ref: { conversationId: 3, rootId: 9 } });
  assert.equal(d.detailEntry().owner, 'private:9', 'a design belongs to the thread it is the design of');
  d.openDetail({ kind: 'shots', ref: { changeId: 41 }, from: 'page:app/plant/dev/issues/4' });
  assert.equal(d.detailEntry().owner, 'page:app/plant/dev/issues/4', 'an opener that names its column wins');
  d.setDetailOwner(null);
  d.openDetail({ kind: 'shots', ref: { changeId: 42 } });
  assert.equal(d.detailEntry().owner, null, 'no column on screen, no owner: the old rules');
});

test('leaving a thread holds what it shows; coming back takes it once; another thread\'s is left alone', () => {
  const d = fresh();
  d.setDetailOwner('private:7');
  d.openDetail({ kind: 'shots', ref: { changeId: 41 } });
  const entry = d.detailEntry();
  d.holdDetail('private:8');
  assert.equal(d.detailEntry(), entry, 'another thread leaving holds nothing of this one');
  d.holdDetail('private:7');
  assert.equal(d.detailEntry(), null, 'the column empties');
  assert.equal(d.takeHeldDetail('private:8'), null);
  assert.equal(d.takeHeldDetail('private:7'), entry, 'the thread come back to gets it back');
  assert.equal(d.takeHeldDetail('private:7'), null, 'once');
});

test('the person\'s own close forgets it: the thread does not show it again', () => {
  const d = fresh();
  d.setDetailOwner('private:7');
  d.openDetail({ kind: 'shots', ref: { changeId: 41 } });
  d.holdDetail('private:7');
  d.reopenDetail(d.takeHeldDetail('private:7'));
  assert.equal(d.detailEntry().kind, 'shots', 'reopened as it was');
  assert.equal(d.detailEntry().owner, 'private:7');
  d.closeDetail();
  assert.equal(d.takeHeldDetail('private:7'), null);
});

test('a thread remembers each thing it opened once, at its newest version, for the picker', () => {
  const d = fresh();
  d.setDetailOwner('private:9');
  d.openDetail({ kind: 'design', ref: { conversationId: 3, rootId: 9 }, version: 1 });
  d.openDetail({ kind: 'shots', ref: { changeId: 41 } });
  d.openDetail({ kind: 'design', ref: { conversationId: 3, rootId: 9 }, version: 2 });
  const seen = d.seenDetails('private:9');
  assert.deepEqual(seen.map((e) => d.detailIdentity(e)), ['design:9', 'shots:41']);
  assert.equal(seen[0].version, 2);
  assert.deepEqual(d.seenDetails('private:10'), []);
  d.noteDetailLabel(seen[1], { title: 'Before and after', line: 'Plant Pal' });
  assert.deepEqual(d.detailLabel('private:9', 'shots:41'), { title: 'Before and after', line: 'Plant Pal' });
});

test('a running preview keeps what it was opened with, so its thread can ask for it again', () => {
  const placement = read('frontend/src/features/staging/placement.ts');
  assert.match(placement, /payload: \{ staging: \{ slug: input\.slug \|\| null, readOnly: input\.readOnly !== false \} \},/);
  // The layout the address remembered rides with it too (a refresh comes back
  // in the same place: tests/staging-preview-redesign.test.js).
  assert.match(read('public/js/app-view.js'), /staging\.place\(\{\s*sessionId,\s*wide: false,\s*settle: !!\(opts && opts\.settle\),\s*slug: slug \|\| null,\s*readOnly,\s*layout: \(opts && opts\.layout\) \|\| null,\s*\}\);/);
  const detail = read('frontend/src/features/ai/detail.ts');
  assert.match(detail, /if \(entry\.kind === 'preview'\) \{[\s\S]*?void view\.ensureStaging\(sessionId, null, null, \{/, 'reopened through the staging overlay, which owns its frame');
});

test('beside a thread on the bot tab the column is cards: a head card with the picker, the thing in a card under it', () => {
  const card = read('frontend/src/features/detail/detail-card.tsx');
  assert.match(card, /aria-haspopup="menu"/);
  assert.match(card, /data-detail-picker=""/);
  assert.match(card, /role="menu"\n\s+aria-label=\{t\('messages:detail\.picker\.section'\)\}/);
  assert.match(card, /data-detail-menu=""/);
  assert.match(card, /<div className="detail-card-body" data-detail-body=\{entry\.kind\}>/);
  // A running preview is one card with one head: its own bar, which keeps
  // its × (tests/staging-preview-has-an-exit.test.js) and draws the picker.
  assert.match(card, /if \(entry\.kind === 'preview'\) return <div className="detail-card" data-detail-card=\{entry\.kind\}>\{body\}<\/div>;/);
  const overlay = read('frontend/src/features/staging/staging-overlay.tsx');
  assert.match(overlay, /const pickHere = placement === 'column' && detail\?\.kind === 'preview' && !!detail\.owner;/);
  assert.match(overlay, /<DetailPicker entry=\{pickHere && detail \? detail : null\} label=\{\{ title: title \|\| fallback, line: state\.appName \|\| null \}\} className="staging-titles staging-pick" anchor=\{headRef\} end=\{draftActs\.discardItem\}>/);
  // The list is drawn at the top of the page, over the preview's frame.
  assert.match(card, /createPortal\(\n\s+<div\n\s+ref=\{list\}\n\s+className="detail-card-menu"/);
  assert.match(read('public/css/app.css'), /\.detail-card-menu \{ position: fixed; z-index: 60;/);
  assert.match(read('frontend/src/features/ai/index.tsx'), /<DetailPane layout=\{layout\} card \/>/);
  // The column's Escape gives way to the open menu's.
  assert.match(read('frontend/src/features/ai/detail.ts'), /if \(document\.querySelector\('\[data-detail-menu\]'\)\) return;/);
  const css = read('public/css/app.css');
  assert.match(css, /html:is\(:not\(\[data-skin\]\), \[data-skin="brand"\]\) #ai-screen \.ai-preview-pane:has\(> \.detail-card\) \{\n  background: none;\n  border: 0;/);
  assert.match(css, /html:is\(:not\(\[data-skin\]\), \[data-skin="brand"\]\) #ai-screen \.ai-preview-pane :is\(\.detail-card-head, \.detail-card-body\) \{\n  border-radius: 20px;/);
});

test('a running preview beside a thread is two cards, as the thread is: a head card and the app\'s frame', () => {
  const css = read('public/css/app.css');
  const overlay = read('frontend/src/features/staging/staging-overlay.tsx');
  // The header, its one line and How to test's steps are one box, which has
  // no box of its own anywhere but beside a thread.
  assert.match(overlay, /<div className="staging-top">\s*\{\/\*[\s\S]*?\*\/\}\s*<div ref=\{headRef\} className="staging-chrome-bar staging-head shrink-0">/);
  assert.match(overlay, /<\/div>\n      <\/div>\n      <div className="staging-body relative flex-1">/, 'the steps are the last thing in it, the frame is not');
  assert.match(css, /\n\.staging-top \{ display: contents; \}\n/);
  const col = 'html:is(:not([data-skin]), [data-skin="brand"]) body:has(#ai-preview-pane [data-detail-body="preview"]) #staging-overlay[data-placement="column"]';
  const rule = (sel) => {
    const at = css.indexOf(`${sel} {\n`);
    assert.ok(at >= 0, `no rule for ${sel}`);
    return css.slice(at, css.indexOf('}', at));
  };
  // The pane paints nothing; the cards are 12px apart on the page's ground.
  assert.match(rule(col), /gap: 12px;[\s\S]*background: none;\n  box-shadow: none;\n  overflow: visible;/);
  assert.match(rule('html:is(:not([data-skin]), [data-skin="brand"]) #ai-screen .ai-preview-pane .detail-card-body[data-detail-body="preview"]'), /background: none;\n  box-shadow: none;/);
  // The thread's own tokens, named on the overlay, which is not in the thread.
  assert.match(rule(col), /--thread-card: var\(--thread-card-look, var\(--dc-sheet-fill\)\);/);
  assert.match(rule(col), /--thread-card-r: 20px;/);
  // The head card is the thread's title card; the frame is its messages card.
  assert.match(rule(`${col} .staging-top`), /border-radius: var\(--thread-card-r\);\n  background: var\(--thread-card\);\n  box-shadow: var\(--thread-card-edge\), 0 10px 24px -14px rgba\(17, 24, 39, 0\.22\);/);
  assert.match(rule(`${col} .staging-body`), /overflow: hidden;\n  border-radius: var\(--thread-card-r\);\n  box-shadow: var\(--thread-card-edge\);/);
  // Its edge is drawn over the frame too, and takes no press: a pin lands in the app.
  assert.match(rule(`${col}:not([data-mat]) .staging-body::after`), /box-shadow: var\(--thread-card-edge\);\n  pointer-events: none;/);
});

test('a preview reopened from its address before the page knew its thread is claimed by it, not closed', () => {
  const d = fresh();
  d.setDetailOwner(null);
  d.openDetail({ kind: 'shots', ref: { changeId: 41 } });
  const entry = d.detailEntry();
  assert.equal(entry.owner, null);
  assert.equal(d.claimDetail('private:7'), true);
  assert.equal(d.detailEntry(), entry, 'the same entry, so what is loading for it still lands');
  assert.equal(entry.owner, 'private:7');
  assert.equal(d.claimDetail('private:8'), false, 'once owned, it stays its thread\'s');
  const ai = read('frontend/src/features/ai/index.tsx');
  assert.match(ai, /if \(claimDetail\(owner\)\) claimed\(\(n\) => n \+ 1\);/);
  assert.match(ai, /if \(!shown\) return;/, 'no column yet: nothing is closed for want of one');
});

test('with three columns up the list gives up the room both take (its lane was the thread column\'s alone)', () => {
  const css = read('public/css/app.css');
  assert.match(css, /#ai-screen\[data-ai-docked\]\[data-ai-open\]\[data-ai-preview="three"\] \{\n  padding-inline-end: calc\(var\(--ai-col-w\) \+ var\(--ai-preview-w\)\);\n\}/);
  assert.ok(css.indexOf('#ai-screen[data-ai-docked][data-ai-open][data-ai-preview="three"]') > css.indexOf('#ai-screen[data-ai-docked][data-ai-open] { padding-inline-end: var(--ai-main-w); }'));
});
