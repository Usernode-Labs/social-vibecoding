'use strict';

// The app starters a project can begin from (#3521). `empty` is today's
// scaffold and the default, so a body with no template keeps exactly what it
// had; `social`, `media`, `game-2d` and `game-3d` are working starters.
//
// The same shared-root guarantees every starter, whatever it renders:
// the platform's auth model, the hosted-asset proxy, health, the inline
// favicon, the precompiled /tailwind.css, one starter-notice sentinel pair
// and no off-origin subresource. The games and the shelf also have to keep
// Homeroom's content rules (no weapons, violence, gambling or mature
// themes), which the denylist below pins.
//
// Run with: node --test tests/app-templates.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { getTemplateFiles } = require('../src/services/template');
const { STARTERS, DEFAULT_TEMPLATE, isTemplateKey, templateKeys, getStarter } = require('../src/templates/app-starters');

const KEYS = ['empty', 'social', 'media', 'game-2d', 'game-3d'];

function filesFor(template) {
  return getTemplateFiles('My App', 'my-app-123', 'pg://x', 'https://github.com/o/r', { template });
}

function file(list, p) {
  const f = list.find((x) => x.path === p);
  assert.ok(f, `template contains ${p}`);
  return f.content;
}

test('the registry has exactly the five keys the create dialog offers, and empty is the default', () => {
  assert.deepEqual(templateKeys(), KEYS);
  assert.equal(DEFAULT_TEMPLATE, 'empty');
  for (const key of KEYS) assert.ok(isTemplateKey(key), key);
  assert.ok(!isTemplateKey('nope'));
  assert.ok(!isTemplateKey(undefined));
  assert.equal(getStarter('nope').key, 'empty', 'an old stored value falls back to empty');
  assert.deepEqual(
    KEYS.map((key) => STARTERS[key].name),
    ['Start from scratch', 'Social productivity', 'Multimedia board', '2D game', '3D game'],
  );
});

test('the default template and the explicit empty template are identical, file for file', () => {
  const implicit = getTemplateFiles('My App', 'my-app-123', 'pg://x', 'https://github.com/o/r');
  const explicit = getTemplateFiles('My App', 'my-app-123', 'pg://x', 'https://github.com/o/r', { template: 'empty' });
  assert.deepEqual(implicit, explicit);
});

test('every starter carries the shared scaffold, which no template may drop', () => {
  const shared = ['CLAUDE.md', 'README.md', 'package.json', 'package-lock.json', 'Dockerfile', 'tailwind.config.js',
    'styles/tailwind-input.css', '.dockerignore', '.gitignore', 'project.toml', 'dapp.json',
    '.claude/settings.json', '.claude/hooks/homeroom-freshness.sh', '.claude/README.md',
    '.claude/homeroom-canonical-repo', 'server.js', 'public/index.html'];
  for (const key of KEYS) {
    const list = filesFor(key);
    assert.deepEqual(list.map((f) => f.path), shared, key);
    // The starter's own words reach both documents.
    const claude = file(list, 'CLAUDE.md');
    assert.ok(claude.includes(STARTERS[key].claudeStarter), `${key}: CLAUDE.md carries the starter's own section`);
    assert.match(claude, /## Starter template/, key);
    const readme = file(list, 'README.md');
    assert.ok(readme.includes(STARTERS[key].readmeDemo), `${key}: README carries the starter's own demo list`);
    assert.match(readme, /## Replacing the template/, key);
  }
});

test('every index.html is a starter screen: one sentinel pair, the dev-console forwarder, an inline favicon and the compiled stylesheet', () => {
  for (const key of KEYS) {
    const html = file(filesFor(key), 'public/index.html');
    assert.equal((html.match(/usernode-starter-notice@1/g) || []).length, 2, `${key}: exactly one sentinel pair`);
    assert.ok(html.includes('usernode-dev-console@1'), `${key}: dev console forwarder`);
    assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,/, `${key}: inline favicon`);
    assert.ok(html.includes('<link rel="stylesheet" href="/tailwind.css">'), `${key}: compiled stylesheet`);
    assert.match(html, /<script src="\/usernode-bridge\/v1\/bridge.js"><\/script>/, `${key}: bridge by relative path`);
    // No off-origin subresource, comments stripped first (the scaffold
    // documents the hosted-runtime escape hatch by showing the tag).
    const live = html.replace(/<!--[\s\S]*?-->/g, '');
    for (const m of live.matchAll(/<(?:script|link|img)\b[^>]*\b(?:src|href)="([^"]+)"/g)) {
      assert.ok(!/^https?:\/\//.test(m[1]), `${key}: off-origin asset ${m[1]}`);
    }
    // Every NEW starter keeps its whole hero and example inside the
    // sentinel pair, so the agent removes the starter wholesale. The empty
    // one keeps today's shape exactly, example card outside it.
    if (key !== 'empty') {
      const open = html.indexOf('<!-- usernode-starter-notice@1');
      const close = html.indexOf('<!-- /usernode-starter-notice@1 -->');
      assert.ok(open < html.indexOf('Try the example') && html.indexOf('Try the example') < close, `${key}: example inside the sentinels`);
    }
  }
});

test('every server.js keeps the platform security model and answers health and favicon before the catch-all', () => {
  for (const key of KEYS) {
    const server = file(filesFor(key), 'server.js');
    assert.match(server, /algorithms: \['RS256'\]/, key);
    assert.match(server, /issuer: 'usernode'/, key);
    assert.match(server, /audience: APP_AUDIENCE/, key);
    assert.match(server, /claims\.pur === 'iframe'/, key);
    assert.match(server, /app\.get\('\/health'/, key);
    assert.match(server, /app\.get\('\/favicon\.ico', \(_req, res\) => res\.status\(204\)\.end\(\)\)/, key);
    assert.ok(server.indexOf("app.get('/favicon.ico'") < server.indexOf("app.get('*'"), `${key}: favicon before the catch-all`);
    assert.ok(server.indexOf("app.get('/health'") < server.indexOf("app.get('*'"), `${key}: health before the catch-all`);
    assert.match(server, /usernode-\(\?:bridge\|native\|tailwind\)/, key);
  }
});

test('each starter ships its own table and routes, and only the three dependencies the scaffold has', () => {
  const expected = {
    empty: { table: 'presses', routes: ['/api/press', '/api/leaderboard'] },
    social: { table: 'tasks', routes: ['/api/tasks', '/api/tasks/:id/toggle'] },
    media: { table: 'media', routes: ['/api/media', '/api/media/:id/report', 'media_reports'] },
    'game-2d': { table: 'scores', routes: ['/api/scores'] },
    'game-3d': { table: 'scores', routes: ['/api/scores'] },
  };
  for (const key of KEYS) {
    const server = file(filesFor(key), 'server.js');
    assert.match(server, /CREATE TABLE IF NOT EXISTS/, key);
    assert.ok(server.includes(expected[key].table), `${key}: ${expected[key].table}`);
    for (const route of expected[key].routes) {
      assert.ok(server.includes(route), `${key}: ${route}`);
    }
  }
  const pkg = JSON.parse(file(filesFor('empty'), 'package.json'));
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['express', 'jsonwebtoken', 'pg']);
  for (const key of KEYS) {
    assert.deepEqual(JSON.parse(file(filesFor(key), 'package.json')).dependencies, pkg.dependencies, key);
  }
});

test('the shelf keeps the content rules it was built for: https links only, no uploads, one report per person, three hide', () => {
  const server = file(filesFor('media'), 'server.js');
  assert.match(server, /\^https:\\\/\\\//, 'a link must start with https://');
  assert.match(server, /ON CONFLICT DO NOTHING/, 'one report per person');
  assert.match(server, />= 3/, 'three distinct reports hide the item');
  assert.match(server, /WHERE hidden = FALSE/, 'hidden items are left out of the list');
  assert.doesNotMatch(server, /type="file"|multipart|multer/, 'no uploads');
  const html = file(filesFor('media'), 'public/index.html');
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /<img\b/, 'the shelf renders no images');
});

test('no starter screen or server shows a weapon, violence, gambling or a mature theme', () => {
  // Word-bounded, so "target", "between" and "skill" do not trip it.
  const BANNED = /\b(guns?|rifles?|pistols?|weapons?|swords?|shoot|shooting|kill|killing|blood|violence|violent|fight|fighting|combat|enem(?:y|ies)|bet|bets|betting|wager|wagers|casino|gamble|gambling|loot\s*box|nude|nudity|sex|sexual|drugs?|alcohol|beer|wine|drunk|flirt|flirting|dating|hookup)\b/i;
  for (const key of KEYS) {
    const list = filesFor(key);
    // Screens and servers only: the docs quote the platform's own rule, which
    // names the categories a game must not show.
    for (const p of ['public/index.html', 'server.js', 'README.md']) {
      const hits = (file(list, p).match(BANNED) || []);
      assert.deepEqual(hits, [], `${key}/${p}: ${hits.join(', ')}`);
    }
  }
});
