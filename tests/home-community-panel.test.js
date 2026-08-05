'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public/js/home-panels.js'), 'utf8');

function load() {
  const sandbox = {
    console,
    App: { user: { id: 1 } },
    document: { addEventListener() {}, querySelectorAll() { return []; }, getElementById() { return null; } },
    location: { search: '', hash: '' },
    URLSearchParams, Date, setTimeout, clearTimeout,
    formatRelativeTime: () => '4m ago',
    addEventListener() {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__HP = HomePanels;`, sandbox);
  return { HP: sandbox.__HP, sandbox };
}

function item(over = {}) {
  return {
    id: 'proposal:8', type: 'proposal', occurred_at: '2026-08-05T10:00:00Z',
    actor: { username: 'builder' },
    app: { id: 2, slug: 'safe-app', name: 'Safe App' },
    proposal: { id: 8, number: 4, title: 'Useful change', status: 'proposed', author: 'builder' },
    ...over,
  };
}

test('community cards are escaped semantic buttons with machine-readable time', () => {
  const { HP } = load();
  const html = HP.renderCommunityRow(item({
    actor: { username: '\"><img src=x>' },
    proposal: { id: 8, title: '<script>alert(1)</script>', status: 'merged' },
  }));
  assert.match(html, /^\s*<button/);
  assert.match(html, /data-app-slug="safe-app"/);
  assert.match(html, /data-session-id="8"/);
  assert.match(html, /datetime="2026-08-05T10:00:00Z"/);
  assert.match(html, /4m ago/);
  assert.doesNotMatch(html, /<script>|<img/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /aria-label=/);
});

test('community panel has an honest empty state and an accessible expand control', () => {
  const { HP } = load();
  let html = HP.renderCommunityPanel({ key: 'community', title: 'Community activity', activity: [], has_more: false });
  assert.match(html, /No recent public activity/);
  assert.doesNotMatch(html, /See more activity/);
  html = HP.renderCommunityPanel({ key: 'community', title: 'Community activity', activity: [item()], has_more: true });
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /See more activity/);
});

test('community row wiring opens current app and proposal routes', () => {
  const { HP, sandbox } = load();
  const handlers = {};
  const row = {
    dataset: { appSlug: 'safe app', sessionId: '8' },
    addEventListener(type, fn) { handlers[type] = fn; },
  };
  const section = {
    querySelectorAll(selector) { return selector === '.home-social-row' ? [row] : []; },
    querySelector() { return null; },
  };
  HP._wire(section);
  handlers.click({ stopPropagation() {} });
  assert.equal(sandbox.location.hash, '#app/safe%20app/dev/proposals/8');
  row.dataset.sessionId = '';
  handlers.click({ stopPropagation() {} });
  assert.equal(sandbox.location.hash, '#app/safe%20app/app');
});
