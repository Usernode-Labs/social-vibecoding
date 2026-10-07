'use strict';

// App templates (#3521): a new project can start from Empty (the default,
// the scaffold every project always got) or one of four starters, social
// productivity, multimedia social, a 2D game and a 3D game.
//
// What is pinned here, without a database:
//
//   1. THE ALLOW-LIST. POST /api/apps takes `template` from
//      services/app-templates.js's TEMPLATE_IDS and nothing else; absent is
//      `empty`; an import takes none. The create dialog's list is the same
//      list less `empty` (which is "Start from scratch").
//   2. EMPTY IS THE DEFAULT. Absent and `empty` write exactly the same
//      files (#4047 dropped the scaffold's Press! demo, so "always got" is
//      the static welcome screen, not the old one).
//   3. EVERY STARTER GENERATES A WORKING REPOSITORY: its files, filled in;
//      the platform conventions every app keeps (the bridge by relative
//      path, the dev console forwarder, no CDN, the theme, a graceful
//      shutdown, staging seeds behind USERNODE_ENV); and a dapp.json whose
//      declared checks the platform's own reader keeps, with each check's
//      anchors present in the starter's screen. Running each starter's API
//      against a real database is tests/app-templates-postgres.test.js; the
//      checks themselves were run in Chromium against each generated app
//      when the starters were written (see the PR).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appTemplates = require('../src/services/app-templates');
const { parseCreateOptions } = require('../src/services/create-options');
const { getTemplateFiles } = require('../src/services/template');
const appManifest = require('../src/services/app-manifest');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const STARTERS = ['social-productivity', 'multimedia-social', 'game-2d', 'game-3d'];

function generate(template, extra = {}) {
  return getTemplateFiles('Demo <App> & "co"', 'demo-app-abc123', 'postgres://x',
    'https://github.com/usernode-bot/demo-app-abc123', { template, ...extra });
}
const file = (files, p) => {
  const found = files.find((f) => f.path === p);
  assert.ok(found, `${p} is generated`);
  return found.content;
};

test('the allow-list: four starters beside Empty, which is the default', () => {
  assert.deepEqual([...appTemplates.TEMPLATE_IDS], ['empty', ...STARTERS]);
  assert.equal(appTemplates.DEFAULT_TEMPLATE, 'empty');
  assert.equal(parseCreateOptions({ audience: 'solo' }).template, 'empty', 'absent is Empty');
  assert.equal(parseCreateOptions({ audience: 'solo', template: '' }).template, 'empty');
  assert.equal(parseCreateOptions({ audience: 'solo', template: null }).template, 'empty');
  for (const id of appTemplates.TEMPLATE_IDS) {
    assert.equal(parseCreateOptions({ audience: 'open', template: id }).template, id);
  }
  for (const bad of ['chess', 'EMPTY', 'game-2d ', '../game-2d', 'toString', '__proto__', 42, ['game-2d'], { id: 'game-2d' }]) {
    assert.match(parseCreateOptions({ audience: 'solo', template: bad }).error,
      /^template must be one of: empty, social-productivity, multimedia-social, game-2d, game-3d$/, String(bad));
  }
  // An import keeps its repository; Empty (or nothing) is still fine.
  assert.match(parseCreateOptions({ template: 'game-3d' }, { imported: true }).error, /import keeps its own repository/);
  assert.equal(parseCreateOptions({ template: 'empty' }, { imported: true }).template, 'empty');
  assert.equal(parseCreateOptions({}, { imported: true }).template, 'empty');
  // The route reads the import flag and the template from the same call.
  const route = fs.readFileSync(path.join(ROOT, 'src/routes/apps.js'), 'utf8');
  assert.match(route, /createOptions\.parseCreateOptions\(req\.body, \{ imported: !!repoUrl \}\)/);
  assert.match(route, /if \(template !== appTemplates\.DEFAULT_TEMPLATE\) \{\s*const \{ rows: templated \} = await pool\.query\(\s*`UPDATE apps SET template = \$1 WHERE id = \$2 RETURNING \*`/);
  assert.match(fs.readFileSync(path.join(ROOT, 'src/db/schema.sql'), 'utf8'),
    /ALTER TABLE apps ADD COLUMN IF NOT EXISTS template VARCHAR\(40\);/);
});

test('the create dialog offers the same starters, in the same words, as the server', () => {
  const { TEMPLATES } = loadTsx('frontend/src/features/dialogs/create-app.tsx');
  assert.deepEqual(TEMPLATES.map((t) => t.key), STARTERS, '"Start from scratch" is Empty');
  for (const t of TEMPLATES) {
    const server = appTemplates.get(t.key);
    assert.equal(t.title, server.title, t.key);
    assert.equal(t.caption, server.summary, t.key);
  }
});

test('Empty is the scaffold every project always got, byte for byte', () => {
  const plain = getTemplateFiles('Notes', 'notes-abc123', 'postgres://x', null, {});
  assert.deepEqual(getTemplateFiles('Notes', 'notes-abc123', 'postgres://x', null, { template: 'empty' }), plain);
  assert.deepEqual(getTemplateFiles('Notes', 'notes-abc123', 'postgres://x', null, { template: null }), plain);
  assert.ok(!plain.some((f) => f.path === 'api.js' || f.path === 'public/app.js'));
  const server = file(plain, 'server.js');
  // #4047: the scaffold ships no Press! demo any more — no demo endpoints
  // and no table; the starter screen is static. The server still listens.
  assert.doesNotMatch(server, /\/api\/press|\/api\/leaderboard|presses/);
  assert.match(server, /app\.listen\(port/);
  assert.doesNotMatch(server, /require\('\.\/api'\)/);
  assert.deepEqual(JSON.parse(file(plain, 'dapp.json')), { secrets: [] });
  // #4047: the welcome card opens with the app's thumbnail tile (no sketch,
  // no starter here, so the name's letter falls back the way the home tile
  // does).
  const emptyHtml = file(plain, 'public/index.html');
  assert.match(emptyHtml, /<div class="flex h-20 w-20 items-center justify-center rounded-2xl border border-line bg-ground text-title"><span class="text-muted">N<\/span><\/div>/);
  assert.doesNotMatch(emptyHtml, /Try the example|What's already working/);
  assert.throws(() => getTemplateFiles('Notes', 'notes', 'pg://x', null, { template: 'chess' }), /Unknown app template: chess/);
});

test('app-creator scaffolds from the row, so a Retry writes the same starter', () => {
  const creator = fs.readFileSync(path.join(ROOT, 'src/services/app-creator.js'), 'utf8');
  assert.match(creator, /function templateOf\(row\) \{\s*const t = row\?\.template;\s*return typeof t === 'string' && appTemplates\.isTemplate\(t\) \? t : appTemplates\.DEFAULT_TEMPLATE;/);
  assert.equal((creator.match(/template: templateOf\(appRow\)/g) || []).length, 2, 'both the GitHub and the local path');
});

for (const id of STARTERS) {
  test(`the ${id} starter generates a working repository`, () => {
    const meta = appTemplates.get(id);
    const files = generate(id);
    const paths = files.map((f) => f.path);
    assert.equal(new Set(paths).size, paths.length, 'no file is written twice');
    for (const p of appTemplates.REQUIRED_FILES) assert.ok(paths.includes(p), p);
    // The shared plumbing is still there, unchanged.
    for (const p of ['Dockerfile', 'package.json', 'package-lock.json', 'tailwind.config.js', 'styles/tailwind-input.css',
      '.claude/settings.json', '.claude/homeroom-canonical-repo', '.gitignore', '.dockerignore', 'project.toml']) {
      assert.deepEqual(file(files, p), file(generate('empty'), p), p);
    }

    for (const f of files) assert.doesNotMatch(f.content, /\{\{[A-Z_]+\}\}/, `${f.path}: every placeholder is filled`);

    const html = file(files, 'public/index.html');
    assert.match(html, /<title>Demo &lt;App&gt; &amp; &quot;co&quot;<\/title>/, 'the name is escaped');
    assert.match(html, /<h1[^>]*>Demo &lt;App&gt; &amp; &quot;co&quot;<\/h1>/);
    assert.match(html, /\/\/ usernode-dev-console@1/, 'the dev console forwarder');
    assert.match(html, /<script src="\/usernode-bridge\/v1\/bridge\.js"><\/script>/, 'the bridge, by relative path');
    assert.match(html, /<link rel="stylesheet" href="\/tailwind\.css">/, 'the precompiled stylesheet');
    assert.match(html, /window\.usernode && window\.usernode\.theme[\s\S]*usernode:theme-changed/, 'the platform theme');
    assert.match(html, /<!-- usernode-starter-notice@1[\s\S]*<!-- \/usernode-starter-notice@1 -->/);
    assert.match(html, /<script src="\/app\.js"><\/script>/);
    // Nothing from another origin: no CDN, no hostname.
    assert.doesNotMatch(html, /<(?:script|link)[^>]+(?:src|href)="(?:https?:)?\/\//);
    for (const p of ['public/index.html', 'public/app.js', 'api.js']) {
      assert.doesNotMatch(file(files, p), /cdn\.|unpkg\.com|jsdelivr/, `${p} loads nothing from a CDN`);
      assert.doesNotMatch(file(files, p), /—|&mdash;/, `${p}: no em dashes in copy`);
    }

    // The screen's script parses, and builds people's words with
    // textContent rather than innerHTML.
    const client = file(files, 'public/app.js');
    assert.doesNotThrow(() => new vm.Script(client, { filename: `${id}/public/app.js` }));
    assert.doesNotMatch(client, /\.innerHTML\s*=/);
    assert.match(client, /'x-usernode-token': token/, 'API calls carry the frame\'s token');

    // server.js mounts api.js behind the sign-in check and drains on SIGTERM.
    const server = file(files, 'server.js');
    assert.ok(server.indexOf("require('./api')") > server.indexOf('if (!req.user) return res.status(401)'),
      'api.js is mounted after the sign-in check');
    assert.match(server, /api\.routes\(app, pool\);/);
    assert.match(server, /await api\.migrate\(pool\);/);
    assert.match(server, /process\.on\('SIGTERM', \(\) => shutdown\('SIGTERM'\)\);/);
    assert.match(server, /process\.on\('SIGINT', \(\) => shutdown\('SIGINT'\)\);/);
    assert.match(server, /res\.status\(shuttingDown \? 503 : 200\)/, '/health says when it is leaving');
    assert.doesNotMatch(server, /presses/);
    assert.match(server, /return res\.redirect\(302, PLATFORM_ORIGIN \+ '\/app\/demo-app-abc123\/full' \+ deepPath\);/,
      'the share-link fallback names this app');

    const api = file(files, 'api.js');
    assert.match(api, /const IS_STAGING = process\.env\.USERNODE_ENV === 'staging';/);
    assert.match(api, /if \(IS_STAGING\) \{/, 'seeds only in staging');
    assert.match(api, /'staging-demo-/, 'seeded rows belong to an obviously fake identity');
    assert.doesNotMatch(api, /req\.user\.id[^\n]*staging/i, 'seeds never belong to the visitor');
    const mod = require(path.join(appTemplates.STARTERS_DIR, id, 'api.js'));
    assert.equal(typeof mod.migrate, 'function');
    assert.equal(typeof mod.routes, 'function');

    // dapp.json: the starter's icon and checks, kept by the platform's own
    // reader, every check anchored on something the screen has.
    const dapp = JSON.parse(file(files, 'dapp.json'));
    assert.deepEqual(Object.keys(dapp), ['icon', 'secrets', 'tests']);
    assert.deepEqual(dapp.secrets, []);
    assert.equal(appManifest.readIcon(dapp).emoji, meta.icon);
    const read = appManifest.readTests(dapp);
    assert.equal(read.length, meta.tests.length, 'no declared check is dropped');
    assert.equal(read.filter((t) => t.visual).length, 1, 'one representative visual flow');
    const screen = html + client;
    for (const t of read) {
      assert.equal(t.path, '/');
      for (const anchor of t.expectSelector.match(/#[a-z][\w-]*|\[data-[\w-]+/g)) {
        const name = anchor.startsWith('#') ? `id="${anchor.slice(1)}"` : anchor.slice(1);
        assert.ok(screen.includes(name) || client.includes(`'${anchor.slice(1)}'`),
          `${t.name}: ${anchor} is on the starter's screen`);
      }
    }

    // README and CLAUDE.md describe the starter, not the Press! example.
    const readme = file(files, 'README.md');
    assert.match(readme, new RegExp(`from\\n?> ?the \\*\\*${meta.title}\\*\\* template`));
    for (const f of meta.features) assert.ok(readme.includes(`- ${f}`), f);
    const claude = file(files, 'CLAUDE.md');
    assert.match(claude, new RegExp(`## Starter template: ${meta.title}`));
    assert.doesNotMatch(claude, /Press!|presses/);
    assert.match(claude, /\/claude\.md/, 'still points at the platform conventions');
  });
}

test('a starter carries the creator\'s line and rule into its dapp.json like Empty does', () => {
  const dapp = JSON.parse(file(generate('game-2d', {
    description: 'Catch stars together',
    governance: { approverPolicy: 'invited', approvalsRequired: 2 },
  }), 'dapp.json'));
  assert.deepEqual(Object.keys(dapp), ['description', 'icon', 'secrets', 'governance', 'tests']);
  assert.equal(dapp.description, 'Catch stars together');
  assert.deepEqual(appManifest.readGovernance(dapp), { approvers: 'invited', approvals: 2 });
});

test('the starters live outside src/, where the SQL lint would read their queries as the platform\'s', () => {
  assert.equal(appTemplates.STARTERS_DIR, path.join(ROOT, 'app-templates'));
  assert.deepEqual(fs.readdirSync(appTemplates.STARTERS_DIR).sort(), [...STARTERS].sort(),
    'one directory per starter, and nothing else');
  // The platform's own Tailwind build does not scan them either: their
  // classes compile in the generated app's build, not the shell's.
  const tw = fs.readFileSync(path.join(ROOT, 'tailwind.config.js'), 'utf8');
  assert.doesNotMatch(tw, /app-templates/);
});

test('the games keep to the content rules: no combat, no weapons; the feed keeps a way to report', () => {
  for (const id of ['game-2d', 'game-3d']) {
    const words = generate(id).filter((f) => /public\/|README/.test(f.path)).map((f) => f.content).join('\n');
    assert.doesNotMatch(words, /\b(shoot|gun|weapon|kill|enemy|attack|bullet|bomb|blood)\w*/i, id);
  }
  const feed = generate('multimedia-social');
  assert.match(file(feed, 'api.js'), /app\.post\('\/api\/posts\/:id\/report'/);
  assert.match(file(feed, 'public/app.js'), /'Report'/);
});
