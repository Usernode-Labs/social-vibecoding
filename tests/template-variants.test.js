'use strict';

// The five create-dialog starters (#3521): every one is the same scaffold,
// differing only in its demo routes, table bootstrap, example card, example
// script and the README/CLAUDE.md sentences that describe them. The empty
// starter is today's output, unchanged. services/template.js builds each
// from the one shared file list, so what this pins is that a demo never
// reaches past its own sections into the shared scaffold.

const test = require('node:test');
const assert = require('node:assert/strict');

const { getTemplateFiles } = require('../src/services/template');

const TEMPLATES = ['empty', 'social-productivity', 'multimedia-social', 'game-2d', 'game-3d'];
// Files whose demo sections differ by starter. Everything else — the app
// manifest, the lockfile, the Dockerfile, the platform config — must be
// byte-identical across all five.
const DEMO_FILES = ['CLAUDE.md', 'README.md', 'server.js', 'public/index.html'];
const SLUG = 'notes-abc123';
const DB = 'postgres://x';

const files = (template) => getTemplateFiles('Notes', SLUG, DB, null, { template });
const byPath = (template) => Object.fromEntries(files(template).map((f) => [f.path, f.content]));

test('every starter ships the same files as the empty starter', () => {
  const empty = files('empty').map((f) => f.path).sort();
  for (const id of TEMPLATES) {
    assert.deepEqual(files(id).map((f) => f.path).sort(), empty, `${id} has the empty starter's file list`);
  }
});

test('only the demo sections of the scaffold differ from the empty starter', () => {
  const emptyFiles = byPath('empty');
  for (const id of TEMPLATES.slice(1)) {
    const other = byPath(id);
    for (const [p, content] of Object.entries(other)) {
      if (!DEMO_FILES.includes(p)) {
        assert.equal(content, emptyFiles[p], `${id}'s ${p} is byte-identical to the empty starter's`);
      } else {
        assert.notEqual(content, emptyFiles[p], `${id}'s ${p} carries its own demo`);
      }
    }
  }
});

test('each starter names its own table and routes in server.js, and ships them in index.html', () => {
  const server = (id) => byPath(id)['server.js'];
  const html = (id) => byPath(id)['public/index.html'];

  assert.match(server('empty'), /CREATE TABLE IF NOT EXISTS presses/, 'the empty starter is today\'s Press demo');
  assert.match(server('empty'), /app\.post\('\/api\/press'/);

  assert.match(server('social-productivity'), /CREATE TABLE IF NOT EXISTS tasks/);
  assert.match(server('social-productivity'), /INSERT INTO tasks/);
  assert.match(html('social-productivity'), /api\/tasks/);

  assert.match(server('multimedia-social'), /CREATE TABLE IF NOT EXISTS picks/);
  assert.match(server('multimedia-social'), /INSERT INTO picks/);
  assert.match(html('multimedia-social'), /api\/picks/);

  for (const id of ['game-2d', 'game-3d']) {
    assert.match(server(id), /CREATE TABLE IF NOT EXISTS scores/, `${id} stores round scores`);
    assert.match(server(id), /INSERT INTO scores/);
    assert.match(server(id), /\/api\/leaderboard/);
    assert.match(html(id), /api\/scores/);
  }
});

test('each starter\'s index.html keeps the platform\'s own markers', () => {
  for (const id of TEMPLATES) {
    const html = byPath(id)['public/index.html'];
    assert.match(html, /usernode-starter-notice@1/, `${id} announces its starter to the platform`);
    assert.match(html, /usernode-(?:bridge|native|tailwind)\//, `${id} loads the hosted assets relatively`);
  }
});

test('the game starters add no dependency and load nothing cross-origin', () => {
  const empty = JSON.parse(byPath('empty')['package.json']);
  for (const id of ['game-2d', 'game-3d']) {
    const pkg = JSON.parse(byPath(id)['package.json']);
    assert.deepEqual(pkg.dependencies, empty.dependencies, `${id} runs on the starter's dependencies`);
    const html = byPath(id)['public/index.html'];
    // Raw canvas and WebGL need nothing from the network; the only URL left
    // is SVG's own namespace, which the browser never fetches.
    assert.ok(!/<(?:script|link|img|source)\b[^>]*\b(src|href)="https?:/i.test(html), `${id} loads no cross-origin asset`);
  }
});
