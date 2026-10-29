'use strict';

// The ready-made originals and the versions made from them
// (src/services/originals.js, docs/plans/versions.md "Originals"). What
// this pins, without a database:
//
//   1. One original per starter directory with ready-made entries, named
//      for it, at homeroom-<dir>, made from its first ready-made.
//   2. ensure() makes the missing ones the way POST /api/apps makes a
//      project (a `creating` row and its maker's membership, which start
//      app-creation), owned by the platform's own account, public, approved
//      by the platform's approvers, who join each original's community; it
//      leaves alone a slug someone else holds, and does nothing without the
//      git host, with versions off, or in a preview. A clock runs it.
//   3. A ready-made made where its original runs is a version that gets its
//      updates; anywhere else it is made as before and linked as an older
//      copy.
//   4. Its setup's first commit is the original's tree at the commit it
//      copies (bytes and modes as they are), with this project's words,
//      name, notes and approval rule, and `followOriginal: true`; its
//      lineage records both commits; and the image key it offers is the one
//      starter-images builds that ready-made's image under, from the same
//      original. The commit it copies is the newest of the original's
//      recent ones whose image is built, so it deploys a prebuilt image.
//
// A bare repository over file:// stands in for the git host, as in
// tests/hosted-git.test.js.
//
// Run with: node --test tests/originals.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}
stub(require.resolve('../src/services/logger'), { info() {}, warn() {}, error() {}, debug() {} });

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'originals-'));
process.env.USERNODE_MIRROR_ROOT = path.join(root, 'mirrors');
fs.mkdirSync(process.env.USERNODE_MIRROR_ROOT);
const HOST = {
  GIT_HOST_URL: 'https://git.example.test', GIT_HOST_INTERNAL_URL: `file://${root}/host`, GIT_HOST_ORG: 'apps',
  GIT_HOST_USER: 'homeroom', GIT_HOST_TOKEN: 'tok',
};
Object.assign(process.env, HOST);
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const appTemplates = require('../src/services/app-templates');
const originals = require('../src/services/originals');
const { getTemplateFiles } = require('../src/services/template');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const NOT_PREVIEW = { USERNODE_ENV: 'production' };

originals._forTest.setVersions(async () => true);

// ── 1. One original per starter directory ────────────────────────────────

test('one original per starter directory with ready-made entries, named for it', () => {
  const list = originals.starters();
  assert.deepEqual(list.map((s) => s.name), [
    'Tier list', 'Group poll', 'Grocery list', 'Chore list', 'Lending library', 'Study timer',
    'Find a time', 'Potluck planner', 'Sign-up sheet', 'Group challenge',
  ]);
  for (const s of list) {
    assert.equal(s.slug, `homeroom-${s.dir}`);
    assert.ok(s.dir.length <= 40, 'fits apps.original_of');
    assert.equal(appTemplates.dirOf(s.template), s.dir);
    assert.equal(appTemplates.READY_IDS.find((id) => appTemplates.dirOf(id) === s.dir), s.template, 'its first ready-made');
  }
  assert.equal(new Set(list.map((s) => s.dir)).size, new Set(appTemplates.READY_IDS.map(appTemplates.dirOf)).size);
});

// ── 2. ensure() ──────────────────────────────────────────────────────────

function ensurePool({ existing = [], taken = [], roster = [5, 6] } = {}) {
  const calls = [];
  let nextId = 100;
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/SELECT id FROM apps WHERE self_hosted = TRUE/.test(sql)) return { rows: [{ id: 1 }] };
      if (/SELECT id FROM users WHERE username = \$1/.test(sql)) return { rows: [{ id: 900 }] };
      if (/SELECT original_of FROM apps WHERE original_of IS NOT NULL/.test(sql)) return { rows: existing.map((d) => ({ original_of: d })) };
      if (/SELECT id FROM apps WHERE slug = \$1/.test(sql)) return { rows: taken.includes(params[0]) ? [{ id: 7 }] : [] };
      if (/WITH new_app AS/.test(sql)) return { rows: [{ id: nextId++, slug: params[1] }] };
      if (/SELECT approvers_from_app_id FROM apps WHERE id = \$1/.test(sql)) return { rows: [{ approvers_from_app_id: null }] };
      if (/SELECT user_id FROM app_approvers WHERE app_id = \$1/.test(sql)) return { rows: roster.map((id) => ({ user_id: id })) };
      if (/FROM users WHERE is_admin = TRUE/.test(sql)) return { rows: [{ id: 70 }] };
      if (/INSERT INTO community_members/.test(sql)) return { rows: [], rowCount: 4 };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

test('ensure makes each missing original as POST /api/apps makes a project, approved by the platform\'s approvers', async () => {
  const pool = ensurePool({ existing: ['tier-list'], taken: ['homeroom-group-poll'] });
  const out = await originals.ensure({}, pool, { env: NOT_PREVIEW });
  const dirs = originals.starters().map((s) => s.dir).filter((d) => d !== 'tier-list' && d !== 'group-poll');
  assert.deepEqual(out.made, dirs.map((d) => `homeroom-${d}`));
  assert.deepEqual(out.skipped, ['homeroom-group-poll'], 'a slug someone else holds is left alone');
  assert.equal(out.originals, 1 + dirs.length);
  const inserts = pool.calls.filter((c) => /WITH new_app AS/.test(c.sql));
  assert.equal(inserts.length, dirs.length);
  const sql = inserts[0].sql;
  // A creating row (which starts app-creation's setup) and its maker's membership.
  assert.match(sql, /INSERT INTO apps \(name, slug, repo_url, created_by, status, collab_visibility, view_visibility,\s+template, icon_emoji, original_of, approvers_from_app_id,\s+approver_policy, approvals_required\)/);
  assert.match(sql, /VALUES \(\$1, \$2, NULL, \$3, 'creating', 'public', 'public', \$4, \$5, \$6, \$7, 'invited', \$8\)\s+ON CONFLICT DO NOTHING/);
  assert.match(sql, /INSERT INTO app_collaborators \(app_id, user_id, status, accepted_at\)\s+SELECT id, \$3, 'member', NOW\(\) FROM new_app/);
  const chores = inserts.find((c) => c.params[5] === 'chore-list').params;
  assert.deepEqual(chores, ['Chore list', 'homeroom-chore-list', 900, 'chore-list', appTemplates.get('chore-list').icon, 'chore-list', 1, 1]);
  // The platform's approvers join every original's community.
  const joined = pool.calls.find((c) => /INSERT INTO community_members/.test(c.sql));
  assert.deepEqual(joined.params, [[5, 6]]);
  assert.match(joined.sql, /SELECT a\.community_id, u\.id, 'auto'\s+FROM apps a CROSS JOIN unnest\(\$1::int\[\]\) AS u\(id\)\s+WHERE a\.original_of IS NOT NULL/);
  assert.equal(out.joined, 4);
  // Its dapp.json says the same rule from its first commit.
  const dapp = JSON.parse(getTemplateFiles('Chore list', 'homeroom-chore-list', null, null, {
    template: 'chore-list', governance: require('../src/services/app-creator').governanceOf({ approver_policy: 'invited', approvals_required: 1 }),
  }).find((f) => f.path === 'dapp.json').content);
  assert.deepEqual(dapp.governance, { approvers: 'invited', approvals: { atLeast: 1 } });
});

test('ensure with every original made only keeps the approvers joined; with no roster, the admins', async () => {
  const all = originals.starters().map((s) => s.dir);
  const pool = ensurePool({ existing: all, roster: [] });
  const out = await originals.ensure({}, pool, { env: NOT_PREVIEW });
  assert.deepEqual([out.made, out.skipped, out.originals], [[], [], all.length]);
  assert.ok(!pool.calls.some((c) => /WITH new_app AS/.test(c.sql)));
  assert.deepEqual(pool.calls.find((c) => /INSERT INTO community_members/.test(c.sql)).params, [[70]]);
});

test('ensure does nothing without the git host, in a preview, or with versions off', async () => {
  const pool = ensurePool();
  assert.deepEqual(await originals.ensure({}, pool, { env: { USERNODE_ENV: 'staging' } }), { off: 'preview' });
  originals._forTest.setVersions(async () => false);
  assert.deepEqual(await originals.ensure({}, pool, { env: NOT_PREVIEW }), { off: 'versions_off' });
  originals._forTest.setVersions(async () => true);
  delete process.env.GIT_HOST_URL;
  try {
    assert.deepEqual(await originals.ensure({}, pool, { env: NOT_PREVIEW }), { off: 'no_git_host' });
  } finally {
    process.env.GIT_HOST_URL = HOST.GIT_HOST_URL;
  }
  assert.equal(pool.calls.length, 0, 'not even a read');
});

test('a clock only the newest build runs makes them every ten minutes', () => {
  const clocks = read('src/workflow/clock/services.ts');
  assert.match(clocks, /name: 'originals', everyMs: 10 \* MIN, newestOnly: true,\s+run: \(_ctx: WorkContext, \{ pool, config \}: JobDeps\) => legacy\('services\/originals'\)\.ensure\(config, pool\),/);
});

// ── 3. The link a new ready-made starts with ────────────────────────────

function linkPool(original) {
  return { query: async (sql) => (/FROM apps WHERE original_of = \$1/.test(sql) ? { rows: original ? [original] : [] } : { rows: [] }) };
}
const ORIGINAL = { id: 61, slug: 'homeroom-tier-list', name: 'Tier list', status: 'running', main_sha: 'a'.repeat(40), repo_url: 'https://git.example.test/apps/homeroom-tier-list', template: 'tier-list-restaurants', original_of: 'tier-list' };
const NOW = new Date('2026-10-28T12:00:00Z');

test('a ready-made of a running original is a version that gets its updates; otherwise an older copy', async () => {
  const link = (o, extra = {}) => originals.linkFor({}, linkPool(o), 'tier-list-hikes', { now: NOW, env: NOT_PREVIEW, ...extra });
  assert.deepEqual(await link(ORIGINAL), { appId: 61, slug: 'homeroom-tier-list', since: NOW.toISOString(), following: true });
  const older = { appId: 61, slug: 'homeroom-tier-list', since: NOW.toISOString(), following: false, legacy: true };
  assert.deepEqual(await link({ ...ORIGINAL, status: 'creating' }), older, 'still being made');
  assert.deepEqual(await link({ ...ORIGINAL, main_sha: null }), older, 'no main yet');
  assert.deepEqual(await link(ORIGINAL, { env: { USERNODE_ENV: 'staging' } }), older, 'a preview');
  originals._forTest.setVersions(async () => false);
  assert.deepEqual(await link(ORIGINAL), older, 'versions off');
  originals._forTest.setVersions(async () => true);
  assert.equal(await link(null), null, 'no original: no link');
  assert.equal(await originals.linkFor({}, linkPool(ORIGINAL), 'game-board'), null, 'not a ready-made');
  assert.equal(await originals.linkFor({}, linkPool(ORIGINAL), 'empty'), null);
  // The create route writes it in the create's own transaction.
  const route = read('src/routes/apps.js');
  assert.match(route, /originalLink = await require\('\.\.\/services\/originals'\)\.linkFor\(config, pool, template\);/);
  assert.match(route, /await optional\('version_link', 'Not linked to its original', async \(\) => \{\s+const link = await require\('\.\.\/services\/upstream-lineage'\)\.writeUpstream\(db, appRow\.id, originalLink\);/);
});

// ── 4. A version's first commit ─────────────────────────────────────────

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]).toString().trim();
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x00]);

// The Tier list original on the git host, as its own setup made it, and
// then a merged change: a new tier note in its page, an icon image and a
// script that must stay executable.
function makeOriginalRepo(name = 'homeroom-tier-list') {
  const bare = path.join(root, 'host', 'apps', `${name}.git`);
  fs.mkdirSync(bare, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const work = fs.mkdtempSync(path.join(root, 'work-'));
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  const files = getTemplateFiles('Tier list', name, null, `https://git.example.test/apps/${name}`, {
    template: 'tier-list-restaurants', governance: { approverPolicy: 'invited', approvalsRequired: 1 },
  });
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(work, f.path)), { recursive: true });
    fs.writeFileSync(path.join(work, f.path), f.content);
  }
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'Initialize Tier list from Homeroom template');
  const firstSha = git(work, 'rev-parse', 'HEAD');
  const page = path.join(work, 'public/index.html');
  fs.writeFileSync(page, fs.readFileSync(page, 'utf8').replace('</body>', '<p id="tier-note">Ranked by the group</p>\n</body>'));
  fs.writeFileSync(path.join(work, 'public/icon.png'), PNG);
  fs.writeFileSync(path.join(work, 'scripts.sh'), '#!/bin/sh\necho hi\n');
  fs.chmodSync(path.join(work, 'scripts.sh'), 0o755);
  // The original's own words and notes, which a version never takes.
  fs.writeFileSync(path.join(work, 'words.json'), JSON.stringify({ ITEM_PLURAL: 'places' }));
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'A note under the tiers');
  git(work, 'push', '-q', bare, 'HEAD:main');
  const sha = git(work, 'rev-parse', 'HEAD');
  fs.rmSync(work, { recursive: true, force: true });
  return { sha, firstSha, repoUrl: `https://git.example.test/apps/${name}` };
}

let made = null;
function original() {
  if (!made) made = makeOriginalRepo();
  return { ...ORIGINAL, main_sha: made.sha, repo_url: made.repoUrl };
}

test('an original\'s tree is read at its commit, bytes and modes as committed', async () => {
  const o = original();
  const tree = await originals.mainTree(o, o.main_sha);
  const byPath = new Map(tree.map((f) => [f.path, f]));
  assert.ok(Buffer.isBuffer(byPath.get('public/icon.png').content), 'an image stays bytes');
  assert.ok(byPath.get('public/icon.png').content.equals(PNG));
  assert.equal(byPath.get('scripts.sh').mode, '100755');
  assert.equal(byPath.get('server.js').mode, '100644');
  assert.match(byPath.get('public/index.html').content, /id="tier-note"/);
  assert.deepEqual(tree.map((f) => f.path), [...tree.map((f) => f.path)].sort());
  assert.equal(await originals.mainTree(o, o.main_sha), tree, 'read once per commit');
  await assert.rejects(originals.mainTree(o, 'nope'), /Not a commit/);
});

test('a version\'s files: the original\'s tree, with its own words, name, notes and rule', async () => {
  const o = original();
  const tree = await originals.mainTree(o, o.main_sha);
  const own = getTemplateFiles('Hikes we love', 'hikes-we-love-abc123', null, 'https://git.example.test/apps/hikes-we-love-abc123', {
    template: 'tier-list-hikes', description: 'Our hikes', governance: { approverPolicy: 'creator', approvalsRequired: 2 },
  });
  const files = originals.versionFiles(tree, own, { name: 'Hikes we love', templateId: 'tier-list-hikes', originalTemplate: 'tier-list-restaurants' });
  const at = (p) => files.find((f) => f.path === p);
  // The original's code, as it is now.
  assert.match(at('public/index.html').content, /id="tier-note"/);
  assert.ok(at('public/icon.png').content.equals(PNG));
  assert.equal(at('scripts.sh').mode, '100755');
  assert.equal(at('server.js').content, tree.find((f) => f.path === 'server.js').content);
  // Its own words and the files that carry its name.
  assert.deepEqual(JSON.parse(at('words.json').content), { ...appTemplates.get('tier-list-hikes').fill });
  assert.match(at('README.md').content, /^# Hikes we love/);
  assert.match(at('LICENSE').content, /The Hikes we love contributors/);
  assert.match(at('CLAUDE.md').content, /^# Hikes we love/);
  assert.equal(at('.claude/homeroom-canonical-repo').content.trim(), 'https://git.example.test/apps/hikes-we-love-abc123');
  const dapp = JSON.parse(at('dapp.json').content);
  assert.equal(dapp.name, 'Hikes we love');
  assert.equal(dapp.description, 'Our hikes');
  assert.deepEqual(dapp.governance, { approvers: 'creator', approvals: { atLeast: 2 } });
  assert.deepEqual(dapp.icon, { emoji: appTemplates.get('tier-list-hikes').icon });
  assert.equal(dapp.followOriginal, true);
  assert.deepEqual(dapp.tests, JSON.parse(JSON.stringify(appTemplates.get('tier-list-restaurants').tests)), 'the original\'s checks');
  // No rule of its own: no governance block, never the original's.
  const plain = originals.versionFiles(tree, getTemplateFiles('Hikes', 'h', null, null, { template: 'tier-list-hikes' }),
    { name: 'Hikes', templateId: 'tier-list-hikes', originalTemplate: 'tier-list-restaurants' });
  const plainDapp = JSON.parse(plain.find((f) => f.path === 'dapp.json').content);
  assert.equal(plainDapp.governance, undefined);
  assert.ok(!plain.some((f) => f.path === '.claude/homeroom-canonical-repo'), 'the original\'s pointer is not taken');
});

test('a ready-made with checks of its own keeps them in a version of an original made from another', () => {
  const theirs = JSON.stringify({ category: 'other', secrets: [], tests: appTemplates.get('signup-shifts').tests, visibility: { view: 'public' }, admins: ['x'], extra: 1 });
  const mine = JSON.stringify({ icon: { emoji: '🙋' }, tests: appTemplates.get('signup-rsvp').tests });
  const dapp = JSON.parse(originals.versionManifest(theirs, mine, { name: 'Who is coming', templateId: 'signup-rsvp', originalTemplate: 'signup-shifts' }));
  assert.deepEqual(dapp.tests, JSON.parse(JSON.stringify(appTemplates.get('signup-rsvp').tests)));
  assert.equal(dapp.extra, 1, 'any other key of the original\'s is carried');
  assert.equal(dapp.visibility, undefined, 'never who sees the original');
  assert.equal(dapp.admins, undefined, 'nor who manages it');
  assert.deepEqual(dapp.icon, { emoji: '🙋' });
});

// The setup, end to end (app-creator.js setUp), as tests/app-creator-failure
// .test.js runs it: the version's own repository is a stub that records the
// commit it is given; the original is the git host's real repository.
// `ready`: the image keys starter-images has built (every one by default).
function loadCreator({ app, pushed, ready = null }) {
  const ids = {
    github: require.resolve('../src/services/github'),
    dbManager: require.resolve('../src/services/db-manager'),
    sketch: require.resolve('../src/services/app-sketch'),
    ws: require.resolve('../src/services/ws'),
    appCreator: require.resolve('../src/services/app-creator'),
  };
  delete require.cache[ids.appCreator];
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (/SELECT \* FROM apps WHERE id = \$1/.test(sql)) return { rows: [app] };
      if (/FROM apps WHERE id = \$1/.test(sql) && params[0] === 61) return { rows: [original()] };
      if (/FROM starter_images/.test(sql) && /context_key = \$1 AND image_ref IS NOT NULL/.test(sql)) {
        return { rows: !ready || ready.has(params[0]) ? [{ context_key: params[0], image_ref: 'registry/starter@sha256:1' }] : [] };
      }
      if (/UPDATE apps SET upstream/.test(sql)) {
        app.upstream = { ...(app.upstream || {}), ...JSON.parse(params[1]) };
        return { rows: [{ upstream: app.upstream }] };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  stub(require.resolve('../src/db/session-locks'), { withSessionLock: async (_pool, _key, fn) => fn() });
  stub(ids.github, {
    isEnabled: () => true,
    getBotUsername: async () => 'apps',
    createRepo: async (owner, slug) => ({ html_url: `https://git.example.test/${owner}/${slug}`, ...(pushed.adopt ? { adopted: true } : {}) }),
    headCommit: async () => pushed.head || null,
    pushFiles: async () => assert.fail('a version is not pushed onto the empty starter'),
    createRootCommit: async (owner, repo, files, opts) => { pushed.commits.push({ files, opts }); return 'b'.repeat(40); },
    forceBranchToSha: async (owner, repo, branch, sha) => { pushed.moves.push({ branch, sha }); return { updated: true }; },
  });
  stub(ids.dbManager, { appDbName: (slug) => `app_${slug}`, createDatabase: async () => ({ password: 'pw' }), connectionUrl: () => 'postgres://x' });
  stub(ids.sketch, { drawFor: async () => null, markCommitted: async () => {}, taglineOf: () => null, designFiles: () => [], cardOf: () => null });
  stub(ids.ws, { pushAppCreationPhase: () => {} });
  return { appCreator: require(ids.appCreator), pool, queries };
}
function workContext() {
  const { steps: makeSteps } = require('../src/workflow/kernel/steps.ts');
  const kept = { value: null };
  return { signal: new AbortController().signal, steps: (o = {}) => makeSteps({ resumeFrom: kept.value, checkpoint: async (v) => { kept.value = v; }, ...o }) };
}
const DOCKER = { appRuntime: 'docker' };

test('a version\'s setup pushes the original\'s tree as its first commit, records both commits, and offers the image built from that original', async () => {
  const o = original();
  const app = {
    id: 77, name: 'Hikes we love', slug: 'hikes-we-love-abc123', status: 'creating', self_hosted: false,
    template: 'tier-list-hikes', approver_policy: 'anyone', approvals_required: null,
    upstream: { appId: 61, slug: 'homeroom-tier-list', following: true, since: NOW.toISOString() },
  };
  const pushed = { commits: [], moves: [] };
  const { appCreator, pool, queries } = loadCreator({ app, pushed });
  const out = await appCreator.setUp(DOCKER, pool, 77, workContext());
  assert.equal(out.failed, undefined, JSON.stringify(out.failed));
  assert.equal(pushed.commits.length, 1);
  const { files, opts } = pushed.commits[0];
  assert.equal(opts.message, 'Initialize Hikes we love from Tier list');
  assert.deepEqual(pushed.moves, [{ branch: 'main', sha: 'b'.repeat(40) }], 'main moves to the commit, with nothing under it');
  assert.match(files.find((f) => f.path === 'public/index.html').content, /id="tier-note"/, 'the original as it is now');
  assert.deepEqual(JSON.parse(files.find((f) => f.path === 'words.json').content), { ...appTemplates.get('tier-list-hikes').fill });
  assert.equal(JSON.parse(files.find((f) => f.path === 'dapp.json').content).followOriginal, true);
  // Its lineage: the commit it copied, chosen before anything was pushed,
  // then its own first commit.
  const writes = queries.filter((q) => /UPDATE apps SET upstream/.test(q.sql)).map((q) => JSON.parse(q.params[1]));
  assert.deepEqual(writes, [{ syncedSha: o.main_sha }, { syncedSha: o.main_sha, baseSha: 'b'.repeat(40) }]);
  assert.equal(app.upstream.following, true);
  assert.ok(queries.some((q) => /UPDATE apps SET repo_url = \$1, template_version = NULL WHERE id = \$2/.test(q.sql)));
  // The image its first deploy looks for is the one built from this original.
  assert.equal(out.sha, 'b'.repeat(40));
  assert.equal(out.offer.starter.template, 'tier-list-hikes');
  const starterImages = require('../src/services/starter-images');
  const imagePool = { query: async (sql) => (/FROM apps WHERE original_of IS NOT NULL/.test(sql) ? { rows: [o] } : { rows: [] }) };
  const prev = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'production';
  try {
    const built = (await starterImages.currentTreesFor(DOCKER, imagePool)).find((t) => t.id === 'tier-list-hikes');
    assert.deepEqual(built.original, { slug: 'homeroom-tier-list', sha: o.main_sha });
    assert.equal(out.offer.starter.key, built.key);
    assert.match(built.files.find((f) => f.path === 'public/index.html').content, /id="tier-note"/);
    // A ready-made of a directory with no original is rendered as before.
    const grocery = (await starterImages.currentTreesFor(DOCKER, imagePool)).find((t) => t.id === 'grocery-list');
    assert.equal(grocery.key, starterImages.currentTrees(DOCKER).find((t) => t.id === 'grocery-list').key);
    assert.notEqual(built.key, starterImages.currentTrees(DOCKER).find((t) => t.id === 'tier-list-hikes').key);
  } finally {
    if (prev === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = prev;
  }
});

test('a setup that resumes finds its own first commit and copies the same commit; one that cannot begin is made as before', async () => {
  const o = original();
  // Resumed: the commit it copies is recorded, and its first commit is the head.
  const app = {
    id: 78, name: 'Cities', slug: 'cities-abc123', status: 'creating', self_hosted: false, template: 'tier-list-cities',
    upstream: { appId: 61, slug: 'homeroom-tier-list', following: true, syncedSha: o.main_sha },
  };
  const pushed = { commits: [], moves: [], adopt: true, head: { sha: 'c'.repeat(40), message: 'Initialize Cities from Tier list' } };
  const { appCreator, pool } = loadCreator({ app, pushed });
  const out = await appCreator.setUp(DOCKER, pool, 78, workContext());
  assert.equal(pushed.commits.length, 0, 'not pushed twice');
  assert.equal(out.sha, 'c'.repeat(40));
  assert.deepEqual({ syncedSha: app.upstream.syncedSha, baseSha: app.upstream.baseSha }, { syncedSha: o.main_sha, baseSha: 'c'.repeat(40) });
  assert.match(out.offer.starter.key, /^[0-9a-f]{64}$/);

  // Its original stopped running before it began: made from app-templates,
  // linked as an older copy.
  const stopped = {
    id: 79, name: 'Games', slug: 'games-abc123', status: 'creating', self_hosted: false, template: 'tier-list-games',
    upstream: { appId: 61, slug: 'homeroom-tier-list', following: true },
  };
  const rendered = [];
  const second = loadCreator({ app: stopped, pushed: { commits: [], moves: [] } });
  require.cache[require.resolve('../src/services/github')].exports.pushFiles = async (owner, repo, files, opts) => {
    rendered.push(opts.message); return { sha: 'd'.repeat(40) };
  };
  const pool2 = {
    query: async (sql, params) => {
      if (/FROM apps WHERE id = \$1/.test(sql) && params[0] === 61) return { rows: [{ ...o, status: 'error' }] };
      return second.pool.query(sql, params);
    },
  };
  const out2 = await second.appCreator.setUp(DOCKER, pool2, 79, workContext());
  assert.deepEqual(rendered, ['Initialize Games from Homeroom template']);
  assert.equal(out2.sha, 'd'.repeat(40));
  assert.deepEqual({ following: stopped.upstream.following, legacy: stopped.upstream.legacy }, { following: false, legacy: true });
});

// The image key of `templateId` built from the original at `sha`.
async function keyAt(templateId, sha) {
  const starterImages = require('../src/services/starter-images');
  const t = starterImages.currentTrees(DOCKER).find((x) => x.id === templateId);
  return (await starterImages.originalEntry(DOCKER, t, original(), sha)).key;
}

test('a new version copies the newest of its original\'s commits whose image is built, and is made as before when none is', async () => {
  const o = original();
  const fresh = (id) => ({
    id, name: 'Hikes', slug: `hikes-${id}`, status: 'creating', self_hosted: false, template: 'tier-list-hikes',
    upstream: { appId: 61, slug: 'homeroom-tier-list', following: true },
  });
  const prev = process.env.STARTER_PREBUILDS;
  try {
    delete process.env.STARTER_PREBUILDS;
    // Main's image is still building; the one from the commit before it is
    // ready: that commit is copied, and the change since is its first update.
    const behind = fresh(81);
    const pushed = { commits: [], moves: [] };
    const first = await keyAt('tier-list-hikes', made.firstSha);
    const { appCreator, pool } = loadCreator({ app: behind, pushed, ready: new Set([first]) });
    const out = await appCreator.setUp(DOCKER, pool, 81, workContext());
    assert.equal(out.failed, undefined, JSON.stringify(out.failed));
    assert.equal(behind.upstream.syncedSha, made.firstSha);
    assert.doesNotMatch(pushed.commits[0].files.find((f) => f.path === 'public/index.html').content, /id="tier-note"/);
    assert.equal(out.offer.starter.key, first, 'the image it deploys is built');
    assert.notEqual(first, await keyAt('tier-list-hikes', o.main_sha));

    // No recent commit's image is built (an original that has just come
    // up): made from app-templates, linked as an older copy.
    const none = fresh(82);
    const rendered = [];
    const second = loadCreator({ app: none, pushed: { commits: [], moves: [] }, ready: new Set() });
    require.cache[require.resolve('../src/services/github')].exports.pushFiles = async (owner, repo, files, opts) => {
      rendered.push(opts.message); return { sha: 'e'.repeat(40) };
    };
    await second.appCreator.setUp(DOCKER, second.pool, 82, workContext());
    assert.deepEqual(rendered, ['Initialize Hikes from Homeroom template']);
    assert.deepEqual({ following: none.upstream.following, legacy: none.upstream.legacy }, { following: false, legacy: true });

    // Where nothing is prebuilt, no commit is quicker: main is copied.
    process.env.STARTER_PREBUILDS = 'off';
    const unbuilt = fresh(83);
    const third = loadCreator({ app: unbuilt, pushed: { commits: [], moves: [] }, ready: new Set() });
    await third.appCreator.setUp(DOCKER, third.pool, 83, workContext());
    assert.equal(unbuilt.upstream.syncedSha, o.main_sha);
  } finally {
    if (prev === undefined) delete process.env.STARTER_PREBUILDS; else process.env.STARTER_PREBUILDS = prev;
  }
});
