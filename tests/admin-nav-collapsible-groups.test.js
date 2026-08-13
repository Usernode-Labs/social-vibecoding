// Collapsible admin menu groups (#1152) — Operations, People, Insights,
// Platform fold away, and the fold persists per browser.
//
// Both admin menu surfaces (the desktop sidebar written into
// #admin-nav-desktop, and the phone level-1 menu written into
// #admin-section-content) render from ONE grouping helper, so this is one
// feature with two renderers. Contract pinned here:
//
//  - the collapse state is a versioned localStorage key holding the
//    COLLAPSED group names — not the expanded ones, which is what makes
//    "all expanded by default" and "a group added later starts expanded"
//    the empty-store behaviour rather than a special case;
//  - every storage read and write is wrapped, because both sit inside a
//    render path: unavailable/full/corrupt storage degrades to "nothing
//    collapsed", never a throw halfway through painting the menu;
//  - both builders emit the same heading contract — a real <button> with
//    data-admin-group-toggle / aria-expanded / aria-controls, plus an items
//    container carrying data-admin-group and `hidden` when collapsed — with
//    a DISTINCT id prefix per surface, because at phone width the hidden
//    desktop sidebar and the level-1 menu are both in the document and
//    aria-controls has to resolve to one node;
//  - a heading press is a MENU-ONLY action: it never routes (no
//    setSection / _renderShell / _renderContent / _writeHash /
//    location.hash), so the section on screen keeps rendering, the phone
//    menu isn't torn down mid-gesture, and focus stays put;
//  - arriving at a section expands ITS group first, so a deep link into a
//    collapsed group can never hide the highlighted row — applied at the
//    three arrival sites that repaint (setSection, and the open()/route()
//    branches that repaint without it), and deliberately NOT inside
//    _renderShell, which would make the group you are using the one group
//    you cannot collapse;
//  - the section rows themselves are untouched: role="tab"/aria-selected on
//    desktop, neither on mobile (the phone menu is a list, not a tab set).
//
// Run with: node --test tests/admin-nav-collapsible-groups.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const consoleJs = fs.readFileSync(
  path.join(root, 'frontend/src/features/admin/admin-console.js'), 'utf8');
const dapp = JSON.parse(fs.readFileSync(path.join(root, 'dapp.json'), 'utf8'));

// The two builders, sliced the way the sibling admin tests do.
const sliceFn = (name, len) => {
  const at = consoleJs.indexOf(`  ${name}`);
  assert.ok(at > -1, `${name} exists`);
  return consoleJs.slice(at, at + len);
};

// Exactly one member, ending at the next member's signature — an
// absence assertion ("the handler never calls setSection") has to be
// bounded by the function, or the fixed-length window above spills into
// the neighbour and the assertion is about the wrong code.
const bodyOf = (name) => {
  const at = consoleJs.indexOf(`  ${name}`);
  assert.ok(at > -1, `${name} exists`);
  const rest = consoleJs.slice(at + name.length + 2);
  const next = rest.search(/\n {2}[A-Za-z_$][\w$]*\(/);
  return next === -1 ? rest : rest.slice(0, next);
};

test('the collapse state is a versioned key holding the COLLAPSED groups', () => {
  assert.match(consoleJs, /const NAV_COLLAPSED_KEY = 'admin_nav_collapsed_groups_v1'/,
    'one versioned localStorage key, declared once at module scope');

  const load = sliceFn('_loadCollapsedGroups() {', 1400);
  assert.match(load, /localStorage\.getItem\(NAV_COLLAPSED_KEY\)/,
    'the load path reads that key');
  assert.match(load, /if \(typeof window === 'undefined'\) return;/,
    'guarded for the prerender pass, which evaluates this module in Node');
  assert.match(load, /Array\.isArray\(arr\)/,
    'a non-array stored value is rejected rather than iterated');
  assert.match(load, /try \{/, 'the whole read is inside try/catch…');
  assert.match(load, /\} catch \{/, '…so corrupt storage cannot throw mid-render');
  // Pruning against SECTIONS is what stops the store growing without bound
  // and what makes a renamed group reset to expanded (the safe direction).
  assert.match(load, /AdminConsole\.SECTIONS\.map\(\(s\) => s\.group \|\| 'Other'\)/,
    'stored names are pruned against the live SECTIONS group names');
  assert.match(load, /if \(changed\) AdminConsole\._saveCollapsedGroups\(\)/,
    'a prune persists, so the pruning happens once rather than every load');

  const save = sliceFn('_saveCollapsedGroups() {', 500);
  assert.match(save, /localStorage\.setItem\(/, 'the save path writes the same key');
  assert.match(save, /\} catch \{/,
    'an unavailable or full store is non-fatal — the session goes in-memory');

  // The inversion is the load-bearing part: a group nobody has collapsed
  // has no entry at all, so it renders expanded.
  const isCollapsed = sliceFn('_isGroupCollapsed(name) {', 200);
  assert.match(isCollapsed, /_collapsed\(\)\.has\(String\(name\)\)/,
    'a group is collapsed only when its name is IN the set — absent means expanded');
});

test('both menus render group headings as real toggle buttons', () => {
  const toggle = sliceFn('_groupToggleHtml(name, domId, collapsed, cls) {', 1200);
  assert.match(toggle, /<button type="button" data-admin-group-toggle="/,
    'a real <button>, so Tab + Enter/Space work with no keydown handler');
  assert.match(toggle, /aria-expanded="\$\{collapsed \? 'false' : 'true'\}"/,
    'expanded state is announced');
  assert.match(toggle, /aria-controls="\$\{domId\}"/,
    'and the controlled container is named');
  assert.match(toggle, /\$\{collapsed \? 'Expand' : 'Collapse'\} \$\{name\}/,
    'the accessible label says which way the press goes');
  assert.match(toggle, /transition-transform/,
    'the chevron rotates rather than being swapped for a second glyph');
  assert.match(toggle, /' -rotate-90'/,
    'down when open, right when closed — complete class literals for the extractor');

  assert.match(sliceFn('_groupDomId(prefix, name) {', 300), /\$\{prefix\}-/,
    'the container id is prefixed per surface');

  const side = sliceFn('_navItemsHtml() {', 2200);
  assert.match(side, /_groupToggleHtml\(g\.name, domId, collapsed,/,
    'the sidebar heading is the shared toggle');
  assert.match(side, /_groupDomId\('admin-nav-group', g\.name\)/,
    "the sidebar's container ids are admin-nav-group-*");
  assert.match(side, /data-admin-group="\$\{AdminConsole\.esc\(g\.name\)\}"/,
    'the sidebar items container is addressable by group name');
  assert.match(side, /collapsed \? ' class="hidden"' : ''/,
    'and is hidden when the group is collapsed');
  // Untouched: the rows are still the tab-set contract the sidebar has had.
  assert.match(side, /role="tab"/, 'sidebar rows are still tabs');
  assert.match(side, /aria-selected=/, 'with the active row still announced');

  const mobile = sliceFn('_mobileMenuHtml() {', 2400);
  assert.match(mobile, /_groupToggleHtml\(g\.name, domId, collapsed,/,
    'the phone menu heading is the same shared toggle');
  assert.match(mobile, /_groupDomId\('admin-menu-group', g\.name\)/,
    "the phone menu's container ids are admin-menu-group-* — a DISTINCT prefix, "
    + 'because the hidden sidebar is in the document at the same width');
  assert.match(mobile, /data-admin-group="\$\{AdminConsole\.esc\(g\.name\)\}"/,
    'the card is addressable by group name');
  assert.match(mobile, /\[&>button:last-child\]:border-b-0\$\{collapsed \? ' hidden' : ''\}/,
    'the card hides when collapsed, and the toggle stays outside it so '
    + '[&>button:last-child] still means "the last section row"');

  // One grouping helper, keyed by NAME on both surfaces — an index-keyed
  // toggle would desync the moment public mode narrows the menu.
  for (const body of [side, mobile]) {
    assert.match(body, /_isGroupCollapsed\(g\.name\)/,
      'collapse is looked up by group name, from the shared helper output');
  }
});

test('a heading press is a menu-only action, wired on both hosts', () => {
  const wire = bodyOf('_wireGroupToggles(root) {');
  assert.match(wire, /querySelectorAll\('\[data-admin-group-toggle\]'\)/,
    'scoped to the host just written, like _wireSectionButtons');
  assert.match(wire, /_setGroupCollapsed\(name, next\)/, 'the press persists the new state');
  assert.match(wire, /setAttribute\('aria-expanded'/, 'and updates the announced state');
  assert.match(wire, /classList\.toggle\('hidden', next\)/,
    'the rows are hidden in place — which also takes them out of tab order');
  assert.match(wire, /classList\.toggle\('-rotate-90', next\)/, 'the chevron turns');
  for (const forbidden of ['setSection(', '_renderContent(', '_renderShell(', '_writeHash(', 'location.hash']) {
    assert.ok(!wire.includes(forbidden),
      `a toggle must not route or repaint — found ${forbidden} in the handler`);
  }

  const shell = bodyOf('_renderShell() {');
  assert.match(shell, /_wireGroupToggles\(sideHost\)/,
    'the sidebar repaint wires its own toggles');
  const menu = sliceFn('_renderMobileMenu(host) {', 300);
  assert.match(menu, /_wireGroupToggles\(host\)/,
    'the phone menu repaint wires its own toggles');
});

test('arriving at a section expands its group, before the repaint', () => {
  const ensure = sliceFn('_ensureActiveGroupExpanded() {', 600);
  assert.match(ensure, /_visibleSections\(\)\.find\(\(x\) => x\.key === AdminConsole\._section\)/,
    'it resolves the group from the section actually being shown');
  assert.match(ensure, /if \(!set\.has\(name\)\) return;/,
    'and only writes when the group was collapsed');

  const setSection = sliceFn('setSection(key, opts) {', 1400);
  const ensureAt = setSection.indexOf('_ensureActiveGroupExpanded()');
  const renderAt = setSection.indexOf('_renderShell()');
  assert.ok(ensureAt > -1, 'setSection applies the arrival rule');
  assert.ok(renderAt > ensureAt,
    'BEFORE the repaint — otherwise the first paint hides the active row');

  // The two branches that repaint without going through setSection: the
  // mobile early return in open() and the mobile transition in route().
  const open = sliceFn('open(section, opts) {', 3000);
  assert.match(open, /_ensureActiveGroupExpanded\(\)/,
    "open()'s mobile early-return branch applies it too");
  const route = sliceFn('route(section, opts) {', 3200);
  assert.match(route, /_ensureActiveGroupExpanded\(\)/,
    "and so does route()'s mobile transition");

  // NOT in _renderShell: that would re-expand on every section switch and
  // every viewport crossing, making the active group uncollapsible.
  const shell = bodyOf('_renderShell() {');
  assert.ok(!shell.includes('_ensureActiveGroupExpanded('),
    'the rule is arrival-only — a deliberate collapse of the current group sticks');
});

test('dapp.json checks the /#admin menu ships expanded and collapsible', () => {
  const declared = Array.isArray(dapp.tests) ? dapp.tests : [];
  const bySel = (sel) => declared.find((t) => t.expectSelector === sel);

  const collapsible = bySel(
    '#admin-nav-desktop [data-admin-group-toggle="Operations"][aria-expanded="true"]');
  assert.ok(collapsible, 'a check asserts the heading renders as an expanded toggle');
  assert.equal(collapsible.path, '/#admin');

  const active = bySel(
    '#admin-nav-desktop [data-admin-group="People"]:not(.hidden) [data-admin-section="users"]');
  assert.ok(active, "a check asserts the active section's group is visible on arrival");
  assert.equal(active.path, '/#admin/users');

  // #860's grouping check is the neighbour these two sit beside, not a
  // thing they replace.
  assert.ok(declared.some((t) => t.path === '/#admin' && t.expectText === 'Operations'),
    'the original grouped-headings check still stands');
});
