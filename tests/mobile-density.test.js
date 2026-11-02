// #1617's first mobile-density slice (its Dev-chat Details sheet reverted by
// #1940). Render contracts run in npm test;
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

test('#1940: the provider and PR link show directly at every width — no Details sheet', () => {
  header.sessionHeaderStore.set({
    sessionId: 12, title: 'A longer change name', branch: 'test/long-title', pr: 21,
    prTitle: 'This session’s PR', newChangeTitle: '', life: null, busy: false,
    venue: { id: 'usernode-openrouter', label: 'Homeroom · OpenRouter', title: 'Choose where to build', disabled: false },
  });
  header.improveStore.set({ previewSessionId: null, previewUrl: null, previewActive: false });
  const html = renderToHtml(createElement(header.SessionHeader));
  assert.match(html, /dc-session-title[^>]*>A longer change name</);
  assert.doesNotMatch(html, /dc-session-details-trigger|aria-haspopup="dialog"|dc-session-details/,
    'the Details button and its dialog are gone');
  assert.match(html, /id="dc-pr-header-link"/);
  assert.doesNotMatch(html, /id="dc-pr-header-link"[^>]*max-sm:hidden/, 'the PR link is not hidden on phones');
  assert.match(html, /id="dc-venue-select"/);
  assert.doesNotMatch(html, /id="dc-venue-select"[^>]*max-sm:hidden/, 'Built with is not hidden on phones');
  assert.equal(tokenize(html).filter(t => t.kind === 'open' && t.attrs.some(a => a.name === 'id' && a.value === 'dc-venue-select')).length, 1);
});

test('Discover keeps the full app name, metadata and explicit add/remove action in one row', () => {
  const row = { app: {}, slug: 'long-app', name: 'A very long community application name',
    meta: '11 users · Updated recently', status: 'Running', statusDot: 'bg-emerald-500',
    openable: true, demo: false, added: false, addTitle: 'Join A very long community application name' };
  const render = added => renderToHtml(createElement(BrowseRows, { rows: [{ ...row, added, canOpen: true }] }));
  const html = render(false);
  for (const hook of ['browse-row-content', 'browse-row-title', 'browse-row-meta', 'browse-row-name']) assert.ok(html.includes(hook));
  assert.ok(html.includes(row.name));
  assert.ok(html.includes(row.meta));
  // QA 2026-09-24 Q10: one short word on screen ("+ Join", communities), and
  // what is being joined in the accessible name.
  assert.match(html, /data-added="false" data-action="join" aria-label="Join A very long community application name"[^>]*>.*Join<\/button>/);
  assert.equal((html.match(/<button[^>]*class="[^"]*\bbrowse-add-btn\b/g) || []).length, 1, 'no duplicated responsive buttons');
  // #5267: a joined row offers Open, one short word, not "✓ Joined".
  assert.match(render(true), /data-added="true" data-action="open" aria-label="Open A very long community application name"[^>]*>Open<\/button>/);
  assert.doesNotMatch(render(true), />Joined</);
});

test('Discover rows keep one compact shape on a phone; the Dev session title still reflows', () => {
  const css = read('public/css/app.css');
  // Overnight audit W08 retired #1617's phone grid (name on its own row, the
  // meta line and a 44px Join under it), which made every row ~96px tall.
  assert.doesNotMatch(css, /\.browse-row\.browse-row \{\s*display: grid;/);
  assert.doesNotMatch(css, /\.browse-row \.browse-row-title \{ grid-column/);
  assert.match(css, /@media \(max-width: 639px\) \{\s*#dc-session-header > \.dc-session-title \{\s*white-space: normal;\s*overflow-wrap: anywhere;/);
  assert.match(css, /-webkit-line-clamp: 2;/, 'very long session names do not consume the chat');
});

test('#1940: the session header no longer carries a dialog of its own', () => {
  const src = read('frontend/src/features/dev-chat/session-header.tsx');
  assert.doesNotMatch(src, /useDialog\(|createPortal|DialogRoot/);
  const css = read('public/css/app.css');
  assert.doesNotMatch(css, /dc-venue-details-select/, 'the Details-only provider styles went with it');
  // The provider still caps its own width, which is what lets it sit in a
  // 360px strip beside the title, the PR link and the mode switch.
  assert.match(css, /\n\.dc-venue-select \{[^}]*max-width: min\(45%, 14rem\);/);
});

// QA 2026-09-24 Q10: at 1440 names were cut to ~10 characters in the desktop
// boxes, at 1024 the name column was 0px wide, and at 360 the directory label
// was clipped mid-word with no ellipsis.
test('Discover names may take two lines in the boxes, and every meta line ellipsises', () => {
  const css = read('public/css/app.css');
  const block = css.slice(css.indexOf('QA 2026-09-24 Q10'));
  // At every width now (W08), and broken between words (L05: `anywhere` cut
  // "Group" to "Grou / p" in a narrow card).
  const rows = css.slice(css.indexOf('ONE ROW SHAPE AT EVERY WIDTH'));
  assert.match(rows, /\*\/\n\.browse-row \.browse-row-title \{ white-space: normal; \}/);
  assert.match(rows, /\.browse-row \.browse-row-name \{\s*display: -webkit-box;\s*-webkit-box-orient: vertical;\s*-webkit-line-clamp: 2;[^}]*overflow-wrap: break-word;/);
  const row = { app: { directory: { label: 'Reviewed working' } }, slug: 's', name: 'N', meta: '0 users · Updated 1d ago',
    status: 'Running', statusDot: 'bg-emerald-500', openable: true, demo: false, added: false, addTitle: 'Add to Your apps' };
  const html = renderToHtml(createElement(BrowseRows, { rows: [row] }));
  assert.match(html, /<span class="block truncate text-xs[^"]*">Reviewed working<\/span>/);
  assert.match(html, /<span class="block truncate">0 users · Updated 1d ago<\/span>/);
});
