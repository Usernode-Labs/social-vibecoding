'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const EDITOR = 'frontend/src/features/dev-board/topic/description-editor.tsx';
const KEPT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

/** Just enough of localStorage for the kept-description helpers. */
function memoryStore() {
  const rows = new Map();
  return {
    get length() { return rows.size; },
    key(index) { return [...rows.keys()][index] ?? null; },
    getItem(key) { return rows.has(key) ? rows.get(key) : null; },
    setItem(key, value) { rows.set(key, String(value)); },
    removeItem(key) { rows.delete(key); },
  };
}

function fixture(userId = 7) {
  const events = [];
  const c = { console, App: { user: { id: userId }, currentApp: 'demo' },
    document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; } },
    localStorage: { getItem() { return null; } }, location: { search: '', hash: '' },
    URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, addEventListener() {},
    CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts.detail; } },
    dispatchEvent: (event) => events.push(event),
  };
  c.window = c;
  c.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(c);
  vm.runInContext(fs.readFileSync('public/js/app-view.js', 'utf8') + '\nglobalThis.av = AppView;', c);
  const av = c.av;
  av.appData = { slug: 'demo', can_collaborate: true };
  av._repaintDevBody = () => {};
  const row = { id: 42, user_id: 7, source: 'cli_handoff', status: 'paused',
    pr_summary_md: 'Old description', pr_number: 91 };
  return { av, row, events };
}

test('the full change menu offers Edit description for its author and opens the matching editor', () => {
  const { av, row, events } = fixture();
  const card = { rail: { menuKey: 'none' }, actions: [] };
  av._topicCard(card, 'session', row, { changeId: 42, proposalBody: { html: 'Details' } });
  const action = av._cardMenus[card.rail.menuKey].find((entry) => entry.label === 'Edit description');
  assert.ok(action);
  action.act();
  assert.equal(events[0].type, 'change-description-edit');
  assert.equal(events[0].detail, 42);
});

test('only authors of open work get description editing; imported summaries are editable too', () => {
  const { av, row } = fixture();
  for (const status of ['active', 'paused', 'promoted', 'merging']) assert.equal(av._canEditDescription({ ...row, status }), true);
  assert.equal(av._canEditDescription({ ...row, source: 'imported' }), true);
  for (const patch of [{ user_id: 8 }, { is_headless: true }, { preview_placeholder: true }, { status: 'merged' }, { status: 'archived' }]) {
    assert.equal(av._canEditDescription({ ...row, ...patch }), false);
  }
  av.appData.can_collaborate = false;
  assert.equal(av._canEditDescription(row), false);
});

test('a saved description refreshes matching caches without changing another proposal or its checks', () => {
  const { av, row, events } = fixture();
  row.check_state = 'passing'; row.status = 'promoted'; row.yes_count = 3;
  const other = { ...row, id: 43 };
  av._proposals = [row, other]; av._changeItems.set(42, row);
  av._cacheDescription(42, { description: 'New description', version: 5, stale: false, prBody: 'New body' });
  assert.equal(row.pr_summary_md, 'New description');
  assert.equal(other.pr_summary_md, 'Old description');
  assert.equal(row.check_state, 'passing'); assert.equal(row.status, 'promoted'); assert.equal(row.yes_count, 3);
  assert.equal(events[0].detail.patch.pr_summary_md, 'New description');
});

// ── Unsaved description kept on the device (#6481) ────────────────────
//
// simpati's sign-in ran out halfway through a proposal and the text was gone
// after signing in again. The editor now keeps what is typed per account and
// change, outside the session's partition, so the sweep that runs when a
// session ends does not take it with it.

test('a description draft is kept per account and change, and read back for that pair only', () => {
  const editor = loadTsx(EDITOR);
  const store = memoryStore();
  const key = editor.descriptionDraftKey(7, 42);
  assert.equal(key, 'usernode:description-draft:7:42');
  assert.equal(key.startsWith('usernode:kept:'), false, 'the session sweep clears only usernode:kept:');

  editor.keepDescriptionDraft(store, 7, 42, 'Half-written proposal', 16000, NOW);
  assert.equal(editor.keptDescriptionDraft(store, 7, 42, NOW), 'Half-written proposal');
  assert.equal(editor.keptDescriptionDraft(store, 8, 42, NOW), null, 'another account reads nothing');
  assert.equal(editor.keptDescriptionDraft(store, 7, 43, NOW), null, 'another change reads nothing');
  assert.equal(editor.keptDescriptionDraft(store, 7, 42, NOW), 'Half-written proposal', 'the other reads did not disturb it');

  assert.equal(editor.descriptionDraftKey(null, 42), null);
  editor.keepDescriptionDraft(store, null, 42, 'nobody signed in', 16000, NOW);
  assert.equal(store.length, 1, 'a viewer with no account keeps nothing');
});

test('a kept description is bounded by the change limit, removed when emptied, and expires', () => {
  const editor = loadTsx(EDITOR);
  const store = memoryStore();
  editor.keepDescriptionDraft(store, 7, 42, 'fits', 5, NOW);
  editor.keepDescriptionDraft(store, 7, 42, 'far too long for the limit', 5, NOW);
  assert.equal(editor.keptDescriptionDraft(store, 7, 42, NOW), 'fits', 'the last copy that fit stays');

  editor.keepDescriptionDraft(store, 7, 42, '', 5, NOW);
  assert.equal(store.length, 0, 'emptying the field forgets the copy');

  editor.keepDescriptionDraft(store, 7, 42, 'almost old', 16000, NOW - KEPT_MAX_AGE_MS + 1);
  assert.equal(editor.keptDescriptionDraft(store, 7, 42, NOW), 'almost old');
  assert.equal(editor.keptDescriptionDraft(store, 7, 42, NOW + 1), null);
  assert.equal(store.length, 0, 'an expired copy is forgotten when it is read');

  store.setItem(editor.descriptionDraftKey(7, 42), '{not json');
  assert.equal(editor.keptDescriptionDraft(store, 7, 42, NOW), null);
  assert.equal(store.length, 0, 'a corrupt copy is forgotten when it is read');
});

test('forgetting a kept description removes it', () => {
  const editor = loadTsx(EDITOR);
  const store = memoryStore();
  editor.keepDescriptionDraft(store, 7, 42, 'draft', 16000, NOW);
  editor.forgetDescriptionDraft(store, 7, 42);
  assert.equal(store.length, 0);
  assert.equal(editor.keptDescriptionDraft(store, 7, 42, NOW), null);
});

test('the editor writes as it is typed, restores on open, and clears on save or an emptied close', () => {
  const source = fs.readFileSync(path.join(ROOT, EDITOR), 'utf8');
  assert.match(source, /onChange=\{\(event\) => \{[\s\S]*?keepDescriptionDraft\(draftStore\(\), draftUserId\(\), id, value, current\.maxLength\)/);
  assert.match(source, /const kept = keptDescriptionDraft\(draftStore\(\), userId, id\);/);
  assert.match(source, /setDraft\(kept\); setLatest\(data\); setRestored\(true\);/);
  assert.match(source, /forgetDescriptionDraft\(draftStore\(\), draftUserId\(\), id\);\s*setCurrent\(data\)/, 'a save clears the copy');
  assert.match(source, /if \(loadedRef\.current && !draftRef\.current\.trim\(\)\) forgetDescriptionDraft\(draftStore\(\), draftUserId\(\), id\);/, 'an emptied close clears the copy');
  assert.match(source, /const \[restored, setRestored\] = useState\(false\);/);
  assert.match(source, /project:topic\.editor\.restored/);
});

test('a session that is over does not sweep the kept description', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  assert.equal(app.includes('description-draft'), false);
  assert.match(app, /window\.UsernodeReact\?\.keptCopies\?\.clear\?\.\(\)/);
});
