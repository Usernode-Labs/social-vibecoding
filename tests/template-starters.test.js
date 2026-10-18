'use strict';

// The four working starters a project can be created from (request #3521):
// Social productivity, Multimedia social, 2D game and 3D game. Each is the
// same Homeroom scaffold — the starter notice, the dev-console forwarder, the
// inline favicon and the relative platform assets — with its own example
// card, routes and table bootstrap. `empty` stays template.js's own
// press-counter example, byte-identical to what every earlier app got.
//
// Run with: node --test tests/template-starters.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { getTemplateFiles } = require('../src/services/template');
const registry = require('../src/templates/starters');

// Required by their own paths, so the changed-file test mapping (which reads
// test source by path) runs this suite when a starter module changes.
const modules = {
  'social-productivity': require('../src/templates/starters/social-productivity'),
  'multimedia-social': require('../src/templates/starters/multimedia-social'),
  'game-2d': require('../src/templates/starters/game-2d'),
  'game-3d': require('../src/templates/starters/game-3d'),
};

const STARTERS = {
  'social-productivity': { heading: 'Shared tasks', routes: '/api/tasks' },
  'multimedia-social': { heading: 'Photo wall', routes: '/api/posts' },
  'game-2d': { heading: 'Star catcher', routes: '/api/scores' },
  'game-3d': { heading: 'Cube collector', routes: '/api/scores' },
};

const files = (template) => getTemplateFiles('My App', 'my-app-123', 'postgres://x', null, { template });
const file = (list, p) => {
  const found = list.find((x) => x.path === p);
  assert.ok(found, `template contains ${p}`);
  return found.content;
};

test('the registry lists the four starters, and each module declares its own id and words', () => {
  assert.deepEqual(registry.STARTER_IDS, ['social-productivity', 'multimedia-social', 'game-2d', 'game-3d']);
  for (const [id, module] of Object.entries(modules)) {
    assert.equal(module.id, id);
    assert.equal(registry.starterFor(id), module);
    assert.ok(module.label && module.caption, `${id}: the create screen's words`);
    assert.match(module.routes, /app\.(get|post|patch)\(/, `${id}: routes`);
    assert.match(module.bootstrap, /CREATE TABLE IF NOT EXISTS/, `${id}: a table bootstrap`);
    assert.ok(module.body().includes('Try the example'), `${id}: the example card`);
    assert.ok(module.script.includes('fetch('), `${id}: the page talks to its API`);
    assert.ok(module.docs.claude && module.docs.readme, `${id}: its docs`);
  }
  assert.equal(registry.starterFor('empty'), null, 'empty stays template.js\'s own scaffold');
  assert.equal(registry.starterFor('nope'), null, 'an unknown id falls back to empty');
});

test('the empty starter is the default, and is the output every earlier app got', () => {
  const omitted = getTemplateFiles('My App', 'my-app-123', 'postgres://x');
  assert.deepEqual(files('empty'), omitted);
  assert.deepEqual(files('not-a-starter'), omitted, 'an unknown id falls back to empty rather than half-swapping');
  const html = file(omitted, 'public/index.html');
  assert.match(html, /id="press-btn"/);
  assert.match(file(omitted, 'server.js'), /\/api\/press/);
});

test('each starter keeps the scaffold every generated app must carry', () => {
  for (const [id, expected] of Object.entries(STARTERS)) {
    const list = files(id);
    const html = file(list, 'public/index.html');
    const server = file(list, 'server.js');

    // The starter notice, its badge and the way to start building.
    assert.equal((html.match(/usernode-starter-notice@1/g) || []).length, 2, `${id}: one sentinel pair`);
    assert.match(html, /Starter template/, `${id}: the hero badge`);
    assert.match(html, /What's already working/, `${id}: the explainer card`);
    assert.match(html, /Start a new change/, `${id}: the way to start building`);
    // Platform infrastructure and the relative assets.
    assert.match(html, /usernode-dev-console@1/, `${id}: the dev-console forwarder`);
    assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,/, `${id}: inline favicon`);
    assert.match(html, /<link rel="stylesheet" href="\/tailwind.css">/, `${id}: relative stylesheet`);
    assert.match(html, /<script src="\/usernode-bridge\/v1\/bridge.js"><\/script>/, `${id}: relative bridge`);
    assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org)/,
      `${id}: no cross-origin script, font or stylesheet is loaded`);
    assert.match(server, /app\.get\('\/favicon\.ico'/, `${id}: favicon answered before the catch-all`);

    // Its own example instead of Press!.
    assert.doesNotMatch(html, /id="press-btn"/, `${id}: Press! is gone`);
    assert.doesNotMatch(server, /\/api\/press/, `${id}: the press routes are gone`);
    assert.ok(html.includes(expected.heading), `${id}: its own example card`);
    assert.ok(server.includes(expected.routes), `${id}: its own routes`);
    assert.doesNotMatch(file(list, 'CLAUDE.md'), /Press!/, `${id}: CLAUDE.md describes its own example`);
    assert.doesNotMatch(file(list, 'README.md'), /presses/, `${id}: README describes its own example`);

    // The generated server is real JavaScript.
    assert.doesNotThrow(() => new vm.Script(server), `${id}: server.js parses`);
  }
});

test('each starter writes its own structure, so no two render the same app', () => {
  const htmls = new Set(Object.keys(STARTERS).map((id) => file(files(id), 'public/index.html')));
  assert.equal(htmls.size, Object.keys(STARTERS).length);
});

test('a photo wall never returns a hidden post, and records a report without hiding it', () => {
  const server = file(files('multimedia-social'), 'server.js');
  assert.match(server, /WHERE p\.hidden = FALSE/, 'the feed filters hidden posts in the query');
  assert.match(server, /INSERT INTO post_reports/);
  assert.match(server, /ON CONFLICT DO NOTHING/);
  assert.doesNotMatch(server, /UPDATE posts SET hidden/, 'reporting does not hide a post');
  assert.match(server, /post_likes .*ON DELETE CASCADE|REFERENCES posts\(id\) ON DELETE CASCADE/,
    'likes and reports follow a deleted post');
  const claude = file(files('multimedia-social'), 'CLAUDE.md');
  assert.match(claude, /UPDATE posts SET hidden = TRUE WHERE id = \$1/, 'a moderator hides a post by setting the flag');
  assert.match(claude, /hidden = FALSE/, 'and the feed keeps filtering it');
});

test('the score routes are bounded, and keep each player\'s best', () => {
  for (const id of ['game-2d', 'game-3d']) {
    const server = file(files(id), 'server.js');
    assert.match(server, /Number\.isInteger\(score\) \|\| score < 0 \|\| score > 500/, `${id}: a score is 0 to 500`);
    assert.match(server, /GREATEST\(game_scores\.best_score, EXCLUDED\.best_score\)/, `${id}: only a best is kept`);
    assert.match(server, /ORDER BY best_score DESC, updated_at ASC[\s\S]{0,40}LIMIT 10/, `${id}: the top ten`);
    assert.match(server, /CREATE TABLE IF NOT EXISTS game_scores/, `${id}: its table`);
  }
});

test('no starter depicts weapons, violence, gambling or adult themes', () => {
  const banned = /\b(guns?|weapons?|knife|knives|kill|kills|killing|shoot|shooting|violence|violent|combat|fight|fighting|nude|nudity|sexual|sex|gamble|gambling|wager|bet|betting|casino|loot|drugs?|drunk|alcohol)\b/i;
  for (const id of Object.keys(STARTERS)) {
    for (const f of files(id)) {
      assert.doesNotMatch(f.content, banned, `${id} ${f.path}: content rules`);
    }
  }
});
