'use strict';

// The starter templates a new project can begin from (#3521). The registry
// (src/services/app-templates.js) is the one list of ids; the fragment
// directories under src/templates/apps/<id>/ are what the scaffold is built
// from; and the 'empty' entry's fragments are the extracted press demo, so
// composing it must reproduce the scaffold the platform always shipped. This
// pins the registry, the fragments, the composed output for every template,
// and the picker rows the create dialog offers (frontend/src/features/
// dialogs/create-app.tsx TEMPLATES), which must stay in step with the
// registry. The byte-identity of the empty scaffold itself is pinned by the
// pre-existing template tests (tests/template-tailwind.test.js,
// tests/starter-notice.test.js, tests/app-favicon.test.js), which pass
// unchanged.
//
// Run with: node --test tests/app-templates.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { TEMPLATE_LIST, resolveTemplateId } = require('../src/services/app-templates');
const { getTemplateFiles } = require('../src/services/template');

const TPL_ROOT = path.join(__dirname, '..', 'src', 'templates', 'apps');
// Newline-terminated, exactly as services/template.js splits on them: the
// fragment doc headers mention the marker names in prose, so a bare name
// would match the commentary first.
const ROUTES_MARKER = '// @@HOMEROOM-ROUTES@@\n';
const BOOT_MARKER = '// @@HOMEROOM-BOOTSTRAP@@\n';

// The demo table each template's example owns, and the tables it must not
// touch — the examples are placeholders that replace cleanly, so an
// example's routes and bootstrap name its own table and nothing else's.
const TEMPLATE_TABLES = { empty: 'presses', social: 'tasks', media: 'posts', game2d: 'scores', game3d: 'scores' };

test('the registry lists five templates with stable, unique ids', () => {
  const ids = TEMPLATE_LIST.map((t) => t.id);
  assert.deepEqual(ids, ['empty', 'social', 'media', 'game2d', 'game3d']);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const t of TEMPLATE_LIST) {
    assert.ok(t.label.length > 0, `${t.id} has a picker label`);
    assert.ok(t.example.length > 0, `${t.id} says what its example is`);
    assert.match(t.claudeShips, /public\/index\.html/, `${t.id} names its demo markup for CLAUDE.md`);
    assert.match(t.readmeDb, /table/, `${t.id} names its table for README.md`);
  }
});

test('the create dialog offers the same five rows, in the same order', () => {
  const { loadTsx } = require('./lib/render-tsx');
  const { TEMPLATES } = loadTsx('frontend/src/features/dialogs/create-app.tsx');
  assert.deepEqual(TEMPLATES.map((t) => t.key), TEMPLATE_LIST.map((t) => t.id),
    'the picker and the registry are one list');
  assert.deepEqual(TEMPLATES.map((t) => t.title), TEMPLATE_LIST.map((t) => t.label),
    'the picker titles are the registry labels');
  for (const t of TEMPLATES) {
    assert.ok(t.caption.length > 0, `${t.key} has a caption`);
    assert.doesNotMatch(t.caption + t.title, /—/, 'no em dashes in the picker copy');
  }
});

test('a template choice resolves: absent or blank is empty, a known id is itself, anything else is a 400', () => {
  assert.deepEqual(resolveTemplateId(undefined), { template: 'empty' });
  assert.deepEqual(resolveTemplateId(null), { template: 'empty' });
  assert.deepEqual(resolveTemplateId(''), { template: 'empty' });
  assert.deepEqual(resolveTemplateId('   '), { template: 'empty' });
  for (const t of TEMPLATE_LIST) assert.deepEqual(resolveTemplateId(t.id), { template: t.id });
  assert.deepEqual(resolveTemplateId('  SOCIAL '), { template: 'social' }, 'trimmed and case-insensitive');
  assert.deepEqual(resolveTemplateId('no-such-thing'), { error: 'Unknown template' });
  assert.deepEqual(resolveTemplateId(42), { error: 'Unknown template' }, 'only a string is a choice');
});

test('every template directory carries a routable fragment pair', () => {
  for (const t of TEMPLATE_LIST) {
    const dir = path.join(TPL_ROOT, t.id);
    const serverApp = fs.readFileSync(path.join(dir, 'server-app.js'), 'utf8');
    const indexBody = fs.readFileSync(path.join(dir, 'index-body.html'), 'utf8');
    assert.ok(serverApp.length > 0 && indexBody.length > 0, `${t.id} has both fragments`);
    const routesAt = serverApp.indexOf(ROUTES_MARKER);
    const bootAt = serverApp.indexOf(BOOT_MARKER);
    assert.ok(routesAt >= 0, `${t.id} has the routes marker`);
    assert.ok(bootAt > routesAt, `${t.id} has the bootstrap marker, after the routes one`);
    // The example screen is starter-template messaging: it ships and it is
    // replaced the same way today's Press demo is.
    assert.equal((indexBody.match(/usernode-starter-notice@1/g) || []).length, 2,
      `${t.id}'s screen carries both sentinel comments`);
    assert.match(indexBody, /\{\{APP_NAME\}\}/, `${t.id}'s screen takes the app name placeholder`);
    // An example owns its one table.
    const table = TEMPLATE_TABLES[t.id];
    assert.match(serverApp, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`), `${t.id} bootstraps ${table}`);
    const others = Object.values(TEMPLATE_TABLES).filter((x) => x !== table);
    for (const other of new Set(others)) {
      assert.ok(!serverApp.includes(other), `${t.id}'s fragment never names ${other}`);
    }
  }
});

test('each composed index.html is self-contained: precompiled stylesheet, relative bridge, no cross-origin asset', () => {
  for (const t of TEMPLATE_LIST) {
    const files = getTemplateFiles('Orb & Board', 'orb-board-x1', 'postgres://x', null, { template: t.id });
    const html = files.find((f) => f.path === 'public/index.html').content;
    assert.match(html, /<link rel="stylesheet" href="\/tailwind\.css">/, `${t.id}: precompiled stylesheet`);
    assert.match(html, /<script src="\/usernode-bridge\/v1\/bridge\.js"><\/script>/, `${t.id}: the bridge, relative`);
    assert.ok(!/src="https?:\/\//.test(html), `${t.id}: no cross-origin script`);
    assert.ok(!/href="https?:\/\//.test(html), `${t.id}: no cross-origin link`);
    assert.ok(!html.includes('{{APP_NAME}}'), `${t.id}: the placeholder is replaced`);
    assert.match(html, /<title>Orb &amp; Board<\/title>/, `${t.id}: the name is escaped into the title`);
    assert.match(html, />Orb &amp; Board<\/h1>/, `${t.id}: and into the hero`);
    // The games load their scripts from the app's own public/ files.
    if (t.id === 'game2d') assert.match(html, /<script src="\/game\.js"><\/script>/);
    if (t.id === 'game3d') assert.match(html, /<script type="module" src="\/game\.js"><\/script>/);
  }
});

test('each composed server.js splices the template around the shared plumbing', () => {
  for (const t of TEMPLATE_LIST) {
    const files = getTemplateFiles('Orb & Board', 'orb-board-x1', 'postgres://x', null, { template: t.id });
    const server = files.find((f) => f.path === 'server.js').content;
    const table = TEMPLATE_TABLES[t.id];
    // The routes land where the demo routes always sat, before the static
    // middleware; the bootstrap lands inside start(), before it listens.
    const routesAt = server.indexOf(`CREATE TABLE IF NOT EXISTS ${table}`);
    assert.ok(routesAt > 0, `${t.id}: its table bootstrap is in the file`);
    assert.ok(routesAt < server.indexOf('const server = app.listen'), `${t.id}: bootstrap inside start()`);
    assert.match(server, /app\.use\(express\.static\(path\.join\(__dirname, 'public'\)\)\)/, `${t.id}: static middleware after the routes`);
    // The plumbing is untouched by every template.
    assert.match(server, /algorithms: \['RS256'\]/, `${t.id}: auth pinned to RS256`);
    assert.match(server, /app\.get\('\/health'/, `${t.id}: /health`);
  }
});

test('the scaffold records which template a repo starts from, in its docs and its files', () => {
  const social = getTemplateFiles('Notes', 'notes-abc123', 'postgres://x', null, { template: 'social' });
  const claude = social.find((f) => f.path === 'CLAUDE.md').content;
  assert.match(claude, /the shared task board example/, 'CLAUDE.md names this template, not the presses demo');
  assert.ok(!claude.includes('/api/press'), 'CLAUDE.md does not name the press demo');
  const readme = social.find((f) => f.path === 'README.md').content;
  assert.match(readme, /stores tasks in a `tasks` table/);
  assert.match(readme, /\/api\/tasks\/:id\/toggle/);
  // The empty template keeps today's copy, which names the press demo.
  const empty = getTemplateFiles('Notes', 'notes-abc123', 'postgres://x', null);
  assert.match(empty.find((f) => f.path === 'CLAUDE.md').content, /the Press! example/);
  assert.match(empty.find((f) => f.path === 'README.md').content, /stores button presses in a `presses` table/);
  // The games' public/ files ride along verbatim.
  const g2 = getTemplateFiles('Notes', 'notes-abc123', 'postgres://x', null, { template: 'game2d' });
  assert.ok(g2.some((f) => f.path === 'public/game.js'), 'the 2D game ships its script');
  const g3 = getTemplateFiles('Notes', 'notes-abc123', 'postgres://x', null, { template: 'game3d' });
  const vendor = g3.find((f) => f.path === 'public/vendor/three.module.min.js');
  assert.ok(vendor, 'the 3D game ships the vendored three.js');
  assert.match(vendor.content, /three\.js/, 'the vendored file carries its upstream banner');
  const note = g3.find((f) => f.path === 'public/vendor/README.md');
  assert.match(note.content, /MIT/, 'the vendor note records the license');
  assert.ok(!['empty', 'social', 'media'].some((id) =>
    getTemplateFiles('N', 'n-a1', 'postgres://x', null, { template: id }).some((f) => f.path === 'public/game.js')),
  'only the games ship a game.js');
});