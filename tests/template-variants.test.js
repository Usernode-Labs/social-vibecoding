// The create dialog's starting templates (#3521). "Start from a template"
// offers five examples — the Press! starter every project has always had
// (`empty`) plus a shared task board, a picture-post feed, a canvas game and
// a three.js game. services/template.js scaffolds the SAME core — auth,
// Dockerfile, Tailwind, dapp.json, the dev-console forwarder and the
// starter-notice welcome — and swaps only the demo: the example routes
// registered after the auth middleware, the demo table's CREATE TABLE
// bootstrap in start(), and the "Try the example" section and its script in
// public/index.html. These tests pin that split.
//
// Run with: node --test tests/template-variants.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getTemplateFiles } = require('../src/services/template');

// The keys services/create-options.js's TEMPLATES accepts. `empty` must stay
// byte-for-byte the scaffold before #3521; its own contract is pinned in
// tests/template-starter-notice.test.js and the create-options suite.
const TEMPLATE_KEYS = ['empty', 'social', 'media', 'game2d', 'game3d'];

function files(template) {
  return getTemplateFiles('Notes', 'notes-abc123', 'postgres://x', null, { template });
}

function file(list, p, template) {
  const f = list.find((x) => x.path === p);
  assert.ok(f, `${template || 'empty'} scaffold contains ${p}`);
  return f.content;
}

test('an unknown template key falls back to the empty starter', () => {
  assert.deepEqual(
    getTemplateFiles('Notes', 'notes-abc123', 'pg://x', null, { template: 'no-such-key' }),
    files('empty'),
    'a key the registry does not answer to is the starter demo, not a broken scaffold',
  );
  // And the default option is the same thing: every earlier caller keeps
  // today's scaffold.
  assert.deepEqual(getTemplateFiles('Notes', 'notes-abc123', 'pg://x'), files('empty'));
});

test('every template keeps the scaffold\'s platform pieces, and swaps only the demo', () => {
  // The paths that never change with the choice.
  const SHARED_PATHS = [
    'CLAUDE.md', 'README.md', 'package.json', 'package-lock.json', 'Dockerfile',
    'tailwind.config.js', 'styles/tailwind-input.css', '.dockerignore', '.gitignore',
    'project.toml', 'dapp.json', 'server.js', 'public/index.html',
  ];
  const emptyList = files('empty');
  for (const key of TEMPLATE_KEYS.filter((k) => k !== 'empty')) {
    const list = files(key);
    assert.deepEqual(list.map((f) => f.path), emptyList.map((f) => f.path),
      `${key} ships the same file set`);
    for (const p of SHARED_PATHS.filter((q) => q !== 'CLAUDE.md' && q !== 'README.md' && q !== 'server.js' && q !== 'public/index.html')) {
      assert.equal(file(list, p, key), file(emptyList, p),
        `${key}: ${p} is untouched by the template choice`);
    }
    // The generated server keeps its auth core and static contract.
    const server = file(list, 'server.js', key);
    assert.match(server, /jsonwebtoken/, `${key}: the auth core survives`);
    assert.match(server, /app\.use\(express\.static\(path\.join\(__dirname, 'public'\)\)\)/,
      `${key}: static serving survives`);
    assert.match(server, /app\.get\('\/health'/, `${key}: the health route survives`);
    // And the HTML keeps its sentinels.
    const html = file(list, 'public/index.html', key);
    assert.match(html, /usernode-dev-console@1/, `${key}: the dev-console forwarder stays`);
    assert.match(html, /usernode-starter-notice@1/, `${key}: the starter-notice sentinel stays`);
  }
});

test('each template registers its own demo routes and bootstrap, and the empty one only the Press! demo', () => {
  const cases = {
    social: { route: '/api/tasks', table: 'CREATE TABLE IF NOT EXISTS tasks', extra: '/api/tasks/:id/toggle' },
    media: { route: '/api/posts', table: 'CREATE TABLE IF NOT EXISTS posts', extra: '/api/posts/:id/heart' },
    game2d: { route: '/api/scores', table: 'CREATE TABLE IF NOT EXISTS scores', extra: null },
    game3d: { route: '/api/scores', table: 'CREATE TABLE IF NOT EXISTS scores', extra: null },
  };
  for (const key of Object.keys(cases)) {
    const server = file(files(key), 'server.js', key);
    const c = cases[key];
    assert.match(server, new RegExp(`app\\.get\\('${c.route.replace(/\//g, '\\/')}`), `${key}: GET ${c.route}`);
    assert.match(server, new RegExp(`app\\.post\\('${c.route.replace(/\//g, '\\/')}`), `${key}: POST ${c.route}`);
    if (c.extra) assert.match(server, new RegExp(c.extra.replace(/\//g, '\\/')), `${key}: ${c.extra}`);
    assert.ok(server.includes(c.table), `${key}: start() bootstraps its own demo table`);
    assert.doesNotMatch(server, /api\/press|api\/leaderboard/, `${key}: the Press! demo's routes are gone`);
  }
  // The empty starter keeps exactly today's demo, no borrowings from the
  // new ones.
  const empty = file(files('empty'), 'server.js');
  for (const stray of ['api/tasks', 'api/posts', 'api/scores', 'vendor/three']) {
    assert.doesNotMatch(empty, new RegExp(stray.replace(/\//g, '\\/')), `empty scaffold carries no ${stray}`);
  }
});

test('each template\'s CLAUDE.md and README name what its example is and where it lives', () => {
  const cases = {
    social: { example: 'task-board example', routes: '/api/tasks', table: '`tasks`' },
    media: { example: 'picture-post feed', routes: '/api/posts', table: '`posts`' },
    game2d: { example: 'star-catching game', routes: '/api/scores', table: '`scores`' },
    game3d: { example: 'gem-collecting 3D game', routes: '/api/scores', table: '`scores`' },
  };
  for (const key of Object.keys(cases)) {
    const c = cases[key];
    const claude = file(files(key), 'CLAUDE.md', key);
    const claudeFlat = claude.replace(/\s+/g, ' ');
    assert.match(claude, new RegExp(c.example), `${key}: CLAUDE.md names the example`);
    assert.ok(claudeFlat.includes(`the \`${c.routes}\``), `${key}: CLAUDE.md names the routes`);
    assert.ok(claudeFlat.includes(`the ${c.table} table bootstrap in \`server.js\``),
      `${key}: CLAUDE.md names the table and where it bootstraps`);
    const readme = file(files(key), 'README.md', key);
    assert.ok(readme.includes(`in a ${c.table} table`), `${key}: README names the table`);
    // The starter-notice instruction still points at the right thing: the
    // README sends the creator to CLAUDE.md, which carries the removal steps.
    assert.match(readme, /start with `CLAUDE\.md`/,
      `${key}: README still points at CLAUDE.md for the removal steps`);
  }
});

test('the 3D game\'s library comes from the app\'s own node_modules, never another origin', () => {
  const server = file(files('game3d'), 'server.js', 'game3d');
  // The route, registered BEFORE the static middleware like the demo routes.
  const vendorAt = server.indexOf("require.resolve('three')");
  const staticAt = server.indexOf("app.use(express.static(path.join(__dirname, 'public')))");
  assert.ok(vendorAt > 0 && vendorAt < staticAt, 'the three.js route is registered before static');
  assert.match(server, /app\.get\(\/\^\\\/vendor\\\/three/, 'the fixed-name route answers /vendor/three*.js');
  assert.match(server, /require\.resolve\('three'\)/,
    'the file is read out of this app\'s own dependency tree');
  assert.doesNotMatch(server, /https?:\/\/[^'"\s]*three/i, 'no off-origin three.js URL');
  // Only the fixed set of file names the library ships is ever served, so
  // the route cannot become a path into the dependency tree.
  assert.match(server, /three\.core\.js/, 'the module build imports three.core.js internally');
  // The demo imports it app-relatively, and the index.html script is a module.
  const html = file(files('game3d'), 'public/index.html', 'game3d');
  assert.match(html, /import \* as THREE from '\/vendor\/three\.module\.js';/);
  assert.match(html, /<script type="module">/);
  // The two other games and the empty scaffold never serve it.
  for (const key of ['empty', 'game2d']) {
    assert.doesNotMatch(file(files(key), 'server.js', key), /vendor\/three/,
      `${key} does not serve three.js`);
  }
});

test('the games are catch-and-collect demos with a ranking, not something else', () => {
  // The platform's content rules: no combat, no gambling. A score is a
  // high-score ranking — the demo text names catching and collecting.
  for (const key of ['game2d', 'game3d']) {
    const html = file(files(key), 'public/index.html', key);
    const script = html.slice(html.indexOf('<script'));
    assert.match(script, /ROUND_SECONDS = 30/, `${key}: a timed round`);
    assert.match(html, /High scores/, `${key}: a ranking, not a wager`);
    assert.doesNotMatch(script, /\b(kill|weapon|bet|casino|wager)\b/i, `${key}: no violence or gambling`);
  }
  const two = file(files('game2d'), 'public/index.html', 'game2d');
  assert.match(two, /Catch the falling stars/, '2D: stars, caught with a basket');
  const three = file(files('game3d'), 'public/index.html', 'game3d');
  assert.match(three, /Collect the gems/, '3D: gems, collected with a rolling ball');
  // The multimedia demo draws its own pictures: nothing is uploaded, and
  // nothing loads from another site.
  const media = file(files('media'), 'public/index.html', 'media');
  assert.doesNotMatch(media, /<input[^>]*type="file"/, 'media: no file upload');
  assert.doesNotMatch(media, /<(img|video|source)\b/, 'media: no external media elements');
  assert.match(media, /bg-gradient-to-br from-rose-500/, 'media: the six tiles are gradients it draws');
});

test('a non-empty demo writes through the same auth gate its server ships', () => {
  // Every demo route that takes a body runs after the same auth middleware
  // (the scaffold's requireAuth answers non-GET /api/ paths), and the two
  // game demos store a score the demo script itself sends with the token.
  for (const key of ['game2d', 'game3d']) {
    const html = file(files(key), 'public/index.html', key);
    assert.match(html, /x-usernode-token/, `${key}: the demo carries the platform token`);
    assert.match(html, /JSON\.stringify\(\{ score: score \}\)/, `${key}: the demo sends its own score`);
  }
});