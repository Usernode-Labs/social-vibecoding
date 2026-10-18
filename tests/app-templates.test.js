'use strict';

// A new project can start from one of five starting points (#3521):
//
//   empty       Start from scratch — the Press! scaffold every new app had
//   social      Social productivity — a shared plan board
//   multimedia  Multimedia social — a media wall with reactions and Report
//   2d          2D game — catch the stars on a canvas
//   3d          3D game — collect orbs on a CSS 3D board
//
// src/services/app-templates.js is the registry; each starter module in
// src/templates/starters/ supplies the pieces src/services/template.js
// wraps in the shared shell. This file pins the keys, the fallback, the
// frontend's client-side list, and the things every generated app must keep
// whatever its starting point — the starter notice, the example card, the
// inline favicon, the relative stylesheet and bridge, no off-origin assets,
// and the platform's token verification.
//
// Run with: node --test tests/app-templates.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const {
  TEMPLATE_KEYS,
  isTemplateKey,
  starterFor,
} = require('../src/services/app-templates');
const { getTemplateFiles } = require('../src/services/template');
const { shellMarkup } = require('./lib/shell-markup');
const { loadTsx } = require('./lib/render-tsx');

const SHA = 'my-app-123';
const filesFor = (template) => getTemplateFiles('My App', SHA, 'pg://x', 'https://github.com/o/r', { template });
const file = (list, p) => {
  const f = list.find((x) => x.path === p);
  assert.ok(f, `template contains ${p}`);
  return f.content;
};

test('the registry names five starting points and falls back to empty', () => {
  assert.deepEqual([...TEMPLATE_KEYS], ['empty', 'social', 'multimedia', '2d', '3d']);
  for (const key of TEMPLATE_KEYS) assert.equal(isTemplateKey(key), true, key);
  for (const bad of ['', 'game', '2D', null, undefined, 2, 'social ']) {
    assert.equal(isTemplateKey(bad), false, String(bad));
  }
  for (const key of TEMPLATE_KEYS) {
    const starter = starterFor(key);
    assert.equal(starter.key, key, `${key} module names its key`);
    assert.ok(starter.title && starter.caption, `${key} has picker words`);
    for (const piece of ['welcome', 'exampleCard', 'script', 'routes', 'bootstrapSql', 'readmeDatabase', 'readmeApi', 'claudeDemo', 'claudeRemove']) {
      assert.equal(typeof starter[piece], 'string', `${key}.${piece}`);
      assert.ok(starter[piece].trim(), `${key}.${piece} is not empty`);
    }
  }
  assert.equal(starterFor('nonsense').key, 'empty', 'an unknown key rebuilds today\'s starter');
  assert.equal(starterFor(undefined).key, 'empty');
});

test('the frontend picker lists exactly the four named starting points, in registry order', () => {
  const { STARTERS } = loadTsx('frontend/src/features/dialogs/create-app.tsx');
  assert.deepEqual(STARTERS.map((s) => s.key), ['social', 'multimedia', '2d', '3d']);
  assert.deepEqual(
    STARTERS.map((s) => s.key),
    TEMPLATE_KEYS.filter((k) => k !== 'empty'),
    'the picker repeats neither Empty nor anything the registry lacks',
  );
  for (const entry of STARTERS) {
    assert.equal(entry.title, starterFor(entry.key).title, `${entry.key} title matches the module`);
    assert.ok(entry.caption.trim(), `${entry.key} has a caption`);
  }
});

test('every starter wraps its demo in the same shared shell', () => {
  for (const key of TEMPLATE_KEYS) {
    const files = filesFor(key);
    const html = file(files, 'public/index.html');
    assert.equal((html.match(/usernode-starter-notice@1/g) || []).length, 2, `${key}: exactly one sentinel pair`);
    assert.match(html, /Starter template/, `${key}: names the starter template`);
    assert.match(html, /What's already working/, `${key}: keeps the explainer card`);
    assert.match(html, /Tap the <strong[^>]*>Homeroom icon<\/strong> in the header and choose <strong[^>]*>Start a new change<\/strong>/, `${key}: says how to build`);
    assert.match(html, /Try the example/, `${key}: labels the demo`);
    assert.match(html, /This example will be replaced/, `${key}: says the demo is temporary`);
    assert.match(html, /Built on Homeroom — this template screen disappears once you build your real app\./, `${key}: footer`);
    // Same platform assets as the default scaffold, all relative.
    assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,/, `${key}: inline favicon`);
    assert.match(html, /<link rel="stylesheet" href="\/tailwind.css">/, `${key}: precompiled stylesheet`);
    assert.match(html, /<script src="\/usernode-bridge\/v1\/bridge.js"><\/script>/, `${key}: bridge`);
    assert.match(html, /<html lang="en" class="dark">/, `${key}: dark page`);
    assert.match(html, /<body class="bg-zinc-950 /, `${key}: dark ground`);
    const live = html.replace(/<!--[\s\S]*?-->/g, '');
    for (const m of live.matchAll(/<(?:script|link|img)\b[^>]*\b(?:src|href)="([^"]+)"/g)) {
      assert.ok(!/^https?:\/\//.test(m[1]), `${key}: off-origin asset ${m[1]}`);
    }
    assert.doesNotMatch(live, /cdn\.tailwindcss\.com/, `${key}: no CDN engine`);
  }
});

test('every starter keeps the platform\'s identity and hosted-asset contract', () => {
  for (const key of TEMPLATE_KEYS) {
    const server = file(filesFor(key), 'server.js');
    assert.match(server, /algorithms: \['RS256'\]/, `${key}: RS256 pinned`);
    assert.match(server, /issuer: 'usernode'/, `${key}: issuer pinned`);
    assert.match(server, /audience: APP_AUDIENCE/, `${key}: audience pinned`);
    assert.match(server, /usernode-\(\?:bridge\|native\|tailwind\)/, `${key}: hosted asset route`);
    assert.doesNotMatch(server, /JWT_SECRET/, `${key}: no JWT_SECRET in the scaffold`);
    assert.doesNotThrow(() => new vm.Script(server, { filename: `${key}-server.js` }), `${key}: server.js parses`);
    assert.match(server, /app\.get\('\/favicon\.ico'/, `${key}: favicon route`);
    assert.ok(server.indexOf("app.get('/favicon.ico'") < server.indexOf("app.get('*'"), `${key}: favicon before catch-all`);
  }
});

test('the empty starter is today\'s Press! scaffold, unchanged', () => {
  const files = filesFor('empty');
  const html = file(files, 'public/index.html');
  const server = file(files, 'server.js');
  for (const id of ['press-btn', 'count', 'leaderboard']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `one #${id}`);
  }
  assert.match(html, />\s*Press!\s*<\/button>/);
  assert.match(server, /app\.post\('\/api\/press'/);
  assert.match(server, /app\.get\('\/api\/leaderboard'/);
  assert.match(server, /CREATE TABLE IF NOT EXISTS presses/);
  // The default options object is the empty starter, so every existing
  // caller gets the scaffold it always did.
  assert.deepEqual(getTemplateFiles('My App', SHA, 'pg://x', 'https://github.com/o/r'), files);
});

test('each named starter seeds its own safe demo and keeps the platform\'s content rules', () => {
  const social = file(filesFor('social'), 'server.js');
  assert.match(social, /CREATE TABLE IF NOT EXISTS plan_items/);
  assert.match(social, /CREATE TABLE IF NOT EXISTS plan_joins/);
  assert.match(social, /app\.get\('\/api\/items'/);
  assert.match(social, /app\.post\('\/api\/items'/);
  assert.match(social, /app\.post\('\/api\/items\/:id\/join'/);
  assert.match(social, /Plant the spring bulbs/);
  assert.match(social, /Pick a book for the group/);
  assert.match(social, /WHERE NOT EXISTS \(SELECT 1 FROM plan_items\)/, 'seeds only an empty board');

  const media = file(filesFor('multimedia'), 'server.js');
  for (const table of ['media_posts', 'media_reactions', 'media_reports']) {
    assert.match(media, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`), table);
  }
  for (const route of ['/api/posts', '/api/posts/:id/react', '/api/posts/:id/report']) {
    assert.ok(media.includes(route), route);
  }
  assert.match(media, /WHERE p\.hidden = FALSE/, 'hidden posts never render');
  const mediaHtml = file(filesFor('multimedia'), 'public/index.html');
  assert.match(mediaHtml, /Report/, 'every post has a Report control');
  for (const cover of ['amber', 'rose', 'sky', 'emerald', 'violet']) {
    assert.match(mediaHtml, new RegExp(`from-${cover}-500`), `${cover} cover is a built-in gradient`);
  }
  assert.doesNotMatch(mediaHtml, /type="file"|accept="image/, 'no uploads');

  for (const key of ['2d', '3d']) {
    const server = file(filesFor(key), 'server.js');
    assert.match(server, /CREATE TABLE IF NOT EXISTS game_scores/, `${key}: scores table`);
    assert.match(server, /app\.get\('\/api\/scores'/, `${key}: scores read`);
    assert.match(server, /app\.post\('\/api\/scores'/, `${key}: scores write`);
    assert.match(server, /score < 0 \|\| score > 9999/, `${key}: score bounded`);
    const html = file(filesFor(key), 'public/index.html');
    assert.match(html, /Top ten/, `${key}: leaderboard`);
  }
  // No starter ships a weapon, a wager or a paid random reward.
  for (const key of TEMPLATE_KEYS) {
    const html = file(filesFor(key), 'public/index.html');
    assert.doesNotMatch(html, /\b(gun|weapon|bet|wager|loot box)\b/i, `${key}: content rules`);
  }
});

test('the picker ids are runtime-only: the prerendered shell has none of them', () => {
  const html = shellMarkup();
  const card = html.slice(html.indexOf('id="create-card"'), html.indexOf('id="rename-modal"'));
  assert.doesNotMatch(card, /id="create-template-block"/, 'mounted only in template mode');
  assert.doesNotMatch(card, /data-template-pill=/, 'no picker rows on arrival');
  assert.match(card, /data-template=""/, 'the card carries the answer empty');
});
