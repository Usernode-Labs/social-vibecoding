// #5286: the admin console is a marked place with a way out, and a phone
// opens it on the numbers.
//
// Before, the console opened in the same chrome as a person's own Settings,
// and a phone's bare #admin was a list of forty section rows with no summary
// before them. Pinned here:
//  - the chassis renders the console's own band (#admin-console-bar) with an
//    Exit link (#admin-exit), shipped hidden and revealed by _renderShell
//    through classList, never for a non-admin in public mode;
//  - Exit goes back to where the console was entered from, which the module
//    records from hashchange/popstate and open() freezes, else the Me tab;
//  - a phone's level 1 renders Overview first, then the section menu, and
//    still tears the previous section down before it does.
//
// Run with: node --test tests/admin-console-marker.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const consoleJs = fs.readFileSync(path.join(root, 'frontend/src/features/admin/admin-console.js'), 'utf8');
const islandTsx = fs.readFileSync(path.join(root, 'frontend/src/features/admin/index.tsx'), 'utf8');

function method(src, head) {
  const at = src.indexOf(head);
  assert.ok(at > -1, `${head.trim()} exists`);
  const rest = src.slice(at);
  return rest.slice(0, rest.indexOf('\n  },\n'));
}

test('the chassis renders the console band, hidden, with an Exit link', () => {
  assert.match(islandTsx, /id="admin-console-bar" className="hidden mb-4"/,
    'the band ships hidden and holds no display utility of its own');
  assert.match(islandTsx, />Admin console</, 'it names the place');
  assert.match(islandTsx, /id="admin-exit"\s+href="#profile"\s+onClick=\{onExit\}/,
    'Exit is a real anchor to the Me tab, refined on press');
  assert.doesNotMatch(islandTsx, /@\/components\/ui/,
    'the console does not draw with the shell primitives');
  assert.match(islandTsx, /bg-amber-50 .*text-amber-900 dark:border-amber-800 dark:bg-amber-950\/50 dark:text-amber-100/,
    'the band is amber (#5627), the View-only strip\'s warning shades, not an inverted zinc row');
  assert.match(islandTsx, /Be careful before changing anything\./,
    'the band asks you to be careful before changing anything (#5627)');
});

test('the band is toggled through classList, and hidden in public mode', () => {
  const body = method(consoleJs, '  _renderShell() {');
  assert.match(body, /getElementById\('admin-console-bar'\)/);
  assert.match(body, /bar\.classList\.toggle\('hidden', AdminConsole\._publicMode\(\)\)/,
    'shown for an admin, hidden for a non-admin on a public section');
});

test('Exit leads back to where the console was entered from', () => {
  const open = method(consoleJs, '  open(section, opts) {');
  assert.match(open, /AdminConsole\._returnTo = AdminConsole\._lastOutside;/,
    'open() freezes the last outside address, so moves inside never change it');
  const exit = method(consoleJs, '  exitTarget() {');
  assert.match(exit, /AdminConsole\._returnTo \|\| '#profile'/,
    'with nothing recorded, Exit goes to the Me tab');
  assert.match(consoleJs, /if \(!\/\^#admin\(\\\/\|\$\)\/\.test\(h\)\) AdminConsole\._lastOutside = h;/,
    'console addresses are never recorded as a way out');
  assert.match(consoleJs, /addEventListener\('hashchange', remember\)/);
  assert.match(consoleJs, /addEventListener\('popstate', remember\)/);
  assert.match(islandTsx, /AdminConsole\?\.exitTarget\?\.\(\)/,
    'the Exit press asks the console where to go');
});

test('a phone opens on Overview, with every section after it', () => {
  const html = method(consoleJs, '  _levelOneHtml() {');
  const overviewAt = html.indexOf('id="admin-mobile-overview"');
  const menuAt = html.indexOf('All sections');
  assert.ok(overviewAt > -1 && menuAt > overviewAt, 'Overview comes first, the list after');
  assert.match(html, /if \(AdminConsole\._publicMode\(\)\) return AdminConsole\._mobileMenuHtml\(\);/,
    'public mode keeps the bare list: a non-admin has no Overview');
  const body = method(consoleJs, '  _renderMobileMenu(host) {');
  assert.match(body, /host\.innerHTML = AdminConsole\._levelOneHtml\(\);/);
  assert.match(body, /_renderModule\(sub, 'AdminOverview', 'overview'\)/,
    'Overview renders through the same seam, so teardown still stops it');
  const content = method(consoleJs, '  _renderContent() {');
  assert.ok(content.indexOf('_teardownActiveSection()') < content.indexOf('_renderMobileMenu(host)'),
    'the previous section is torn down before level 1 replaces it');
});

test('a section chunk arriving late repaints the level, not a bare section', () => {
  const body = method(consoleJs, '  _renderModule(host, modName, key) {');
  assert.match(body, /if \(live && AdminConsole\._open\) AdminConsole\._renderContent\(\);/,
    'on a phone level 1 a bare section render would wipe the menu');
});
