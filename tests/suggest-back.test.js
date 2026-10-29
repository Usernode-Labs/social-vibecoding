'use strict';

// "Suggest to <original>": a version's owner sends its own changes to the
// project it was made from, as a proposal there (docs/plans/versions.md,
// "Suggestions up").
//
//   src/services/suggest-back.js   the rules, the patch and the chain
//   src/routes/suggest-back.js     GET (the confirmation) and POST (send)
//   frontend/src/features/dev-board/suggest-back-dialog.tsx and the ⋯ row
//                                  in ./actions-row.tsx
//
// Pinned here:
//   1. what is sent: each picked commit of the version's own, with the
//      paths that never travel left out and dapp.json's name, visibility,
//      admins, governance, description and followOriginal kept as the
//      ORIGINAL's, applying at the original's synced commit with
//      `git am --3way` (real git, local repositories); a pick that builds on
//      a change that was not picked is refused in words saying so;
//   2. the guards, in the order a person meets them: owner only, copies
//      made before the lineage commits existed, the original gone, not a
//      collaborator ("Ask to join to suggest changes."), not a member
//      (`join_required` for the original), the proposal cap, one open
//      suggestion per version, the picks, the patch bounds, and a patch that
//      no longer applies;
//   3. what lands: an imported, active proposal owned by the version's
//      owner, tagged with the version, titled "Suggested by <version>",
//      whose preview and checks start;
//   4. the link read from apps.upstream (a legacy one resolved first), and
//      the updates the version took left out of "your changes";
//   5. the route's doors (same-origin, the membership gate, 201/refusals);
//   6. the dialog's words and who the ⋯ offers the row to.
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
const suggestBackOperation = require('../src/services/suggest-back-operation');
const { inlineOperations } = require('./lib/inline-operations');
const kernelSteps = require('../src/workflow/kernel/steps.ts');
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

test('dapp.json: the version\'s name, visibility, admins, governance, description and following stay behind', () => {
  assert.deepEqual([...suggestBack.EXCLUDED_MANIFEST_KEYS],
    ['name', 'visibility', 'admins', 'governance', 'description', 'followOriginal']);
  assert.deepEqual([...suggestBack.EXCLUDED_PATHS],
    ['words.json', '.claude/homeroom-canonical-repo', 'README.md', 'CLAUDE.md', 'LICENSE']);
  const base = JSON.stringify({ name: 'Book Club (remix)', description: 'Read together' });
  const onlyExcluded = JSON.stringify({
    name: 'Renamed', description: 'Read with friends', followOriginal: false,
    visibility: { build: 'public', view: 'public' }, admins: ['me'], governance: { approvers: 'invited' },
  });
  assert.deepEqual(suggestBack.mergeManifest(base, onlyExcluded, '{}'), { changed: false },
    'a rename, a new description or an audience change is not a change to the original');

  const target = JSON.stringify({ name: 'Book Club', admins: ['owner'], description: 'Read together', tests: [1] });
  const head = JSON.stringify({ name: 'Renamed', description: 'Mine', icon: { emoji: '📚' } });
  const merged = suggestBack.mergeManifest(base, head, target);
  assert.equal(merged.changed, true);
  assert.deepEqual(merged.keys, ['icon']);
  assert.deepEqual(JSON.parse(merged.text), {
    name: 'Book Club', admins: ['owner'], description: 'Read together', tests: [1], icon: { emoji: '📚' },
  }, 'the original keeps its own name, admins and description; the version\'s other changes carry over');
  assert.deepEqual(Object.keys(JSON.parse(merged.text)), ['name', 'admins', 'description', 'tests', 'icon'],
    'the original\'s key order, new keys after it');

  const removed = suggestBack.mergeManifest(JSON.stringify({ name: 'x', tests: [1] }), JSON.stringify({ name: 'x' }), target);
  assert.equal('tests' in JSON.parse(removed.text), false, 'a key the version removed is removed');
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

function commitAll(dir, message) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
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
  fs.writeFileSync(path.join(orig, 'list.js'), 'const books = [];\n');
  fs.writeFileSync(path.join(orig, 'README.md'), '# Book Club\n');
  const sourceSha = commitAll(orig, 'init');

  // The version, as app-forker leaves it: the same tree, renamed, with its
  // own canonical-repo pointer, as one history-free commit.
  fs.mkdirSync(copy);
  git(copy, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(copy, 'app.js'), 'console.log("hi");\n');
  fs.writeFileSync(path.join(copy, 'list.js'), 'const books = [];\n');
  fs.writeFileSync(path.join(copy, 'README.md'), '# Book Club\n');
  fs.writeFileSync(path.join(copy, 'dapp.json'), `${JSON.stringify({
    name: 'Book Club (remix)', description: 'Read together', followOriginal: true,
  }, null, 2)}\n`);
  fs.mkdirSync(path.join(copy, '.claude'));
  fs.writeFileSync(path.join(copy, '.claude', 'homeroom-canonical-repo'), 'https://git.example.test/apps/copy\n');
  const forkBaseSha = commitAll(copy, 'Forked from book-club');

  // What its owner then changed, as three merged changes:
  //   1. code, a binary file, dapp.json (a rename and a new description,
  //      which stay behind, and an icon, which goes), its README and its
  //      repository pointer (which stay behind);
  //   2. a list of books, on its own;
  //   3. a sort on the list 2 made, so it builds on 2.
  fs.writeFileSync(path.join(copy, 'app.js'), 'console.log("hi");\nconsole.log("dark mode");\n');
  fs.writeFileSync(path.join(copy, 'icon.bin'), Buffer.from([0, 1, 2, 3, 255]));
  fs.writeFileSync(path.join(copy, 'README.md'), '# My Book Club\n');
  fs.writeFileSync(path.join(copy, 'dapp.json'), `${JSON.stringify({
    name: 'My Book Club', description: 'Read with friends', followOriginal: true,
    visibility: { build: 'private', view: 'private' }, icon: { emoji: '📚' },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(copy, '.claude', 'homeroom-canonical-repo'), 'https://git.example.test/apps/elsewhere\n');
  const darkSha = commitAll(copy, 'Add dark mode (#1)');
  fs.writeFileSync(path.join(copy, 'list.js'), 'const books = ["Dune", "Emma"];\n');
  const listSha = commitAll(copy, 'Start the list (#2)');
  fs.writeFileSync(path.join(copy, 'list.js'), 'const books = ["Dune", "Emma"].sort();\n');
  const sortSha = commitAll(copy, 'Sort the list (#3)');
  const changes = [
    { sha: darkSha, title: 'Add dark mode' },
    { sha: listSha, title: 'Start the list' },
    { sha: sortSha, title: 'Sort the list' },
  ];
  return { dir, orig, copy, sourceSha, forkBaseSha, copyHeadSha: sortSha, changes };
}

function build(fx, picks) {
  return head.withScratchRepo('suggest-test', ({ dir, git: run }) => suggestBack.buildPatch({
    git: run, dir, copyRemote: fx.copy, originalRemote: fx.orig,
    baseSha: fx.forkBaseSha, copyHeadSha: fx.copyHeadSha, syncedSha: fx.sourceSha,
    picks, changes: fx.changes,
  }));
}

// Apply it where the service applies it: the original at its synced
// commit, as an mbox, with `git am --3way`.
function applyOnOriginal(fx, patch) {
  const check = path.join(fx.dir, `check-${Math.random().toString(36).slice(2)}`);
  git(fx.dir, 'clone', '-q', fx.orig, check);
  git(check, 'checkout', '-q', '--detach', fx.sourceSha);
  const file = path.join(fx.dir, 'p.mbox');
  fs.writeFileSync(file, patch);
  git(check, 'am', '--3way', '--keep-non-patch', file);
  return check;
}

test('each picked change travels on its own, without what makes the version a different project, and applies at the synced commit', async () => {
  const fx = fixtureRepos();
  try {
    const built = await build(fx, fx.changes);
    assert.deepEqual(built.files.sort(), ['app.js', 'dapp.json', 'icon.bin', 'list.js']);
    assert.deepEqual(built.manifestKeys, ['icon']);
    assert.deepEqual(built.sent, ['Add dark mode', 'Start the list', 'Sort the list']);
    assert.match(built.patch, /^From [0-9a-f]{40} /, 'an mbox, which applyPatch applies with git am');
    assert.equal((built.patch.match(/^From [0-9a-f]{40} /gm) || []).length, 4, 'one message per change, and one for dapp.json');
    assert.doesNotMatch(built.patch, /homeroom-canonical-repo|README\.md/, 'its repository pointer and README stay behind');
    assert.match(built.patch, /GIT binary patch/, 'binary-safe');
    assert.doesNotMatch(built.patch, /My Book Club|private|Read with friends|followOriginal/,
      'its name, audience, description and following stay behind');

    const check = applyOnOriginal(fx, built.patch);
    const manifest = JSON.parse(fs.readFileSync(path.join(check, 'dapp.json'), 'utf8'));
    assert.deepEqual(manifest, {
      name: 'Book Club', visibility: { build: 'public', view: 'public' }, description: 'Read together',
      icon: { emoji: '📚' },
    }, 'the original keeps its name, audience and description');
    assert.match(fs.readFileSync(path.join(check, 'app.js'), 'utf8'), /dark mode/);
    assert.equal(fs.readFileSync(path.join(check, 'list.js'), 'utf8'), 'const books = ["Dune", "Emma"].sort();\n');
    assert.equal(fs.readFileSync(path.join(check, 'README.md'), 'utf8'), '# Book Club\n');
    assert.deepEqual([...fs.readFileSync(path.join(check, 'icon.bin'))], [0, 1, 2, 3, 255]);
    assert.equal(git(check, 'log', '--format=%s', '-1', 'HEAD~1'), 'Sort the list (#3)', 'each change keeps its own message');
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('only the picked changes are sent', async () => {
  const fx = fixtureRepos();
  try {
    const built = await build(fx, [fx.changes[1]]);
    assert.deepEqual(built.files, ['list.js']);
    assert.deepEqual(built.manifestKeys, [], 'dapp.json only changed in a change that was not picked');
    const check = applyOnOriginal(fx, built.patch);
    assert.equal(fs.readFileSync(path.join(check, 'list.js'), 'utf8'), 'const books = ["Dune", "Emma"];\n');
    assert.doesNotMatch(fs.readFileSync(path.join(check, 'app.js'), 'utf8'), /dark mode/);
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('a pick that builds on a change that was not picked is refused, naming it', async () => {
  const fx = fixtureRepos();
  try {
    await assert.rejects(build(fx, [fx.changes[2]]), (err) => {
      assert.ok(err instanceof suggestBack.DependsOnUnpicked);
      assert.equal(err.pick.title, 'Sort the list');
      return true;
    });
    assert.equal(suggestBack.MESSAGES.dependsOnUnpicked('Sort the list'),
      '“Sort the list” builds on one of your changes you did not pick. Pick that one too, or leave this one out.');
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
  insertError = null, commits = [{ sha: HEAD_SHA, subject: 'Add dark mode (#1)' }], updateMerges = [],
} = {}) {
  const calls = { queries: [], applyPatch: [], createPR: [], kicks: [], cleanups: 0, closed: [], pushes: [], compared: [], resolved: [] };
  const pool = {
    async query(sql, params = []) {
      const text = String(sql);
      calls.queries.push({ sql: text, params });
      if (/SELECT \* FROM apps WHERE id = \$1/.test(text)) return { rows: original && params[0] === original.id ? [original] : [] };
      if (/suggested_from_app_id = \$1/.test(text) && /SELECT/.test(text)) return { rows: open ? [open] : [] };
      if (/upstream_from_app_id IS NOT NULL AND merge_commit_sha IS NOT NULL/.test(text)) {
        return { rows: updateMerges.map((m) => ({ merge_commit_sha: m })) };
      }
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
      compareCommitSubjects: async (owner, repo, base, headRef) => {
        calls.compared.push({ owner, repo, base, head: headRef });
        return { commits, totalCommits: commits.length, files: ['app.js', 'README.md'] };
      },
      findOpenPrByBranch: async () => null,
      createPR: async (owner, repo, args) => {
        calls.createPR.push({ owner, repo, ...args });
        return { number: 42, html_url: 'https://github.com/usernode-bot/book-club/pull/42', title: args.title, body: args.body, base: { sha: SOURCE_SHA } };
      },
      getBotUsername: async () => 'usernode-bot',
      closePR: async (owner, repo, n) => { calls.closed.push(n); },
    },
    head: {
      resolveWriteCredential: async () => ({ token: 'tok', username: 'x-access-token', source: 'installation' }),
      appRemote: (owner, repo) => `${owner}/${repo}`,
      withScratchRepo: async () => (typeof built === 'function' ? built() : built),
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
    lineage: { resolveLegacy: async (_config, _pool, app) => { calls.resolved.push(app.id); return null; } },
  };
  return { pool, deps, calls };
}

async function send(fx, { user = OWNER, fork = COPY, picks } = {}) {
  return suggestBack.suggest({ pool: fx.pool, config: {}, user, fork, picks, deps: fx.deps });
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
  assert.match(out.body.error, /made before Homeroom kept track of where a version starts/);
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
  assert.match(dup.body.error, /already suggested this version’s changes to Book Club/);
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
  assert.equal(empty.body.error, 'Your version has no changes to send since you made it.');

  const ci = await send(fixture({ built: { patch: 'x', files: ['.github/workflows/x.yml'], manifestKeys: [] } }));
  assert.equal(ci.body.code, 'forbidden_path');

  const fx = fixture({ applied: { ok: false, code: 'patch_did_not_apply', message: 'raw' } });
  const moved = await send(fx);
  assert.equal(moved.status, 409);
  assert.equal(moved.body.error, 'The original has changed too much since you made your version.');
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
  assert.equal(pr.title, 'Suggested by Book Club (remix): Add dark mode');
  assert.match(pr.body, /Suggested by \*\*Book Club \(remix\)\*\*, a version of this project, by remixer\./);
  assert.match(pr.body, /Its changes:\n\n- Add dark mode/);
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

// A work item's steps over an in-memory checkpoint, as a conductor keeps
// them: `next()` is the same send tried again.
function checkpointed() {
  let saved = null;
  let attempt = 0;
  return {
    next: () => kernelSteps.steps({ resumeFrom: saved, attempt: ++attempt, triesLeft: 3, checkpoint: async (v) => { saved = v; } }),
    saved: () => saved,
    forget: (...keys) => { saved = { ...saved }; for (const k of keys) delete saved[k]; },
  };
}

test('a send retried on a conductor pushes nothing again, opens no second PR, and finds the proposal it wrote', async () => {
  const fx = fixture();
  const made = [];
  let failInsert = 1;
  const pool = {
    async query(sql, params) {
      const text = String(sql);
      if (/SELECT id FROM chat_sessions WHERE app_id = \$1 AND pr_number = \$2 AND suggested_from_app_id = \$3/.test(text)) {
        return { rows: made.filter((r) => r.appId === params[0] && r.prNumber === params[1]).map((r) => ({ id: r.id })) };
      }
      if (/suggested_from_app_id = \$1/.test(text) && /SELECT/.test(text)) {
        return { rows: made.map((r) => ({ id: r.id, pr_number: r.prNumber, slug: 'book-club' })) };
      }
      if (/INSERT INTO chat_sessions/.test(text)) {
        if (failInsert > 0) { failInsert -= 1; throw new Error('connection reset'); }
        made.push({ id: 901, appId: params[0], prNumber: params[3] });
        return { rows: [{ id: 901 }] };
      }
      return fx.pool.query(sql, params);
    },
  };
  const send = (steps) => suggestBack.suggest({ pool, config: {}, user: OWNER, fork: COPY, deps: fx.deps, steps });

  // The proposal's row fails once, after the push and the pull request:
  // nothing is given back while tries are left, and the retry writes only
  // the row.
  const item = checkpointed();
  await assert.rejects(send(item.next()), /connection reset/);
  assert.deepEqual([fx.calls.applyPatch.length, fx.calls.createPR.length, fx.calls.closed.length, fx.calls.cleanups], [1, 1, 0, 0]);
  const out = await send(item.next());
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.sessionId, 901);
  assert.deepEqual([fx.calls.applyPatch.length, fx.calls.createPR.length, fx.calls.closed.length, fx.calls.cleanups], [1, 1, 0, 0],
    'one push, one pull request, nothing closed');
  assert.equal(made.length, 1);

  // Its row written and its step lost (the process went between the two):
  // the open suggestion is its own, and the retry finds the row it wrote.
  item.forget('session', 'topic', 'checks');
  const again = await send(item.next());
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.sessionId, 901);
  assert.equal(made.length, 1, 'no second row');
  assert.equal(fx.calls.createPR.length, 1);

  // Anybody else's open suggestion is still one.
  const other = await send(checkpointed().next());
  assert.equal(other.status, 409);
  assert.equal(other.body.code, 'already_open');
});

test('the conductor reads the send\'s authority again: an original its owner can no longer build, a version they cannot see', async () => {
  const operations = require('../src/services/platform-operations');
  const fx = fixture({ collab: false });
  const prior = suggestBackOperation._setDepsForTests(fx.deps);
  try {
    const pool = {
      async query(sql, params) {
        const text = String(sql);
        if (/FROM users WHERE id = \$1/.test(text) && /anonymised_at/.test(text)) {
          return { rows: [{ id: params[0], username: 'remixer', is_admin: false, admin_readonly: false, has_platform_access: true, private_member_since: null, anonymised_at: null }] };
        }
        if (/SELECT \* FROM apps WHERE id = \$1/.test(text) && params[0] === COPY.id) return { rows: [COPY] };
        if (/FROM app_collaborators WHERE app_id = \$1 AND user_id = \$2/.test(text)) {
          return { rows: params[0] === COPY.id && params[1] === OWNER.id ? [{ '?column?': 1 }] : [] };
        }
        return fx.pool.query(sql, params);
      },
    };
    const request = { op: 'suggestBack.open', requestId: 'r', appId: COPY.id, userId: OWNER.id, input: { picked: false } };
    const out = await operations.run({ pool, config: {} }, request);
    assert.equal(out.status, 403);
    assert.equal(out.body.code, 'collab_required');
    assert.equal(fx.calls.applyPatch.length, 0, 'nothing is built or pushed');
    const stranger = await operations.run({ pool, config: {} }, { ...request, userId: 77 });
    assert.equal(stranger.status, 404, 'a version they cannot see');
  } finally {
    suggestBackOperation._setDepsForTests(prior);
  }
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

// ── 3b. Picks, the link, and the updates the version took ────────────

const SYNCED_SHA = 'e'.repeat(40);
const VERSION_BASE_SHA = 'f'.repeat(40);
const OWN_SHA = '1'.repeat(40);
const UPDATE_SHA = '2'.repeat(40);
const RENAMED_UPDATE_SHA = '3'.repeat(40);

test('picks: all by default, only the version\'s own, never none', () => {
  const changes = [{ sha: OWN_SHA, title: 'A' }, { sha: HEAD_SHA, title: 'B' }];
  assert.deepEqual(suggestBack.choosePicks(undefined, changes).picks, changes);
  assert.deepEqual(suggestBack.choosePicks([HEAD_SHA.toUpperCase(), OWN_SHA], changes).picks, changes,
    'in the version\'s own order, whatever order they came in');
  assert.deepEqual(suggestBack.choosePicks([HEAD_SHA], changes).picks, [changes[1]]);
  assert.equal(suggestBack.choosePicks([], changes).error.body.code, 'nothing_picked');
  assert.equal(suggestBack.choosePicks(['9'.repeat(40)], changes).error.body.code, 'unknown_pick');
  assert.equal(suggestBack.choosePicks('all', changes).error.body.code, 'invalid_picks');
});

test('the confirmation lists the version\'s own changes, newest last, leaving out the updates it took', async () => {
  const fx = fixture({
    commits: [
      { sha: UPDATE_SHA, subject: 'Update from Book Club (#4)' },
      { sha: RENAMED_UPDATE_SHA, subject: 'Better colours (#5)' },
      { sha: OWN_SHA, subject: 'Start the list (#6)' },
      { sha: HEAD_SHA, subject: 'Add dark mode (#7)' },
    ],
    updateMerges: [RENAMED_UPDATE_SHA],
  });
  const view = await suggestBack.preview({ pool: fx.pool, user: OWNER, fork: COPY, deps: fx.deps });
  assert.deepEqual(view.changes, [
    { sha: OWN_SHA, title: 'Start the list' },
    { sha: HEAD_SHA, title: 'Add dark mode' },
  ], 'an update by its proposal, or by its subject, is not one of yours');
  assert.deepEqual(view.commits, ['Start the list', 'Add dark mode']);
  assert.equal(view.commitCount, 2);
  assert.equal(view.fileCount, 1, 'README.md never travels, so it is not counted');
  const updates = fx.calls.queries.find((q) => /upstream_from_app_id IS NOT NULL AND merge_commit_sha IS NOT NULL/.test(q.sql));
  assert.deepEqual(updates.params, [COPY.id]);
});

test('a version whose only commits are updates it took has nothing to send; an unread list leaves Send offered', async () => {
  let fx = fixture({ commits: [{ sha: UPDATE_SHA, subject: 'Update from Book Club (#4)' }] });
  let view = await suggestBack.preview({ pool: fx.pool, user: OWNER, fork: COPY, deps: fx.deps });
  assert.equal(view.ready, false);
  assert.deepEqual(view.reason, { code: 'no_changes', error: 'Your version has no changes to send since you made it.' });
  assert.equal((await send(fx)).body.code, 'no_changes');

  fx = fixture();
  fx.deps.github.compareCommitSubjects = async () => { throw new Error('slow'); };
  view = await suggestBack.preview({ pool: fx.pool, user: OWNER, fork: COPY, deps: fx.deps });
  assert.equal(view.ready, true, 'the send reads the list again');
  assert.equal(view.reason, null);
});

test('a send with picks the version does not have, or none, is refused before anything is built', async () => {
  const fx = fixture({ built: () => assert.fail('built') });
  assert.equal((await send(fx, { picks: ['9'.repeat(40)] })).body.code, 'unknown_pick');
  assert.equal((await send(fx, { picks: [] })).body.error, 'Pick at least one of your changes to suggest.');
  assert.equal(fx.calls.applyPatch.length, 0);
});

test('a pick that builds on an unpicked change, or one that does not fit, is refused in words', async () => {
  const pick = { sha: HEAD_SHA, title: 'Sort the list' };
  let out = await send(fixture({ built: () => { throw new suggestBack.DependsOnUnpicked(pick); } }), { picks: [HEAD_SHA] });
  assert.equal(out.status, 409);
  assert.equal(out.body.code, 'depends_on_unpicked');
  assert.match(out.body.error, /“Sort the list” builds on one of your changes you did not pick/);
  assert.equal(out.body.sha, HEAD_SHA);
  out = await send(fixture({ built: () => { throw new suggestBack.DoesNotFit(pick); } }));
  assert.equal(out.body.code, 'original_moved');
});

test('the link is read from apps.upstream: the version\'s base and the original\'s synced commit', async () => {
  const version = {
    ...COPY, forked_from: null,
    upstream: { appId: 3, slug: 'book-club', following: true, syncedSha: SYNCED_SHA, baseSha: VERSION_BASE_SHA },
  };
  const fx = fixture();
  const out = await send(fx, { fork: version });
  assert.equal(out.ok, true);
  assert.equal(fx.calls.compared[0].base, VERSION_BASE_SHA, 'its changes since its base');
  assert.equal(fx.calls.applyPatch[0].baseSha, SYNCED_SHA, 'applied where the version last took the original');
  assert.equal(fx.calls.resolved.length, 0, 'a planned link is not looked for');
});

test('a legacy link has its commits looked for first, and says so when they cannot be found', async () => {
  const legacy = { ...COPY, forked_from: null, upstream: { appId: 3, slug: 'book-club', legacy: true } };
  let fx = fixture();
  let out = await send(fx, { fork: legacy });
  assert.equal(out.body.code, 'lineage_missing');
  assert.deepEqual(fx.calls.resolved, [COPY.id]);

  fx = fixture();
  fx.deps.lineage.resolveLegacy = async () => ({ appId: 3, syncedSha: SYNCED_SHA, baseSha: VERSION_BASE_SHA, legacy: false });
  out = await send(fx, { fork: legacy });
  assert.equal(out.ok, true);
  assert.equal(fx.calls.applyPatch[0].baseSha, SYNCED_SHA);
});

test('the words people read say version, never remix or copy', () => {
  for (const [key, value] of Object.entries(suggestBack.MESSAGES)) {
    const text = typeof value === 'function' ? value('Book Club') : value;
    assert.doesNotMatch(text, /remix|\bcop(y|ies)\b|fork|upstream|template|—/i, key);
  }
  assert.equal(suggestBack.prTitle('Book Club picks', ['A', 'B']), 'Suggested by Book Club picks: A, B');
  assert.ok(suggestBack.prTitle('X', ['y'.repeat(300)]).length <= 256);
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
      // The conductor reads the version again by its id.
      if (/SELECT \* FROM apps WHERE id = \$1/.test(String(sql)) && params[0] === COPY.id) return { rows: [COPY] };
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
  // The send is a conductor's (services/suggest-back-operation.js), run here
  // in the test's own process with the same stand-ins.
  const conductor = inlineOperations({ pool: () => routePool, user: () => OWNER });
  const priorDeps = suggestBackOperation._setDepsForTests(fx.deps);
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/apps`;
  try {
    const cross = await fetch(`${base}/${COPY.slug}/suggest-back`, { method: 'POST', headers: { 'sec-fetch-site': 'same-site' } });
    assert.equal(cross.status, 403, 'a page on an app subdomain cannot send on the owner\'s behalf');
    assert.equal(fx.calls.applyPatch.length, 0);

    const missing = await fetch(`${base}/nope/suggest-back`, { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } });
    assert.equal(missing.status, 404);

    const unknown = await fetch(`${base}/${COPY.slug}/suggest-back`, {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ picks: ['9'.repeat(40)] }),
    });
    assert.equal(unknown.status, 400, 'picks are read from the body');
    assert.equal((await unknown.json()).code, 'unknown_pick');

    const ok = await fetch(`${base}/${COPY.slug}/suggest-back`, { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } });
    assert.equal(ok.status, 201);
    const body = await ok.json();
    assert.equal(body.ok, true);
    assert.equal(body.href, '#app/book-club/dev/proposals/901');

    const preview = await fetch(`${base}/${COPY.slug}/suggest-back`);
    assert.equal(preview.status, 200);
    assert.equal((await preview.json()).original.slug, 'book-club');
    assert.equal(conductor.inputs.size, 0, 'the picks the send was given are dropped once it has run');
  } finally {
    server.close();
    conductor();
    suggestBackOperation._setDepsForTests(priorDeps);
  }

  const src = read('src/routes/suggest-back.js');
  assert.match(src, /'\/api\/apps\/:slug\/suggest-back',\s+drainGuard,\s+githubLookupLimiter,\s+sameOriginBrowserOnly,\s+requireAppMembership,/);
  // The route checks and asks; the conductor writes.
  assert.match(src, /op: 'suggestBack\.open', appId: fork\.id, userId: req\.user\.id/);
  assert.doesNotMatch(src, /suggestBack\.suggest\(/);
  assert.match(read('server.js'), /require\('\.\/src\/routes\/suggest-back'\)\.suggestBackRoutes\(config\)/);
});

// ── 5. The dialog and the ⋯ row ───────────────────────────────────────

test('the ⋯ offers "Suggest to <original>" to the version\'s owner only', () => {
  const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
  const { suggestBackTarget, changeLines, versionOfApp, pickableChanges } = loadTsx('frontend/src/features/dev-board/suggest-back-dialog.tsx');
  const resolved = { ...COPY, forked_from: { appId: 3, slug: 'book-club', name: 'Book Club', linkable: true } };
  assert.deepEqual(suggestBackTarget(resolved, 5), { slug: 'book-club', name: 'Book Club' });
  assert.equal(suggestBackTarget(resolved, 6), null, 'not for anyone else');
  assert.equal(suggestBackTarget(resolved, null), null);
  assert.equal(suggestBackTarget({ ...resolved, forked_from: null }, 5), null, 'not for an app that is not a copy');
  assert.equal(suggestBackTarget({ ...resolved, forked_from: { ...resolved.forked_from, linkable: false } }, 5), null,
    'not when the original is gone');
  // Versions (docs/plans/versions.md): a ready-made version has no
  // `forked_from`; the one-app read's `upstream_link` links it, and wins.
  const linked = { ...COPY, forked_from: null, upstream_link: { slug: 'tier-list', name: 'Tier list', following: true, linkable: true } };
  assert.deepEqual(suggestBackTarget(linked, 5), { slug: 'tier-list', name: 'Tier list' });
  assert.deepEqual(versionOfApp(linked), { slug: 'tier-list', name: 'Tier list', following: true });
  assert.deepEqual(versionOfApp(resolved), { slug: 'book-club', name: 'Book Club', following: false },
    'an older server\'s forked_from says nothing of updates');
  assert.equal(versionOfApp({ ...linked, upstream_link: { ...linked.upstream_link, linkable: false } }), null);
  assert.deepEqual(pickableChanges({ changes: [{ sha: 'a1', title: 'Rate out of 10' }, { sha: '', title: 'x' }] }), [{ sha: 'a1', title: 'Rate out of 10' }]);
  assert.deepEqual(pickableChanges({}), [], 'an older server has no pick list');

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
    assert.match(html, />Suggest to Book Club</);
    assert.match(html, />Pick which of your changes to send</);
    assert.match(html, /data-plus="updates"/, 'and Updates from <original>');
    assert.match(html, />Updates from Book Club</);
    assert.match(html, />Doesn’t get its updates</);
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
    slug: 'book-club-picks', copyName: 'Book club picks', original: { slug: 'book-club', name: 'Book Club' }, onClose() {},
  }));
  const text = html.replace(/<[^>]*>/g, '').replace(/&#x27;/g, "'");
  assert.match(text, /Suggest to Book Club/);
  // An original the platform approves keeps a suggestion in review rather
  // than putting it to a vote, so the words promise no vote.
  assert.match(text, /Pick the changes to send\. They go to Book Club as a suggestion, for the people who decide its changes to try\./);
  assert.match(text, /Your name and words stay yours\. Not sent: Book club picks’s name, who can see it, its admins or its data\./);
  assert.match(text, /If it goes in, every version that gets Book Club’s updates is given it, yours included\./);
  assert.doesNotMatch(text, /remix|rewrite|reword/i, 'it promises nothing about rewording the changes');
  assert.match(text, /Loading your changes…/, 'the list loads after the dialog opens, never in a render');
  assert.match(html, />Cancel</);
  assert.match(html, /data-suggest-send="true" disabled=""[^>]*>Send to Book Club</, 'Send waits for the list');
  assert.doesNotMatch(text, /—/, 'no em dashes in the copy');
});
