'use strict';

// The four ready-made project templates (#3521): the allow-list, the strict
// parsing, Empty's unchanged byte-for-byte scaffold, the dialog's list
// matching the server's, and every starter generating a complete repository
// with its own declared checks.
//
// Run with: node --test tests/app-templates.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const templates = require('../src/services/app-templates');
const { getTemplateFiles } = require('../src/services/template');
const options = require('../src/services/create-options');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const files = (template) => getTemplateFiles('Weekend plans', 'weekend-plans-abc123', 'postgres://x', null, { template });
const byPath = (list, p) => list.find((f) => f.path === p);

test('the allow-list is closed, names Empty first, and refuses an unknown id', () => {
  assert.equal(templates.DEFAULT_TEMPLATE, 'empty');
  assert.deepEqual(templates.TEMPLATE_IDS,
    ['empty', 'social-productivity', 'multimedia-social', 'game-2d', 'game-3d']);
  assert.deepEqual(templates.TEMPLATES.map((t) => t.id), templates.TEMPLATE_IDS.slice(1));
  for (const id of templates.TEMPLATE_IDS) assert.ok(templates.isTemplate(id), id);
  assert.equal(templates.isTemplate('nope'), false);
  assert.deepEqual(options.parseCreateOptions({}), { ...options.parseCreateOptions({ template: 'empty' }) },
    'an absent template is Empty');
  assert.equal(options.parseCreateOptions({ template: '' }).template, 'empty');
  assert.equal(options.parseCreateOptions({ template: 'game-2d' }).template, 'game-2d');
  assert.match(options.parseCreateOptions({ template: 'nope' }).error,
    /^template must be one of: empty, social-productivity, multimedia-social, game-2d, game-3d$/);
  // An import keeps its own code, so a starter cannot be attached to it.
  assert.equal(options.parseCreateOptions({ template: 'empty' }, { imported: true }).template, 'empty');
  assert.match(options.parseCreateOptions({ template: 'game-2d' }, { imported: true }).error,
    /imported project keeps its own repository/);
});

test('Empty writes exactly the files it wrote before templates existed', () => {
  const plain = getTemplateFiles('Weekend plans', 'weekend-plans-abc123', 'postgres://x');
  const explicit = files('empty');
  assert.deepEqual(explicit, plain);
  assert.equal(byPath(plain, 'api.js'), undefined, 'no starter API');
  assert.equal(byPath(plain, 'public/app.js'), undefined, 'no starter screen script');
  assert.match(byPath(plain, 'server.js').content, /CREATE TABLE IF NOT EXISTS presses/);
  assert.doesNotMatch(byPath(plain, 'server.js').content, /require\('\.\/api'\)/);
  assert.deepEqual(JSON.parse(byPath(plain, 'dapp.json').content), { secrets: [] });
  assert.match(byPath(plain, 'public/index.html').content, /usernode-starter-notice@1/);
});

test('the dialog lists exactly the server\'s starters, in order', () => {
  const src = read('frontend/src/features/dialogs/create-app.tsx');
  const block = src.slice(src.indexOf('const TEMPLATES'), src.indexOf('type ImportState'));
  const keys = [...block.matchAll(/\{ key: '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(keys, templates.TEMPLATES.map((t) => t.id));
  for (const t of templates.TEMPLATES) {
    assert.ok(block.includes(`title: '${t.title}'`), t.title);
    assert.ok(block.includes(`caption: '${t.caption}'`), t.caption);
  }
});

test('every starter generates a complete, working repository', () => {
  for (const starter of templates.TEMPLATES) {
    const repo = files(starter.id);
    for (const required of ['api.js', 'public/index.html', 'public/app.js', 'server.js', 'dapp.json',
      'README.md', 'CLAUDE.md', 'package.json', 'Dockerfile', 'tailwind.config.js']) {
      assert.ok(byPath(repo, required), `${starter.id}: ${required}`);
      assert.ok(byPath(repo, required).content.length > 0, `${starter.id}: ${required} is not empty`);
    }
    const server = byPath(repo, 'server.js').content;
    assert.match(server, /const api = require\('\.\/api'\);/);
    assert.match(server, /api\.mount\(app, pool\);/);
    assert.match(server, /await api\.migrate\(pool\)/);
    assert.match(server, /USERNODE_ENV === 'staging'[\s\S]{0,120}api\.seed\(pool\)/);
    assert.match(server, /SIGTERM/);
    assert.match(server, /status: 'draining'/);

    const api = byPath(repo, 'api.js').content;
    assert.match(api, /module\.exports = \{ mount, migrate, seed/);
    assert.match(api, /async function migrate/);
    assert.match(api, /ON CONFLICT \(id\) DO NOTHING/, 'staging seeds are idempotent');
    assert.match(api, /USERNODE_ENV|seed/);

    const html = byPath(repo, 'public/index.html').content;
    assert.match(html, /usernode-dev-console@1/, 'the dev-console forwarder is injected');
    assert.match(html, /src="\/usernode-bridge\/v1\/bridge\.js"/);
    assert.match(html, /href="\/tailwind\.css"/);
    assert.match(html, /usernode:theme-changed/);
    assert.doesNotMatch(html, /src="https?:\/\//, 'no cross-origin asset');

    const manifest = JSON.parse(byPath(repo, 'dapp.json').content);
    assert.equal(manifest.name, 'Weekend plans');
    assert.equal(manifest.icon.color, starter.color);
    assert.deepEqual(manifest.secrets, []);
    assert.equal(manifest.tests.length, 2);
    for (const check of manifest.tests) {
      assert.ok(check.path.startsWith('/'), `${starter.id}: a check navigates a route`);
      assert.ok(check.expectSelector && check.expectText, `${starter.id}: ${check.id}`);
      assert.ok(check.expectSelector.length <= 256, `${starter.id}: selector fits the platform limit`);
      // The selector names something the starter's own screen renders.
      const token = check.expectSelector.match(/#([A-Za-z0-9_-]+)/);
      assert.ok(token, `${starter.id}: ${check.id} selects an id`);
      assert.ok(html.includes(`id="${token[1]}"`), `${starter.id}: ${check.id} -> #${token[1]}`);
    }
    assert.ok(manifest.tests.some((c) => c.visual), `${starter.id} has a visual check`);

    assert.match(byPath(repo, 'README.md').content, new RegExp(starter.title));
    assert.match(byPath(repo, 'CLAUDE.md').content, /## Starting template/);
    assert.match(byPath(repo, 'CLAUDE.md').content, new RegExp(starter.title));
    assert.doesNotMatch(byPath(repo, 'README.md').content, /Starter template.*placeholder example code/,
      'a starter is a real app, not the Empty placeholder');
  }
});

test('the starters are the only directories, and they live outside src/', () => {
  assert.deepEqual(fs.readdirSync(templates.STARTERS_DIR).sort(), templates.TEMPLATES.map((t) => t.id).sort());
  assert.ok(!templates.STARTERS_DIR.startsWith(path.join(root, 'src') + path.sep));
  for (const starter of templates.TEMPLATES) {
    assert.deepEqual(templates.starterFiles(starter.id).map((f) => f.path).sort(),
      ['api.js', 'public/app.js', 'public/index.html']);
  }
  assert.throws(() => templates.starterFiles('empty'));
  assert.throws(() => templates.starterFiles('nope'));
});

test('the content rules hold: no combat, weapons or gambling, and the feed can be reported', () => {
  const banned = /\b(weapon|gun|shoot|fight|combat|bet|wager|casino|gamble|loot box)\b/i;
  for (const starter of templates.TEMPLATES) {
    for (const file of templates.starterFiles(starter.id)) {
      assert.doesNotMatch(file.content, banned, `${starter.id}/${file.path} stays peaceful`);
    }
  }
  const feed = byPath(files('multimedia-social'), 'api.js').content;
  assert.match(feed, /HIDDEN_AT = 3/);
  assert.match(feed, /\/report/);
  assert.match(feed, /staging:private/);
  const feedJs = byPath(files('multimedia-social'), 'public/app.js').content;
  assert.match(feedJs, /'Report'/);
  assert.match(feedJs, /report/);
});

test('the template id is stored on the row and reaches both scaffold paths', () => {
  const schema = read('src/db/schema.sql');
  assert.match(schema, /ALTER TABLE apps ADD COLUMN IF NOT EXISTS template VARCHAR\(40\);/);
  const route = read('src/routes/apps.js');
  assert.match(route, /const template = options\.template && options\.template !== 'empty' \? options\.template : null;/);
  assert.match(route, /collab_visibility, view_visibility, template\)/);
  assert.match(route, /\.\.\.\(template \? \{ template \} : \{\}\),/);
  const creator = read('src/services/app-creator.js');
  assert.match(creator, /function templateOf\(row\)/);
  assert.match(creator, /appTemplates\.isTemplate\(id\) \? id : appTemplates\.DEFAULT_TEMPLATE/);
  assert.equal((creator.match(/template: templateOf\(appRow\)/g) || []).length, 2,
    'the GitHub push and the local build both write the same starter');
});
