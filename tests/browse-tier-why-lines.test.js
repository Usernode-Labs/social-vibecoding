// #5928 item 2: Discover's tier headings say how their rows were picked. The
// heading stays grouped-list's SectionHeader, an <h2> with the label as its
// only child (dapp.json's `?sort=users` check reads `:not(:has(h2))`); the
// explanation is a sibling <p> after it, in the subtitle's size, spanning the
// grid the way the heading does.
const test = require('node:test');
const assert = require('node:assert/strict');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const { BrowseRows } = loadTsx('frontend/src/features/apps/browse-list.tsx');
const row = (slug, directoryTier, over = {}) => ({
  app: { slug, name: slug, directory: { tier: directoryTier, state: 'working' } },
  slug, name: slug, meta: '1 user', status: 'Running', statusDot: 'bg-green-500',
  demo: false, openable: true, added: false, addTitle: 'Add to Your apps', directoryTier, ...over,
});
const WHY = 'md:col-span-full px-4 -mt-1 pb-2 text-[13px] leading-5 text-zinc-500 dark:text-zinc-400';

test('Featured and More apps each carry one line saying how the rows were picked', () => {
  const html = renderToHtml(createElement(BrowseRows, {
    rows: [row('picked-app', 'ready', { recommended: true }), row('ready-app', 'ready')],
    curated: true,
  }));
  const featured = message('discover:list.why.recommended');
  const rest = message('discover:list.why.rest');
  assert.equal(featured, "Picked by Homeroom's staff.");
  assert.equal(rest, 'Every app that runs, the most used first.');
  assert.match(html, new RegExp(`<h2[^>]*>Featured</h2><p class="${WHY.replace(/[[\]]/g, '\\$&')}">Picked by Homeroom&#x27;s staff\\.</p>`),
    'the line follows its heading, and the heading keeps the label as its only child');
  assert.match(html, new RegExp(`<h2[^>]*>More apps</h2><p class="${WHY.replace(/[[\]]/g, '\\$&')}">${rest}</p>`));
});

test('Apps to try (no Featured group) carries the same line as More apps, and an ungrouped list none', () => {
  const grouped = renderToHtml(createElement(BrowseRows, { rows: [row('ready-app', 'ready')], curated: true }));
  assert.match(grouped, /<h2[^>]*>Apps to try<\/h2><p [^>]*>Every app that runs, the most used first\.<\/p>/);
  const flat = renderToHtml(createElement(BrowseRows, { rows: [row('ready-app', 'ready')], curated: false }));
  assert.doesNotMatch(flat, /<h2|the most used first|Homeroom&#x27;s staff/);
});
