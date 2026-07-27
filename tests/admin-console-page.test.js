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
  assert.match(fn.slice(0, 300), /if \(!App\.user\?\.isAdmin\)/,
    'gate on isAdmin — full AND view-only admins, never canAdminWrite');
  assert.match(fn.slice(0, 300), /App\.navigateHome\(\)/,
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

test('the menu carries every section and the standalone tools', () => {
  for (const key of ['overview', 'users', 'codes', 'limits', 'features', 'db-export']) {
    assert.ok(new RegExp(`key: '${key}'`).test(consoleJs), `section '${key}' registered`);
  }
  for (const href of ['/dashboard', '/debug', '/gallery', '/status']) {
    assert.ok(consoleJs.includes(`href: '${href}'`), `tools link to ${href}`);
  }
  // Responsive split: sidebar on md+, tab strip below md.
  assert.ok(consoleJs.includes('id="admin-nav-desktop"'), 'desktop sidebar renders');
  assert.ok(consoleJs.includes('id="admin-nav-mobile"'), 'mobile tab strip renders');
  assert.match(consoleJs, /overflow-x-auto/, 'the mobile strip scrolls sideways, not the page');
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
