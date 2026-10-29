'use strict';

// Copies made before versions existed, as versions (docs/plans/versions.md,
// "Remixes and lineage"):
//
//   src/services/versions-backfill.js   the clock job that links them
//   src/services/upstream-lineage.js    resolveLegacy, which finds a legacy
//                                       link's two commits when first needed
//
// Pinned here:
//   1. what each kind of copy is linked with, never following on its own;
//   2. the walk: bounded, carried on from where the last run stopped, and
//      only ever writing a row that has no link (idempotent);
//   3. resolveLegacy against real repositories on disk: the commits a remix
//      kept, a remix's first commit and its original's main when it was
//      made, and a ready-made project's starter commits;
//   4. the clock job.
//
// Run with: node --test tests/versions-lineage.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const backfill = require('../src/services/versions-backfill');
const lineage = require('../src/services/upstream-lineage');
const appTemplates = require('../src/services/app-templates');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

// ── 1. The links ──────────────────────────────────────────────────────

test('a remix that kept its commits is linked with them; one that did not is legacy', () => {
  const original = { id: 3, slug: 'book-club' };
  assert.deepEqual(
    backfill.remixLink({ appId: 3, slug: 'book-club', sourceSha: A.toUpperCase(), forkBaseSha: B, forkedAt: '2026-09-01T10:00:00.000Z' }, original),
    { appId: 3, slug: 'book-club', following: false, syncedSha: A, baseSha: B, legacy: false, since: '2026-09-01T10:00:00.000Z' });
  assert.deepEqual(
    backfill.remixLink(JSON.stringify({ appId: 3 }), original, new Date('2026-08-01T00:00:00Z')),
    { appId: 3, slug: 'book-club', following: false, legacy: true, since: '2026-08-01T00:00:00.000Z' });
  assert.deepEqual(backfill.readyMadeLink({ id: 9, slug: 'tier-list' }),
    { appId: 9, slug: 'tier-list', following: false, legacy: true });
});

// ── 2. The walk ───────────────────────────────────────────────────────

function backfillPool({ remixes = [], readyMades = [], apps = [] } = {}) {
  const calls = [];
  const linked = new Map();
  return {
    calls,
    linked,
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (/forked_from IS NOT NULL/.test(text) && /ORDER BY id/.test(text)) {
        return { rows: remixes.filter((r) => r.id > params[0] && !linked.has(r.id)).slice(0, params[1]) };
      }
      if (/template = ANY\(\$2::text\[\]\)/.test(text)) {
        return { rows: readyMades.filter((r) => r.id > params[0] && !linked.has(r.id) && params[1].includes(r.template)).slice(0, params[2]) };
      }
      if (/WHERE id = ANY\(\$1::int\[\]\) OR slug = ANY\(\$2::text\[\]\)/.test(text)) {
        return { rows: apps.filter((a) => params[0].includes(a.id) || params[1].includes(a.slug)) };
      }
      if (/WHERE original_of = ANY\(\$1::text\[\]\)/.test(text)) {
        return { rows: apps.filter((a) => a.original_of && params[0].includes(a.original_of)) };
      }
      if (/UPDATE apps SET upstream = \$2::jsonb WHERE id = \$1 AND upstream IS NULL/.test(text)) {
        if (linked.has(params[0])) return { rowCount: 0, rows: [] };
        linked.set(params[0], JSON.parse(params[1]));
        return { rowCount: 1, rows: [] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

test('remixes and ready-made projects are linked to their originals, never following', async () => {
  const readyId = appTemplates.READY_IDS[0];
  const dir = appTemplates.dirOf(readyId);
  const pool = backfillPool({
    apps: [
      { id: 3, slug: 'book-club' },
      { id: 4, slug: 'recipes' },
      { id: 50, slug: 'the-original', original_of: dir },
    ],
    remixes: [
      { id: 10, forked_from: { appId: 3, slug: 'book-club', sourceSha: A, forkBaseSha: B } },
      { id: 11, forked_from: { slug: 'recipes' } },
      { id: 12, forked_from: { appId: 999, slug: 'gone' } },
    ],
    readyMades: [
      { id: 20, template: readyId, created_at: '2026-07-01T00:00:00Z' },
    ],
  });
  const out = await backfill.run({}, pool);
  assert.deepEqual(out, { remixes: 2, readyMades: 1, remixesAfter: 0, readyMadesAfter: 0 });
  assert.deepEqual(pool.linked.get(10), { appId: 3, slug: 'book-club', following: false, syncedSha: A, baseSha: B, legacy: false });
  assert.deepEqual(pool.linked.get(11), { appId: 4, slug: 'recipes', following: false, legacy: true }, 'found by its slug');
  assert.equal(pool.linked.has(12), false, 'a deleted original is no link');
  assert.deepEqual(pool.linked.get(20), { appId: 50, slug: 'the-original', following: false, legacy: true, since: '2026-07-01T00:00:00.000Z' });

  // Again: nothing left to link, nothing written twice.
  const again = await backfill.run({}, pool);
  assert.deepEqual([again.remixes, again.readyMades], [0, 0]);
});

test('the walk is bounded and carries on from where the last run stopped', async () => {
  const remixes = Array.from({ length: 5 }, (_, i) => ({ id: 100 + i, forked_from: { appId: 3 } }));
  const pool = backfillPool({ apps: [{ id: 3, slug: 'book-club' }], remixes });
  const first = await backfill.run({}, pool, { limit: 2 });
  assert.equal(first.remixes, 2);
  assert.equal(first.remixesAfter, 101, 'a full page: the next run starts after it');
  const second = await backfill.run({}, pool, { previous: first, limit: 2 });
  assert.equal(second.remixes, 2);
  assert.equal(second.remixesAfter, 103);
  const third = await backfill.run({}, pool, { previous: second, limit: 2 });
  assert.equal(third.remixes, 1);
  assert.equal(third.remixesAfter, 0, 'a short page: back to the start');
  assert.equal(pool.linked.size, 5);
});

test('the walk reads only unlinked copies that are not being made, and never an original', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/versions-backfill.js'), 'utf8');
  assert.match(src, /WHERE id > \$1 AND upstream IS NULL AND forked_from IS NOT NULL\s+AND status <> 'creating' AND NOT self_hosted/);
  assert.match(src, /WHERE id > \$1 AND upstream IS NULL AND original_of IS NULL AND forked_from IS NULL\s+AND template = ANY\(\$2::text\[\]\)/);
});

// ── 3. resolveLegacy, with real git ───────────────────────────────────

function git(cwd, args, env = {}) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8',
    env: {
      ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: cwd,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
      ...env,
    },
  }).trim();
}

function commit(dir, file, content, message, when) {
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message], when ? { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } : {});
  return git(dir, ['rev-parse', 'HEAD']);
}

function repo(root, name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  return dir;
}

// The repositories by their address, as the mirror would hand them over.
function io(byRepo) {
  return {
    mirror: async (owner, name) => byRepo[`${owner}/${name}`],
    git: async (dir, args) => git(dir, args),
  };
}

function lineagePool(rows) {
  const writes = [];
  return {
    writes,
    async query(sql, params = []) {
      const text = String(sql);
      if (/SELECT id, upstream, forked_from, repo_url, created_at FROM apps WHERE id = \$1/.test(text)) {
        return { rows: rows[params[0]] ? [rows[params[0]]] : [] };
      }
      if (/SELECT id, repo_url FROM apps WHERE id = \$1/.test(text)) {
        return { rows: rows[params[0]] ? [rows[params[0]]] : [] };
      }
      if (/UPDATE apps SET upstream = COALESCE\(upstream, '\{\}'::jsonb\) \|\| \$2::jsonb/.test(text)) {
        const patch = JSON.parse(params[1]);
        writes.push({ id: params[0], patch });
        const row = rows[params[0]];
        row.upstream = { ...(row.upstream || {}), ...patch };
        return { rows: [{ upstream: row.upstream }] };
      }
      return { rows: [] };
    },
  };
}

test('a planned link is returned as it is; one with no original or no link is null', async () => {
  const pool = lineagePool({
    1: { id: 1, repo_url: 'https://github.com/acme/v', upstream: { appId: 2, slug: 'o', syncedSha: A, baseSha: B } },
    3: { id: 3, repo_url: 'https://github.com/acme/w', upstream: { appId: 99, legacy: true } },
    4: { id: 4, repo_url: 'https://github.com/acme/x', upstream: null },
  });
  const planned = await lineage.resolveLegacy({}, pool, { id: 1 }, io({}));
  assert.equal(planned.syncedSha, A);
  assert.equal(pool.writes.length, 0);
  assert.equal(await lineage.resolveLegacy({}, pool, { id: 3 }, io({})), null, 'its original is gone');
  assert.equal(await lineage.resolveLegacy({}, pool, { id: 4 }, io({})), null, 'not a version');
});

test('a legacy remix that kept its commits takes them, without reading a repository', async () => {
  const pool = lineagePool({
    1: { id: 1, repo_url: 'https://github.com/acme/v', upstream: { appId: 2, legacy: true }, forked_from: { appId: 2, sourceSha: A, forkBaseSha: B } },
    2: { id: 2, repo_url: 'https://github.com/acme/o' },
  });
  const out = await lineage.resolveLegacy({}, pool, { id: 1 }, { mirror: () => assert.fail('read'), git: () => assert.fail('read') });
  assert.deepEqual([out.syncedSha, out.baseSha, out.legacy], [A, B, false]);
  assert.deepEqual(pool.writes, [{ id: 1, patch: { syncedSha: A, baseSha: B, legacy: false } }]);
});

test('a remix from before its commits were kept: its first commit, and the original\'s main when it was made', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-remix-'));
  try {
    const orig = repo(root, 'orig');
    commit(orig, 'app.js', '1\n', 'one', '2026-09-01T10:00:00Z');
    const atFork = commit(orig, 'app.js', '2\n', 'two (#1)', '2026-09-02T10:00:00Z');
    commit(orig, 'app.js', '3\n', 'three (#2)', '2026-09-05T10:00:00Z');
    const copy = repo(root, 'copy');
    const first = commit(copy, 'app.js', '2\n', 'Forked from orig', '2026-09-03T10:00:00Z');
    commit(copy, 'app.js', '2\nmine\n', 'Mine (#1)', '2026-09-04T10:00:00Z');
    const pool = lineagePool({
      1: { id: 1, repo_url: 'https://github.com/acme/copy', upstream: { appId: 2, legacy: true }, forked_from: { appId: 2, forkedAt: '2026-09-03T09:00:00Z' } },
      2: { id: 2, repo_url: 'https://github.com/acme/orig' },
    });
    const out = await lineage.resolveLegacy({}, pool, { id: 1 }, io({ 'acme/copy': copy, 'acme/orig': orig }));
    assert.equal(out.baseSha, first, 'the copy\'s own first commit');
    assert.equal(out.syncedSha, atFork, 'the original\'s main when the copy was made');
    assert.equal(out.legacy, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a ready-made project from before versions: its starter commit, and the original\'s own first one', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-ready-'));
  try {
    const orig = repo(root, 'orig');
    commit(orig, 'README.md', '# Tier list\n', 'Initial commit');
    const origStarter = commit(orig, 'index.html', 'tier list\n', 'Initialize Tier list from Homeroom template');
    commit(orig, 'index.html', 'tier list 2\n', 'Better colours (#1)');
    const copy = repo(root, 'copy');
    commit(copy, 'README.md', '# Cities\n', 'Initial commit');
    const copyStarter = commit(copy, 'index.html', 'cities\n', 'Initialize City Tier List from Homeroom template');
    commit(copy, 'index.html', 'cities, sorted\n', 'Sort the cities (#1)');
    const pool = lineagePool({
      1: { id: 1, repo_url: 'https://github.com/acme/copy', upstream: { appId: 2, slug: 'tier-list', legacy: true }, forked_from: null },
      2: { id: 2, repo_url: 'https://github.com/acme/orig' },
    });
    const out = await lineage.resolveLegacy({}, pool, { id: 1 }, io({ 'acme/copy': copy, 'acme/orig': orig }));
    assert.deepEqual([out.baseSha, out.syncedSha, out.legacy, out.slug], [copyStarter, origStarter, false, 'tier-list']);

    // A repository with no starter commit cannot be planned, and is left legacy.
    const bare = repo(root, 'bare');
    commit(bare, 'x', 'x\n', 'Something else');
    const pool2 = lineagePool({
      1: { id: 1, repo_url: 'https://github.com/acme/bare', upstream: { appId: 2, legacy: true } },
      2: { id: 2, repo_url: 'https://github.com/acme/orig' },
    });
    assert.equal(await lineage.resolveLegacy({}, pool2, { id: 1 }, io({ 'acme/bare': bare, 'acme/orig': orig })), null);
    assert.equal(pool2.writes.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a repository that cannot be read is null, not a failure', async () => {
  const pool = lineagePool({
    1: { id: 1, repo_url: 'https://github.com/acme/copy', upstream: { appId: 2, legacy: true }, forked_from: { appId: 2 } },
    2: { id: 2, repo_url: 'https://github.com/acme/orig' },
  });
  const out = await lineage.resolveLegacy({}, pool, { id: 1 }, { mirror: async () => { throw new Error('clone failed'); }, git: async () => '' });
  assert.equal(out, null);
});

// ── 4. The clock job ──────────────────────────────────────────────────

test('the clock runs the backfill every ten minutes, on the newest build, from the last run\'s place', () => {
  const clocks = fs.readFileSync(path.join(__dirname, '..', 'src/workflow/clock/services.ts'), 'utf8');
  assert.match(clocks, /name: 'versions-backfill', everyMs: 10 \* MIN, newestOnly: true,/);
  assert.match(clocks, /legacy\('services\/versions-backfill'\)\.run\(config, pool, \{\s+previous: \(ctx\.input\.previous \?\? null\) as any,/);
});
