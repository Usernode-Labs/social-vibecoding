// Ready-made apps' prebuilt images (src/services/starter-images.js).
//
// City Tier List (newcomer run, 20 Oct 2026) took 32.2 s from Make it to
// live, 19.1 s of it building an image of code every city tier list shares.
// Each ready-made app's image is now built ahead, on the platform, and a new
// project deploys it. What this pins:
//
//   1. The generated code is the same for every project made from one
//      ready-made app: no name or slug in what the image is built from, so
//      two projects get one key, and two templates two.
//   2. The name and slug reach the app at runtime: USERNODE_APP_NAME and
//      USERNODE_APP_SLUG, in every container's env, reserved, and value-exempt
//      in a preview's env fingerprint; server.js fills the page from them.
//   3. A new project deploys the ready image under its own key, waits for one
//      being built, and otherwise builds as before.
//   4. The leader builds them ahead (never on a person's first project), not
//      in a staging preview, and Admin > Templates shows them, with Rebuild.
//
// Run with: node --test tests/starter-images.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const starterImages = require('../src/services/starter-images');
const { getTemplateFiles } = require('../src/services/template');
const appTemplates = require('../src/services/app-templates');

const K8S = { appRuntime: 'kubernetes', kubernetes: { buildEngine: 'auto', buildkitImage: 'moby/buildkit:test', buildkitMode: 'rootless' } };
const recipe = starterImages.buildRecipe(K8S);
const SKETCH = { design: { emoji: '🏙️', tagline: 'Where we would live', palette: ['#111111'] } };

// ── 1. One key per ready-made app ────────────────────────────────────────

test('two projects made from one ready-made app get one key, whatever they are called', () => {
  const a = getTemplateFiles('City Tier List', 'city-tier-list-1e2a43', null, 'https://github.com/usernode-bot/city-tier-list-1e2a43', {
    template: 'tier-list-cities', description: 'A city tier list', governance: { approverPolicy: 'anyone', approvalsRequired: null },
  });
  const b = getTemplateFiles('Best <Cities> & "Towns"', 'best-cities-ab12cd', null, 'https://github.com/usernode-bot/best-cities-ab12cd', {
    template: 'tier-list-cities', description: 'Where we go next', sketch: SKETCH,
    governance: { approverPolicy: 'creator', approvalsRequired: 2 },
  });
  const key = starterImages.contextKey(a, recipe);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(starterImages.contextKey(b, recipe), key);
  // The key the leader builds under is the one a new project computes.
  const built = starterImages.currentTrees(K8S).find((t) => t.id === 'tier-list-cities');
  assert.equal(built.key, key);
});

test('what is in the image names no project: no name, no slug', () => {
  const files = getTemplateFiles('Zebra Quokka Club', 'zebra-quokka-club-9f9f9f', null, 'https://github.com/usernode-bot/zebra-quokka-club-9f9f9f', {
    template: 'tier-list-cities', description: 'Zebra quokka description', sketch: SKETCH,
  });
  const inImage = starterImages.imageFiles(files);
  for (const f of inImage) {
    assert.doesNotMatch(String(f.content), /Zebra|Quokka|zebra-quokka|9f9f9f/i, `${f.path} names the project`);
  }
  // The files that do name it stay out of the image.
  const paths = inImage.map((f) => f.path);
  for (const repoOnly of ['README.md', 'CLAUDE.md', 'LICENSE', 'dapp.json']) {
    assert.ok(files.some((f) => f.path === repoOnly), `${repoOnly} is still committed`);
    assert.ok(!paths.includes(repoOnly), `${repoOnly} is not in the image`);
  }
  assert.ok(!paths.some((p) => p.startsWith('.claude/') || p.startsWith('design/')));
  assert.ok(paths.includes('server.js') && paths.includes('public/index.html') && paths.includes('Dockerfile'));
});

test('each ready-made app has a key of its own, and any change to its image moves it', () => {
  const trees = starterImages.currentTrees(K8S);
  assert.equal(trees.length, appTemplates.READY_IDS.length);
  const keys = trees.map((t) => t.key);
  assert.ok(keys.every((k) => /^[a-f0-9]{64}$/.test(k)), 'every ready-made app is shared');
  assert.equal(new Set(keys).size, keys.length, 'two templates never share a key');
  const files = trees[0].files;
  const changed = files.map((f) => (f.path === 'public/app.js' ? { ...f, content: `${f.content}\n// changed` } : f));
  assert.notEqual(starterImages.contextKey(changed, recipe), trees[0].key);
  // How it is built is part of the key too.
  assert.notEqual(starterImages.contextKey(files, starterImages.buildRecipe({ appRuntime: 'docker' })), trees[0].key);
});

test('a .dockerignore Docker would read differently is not shared', () => {
  const files = [{ path: '.dockerignore', content: 'node_modules\n!keep.txt\n' }, { path: 'a.js', content: '1' }];
  assert.equal(starterImages.imageFiles(files), null);
  assert.equal(starterImages.contextKey(files, recipe), null);
  const plain = starterImages.imageFiles([{ path: '.dockerignore', content: '.env.*\ndesign\n' }, { path: '.env.local', content: 'x' }, { path: 'design/sketch.json', content: '{}' }, { path: 'designs.txt', content: 'y' }]);
  assert.deepEqual(plain.map((f) => f.path), ['.dockerignore', 'designs.txt']);
});

// ── 2. The name and slug at runtime ──────────────────────────────────────

test('a starter page keeps {{APP_NAME}}, and server.js fills it in, escaped', () => {
  const files = getTemplateFiles('Ignored Name', 'ignored-name-123456', null, null, { template: 'tier-list-cities' });
  const page = files.find((f) => f.path === 'public/index.html').content;
  assert.match(page, /<title>\{\{APP_NAME\}\}<\/title>/);
  const server = files.find((f) => f.path === 'server.js').content;
  assert.doesNotMatch(server, /ignored-name-123456|Ignored Name/);
  assert.match(server, /const APP_SLUG = process\.env\.USERNODE_APP_SLUG \|\| '';/);
  assert.match(server, /const APP_NAME = process\.env\.USERNODE_APP_NAME \|\| "City tier list";/);
  assert.match(server, /app\.use\(express\.static\(path\.join\(__dirname, 'public'\), \{ index: false \}\)\);/);

  // Run the page block: '/' answers the page with the name filled in.
  const block = server.slice(server.indexOf("const fs = require('fs');"), server.indexOf("app.use(express.static"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starter-page-'));
  fs.mkdirSync(path.join(dir, 'public'));
  fs.writeFileSync(path.join(dir, 'public', 'index.html'), page);
  const routes = {};
  vm.runInNewContext(block, {
    require, path, __dirname: dir,
    process: { env: { USERNODE_APP_NAME: 'Cities <we> "love" & more' } },
    app: { get: (paths, handler) => { for (const p of paths) routes[p] = handler; } },
  });
  let sent = null;
  let type = null;
  routes['/']({}, { type(t) { type = t; return this; }, send(body) { sent = body; return this; } });
  assert.equal(type, 'html');
  assert.match(sent, /<title>Cities &lt;we&gt; &quot;love&quot; &amp; more<\/title>/);
  assert.doesNotMatch(sent, /\{\{APP_NAME\}\}/);
  assert.equal(typeof routes['/index.html'], 'function');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('every generated app links to its platform page by USERNODE_APP_SLUG, not a written-in slug', () => {
  const empty = getTemplateFiles('Plain', 'plain-abcdef', null, null, {}).find((f) => f.path === 'server.js').content;
  assert.doesNotMatch(empty, /plain-abcdef/);
  assert.match(empty, /const appPath = APP_SLUG \? '\/app\/' \+ encodeURIComponent\(APP_SLUG\) \+ '\/full' \+ deepPath : '';/);
  assert.match(empty, /return res\.redirect\(302, PLATFORM_ORIGIN \+ appPath\);/);
  // The empty scaffold's page is its own and still names the project.
  assert.match(empty, /res\.sendFile\(path\.join\(__dirname, 'public', 'index\.html'\)\);/);
});

test('every container env carries the slug and name, reserved and value-exempt', () => {
  const { appIdentityEnv } = require('../src/services/app-identity-env');
  const env = appIdentityEnv({ id: 9, slug: 'city-tier-list-1e2a43', name: 'City Tier List' }, { iframeJwtPublicKey: 'PEM' });
  assert.equal(env.USERNODE_APP_SLUG, 'city-tier-list-1e2a43');
  assert.equal(env.USERNODE_APP_NAME, 'City Tier List');
  // Always both names, so every builder's env has one shape.
  const bare = appIdentityEnv({ id: 9 }, { iframeJwtPublicKey: 'PEM' });
  assert.equal(bare.USERNODE_APP_SLUG, '');
  assert.equal(bare.USERNODE_APP_NAME, '');
  const { RESERVED_KEYS } = require('../src/services/app-manifest');
  assert.ok(RESERVED_KEYS.has('USERNODE_APP_SLUG') && RESERVED_KEYS.has('USERNODE_APP_NAME'));
  const stagingEnv = require('../src/services/staging-env');
  stagingEnv._resetExpected();
  const preview = stagingEnv.envFingerprint(stagingEnv.platformStagingEnv({ id: 42, slug: 'some-app-123abc', name: 'Some App' }));
  assert.equal(preview, stagingEnv.expectedStagingFingerprint(), 'a preview of any app matches the expected digest');
  stagingEnv._resetExpected();
  // A new project's env names it (its first deploy is every deploy's,
  // staging.deployProduction); the boot respawn reads its name.
  assert.match(read('src/services/staging.js'), /\.\.\.appIdentityEnv\(app, config\),/);
  assert.match(read('src/db/migrate.js'), /`SELECT id, slug, name, container_id, manifest_snapshot, db_password, status, self_hosted/);
});

// ── 3. A new project ─────────────────────────────────────────────────────

function fakePool(script) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return script(sql, params, calls.length);
    },
  };
}

test('a new project deploys the ready image under its key', async () => {
  const pool = fakePool((sql) => (/image_ref IS NOT NULL/.test(sql)
    ? { rows: [{ template: 'tier-list-cities', context_key: 'k'.repeat(64), image_ref: 'reg/homeroom-starter-tier-list-cities@sha256:abc', build_ref: 'social-buildkit/bk-1', engine: 'buildkit' }] }
    : { rows: [] }));
  const got = await starterImages.imageFor(K8S, pool, { key: 'k'.repeat(64), slug: 'city-tier-list-1e2a43' });
  assert.equal(got.imageRef, 'reg/homeroom-starter-tier-list-cities@sha256:abc');
  assert.equal(got.buildRef, 'social-buildkit/bk-1');
  assert.equal(got.reused, true);
  assert.deepEqual({ ...got.prebuilt, waitedMs: 0 }, { template: 'tier-list-cities', key: 'kkkkkkkkkkkk', waitedMs: 0 });
});

test('it waits for an image being built, and builds its own when none comes or none is coming', async () => {
  let clock = 0;
  const now = () => clock;
  // Being built, ready on the third look.
  let looks = 0;
  const pool = fakePool((sql) => {
    if (/image_ref IS NOT NULL/.test(sql)) {
      looks += 1;
      return { rows: looks >= 3 ? [{ template: 't', image_ref: 'img@sha256:1', build_ref: null, engine: 'buildkit' }] : [] };
    }
    // A build of it under way: the clock's target, queued or running.
    if (/FROM wf_work/.test(sql)) { clock += 1000; return { rows: [{ key: 'a'.repeat(64) }] }; }
    return { rows: [] };
  });
  const got = await starterImages.imageFor(K8S, pool, { key: 'a'.repeat(64), slug: 's' }, { pollMs: 1, now });
  assert.equal(got.imageRef, 'img@sha256:1');
  assert.ok(got.prebuilt.waitedMs > 0);
  // Never longer than waitMs.
  clock = 0;
  const forever = fakePool((sql) => {
    if (/FROM wf_work/.test(sql)) { clock += 30000; return { rows: [{ key: 'a'.repeat(64) }] }; }
    return { rows: [] };
  });
  assert.equal(await starterImages.imageFor(K8S, forever, { key: 'a'.repeat(64), slug: 's' }, { pollMs: 1, now, waitMs: 60000 }), null);
  // Queued, failed or none at all: no wait.
  const idle = fakePool(() => ({ rows: [] }));
  assert.equal(await starterImages.imageFor(K8S, idle, { key: 'a'.repeat(64), slug: 's' }, { pollMs: 1 }), null);
  assert.equal(idle.calls.length, 2, 'one look for an image, one for a build under way');
  // A lookup that fails is a build, never a failed creation.
  const broken = { query: async () => { throw new Error('db down'); } };
  assert.equal(await starterImages.imageFor(K8S, broken, { key: 'a'.repeat(64), slug: 's' }), null);
  assert.equal(await starterImages.imageFor(K8S, idle, { key: null, slug: 's' }), null);
});

test('a ready-made app\'s first deploy looks for an image only for the starter commit its setup just made', () => {
  const creator = read('src/services/app-creator.js');
  assert.match(creator, /const key = appTemplates\.isReadyMade\(template\) \? starterImages\.contextKey\(files, starterImages\.buildRecipe\(config\)\) : null;/);
  assert.match(creator, /offer: sha \? \{ starter: \{ sha, template, \.\.\.\(key \? \{ key \} : \{\}\) \} \} : null/);
  const deploy = read('src/services/staging.js');
  // Only the exact commit (tests/first-deploy.test.js runs it).
  assert.match(deploy, /const starter = options\.starter && mainSha && String\(options\.starter\.sha \|\| ''\)\.toLowerCase\(\) === String\(mainSha\)\.toLowerCase\(\)/);
  assert.match(deploy, /if \(!build && starter\?\.key\) \{\s+build = await require\('\.\/starter-images'\)\.imageFor\(config, prodPool, \{ key: starter\.key, slug: app\.slug \}\);/);
  assert.match(deploy, /engine: build\.prebuilt \? 'prebuilt' :/);
  const timing = require('../src/services/app-creation-timing');
  const note = timing.buildNote({ engine: 'prebuilt', result: { reused: true, prebuilt: { template: 'tier-list-cities', key: 'abcdefabcdef', waitedMs: 1200.4 } } });
  assert.deepEqual(note, { engine: 'prebuilt', reused: true, prebuilt: { template: 'tier-list-cities', key: 'abcdefabcdef', waitedMs: 1200 } });
});

// ── 4. Built ahead ───────────────────────────────────────────────────────

test('a clock only the newest build runs builds them ahead, each key a target, and not in a staging preview', () => {
  const clocks = read('src/workflow/clock/services.ts');
  assert.match(clocks, /name: 'starter-images', everyMs: MIN, newestOnly: true,/);
  assert.match(clocks, /legacy\('services\/starter-images'\)\.targets\(config, pool\)/);
  assert.match(clocks, /legacy\('services\/starter-images'\)\.buildTarget\(config, pool, ctx\.input\.input\)/);
  assert.ok(!read('server.js').includes("require('./src/services/starter-images').start"), 'no leader builds them');
  assert.equal(starterImages.prebuildsOn({}), true);
  assert.equal(starterImages.prebuildsOn({ USERNODE_ENV: 'staging' }), false);
  assert.equal(starterImages.prebuildsOn({ STARTER_PREBUILDS: 'off' }), false);
  // Owed a build: queued, a failure whose wait is over (a few times at
  // most), or one marked building whose build stopped with its process (the
  // clock gives one still running no second item).
  const src = read('src/services/starter-images.js');
  assert.match(src, /AND \(status IN \('queued', 'building'\)\s+OR \(status = 'failed' AND attempts < \$3/);
  assert.doesNotMatch(src, /heartbeat_at|owner = 'workflow'|owner IS DISTINCT/, 'no lease of its own, nor a wait for a builder from before the clock: the clock\'s target is the one builder');
  // The build is the starter as generated: it writes the shared layer cache.
  assert.match(src, /starterTree: true,/);
  // Its source is a commit with no parent, on the template's own branch.
  assert.match(src, /github\.createRootCommit\(owner, SOURCE_REPO, t\.files/);
  assert.match(read('src/db/schema.sql'), /CREATE TABLE IF NOT EXISTS starter_images \(/);
});

test('Admin > Templates lists every ready-made app, with Rebuild for writers', () => {
  const consoleJs = read('frontend/src/features/admin/admin-console.js');
  assert.match(consoleJs, /\{ key: 'templates', label: 'Templates', group: 'Platform' \},/);
  assert.match(consoleJs, /templates: 'AdminTemplates',/);
  assert.match(consoleJs, /'templates': '<svg /);
  assert.match(read('frontend/src/features/admin/sections.ts'), /import '\.\/admin-templates\.tsx';/);
  assert.match(read('scripts/audit-react-ownership.mjs'), /\{ sel: '#admin-section-content', when: '#admin\/templates' \}/);
  const routes = read('src/routes/admin.js');
  assert.match(routes, /router\.get\('\/api\/admin\/templates', async/);
  assert.match(routes, /router\.post\('\/api\/admin\/templates\/:id\/rebuild', requireAdminWrite, async/);
  const section = read('frontend/src/features/admin/admin-templates.tsx');
  assert.match(section, /data-template-rebuild=\{t\.id\}/);
  assert.match(section, /\{canWrite && t\.key \? \(/);
  // The staging demo: the real templates, made-up states, written nowhere.
  const demo = starterImages.demoList(K8S, Date.parse('2026-10-20T10:00:00Z'));
  assert.equal(demo.demo, true);
  assert.deepEqual(demo.templates.map((t) => t.id), appTemplates.READY_IDS);
  assert.ok(demo.templates.some((t) => t.status === 'failed' && t.error));
  assert.ok(demo.templates.some((t) => t.status === 'ready' && /@sha256:[a-f0-9]{64}$/.test(t.imageRef)));
});
