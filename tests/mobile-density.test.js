// #1617's first mobile-density slice. Render contracts run in npm test;
// scripts/capture-mobile-density.mjs exercises the actual browser interactions.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { tokenize } = require('./helpers/html-tokens');
const { BrowseRows } = loadTsx('frontend/src/features/apps/browse-list.tsx');
const header = loadTsx('tests/fixtures/dev-session-header-api.ts');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('mobile Details is named, starts closed, and leaves desktop PR and provider hooks intact', () => {
  header.sessionHeaderStore.set({
    sessionId: 12, title: 'A longer change name', branch: 'test/long-title', pr: 21,
    prTitle: 'This session’s PR', newChangeTitle: '', life: null, busy: false,
    venue: { id: 'usernode-openrouter', label: 'Usernode · OpenRouter', title: 'Choose where to build', disabled: false },
  });
  header.improveStore.set({ previewSessionId: null, previewUrl: null, previewActive: false });
  const html = renderToHtml(createElement(header.SessionHeader));
  assert.match(html, /dc-session-title[^>]*>A longer change name</);
  assert.match(html, /dc-session-details-trigger[^>]*sm:hidden[^>]*aria-haspopup="dialog"[^>]*aria-expanded="false"[^>]*aria-controls="dc-session-details"/);
  assert.match(html, /id="dc-pr-header-link"[^>]*max-sm:hidden/);
  assert.match(html, /id="dc-venue-select"[^>]*max-sm:hidden/);
  assert.doesNotMatch(html, /id="dc-venue-details-select"/, 'closed Details has no second provider focus target');
  assert.equal(tokenize(html).filter(t => t.kind === 'open' && t.attrs.some(a => a.name === 'id' && a.value === 'dc-venue-select')).length, 1);
});

test('Discover keeps the full app name, metadata and explicit add/remove action in one row', () => {
  const row = { app: {}, slug: 'long-app', name: 'A very long community application name',
    meta: '11 users · Updated recently', status: 'Running', statusDot: 'bg-emerald-500',
    openable: true, demo: false, added: false, addTitle: 'Add to Your apps' };
  const render = added => renderToHtml(createElement(BrowseRows, { rows: [{ ...row, added }] }));
  const html = render(false);
  for (const hook of ['browse-row-content', 'browse-row-title', 'browse-row-meta', 'browse-row-name']) assert.ok(html.includes(hook));
  assert.ok(html.includes(row.name));
  assert.ok(html.includes(row.meta));
  assert.match(html, /data-added="false" aria-pressed="false"[^>]*>Add to Your apps</);
  assert.equal((html.match(/class="browse-add-btn/g) || []).length, 1, 'no duplicated responsive buttons');
  assert.match(render(true), /data-added="true" aria-pressed="true"/);
  assert.match(render(true), />Added</);
});

test('the title reflow is phone-only and scoped to Discover and the Dev session title', () => {
  const css = read('public/css/app.css');
  assert.match(css, /@media \(max-width: 639px\) \{\s*\.browse-row\.browse-row \{\s*display: grid;/);
  assert.match(css, /\.browse-row \.browse-row-title \{ grid-column: 2 \/ 4; grid-row: 1;/);
  assert.match(css, /\.browse-row > \.browse-add-btn \{ grid-column: 3; grid-row: 2; min-height: 44px;/);
  assert.match(css, /@media \(max-width: 639px\) \{\s*#dc-session-header > \.dc-session-title \{\s*white-space: normal;\s*overflow-wrap: anywhere;/);
  assert.match(css, /-webkit-line-clamp: 2;/, 'very long session names do not consume the chat');
});

test('Details uses the shared dialog lifecycle and a body portal for native-kit click delegation', () => {
  const src = read('frontend/src/features/dev-chat/session-header.tsx');
  assert.match(src, /useDialog\('sessionDetails'/);
  assert.match(src, /setDialogHome\(document\.body\)/);
  assert.match(src, /dialogHome \? createPortal\(/);
  assert.match(src, /<DialogRoot[^>]*ref=\{details.rootRef\}/);
  assert.match(src, /onClose: \(\) => \{\s*setShowDetails\(false\)/,
    'contents survive the exit animation and clear only after it ends');
  assert.match(src, /\[s.sessionId, s.branch, close\]/, 'changing sessions dismisses stale details');
});
