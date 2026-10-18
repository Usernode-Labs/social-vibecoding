'use strict';

// The five starter templates the create dialog offers (services/template.js
// TEMPLATES; create-options.TEMPLATES is what the route accepts). Every one
// is the same scaffold — the same auth, the same plumbing, the same
// starter-notice messaging the project's first real feature replaces — with
// only the example card, the demo routes and the demo table differing. The
// starter render is byte for byte what new projects always got, and an
// unknown key falls back to it rather than failing a Retry.
//
// Run with: node --test tests/create-templates.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { getTemplateFiles } = require('../src/services/template');
const { TEMPLATES } = require('../src/services/create-options');

const KEYS = ['starter', 'social', 'multimedia', 'game-2d', 'game-3d'];
const LABELS = {
  starter: 'Empty',
  social: 'Social productivity',
  multimedia: 'Multimedia social',
  'game-2d': '2D game',
  'game-3d': '3D game',
};

const filesOf = (template) => getTemplateFiles('Demo', 'demo-abc123', 'postgres://x', null, { template });
const fileOf = (template, path) => filesOf(template).find((f) => f.path === path).content;

test('the template keys the dialog sends are the ones the server accepts', () => {
  assert.deepEqual([...TEMPLATES], KEYS);
});

test('every template keeps the platform plumbing, whatever the demo is', () => {
  for (const key of KEYS) {
    const files = filesOf(key);
    const paths = files.map((f) => f.path);
    for (const expected of ['CLAUDE.md', 'README.md', 'server.js', 'public/index.html', 'Dockerfile', 'dapp.json',
      '.claude/settings.json', '.claude/hooks/homeroom-freshness.sh']) {
      assert.ok(paths.includes(expected), key + ' ships ' + expected);
    }
    const html = fileOf(key, 'public/index.html');
    assert.match(html, /usernode-dev-console@1/, key + ': the dev-console forwarder script');
    assert.match(html, /\/usernode-bridge\/v1\/bridge\.js/, key + ': the bridge script tag');
    assert.match(html, /<!-- usernode-starter-notice@1[\s\S]*<!-- \/usernode-starter-notice@1 -->/,
      key + ': the starter-notice sentinel pair wraps the welcome');
    assert.match(html, /This example will be replaced/, key + ': the example is labelled as one');
    const server = fileOf(key, 'server.js');
    assert.match(server, /app\.get\('\/health'/, key + ': /health');
    assert.match(server, /PUBLIC_API_PATHS = new Set\(\['\/health'\]\)/, key + ': the auth middleware, /health public');
    assert.match(server, /algorithms: \['RS256'\]/, key + ': the pinned JWT algorithm');
    assert.match(server, /app\.get\('\*', \(req, res\)/, key + ': the catch-all shell route');
  }
});

test('each template serves its own demo routes and table, and none of another\'s', () => {
  const marks = {
    starter: ["app.post('/api/press'", 'CREATE TABLE IF NOT EXISTS presses'],
    social: ["app.post('/api/tasks'", "app.post('/api/tasks/:id/toggle'", 'CREATE TABLE IF NOT EXISTS tasks', 'done_by'],
    multimedia: ["app.post('/api/media'", "app.post('/api/media/:id/like'", 'CREATE TABLE IF NOT EXISTS media_likes'],
    'game-2d': ["app.post('/api/score'", 'CREATE TABLE IF NOT EXISTS scores'],
    'game-3d': ["app.post('/api/score'", 'CREATE TABLE IF NOT EXISTS scores'],
  };
  for (const key of KEYS) {
    const server = fileOf(key, 'server.js');
    for (const mark of marks[key]) assert.ok(server.includes(mark), key + ' serves ' + mark);
    for (const other of KEYS) {
      // The two games share one high-score server part by design.
      if (other === key || (key.startsWith('game') && other.startsWith('game'))) continue;
      for (const mark of marks[other]) {
        assert.ok(!server.includes(mark), key + ' does not serve ' + other + "'s " + mark);
      }
    }
  }
  // The board keeps each person's BEST score, whatever they last sent.
  for (const key of ['game-2d', 'game-3d']) {
    assert.match(fileOf(key, 'server.js'), /GREATEST\(scores\.score, EXCLUDED\.score\)/);
  }
});

test('each example card is its own demo, and the two games play differently', () => {
  const htmlMarks = {
    starter: ['Press!', '0 total presses'],
    social: ['Shared to-do list', 'task-form'],
    multimedia: ['Shared queue', 'media-form', 'rel="noopener noreferrer"'],
    'game-2d': ['Star catch', '<canvas id="game"'],
    'game-3d': ['Tile orbit', 'preserve-3d'],
  };
  for (const key of KEYS) {
    const html = fileOf(key, 'public/index.html');
    for (const mark of htmlMarks[key]) assert.ok(html.includes(mark), key + ' shows ' + mark);
  }
  // The 2D game drives a canvas; the 3D game orbits a CSS scene. Neither
  // embeds anything and neither renders a raw link address as its title.
  assert.doesNotMatch(fileOf('game-2d', 'public/index.html'), /preserve-3d/);
  assert.doesNotMatch(fileOf('game-3d', 'public/index.html'), /<canvas/);
});

test('the hero badge names the template, and README and CLAUDE.md name it for non-starter scaffolds', () => {
  const badges = {
    starter: 'Starter template',
    social: 'Social productivity template',
    multimedia: 'Multimedia social template',
    'game-2d': '2D game template',
    'game-3d': '3D game template',
  };
  for (const key of KEYS) {
    assert.ok(fileOf(key, 'public/index.html').includes(`>${badges[key]}</span>`), key + ': badge ' + badges[key]);
    if (key === 'starter') {
      assert.doesNotMatch(fileOf(key, 'README.md'), /came from the/);
      assert.doesNotMatch(fileOf(key, 'CLAUDE.md'), /came from the \*\*/);
    } else {
      assert.match(fileOf(key, 'README.md'), new RegExp('came from the "' + LABELS[key] + '" template'));
      assert.match(fileOf(key, 'CLAUDE.md'), new RegExp('came from the \\*\\*' + LABELS[key] + '\\*\\* template'));
    }
  }
});

test('an unknown or missing key resolves to the starter, so a bad value on a row cannot fail a Retry', () => {
  const starter = filesOf('starter');
  assert.deepEqual(filesOf('junk'), starter);
  assert.deepEqual(filesOf(undefined), starter);
  assert.deepEqual(getTemplateFiles('Demo', 'demo-abc123', 'postgres://x'), starter,
    'a call without a template renders the starter, as every pre-template call site does');
});

test('the starter render is the scaffold new projects always got', () => {
  const html = fileOf('starter', 'public/index.html');
  assert.match(html, /<button id="press-btn" class="w-32 h-32 rounded-full bg-violet-600[^"]*">\n        Press!\n      <\/button>/);
  assert.match(html, /No presses yet/);
  const server = fileOf('starter', 'server.js');
  assert.match(server, /INSERT INTO presses \(user_id, username\) VALUES \(\$1, \$2\)/);
  assert.match(server, /SELECT username, COUNT\(\*\) as presses/);
  assert.match(server, /ORDER BY presses DESC/);
  // And nothing a non-starter template would add leaked into it.
  assert.doesNotMatch(server, /\/api\/tasks|\/api\/media|\/api\/score/);
  assert.doesNotMatch(html, /came from the/);
});