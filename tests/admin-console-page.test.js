// Full-page admin & moderation console (#818) — the second slice behind
// the #588 header icon: the "Coming soon" placeholder is replaced by a
// hash-routed #admin screen rendered by public/js/admin-console.js.
//
// Contract pinned here:
//  - the icon's click handler navigates to #admin (and still re-checks
//    the isAdmin gate — see admin-console-header-button.test.js for the
//    icon itself);
//  - the hash router has an `admin` branch, and navigateToAdminConsole
//    re-checks isAdmin so a hand-typed #admin from a non-admin bails home;
//  - the screen container ships hidden in the shell, like its siblings;
//  - PAGE VISIBILITY gates on isAdmin (view-only admins included) while
//    WRITE CONTROLS gate on canAdminWrite — the view-only-admin split
//    (issue #311) that is easy to break by using the wrong flag on either
//    side;
//  - no environment gating anywhere: staging and production get the
//    identical console;
//  - the dapp.json rendered check keeps the page actually rendering at
//    /#admin for the capture identity.
//
// Run with: node --test tests/admin-console-page.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
const consoleJs = fs.readFileSync(path.join(root, 'public/js/admin-console.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dapp.json'), 'utf8'));

test('the icon action navigates to the #admin hash route, gate first', () => {
  const fn = appJs.slice(appJs.indexOf('  openAdminConsole()'));
  assert.match(fn.slice(0, 300), /if \(!App\.user\?\.isAdmin\) return;/,
    'openAdminConsole re-checks the gate before navigating');
  assert.match(fn.slice(0, 400), /location\.hash = '#admin'/,
    'openAdminConsole routes through the hash — the console is a real page, not a modal');
  assert.ok(!/Coming soon/.test(fn.slice(0, 400)),
    'the placeholder alert is gone');
});

test('the hash router handles #admin[/section]', () => {
  assert.match(appJs, /parts\[0\] === 'admin'/,
    'restoreFromHash has an admin branch');
  assert.match(appJs, /App\.navigateToAdminConsole\(parts\[1\] \|\| null\)/,
    'the optional section segment deep-links a menu section');
});

test('navigateToAdminConsole re-checks isAdmin and bails home for non-admins', () => {
  const fn = appJs.slice(appJs.indexOf('  navigateToAdminConsole('));
  assert.ok(fn.length > 0, 'navigateToAdminConsole exists in app.js');
  // #860 restated the gate as `const isAdmin = !!App.user?.isAdmin` plus a
  // narrow public-section exception, so match on the flag rather than the
  // old single-line `if`. Still isAdmin (full AND view-only), never
  // canAdminWrite.
  assert.match(fn.slice(0, 400), /const isAdmin = !!App\.user\?\.isAdmin;/,
    'gate on isAdmin — full AND view-only admins, never canAdminWrite');
  assert.match(fn.slice(0, 400), /App\.navigateHome\(\)/,
    'a hand-typed #admin from a non-admin lands on home');
  assert.ok(!/canAdminWrite/.test(fn.slice(0, fn.indexOf('_exitAdminConsole'))),
    'page visibility must not gate on canAdminWrite — that excludes view-only admins');
});

test('the admin screen ships hidden in the shell like its siblings', () => {
  const main = html.match(/<main id="admin-screen"[^>]*>/);
  assert.ok(main, 'index.html carries #admin-screen');
  assert.match(main[0], /class="hidden /, 'ships hidden — revealed only by navigation');
  assert.ok(html.includes('id="admin-root"'), 'the module renders into #admin-root');
  assert.ok(html.includes('<script src="/js/admin-console.js"></script>'),
    'admin-console.js is loaded by the shell');
});

test('every full-screen exit path also exits the admin screen', () => {
  // The same _inX/_exitX discipline the leaderboard/challenges/profile
  // screens follow: missing one exit call leaves two screens stacked.
  const exits = appJs.match(/if \(App\._inAdmin\) App\._exitAdminConsole\(\);/g) || [];
  assert.ok(exits.length >= 6,
    `_exitAdminConsole is called from the sibling navigate/exit sites (found ${exits.length}, expect >= 6)`);
  assert.match(appJs, /else if \(App\._inAdmin\) App\.navigateHome\(\);/,
    'the empty-hash branch sends an open admin screen home');
});

test('write controls gate on canAdminWrite, in the module only', () => {
  assert.match(consoleJs, /canWrite\(\) \{ return !!\(window\.App && App\.user && App\.user\.canAdminWrite\); \}/,
    'the single write gate reads App.user.canAdminWrite');
  assert.ok(consoleJs.includes('admin-view-only-banner'),
    'view-only admins get the amber read-only banner');
  // The header-button test pins that app.js's admin-console functions
  // never mention canAdminWrite; keep the flag's only consumer here.
  const fns = appJs.slice(
    appJs.indexOf('  renderAdminButton()'),
    appJs.indexOf('  loadedPlatformSha:')
  );
  assert.ok(fns.length > 0, 'admin-console functions located in app.js');
  assert.ok(!/canAdminWrite/.test(fns),
    'app.js admin-console functions stay canAdminWrite-free');
});

test('the console is not gated on the environment', () => {
  // Comments legitimately *mention* USERNODE_ENV (to say the console is
  // not gated on it) — assert against comment-stripped code only.
  const code = consoleJs.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/USERNODE_ENV|IS_STAGING|isStaging/.test(code),
    'feature availability must be identical in staging and production');
});

test('the menu carries every section, grouped, with no external tools left', () => {
  const KEYS = [
    'overview', 'status', 'node', 'merges', 'rollover', 'staging-reap',
    'users', 'codes', 'limits',
    'analytics', 'estimator', 'gallery', 'features',
    'campaigns', 'db-export', 'mail', 'topochain',
  ];
  for (const key of KEYS) {
    assert.ok(new RegExp(`key: '${key}'`).test(consoleJs), `section '${key}' registered`);
  }
  // #860: nothing in the console opens a new browser tab any more — the
  // TOOLS external-link block and its target="_blank" anchors are gone.
  assert.ok(!/TOOLS\s*:/.test(consoleJs), 'the TOOLS external-link array is gone');
  assert.ok(!/More tools/.test(consoleJs), 'the "More tools" menu block is gone');
  for (const href of ['/dashboard', '/debug', '/gallery', '/status']) {
    assert.ok(!consoleJs.includes(`href: '${href}'`),
      `${href} must be a section, not an external link`);
  }
  // Every section declares a group — load-bearing for BOTH navs now: the
  // desktop sidebar's headings and the phone menu's grouped rows.
  const sectionBlock = consoleJs.slice(
    consoleJs.indexOf('SECTIONS: ['),
    consoleJs.indexOf('isOpen()')
  );
  const keyCount = (sectionBlock.match(/key: '/g) || []).length;
  const groupCount = (sectionBlock.match(/group: '/g) || []).length;
  assert.equal(keyCount, groupCount, 'every SECTIONS entry carries a group');
  // Responsive split: sidebar on md+, two-level hierarchy below md.
  assert.ok(consoleJs.includes('id="admin-nav-desktop"'), 'desktop sidebar renders');
  assert.ok(consoleJs.includes('id="admin-mobile-menu"'), 'the mobile level-1 menu renders');
  // The horizontally scrolling tab strip it replaced is GONE, not merely
  // hidden — its id and its sideways scroll are what made fifteen
  // ungrouped sections a thumb-swipe scavenger hunt on a phone.
  assert.ok(!consoleJs.includes('admin-nav-mobile'),
    'the mobile tab strip is gone, replaced by the two-level menu');
  assert.ok(!/overflow-x-auto/.test(consoleJs),
    'nothing in the console scrolls sideways any more');
  // Both navs read their grouping from one helper so they cannot drift.
  assert.match(consoleJs, /_groupedSections\(\)\s*\{/,
    'one shared grouping helper feeds the sidebar and the mobile menu');
  const menuHtml = consoleJs.slice(consoleJs.indexOf('_mobileMenuHtml()'));
  assert.match(menuHtml.slice(0, 1600), /_groupedSections\(\)/,
    'the mobile menu groups via the shared helper');
  const sideHtml = consoleJs.slice(consoleJs.indexOf('  _navItemsHtml()'));
  assert.match(sideHtml.slice(0, 1200), /_groupedSections\(\)/,
    'the sidebar groups via the shared helper');
});

// #860: the six folded-in sections each live in their own module, loaded by
// the shell and precached by the service worker. Losing any of those three
// registrations shows "module failed to load" instead of the section.
test('every folded-in section has a module, a script tag and a precache entry', () => {
  const sw = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
  const MODULES = {
    status: 'admin-status',
    node: 'admin-node',
    analytics: 'admin-analytics',
    // #898: platform analytics split out of the Analytics section.
    estimator: 'admin-estimator',
    merges: 'admin-merges',
    gallery: 'admin-gallery',
    campaigns: 'admin-campaigns',
    topochain: 'admin-topochain',
    // Platform outbound mail: configuration, a test send, and the ledger.
    mail: 'admin-mail',
  };
  for (const [key, file] of Object.entries(MODULES)) {
    assert.match(consoleJs, new RegExp(`${key}: '`),
      `SECTION_MODULES maps '${key}' to a module global`);
    assert.ok(fs.existsSync(path.join(root, 'public/js', `${file}.js`)),
      `public/js/${file}.js exists`);
    assert.ok(html.includes(`<script src="/js/${file}.js"></script>`),
      `${file}.js is loaded by the shell`);
    assert.ok(sw.includes(`'/js/${file}.js'`),
      `${file}.js is precached by the service worker`);
  }
  // The retired page scripts are gone, not merely unreferenced.
  for (const gone of ['dashboard.js', 'debug.js', 'gallery.js', 'admin-features.js']) {
    assert.ok(!fs.existsSync(path.join(root, 'public/js', gone)),
      `public/js/${gone} is removed`);
    assert.ok(!sw.includes(`'/js/${gone}'`), `${gone} dropped from the SW precache`);
  }
});

// The lifecycle that keeps a 5s /api/status poll (which shells out to
// `docker stats` server-side) and a 2s /api/node-status poll from outliving
// the section that started them.
test('every section module exposes destroy(), and switches call it first', () => {
  for (const file of ['admin-status', 'admin-node', 'admin-analytics',
    'admin-estimator', 'admin-merges', 'admin-gallery', 'admin-campaigns',
    'admin-topochain', 'admin-mail']) {
    const src = fs.readFileSync(path.join(root, 'public/js', `${file}.js`), 'utf8');
    assert.match(src, /destroy\(\)\s*\{/, `${file}.js implements destroy()`);
    assert.match(src, /render\(\s*\w+\s*\)\s*\{/, `${file}.js implements render(host)`);
  }
  assert.match(consoleJs, /_teardownActiveSection\(\)\s*\{/,
    'the console has a single teardown choke point');
  const renderSection = consoleJs.slice(consoleJs.indexOf('  _renderSection() {'));
  const head = renderSection.slice(0, 1200);
  const teardownAt = head.indexOf('_teardownActiveSection()');
  const renderAt = head.indexOf('mod.render(host)');
  assert.ok(teardownAt > -1, '_renderSection tears the previous section down');
  assert.ok(renderAt > -1, '_renderSection delegates to the section module');
  assert.ok(teardownAt < renderAt, 'teardown happens BEFORE the next section renders');
  // Leaving the console entirely must stop the polls too.
  const close = consoleJs.slice(consoleJs.indexOf('  close() {'));
  assert.match(close.slice(0, 400), /_teardownActiveSection\(\)/,
    'close() also tears the active section down');
});

// Public mode: /status and /node-status were public pages before the fold,
// so a signed-in non-admin following those old links still reaches them —
// and sees ONLY them. Everything else, including bare #admin, still bounces.
test('the two formerly-public sections stay reachable for non-admins', () => {
  for (const key of ['status', 'node']) {
    assert.match(consoleJs, new RegExp(`key: '${key}'[^}]*public: true`),
      `section '${key}' is flagged public`);
  }
  // Only those two — counted inside the SECTIONS literal, so the
  // file-header comment explaining the flag doesn't inflate the tally.
  const sectionBlock = consoleJs.slice(
    consoleJs.indexOf('SECTIONS: ['),
    consoleJs.indexOf('isOpen()')
  );
  assert.equal((sectionBlock.match(/public: true/g) || []).length, 2,
    'exactly two sections are public');
  assert.match(consoleJs, /_visibleSections\(\)\s*\{/, 'the menu filters by visibility');
  assert.match(consoleJs, /filter\(\(s\) => s\.public\)/,
    'public mode narrows the menu to the public sections');

  const fn = appJs.slice(appJs.indexOf('  navigateToAdminConsole('));
  const head = fn.slice(0, 900);
  assert.match(appJs, /ADMIN_PUBLIC_SECTIONS: \['status', 'node'\]/,
    'app.js pins the public section list');
  assert.match(head, /if \(!isAdmin && !publicMode\)/,
    'a non-admin on any non-public section still bails');
  assert.match(head, /App\.navigateHome\(\)/, 'and lands on home');
  assert.match(fn.slice(0, 4000), /publicMode \? 'Platform status' : 'Admin & moderation'/,
    'public mode retitles the header');
});

test('section switches replace, never push, history', () => {
  const fn = consoleJs.slice(consoleJs.indexOf('  _writeHash(key) {'));
  assert.ok(fn.length > 0, '_writeHash located');
  assert.match(fn.slice(0, 400), /location\.hash\.startsWith\('#admin'\)/,
    'hash write-back only while actually on the #admin route');
  assert.match(fn.slice(0, 400), /history\.replaceState/,
    'replaceState so section hops do not pollute the back stack');
  assert.ok(!/history\.pushState/.test(consoleJs),
    'the module never pushes history entries itself');
});

test('dapp.json locks the rendered page in with checks', () => {
  const tests = manifest.tests || [];
  const page = tests.find((t) => t.path === '/#admin');
  assert.ok(page, 'a dapp.json test renders /#admin');
  assert.match(page.expectSelector, /#admin-screen:not\(\.hidden\)/,
    'asserts the screen is actually revealed, not just present');
  const section = tests.find((t) => t.path === '/#admin/codes');
  assert.ok(section, 'a dapp.json test renders a deep-linked section');
  const dbExport = tests.find((t) => t.path === '/#admin/db-export');
  assert.ok(dbExport, 'a dapp.json test renders the database-export section');
  const estimator = tests.find((t) => t.path === '/?demo=1#admin/estimator');
  assert.ok(estimator, 'a dapp.json test renders the estimator-accuracy section (#898)');
  assert.match(dbExport.expectSelector, /#admin-db-export-panel/,
    'asserts the export panel actually rendered, not just the shell');
});

// ─── Database export section ──────────────────────────────────────
//
// The console's most dangerous control. The client-side contract:
// availability comes from the server's capability probe (never an env
// check of its own — see the "not gated on the environment" test above),
// the download is a NAVIGATION rather than a Blob, and every string that
// reaches the DOM from the history API is escaped.

test('the export section warns before it offers, and never uses a native prompt', () => {
  const fn = consoleJs.slice(
    consoleJs.indexOf('  renderDbExportSection(host) {'),
    consoleJs.indexOf('  _resetDbExportConfirm()')
  );
  assert.ok(fn.length > 0, 'renderDbExportSection located');
  assert.match(fn, /password hash/, 'spells out what the file contains');
  assert.match(fn, /admin-db-export-phrase/, 'the typed EXPORT confirmation is an in-page field');
  assert.match(fn, /admin-db-export-password/, 'password re-entry is an in-page field');
  assert.ok(!/\bprompt\(/.test(consoleJs), 'no native prompt() — the platform renders its own dialogs');
});

test('the restore instructions match the file the server actually sends', () => {
  // The download is a gzip-compressed plain-SQL dump, so the panel must
  // document gunzip + psql. A stale `pg_restore … .dump` line here is worse
  // than no line at all: an admin follows it during an incident and the
  // restore fails on a file pg_restore cannot read.
  const fn = consoleJs.slice(
    consoleJs.indexOf('  renderDbExportSection(host) {'),
    consoleJs.indexOf('  _resetDbExportConfirm()')
  );
  assert.match(fn, /\.sql\.gz/, 'names the extension the browser will save');
  assert.match(fn, /gunzip -c/, 'the restore starts by decompressing');
  assert.match(fn, /\|\s*psql/, 'and replays the SQL with psql, not pg_restore');
  assert.ok(!/pg_restore/.test(consoleJs), 'no leftover custom-format restore command');
  assert.ok(!/&lt;file&gt;\.dump/.test(consoleJs), 'no leftover .dump filename');
});

test('the export button is enabled by the server, not by the client', () => {
  const fn = consoleJs.slice(
    consoleJs.indexOf('  async loadDbExportStatus()'),
    consoleJs.indexOf('  async startDbExport()')
  );
  assert.match(fn, /btn\.disabled = !data\.available/,
    'the probe decides; the client only renders the decision');
  assert.match(fn, /DB_EXPORT_REASONS\[data\.reason\]/,
    'the refusal copy is keyed off the server reason code');
  for (const reason of ['staging', 'unavailable', 'in_progress', 'rate_limited']) {
    assert.ok(new RegExp(`${reason}:`).test(consoleJs), `reason '${reason}' has copy`);
  }
});

test('the download is navigated, not fetched into memory', () => {
  const fn = consoleJs.slice(
    consoleJs.indexOf('  async startDbExport()'),
    consoleJs.indexOf('  _dbExportRow(r)')
  );
  assert.match(fn, /\/api\/admin\/db-export\/ticket/, 'step 1 posts the confirmation');
  assert.match(fn, /window\.location\.href = data\.url/, 'step 2 navigates to the ticket URL');
  assert.ok(!/createObjectURL/.test(fn),
    'a multi-hundred-MB dump must never be held in page memory as a Blob');
  assert.match(fn, /pw\.value = ''/, 'the password field is cleared as soon as it is spent');
});

test('history rows are escaped — they carry admin-controlled strings', () => {
  const fn = consoleJs.slice(
    consoleJs.indexOf('  _dbExportRow(r)'),
    consoleJs.indexOf('  async loadDbExportHistory()')
  );
  for (const field of ['r.username', 'r.db_name', 'r.ip', 'r.error']) {
    assert.ok(new RegExp(`esc\\(${field.replace('.', '\\.')}`).test(fn)
      || new RegExp(`esc\\([^)]*${field.replace('.', '\\.')}`).test(fn),
      `${field} passes through esc()`);
  }
});

test('the section spells out post-export rotation guidance', () => {
  assert.match(consoleJs, /rotate/i, 'the console tells the admin what to rotate if the file leaks');
  assert.match(consoleJs, /JWT secret/i, 'naming the one rotation that invalidates every session');
});
