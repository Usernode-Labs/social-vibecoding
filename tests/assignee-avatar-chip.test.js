// #489: the assignee chip's initial-avatar. An assigned task renders a
// coloured initial-avatar + escaped @username; an unassigned task renders the
// muted placeholder avatar + "Unassigned" text while staying an interactive
// data-attr-chip button (a <span> only when readonly); avatar colour is a
// deterministic function of the username.
//
// The split since #1367's card chunk: `_attrChipSpec` + `_assigneeTint` in
// app-view.js resolve the tint, the initial and the label, and
// card/dev-card.tsx's `Badge` draws them. `_assigneeAvatarHtml` and its
// placeholder sibling built the circle as a string and are retired.
//
// Same vm-context harness as console-warning-card.test.js: load app-view.js
// into a sandbox, stub the globals it reaches, assert on the markup.
//
// Run with: node --test tests/assignee-avatar-chip.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { api } = require('./lib/dev-card-html');
const { renderToHtml, createElement } = require('./lib/render-tsx');

// ── Rendering one chip ──────────────────────────────────────────────────
//
// `_attrChipHtml` built the chip as a string. #1367's card chunk split it:
// `_attrChipSpec` resolves the label, the tint and the tooltip, and
// card/dev-card.tsx's `Badge` draws them. This composes the two, which is
// exactly what a card does — and React escapes the text children, so the
// escaping this file pins is the component's now rather than escapeHtml's.
function attrChipHtml(AppView, field, targetType, targetRef, summary, readonly) {
  const b = AppView._attrChipSpec(field, targetType, targetRef, summary, readonly);
  return renderToHtml(createElement(api().Badge, { b }));
}


const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

function makeAppView() {
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: 1 } },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  return sandbox.__AppView;
}

test('assigned task: interactive chip renders an initial-avatar + escaped @username', () => {
  const AppView = makeAppView();
  const html = attrChipHtml(AppView, 'assignee', 'issue', 5, { top: 'Evan', count: 1, myValue: null }, false);
  assert.match(html, /^<button/); // interactive
  assert.match(html, /data-attr-chip/);
  assert.match(html, /data-attr-field="assignee"/);
  assert.match(html, /class="attr-avatar /); // the avatar circle
  assert.match(html, />E<\/span>/); // uppercased first letter
  assert.match(html, /@Evan/);
  // Count of 1 stays silent (only shows when > 1).
  assert.doesNotMatch(html, /&middot;/);
});

test('assigned task: multi-vote count still renders the faint · N suffix', () => {
  const AppView = makeAppView();
  const html = attrChipHtml(AppView, 'assignee', 'issue', 5, { top: 'maya', count: 3, myValue: null }, false);
  // The entity the string builder wrote is the character itself now —
  // React renders text children.
  assert.match(html, /·3/);
  assert.match(html, />M<\/span>/);
});

test('unassigned task: renders the placeholder avatar + "Unassigned", still a button', () => {
  const AppView = makeAppView();
  const html = attrChipHtml(AppView, 'assignee', 'issue', 5, { top: null, count: 0, myValue: null }, false);
  assert.match(html, /^<button/);
  assert.match(html, /attr-avatar-empty/);
  assert.match(html, /Unassigned/);
  // The empty-state tooltip is the assign CTA.
  assert.match(html, /Assign someone to this task/);
});

test('readonly (merged) assignee: renders a <span>, not a button, but keeps the avatar', () => {
  const AppView = makeAppView();
  const html = attrChipHtml(AppView, 'assignee', 'proposal', 7, { top: 'Evan', count: 2, myValue: null }, true);
  assert.match(html, /^<span/);
  assert.doesNotMatch(html, /data-attr-chip/);
  assert.match(html, /class="attr-avatar /);
  assert.match(html, /@Evan/);
});

test('username with HTML metacharacters is escaped in the chip', () => {
  const AppView = makeAppView();
  const html = attrChipHtml(AppView, 'assignee', 'issue', 5, { top: '<script>x', count: 1, myValue: null }, false);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('the avatar uppercases the initial and falls back to "?" for blank names', () => {
  const AppView = makeAppView();
  const initial = (top) =>
    AppView._attrChipSpec('assignee', 'issue', 5, { top, count: 1 }, false).label.initial;
  assert.equal(initial('evan'), 'E');
  assert.equal(initial('  spaced'), 'S');
  // A blank name still resolves to a chip — the empty-state branch is keyed
  // on a FALSY `top`, so a whitespace-only one takes the avatar path and
  // needs the fallback glyph.
  assert.equal(initial(' '), '?');
});

test('_assigneeTint: same username is deterministic; different names can differ', () => {
  const AppView = makeAppView();
  assert.equal(AppView._assigneeTint('staging-tester'), AppView._assigneeTint('staging-tester'));
  // Across a spread of names, the palette is actually exercised (not all one
  // colour) — guards against a hash that collapses to a single bucket.
  const names = ['staging-tester', 'staging-demo-user', 'maya-builder', 'evan', 'zoe', 'alex'];
  const distinct = new Set(names.map((n) => AppView._assigneeTint(n)));
  assert.ok(distinct.size > 1, 'expected more than one tint across sample names');
  // Every tint is one of the declared palette entries.
  for (const n of names) {
    assert.ok(AppView.ASSIGNEE_AVATAR_TINTS.includes(AppView._assigneeTint(n)));
  }
});

test('priority chip is untouched by the assignee changes', () => {
  const AppView = makeAppView();
  const html = attrChipHtml(AppView, 'priority', 'issue', 5, { top: 'high', count: 1, myValue: null }, false);
  assert.match(html, /High/);
  assert.doesNotMatch(html, /attr-avatar/);
});
