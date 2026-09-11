'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const curation = require('../src/services/discovery-curation');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { BrowseRows } = loadTsx('frontend/src/features/apps/browse-list.tsx');

const app = (over = {}) => ({
  status: 'running', main_sha: 'a'.repeat(40), icon_emoji: '🎮',
  last_deploy_at: '2026-09-01T12:00:00Z', directory_review_status: 'working',
  directory_reviewed_at: '2026-09-01T13:00:00Z', directory_reviewed_sha: 'a'.repeat(40), ...over,
});

test('only a reviewed current deployment with an intentional icon is ready', () => {
  assert.equal(curation.describe(app()).tier, 'ready');
  assert.equal(curation.describe(app({ icon_emoji: null, icon_image_id: 'image-id' })).tier, 'ready');
  assert.equal(curation.describe(app({ icon_emoji: null, icon_url: '/app-icons/image-id' })).tier, 'ready');
  for (const icon of [null, '', '  ']) {
    const result = curation.describe(app({ icon_emoji: icon }));
    assert.equal(result.tier, 'more'); assert.equal(result.state, 'missing_icon');
  }
  for (const status of ['creating', 'error', 'awaiting_secrets']) {
    assert.equal(curation.describe(app({ status })).tier, 'more');
  }
  assert.notEqual(curation.describe(app({ self_hosted: true })).tier, 'ready');
});

test('deployment health, popularity, featuring and staging demo flags are not editorial reviews', () => {
  for (const directory_review_status of [null, 'unreviewed', 'unknown']) {
    const result = curation.describe(app({ directory_review_status, featured: true, active_users: 9999 }));
    assert.equal(result.tier, 'unreviewed'); assert.equal(result.label, 'Not yet reviewed');
  }
  assert.equal(curation.describe(app({ demo: true })).tier, 'ready', 'inert staging fixtures can simulate a working review');
  for (const directory_review_status of ['demo', 'broken']) {
    const result = curation.describe(app({ directory_review_status, active_users: 9999, featured: true }));
    assert.equal(result.tier, 'more'); assert.equal(result.state, directory_review_status);
  }
});

test('changing code or redeploying the same code retires the working claim', () => {
  for (const override of [
    { main_sha: 'b'.repeat(40) }, { main_sha: null }, { directory_reviewed_sha: null },
    { last_deploy_at: '2026-09-01T14:00:00Z' }, { last_deploy_at: 'invalid' },
    { directory_reviewed_at: null }, { directory_reviewed_at: 'invalid' },
  ]) {
    const result = curation.describe(app(override));
    assert.equal(result.tier, 'unreviewed', JSON.stringify(override));
    assert.equal(result.label, 'Needs re-review');
  }
  assert.equal(curation.describe(app({ last_deploy_at: new Date('2026-09-01T13:00:00Z') })).tier, 'ready');
  assert.equal(curation.describe(app({ last_deploy_at: null })).tier, 'ready');
});

const row = (slug, override = {}) => {
  const a = { slug, name: slug, ...app(override) };
  a.directory = curation.describe(a);
  return { app: a, slug, name: slug, meta: '1 user', status: 'Running', statusDot: 'bg-green-500',
    demo: false, openable: true, added: false, addTitle: 'Add to Your apps', directoryTier: a.directory.tier };
};
const rows = [row('ready'), row('unreviewed', { directory_review_status: 'unreviewed' }),
  row('demo-only', { directory_review_status: 'demo' }), row('broken', { directory_review_status: 'broken' }),
  row('iconless', { icon_emoji: null })];
const render = (props = {}) => renderToHtml(createElement(BrowseRows, { rows, curated: true, ...props }));

test('directory renders reviewed apps first, leaves unreviewed visible, and discloses the rest accessibly', () => {
  const html = render();
  assert.ok(html.indexOf('data-slug="ready"') < html.indexOf('data-slug="unreviewed"'));
  assert.match(html, /Reviewed working apps/);
  assert.match(html, /Show more \(3\)/);
  assert.match(html, /aria-expanded="false" aria-controls="browse-more-apps"/);
  assert.match(html, /id="browse-more-apps" class="hidden"/);
  for (const slug of ['demo-only', 'broken', 'iconless']) assert.ok(!html.includes(`data-slug="${slug}"`));
  const expanded = render({ moreExpanded: true });
  assert.match(expanded, /aria-expanded="true"/);
  assert.match(expanded, /Show less/);
  for (const slug of ['demo-only', 'broken', 'iconless']) assert.ok(expanded.includes(`data-slug="${slug}"`));
  assert.match(expanded, /Needs fixes/);
  assert.match(expanded, /Needs an icon/);
  assert.doesNotMatch(expanded, /data-demo="true"/, 'real demo apps retain their navigation and Add actions');
});

test('#1912: a metric sort is one list in its own order, and still discloses the rest', () => {
  // Supplied in "sort order" with an unreviewed app FIRST: ungrouped keeps it
  // there instead of lifting the reviewed one above it under a heading.
  const ordered = [rows[1], rows[0], rows[2], rows[3], rows[4]];
  const html = render({ rows: ordered, grouped: false });
  assert.ok(html.indexOf('data-slug="unreviewed"') < html.indexOf('data-slug="ready"'), 'the sort order holds');
  assert.doesNotMatch(html, /<h2[^>]*>(Reviewed working apps|Not yet reviewed)</, 'no tier headings');
  assert.match(render(), /<h2[^>]*>Reviewed working apps</, 'while Recommended keeps them');
  assert.match(html, /Show more \(3\)/, 'the same disclosure as Recommended');
  for (const slug of ['demo-only', 'broken', 'iconless']) assert.ok(!html.includes(`data-slug="${slug}"`));
  const expanded = render({ rows: ordered, grouped: false, moreExpanded: true });
  for (const slug of ['demo-only', 'broken', 'iconless']) assert.ok(expanded.includes(`data-slug="${slug}"`));
});

test('search renders all supplied results without disclosure', () => {
  const html = render({ curated: false });
  for (const { slug } of rows) assert.ok(html.includes(`data-slug="${slug}"`));
  assert.doesNotMatch(html, /Show more|browse-more-apps/);
  assert.equal(render({ rows: null }), '', 'no data-dependent markup before hydration');
  assert.equal(render({ rows: [] }), '', 'no dead disclosure on an empty directory');
  assert.match(render({ rows: [rows[2]] }), /Show more \(1\)/, 'even an all-demo directory remains reachable');
});

test('staging preview fixtures exercise real curation logic without certifying real apps', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/apps.js'), 'utf8');
  const start = source.indexOf('function demoIconApps(');
  const end = source.indexOf('// SELF-HOSTING.md sub-step 2k', start);
  const fixture = new Function('discoveryCuration', 'DEMO_ICON_PNG', 'demoAgo',
    `${source.slice(start, end)}; return demoIconApps;`)(curation, 'data:image/png;base64,fixture', () => '2026-01-01T00:00:00Z');
  assert.ok(fixture().filter((a) => a.featured).every((a) => a.directory.tier === 'ready'));
  const samples = fixture(true).filter((a) => a.slug.startsWith('directory-sample-'));
  assert.deepEqual(samples.map((a) => a.directory.tier), ['ready', 'unreviewed', 'more', 'more', 'more']);
  assert.match(source, /if \(IS_STAGING && req.query.demo === '1'\)/);
});

test('admin review explains the manual verification and exposes existing review states', () => {
  const { DirectoryReview } = loadTsx('frontend/src/features/admin/admin-featured-apps.tsx');
  const html = renderToHtml(createElement(DirectoryReview, { apps: [
    { slug: 'sample', name: 'Sample', directory: { label: 'Needs fixes', tier: 'more' } },
  ], onSaved: () => {} }));
  assert.match(html, /Directory review/);
  assert.match(html, /Running alone is not verification/);
  assert.match(html, /Sample: Needs fixes/);
  assert.match(html, /role="status"/);
  assert.doesNotMatch(html, /Save review/, 'no review can be saved before an app is selected');
});
