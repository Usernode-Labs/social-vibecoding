'use strict';

// The "Deduplicate user" form (frontend/src/features/admin/admin-user-merge.tsx)
// rendered for real: the entry button exists only for full admins, and the
// destructive button stays disabled until the exact username is typed. Plus
// the wiring into the Users details view and the platform rules the admin
// console holds every section to.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ENTRY = 'frontend/src/features/admin/admin-user-merge.tsx';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const SRC = read(ENTRY);
const USERS = read('frontend/src/features/admin/admin-users.tsx');
const mod = loadTsx(ENTRY);

const summary = (over) => ({
  id: 1, username: 'alice', display_name: null, email: 'alice@example.invalid', email_confirmed: true,
  created_at: '2026-01-02T00:00:00Z', role: 'user', has_wallet: false, providers: [], apps: 1, proposals: 0,
  messages: 3, points: 10, merge_away_blocked: null, keep_blocked: null,
  references: { 'chat_messages.user_id': 3, 'apps.created_by': 1 }, reference_total: 4, ...over,
});
const kept = summary({ id: 1, username: 'alice' });
const merged = summary({ id: 2, username: 'alice_old', email: 'old@example.invalid' });
const noop = () => {};

function confirmHtml(typed, extra = {}) {
  return renderToHtml(createElement(mod.MergeConfirmStep, {
    kept, merged, emailFrom: 'kept', typed, busy: false, error: null,
    onType: noop, onBack: noop, onMerge: noop, ...extra,
  }));
}
const submitTag = (html) => html.match(/<button[^>]*id="admin-user-merge-submit"[^>]*>/)[0];

test('the entry button renders only for a full admin', () => {
  assert.equal(renderToHtml(createElement(mod.MergeEntryButton, { canWrite: false, onOpen: noop })), '');
  const html = renderToHtml(createElement(mod.MergeEntryButton, { canWrite: true, onOpen: noop }));
  assert.match(html, /id="admin-user-merge-btn"/);
  assert.match(html, />Deduplicate user</);
});

test('Merge accounts stays disabled until the anonymised username is typed exactly', () => {
  for (const typed of ['', 'alice', 'Alice_old', 'alice_old ', 'alice_ol']) {
    assert.match(submitTag(confirmHtml(typed)), /disabled=""/, `disabled for "${typed}"`);
  }
  assert.doesNotMatch(submitTag(confirmHtml('alice_old')), /disabled=""/);
  assert.match(submitTag(confirmHtml('alice_old', { busy: true })), /disabled=""/, 'disabled while the request runs');
  assert.equal(mod.confirmationMatches('alice_old', 'alice_old'), true);
  assert.equal(mod.confirmationMatches('', ''), false);
});

test('the summary names both accounts, the email kept and the rows that move', () => {
  const html = confirmHtml('');
  assert.match(html, /Type alice_old to confirm/);
  assert.match(html, /alice \(User #1\)/);
  assert.match(html, /alice_old \(User #2\)/);
  assert.match(html, /merged-2/);
  assert.match(html, /alice@example\.invalid/);
  assert.match(confirmHtml('', { emailFrom: 'merged' }), /old@example\.invalid/);
  assert.match(html, /4 rows in 2 tables/);
  assert.doesNotMatch(html, /<a /, 'no address is rendered as a link');
  assert.match(confirmHtml('', { error: 'Server said no' }), /role="alert"[^>]*>Server said no</);
});

test('email options only offer addresses that exist', () => {
  assert.deepEqual(mod.emailOptions(kept, merged).map((o) => o.value), ['kept', 'merged']);
  assert.deepEqual(mod.emailOptions({ ...kept, email: null }, merged).map((o) => o.value), ['merged']);
  assert.deepEqual(mod.emailOptions(kept, { ...merged, email: '' }).map((o) => o.value), ['kept']);
});

test('the picker never offers the account itself', () => {
  const all = [{ id: 1, username: 'alice' }, { id: 2, username: 'alice_old' }, { id: 3, username: 'bob' }];
  assert.deepEqual(mod.filterCandidates(all, 1, 'alice').map((u) => u.id), [2]);
  assert.deepEqual(mod.filterCandidates(all, 1, '#3').map((u) => u.id), [3]);
  assert.deepEqual(mod.filterCandidates(all, 1, ''), []);
});

test('the details view gates the button and the panel on canWrite', () => {
  assert.match(USERS, /import \{ MergeEntryButton, UserMergePanel \} from '\.\/admin-user-merge\.tsx';/);
  assert.match(USERS, /<MergeEntryButton canWrite=\{canWrite\}/);
  assert.match(USERS, /\{canWrite && merging \? \(/);
  assert.match(USERS, /id="admin-user-merge-success"/);
});

test('every request path is spelled literally and the copy follows the console rules', () => {
  assert.ok(SRC.includes('`/api/admin/users/${user.id}/merge-preview?other=${other.id}`'));
  assert.ok(SRC.includes("send('POST', `/api/admin/users/${kept.id}/merge`"));
  assert.doesNotMatch(SRC, /const API\s*=/);
  assert.doesNotMatch(SRC, /@\/components\/ui/, 'the console surface, not shell primitives');
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  assert.ok(!code.includes('—'), 'no em dash in user-facing copy');
});
