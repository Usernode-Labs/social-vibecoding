'use strict';

// "Suggest this back": a remix's owner sends the copy's changes to the app it
// was copied from, as a proposal there.
//
//   src/services/suggest-back.js   the rules, the diff and the chain
//   src/routes/suggest-back.js     GET (the confirmation) and POST (send)
//   frontend/src/features/dev-board/suggest-back-dialog.tsx and the ⋯ row
//                                  in ./actions-row.tsx
//
// Pinned here:
//   1. what is sent: the diff from the copy's first commit to its main, with
//      `.claude/homeroom-canonical-repo` left out and dapp.json's name,
//      visibility, admins and governance kept as the ORIGINAL's, applying
//      at the original's source commit (real git, local repositories);
//   2. the guards, in the order a person meets them: owner only, copies
//      made before the lineage commits existed, the original gone, not a
//      collaborator ("Ask to join to suggest changes."), not a member
//      (`join_required` for the original), the proposal cap, one open
//      suggestion per copy, the patch bounds, and a patch that no longer
//      applies ("The original has changed too much since you remixed it.");
//   3. what lands: an imported, active proposal owned by the copy's owner,
//      tagged with the copy, whose preview and checks start;
//   4. the route's doors (same-origin, the membership gate, 201/refusals);
//   5. the dialog's words and who the ⋯ offers the row to.
//
// Run with: node --test tests/suggest-back.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const suggestBack = require('../src/services/suggest-back');
const head = require('../src/services/external-agent-head');
const github = require('../src/services/github');
const communities = require('../src/services/communities');

const SOURCE_SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const HEAD_SHA = 'c'.repeat(40);
const APPLIED_SHA = 'd'.repeat(40);

// ── 1. Pure rules ────────────────────────────────────────────────────

test('lineage: a copy needs both recorded commits; older copies are told why', () => {
  assert.equal(suggestBack.readLineage({ forked_from: null }), null, 'not a copy');
  const old = suggestBack.readLineage({ forked_from: { appId: 3, slug: 'book-club' } });
  assert.equal(old.complete, false, 'a copy made before the lineage commits existed');
  const full = suggestBack.readLineage({
    forked_from: JSON.stringify({ appId: 3, slug: 'book-club', sourceSha: SOURCE_SHA.toUpperCase(), forkBaseSha: BASE_SHA }),
  });
  assert.deepEqual(full, { appId: 3, slug: 'book-club', sourceSha: SOURCE_SHA, forkBaseSha: BASE_SHA, complete: true });
  assert.equal(suggestBack.readLineage({ forked_from: { appId: 3, sourceSha: 'nope', forkBaseSha: BASE_SHA } }).complete, false);
  assert.match(suggestBack.MESSAGES.lineageMissing, /made before Homeroom kept track/);
});

test('dapp.json: the copy\'s name, visibility, admins and governance stay behind', () => {
  assert.deepEqual([...suggestBack.EXCLUDED_MANIFEST_KEYS], ['name', 'visibility', 'admins', 'governance']);
  assert.deepEqual([...suggestBack.EXCLUDED_PATHS], ['.claude/homeroom-canonical-repo']);
  const base = JSON.stringify({ name: 'Book Club (remix)', description: 'Read together' });
  const onlyExcluded = JSON.stringify({
    name: 'Renamed', description: 'Read together',
    visibility: { build: 'public', view: 'public' }, admins: ['me'], governance: { approvers: 'invited' },
  });
  assert.deepEqual(suggestBack.mergeManifest(base, onlyExcluded, '{}'), { changed: false },
    'a rename or an audience change is not a change to the original');

  const target = JSON.stringify({ name: 'Book Club', admins: ['owner'], description: 'Read together', tests: [1] });
  const head = JSON.stringify({ name: 'Renamed', description: 'Read with friends', icon: { emoji: '📚' } });
  const merged = suggestBack.mergeManifest(base, head, target);
  assert.equal(merged.changed, true);
  assert.deepEqual(merged.keys, ['description', 'icon']);
  assert.deepEqual(JSON.parse(merged.text), {
    name: 'Book Club', admins: ['owner'], description: 'Read with friends', tests: [1], icon: { emoji: '📚' },
  }, 'the original keeps its own name and admins; the copy\'s other changes carry over');
  assert.deepEqual(Object.keys(JSON.parse(merged.text)), ['name', 'admins', 'description', 'tests', 'icon'],
    'the original\'s key order, new keys after it');

  const removed = suggestBack.mergeManifest(JSON.stringify({ name: 'x', tests: [1] }), JSON.stringify({ name: 'x' }), target);
  assert.equal('tests' in JSON.parse(removed.text), false, 'a key the copy removed is removed');
  assert.equal(suggestBack.mergeManifest('{', '{"a":1}', '{}').unreadable, true, 'unreadable JSON is left alone');
});

test('the bounds: nothing under .github/, at most 200 files, at most 256 KB', () => {
  assert.equal(suggestBack.checkPatch({ patch: 'x', files: ['a.txt'] }), null);
  const gh = suggestBack.checkPatch({ patch: 'x', files: ['a.txt', '.github/workflows/ci.yml'] });
  assert.equal(gh.status, 400);
  assert.equal(gh.body.code, 'forbidden_path');
  assert.match(gh.body.error, /\.github\/workflows\/ci\.yml/);
  const many = suggestBack.checkPatch({ patch: 'x', files: Array.from({ length: 201 }, (_, i) => `f${i}`) });
  assert.equal(many.body.code, 'too_many_files');
  assert.match(many.body.error, /201 files/);
  const big = suggestBack.checkPatch({ patch: 'x'.repeat(256 * 1024 + 1), files: ['a'] });
  assert.equal(big.body.code, 'too_large');
  assert.equal(suggestBack.MAX_PATCH_BYTES, require('../src/services/external-agent-patch').MAX_PATCH_BYTES);
  assert.equal(suggestBack.MAX_PATCH_FILES, require('../src/services/external-agent-patch').MAX_PATCH_FILES);
});

// ── 1b. The diff, with real git ──────────────────────────────────────

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: cwd, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  }).trim();
}

function fixtureRepos() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suggest-back-'));
  const orig = path.join(dir, 'orig');
  const copy = path.join(dir, 'copy');
  fs.mkdirSync(orig);
  git(orig, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(orig, 'dapp.json'), `${JSON.stringify({
    name: 'Book Club', visibility: { build: 'public', view: 'public' }, description: 'Read together',
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(orig, 'app.js'), 'console.log("hi");\n');
  git(orig, 'add', '-A');
  git(orig, 'commit', '-q', '-m', 'init');
  const sourceSha = git(orig, 'rev-parse', 'HEAD');

  // The copy, as app-forker leaves it: the same tree, renamed, with its own
  // canonical-repo pointer, as one history-free commit.
  fs.mkdirSync(copy);
  git(copy, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(copy, 'app.js'), 'console.log("hi");\n');
  fs.writeFileSync(path.join(copy, 'dapp.json'), `${JSON.stringify({
    name: 'Book Club (remix)', description: 'Read together',
  }, null, 2)}\n`);
  fs.mkdirSync(path.join(copy, '.claude'));
  fs.writeFileSync(path.join(copy, '.claude', 'homeroom-canonical-repo'), 'https://github.com/bot/copy\n');
  git(copy, 'add', '-A');
  git(copy, 'commit', '-q', '-m', 'Forked from book-club');
  const forkBaseSha = git(copy, 'rev-parse', 'HEAD');

  // What its owner then changed: code, a binary file, dapp.json (a rename,
  // which stays behind, and a new description, which goes), and the pointer.
  fs.writeFileSync(path.join(copy, 'app.js'), 'console.log("hi");\nconsole.log("dark mode");\n');
  fs.writeFileSync(path.join(copy, 'icon.bin'), Buffer.from([0, 1, 2, 3, 255]));
  fs.writeFileSync(path.join(copy, 'dapp.json'), `${JSON.stringify({
    name: 'My Book Club', description: 'Read with friends', visibility: { build: 'private', view: 'private' },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(copy, '.claude', 'homeroom-canonical-repo'), 'https://github.com/bot/elsewhere\n');
  git(copy, 'add', '-A');
  git(copy, 'commit', '-q', '-m', 'Add dark mode');
  const copyHeadSha = git(copy, 'rev-parse', 'HEAD');
  return { dir, orig, copy, sourceSha, forkBaseSha, copyHeadSha };
}

test('the patch carries the copy\'s changes, not what makes it a different app, and applies at the source commit', async () => {
  const fx = fixtureRepos();
  try {
    const built = await head.withScratchRepo('suggest-test', ({ dir, git: run }) => suggestBack.buildPatch({
      git: run, dir, copyRemote: fx.copy, originalRemote: fx.orig,
      forkBaseSha: fx.forkBaseSha, copyHeadSha: fx.copyHeadSha, sourceSha: fx.sourceSha,
    }));
    assert.deepEqual(built.files.sort(), ['app.js', 'dapp.json', 'icon.bin']);
    assert.deepEqual(built.manifestKeys, ['description']);
    assert.doesNotMatch(built.patch, /homeroom-canonical-repo/, 'the copy\'s own repository pointer stays behind');
    assert.match(built.patch, /GIT binary patch/, 'binary-safe');
    assert.doesNotMatch(built.patch, /My Book Club|private/, 'its name and audience stay behind');
    assert.match(built.patch, /"description": "Read with friends"/);

    // Apply it where the service applies it: the original at sourceSha.
    const check = path.join(fx.dir, 'check');
    git(fx.dir, 'clone', '-q', fx.orig, check);
    git(check, 'checkout', '-q', '--detach', fx.sourceSha);
    fs.writeFileSync(path.join(fx.dir, 'p.patch'), built.patch);
    git(check, 'apply', '--3way', '--whitespace=nowarn', path.join(fx.dir, 'p.patch'));
    const manifest = JSON.parse(fs.readFileSync(path.join(check, 'dapp.json'), 'utf8'));
    assert.deepEqual(manifest, {
      name: 'Book Club', visibility: { build: 'public', view: 'public' }, description: 'Read with friends',
    }, 'the original keeps its name and audience');
    assert.match(fs.readFileSync(path.join(check, 'app.js'), 'utf8'), /dark mode/);
    assert.deepEqual([...fs.readFileSync(path.join(check, 'icon.bin'))], [0, 1, 2, 3, 255]);
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

// ── 2/3. The guards and what lands, with the chain stubbed ───────────

const ORIGINAL = {
  id: 3, slug: 'book-club', name: 'Book Club', created_by: 9, self_hosted: false,
  community_id: 30, collab_visibility: 'public', view_visibility: 'public',
  repo_url: 'https://github.com/usernode-bot/book-club',
};
const COPY = {
  id: 12, slug: 'book-club-remix', name: 'Book Club (remix)', created_by: 5, self_hosted: false,
  collab_visibility: 'private', view_visibility: 'private',
  repo_url: 'https://github.com/usernode-bot/book-club-remix', main_sha: HEAD_SHA,
  forked_from: { appId: 3, slug: 'book-club', sourceSha: SOURCE_SHA, forkBaseSha: BASE_SHA, forkedAt: '2026-10-01T00:00:00Z' },
};
const OWNER = { id: 5, username: 'remixer' };

function fixture({
  original = ORIGINAL, collab = true, member = true, cap = null, open = null,
  applied = { ok: true, branch: 'usernode/patch-u5-ts12-x', headSha: APPLIED_SHA },
  built = { patch: 'diff --git a/app.js b/app.js\n', files: ['app.js'], manifestKeys: [] },
  insertError = null,
} = {}) {
  const calls = { queries: [], applyPatch: [], createPR: [], kicks: [], cleanups: 0, closed: [], pushes: [] };
  const pool = {
    async query(sql, params = []) {
      const text = String(sql);
      calls.queries.push({ sql: text, params });
      if (/SELECT \* FROM apps WHERE id = \$1/.test(text)) return { rows: original && params[0] === original.id ? [original] : [] };
      if (/suggested_from_app_id = \$1/.test(text) && /SELECT/.test(text)) return { rows: open ? [open] : [] };
      if (/INSERT INTO chat_sessions/.test(text)) {
        if (insertError) throw insertError;
        return { rows: [{ id: 901 }] };
      }
      return { rows: [] };
    },
  };
  const deps = {
    github: {
      parseGithubUrl: github.parseGithubUrl,
      isEnabled: () => true,
      getRepoHead: async () => ({ headSha: HEAD_SHA }),
      compareCommitSubjects: async () => ({ commits: [{ sha: HEAD_SHA, subject: 'Add dark mode' }], totalCommits: 1, files: ['app.js'] }),
      createPR: async (owner, repo, args) => {
        calls.createPR.push({ owner, repo, ...args });
        return { number: 42, html_url: 'https://github.com/usernode-bot/book-club/pull/42', title: args.title, body: args.body, base: { sha: SOURCE_SHA } };
      },
      getBotUsername: async () => 'usernode-bot',
      closePR: async (owner, repo, n) => { calls.closed.push(n); },
    },
    head: {
      resolveWriteCredential: async () => ({ token: 'tok', source: 'pat' }),
      authenticatedRemote: (_t, owner, repo) => `${owner}/${repo}`,
      withScratchRepo: async () => built,
      redactToken: (m) => m,
    },
    externalAgentPatch: {
      applyPatch: async (args) => {
        calls.applyPatch.push(args);
        return applied.ok ? { ...applied, cleanup: async () => { calls.cleanups += 1; } } : applied;
      },
    },
    appAccess: {
      checkAppAccess: async (_pool, app, _user, level) => (level === 'collab' && app.id === ORIGINAL.id ? collab : true),
    },
    communities: { isMember: async () => member, joinRequiredBody: communities.joinRequiredBody },
    limits: { checkPromotedCap: async () => cap },
    topicAttrs: { selfAssignProposal: async () => {} },
    prImportSync: { kickImportedChecks: (args) => { calls.kicks.push(args); } },
    ws: { pushSessionUpdate: (p) => calls.pushes.push(p) },
  };
  return { pool, deps, calls };
}

async function send(fx, { user = OWNER, fork = COPY } = {}) {
  return suggestBack.suggest({ pool: fx.pool, config: {}, user, fork, deps: fx.deps });
}

test('only the copy\'s owner can send, and only from a copy', async () => {
  const fx = fixture();
  const stranger = await send(fx, { user: { id: 77, username: 'x' } });
  assert.equal(stranger.status, 403);
  assert.equal(stranger.body.code, 'not_owner');
  const notCopy = await send(fx, { fork: { ...COPY, forked_from: null } });
  assert.equal(notCopy.body.code, 'not_a_copy');
  assert.equal(fx.calls.applyPatch.length, 0);
});

test('a copy made before the lineage commits were recorded says so, and sends nothing', async () => {
  const fx = fixture();
  const out = await send(fx, { fork: { ...COPY, forked_from: { appId: 3, slug: 'book-club' } } });
  assert.equal(out.status, 409);
  assert.equal(out.body.code, 'lineage_missing');
  assert.match(out.body.error, /made before Homeroom kept track of where a remix starts/);
  assert.equal(out.body.original.name, 'Book Club');
  assert.equal(fx.calls.applyPatch.length, 0);
});

test('a deleted original, or the platform itself, cannot be sent to', async () => {
  assert.equal((await send(fixture({ original: null }))).body.code, 'original_gone');
  assert.equal((await send(fixture({ original: { ...ORIGINAL, self_hosted: true } }))).body.code, 'original_gone');
});

test('someone who cannot build the original is asked to join; a non-member gets the Join prompt', async () => {
  const outsider = await send(fixture({ collab: false }));
  assert.equal(outsider.status, 403);
  assert.equal(outsider.body.code, 'collab_required');
  assert.equal(outsider.body.error, 'Ask to join to suggest changes.');
  assert.deepEqual(outsider.body.app, { slug: 'book-club', name: 'Book Club' });

  const fx = fixture({ member: false });
  const notMember = await send(fx);
  assert.equal(notMember.status, 403);
  assert.equal(notMember.body.code, 'join_required', 'the fetch wrapper turns this into Join and a retry');
  assert.equal(notMember.body.app.slug, 'book-club', 'it asks to join the ORIGINAL');
  assert.equal(fx.calls.applyPatch.length, 0);

  const admin = await send(fixture({ member: false }), { user: { ...OWNER, isAdmin: true } });
  assert.equal(admin.ok, true, 'admins pass the membership gate, as everywhere');
});

test('the proposal cap and one open suggestion per copy', async () => {
  const capped = await send(fixture({ cap: { code: 'at_capacity', message: 'You already have 3 PRs up for vote.' } }));
  assert.equal(capped.status, 429);
  assert.equal(capped.body.code, 'at_capacity');

  const fx = fixture({ open: { id: 700, slug: 'book-club' } });
  const dup = await send(fx);
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, 'already_open');
  assert.match(dup.body.error, /already sent this copy’s changes to Book Club/);
  assert.equal(dup.body.open.href, '#app/book-club/dev/proposals/700');
  const read = fx.calls.queries.find((q) => /suggested_from_app_id = \$1/.test(q.sql));
  assert.match(read.sql, /status IN \('active', 'promoted', 'merging'\)/);
  assert.deepEqual(read.params, [COPY.id]);
  assert.equal(fx.calls.applyPatch.length, 0);
});

test('no changes, the patch bounds, and a patch that no longer applies', async () => {
  const fx0 = fixture();
  fx0.deps.github.getRepoHead = async () => ({ headSha: BASE_SHA });
  assert.equal((await send(fx0)).body.code, 'no_changes');

  const empty = await send(fixture({ built: { patch: '', files: [], manifestKeys: [] } }));
  assert.equal(empty.body.code, 'no_changes');
  assert.equal(empty.body.error, 'Your copy has no changes to send since you remixed it.');

  const ci = await send(fixture({ built: { patch: 'x', files: ['.github/workflows/x.yml'], manifestKeys: [] } }));
  assert.equal(ci.body.code, 'forbidden_path');

  const fx = fixture({ applied: { ok: false, code: 'patch_did_not_apply', message: 'raw' } });
  const moved = await send(fx);
  assert.equal(moved.status, 409);
  assert.equal(moved.body.error, 'The original has changed too much since you remixed it.');
  assert.equal(fx.calls.createPR.length, 0);
});

test('a sent suggestion is an active imported proposal on the original, owned by the copy\'s owner', async () => {
  const fx = fixture();
  const out = await send(fx);
  assert.equal(out.ok, true);
  assert.equal(out.sessionId, 901);
  assert.equal(out.href, '#app/book-club/dev/proposals/901');
  assert.deepEqual(out.original, { slug: 'book-club', name: 'Book Club' });

  const [applied] = fx.calls.applyPatch;
  assert.equal(applied.owner, 'usernode-bot');
  assert.equal(applied.repo, 'book-club', 'applied in the ORIGINAL\'s repository');
  assert.equal(applied.baseSha, SOURCE_SHA, 'at the commit the copy was cut from');
  assert.equal(applied.userId, OWNER.id);

  const [pr] = fx.calls.createPR;
  assert.equal(pr.branch, 'usernode/patch-u5-ts12-x');
  assert.equal(pr.title, 'Add dark mode (from Book Club (remix))');
  assert.match(pr.body, /Suggested back from \*\*Book Club \(remix\)\*\*/);
  assert.match(pr.body, /Not sent: Book Club \(remix\)’s name, who can see it, its admins or its data\./);

  const insert = fx.calls.queries.find((q) => /INSERT INTO chat_sessions/.test(q.sql));
  assert.match(insert.sql, /'active',\s+'imported'/, 'active, imported');
  const [appId, userId, branch, prNumber] = insert.params;
  assert.deepEqual([appId, userId, branch, prNumber], [ORIGINAL.id, OWNER.id, 'usernode/patch-u5-ts12-x', 42]);
  assert.equal(insert.params[6], APPLIED_SHA, 'the head the preview builds');
  assert.equal(insert.params[insert.params.length - 1], COPY.id, 'tagged with the copy it came from');

  assert.equal(fx.calls.kicks.length, 1, 'preview and checks start, as an import\'s do');
  assert.equal(fx.calls.kicks[0].session.id, 901);
  assert.equal(fx.calls.kicks[0].headSha, APPLIED_SHA);
  assert.deepEqual(fx.calls.pushes, [{ action: 'imported', sessionId: 901, appSlug: 'book-club' }]);
});

test('a race past the duplicate read meets the unique index: the stray PR is closed and its branch removed', async () => {
  const err = Object.assign(new Error('duplicate key'), { code: '23505' });
  const fx = fixture({ insertError: err });
  const out = await send(fx);
  assert.equal(out.status, 409);
  assert.equal(out.body.code, 'already_open');
  assert.deepEqual(fx.calls.closed, [42]);
  assert.equal(fx.calls.cleanups, 1);
});

test('the schema keeps one open suggestion per copy', () => {
  const schema = read('src/db/schema.sql');
  assert.match(schema, /ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS suggested_from_app_id INTEGER\s+REFERENCES apps\(id\) ON DELETE SET NULL;/);
  assert.match(schema, /CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_sessions_one_open_suggestion\s+ON chat_sessions \(suggested_from_app_id\)\s+WHERE suggested_from_app_id IS NOT NULL AND status IN \('active', 'promoted', 'merging'\);/);
});

test('the preview lists the commits, and says why Send cannot go ahead', async () => {
  const fx = fixture();
  const view = await suggestBack.preview({ pool: fx.pool, user: OWNER, fork: COPY, deps: fx.deps });
  assert.equal(view.ready, true);
  assert.deepEqual(view.commits, ['Add dark mode']);
  assert.equal(view.fileCount, 1);
  assert.deepEqual(view.original, { slug: 'book-club', name: 'Book Club' });

  const old = await suggestBack.preview({
    pool: fx.pool, user: OWNER, fork: { ...COPY, forked_from: { appId: 3, slug: 'book-club' } }, deps: fx.deps,
  });
  assert.equal(old.ready, false);
  assert.equal(old.reason.code, 'lineage_missing');

  const joinFirst = await suggestBack.preview({ pool: fixture({ member: false }).pool, user: OWNER, fork: COPY, deps: fixture({ member: false }).deps });
  assert.equal(joinFirst.ready, false);
  assert.equal(joinFirst.reason.code, 'join_required', 'the dialog still offers Send: pressing it asks to Join');
});

// ── 4. The route ──────────────────────────────────────────────────────

test('the route: same-origin only, membership-gated, 201 with the proposal', async () => {
  const express = require('express');
  const { suggestBackRoutes } = require('../src/routes/suggest-back');
  const fx = fixture();
  const routePool = {
    async query(sql, params) {
      if (/SELECT \* FROM apps WHERE slug = \$1/.test(String(sql))) {
        return { rows: params[0] === COPY.slug ? [COPY] : [] };
      }
      // The copy is Just you: its owner sees it as its one collaborator.
      if (/FROM app_collaborators WHERE app_id = \$1 AND user_id = \$2/.test(String(sql))) {
        return { rows: params[0] === COPY.id && params[1] === OWNER.id ? [{ '?column?': 1 }] : [] };
      }
      return fx.pool.query(sql, params);
    },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = OWNER; next(); });
  app.use(suggestBackRoutes({}, { pool: routePool, deps: fx.deps }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/apps`;
  try {
    const cross = await fetch(`${base}/${COPY.slug}/suggest-back`, { method: 'POST', headers: { 'sec-fetch-site': 'same-site' } });
    assert.equal(cross.status, 403, 'a page on an app subdomain cannot send on the owner\'s behalf');
    assert.equal(fx.calls.applyPatch.length, 0);

    const missing = await fetch(`${base}/nope/suggest-back`, { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } });
    assert.equal(missing.status, 404);

    const ok = await fetch(`${base}/${COPY.slug}/suggest-back`, { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } });
    assert.equal(ok.status, 201);
    const body = await ok.json();
    assert.equal(body.ok, true);
    assert.equal(body.href, '#app/book-club/dev/proposals/901');

    const preview = await fetch(`${base}/${COPY.slug}/suggest-back`);
    assert.equal(preview.status, 200);
    assert.equal((await preview.json()).original.slug, 'book-club');
  } finally {
    server.close();
  }

  const src = read('src/routes/suggest-back.js');
  assert.match(src, /'\/api\/apps\/:slug\/suggest-back',\s+drainGuard,\s+githubLookupLimiter,\s+sameOriginBrowserOnly,\s+requireAppMembership,/);
  assert.match(read('server.js'), /require\('\.\/src\/routes\/suggest-back'\)\.suggestBackRoutes\(config\)/);
});

// ── 5. The dialog and the ⋯ row ───────────────────────────────────────

test('the ⋯ offers "Suggest this back" to the copy\'s owner only', () => {
  const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
  const { suggestBackTarget, changeLines } = loadTsx('frontend/src/features/dev-board/suggest-back-dialog.tsx');
  const resolved = { ...COPY, forked_from: { appId: 3, slug: 'book-club', name: 'Book Club', linkable: true } };
  assert.deepEqual(suggestBackTarget(resolved, 5), { slug: 'book-club', name: 'Book Club' });
  assert.equal(suggestBackTarget(resolved, 6), null, 'not for anyone else');
  assert.equal(suggestBackTarget(resolved, null), null);
  assert.equal(suggestBackTarget({ ...resolved, forked_from: null }, 5), null, 'not for an app that is not a copy');
  assert.equal(suggestBackTarget({ ...resolved, forked_from: { ...resolved.forked_from, linkable: false } }, 5), null,
    'not when the original is gone');

  assert.deepEqual(changeLines({ commits: ['A', 'B'], commitCount: 5, fileCount: 3 }), ['A', 'B', 'and 3 more']);
  assert.deepEqual(changeLines({ commits: [], commitCount: 0, fileCount: 1 }), ['1 file changed']);
  assert.deepEqual(changeLines({ commits: [], commitCount: 0, fileCount: 4 }), ['4 files changed']);

  const { DevPlusMenu } = loadTsx('frontend/src/features/dev-board/actions-row.tsx');
  const props = { selfHosted: false, readOnly: false, canCollaborate: true, showsMembers: true, illustrationApp: resolved };
  const saved = globalThis.window;
  try {
    globalThis.window = { App: { user: { id: 5 } } };
    const html = renderToHtml(createElement(DevPlusMenu, props));
    assert.match(html, /data-plus="suggest-back"/);
    assert.match(html, />Suggest this back</);
    assert.match(html, />Send your changes to Book Club as a proposal</);
    globalThis.window = { App: { user: { id: 6 } } };
    assert.doesNotMatch(renderToHtml(createElement(DevPlusMenu, props)), /suggest-back/);
  } finally {
    if (saved === undefined) delete globalThis.window;
    else globalThis.window = saved;
  }
});

test('the dialog says what goes, what does not, and who votes', () => {
  const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
  const { SuggestBackDialog } = loadTsx('frontend/src/features/dev-board/suggest-back-dialog.tsx');
  const html = renderToHtml(createElement(SuggestBackDialog, {
    slug: 'book-club-remix', copyName: 'Book Club (remix)', original: { slug: 'book-club', name: 'Book Club' }, onClose() {},
  }));
  const text = html.replace(/<[^>]*>/g, '').replace(/&#x27;/g, "'");
  assert.match(text, /Suggest this back to Book Club/);
  assert.match(text, /Your changes since you remixed go to Book Club as a proposal\. Its members try it and vote, like any other change\./);
  assert.match(text, /Not sent: Book Club \(remix\)’s name, who can see it, its admins or its data\./);
  assert.match(text, /Loading your changes…/, 'the list loads after the dialog opens, never in a render');
  assert.match(html, />Cancel</);
  assert.match(html, /data-suggest-send="true" disabled=""[^>]*>Send to Book Club</, 'Send waits for the list');
  assert.doesNotMatch(text, /—/, 'no em dashes in the copy');
});
