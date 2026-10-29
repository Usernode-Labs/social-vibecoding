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
  last_deploy_at: '2026-09-01T12:00:00Z', directory_review_status: 'unreviewed', ...over,
});

test('an app that runs and has an icon is listed, with no review', () => {
  assert.deepEqual(curation.describe(app()), { state: 'listed', tier: 'listed', label: null, flagged: false, flaggedAt: null });
  assert.equal(curation.describe(app({ icon_emoji: null, icon_image_id: 'image-id' })).tier, 'listed');
  assert.equal(curation.describe(app({ icon_emoji: null, icon_url: '/app-icons/image-id' })).tier, 'listed');
  // Whatever a review used to say, and however long ago it deployed: no
  // version pinning, nothing that lapses on a deploy.
  for (const over of [{ directory_review_status: 'working' }, { directory_review_status: null },
    { main_sha: 'b'.repeat(40) }, { main_sha: null }, { last_deploy_at: '2030-01-01T00:00:00Z' }, { demo: true }]) {
    assert.equal(curation.describe(app(over)).tier, 'listed', JSON.stringify(over));
  }
  for (const icon of [null, '', '  ']) {
    const result = curation.describe(app({ icon_emoji: icon }));
    assert.equal(result.tier, 'more'); assert.equal(result.state, 'missing_icon'); assert.equal(result.label, 'Needs an icon');
  }
  for (const status of ['creating', 'error', 'awaiting_secrets']) {
    const result = curation.describe(app({ status }));
    assert.equal(result.tier, 'more'); assert.equal(result.label, 'Not running');
  }
});

test('an admin\'s flag hides an app from Discover, whatever its numbers, and is the only editorial state', () => {
  for (const directory_review_status of ['demo', 'broken']) {
    const result = curation.describe(app({ directory_review_status, active_users: 9999, featured: true,
      directory_reviewed_at: '2026-10-29T12:00:00Z' }));
    assert.deepEqual(result, { state: 'flagged', tier: 'hidden', label: 'Hidden from Discover', flagged: true,
      flaggedAt: '2026-10-29T12:00:00.000Z' });
  }
  // A flag wins over not running and no icon: it is left out, not under Show more.
  assert.equal(curation.describe(app({ directory_review_status: 'broken', status: 'error', icon_emoji: null })).tier, 'hidden');
  assert.equal(curation.isFlagged(app({ directory_review_status: curation.FLAGGED })), true);
  assert.equal(curation.isFlagged(app({ directory_review_status: curation.UNFLAGGED })), false);
  assert.deepEqual(curation.FLAGGED_STATES, ['demo', 'broken']);
});

test('featuring needs an icon and no flag, and says which is missing', () => {
  assert.equal(curation.featureRefusal(app()), null);
  assert.equal(curation.featureRefusal(app({ status: 'error' })), null, 'a stopped app is left out where it would show, not refused');
  assert.match(curation.featureRefusal(app({ icon_emoji: null })), /has no icon/);
  assert.match(curation.featureRefusal(app({ directory_review_status: 'broken' })), /is flagged[\s\S]*Clear the flag/);
});

const row = (slug, override = {}) => {
  const a = { slug, name: slug, ...app(override) };
  a.directory = curation.describe(a);
  return { app: a, slug, name: slug, meta: '1 user', status: 'Running', statusDot: 'bg-green-500',
    demo: false, openable: true, added: false, addTitle: 'Add to Your apps',
    directoryTier: a.directory.tier === 'listed' ? 'ready' : 'more' };
};
const rows = [row('ready'), row('second'),
  row('stopped', { status: 'error' }), row('creating', { status: 'creating' }),
  row('iconless', { icon_emoji: null })];
const render = (props = {}) => renderToHtml(createElement(BrowseRows, { rows, curated: true, ...props }));

test('directory lists the apps that run, and discloses the rest accessibly', () => {
  const html = render();
  assert.ok(html.indexOf('data-slug="ready"') < html.indexOf('data-slug="second"'));
  // #5267: one heading over them.
  assert.match(html, /<h2[^>]*>All apps</);
  assert.match(html, /Show more \(3\)/);
  assert.match(html, /aria-expanded="false" aria-controls="browse-more-apps"/);
  assert.match(html, /id="browse-more-apps" class="hidden"/);
  for (const slug of ['stopped', 'creating', 'iconless']) assert.ok(!html.includes(`data-slug="${slug}"`));
  const expanded = render({ moreExpanded: true });
  assert.match(expanded, /aria-expanded="true"/);
  assert.match(expanded, /Show less/);
  for (const slug of ['stopped', 'creating', 'iconless']) assert.ok(expanded.includes(`data-slug="${slug}"`));
  assert.match(expanded, /Not running/);
  assert.match(expanded, /Needs an icon/);
  assert.doesNotMatch(expanded, /data-demo="true"/, 'real apps retain their navigation and Add actions');
});

test('#1912: a metric sort is one list in its own order, and still discloses the rest', () => {
  // Supplied in "sort order" with the second app FIRST: ungrouped keeps it
  // there.
  const ordered = [rows[1], rows[0], rows[2], rows[3], rows[4]];
  const html = render({ rows: ordered, grouped: false });
  assert.ok(html.indexOf('data-slug="second"') < html.indexOf('data-slug="ready"'), 'the sort order holds');
  assert.doesNotMatch(html, /<h2/, 'no headings');
  assert.match(render(), /<h2[^>]*>All apps</, 'while the default list keeps its heading');
  assert.match(html, /Show more \(3\)/, 'the same disclosure as Recommended');
  for (const slug of ['stopped', 'creating', 'iconless']) assert.ok(!html.includes(`data-slug="${slug}"`));
  const expanded = render({ rows: ordered, grouped: false, moreExpanded: true });
  for (const slug of ['stopped', 'creating', 'iconless']) assert.ok(expanded.includes(`data-slug="${slug}"`));
});

test('search renders all supplied results without disclosure', () => {
  const html = render({ curated: false });
  for (const { slug } of rows) assert.ok(html.includes(`data-slug="${slug}"`));
  assert.doesNotMatch(html, /Show more|browse-more-apps/);
  assert.equal(render({ rows: null }), '', 'no data-dependent markup before hydration');
  assert.equal(render({ rows: [] }), '', 'no dead disclosure on an empty directory');
  assert.match(render({ rows: [rows[2]] }), /Show more \(1\)/, 'even a directory of stopped apps remains reachable');
});

test('staging preview fixtures exercise the flag without touching real apps', () => {
  const { catalogFixtures: fixture } = require('../src/services/staging-apps');
  assert.ok(fixture().filter((a) => a.featured).every((a) => a.directory.tier === 'listed'));
  const samples = fixture(true).filter((a) => a.slug.startsWith('directory-sample-'));
  assert.deepEqual(samples.map((a) => [a.slug, a.directory.state]), [
    ['directory-sample-listed', 'listed'], ['directory-sample-flagged', 'flagged'], ['directory-sample-no-icon', 'missing_icon']]);
  // Preview serves the seeded row, not this in-memory copy, so the seed
  // stores the flag too.
  const seed = fs.readFileSync(path.join(__dirname, '../src/services/staging-apps.js'), 'utf8');
  assert.match(seed, /main_sha, directory_review_status, directory_reviewed_at\)/);
  assert.doesNotMatch(seed, /directory_reviewed_sha/);
  assert.match(fs.readFileSync(path.join(__dirname, '../src/routes/apps.js'), 'utf8'), /req.query.demo === '1'/);
});

test('a row names why it is under Show more, and a listed row says nothing', () => {
  const { rowDirectoryLabel } = loadTsx('frontend/src/features/apps/browse-list.tsx');
  assert.equal(rowDirectoryLabel(rows[0].app.directory), null);
  assert.equal(rowDirectoryLabel(rows[2].app.directory), 'Not running');
  assert.equal(rowDirectoryLabel(rows[4].app.directory), 'Needs an icon');
  // Only the Joined view lists a flagged app, and its row says why it is
  // nowhere else in Discover.
  assert.equal(rowDirectoryLabel(curation.describe(app({ directory_review_status: 'broken' }))), 'Hidden from Discover');
  assert.equal(rowDirectoryLabel(null), null);
  for (const html of [render(), render({ grouped: false }), render({ curated: false })]) {
    assert.doesNotMatch(html, /review/i);
  }
});

test('#5267, #5928: Featured leads the default list, and the rest is More apps', () => {
  const picked = { ...row('picked'), recommended: true };
  const html = render({ rows: [picked, rows[0], rows[1]] });
  // Staff picks, not a personal recommendation (#5928): the heading says so.
  assert.doesNotMatch(html, /Recommended for you/);
  const rec = html.indexOf('>Featured</h2>');
  const more = html.indexOf('>More apps</h2>');
  assert.ok(rec >= 0 && rec < html.indexOf('data-slug="picked"'));
  assert.ok(html.indexOf('data-slug="picked"') < more && more < html.indexOf('data-slug="ready"'));
  assert.doesNotMatch(html, />All apps</);
  // A joined row offers Open; a row you are not in offers Join.
  const joined = { ...row('joined'), added: true, canOpen: true };
  const both = render({ rows: [joined, rows[0]], curated: false });
  assert.match(both, /data-added="true" data-action="open" aria-label="Open joined"[^>]*>Open</);
  assert.match(both, /data-added="false" data-action="join" aria-label="Join ready"/);
  assert.doesNotMatch(both, />Joined</);
  // One that cannot run has nothing to open: the row itself opens its page.
  assert.doesNotMatch(render({ rows: [{ ...joined, canOpen: false }], curated: false }), /browse-add-btn/);
});

test('#5928: Join is the accent pill, Open the quieter neutral one, both through Button', () => {
  const { buttonVariants } = loadTsx('frontend/@/components/ui/button.tsx');
  const joined = { ...row('joined'), added: true, canOpen: true, canLeave: true };
  const html = render({ rows: [joined, rows[0]], curated: false });
  const classOf = (action) => {
    const tag = (html.match(new RegExp(`<button[^>]*data-action="${action}"[^>]*>`)) || [])[0];
    assert.ok(tag, `a ${action} button`);
    return tag.match(/class="([^"]*)"/)[1].split(/\s+/);
  };
  const has = (classes, run) => run.split(/\s+/).every((c) => classes.includes(c));
  const join = classOf('join');
  const open = classOf('open');
  // The primitive's own variants, not a hand-copied fill.
  assert.ok(has(join, buttonVariants({ variant: 'pillAccent', size: 'none', ink: 'solid' })), 'Join is Button pillAccent');
  assert.ok(has(open, buttonVariants({ variant: 'pillNeutral', size: 'none', ink: 'neutral' })), 'Open is Button pillNeutral');
  assert.ok(!open.some((c) => c.includes('violet')), 'Open carries no accent');
  for (const classes of [join, open]) assert.ok(classes.includes('browse-add-btn'), 'the click guard and checks hook stays');
  // 44px to tap at every width below the shell's md (768px): on the element
  // itself, released only from md up. Leave beside Open too.
  for (const [name, classes] of [['join', join], ['open', open], ['leave', classOf('leave')]]) {
    assert.ok(classes.includes('min-h-[44px]'), `${name} is 44px tall below md`);
    assert.ok(classes.includes('md:min-h-0'), `${name} returns to its compact size from md`);
    assert.ok(!classes.some((c) => /^(sm):min-h/.test(c)), `${name} is not released at 640px`);
  }
  // md is Tailwind's default 768px: the config sets no screens of its own.
  const config = require('../tailwind.config.js');
  assert.equal(config.theme?.screens ?? config.theme?.extend?.screens, undefined);
});

test('#5928: a row says what the app is, in its own words, when it has them', () => {
  const described = { ...row('described'), about: 'Count sheep before bed.' };
  const html = render({ rows: [described, rows[0]], curated: false });
  const at = html.indexOf('data-slug="described"');
  const about = html.indexOf('class="browse-row-about', at);
  assert.ok(about > at && about < html.indexOf('data-slug="ready"'), 'the line is on its own row');
  assert.match(html, /class="browse-row-about[^"]*"[^>]*>Count sheep before bed\.<\/span>/);
  assert.equal((html.match(/browse-row-about/g) || []).length, 1, 'no filler line on a row without one');
  // Not the small label's size.
  assert.doesNotMatch(html, /class="browse-row-about[^"]*text-xs/);
});

test('the admin console lists flagged apps and flags one only after asking; a view-only admin reads the list', () => {
  const { DiscoverFlags, canFeature } = loadTsx('frontend/src/features/admin/admin-featured-apps.tsx');
  const flagged = { slug: 'hidden-one', name: 'Hidden one', icon_emoji: '🚩', directory: curation.describe(app({ directory_review_status: 'broken' })) };
  const listed = { slug: 'listed-one', name: 'Listed one', icon_emoji: '🧩', directory: curation.describe(app()) };
  const html = renderToHtml(createElement(DiscoverFlags, { apps: [flagged, listed], canWrite: true, onChanged: () => {} }));
  assert.match(html, /Flagged apps/);
  assert.match(html, /left out of Discover and Featured everywhere/);
  assert.match(html, /data-flagged-row="hidden-one"/);
  assert.doesNotMatch(html, /data-flagged-row="listed-one"/);
  assert.match(html, /data-unflag="hidden-one"[^>]*>Clear flag</);
  assert.match(html, /<option value="listed-one">Listed one<\/option>/, 'the picker offers only unflagged apps');
  assert.doesNotMatch(html, /<option value="hidden-one">/);
  assert.match(html, /role="status"/);
  assert.doesNotMatch(html, /review/i);

  const readOnly = renderToHtml(createElement(DiscoverFlags, { apps: [flagged], canWrite: false, onChanged: () => {} }));
  assert.match(readOnly, /data-flagged-row="hidden-one"/);
  assert.doesNotMatch(readOnly, /Clear flag|admin-flag-picker/, 'a view-only admin reads the list');
  assert.match(renderToHtml(createElement(DiscoverFlags, { apps: [listed], canWrite: true, onChanged: () => {} })), /No app is flagged/);

  const src = fs.readFileSync(path.join(__dirname, '../frontend/src/features/admin/admin-featured-apps.tsx'), 'utf8');
  assert.match(src, /_confirm\(\{[\s\S]*?danger: true/, 'flagging asks first');
  assert.match(src, /\/api\/admin\/apps\/\$\{encodeURIComponent\(app\.slug\)\}\/discover-flag/);

  assert.equal(canFeature(listed), true);
  assert.equal(canFeature(flagged), false);
  assert.equal(canFeature({ slug: 'x', directory: curation.describe(app({ icon_emoji: null })) }), false);
});
