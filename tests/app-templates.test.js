'use strict';

// The starter templates a new project can begin from (#3521): Social
// productivity, Multimedia social, 2D game and 3D game. src/services/template.js
// swaps exactly `server.js` and `public/index.html` of the base scaffold for a
// starter, so these tests pin the two things that must not drift — the shared
// security surface (identity verification, public paths, no off-origin assets)
// and each starter's own screen and API.
//
// Run with: node --test tests/app-templates.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { getTemplateFiles } = require('../src/services/template');
const { starters, starterFor } = require('../src/templates/starters');

const KEYS = ['social', 'media', 'game2d', 'game3d'];

function filesFor(template) {
  return getTemplateFiles('Seed swap', 'seed-swap-123', 'pg://x', null, { template });
}

function file(list, path) {
  const entry = list.find((f) => f.path === path);
  assert.ok(entry, `template contains ${path}`);
  return entry.content;
}

test('the registry lists the four starters in the order the dialog shows them', () => {
  assert.deepEqual(starters.map((starter) => starter.key), KEYS);
  for (const key of KEYS) {
    const starter = starterFor(key);
    assert.ok(starter, key);
    assert.equal(typeof starter.document, 'function');
    assert.equal(typeof starter.server, 'function');
    assert.equal(typeof starter.title, 'string');
  }
  assert.equal(starterFor('empty'), null, 'empty is the base scaffold, not a starter');
  assert.equal(starterFor('nope'), null, 'an unknown key can never break a create or a heal');
});

test('every starter replaces exactly server.js and public/index.html, and nothing else', () => {
  const base = filesFor('empty');
  const basePaths = base.map((f) => f.path);
  for (const key of KEYS) {
    const files = filesFor(key);
    assert.deepEqual(files.map((f) => f.path), basePaths, `${key}: same files, same order`);
    assert.equal(files.length, base.length);
    assert.doesNotMatch(file(files, 'public/index.html'), /press-btn/, `${key}: no Press! demo`);
    assert.doesNotMatch(file(files, 'server.js'), /presses/, `${key}: no presses table`);
  }
});

test('the empty template is today\'s base scaffold, byte for byte', () => {
  const bare = getTemplateFiles('Seed swap', 'seed-swap-123', 'pg://x');
  assert.deepEqual(getTemplateFiles('Seed swap', 'seed-swap-123', 'pg://x', null, { template: 'empty' }), bare);
  assert.deepEqual(filesFor('unrecognised'), bare, 'an old row or a rollback keeps the base scaffold');
  assert.match(file(filesFor('empty'), 'public/index.html'), /press-btn/);
  assert.match(file(filesFor('empty'), 'server.js'), /CREATE TABLE IF NOT EXISTS presses/);
});

test('each starter head loads only its own compiled stylesheet and the platform bridge', () => {
  for (const key of KEYS) {
    const html = file(filesFor(key), 'public/index.html');
    const head = html.slice(0, html.indexOf('</head>'));
    const scripts = [...head.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(scripts, ['/usernode-bridge/v1/bridge.js'], `${key}: the bridge, by relative path`);
    const links = [...head.matchAll(/<link[^>]*href="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(links.filter((href) => href === '/tailwind.css').length, 1, `${key}: one stylesheet`);
    for (const href of links) {
      assert.ok(href === '/tailwind.css' || href.startsWith('data:'), `${key}: no remote stylesheet (${href})`);
    }
    // No off-origin script, stylesheet or image anywhere in the document.
    assert.doesNotMatch(html, /<script[^>]+src="https?:/, `${key}: no off-origin script`);
    assert.doesNotMatch(html, /<link[^>]+href="https?:/, `${key}: no off-origin link`);
    assert.doesNotMatch(html, /<img[^>]+src="https?:/, `${key}: no off-origin image`);
    assert.match(html, /usernode-dev-console@1/, `${key}: console errors still reach the shell`);
    assert.match(html, /usernode\.uploadFile|fetch\('\/api\//, `${key}: the screen calls its own API`);
  }
});

test('each starter server keeps the platform identity checks and the public-path set', () => {
  for (const key of KEYS) {
    const server = file(filesFor(key), 'server.js');
    assert.match(server, /algorithms: \['RS256'\]/, `${key}: pinned algorithm`);
    assert.match(server, /issuer: 'usernode'/, `${key}: pinned issuer`);
    assert.match(server, /audience: APP_AUDIENCE/, `${key}: pinned audience`);
    assert.match(server, /claims\.pur === 'iframe'/, `${key}: only identity tokens authenticate`);
    assert.match(server, /const PUBLIC_API_PATHS = new Set\(\['\/health'\]\);/, `${key}: only /health is public`);
    assert.match(server, /app\.use\(express\.static\(path\.join\(__dirname, 'public'\)\)\);/, `${key}: static mount`);
    assert.match(server, /server\.keepAliveTimeout = 75_000;/, `${key}: the platform's idle timeout`);
    assert.match(server, /'\/app\/seed-swap-123\/full'/, `${key}: unauthenticated visits carry this app's slug`);
  }
});

test('each starter index carries one starter-notice sentinel pair around its one line', () => {
  for (const starter of starters) {
    const html = starter.document('Seed swap');
    assert.equal((html.match(/usernode-starter-notice@1/g) || []).length, 2, `${starter.key}: exactly one pair`);
    const open = html.indexOf('<!-- usernode-starter-notice@1');
    const close = html.indexOf('<!-- /usernode-starter-notice@1 -->');
    assert.ok(open !== -1 && close > open, `${starter.key}: ordered sentinels`);
    const block = html.slice(open, close);
    assert.ok(block.includes(`Starter template: ${starter.title}. Replace this screen from the Homeroom icon's Start a new change row.`),
      `${starter.key}: names itself and how to replace it`);
    assert.doesNotMatch(block, /Improve/, `${starter.key}: no retired Improve pill`);
  }
});

test('a starter escapes the project name it renders', () => {
  for (const starter of starters) {
    const html = starter.document('<script>alert(1)</script>');
    assert.doesNotMatch(html, /<h1[^>]*><script>/, `${starter.key}: the name is text, not markup`);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, `${starter.key}: escaped`);
  }
});

test('each screen calls the API its server defines', () => {
  const cases = {
    social: ['/api/tasks', 'app.post(\'/api/tasks/:id/toggle\''],
    media: ['/api/posts', 'app.post(\'/api/posts/:id/report\''],
    game2d: ['/api/scores'],
    game3d: ['/api/scores'],
  };
  for (const key of KEYS) {
    const server = file(filesFor(key), 'server.js');
    const html = file(filesFor(key), 'public/index.html');
    for (const route of cases[key]) {
      assert.match(server, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${key}: ${route}`);
    }
    for (const call of html.match(/fetch\('\/api\/[^']+'/g) || []) {
      const path = call.slice(7, -1).split('?')[0];
      const pattern = path.replace(/:[a-z]+/gi, '[^/]+');
      assert.match(server, new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${key}: the screen calls ${path}, which the server serves`);
    }
  }
});

test('the media starter accepts only a platform-stored image and keeps a report route', () => {
  const server = file(filesFor('media'), 'server.js');
  assert.match(server, /const IMAGE_ID_RE = \/\^\[a-f0-9\]\{32\}\$\//);
  assert.match(server, /url\.pathname === '\/app-files\/' \+ id/);
  assert.match(server, /!PLATFORM_ORIGIN \|\| url\.origin === PLATFORM_ORIGIN/, 'a stored image is the platform\'s own');
  assert.match(server, /app\.post\('\/api\/posts\/:id\/report'/);
  assert.match(server, /ON CONFLICT \(post_id, user_id\) DO NOTHING/, 'a second report is a no-op');
  const html = file(filesFor('media'), 'public/index.html');
  assert.match(html, /This image is no longer available\./, 'a taken-down image is said, not broken');
  assert.match(html, /usernode\.uploadFile\(file/, 'the photo goes through the platform bridge');
});

test('both games clamp a posted score and return the best row per person, top ten', () => {
  for (const key of ['game2d', 'game3d']) {
    const server = file(filesFor(key), 'server.js');
    assert.match(server, /Math\.max\(0, Math\.min\(9999, n\)\)/, `${key}: clamped 0-9999`);
    assert.match(server, /MAX\(score\) AS score/, `${key}: a person's best score`);
    assert.match(server, /GROUP BY user_id, username ORDER BY score DESC, username ASC LIMIT 10/, `${key}: top ten`);
  }
});

test('the social starter lets anyone tick a task off and records who did', () => {
  const server = file(filesFor('social'), 'server.js');
  assert.match(server, /UPDATE tasks SET done = NOT done, done_by = CASE WHEN done THEN NULL ELSE \$2 END WHERE id = \$1/);
  assert.match(server, /CREATE TABLE IF NOT EXISTS tasks/);
  assert.match(server, /done_by VARCHAR\(255\)/);
});
