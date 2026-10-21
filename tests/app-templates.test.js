'use strict';

// The four ready-made starters a new project can begin from (#3521), and the
// empty one they sit beside. The catalogue resolves every key; `empty` (and
// anything unknown, so an old row can never fail a Retry) is today's
// scaffold exactly; each named starter swaps only public/index.html and
// server.js, names itself in README.md and CLAUDE.md, and keeps the empty
// starter's auth block, hosted-asset proxy, static handler and fallback while
// loading nothing from another origin.
//
// Run with: node --test tests/app-templates.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { TEMPLATE_KEYS, NAMED_TEMPLATES, isTemplateKey, starterFor } = require('../src/services/app-templates');
const { getTemplateFiles } = require('../src/services/template');

const files = (opts) => getTemplateFiles('Seed swap', 'seed-swap-abc123', 'postgres://db', 'https://github.com/o/r', opts);
const file = (list, p) => list.find((f) => f.path === p).content;

test('the catalogue: five keys, and only those', () => {
  assert.deepEqual(TEMPLATE_KEYS, ['empty', 'social', 'multimedia', 'game2d', 'game3d']);
  for (const key of TEMPLATE_KEYS) assert.ok(isTemplateKey(key), key);
  for (const key of ['', 'Social', 'gallery', null, 1, {}, 'empty ']) assert.ok(!isTemplateKey(key), String(key));
  assert.equal(starterFor('empty'), null, 'Start from scratch has no starter of its own');
  assert.equal(starterFor('nope'), null, 'an unknown key falls back to empty rather than failing a Retry');
  assert.equal(starterFor(undefined), null);
});

test('empty is today\'s scaffold: the same files, whatever the caller leaves out', () => {
  const plain = files({});
  const empty = files({ template: 'empty' });
  const unknown = files({ template: 'not-a-starter' });
  assert.deepEqual(empty, plain);
  assert.deepEqual(unknown, plain);
  assert.match(file(plain, 'public/index.html'), /Try the example/);
  assert.match(file(plain, 'server.js'), /CREATE TABLE IF NOT EXISTS presses/);
  assert.match(file(plain, 'README.md'), /The scaffold is a small working demo/);
});

test('each named starter is a working screen and server of its own', () => {
  for (const key of ['social', 'multimedia', 'game2d', 'game3d']) {
    const t = NAMED_TEMPLATES[key];
    const list = files({ template: key });
    const html = file(list, 'public/index.html');
    const server = file(list, 'server.js');

    // A real screen: the starter notice, the dev-console forwarder, the
    // compiled stylesheet and the bridge, all by relative path.
    assert.match(html, /usernode-starter-notice@1/, `${key} notice`);
    assert.match(html, /\/usernode-starter-notice@1/, `${key} notice closes`);
    assert.match(html, /usernode-dev-console@1/, `${key} forwarder`);
    assert.match(html, /<link rel="stylesheet" href="\/tailwind\.css">/, `${key} stylesheet`);
    assert.match(html, /<script src="\/usernode-bridge\/v1\/bridge\.js"><\/script>/, `${key} bridge`);
    assert.match(html, /Starter template/, `${key} says it is a starter`);
    assert.match(html, /Start a new change/, `${key} says how to make it yours`);
    assert.match(html, new RegExp(`<title>Seed swap</title>`), `${key} names the app`);
    // Nothing from another origin: no absolute URL a browser would fetch.
    const offOrigin = [...html.matchAll(/(?:src|href)="((?:https?:)?\/\/[^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(offOrigin, [], `${key} loads no off-origin resource`);

    // The server keeps the empty starter's auth and plumbing.
    assert.match(server, /algorithms: \['RS256'\]/, `${key} pins RS256`);
    assert.match(server, /issuer: 'usernode'/, `${key} pins the issuer`);
    assert.match(server, /'usernode:app:' \+ process\.env\.USERNODE_APP_ID/, `${key} pins the audience`);
    assert.match(server, /claims\.pur === 'iframe'/, `${key} only accepts identity tokens`);
    assert.match(server, /usernode-\(\?:bridge\|native\|tailwind\)/, `${key} proxies the hosted assets`);
    assert.match(server, /app\.use\(express\.static\(path\.join\(__dirname, 'public'\)\)\)/, `${key} serves its screen`);
    assert.match(server, /\/app\/seed-swap-abc123\/full/, `${key} falls back to Homeroom`);
    // It carries its own table bootstrap and routes, and parses.
    assert.ok(server.includes(t.tables.split('\n')[0]), `${key} creates its own table`);
    assert.match(server, /app\.(get|post)\('\/api\//, `${key} has an API`);
    assert.doesNotThrow(() => new vm.Script(server), `${key} server parses`);

    // Other scaffold files are the same ones every project gets.
    for (const p of ['package.json', 'Dockerfile', 'dapp.json', '.claude/settings.json',
      '.claude/homeroom-canonical-repo', 'tailwind.config.js']) {
      assert.deepEqual(file(list, p), file(files({}), p), `${key} keeps ${p}`);
    }
  }
});

test('each server has the API the starter screen calls', () => {
  const social = file(files({ template: 'social' }), 'server.js');
  assert.match(social, /app\.get\('\/api\/tasks'/);
  assert.match(social, /app\.post\('\/api\/tasks'/);
  assert.match(social, /app\.post\('\/api\/tasks\/:id\/toggle'/);

  const wall = file(files({ template: 'multimedia' }), 'server.js');
  assert.match(wall, /app\.get\('\/api\/posts'/);
  assert.match(wall, /app\.post\('\/api\/posts'/);
  assert.match(wall, /app\.post\('\/api\/posts\/:id\/report'/);
  // One report hides the post for everyone, and the wall never shows it.
  assert.match(wall, /SET hidden = TRUE WHERE id = \$1 AND hidden = FALSE/);
  assert.match(wall, /WHERE hidden = FALSE/);
  // A photo has to be one Homeroom stored for this app.
  assert.match(wall, /'\/app-files\/'/, 'the photo prefix is Homeroom\'s own path');

  for (const key of ['game2d', 'game3d']) {
    const server = file(files({ template: key }), 'server.js');
    assert.match(server, /app\.get\('\/api\/scores'/, `${key} lists scores`);
    assert.match(server, /app\.post\('\/api\/scores'/, `${key} records a score`);
    assert.match(server, /score > 500/, `${key} bounds the score`);
  }
});

test('the starter is named in README.md and the CLAUDE.md starter section', () => {
  const readme = file(files({ template: 'multimedia' }), 'README.md');
  assert.match(readme, /\*\*Multimedia social\*\* starter/);
  assert.match(readme, /photo wall/, 'the caption says what it is');
  const claude = file(files({ template: 'multimedia' }), 'CLAUDE.md');
  assert.match(claude, /is the \*\*Multimedia social\*\* starter/);
  assert.match(claude, /usernode-starter-notice@1/, 'and what to replace first');
  // The empty starter's own copy is gone from a named one.
  assert.doesNotMatch(claude, /Press! example/);
  assert.doesNotMatch(readme, /The scaffold is a small working demo/);
});

test('no starter carries violence, gambling or a sign-in of its own', () => {
  const banned = /\b(weapon|gun|enemy|enemies|combat|attack|loot|wager|betting|casino|password|credit card)\b/i;
  for (const key of ['social', 'multimedia', 'game2d', 'game3d']) {
    const list = files({ template: key });
    for (const p of ['public/index.html', 'server.js']) {
      assert.doesNotMatch(file(list, p), banned, `${key} ${p}`);
    }
  }
});
