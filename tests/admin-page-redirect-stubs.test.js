// Redirect stubs for the seven retired standalone admin pages (#860).
//
// /admin, /admin-features, /dashboard, /debug, /gallery, /status and
// /node-status are sections of the in-app #admin console now. Their old
// URLs must keep working — nothing 404s — so each public/<name>.html is a
// tiny client-side stub that rewrites the URL into the matching
// #admin/<section>.
//
// Contract pinned here:
//   - every stub exists, is genuinely a stub (no leftover page markup), and
//     maps to the right section;
//   - the QUERY STRING is preserved — `?demo=1` is how the staging seed
//     data is reached, and the SPA form is /?demo=1#admin/<section>;
//   - /admin#campaign-<id> maps to #admin/campaigns/<id> rather than losing
//     the campaign id (the whole reason these are client-side stubs and not
//     server 302s: a 302's own Location fragment wins over the request's);
//   - the server routes still serve these files, so both /admin and
//     /admin.html forward;
//   - no page in the repo links to the retired pages any more.
//
// Run with: node --test tests/admin-page-redirect-stubs.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// old page file → the hash route it must land on
const STUBS = {
  'admin.html': '#admin',
  'admin-features.html': '#admin/features',
  'dashboard.html': '#admin/analytics',
  'debug.html': '#admin/merges',
  'gallery.html': '#admin/gallery',
  'status.html': '#admin/status',
  'node-status.html': '#admin/node',
};

test('every retired page is a small stub that redirects into its section', () => {
  for (const [file, route] of Object.entries(STUBS)) {
    const src = read(path.join('public', file));
    assert.ok(src.includes('location.replace('),
      `${file} redirects with location.replace`);
    assert.ok(src.includes(route), `${file} targets ${route}`);
    // A stub, not a page: no CDN Tailwind, no page script, no <main>.
    assert.ok(!src.includes('cdn.tailwindcss.com'), `${file} no longer loads Tailwind`);
    assert.ok(!/<main\b/.test(src), `${file} carries no page markup`);
    assert.ok(src.split('\n').length < 40, `${file} stays a stub (<40 lines)`);
    // Graceful degrade without JS.
    assert.match(src, /<noscript>[\s\S]*href="\//, `${file} has a <noscript> fallback link`);
  }
});

test('stubs preserve the query string so ?demo=1 still reaches the seeded view', () => {
  for (const file of Object.keys(STUBS)) {
    const src = read(path.join('public', file));
    assert.ok(/location\.search/.test(src),
      `${file} carries location.search through to the SPA URL`);
  }
});

test('/admin#campaign-<id> deep-links the campaign instead of losing the id', () => {
  const src = read('public/admin.html');
  assert.match(src, /#campaign-\(\\d\+\)/,
    'admin.html matches the legacy #campaign-<id> fragment');
  assert.match(src, /'#admin\/campaigns\/' \+ m\[1\]/,
    'and maps it onto #admin/campaigns/<id>');
  // The consuming side owns that second hash level.
  const campaigns = read('frontend/src/features/admin/admin-campaigns.js');
  assert.match(campaigns, /#admin\\\/campaigns\\\/\(\\d\+\)/,
    'admin-campaigns.js reads the campaign id back out of the hash');
});

test('the server still serves each stub, before the SPA fallback', () => {
  const server = read('server.js');
  for (const route of ['/admin', '/admin-features', '/dashboard', '/debug', '/gallery']) {
    const re = new RegExp(`app\\.get\\('${route}'`);
    assert.match(server, re, `server.js keeps a route for ${route}`);
  }
  // Registration order matters: the SPA catch-all would swallow them
  // otherwise. Match the actual handler, not the comment that mentions it.
  assert.ok(server.indexOf("app.get('/admin'") < server.indexOf("app.get('*', (req, res)"),
    'the stub routes are registered before the SPA catch-all');
  // /status and /node-status live elsewhere.
  assert.match(read('src/routes/status.js'), /router\.get\('\/status'/,
    'src/routes/status.js keeps the /status route');
  assert.match(server, /app\.get\('\/node-status'/,
    'server.js keeps the /node-status route');
});

test('the public JSON endpoints stay mounted before authMiddleware', () => {
  // With the pages folded into the signed-in console these endpoints ARE the
  // anonymous surface (external monitoring, embedded child-app reads), so
  // they must not drift behind the auth gate.
  const server = read('server.js');
  const authIdx = server.indexOf('app.use(authMiddleware');
  assert.ok(authIdx > 0, 'authMiddleware is mounted in server.js');
  for (const route of ["app.get('/api/node-status'", "app.get('/api/node-status/full'"]) {
    const idx = server.indexOf(route);
    assert.ok(idx > 0 && idx < authIdx, `${route} is mounted before authMiddleware`);
  }
  assert.ok(server.indexOf('app.use(statusRoutes(config))') < authIdx,
    'statusRoutes (which owns GET /api/status) is mounted before authMiddleware');
});

test('nothing links to the retired standalone pages any more', () => {
  // The old pages each carried a hand-rolled row of cross-links; the console
  // menu replaces them. A stray href would send an admin back out of the app.
  // The console's ten modules live in the React bundle since #1082 chunk E;
  // public/js is still scanned because a future admin-* module there would be
  // just as able to smuggle one of these links back in.
  const dirs = ['frontend/src/features/admin', 'public/js'];
  const files = ['public/index.html'].concat(dirs.flatMap((dir) => fs
    .readdirSync(path.join(root, dir))
    .filter((f) => f.startsWith('admin-') && f.endsWith('.js'))
    .map((f) => path.join(dir, f))));
  for (const rel of files) {
    const src = read(rel);
    for (const href of ['href="/dashboard"', 'href="/debug"', 'href="/gallery"',
      'href="/status"', 'href="/admin"', 'href="/node-status"', 'href="/admin-features"']) {
      assert.ok(!src.includes(href), `${rel} must not link to ${href}`);
    }
  }
});
