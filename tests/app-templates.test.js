// The four ready-made starters (#3521): the server catalog, the create
// dialog's exported choices, and the two files every starter ships.
//
// The catalog is the one place keys, titles and captions are written on the
// server; the dialog repeats them so a test can compare the two. Each
// starter is public/index.html plus starter.js, and starter.js is EXECUTED
// here in a small sandbox — its routes are registered and its schema is read
// back — rather than grepped, so a starter that does not export what the
// generated server calls fails here.
//
// Run with: node --test tests/app-templates.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appTemplates = require('../src/services/app-templates');
const { getTemplateFiles } = require('../src/services/template');
const { loadTsx } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');

function starterSource(key, file) {
  return fs.readFileSync(path.join(root, 'src', 'templates', 'starters', key, file), 'utf8');
}

/** Run a starter.js and capture the routes it registers and the SQL it runs. */
function loadStarter(key, pool = { query: async () => ({ rows: [] }) }) {
  const source = starterSource(key, 'starter.js');
  const routes = [];
  const handlers = new Map();
  const record = (method) => (route, fn) => {
    routes.push([method, route]);
    handlers.set(`${method} ${route}`, fn);
  };
  const app = { get: record('GET'), post: record('POST') };
  const module = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', source)(module, module.exports, (id) => {
    throw new Error(`${key}/starter.js unexpectedly requires ${id}`);
  });
  const attachStarter = module.exports;
  attachStarter(app, pool);
  return { attachStarter, app, routes, handlers, source };
}

/** Run one route handler and report what it answered. */
async function call(handler, { body = {}, params = {}, user = { id: 7, username: 'ada' } }) {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  await handler({ body, params, user }, res, () => {});
  return { status: res.statusCode, body: res.payload };
}

async function schemaOf(attachStarter) {
  const queries = [];
  await attachStarter.ensureSchema({ query: async (sql) => { queries.push(sql); return { rows: [] }; } });
  return queries.join('\n');
}

const EXPECTED = {
  empty: {
    routes: [['POST', '/api/press'], ['GET', '/api/leaderboard']],
    tables: ['presses'],
  },
  social: {
    routes: [
      ['GET', '/api/goals'], ['POST', '/api/goals'], ['POST', '/api/goals/:id/cheer'],
      ['POST', '/api/goals/:id/status'], ['POST', '/api/goals/:id/report'],
    ],
    tables: ['goals', 'goal_cheers', 'goal_reports'],
  },
  media: {
    routes: [['GET', '/api/photos'], ['POST', '/api/photos'], ['POST', '/api/photos/:id/report']],
    tables: ['photos', 'photo_reports'],
  },
  game2d: {
    routes: [['GET', '/api/scores'], ['POST', '/api/scores']],
    tables: ['scores'],
  },
  game3d: {
    routes: [['GET', '/api/scores'], ['POST', '/api/scores']],
    tables: ['scores'],
  },
};

test('the dialog offers exactly the server catalog, in the same words', () => {
  const { TEMPLATE_CHOICES } = loadTsx('frontend/src/features/dialogs/create-app.tsx');
  assert.deepEqual(
    TEMPLATE_CHOICES.map((c) => ({ key: c.key, title: c.title, caption: c.caption })),
    appTemplates.TEMPLATES.map((t) => ({ key: t.key, title: t.title, caption: t.caption })),
    'keys, titles and captions cannot drift between the dialog and the server',
  );
  assert.deepEqual([...appTemplates.TEMPLATE_KEYS], ['empty', 'social', 'media', 'game2d', 'game3d']);
  assert.equal(appTemplates.templateEntry('empty'), null, 'Start from scratch is not a ready-made template');
  assert.equal(appTemplates.templateEntry('game2d').title, '2D game');
});

test('every starter ships on top of the common scaffold, and an unknown key throws', () => {
  const common = ['CLAUDE.md', 'README.md', 'package.json', 'package-lock.json', 'Dockerfile',
    'tailwind.config.js', 'styles/tailwind-input.css', '.dockerignore', '.gitignore', 'project.toml',
    'dapp.json', '.claude/settings.json', 'server.js'];
  for (const key of appTemplates.TEMPLATE_KEYS) {
    const files = getTemplateFiles('My App', 'my-app-123', 'pg://x', null, { template: key });
    const byPath = new Map(files.map((f) => [f.path, f.content]));
    for (const p of common) assert.ok(byPath.has(p), `${key} still ships ${p}`);
    assert.ok(byPath.has('starter.js'), `${key} ships starter.js`);
    assert.ok(byPath.has('public/index.html'), `${key} ships public/index.html`);
    assert.ok(!byPath.has('public/tailwind.css'), 'the stylesheet is built by the image');
    // The template is named where a coding agent reads it.
    if (key !== 'empty') {
      const entry = appTemplates.templateEntry(key);
      assert.match(byPath.get('CLAUDE.md'), new RegExp(entry.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(byPath.get('README.md'), new RegExp(`\\*\\*${entry.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\*\\*`));
    }
  }
  assert.throws(() => appTemplates.renderStarter('racing', { appName: 'x' }), /Unknown app template/);
  assert.throws(() => getTemplateFiles('My App', 'my-app-123', 'pg://x', null, { template: 'racing' }),
    /Unknown app template/);
});

test('the Empty starter is still the Press! page and the same two routes', () => {
  const files = getTemplateFiles('My App', 'my-app-123', 'pg://x');
  const html = files.find((f) => f.path === 'public/index.html').content;
  for (const id of ['press-btn', 'count', 'leaderboard']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, id);
  }
  assert.match(html, /id="press-btn"/);
  assert.match(html, /Try the example/);
  assert.match(html, /usernode-starter-notice@1/);
  const server = files.find((f) => f.path === 'server.js').content;
  assert.doesNotMatch(server, /\/api\/press/, 'the press routes moved into starter.js');
  assert.match(server, /require\('\.\/starter'\)/);
  assert.match(server, /attachStarter\(app, pool\);/);
  assert.match(server, /await attachStarter\.ensureSchema\(pool\);/);
  const starter = files.find((f) => f.path === 'starter.js').content;
  assert.match(starter, /INSERT INTO presses/);
});

test('every page carries the platform parts and exactly one starter-notice pair', () => {
  for (const key of appTemplates.TEMPLATE_KEYS) {
    const html = getTemplateFiles('My App', 'my-app-123', 'pg://x', null, { template: key })
      .find((f) => f.path === 'public/index.html').content;
    assert.equal((html.match(/usernode-starter-notice@1/g) || []).length, 2, `${key}: one sentinel pair`);
    assert.match(html, /<html lang="en" class="dark">/, `${key}: dark document`);
    assert.match(html, /<body class="bg-zinc-950/, `${key}: the platform's dark ground`);
    assert.match(html, /<link rel="stylesheet" href="\/tailwind\.css">/, `${key}: precompiled stylesheet`);
    assert.match(html, /<script src="\/usernode-bridge\/v1\/bridge\.js"><\/script>/, `${key}: the bridge`);
    assert.match(html, /rel="icon" href="data:image\/svg\+xml,/, `${key}: inline favicon`);
    assert.match(html, /usernode-dev-console@1/, `${key}: the dev-console forwarder`);
    assert.match(html, /x-usernode-token/, `${key}: the token is forwarded`);
    assert.doesNotMatch(html, /\{\{APP_NAME\}\}|\{\{DEV_CONSOLE\}\}/, `${key}: no placeholders left`);
    // No off-origin static asset. Comments are stripped first: they document
    // the hosted runtime without loading it.
    const live = html.replace(/<!--[\s\S]*?-->/g, '');
    for (const m of live.matchAll(/<(?:script|link|img)\b[^>]*\b(?:src|href)="([^"]+)"/g)) {
      assert.ok(!/^https?:\/\//.test(m[1]), `${key} loads an off-origin asset: ${m[1]}`);
    }
    if (key !== 'empty') {
      // The banner names the template and says how to replace it.
      assert.match(html, /Starter template · /, key);
      assert.match(html, /Homeroom icon/, key);
      assert.match(html, /Start a new change/, key);
      // The page renders user text with textContent, never as markup.
      assert.doesNotMatch(html, /innerHTML/, key);
    }
  }
});

test('the template page replaces the app name and the dev-console block', () => {
  const html = getTemplateFiles('Paula & Sam', 'paula-abc', 'pg://x', null, { template: 'social' })
    .find((f) => f.path === 'public/index.html').content;
  assert.match(html, /<title>Paula &amp; Sam<\/title>/);
  assert.match(html, /<h1 class="text-2xl font-bold">Paula &amp; Sam<\/h1>/);
  assert.match(html, /usernode-dev-console@1/);
});

test('every starter.js exports attachStarter with ensureSchema, and registers its own routes and tables', async () => {
  for (const key of appTemplates.TEMPLATE_KEYS) {
    const { attachStarter, routes } = loadStarter(key);
    assert.equal(typeof attachStarter, 'function', `${key}: a function`);
    assert.equal(typeof attachStarter.ensureSchema, 'function', `${key}: ensureSchema is attached`);
    assert.deepEqual(routes, EXPECTED[key].routes, `${key}: routes`);
    const schema = await schemaOf(attachStarter);
    for (const table of EXPECTED[key].tables) {
      assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`), `${key}: creates ${table}`);
    }
  }
});

test('a goal or photo reported by three different people is hidden from every read', async () => {
  for (const [key, table, reportTable, idColumn] of [
    ['social', 'goals', 'goal_reports', 'goal_id'],
    ['media', 'photos', 'photo_reports', 'photo_id'],
  ]) {
    const { attachStarter, source } = loadStarter(key);
    const schema = await schemaOf(attachStarter);
    assert.match(schema, /hidden BOOLEAN NOT NULL DEFAULT FALSE/, `${key}: hidden flag`);
    assert.match(source, /HIDE_AFTER_REPORTS = 3/, `${key}: three reports`);
    assert.match(source, new RegExp(`UPDATE ${table} SET hidden = TRUE`), `${key}: hides at the threshold`);
    assert.match(source, new RegExp(`\\(SELECT COUNT\\(\\*\\) FROM ${reportTable} WHERE ${idColumn} = \\$1\\) >= \\$2`),
      `${key}: counts distinct reports`);
    assert.match(source, new RegExp(`FROM ${table}[\\s\\S]*?hidden = FALSE`), `${key}: reads hide reported rows`);
  }
});

test('the games take a whole score from 0 to 10000 and list the top ten plus the viewer\'s best', async () => {
  for (const key of ['game2d', 'game3d']) {
    const queries = [];
    const pool = { query: async (sql, args) => { queries.push([sql, args]); return { rows: [{ best: 5 }] }; } };
    const { attachStarter, handlers, source } = loadStarter(key, pool);
    await schemaOf(attachStarter);
    assert.match(source, /LIMIT 10/);
    assert.match(source, /MAX\(score\)::int AS best/);

    const insert = handlers.get('POST /api/scores');
    for (const [score, expected] of [[-1, 400], [1.5, 400], [10001, 400], ['5', 400], [0, 201], [10000, 201]]) {
      const answer = await call(insert, { body: { score } });
      assert.equal(answer.status, expected, `${key}: score ${JSON.stringify(score)}`);
    }
    const accepted = queries.filter(([sql]) => /INSERT INTO scores/.test(sql));
    assert.deepEqual(accepted.map(([, args]) => args), [[7, 'ada', 0], [7, 'ada', 10000]],
      `${key}: the stored row is the user and the whole score`);
  }
});

test('Multimedia social stores only Homeroom file URLs, with the id the page uploaded', () => {
  const { attachStarter } = loadStarter('media');
  const id = '0123456789abcdef0123456789abcdef';
  assert.equal(attachStarter.fileIdOf(`https://apps.example.com/app-files/${id}`, id), id);
  assert.equal(attachStarter.fileIdOf(`/app-files/${id}`, id), null, 'a relative path is not a stored URL');
  assert.equal(attachStarter.fileIdOf(`https://evil.example.com/${id}`, id), null);
  assert.equal(attachStarter.fileIdOf(`https://apps.example.com/app-files/${id}`, 'f'.repeat(32)), null,
    'the claimed id must be the one in the path');
  assert.equal(attachStarter.fileIdOf(`https://apps.example.com/app-files/${id}`, undefined), null);
  assert.equal(attachStarter.fileIdOf(`https://apps.example.com/app-files/${id.slice(0, 31)}`, id), null,
    'a 31-character id is not a Homeroom file');
});
