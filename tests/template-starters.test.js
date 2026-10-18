'use strict';

// The create screen's starter templates (#3521): the four starters the
// picker offers, what a project created from each ships, and what a
// project created WITHOUT one (the default, still "Start from scratch")
// does not. src/templates/starters/ feeds services/template.js, which
// splices each starter's demo over the scaffold's generic Press! blocks —
// so every test here reads the files getTemplateFiles writes, the way a
// new repository's server.js, index.html, CLAUDE.md and README.md read.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { STARTERS, get } = require('../src/templates/starters');
const { STARTER_TEMPLATE_IDS } = require('../src/services/create-options');
const { getTemplateFiles } = require('../src/services/template');

const files = (template) => getTemplateFiles('Demo', 'demo-abc123', 'postgres://x', null, { template });
const file = (template, p) => files(template).find((f) => f.path === p).content;

// The starter ids the picker offers are exactly the ids the registry
// serves (index.js already throws at load when either list drifts; this
// pins the pair they must agree with, including the picker's own copy).
test('the registry, create-options and the picker list the same four starters', () => {
  assert.deepEqual(Object.keys(STARTERS), [
    'social-productivity', 'multimedia-social', 'game-2d', 'game-3d',
  ]);
  assert.deepEqual(STARTER_TEMPLATE_IDS, Object.keys(STARTERS));
  const tsx = fs.readFileSync(path.join(__dirname, '../frontend/src/features/dialogs/create-app.tsx'), 'utf8');
  const picker = tsx.match(/const TEMPLATES[^=]*= \[([\s\S]*?)\n];/)[1];
  assert.deepEqual([...picker.matchAll(/key: '([a-z0-9-]+)'/g)].map((m) => m[1]),
    [...STARTER_TEMPLATE_IDS], 'the dialog offers the registry\'s starters in its order');
  assert.equal(get('no-such-thing'), null, 'an unknown id falls back, it does not throw the route');
});

// What every starter keeps: the scaffold around the demo is untouched, so
// a templated project deploys, is built on and is healed exactly like a
// scratch one.
test('a starter keeps the scaffold: sentinels, dev-console forwarder, auth, hosted-asset handler', () => {
  for (const id of STARTER_TEMPLATE_IDS) {
    const html = file(id, 'public/index.html');
    const server = file(id, 'server.js');
    const read = file(id, 'CLAUDE.md');
    assert.match(html, /usernode-starter-notice@1[\s\S]*usernode-starter-notice@1/, `${id}: starter-notice sentinel`);
    assert.match(html, /usernode-dev-console@1/, `${id}: dev-console forwarder`);
    assert.match(html, /Try the example/, `${id}: the demo card is still labelled`);
    assert.match(html, /This example will be replaced/, `${id}: the label still says it is replaced`);
    assert.match(read, /usernode-starter-notice@1/, `${id}: CLAUDE.md still tells the builder about the notice`);
    assert.match(server, /JWT_PUBLIC_KEY/, `${id}: the auth chassis`);
    assert.match(server, /x-usernode-token/, `${id}: the token header the demo scripts send`);
    assert.match(server, /usernode-\(\?:bridge\|native\|tailwind\)/, `${id}: the hosted-asset handler`);
    // The generated script must still be JavaScript this Node can parse.
    new (require('vm').Script)(server, { filename: `${id}-server.js` });
  }
});

// What each starter seeds: its demo routes and table bootstrap in
// server.js, its example card in index.html, and its name in the docs.
for (const id of STARTER_TEMPLATE_IDS) {
  test(`the "${id}" starter seeds its own demo, and names it`, () => {
  const starter = get(id);
  const server = file(id, 'server.js');
  const html = file(id, 'public/index.html');
  const claude = file(id, 'CLAUDE.md');
  const readme = file(id, 'README.md');

  // The demo routes and DDL come from the starter, not the Press! default.
  assert.ok(server.includes(starter.demoServer().routes), `${id}: its demo routes`);
  assert.ok(server.includes(starter.demoServer().ddl), `${id}: its DDL`);
  assert.ok(claude.includes(`\`${starter.demoTable}\``), 'CLAUDE.md names the starter\'s table');

  // The example card is the starter's own markup and script, with the ids
  // the script reads — unique, because getElementById returns the first.
  assert.ok(html.includes(starter.demoScreen().markup), `${id}: its example card`);
  assert.ok(html.includes(starter.demoScreen().script), `${id}: its demo script`);
  const ids = [...html.matchAll(/ id="([a-zA-Z0-9-]+)"/g)].map((m) => m[1]);
  const dupes = ids.filter((v, i) => ids.indexOf(v) !== i);
  assert.deepEqual(dupes, [], `${id}: demo ids are unique`);

  // The docs name THIS starter's example, not the Press! one.
  assert.ok(claude.includes(starter.exampleNote), `${id}: CLAUDE.md names its example`);
  assert.ok(readme.includes(starter.readmeExample), `${id}: README.md names its example`);
  assert.doesNotMatch(claude, /Press!/, `${id}: no Press! left in CLAUDE.md`);
  assert.doesNotMatch(html, /id="press-btn"/, `${id}: no Press! button left in the page`);
  });
}

test('multimedia posts arrive as bounded image data URLs', () => {
  const routes = get('multimedia-social').demoServer().routes;
  assert.match(routes, /data:\(image\\\/\(\?:png\|jpeg\|webp\)\);base64/,
    'only png, jpeg and webp data URLs are accepted');
  assert.match(file('multimedia-social', 'server.js'), /express\.json\(\{ limit: '3mb' \}\)/,
    'the demo raises the JSON limit so a 2MB picture fits');
});

test('the game starters score into a clamped top ten', () => {
  for (const id of ['game-2d', 'game-3d']) {
    const routes = get(id).demoServer().routes;
    assert.match(routes, /Math\.max\(0, Math\.min\(100000/, 'a score is clamped into 0..100000');
    assert.match(routes, /LIMIT 10/, 'the leaderboard is the top ten');
  }
});

test('the 3D game ships the vendored three.js it imports, with provenance', () => {
  const out = files('game-3d');
  const vendor = out.find((f) => f.path === 'public/vendor/three.module.min.js');
  assert.ok(vendor, 'the vendored module is one of the files pushed to the new repository');
  assert.match(vendor.content, /^\/\*\*\n \* @license/);
  const readme = out.find((f) => f.path === 'public/vendor/README.md');
  assert.match(readme.content, /three\.js/, 'the provenance README names the library');
  assert.match(readme.content, /[0-9a-f]{64}/, 'and carries the sha384 to verify it by');
  const html = file('game-3d', 'public/index.html');
  assert.match(html, /<script type="module">/, 'the demo script imports a module');
  assert.match(html, /import \* as THREE from '\/vendor\/three\.module\.min\.js';/);
  assert.match(file('game-3d', 'server.js'), /express\.static/, 'the app serves public/ statically, so /vendor/ answers');
});

// "Start from scratch" is the default and must not change shape: no
// starter block, the generic Press! demo, a plain script.
test('no template is the default: the generic demo, none of the starters', () => {
  const out = files(null);
  const html = out.find((f) => f.path === 'public/index.html').content;
  const server = out.find((f) => f.path === 'server.js').content;
  assert.match(html, /id="press-btn"/);
  assert.match(html, /<script>/);
  assert.doesNotMatch(html, /<script type="module">/);
  assert.match(server, /CREATE TABLE IF NOT EXISTS presses/);
  assert.match(server, /app\.use\(express\.json\(\)\);/);
  for (const [p, content] of out.map((f) => [f.path, f.content])) {
    assert.doesNotMatch(content, /three\.module\.min\.js/, `${p}: no starter file ships`);
  }
  for (const id of STARTER_TEMPLATE_IDS) {
    const starter = get(id);
    assert.ok(!server.includes(starter.demoServer().routes), `${id}: its demo routes are absent`);
    assert.ok(!server.includes(starter.demoServer().ddl), `${id}: its DDL is absent`);
    assert.ok(!html.includes(starter.demoScreen().markup), `${id}: its demo markup is absent`);
    assert.ok(!files(null).some((f) => (starter.extraFiles || [])
      .some((x) => f.path === x.path)), `${id}: its extra files are absent`);
  }
});
