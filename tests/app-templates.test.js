'use strict';

// App templates (#3521): a new project starts from Empty, the scaffold every
// project always got, or from one of Homeroom's ready-made apps. The four
// general starters (social productivity, multimedia social, a 2D game and a
// 3D game) were deleted with the create dialog that offered them. What came
// back (Evan, 8 October 2026) are apps finished enough that a project made
// from one needs nothing built: the make screen's eight choices that need no
// typing (frontend/src/features/first-session/examples.ts; the make screen's
// side is tests/first-session-make.test.js).
//
// What is pinned here, without a database (tests/app-templates-postgres
// .test.js runs each one):
//
//   1. THE ALLOW-LIST. POST /api/apps takes `template` from
//      services/app-templates.js's TEMPLATE_IDS and nothing else: `empty`
//      and the eight ready-made apps; absent is `empty`; a deleted starter's
//      id is refused, not swapped.
//   2. EMPTY IS THE DEFAULT. Absent and `empty` write exactly the same
//      files (#4047 dropped the scaffold's Press! demo, so "always got" is
//      the static welcome screen, not the old one).
//   3. A ROW FROM A DELETED STARTER RETRIES AS EMPTY: app-creator reads an
//      id no longer on the list as the default.
//   4. EVERY READY-MADE APP is a whole repository on the platform's
//      conventions and the new app's design kit: its files, the entry's
//      fill escaped where it lands, the bridge, the theme, no CDN, its own
//      declared checks resolving against its own screen.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appTemplates = require('../src/services/app-templates');
const { parseCreateOptions } = require('../src/services/create-options');
const { getTemplateFiles } = require('../src/services/template');
const appManifest = require('../src/services/app-manifest');

const ROOT = path.join(__dirname, '..');
// The app frame's sandbox flags, read from the source the shell builds from.
const APP_FRAME_SANDBOX = /APP_FRAME_SANDBOX =\s*'([^']+)'/.exec(
  fs.readFileSync(path.join(__dirname, '..', 'frontend/src/features/app-frame/app-frame-policy.js'), 'utf8'))[1];
const DELETED = ['social-productivity', 'multimedia-social', 'game-2d', 'game-3d'];
const READY = [
  'tier-list-restaurants', 'tier-list-hikes', 'tier-list-cities', 'tier-list-games',
  'grocery-list', 'chore-list', 'lending-library', 'potluck-planner',
];

const file = (files, p) => {
  const found = files.find((f) => f.path === p);
  assert.ok(found, `${p} is generated`);
  return found.content;
};

const generate = (id, name = 'Demo App') => getTemplateFiles(name, 'demo-app-abc123', 'postgres://x', null, { template: id });

test('the allow-list: Empty, the default, and the eight ready-made apps; a deleted starter is refused', () => {
  assert.deepEqual([...appTemplates.TEMPLATE_IDS], ['empty', ...READY]);
  assert.deepEqual([...appTemplates.READY_IDS], READY);
  assert.equal(appTemplates.DEFAULT_TEMPLATE, 'empty');
  assert.equal(parseCreateOptions({ audience: 'solo' }).template, 'empty', 'absent is Empty');
  assert.equal(parseCreateOptions({ audience: 'solo', template: '' }).template, 'empty');
  assert.equal(parseCreateOptions({ audience: 'solo', template: null }).template, 'empty');
  assert.equal(parseCreateOptions({ audience: 'open', template: 'empty' }).template, 'empty');
  for (const id of READY) assert.equal(parseCreateOptions({ audience: 'invited', template: id }).template, id);
  const refusal = new RegExp(`^template must be one of: ${['empty', ...READY].join(', ')}$`);
  for (const bad of [...DELETED, 'chess', 'EMPTY', 'tier-list', '../game-2d', 'toString', '__proto__', 42, ['game-2d'], { id: 'game-2d' }]) {
    assert.match(parseCreateOptions({ audience: 'solo', template: bad }).error, refusal, String(bad));
  }
  for (const id of DELETED) assert.equal(appTemplates.get(id), null, id);
  // `tier-list` is a directory four entries share, not an entry of its own.
  assert.equal(appTemplates.isTemplate('tier-list'), false);
  // An import keeps its repository: Empty (or nothing) is fine, a ready-made app is not.
  assert.equal(parseCreateOptions({ template: 'empty' }, { imported: true }).template, 'empty');
  assert.equal(parseCreateOptions({}, { imported: true }).template, 'empty');
  assert.match(parseCreateOptions({ template: 'grocery-list' }, { imported: true }).error, /cannot start from a template/);
  // The route reads the import flag and the template from the same call.
  const route = fs.readFileSync(path.join(ROOT, 'src/routes/apps.js'), 'utf8');
  assert.match(route, /createOptions\.parseCreateOptions\(req\.body, \{ imported: !!repoUrl \}\)/);
  assert.match(fs.readFileSync(path.join(ROOT, 'src/db/schema.sql'), 'utf8'),
    /ALTER TABLE apps ADD COLUMN IF NOT EXISTS template VARCHAR\(40\);/);
  for (const id of appTemplates.TEMPLATE_IDS) assert.ok(id.length <= 40, `${id} fits apps.template`);
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

test('app-creator scaffolds from the row, and a deleted starter\'s row retries as Empty', () => {
  const creator = fs.readFileSync(path.join(ROOT, 'src/services/app-creator.js'), 'utf8');
  assert.match(creator, /function templateOf\(row\) \{\s*const t = row\?\.template;\s*return typeof t === 'string' && appTemplates\.isTemplate\(t\) \? t : appTemplates\.DEFAULT_TEMPLATE;/);
  assert.equal((creator.match(/template: templateOf\(appRow\)/g) || []).length, 2, 'both the GitHub and the local path');
  // What templateOf answers for a project made from a starter before they went.
  for (const id of DELETED) assert.equal(appTemplates.isTemplate(id), false, id);
});

test('each ready-made app is a directory of its own files; the four tier lists share one', () => {
  assert.equal(appTemplates.STARTERS_DIR, path.join(ROOT, 'app-templates'));
  assert.deepEqual(appTemplates.starterFiles('empty'), []);
  for (const id of DELETED) assert.deepEqual(appTemplates.starterFiles(id), [], id);
  const dirs = new Set(READY.map((id) => appTemplates.dirOf(id)));
  assert.deepEqual([...dirs].sort(), ['chore-list', 'grocery-list', 'lending-library', 'potluck-planner', 'tier-list']);
  assert.deepEqual(fs.readdirSync(appTemplates.STARTERS_DIR).sort(), [...dirs].sort(), 'no directory that no entry uses');
  for (const dir of dirs) {
    for (const rel of appTemplates.REQUIRED_FILES) {
      assert.ok(fs.existsSync(path.join(appTemplates.STARTERS_DIR, dir, rel)), `${dir}/${rel}`);
    }
  }
  for (const id of READY) {
    const t = appTemplates.get(id);
    assert.equal(t.ready, true, id);
    assert.equal(appTemplates.isReadyMade(id), true, id);
    for (const k of ['title', 'summary', 'icon', 'tables']) assert.ok(t[k], `${id}.${k}`);
    assert.ok(t.features.length >= 3, `${id} says what it already does`);
  }
  assert.equal(appTemplates.isReadyMade('empty'), false, 'Empty is built by its first version');
  // The tier lists: one app, what it ranks filled in.
  for (const id of READY.slice(0, 4)) {
    const t = appTemplates.get(id);
    assert.equal(t.dir, 'tier-list');
    assert.deepEqual(Object.keys(t.fill).sort(), ['ITEM_EXAMPLE', 'ITEM_ONE', 'ITEM_PLURAL']);
    assert.match(t.fill.ITEM_EXAMPLE, /^e\.g\. /, 'the add field\'s placeholder is an example that says so');
  }
  // The platform's own build never reads the starters.
  for (const f of ['Dockerfile', 'tailwind.config.js', '.dockerignore']) {
    if (fs.existsSync(path.join(ROOT, f))) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), /app-templates/, f);
  }
});

test('a tier list ranks what its entry says, escaped where it lands, and its script reads none of it', () => {
  const hikes = generate('tier-list-hikes');
  const html = file(hikes, 'public/index.html');
  assert.match(html, /Our favorite hikes, ranked together\./);
  assert.match(html, /<label for="add-name" class="section-label mb-0">Add a hike<\/label>/);
  assert.match(html, /placeholder="e\.g\. the lake loop"/);
  assert.match(html, /<p class="text-heading">No hikes yet<\/p>/);
  assert.doesNotMatch(file(generate('tier-list-cities'), 'public/index.html'), /hike/);
  // The fill is the entry's, never the maker's, but it is escaped all the same,
  // like the name.
  const odd = getTemplateFiles('A <b>"Best"</b> & co', 'x', 'postgres://x', null, { template: 'tier-list-games' });
  const oddHtml = file(odd, 'public/index.html');
  assert.match(oddHtml, /<title>A &lt;b&gt;&quot;Best&quot;&lt;\/b&gt; &amp; co<\/title>/);
  assert.doesNotMatch(oddHtml, /<b>"Best"/);
  for (const id of READY) {
    for (const f of generate(id)) assert.doesNotMatch(f.content, /\{\{[A-Z_]+\}\}/, `${id}: ${f.path} has every placeholder filled`);
  }
  const script = fs.readFileSync(path.join(appTemplates.STARTERS_DIR, 'tier-list/public/app.js'), 'utf8');
  assert.doesNotMatch(script, /\{\{/, 'the script is the same for every tier list');
});

for (const id of READY) {
  test(`the ${id} app is a whole repository on the platform's conventions`, () => {
    const files = generate(id);
    const html = file(files, 'public/index.html');
    const script = file(files, 'public/app.js');
    const api = file(files, 'api.js');
    // The screen: forwarder, precompiled Tailwind, the bridge by relative
    // path, the viewer's theme, its own script last.
    assert.match(html, /usernode-dev-console@1/);
    assert.match(html, /<link rel="stylesheet" href="\/tailwind\.css">/);
    assert.match(html, /<script src="\/usernode-bridge\/v1\/bridge\.js"><\/script>/);
    assert.match(html, /window\.usernode && window\.usernode\.theme/);
    assert.match(html, /<script src="\/app\.js"><\/script>\s*<\/body>/);
    assert.match(html, /<title>Demo App<\/title>/);
    assert.match(html, /<h1 class="text-title">Demo App<\/h1>/);
    // No CDN: every script and stylesheet is the app's own or the platform's, by path.
    for (const m of html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)) {
      assert.ok(m[1].startsWith('/') || m[1].startsWith('data:'), `${id}: ${m[1]} is not fetched from another origin`);
    }
    // A ready-made app is the app: no "started from a template" notice to delete.
    assert.doesNotMatch(html, /usernode-starter-notice@1/);
    // Its script: plain DOM, people's words as text, the platform's token on every call.
    assert.doesNotThrow(() => new vm.Script(script), `${id}: app.js parses`);
    assert.doesNotMatch(script, /\.innerHTML\s*=|insertAdjacentHTML|document\.write/);
    assert.match(script, /var headers = \{ 'x-usernode-token': token \};/);
    assert.match(script, /if \(window\.usernode && window\.usernode\.previewNow\) headers\['x-usernode-now'\] = window\.usernode\.now\(\)\.toISOString\(\);/);
    assert.match(script, /\b\w+\.error === 'account_required'/, 'a guest\'s write is asked to make an account, not shown a code');
    // Homeroom's app frame allows no dialogs (no allow-modals), so confirm()
    // answers false unseen and the action never happens: ask in the page.
    assert.doesNotMatch(APP_FRAME_SANDBOX, /allow-modals/);
    assert.doesNotMatch(script.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), /\b(?:confirm|alert|prompt)\(/, `${id}: no browser dialogs`);
    // Its server half: mounted after the sign-in check, tables on boot,
    // staging rows only in staging and owned by fake identities, now from req.now.
    assert.doesNotThrow(() => new vm.Script(`(function (module, require, process) {${api}\n})`), `${id}: api.js parses`);
    assert.match(api, /module\.exports = \{ migrate, routes \};/);
    assert.match(api, /const IS_STAGING = process\.env\.USERNODE_ENV === 'staging';/);
    assert.match(api, /if \(IS_STAGING\) \{[\s\S]*'staging-demo-user'/);
    assert.match(api, /'Staging demo /, 'seeded rows say so');
    assert.doesNotMatch(api.replace(/\/\/.*$/gm, ''), /new Date\(\)/, 'now is req.now, not the server clock');
    assert.doesNotMatch(api, /err\.message \}\)/, 'a failure is logged, not sent to the screen');
    const server = file(files, 'server.js');
    assert.ok(server.indexOf("const api = require('./api');") > server.indexOf('app.use((req, res, next) => {'), 'after the sign-in check');
    assert.match(server, /await api\.migrate\(pool\);/);
    assert.match(server, /process\.on\('SIGTERM', \(\) => shutdown\('SIGTERM'\)\);/);
    // Its manifest: the entry's icon and checks; its README and notes say what it is.
    const t = appTemplates.get(id);
    const manifest = JSON.parse(file(files, 'dapp.json'));
    assert.deepEqual(manifest.icon, { emoji: t.icon });
    assert.deepEqual(manifest.tests, JSON.parse(JSON.stringify(t.tests)));
    const readme = file(files, 'README.md');
    assert.match(readme, new RegExp(`ready-made\\s+> \\*\\*${t.title}\\*\\*`));
    for (const f of t.features) assert.ok(readme.includes(`- ${f}`), `${id}: README lists "${f.slice(0, 30)}"`);
    const claude = file(files, 'CLAUDE.md').replace(/\s+/g, ' ');
    assert.match(claude, new RegExp(`created from Homeroom's ready-made \\*\\*${t.title}\\*\\*`));
    assert.ok(claude.includes(`(${t.tables})`), `${id}: its tables are named`);
    // No em dashes in what the app says or what its notes say about it.
    for (const f of appTemplates.starterFiles(id)) assert.doesNotMatch(f.content, /\u2014/, `${id}: ${f.path}`);
    assert.doesNotMatch(JSON.stringify(t), /\u2014/);
  });

  test(`the ${id} app is drawn with the design kit only`, () => {
    const own = appTemplates.starterFiles(id).filter((f) => /^public\//.test(f.path));
    const src = own.map((f) => f.content.replace(/<!--[\s\S]*?-->/g, '')).join('\n');
    assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b(?!['"]?\))/, 'no raw hex colour');
    const stock = /(?<![\w:/-])(?:[a-z]+:)*(?:bg|text|border|ring|divide|from|via|to|accent|fill|stroke)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g;
    assert.deepEqual([...src.matchAll(stock)].map((m) => m[0]), [], 'colour comes from the kit\'s tokens, never a stock palette class');
    assert.doesNotMatch(src, /\bdark:/, 'the tokens carry both looks');
    assert.doesNotMatch(src, /\buppercase\b|\btracking-/, 'no uppercase eyebrows');
    assert.match(src, /class="min-h-screen bg-ground text-fg"/);
    // Honest states: loading shapes, an error with Retry, an empty state.
    assert.match(src, /class="skeleton /);
    assert.match(src, /class="state-error card"[\s\S]*?>Retry<\/button>/);
    assert.match(src, /class="state-empty card"/);
  });

  test(`the ${id} app's declared checks are valid and select its own screen`, () => {
    const t = appTemplates.get(id);
    const parsed = appManifest.readTests({ tests: t.tests });
    assert.equal(parsed.length, t.tests.length, 'every check survives the manifest\'s own validation');
    const visual = parsed.filter((c) => c.visual);
    assert.equal(visual.length, 1, 'one visual flow its first proposals are compared on');
    assert.ok(visual[0].impact.length, 'with the files that change it');
    const own = appTemplates.starterFiles(id);
    const src = own.filter((f) => /^public\//.test(f.path)).map((f) => f.content).join('\n');
    for (const c of parsed) {
      for (const [, name] of c.expectSelector.matchAll(/#([\w-]+)/g)) assert.match(src, new RegExp(`id="${name}"|'${name}'`), `${id}: #${name}`);
      for (const [, attr] of c.expectSelector.matchAll(/\[(data-[\w-]+)/g)) assert.ok(src.includes(attr), `${id}: [${attr}]`);
    }
    // Each is reached on a staging preview through seeded rows: the API
    // seeds ids the screen draws.
    assert.match(own.find((f) => f.path === 'api.js').content, /VALUES\s*\(900001,/);
  });
}
