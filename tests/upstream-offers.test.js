'use strict';

// Updates down: an original's merged changes offered to each version that
// follows it, as an ordinary change its own group votes on.
//
//   src/services/upstream-offers.js   planning, opening, refreshing,
//                                     skipping, settling, fitting, facts
//   src/routes/upstream.js            GET/POST /api/apps/:slug/upstream...
//   src/workflow/clock/services.ts    the clock job `upstream-offers`
//
// Pinned here:
//   1. facts are computed from the diff (factsOf), with what is not code or
//      not outside left out;
//   2. the plan, with real git over file:// standing in for the git host:
//      theirs on the version's base, the three-way merge with that base,
//      dapp.json's keys, the paths that never travel, brings and keeps, a
//      conflict, an update that changes nothing, the same commits twice;
//   3. the flows: open (refs, the platform's proposal, its promote, the
//      members told), merged and closed proposals moving the lineage, a
//      second update built on the first, refresh, skip, needs_fit and fit;
//   4. the clock's run and its targets, and the off switch;
//   5. the routes' shapes and doors;
//   6. the change page's block and where the pieces are wired.
//
// Run with: node --test tests/upstream-offers.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const loggerId = require.resolve('../src/services/logger');
require.cache[loggerId] = {
  id: loggerId, filename: loggerId, loaded: true, paths: [],
  exports: { info() {}, debug() {}, warn() {}, error() {} },
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upstream-offers-'));
Object.assign(process.env, {
  GIT_HOST_URL: 'https://git.example.test', GIT_HOST_INTERNAL_URL: `file://${root}/host`, GIT_HOST_ORG: 'apps',
  GIT_HOST_USER: 'homeroom', GIT_HOST_TOKEN: 'tok',
});
delete process.env.VERSIONS_ENABLED;
if (process.env.USERNODE_ENV === 'staging') delete process.env.USERNODE_ENV;
fs.mkdirSync(path.join(root, 'host', 'apps'), { recursive: true });
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const gitHost = require('../src/services/git-host');
const offers = require('../src/services/upstream-offers');
const lineage = require('../src/services/upstream-lineage');

const { SQL, factsOf } = offers;

// ── 1. Facts ─────────────────────────────────────────────────────────

function diffOf(files) {
  // A unified diff by hand: { path: { add: [...], del: [...] } }.
  const out = [];
  for (const [file, { add = [], del = [] }] of Object.entries(files)) {
    out.push(`diff --git a/${file} b/${file}`, 'index 1111111..2222222 100644', `--- a/${file}`, `+++ b/${file}`,
      `@@ -1,${del.length} +1,${add.length} @@`);
    for (const l of del) out.push(`-${l}`);
    for (const l of add) out.push(`+${l}`);
  }
  return `${out.join('\n')}\n`;
}

test('facts: nothing in, nothing claimed', () => {
  assert.deepEqual(factsOf('', null, null), { ...offers.EMPTY_FACTS });
  assert.deepEqual(factsOf(undefined, '{', 'not json'), { ...offers.EMPTY_FACTS });
});

test('facts: the tables an update adds, not ones it only moves, comments, or prose', () => {
  const diff = diffOf({
    'server.js': {
      add: [
        'await db.query(`CREATE TABLE IF NOT EXISTS scores (id SERIAL PRIMARY KEY)`);',
        '  create table "Players" (id int);',
        'CREATE UNLOGGED TABLE app.cache (k text);',
        'CREATE TEMP TABLE scratch (x int);',
        'CREATE TABLE IF NOT EXISTS moved (id int);',
        '// CREATE TABLE commented_out (id int);',
        'const sql = `CREATE TABLE ${name} (id int)`;',
      ],
      del: ['CREATE TABLE IF NOT EXISTS moved (id int);'],
    },
    'README.md': { add: ['Run CREATE TABLE notes (x int) by hand.'] },
  });
  assert.deepEqual(factsOf(diff, {}, {}).tablesAdded, ['Players', 'app.cache', 'scores', 'scratch']);
});

test('facts: what changes data already stored, and what does not', () => {
  const destructive = [
    'DROP TABLE IF EXISTS old_scores;',
    'ALTER TABLE scores DROP COLUMN note;',
    'ALTER TABLE scores DROP note;',
    'ALTER TABLE scores RENAME TO results;',
    'ALTER TABLE scores RENAME COLUMN pts TO points;',
    '  RENAME COLUMN a TO b',
    'ALTER TABLE scores ALTER COLUMN points TYPE bigint;',
    'ALTER TABLE scores ALTER points SET DATA TYPE bigint;',
    'TRUNCATE scores;',
    'truncate table scores',
  ];
  const harmless = [
    'ALTER TABLE scores DROP CONSTRAINT scores_pkey;',
    'ALTER TABLE scores ALTER COLUMN points DROP DEFAULT;',
    'ALTER TABLE scores ALTER COLUMN points DROP NOT NULL;',
    'ALTER TABLE scores ADD COLUMN IF NOT EXISTS note TEXT;',
    'const short = truncate(text, 10);',
    'const truncated = list.slice(0, 3);',
    'await fs.rename(tmp, target);',
    '// DROP TABLE scores, one day',
    '-- DROP TABLE scores;',
  ];
  const facts = factsOf(diffOf({ 'server.js': { add: [...destructive, ...harmless] } }), {}, {});
  assert.deepEqual(facts.destructive, destructive.map((l) => l.trim()));

  const moved = factsOf(diffOf({ 'server.js': { add: ['DROP TABLE x;'], del: ['DROP TABLE x;'] } }), {}, {});
  assert.deepEqual(moved.destructive, [], 'a line it only moved is not new');
  const docs = factsOf(diffOf({ 'docs/schema.md': { add: ['DROP TABLE x;'] } }), {}, {});
  assert.deepEqual(docs.destructive, [], 'prose says nothing');
});

test('facts: a removed SQL comment inside a hunk is read as a removed line, never as a file header', () => {
  const diff = [
    'diff --git a/db.sql b/db.sql', 'index 1..2 100644', '--- a/db.sql', '+++ b/db.sql', '@@ -1,2 +1,2 @@',
    '--- an old note about https://old.example.io',
    '+++ a new note',
    '+DROP TABLE gone;',
    'diff --git a/icon.png b/icon.png', 'index 3..4 100644', 'GIT binary patch', 'literal 5',
    'McmZQzWMXFE0002A0RR91', '', 'literal 0', 'HcmV?d00001', '',
  ].join('\n');
  const facts = factsOf(diff, {}, {});
  assert.deepEqual(facts.destructive, ['DROP TABLE gone;'], 'the hunk kept its file and its lines');
});

test('facts: outside hosts its code starts to name', () => {
  const diff = diffOf({
    'public/app.js': {
      add: [
        'fetch("https://API.Cats.io:8443/v1/cats")',
        'const old = "https://already.example.co/x";',
        'fetch(`http://localhost:3000/x`); fetch("http://127.0.0.1/y");',
        'fetch("https://docs.example.com/a"); fetch("https://sub.example.org/b"); fetch("https://x.test/c");',
        'fetch("https://app.onhomeroom.com/api"); fetch("http://usernode:3000/api/app-llm");',
        'fetch("http://usernode-platform.svc/x");',
        '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
        'fetch("/api/scores"); fetch("./local.json");',
        '// see https://commented.io/why',
        '<script src="https://cdn.jsdelivr.net/npm/x@1"></script>',
      ],
      del: ['const old = "https://already.example.co/y";'],
    },
    'README.md': { add: ['Made with https://readme-only.io'] },
    'package-lock.json': { add: ['"resolved": "https://registry.npmjs.org/x/-/x-1.tgz"'] },
  });
  assert.deepEqual(factsOf(diff, {}, {}).hostsAdded, ['api.cats.io', 'cdn.jsdelivr.net']);
  for (const host of ['localhost', 'docs.example.com', 'app.onhomeroom.com', 'usernode', 'www.w3.org', 'a.local', 'x.invalid']) {
    assert.equal(offers.insideHost(host), true, host);
  }
  assert.equal(offers.insideHost('api.cats.io'), false);
});

test('facts: the keys dapp.json starts to need', () => {
  const base = JSON.stringify({ secrets: [{ key: 'OLD_KEY' }] });
  const head = JSON.stringify({ secrets: [{ key: 'OLD_KEY' }, { key: 'CAT_KEY', required: true }, 'PLAIN', { nope: 1 }] });
  assert.deepEqual(factsOf('', base, head).secretsAdded, ['CAT_KEY', 'PLAIN']);
  assert.deepEqual(factsOf('', { secrets: { A: {} } }, { secrets: { A: {}, B: {} } }).secretsAdded, ['B'], 'an object of keys');
  assert.deepEqual(factsOf('', head, base).secretsAdded, [], 'a key it drops is not one it needs');
});

test('facts: starting to use AI or file storage, not using them again', () => {
  const ai = diffOf({ 'server.js': { add: ['const url = process.env.USERNODE_LLM_PROXY_URL;'] } });
  assert.equal(factsOf(ai, {}, {}).ai, true);
  assert.equal(factsOf(ai, {}, {}, { alreadyAi: true }).ai, false, 'it used the proxy before');
  const moved = diffOf({ 'server.js': { add: ['x(process.env.USERNODE_LLM_PROXY_URL)'], del: ['y(process.env.USERNODE_LLM_PROXY_URL)'] } });
  assert.equal(factsOf(moved, {}, {}).ai, false, 'a reference it only moved');
  assert.equal(factsOf('', {}, { llm: { model: 'x' } }).ai, true, 'dapp.json asks for the model');
  assert.equal(factsOf(diffOf({ 'NOTES.md': { add: ['USERNODE_LLM_PROXY_URL'] } }), {}, {}).ai, false);

  const storage = diffOf({ 'server.js': { add: ['const s = process.env.USERNODE_STORAGE_URL;'] } });
  assert.equal(factsOf(storage, {}, {}).storage, true);
  assert.equal(factsOf(storage, {}, {}, { alreadyStorage: true }).storage, false);
});

test('facts: lists are bounded, and lines clipped', () => {
  const add = Array.from({ length: 30 }, (_, i) => `DROP TABLE t${i}; ${'x'.repeat(300)}`);
  const facts = factsOf(diffOf({ 'a.js': { add } }), {}, {});
  assert.equal(facts.destructive.length, 20);
  assert.ok(facts.destructive.every((l) => l.length <= 200));
});

test('change titles lose the " (#N)" a squash gives them', () => {
  assert.equal(offers.titleOf('Add a shuffle button (#12)'), 'Add a shuffle button');
  assert.equal(offers.titleOf('Fix (#2) in the middle'), 'Fix (#2) in the middle');
  assert.equal(offers.branchFor('a'.repeat(40)), 'homeroom/update-aaaaaaaaaaaa');
});

// ── 2. The plan, with real git ───────────────────────────────────────

let repoSeq = 0;

function sh(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  }).toString().trim();
}

function write(dir, file, content) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
}

function commitAll(dir, message) {
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', message);
  return sh(dir, 'rev-parse', 'HEAD');
}

function push(dir, name, refspec = 'HEAD:refs/heads/main') {
  sh(dir, 'push', '-q', '--force', `${root}/host/apps/${name}.git`, refspec);
}

const manifest = (obj) => `${JSON.stringify(obj, null, 2)}\n`;

/**
 * An original and a version made from it, on the stand-in git host. The
 * version's first commit is the original's tree with its own words, name
 * and README; then its own change. `conflict` makes the version's change
 * overlap the original's; `readmeOnly` has the original change only what
 * never travels.
 */
function fixture({ conflict = false, readmeOnly = false } = {}) {
  repoSeq += 1;
  const orig = `tier-${repoSeq}`;
  const ver = `mine-${repoSeq}`;
  for (const name of [orig, ver]) execFileSync('git', ['init', '-q', '--bare', '-b', 'main', `${root}/host/apps/${name}.git`]);

  const ow = fs.mkdtempSync(path.join(root, 'ow-'));
  sh(ow, 'init', '-q', '-b', 'main');
  write(ow, 'dapp.json', manifest({ name: 'Tier list', description: 'Rank anything', secrets: [] }));
  write(ow, 'app.js', 'one\ntwo\nthree\n');
  write(ow, 'README.md', '# Tier list\n');
  write(ow, 'words.json', manifest({ ITEM_PLURAL: 'things' }));
  write(ow, 'icon.bin', Buffer.from([0, 1, 2]));
  const syncedSha = commitAll(ow, 'Initial version');
  push(ow, orig);

  const vw = fs.mkdtempSync(path.join(root, 'vw-'));
  sh(vw, 'init', '-q', '-b', 'main');
  for (const f of ['app.js', 'icon.bin']) fs.copyFileSync(path.join(ow, f), path.join(vw, f));
  write(vw, 'dapp.json', manifest({ name: 'Our cities', description: 'Rank our cities', secrets: [], followOriginal: true }));
  write(vw, 'README.md', '# Our cities\n');
  write(vw, 'words.json', manifest({ ITEM_PLURAL: 'cities' }));
  const baseSha = commitAll(vw, 'Made from Tier list');
  if (conflict) write(vw, 'app.js', 'one\nTWO, OURS\nthree\n');
  else write(vw, 'style.css', 'body { color: teal; }\n');
  const ownSha = commitAll(vw, 'Our colours (#2)');
  push(vw, ver);

  // What the original then merged.
  if (readmeOnly) {
    write(ow, 'README.md', '# Tier list, now better\n');
    commitAll(ow, 'Better README (#3)');
  } else {
    write(ow, 'app.js', 'one\ntwo, shuffled\nthree\n');
    commitAll(ow, 'Add a shuffle button (#3)');
    write(ow, 'server.js', 'db.query(`CREATE TABLE IF NOT EXISTS scores (id int)`);\nfetch("https://api.cats.io/x");\n');
    write(ow, 'README.md', '# Tier list 2\n');
    write(ow, 'words.json', manifest({ ITEM_PLURAL: 'items' }));
    write(ow, 'icon.bin', Buffer.from([9, 8, 7, 255]));
    commitAll(ow, 'Keep scores (#4)');
    write(ow, 'dapp.json', manifest({ name: 'Tier list!', description: 'Rank everything', secrets: [{ key: 'CAT_KEY' }] }));
    commitAll(ow, 'Ask for a cat key (#5)');
  }
  const fromSha = sh(ow, 'rev-parse', 'HEAD');
  push(ow, orig);
  return { orig, ver, ow, vw, syncedSha, baseSha, ownSha, fromSha };
}

async function plan(fx, over = {}) {
  const deps = { gitHost };
  return offers.withScratch('test', deps, (dir) => offers.planIn(dir, {
    deps, versionRemote: gitHost.cloneUrl(fx.ver), originalRemote: gitHost.cloneUrl(fx.orig),
    syncedSha: fx.syncedSha, baseSha: fx.baseSha, fromSha: fx.fromSha,
    originalName: 'Tier list', versionName: 'Our cities', ...over,
  }));
}

// Read a commit's file from the stand-in host.
function show(name, rev, file) {
  return execFileSync('git', ['--git-dir', `${root}/host/apps/${name}.git`, 'show', `${rev}:${file}`]).toString();
}

test('the plan: the original\'s changes on the version\'s base, merged with the version\'s own', async () => {
  const fx = fixture();
  const p = await plan(fx);
  assert.equal(p.clean, true);
  assert.equal(p.empty, false);
  assert.deepEqual(p.conflicts, []);
  assert.equal(p.mainSha, fx.ownSha);

  // The plan pushes nothing: plan again and push the two commits it made,
  // to look at them on the host.
  const deps = { gitHost };
  await offers.withScratch('push', deps, async (dir) => {
    const again = await offers.planIn(dir, {
      deps, versionRemote: gitHost.cloneUrl(fx.ver), originalRemote: gitHost.cloneUrl(fx.orig),
      syncedSha: fx.syncedSha, baseSha: fx.baseSha, fromSha: fx.fromSha, originalName: 'Tier list', versionName: 'Our cities',
    });
    assert.equal(again.headSha, p.headSha, 'the same inputs make the same commits');
    assert.equal(again.theirsSha, p.theirsSha);
    await gitHost.pushRefs(fx.ver, dir, [`${p.headSha}:refs/heads/check`, `${p.theirsSha}:refs/homeroom/check`], { force: true });
  });
  const parents = (rev) => execFileSync('git', ['--git-dir', `${root}/host/apps/${fx.ver}.git`, 'rev-list', '--parents', '-n', '1', rev])
    .toString().trim().split(' ').slice(1);
  assert.deepEqual(parents(p.headSha), [fx.ownSha], 'the update goes on top of the version\'s main');
  assert.deepEqual(parents(p.theirsSha), [fx.baseSha], 'theirs sits on the version\'s base');

  assert.equal(show(fx.ver, p.headSha, 'app.js'), 'one\ntwo, shuffled\nthree\n', 'the original\'s change');
  assert.match(show(fx.ver, p.headSha, 'server.js'), /CREATE TABLE IF NOT EXISTS scores/);
  assert.equal(show(fx.ver, p.headSha, 'style.css'), 'body { color: teal; }\n', 'the version\'s own change stays');
  assert.equal(show(fx.ver, p.headSha, 'README.md'), '# Our cities\n', 'its README never travels');
  assert.equal(show(fx.ver, p.headSha, 'words.json'), manifest({ ITEM_PLURAL: 'cities' }), 'nor its words');
  assert.deepEqual([...execFileSync('git', ['--git-dir', `${root}/host/apps/${fx.ver}.git`, 'cat-file', 'blob', `${p.headSha}:icon.bin`])],
    [9, 8, 7, 255], 'binary-safe');
  assert.deepEqual(JSON.parse(show(fx.ver, p.headSha, 'dapp.json')), {
    name: 'Our cities', description: 'Rank our cities', secrets: [{ key: 'CAT_KEY' }], followOriginal: true,
  }, 'dapp.json: the original\'s new key carried over, the version\'s name, words and switch kept');
  assert.deepEqual(p.manifestKeys, ['secrets']);

  assert.deepEqual(p.brings.map((b) => b.title), ['Add a shuffle button', 'Keep scores', 'Ask for a cat key'], 'oldest first');
  assert.deepEqual(p.keeps, { count: 1, titles: ['Our colours'] });
  assert.deepEqual(p.facts, {
    tablesAdded: ['scores'], destructive: [], hostsAdded: ['api.cats.io'], secretsAdded: ['CAT_KEY'], ai: false, storage: false,
  });
  assert.equal(p.words.title, 'Update from Tier list');
  assert.match(p.words.body, /^Tier list has changed since Our cities last took its updates\. This brings those changes in:/);
  assert.match(p.words.body, /- Adds data tables: scores\./);
  assert.match(p.words.body, /- Needs keys set: CAT_KEY\./);
  assert.match(p.words.body, /Our cities's own changes stay as they are\./);
});

test('the plan: the version\'s own change to the same lines is a conflict, with the paths', async () => {
  const fx = fixture({ conflict: true });
  const p = await plan(fx);
  assert.equal(p.clean, false);
  assert.deepEqual(p.conflicts, ['app.js']);
  assert.equal(p.headSha, null);
  assert.match(p.theirsSha, /^[0-9a-f]{40}$/, 'theirs is made either way, to wait under refs/homeroom/offer');
});

test('the plan: an update that only touches what never travels changes nothing here', async () => {
  const fx = fixture({ readmeOnly: true });
  const p = await plan(fx);
  assert.equal(p.clean, true);
  assert.equal(p.empty, true);
  assert.equal(p.headSha, null);
  assert.deepEqual(p.brings, [{ title: 'Better README' }]);
});

test('merge-tree\'s -z output: the tree, the conflicted paths, and not the messages that repeat them', () => {
  const out = `${'a'.repeat(40)}\0b.txt\0a.txt\0\0` + '1\0a.txt\0Auto-merging\0Auto-merging a.txt\0';
  assert.deepEqual(offers.parseMergeTree(out), { tree: 'a'.repeat(40), conflicts: ['a.txt', 'b.txt'] });
  assert.deepEqual(offers.parseMergeTree(`${'b'.repeat(40)}\0`), { tree: 'b'.repeat(40), conflicts: [] });
});

// ── 3. The flows ─────────────────────────────────────────────────────

const PLATFORM_ID = 50;
const MEMBER = { id: 5, username: 'ada' };

/** An in-memory stand-in for the tables the service reads, keyed by its own statements. */
function store() {
  const s = {
    apps: new Map(), offers: new Map(), sessions: new Map(), requests: [], issues: [],
    members: new Map(), updateMerges: new Map(), nextSession: 900, queries: [],
  };
  const offerRow = (appId) => {
    const o = s.offers.get(appId);
    if (!o) return null;
    const cs = o.session_id ? s.sessions.get(o.session_id) : null;
    return { ...o, session_status: cs ? cs.status : null, pr_number: cs ? cs.pr_number : null,
      branch_name: cs ? cs.branch_name : null, reviewed_head_sha: cs ? cs.reviewed_head_sha : null };
  };
  const following = (v) => v.upstream && v.upstream.following === true;
  s.pool = {
    async query(sql, params = []) {
      s.queries.push(sql);
      const one = (row) => ({ rows: row ? [row] : [], rowCount: row ? 1 : 0 });
      switch (sql) {
        case SQL.version:
        case SQL.original: return one(s.apps.get(params[0]));
        case SQL.offer: return one(offerRow(params[0]));
        case SQL.saveOffer: {
          const [app_id, from_app_id, from_sha, state, theirs_sha, session_id, facts, brings, keeps, conflicts, error] = params;
          s.offers.set(app_id, { app_id, from_app_id, from_sha, state, theirs_sha, session_id,
            facts: JSON.parse(facts), brings: JSON.parse(brings), keeps: JSON.parse(keeps), conflicts: JSON.parse(conflicts), error });
          return one(null);
        }
        case SQL.setState: { const o = s.offers.get(params[0]); if (o) Object.assign(o, { state: params[1], error: params[2] }); return one(o); }
        case SQL.setError: { const o = s.offers.get(params[0]); if (o) o.error = params[1]; return one(o); }
        case SQL.clearAvailable: { const o = s.offers.get(params[0]); if (o && o.state === 'available') s.offers.delete(params[0]); return one(null); }
        case SQL.openSession: {
          const open = [...s.sessions.values()].filter((c) => c.app_id === params[0] && c.upstream_from_app_id
            && ['active', 'promoted', 'merging'].includes(c.status));
          return one(open[open.length - 1]);
        }
        case SQL.session: {
          const c = s.sessions.get(params[0]);
          return one(c ? { ...c, repo_url: s.apps.get(c.app_id).repo_url, app_slug: s.apps.get(c.app_id).slug } : null);
        }
        case SQL.insertSession: {
          const [app_id, user_id, branch_name, pr_number, pr_url, pr_title, pr_body, upstream_from_app_id] = params;
          if ([...s.sessions.values()].some((c) => c.app_id === app_id && c.upstream_from_app_id
            && ['active', 'promoted', 'merging'].includes(c.status))) {
            throw Object.assign(new Error('duplicate key'), { code: '23505' });
          }
          const id = s.nextSession++;
          s.sessions.set(id, { id, app_id, user_id, branch_name, pr_number, pr_url, pr_title, pr_body, upstream_from_app_id,
            status: 'active', source: 'maintenance', shared_at: 'now', approval_epoch: 0 });
          return one({ id });
        }
        case SQL.sessionBody: { const c = s.sessions.get(params[0]); if (c) c.pr_body = params[1]; return one(null); }
        case SQL.epoch: return one({ approval_epoch: (s.sessions.get(params[0]) || {}).approval_epoch || 0 });
        case SQL.updateMerges: return { rows: (s.updateMerges.get(params[0]) || []).map((x) => ({ merge_commit_sha: x })) };
        case SQL.members: return { rows: (s.members.get(params[0]) || []).map((user_id) => ({ user_id })) };
        case SQL.fitRequest: {
          const hits = s.requests.filter((r) => r.app_id === params[0] && r.body.includes(params[1])).sort((a, b) => b.number - a.number);
          return one(hits[0]);
        }
        case SQL.insertIssue: { s.issues.push(params); return one({ id: s.issues.length }); }
        case SQL.mark: {
          let n = 0;
          for (const v of s.apps.values()) {
            const o = v.upstream && s.apps.get(v.upstream.appId);
            if (!following(v) || !o || o.id === v.id || !v.repo_url || !o.main_sha || o.main_sha === v.upstream.syncedSha) continue;
            const had = s.offers.get(v.id);
            if (had && !(['skipped', 'merged'].includes(had.state) || (had.state === 'failed' && had.from_sha !== o.main_sha))) continue;
            s.offers.set(v.id, { app_id: v.id, from_app_id: o.id, from_sha: o.main_sha, state: 'available', theirs_sha: null,
              session_id: null, facts: {}, brings: [], keeps: {}, conflicts: [], error: null });
            n += 1;
          }
          return { rows: [], rowCount: n };
        }
        case SQL.dueSettle:
          return { rows: [...s.offers.keys()].map(offerRow).filter((o) => o.state === 'open' && ['merged', 'archived'].includes(o.session_status))
            .map((o) => ({ app_id: o.app_id, session_id: o.session_id, status: o.session_status })) };
        case SQL.dueFit:
          return { rows: [...s.offers.values()].filter((o) => o.state === 'needs_fit').map((o) => ({ app_id: o.app_id, from_sha: o.from_sha })) };
        case SQL.dueRefresh:
          return { rows: [...s.offers.keys()].map(offerRow)
            .filter((o) => o.state === 'open' && ['active', 'promoted'].includes(o.session_status)
              && s.apps.get(o.from_app_id).main_sha && s.apps.get(o.from_app_id).main_sha !== o.from_sha)
            .map((o) => ({ app_id: o.app_id, main_sha: s.apps.get(o.from_app_id).main_sha })) };
        case SQL.dueOpen:
          return { rows: [...s.offers.values()].filter((o) => o.state === 'available').map((o) => ({ app_id: o.app_id, from_sha: o.from_sha })) };
        case SQL.changeView: {
          const c = s.sessions.get(params[0]);
          if (!c || !c.upstream_from_app_id) return one(null);
          const o = s.apps.get(c.upstream_from_app_id);
          const off = [...s.offers.values()].find((x) => x.app_id === c.app_id && x.session_id === c.id);
          return one({ id: c.id, status: c.status, from_slug: o.slug, from_name: o.name, from_emoji: o.icon_emoji,
            state: off ? off.state : null, brings: off ? off.brings : null, facts: off ? off.facts : null,
            keeps: off ? off.keeps : null, conflicts: off ? off.conflicts : null });
        }
        default:
          if (/UPDATE apps SET upstream = COALESCE\(upstream/.test(sql)) {
            const app = s.apps.get(params[0]);
            app.upstream = { ...(app.upstream || {}), ...JSON.parse(params[1]) };
            return { rows: [{ upstream: app.upstream }], rowCount: 1 };
          }
          throw new Error(`unstubbed: ${String(sql).slice(0, 80)}`);
      }
    },
  };
  return s;
}

function seed(fx, { following = true, active = [MEMBER.id] } = {}) {
  const s = store();
  const original = {
    id: 3, slug: fx.orig, name: 'Tier list', icon_emoji: '🏆', icon_image_id: null, main_sha: fx.fromSha,
    repo_url: `https://git.example.test/apps/${fx.orig}`, view_visibility: 'public', collab_visibility: 'public',
    created_by: PLATFORM_ID, self_hosted: false, moderation_suspended_at: null, upstream: null,
  };
  const version = {
    id: 12, slug: fx.ver, name: 'Our cities', repo_url: `https://git.example.test/apps/${fx.ver}`, main_sha: fx.ownSha,
    community_id: 120, created_by: MEMBER.id, view_visibility: 'private', collab_visibility: 'private', self_hosted: false,
    moderation_suspended_at: null,
    upstream: { appId: 3, slug: fx.orig, following, syncedSha: fx.syncedSha, baseSha: fx.baseSha, share: false },
  };
  s.apps.set(3, original);
  s.apps.set(12, version);
  s.members.set(12, [MEMBER.id, PLATFORM_ID, 6]);
  const calls = { prs: [], closedPrs: [], updatedPrs: [], promotes: [], closes: [], reconciles: [], notified: [], issues: [], asks: [], notes: [] };
  const deps = {
    gitHost,
    github: {
      createPR: async (owner, repo, args) => {
        calls.prs.push({ owner, repo, ...args });
        return { number: 7 + calls.prs.length - 1, html_url: `https://homeroom.test/#app/${repo}/dev/changes/7`, title: args.title };
      },
      findOpenPrByBranch: async () => null,
      closePR: async (_o, _r, n) => { calls.closedPrs.push(n); },
      updatePR: async (_o, _r, n, args) => { calls.updatedPrs.push({ n, ...args }); },
      createIssue: async (owner, repo, args) => {
        const number = 40 + calls.issues.length;
        calls.issues.push({ owner, repo, ...args });
        s.requests.push({ app_id: 12, number, body: args.body, state: 'open', state_reason: null });
        return { number };
      },
    },
    enabled: async () => true,
    resolveLegacy: async () => null,
    platformUserId: async () => PLATFORM_ID,
    promote: async (p) => {
      calls.promotes.push(p);
      s.sessions.get(p.sessionId).status = 'promoted';
      s.sessions.get(p.sessionId).reviewed_head_sha = p.expectedHead;
      return { status: 200, body: { ok: true } };
    },
    close: async (p) => {
      calls.closes.push(p);
      s.sessions.get(p.sessionId).status = 'archived';
      return { status: 'accepted' };
    },
    reconcileHead: async (args) => { calls.reconciles.push(args); },
    activeUserIds: async (_pool, id) => (id === 12 ? active : []),
    canManage: async (_pool, app, user) => !!user && user.id === app.created_by,
    canView: async () => true,
    room: async () => true,
    notifyReady: async (_pool, args) => { calls.notified.push(args); return args.recipientIds; },
    askBot: async (_pool, args) => { calls.asks.push(args); return { ok: true }; },
    noteIssue: (args) => { calls.notes.push(args); },
    ws: { sendSystemMessage: async () => {}, pushIssueUpdate() {} },
  };
  return { s, deps, calls, version, original };
}

const ref = (name, r) => {
  try {
    return execFileSync('git', ['--git-dir', `${root}/host/apps/${name}.git`, 'rev-parse', '--verify', '-q', r]).toString().trim();
  } catch {
    return null;
  }
};

test('open: the branch and theirs pushed, the platform\'s proposal made and promoted, and its members told', async () => {
  const fx = fixture();
  const { s, deps, calls } = seed(fx);
  const out = await offers.openUpdate({ config: {}, pool: s.pool, versionId: 12, deps });
  assert.equal(out.ok, true);
  assert.equal(out.state, 'open');
  const sessionId = out.sessionId;

  const branch = `homeroom/update-${fx.fromSha.slice(0, 12)}`;
  const head = ref(fx.ver, `refs/heads/${branch}`);
  assert.ok(head, 'the update\'s branch is on the version\'s repository');
  const offerRef = ref(fx.ver, 'refs/homeroom/offer');
  assert.equal(execFileSync('git', ['--git-dir', `${root}/host/apps/${fx.ver}.git`, 'rev-parse', `${offerRef}^`]).toString().trim(), fx.baseSha,
    'theirs waits under refs/homeroom/offer, on the version\'s base');

  assert.deepEqual(calls.prs.map((p) => [p.owner, p.repo, p.branch, p.title]), [['apps', fx.ver, branch, 'Update from Tier list']]);
  const session = s.sessions.get(sessionId);
  assert.equal(session.source, 'maintenance');
  assert.equal(session.user_id, PLATFORM_ID, 'the platform\'s, holding nobody\'s slot');
  assert.equal(session.upstream_from_app_id, 3);
  assert.equal(session.pr_number, 7);
  assert.equal(session.branch_name, branch);

  assert.equal(calls.promotes.length, 1);
  assert.deepEqual({ ...calls.promotes[0], source: calls.promotes[0].source.kind }, {
    sessionId, appId: 12, userId: PLATFORM_ID, username: 'Homeroom', from: 'active', cap: 1_000_000,
    pr: { state: 'open', draft: false, merged: false, head }, expectedHead: head, source: 'system',
  });
  assert.deepEqual(calls.notified.map((n) => [n.appId, n.sessionId, n.recipientIds, n.sourceUserId]),
    [[12, sessionId, [MEMBER.id, 6], null]], 'every member but the platform itself');

  const row = s.offers.get(12);
  assert.equal(row.state, 'open');
  assert.equal(row.session_id, sessionId);
  assert.equal(row.theirs_sha, offerRef);
  assert.equal(row.from_sha, fx.fromSha);
  assert.deepEqual(row.brings.map((b) => b.title), ['Add a shuffle button', 'Keep scores', 'Ask for a cat key']);
  assert.deepEqual(row.keeps, { count: 1, titles: ['Our colours'] });
  assert.deepEqual(row.facts.tablesAdded, ['scores']);

  const again = await offers.openUpdate({ config: {}, pool: s.pool, versionId: 12, deps });
  assert.deepEqual([again.ok, again.sessionId, again.already], [true, sessionId, true], 'one open update per version');
  assert.equal(calls.prs.length, 1);

  const view = await offers.changeView(s.pool, sessionId);
  assert.deepEqual(view, {
    from: { slug: fx.orig, name: 'Tier list', emoji: '🏆' },
    brings: row.brings, facts: { ...offers.EMPTY_FACTS, ...row.facts }, keeps: row.keeps, state: 'open', conflicts: [],
  });
  assert.equal(await offers.changeView(s.pool, 12345), null, 'any other change has none');
});

test('merged: the lineage moves to theirs; the next update is built on it and leaves the first one\'s merge out of keeps', async () => {
  const fx = fixture();
  const { s, deps, calls } = seed(fx);
  const first = await offers.openUpdate({ config: {}, pool: s.pool, versionId: 12, deps });
  const theirs1 = s.offers.get(12).theirs_sha;
  const head1 = ref(fx.ver, `refs/heads/homeroom/update-${fx.fromSha.slice(0, 12)}`);

  // The group took it: a squash onto main, as Homeroom merges.
  const squash = (() => {
    const vw = fs.mkdtempSync(path.join(root, 'sq-'));
    sh(vw, 'init', '-q', '-b', 'main');
    sh(vw, 'fetch', '-q', `${root}/host/apps/${fx.ver}.git`, 'main', `refs/heads/homeroom/update-${fx.fromSha.slice(0, 12)}`);
    const tree = sh(vw, 'rev-parse', `${head1}^{tree}`);
    const merged = sh(vw, 'commit-tree', tree, '-p', fx.ownSha, '-m', 'Update from Tier list (#7)');
    sh(vw, 'push', '-q', `${root}/host/apps/${fx.ver}.git`, `${merged}:refs/heads/main`);
    return merged;
  })();
  s.sessions.get(first.sessionId).status = 'merged';
  s.updateMerges.set(12, [squash]);

  assert.deepEqual(await offers.settleUpdate({ config: {}, pool: s.pool, versionId: 12, deps }), { state: 'merged' });
  assert.equal(ref(fx.ver, 'refs/homeroom/upstream'), theirs1, 'refs/homeroom/upstream keeps the new base reachable');
  assert.equal(s.apps.get(12).upstream.syncedSha, fx.fromSha);
  assert.equal(s.apps.get(12).upstream.baseSha, theirs1);
  assert.equal(s.offers.get(12).state, 'merged');
  assert.deepEqual(await offers.settleUpdate({ config: {}, pool: s.pool, versionId: 12, deps }), { skipped: 'unsettled' }, 'once');

  // The original moves again; the version made one more change of its own.
  write(fx.ow, 'app.js', 'one\ntwo, shuffled\nthree\nfour\n');
  const from2 = commitAll(fx.ow, 'Add a fourth tier (#6)');
  push(fx.ow, fx.orig);
  s.apps.get(3).main_sha = from2;

  const sweep = await offers.sweep({}, s.pool, { deps });
  assert.equal(sweep.marked, 1, 'marked as owed an update');
  assert.deepEqual(sweep.items.map((i) => [i.target, i.gen, i.input.op]), [['v12', `open-${from2.slice(0, 12)}`, 'open']]);
  const second = await offers.work({}, s.pool, sweep.items[0].input, { deps });
  assert.equal(second.state, 'open');
  const row = s.offers.get(12);
  assert.deepEqual(row.brings.map((b) => b.title), ['Add a fourth tier'], 'only what is new since the last update');
  assert.deepEqual(row.keeps, { count: 1, titles: ['Our colours'] }, 'the first update\'s merge is not the version\'s own change');
  const head2 = ref(fx.ver, `refs/heads/homeroom/update-${from2.slice(0, 12)}`);
  assert.equal(show(fx.ver, head2, 'app.js'), 'one\ntwo, shuffled\nthree\nfour\n');
  assert.equal(show(fx.ver, head2, 'style.css'), 'body { color: teal; }\n');
  assert.equal(calls.prs.length, 2);
});

test('closed without merging: not taken, and the lineage moves past it so it is not offered again', async () => {
  const fx = fixture();
  const { s, deps } = seed(fx);
  const out = await offers.openUpdate({ config: {}, pool: s.pool, versionId: 12, deps });
  s.sessions.get(out.sessionId).status = 'archived';
  const sweep = await offers.sweep({}, s.pool, { deps });
  assert.deepEqual(sweep.items.map((i) => [i.target, i.gen, i.input.op]), [['v12', undefined, 'settle']], 'settled every run until done');
  assert.deepEqual(await offers.work({}, s.pool, sweep.items[0].input, { deps }), { state: 'skipped' });
  assert.equal(s.apps.get(12).upstream.syncedSha, fx.fromSha);
  assert.equal((await offers.sweep({}, s.pool, { deps })).items.length, 0, 'nothing more is owed');
});

test('skip: the proposal closed and the lineage moved past it without changing any code', async () => {
  const fx = fixture();
  const { s, deps, calls } = seed(fx);
  const before = ref(fx.ver, 'refs/heads/main');
  const out = await offers.openUpdate({ config: {}, pool: s.pool, versionId: 12, deps });
  const theirs = s.offers.get(12).theirs_sha;
  const skipped = await offers.skipUpdate({ config: {}, pool: s.pool, versionId: 12, user: MEMBER, deps });
  assert.deepEqual(skipped, { ok: true, state: 'skipped' });
  assert.deepEqual(calls.closes.map((c) => [c.sessionId, c.reason, c.from, c.userId, c.username, c.source.kind]),
    [[out.sessionId, 'update-skipped', 'promoted', null, 'ada', 'route']]);
  assert.equal(ref(fx.ver, 'refs/homeroom/upstream'), theirs);
  assert.equal(ref(fx.ver, 'refs/heads/main'), before, 'main is untouched');
  assert.deepEqual([s.apps.get(12).upstream.syncedSha, s.apps.get(12).upstream.baseSha], [fx.fromSha, theirs]);
  assert.equal(s.offers.get(12).state, 'skipped');

  const nothing = await offers.skipUpdate({ config: {}, pool: s.pool, versionId: 12, user: MEMBER, deps });
  assert.equal(nothing.status, 409);
  assert.equal(nothing.body.code, 'nothing_to_skip');
});

test('skip: an update going in right now cannot be skipped', async () => {
  const fx = fixture();
  const { s, deps } = seed(fx);
  await offers.openUpdate({ config: {}, pool: s.pool, versionId: 12, deps });
  deps.close = async () => ({ status: 'rejected', reason: 'merging' });
  const out = await offers.skipUpdate({ config: {}, pool: s.pool, versionId: 12, user: MEMBER, deps });
  assert.equal(out.body.code, 'merging');
  assert.equal(out.body.error, offers.MESSAGES.merging);
  assert.equal(s.offers.get(12).state, 'open');
});

test('refresh: an open update whose original moved again is planned again and its branch moved', async () => {
  const fx = fixture();
  const { s, deps, calls } = seed(fx);
  const out = await offers.openUpdate({ config: {}, pool: s.pool, versionId: 12, deps });
  const branch = `homeroom/update-${fx.fromSha.slice(0, 12)}`;
  const oldHead = ref(fx.ver, `refs/heads/${branch}`);

  write(fx.ow, 'later.js', 'module.exports = 1;\n');
  const from2 = commitAll(fx.ow, 'One more thing (#6)');
  push(fx.ow, fx.orig);
  s.apps.get(3).main_sha = from2;

  const sweep = await offers.sweep({}, s.pool, { deps });
  assert.deepEqual(sweep.items.map((i) => [i.gen, i.input.op]), [[`refresh-${from2.slice(0, 12)}`, 'refresh']]);
  const r = await offers.work({}, s.pool, sweep.items[0].input, { deps });
  assert.deepEqual(r, { op: 'refresh', state: 'open', sessionId: out.sessionId });
  const newHead = ref(fx.ver, `refs/heads/${branch}`);
  assert.notEqual(newHead, oldHead, 'the same branch, moved');
  assert.equal(show(fx.ver, newHead, 'later.js'), 'module.exports = 1;\n');
  assert.equal(s.offers.get(12).from_sha, from2);
  assert.deepEqual(s.offers.get(12).brings.map((b) => b.title).slice(-1), ['One more thing']);
  assert.equal(calls.reconciles.length, 1, 'the head moves the way any proposal\'s does (its votes clear)');
  assert.equal(calls.reconciles[0].session.id, out.sessionId);
  assert.equal(calls.reconciles[0].fresh, true);
  assert.equal(calls.updatedPrs[0].n, 7);
  assert.match(s.sessions.get(out.sessionId).pr_body, /- One more thing/);
});

test('needs_fit: a conflict waits under refs/homeroom/offer; fit files one request and asks the bot as the member', async () => {
  const fx = fixture({ conflict: true });
  const { s, deps, calls } = seed(fx);
  const out = await offers.openUpdate({ config: {}, pool: s.pool, versionId: 12, deps });
  assert.deepEqual(out, { ok: true, state: 'needs_fit' });
  assert.equal(calls.prs.length, 0, 'nothing is put up for a vote');
  const row = s.offers.get(12);
  assert.deepEqual(row.conflicts, ['app.js']);
  assert.equal(ref(fx.ver, 'refs/homeroom/offer'), row.theirs_sha);

  const fit = await offers.fitUpdate({ config: {}, pool: s.pool, versionId: 12, user: MEMBER, deps });
  assert.deepEqual(fit, { ok: true, requestNumber: 40, href: `#app/${fx.ver}/dev/issues/40`, asked: true, message: null });
  const filed = calls.issues[0];
  assert.equal(filed.title, 'Fit the update from Tier list');
  assert.equal(filed.createdBy, MEMBER.id);
  assert.match(filed.body, /- app\.js/);
  assert.match(filed.body, /- Add a shuffle button/);
  assert.match(filed.body, /fetch `refs\/homeroom\/offer`/);
  assert.match(filed.body, /```diff[\s\S]*two, shuffled[\s\S]*```/, 'the original\'s change to the file, for the bot');
  assert.ok(filed.body.includes(offers.fitMarker(12, fx.fromSha)));
  assert.doesNotMatch(filed.body, /—/);
  assert.deepEqual(calls.asks.map((a) => [a.app.id, a.user.id, a.issueNumber]), [[12, MEMBER.id, 40]]);
  assert.equal(s.issues.length, 1, 'on the board like any request');

  const again = await offers.fitUpdate({ config: {}, pool: s.pool, versionId: 12, user: MEMBER, deps });
  assert.equal(again.requestNumber, 40, 'a second press finds the first request');
  assert.equal(calls.issues.length, 1);

  deps.askBot = async () => ({ ok: false, error: 'Homeroom bot is not on for you yet.' });
  const notOn = await offers.fitUpdate({ config: {}, pool: s.pool, versionId: 12, user: MEMBER, deps });
  assert.deepEqual([notOn.ok, notOn.asked, notOn.message], [true, false, 'Homeroom bot is not on for you yet.'],
    'the request stands whatever the bot answered');
  assert.deepEqual(calls.notes.map((n) => n.issueNumber), [40]);

  // The fitted change went in and closed its request: the lineage moves.
  s.requests[0].state = 'closed';
  s.requests[0].state_reason = 'completed';
  const sweep = await offers.sweep({}, s.pool, { deps });
  assert.deepEqual(sweep.items.map((i) => i.input.op), ['settle']);
  assert.deepEqual(await offers.work({}, s.pool, sweep.items[0].input, { deps }), { state: 'merged' });
  assert.equal(s.apps.get(12).upstream.baseSha, row.theirs_sha);
});

test('needs_fit can be skipped, moving the lineage to its theirs', async () => {
  const fx = fixture({ conflict: true });
  const { s, deps } = seed(fx);
  await offers.openUpdate({ config: {}, pool: s.pool, versionId: 12, deps });
  const theirs = s.offers.get(12).theirs_sha;
  assert.deepEqual(await offers.skipUpdate({ config: {}, pool: s.pool, versionId: 12, user: MEMBER, deps }), { ok: true, state: 'skipped' });
  assert.equal(ref(fx.ver, 'refs/homeroom/upstream'), theirs);
  assert.equal(s.apps.get(12).upstream.syncedSha, fx.fromSha);
});

test('an update that changes nothing here moves the lineage with no proposal', async () => {
  const fx = fixture({ readmeOnly: true });
  const { s, deps, calls } = seed(fx);
  const out = await offers.openUpdate({ config: {}, pool: s.pool, versionId: 12, deps });
  assert.deepEqual(out, { ok: true, state: 'merged', empty: true });
  assert.equal(calls.prs.length, 0);
  assert.equal(s.apps.get(12).upstream.syncedSha, fx.fromSha);
  assert.ok(ref(fx.ver, 'refs/homeroom/upstream'));
});

test('a promote that is refused closes the platform\'s change and records why', async () => {
  const fx = fixture();
  const { s, deps, calls } = seed(fx);
  deps.promote = async () => ({ status: 409, body: { error: 'This change has no committed code on its branch yet' } });
  const out = await offers.openUpdate({ config: {}, pool: s.pool, versionId: 12, deps });
  assert.equal(out.body.code, 'plan_failed');
  assert.equal(calls.closes[0].reason, 'update-refused');
  assert.equal(s.offers.get(12).state, 'failed');
  assert.match(s.offers.get(12).error, /no committed code/);
  assert.equal(calls.notified.length, 0);
});

test('refusals: off, already current, a legacy copy that cannot be planned, no room', async () => {
  const fx = fixture();
  let { s, deps } = seed(fx);
  deps.enabled = async () => false;
  assert.equal((await offers.openUpdate({ config: {}, pool: s.pool, versionId: 12, deps })).body.code, 'versions_off');

  ({ s, deps } = seed(fx));
  s.apps.get(3).main_sha = fx.syncedSha;
  const current = await offers.openUpdate({ config: {}, pool: s.pool, versionId: 12, deps });
  assert.equal(current.body.code, 'up_to_date');
  assert.equal(current.body.error, 'This version already has everything from Tier list.');

  ({ s, deps } = seed(fx));
  s.apps.get(12).upstream = { appId: 3, slug: fx.orig, following: true, legacy: true };
  const legacy = await offers.openUpdate({ config: {}, pool: s.pool, versionId: 12, deps });
  assert.equal(legacy.body.code, 'cannot_plan');
  assert.equal(s.offers.get(12).state, 'failed', 'and is not tried again until its original moves');

  ({ s, deps } = seed(fx));
  deps.room = async () => false;
  assert.equal((await offers.openUpdate({ config: {}, pool: s.pool, versionId: 12, deps })).body.code, 'busy');

  ({ s, deps } = seed(fx));
  s.apps.get(12).upstream = null;
  assert.equal((await offers.openUpdate({ config: {}, pool: s.pool, versionId: 12, deps })).body.code, 'not_a_version');
});

test('a legacy copy resolved the first time it is needed is planned from what was found', async () => {
  const fx = fixture();
  const { s, deps } = seed(fx);
  s.apps.get(12).upstream = { appId: 3, slug: fx.orig, following: true, legacy: true };
  deps.resolveLegacy = async (_config, _pool, app) => {
    assert.equal(app.id, 12);
    return { ...lineage.readUpstream(app), syncedSha: fx.syncedSha, baseSha: fx.baseSha };
  };
  const out = await offers.openUpdate({ config: {}, pool: s.pool, versionId: 12, deps });
  assert.equal(out.state, 'open');
});

// ── 4. The clock ─────────────────────────────────────────────────────

test('the clock: nothing while versions are off, in a preview, or without the git host', async () => {
  const fx = fixture();
  const { s, deps } = seed(fx);
  deps.enabled = async () => false;
  assert.deepEqual(await offers.sweep({}, s.pool, { deps }), { off: true });
  assert.equal(s.queries.length, 0, 'not a single read');
  deps.enabled = async () => true;
  process.env.USERNODE_ENV = 'staging';
  try {
    assert.deepEqual(await offers.sweep({}, s.pool, { deps }), { off: 'unavailable' });
  } finally {
    delete process.env.USERNODE_ENV;
  }
  assert.equal(s.queries.length, 0);
});

test('the clock: following versions behind their original are marked; only ones in use are opened, while there is room', async () => {
  const fx = fixture();
  let { s, deps } = seed(fx, { following: false });
  let run = await offers.sweep({}, s.pool, { deps });
  assert.equal(run.marked, 0, 'a version that does not get its updates waits for its card');
  assert.equal(run.items.length, 0);

  ({ s, deps } = seed(fx, { active: [] }));
  run = await offers.sweep({}, s.pool, { deps });
  assert.equal(run.marked, 1);
  assert.equal(s.offers.get(12).state, 'available');
  assert.equal(run.items.length, 0, 'a dormant version waits for its hub\'s card');

  ({ s, deps } = seed(fx));
  deps.room = async () => false;
  run = await offers.sweep({}, s.pool, { deps });
  assert.deepEqual([run.marked, run.room, run.items.length], [1, false, 0], 'no room: nothing opened');

  ({ s, deps } = seed(fx));
  run = await offers.sweep({}, s.pool, { deps });
  assert.equal(run.opened, 1);
  assert.deepEqual(run.items, [{ target: 'v12', gen: `open-${fx.fromSha.slice(0, 12)}`, input: { op: 'open', appId: 12 } }]);
  assert.match(run.items[0].target, /^[A-Za-z0-9:._-]{1,160}$/, 'a target the clock machine accepts');
});

test('the clock: an open that throws marks its row failed and moves on', async () => {
  const fx = fixture();
  const { s, deps } = seed(fx);
  await offers.sweep({}, s.pool, { deps });
  deps.platformUserId = async () => { throw new Error('db hiccup'); };
  const out = await offers.work({}, s.pool, { op: 'open', appId: 12 }, { deps });
  assert.equal(out.op, 'open');
  assert.equal(s.offers.get(12).state, 'failed');
  const again = await offers.sweep({}, s.pool, { deps });
  assert.equal(again.marked, 0, 'a failure is tried again when its original moves');
  assert.deepEqual(await offers.work({}, s.pool, { op: 'nope', appId: 12 }, { deps }), { skipped: 'unknown_op' });
  assert.deepEqual(await offers.work({}, s.pool, { op: 'open', appId: 'x' }, { deps }), { skipped: 'bad_input' });
});

test('the clock job is registered for the newest build, with a target worker', () => {
  const src = read('src/workflow/clock/services.ts');
  assert.match(src, /name: 'upstream-offers', everyMs: MIN, newestOnly: true,\s+run: \(_ctx: WorkContext, \{ pool, config \}: JobDeps\) => legacy\('services\/upstream-offers'\)\.sweep\(config, pool\),\s+item: \{/);
  assert.match(src, /legacy\('services\/upstream-offers'\)\.work\(config, pool, ctx\.input\.input\)/);
});

// ── 5. The routes ────────────────────────────────────────────────────

async function mountRoutes({ s, deps, user = MEMBER }) {
  const express = require('express');
  const { upstreamRoutes } = require('../src/routes/upstream');
  const routePool = {
    async query(sql, params) {
      const text = String(sql);
      if (/^SELECT \* FROM apps WHERE slug = \$1$/.test(text)) {
        return { rows: [...s.apps.values()].filter((a) => a.slug === params[0]) };
      }
      if (/^SELECT \* FROM apps WHERE id = \$1$/.test(text)) return { rows: s.apps.has(params[0]) ? [s.apps.get(params[0])] : [] };
      if (/FROM app_collaborators WHERE app_id = \$1 AND user_id = \$2/.test(text)) {
        return { rows: params[0] === 12 && [MEMBER.id, 6].includes(params[1]) ? [{ x: 1 }] : [] };
      }
      if (/FROM user_app_blocks/.test(text)) return { rows: [] };
      if (/FROM apps a WHERE a\.slug = \$1/.test(text)) {
        const a = [...s.apps.values()].find((x) => x.slug === params[0]);
        return { rows: a ? [{ ...a, is_member: (s.members.get(a.id) || []).includes(params[1]) }] : [] };
      }
      return s.pool.query(sql, params);
    },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(upstreamRoutes({}, { pool: routePool, deps }));
  const server = await new Promise((resolve) => { const srv = app.listen(0, () => resolve(srv)); });
  const base = `http://127.0.0.1:${server.address().port}/api/apps`;
  const call = async (method, url, body, headers = { 'sec-fetch-site': 'same-origin' }) => {
    const res = await fetch(`${base}${url}`, {
      method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json() };
  };
  return { call, close: () => server.close() };
}

test('GET /upstream: the version\'s side, every field present', async () => {
  const fx = fixture();
  const { s, deps } = seed(fx);
  const { call, close } = await mountRoutes({ s, deps });
  try {
    let r = await call('GET', `/${fx.ver}/upstream`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, {
      enabled: true,
      original: { slug: fx.orig, name: 'Tier list', emoji: '🏆', iconUrl: null },
      following: true, share: false, canManage: true, private: true, behind: true, offer: null,
    });

    r = await call('POST', `/${fx.ver}/upstream/open`);
    assert.equal(r.status, 200);
    assert.equal(r.body.offer.state, 'open');
    assert.deepEqual(Object.keys(r.body.offer).sort(),
      ['brings', 'conflicts', 'facts', 'fromSha', 'href', 'keeps', 'sessionId', 'state']);
    assert.equal(r.body.offer.href, `#app/${fx.ver}/dev/changes/7`);
    assert.equal(r.body.offer.fromSha, fx.fromSha);
    assert.deepEqual(Object.keys(r.body.offer.facts).sort(),
      ['ai', 'destructive', 'hostsAdded', 'secretsAdded', 'storage', 'tablesAdded']);

    const again = await call('POST', `/${fx.ver}/upstream/open`);
    assert.equal(again.body.offer.sessionId, r.body.offer.sessionId, 'an update already up is answered as it stands');

    assert.equal((await call('GET', '/nope/upstream')).status, 404);
    assert.equal((await call('POST', `/${fx.ver}/upstream/open`, null, { 'sec-fetch-site': 'same-site' })).status, 403,
      'only the Homeroom page itself');

    r = await call('POST', `/${fx.ver}/upstream/share`, { share: 'yes' });
    assert.equal(r.status, 400);
    r = await call('POST', `/${fx.ver}/upstream/share`, { share: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.share, true);
    assert.equal(s.apps.get(12).upstream.share, true);

    r = await call('POST', `/${fx.ver}/upstream/skip`);
    assert.equal(r.status, 200);
    assert.equal(r.body.offer.state, 'skipped');
    assert.equal(r.body.behind, false, 'the lineage is past it');
    r = await call('POST', `/${fx.ver}/upstream/fit`);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'nothing_to_fit');
  } finally {
    close();
  }
});

test('routes: share is for managers; a non-member is asked to join; a project that is no version says so', async () => {
  const fx = fixture();
  const { s, deps } = seed(fx);
  s.apps.get(12).view_visibility = 'public';
  s.apps.get(12).collab_visibility = 'public';
  const other = await mountRoutes({ s, deps, user: { id: 6, username: 'bo' } });
  try {
    const r = await other.call('POST', `/${fx.ver}/upstream/share`, { share: true });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'not_manager');
  } finally {
    other.close();
  }
  const stranger = await mountRoutes({ s, deps, user: { id: 77, username: 'zed' } });
  try {
    const r = await stranger.call('POST', `/${fx.ver}/upstream/skip`);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'join_required');
    const read = await stranger.call('GET', `/${fx.ver}/upstream`);
    assert.equal(read.status, 200, 'reading takes view access only');
    assert.equal(read.body.canManage, false);
  } finally {
    stranger.close();
  }
  s.apps.get(12).upstream = null;
  const owner = await mountRoutes({ s, deps });
  try {
    const r = await owner.call('GET', `/${fx.ver}/upstream`);
    assert.deepEqual(r.body, { enabled: true, original: null, following: false, share: false, canManage: true, private: false, behind: false, offer: null });
    assert.equal((await owner.call('POST', `/${fx.ver}/upstream/share`, { share: true })).body.code, 'not_a_version');
  } finally {
    owner.close();
  }
});

test('routes: the doors are in the order every route that writes a repository mounts them', () => {
  const src = read('src/routes/upstream.js');
  for (const op of ['open', 'skip', 'fit']) {
    assert.match(src, new RegExp(`'/api/apps/:slug/upstream/${op}',\\s+drainGuard, githubLookupLimiter, sameOriginBrowserOnly, requireAppMembership,`));
  }
  assert.match(src, /'\/api\/apps\/:slug\/upstream\/share', sameOriginBrowserOnly,/);
  assert.match(read('server.js'), /require\('\.\/src\/routes\/upstream'\)\.upstreamRoutes\(config\)/);
});

// ── 6. The change page and the words ─────────────────────────────────

test('the change page carries the update\'s block in the proposal read and the session details', () => {
  assert.match(read('src/routes/votes.js'), /proposal\.upstream = await require\('\.\.\/services\/upstream-offers'\)\.changeView\(pool, proposal\.id\);/);
  assert.match(read('src/routes/sessions.js'), /detail\.upstream = await require\('\.\.\/services\/upstream-offers'\)\.changeView\(pool, session\.id\);/);
});

test('the words people read: plain, no em dashes, none of the words the screens never say', () => {
  const said = [
    ...Object.values(offers.MESSAGES).map((m) => (typeof m === 'function' ? m('Tier list') : m)),
    ...Object.values(offers.describe({
      originalName: 'Tier list', versionName: 'Our cities', brings: [{ title: 'A' }],
      facts: { ...offers.EMPTY_FACTS, tablesAdded: ['t'], destructive: ['DROP TABLE x;'], hostsAdded: ['h.io'], secretsAdded: ['K'], ai: true, storage: true },
      keeps: { count: 2, titles: [] },
    })),
  ];
  for (const text of said) {
    assert.doesNotMatch(text, /—/, text);
    assert.doesNotMatch(text, /\b(remix|template|upstream|fork|merge|offer|sync)/i, text);
  }
});
