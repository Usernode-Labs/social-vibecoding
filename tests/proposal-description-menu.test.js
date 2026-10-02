'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

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
