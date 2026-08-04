// Detection tests for scripts/audit-jwt-secret-readers.js.
//
// The audit is what gates deleting the `JWT_SECRET` line from
// services/app-identity-env.js (see the removal criterion there). A false
// NEGATIVE is the dangerous direction: it would report an app as clean, the
// alias would be deleted, and every user of that app would be silently logged
// out. So the patterns are pinned against the shapes real app source actually
// uses, plus the near-misses that must NOT count.
//
// The script is require()d as a module — its main() is guarded on
// require.main — so nothing connects to a database or to GitHub here.
//
// Run with: node --test tests/jwt-secret-audit.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const audit = require('../scripts/audit-jwt-secret-readers.js');

test('detects the pre-cutover scaffold shape verbatim', () => {
  // The exact two lines tests/scaffold-token-compat.test.js freezes.
  const src = [
    "const jwt = require('jsonwebtoken');",
    'const JWT_SECRET = process.env.JWT_SECRET;',
    'app.use((req, res, next) => {',
    '  const token = req.query.token;',
    '  try { req.user = jwt.verify(token, JWT_SECRET); } catch {}',
    '  next();',
    '});',
  ].join('\n');
  const hit = audit.findReader(src);
  assert.ok(hit, 'the canonical legacy shape must be found');
  assert.equal(hit.line, 2, 'and reported at the line an author can go fix');
  assert.match(hit.text, /process\.env\.JWT_SECRET/);
});

test('detects bracket access and destructuring', () => {
  assert.ok(audit.findReader("const k = process.env['JWT_SECRET'];"));
  assert.ok(audit.findReader('const k = process.env["JWT_SECRET"];'));
  assert.ok(audit.findReader('const k = process.env[`JWT_SECRET`];'));
  assert.ok(audit.findReader('const { JWT_SECRET } = process.env;'));
  assert.ok(audit.findReader('const { PORT, JWT_SECRET, DATABASE_URL } = process.env;'));
  const multiline = audit.findReader([
    'const {',
    '  PORT,',
    '  JWT_SECRET,',
    '} = process.env;',
  ].join('\n'));
  assert.equal(multiline.line, 3);
  assert.equal(multiline.text, 'JWT_SECRET,');
});

// The fallback shape the scaffold used to ship. An app generated during the
// cutover window has BOTH names, and it still depends on the alias whenever
// the platform stops setting the new one — so it counts as a reader.
test('detects the two-name fallback the old scaffold shipped', () => {
  const hit = audit.findReader(
    "const K = (process.env.USERNODE_JWT_PUBLIC_KEY || process.env.JWT_SECRET || '');"
  );
  assert.ok(hit, 'a fallback reader is still a reader');
});

test('does NOT flag an app that reads only the new name', () => {
  const src = [
    "const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')",
    "  .replace(/\\\\n/g, '\\n');",
    "const APP_AUDIENCE = 'usernode:app:' + process.env.USERNODE_APP_ID;",
  ].join('\n');
  assert.equal(audit.findReader(src), null);
});

// Near-misses. These must not count, or the audit never reaches zero and the
// alias can never be removed.
test('does NOT flag the sibling platform key names', () => {
  assert.equal(audit.findReader('const a = process.env.WORKER_JWT_SECRET;'), null);
  assert.equal(audit.findReader('const b = process.env.EDGE_JWT_SECRET;'), null);
  assert.equal(audit.findReader('const c = process.env.USERNODE_JWT_SECRET;'), null);
  assert.equal(audit.findReader('const d = process.env.JWT_SECRET_OLD;'), null,
    'a longer name is a different variable — \\b must hold the right edge');
});

test('does NOT flag a bare mention with no process.env read', () => {
  assert.equal(audit.findReader('// JWT_SECRET was removed in the RSA cutover'), null);
  assert.equal(audit.findReader('const label = "JWT_SECRET";'), null);
});

test('handles empty and non-string input without throwing', () => {
  assert.equal(audit.findReader(''), null);
  assert.equal(audit.findReader(null), null);
  assert.equal(audit.findReader(undefined), null);
});

// ── repo_url parsing ────────────────────────────────────────────────────

test('parses the repo_url shapes apps.repo_url actually holds', () => {
  assert.deepEqual(
    audit.parseRepoUrl('https://github.com/usernode-bot/whiteboard-0d337f'),
    { owner: 'usernode-bot', repo: 'whiteboard-0d337f' }
  );
  assert.deepEqual(
    audit.parseRepoUrl('https://github.com/usernode-bot/whiteboard-0d337f.git'),
    { owner: 'usernode-bot', repo: 'whiteboard-0d337f' }
  );
  assert.deepEqual(
    audit.parseRepoUrl('http://github.com/Usernode-Labs/social-vibecoding'),
    { owner: 'Usernode-Labs', repo: 'social-vibecoding' }
  );
});

test('an unparseable repo_url is null, never a wrong guess', () => {
  assert.equal(audit.parseRepoUrl(''), null);
  assert.equal(audit.parseRepoUrl(null), null);
  assert.equal(audit.parseRepoUrl('https://gitlab.com/someone/thing'), null);
});

// The entrypoint list is now an ordering optimization, not the coverage
// boundary. Full-tree tests below pin that distinction.
test('candidate entrypoints prioritize the likely readers', () => {
  assert.ok(audit.CANDIDATE_FILES.includes('server.js'),
    'every scaffold generation puts auth in server.js');
  assert.ok(audit.CANDIDATE_FILES.includes('lib/dapp-server.js'),
    'the vendored shared server is where several fleet apps keep it');
  assert.equal(audit.CANDIDATE_FILES[0], 'server.js', 'cheapest, likeliest first');
});

function encoded(source) {
  return Buffer.from(source).toString('base64');
}

function fakeGithub(files, options = {}) {
  let active = 0;
  let maxActive = 0;
  const entries = files.map((file, index) => ({
    path: file.path,
    type: file.type || 'blob',
    sha: file.sha === undefined ? `sha-${index}` : file.sha,
    ...(file.omitSize ? {} : { size: file.size === undefined ? Buffer.byteLength(file.source || '') : file.size }),
  }));
  return {
    stats: () => ({ active, maxActive }),
    async getRepoTree() {
      if (options.treeError) throw options.treeError;
      return {
        truncated: !!options.truncated,
        entries: Object.prototype.hasOwnProperty.call(options, 'entries') ? options.entries : entries,
      };
    },
    async getRepoBlob(_owner, _repo, sha) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay));
        const index = Number(String(sha).replace('sha-', ''));
        const file = files[index];
        if (!file || file.fetchError) throw file?.fetchError || new Error('missing fake blob');
        return {
          encoding: file.encoding || 'base64',
          content: file.content === undefined ? encoded(file.source || '') : file.content,
          size: file.size,
        };
      } finally {
        active -= 1;
      }
    },
  };
}

test('detects a reader outside every legacy candidate entrypoint', async () => {
  const github = fakeGithub([
    { path: 'server.js', source: 'require("./src/auth/middleware")' },
    { path: 'src/auth/middleware.js', source: 'const key = process.env.JWT_SECRET;' },
  ]);
  const result = await audit.scanRepository(github, 'owner', 'repo');
  assert.equal(result.state, 'reader');
  assert.equal(result.hit.file, 'src/auth/middleware.js');
  assert.equal(result.hit.line, 1);
});

test('reports clean only after every eligible source file is scanned', async () => {
  const github = fakeGithub([
    { path: 'server.js', source: 'require("./src/auth.js")' },
    { path: 'src/auth.js', source: 'const key = process.env.USERNODE_JWT_PUBLIC_KEY;' },
    { path: 'src/routes.ts', source: 'export const ok = true;' },
  ]);
  const result = await audit.scanRepository(github, 'owner', 'repo');
  assert.deepEqual(result, { state: 'clean', checked: 3 });
});

test('candidate ordering is deterministic without narrowing coverage', () => {
  const ordered = audit.orderSourceEntries([
    { path: 'z.js' },
    { path: 'src/server.js' },
    { path: 'a.js' },
    { path: 'server.js' },
  ]).map((entry) => entry.path);
  assert.deepEqual(ordered, ['server.js', 'src/server.js', 'a.js', 'z.js']);
});

test('excludes dependencies, generated output, fixtures, tests, assets, maps and minified files', () => {
  for (const file of [
    'node_modules/pkg/index.js', 'vendor/auth.js', 'dist/server.js', 'build/server.js',
    'coverage/raw.js', '.next/server.js', '.nuxt/server.js', '.output/server.js',
    'fixtures/auth.js', '__fixtures__/auth.js', 'test/auth.js', 'tests/auth.js',
    '__tests__/auth.js', 'public/auth.js', 'assets/auth.js', 'static/auth.js',
    'src/app.min.js', 'src/app.js.map', 'README.md', 'package-lock.json',
  ]) assert.equal(audit.isEligibleSource(file), false, file);
  for (const file of ['server.js', 'src/auth.ts', 'components/App.vue', 'routes/login.svelte']) {
    assert.equal(audit.isEligibleSource(file), true, file);
  }
  for (const file of ['vendor/auth.js', 'dist/server.js', 'build/server.ts', 'src/app.min.js']) {
    assert.equal(audit.isAmbiguousGeneratedSource(file), true, file);
  }
});

test('truncated, missing and oversized tree inventories fail closed', async () => {
  assert.equal((await audit.scanRepository(fakeGithub([], { truncated: true }), 'o', 'r')).state, 'unreadable');
  assert.equal((await audit.scanRepository(fakeGithub([], { entries: null }), 'o', 'r')).state, 'unreadable');

  const entries = Array.from({ length: 3 }, (_, i) => ({ path: `src/${i}.js`, type: 'blob', sha: `s${i}`, size: 1 }));
  const tooMany = await audit.scanRepository(fakeGithub([], { entries }), 'o', 'r', { maxTreeEntries: 2 });
  assert.match(tooMany.reason, /tree exceeds/);

  const huge = await audit.scanRepository(fakeGithub([
    { path: 'server.js', source: 'x', size: 11 },
  ]), 'o', 'r', { maxFileBytes: 10 });
  assert.match(huge.reason, /source blob exceeds/);
});

test('malformed source entries and repos with no auditable source fail closed', async () => {
  const malformed = await audit.scanRepository(fakeGithub([], {
    entries: [{ path: 'server.js', type: 'blob', sha: '' }],
  }), 'o', 'r');
  assert.equal(malformed.state, 'unreadable');
  assert.match(malformed.reason, /no blob id/);

  const absent = await audit.scanRepository(fakeGithub([
    { path: 'README.md', source: 'docs only' },
  ]), 'o', 'r');
  assert.equal(absent.state, 'unreadable');
  assert.match(absent.reason, /no eligible source/);

  const unsafe = await audit.scanRepository(fakeGithub([], {
    entries: [{ path: '../server.js', type: 'blob', sha: 'sha', size: 1 }],
  }), 'o', 'r');
  assert.match(unsafe.reason, /unsafe path/);

  const invalidSize = await audit.scanRepository(fakeGithub([], {
    entries: [{ path: 'server.js', type: 'blob', sha: 'sha', size: -1 }],
  }), 'o', 'r');
  assert.match(invalidSize.reason, /invalid size/);
});

test('generated or vendored executable source makes the audit ambiguous, never clean', async () => {
  for (const path of ['dist/server.js', 'build/auth.ts', 'vendor/runtime.js', 'src/app.min.js']) {
    const result = await audit.scanRepository(fakeGithub([{ path, source: 'const ok = true;' }]), 'o', 'r');
    assert.equal(result.state, 'unreadable');
    assert.match(result.reason, /manual corroboration/);
  }
});

test('unsupported encodings, malformed base64, binary source and fetch failures fail closed', async () => {
  const cases = [
    [{ path: 'server.js', source: 'x', encoding: 'utf-8' }, /encoding/],
    [{ path: 'server.js', source: 'x', content: '***=' }, /base64/],
    [{ path: 'server.js', source: 'x', content: encoded('a\0b') }, /not text/],
    [{ path: 'server.js', source: 'x', content: Buffer.from([0xff]).toString('base64') }, /UTF-8/],
    [{ path: 'server.js', source: 'xx', content: encoded('x'), size: 2 }, /size metadata/],
    [{ path: 'server.js', source: 'x', fetchError: new Error('network down') }, /network down/],
  ];
  for (const [file, expected] of cases) {
    const result = await audit.scanRepository(fakeGithub([file]), 'o', 'r');
    assert.equal(result.state, 'unreadable');
    assert.match(result.reason, expected);
  }
});

test('source-file and byte budgets fail closed', async () => {
  const files = [
    { path: 'a.js', source: '1234' },
    { path: 'b.js', source: '5678' },
  ];
  const tooMany = await audit.scanRepository(fakeGithub(files), 'o', 'r', { maxSourceFiles: 1 });
  assert.match(tooMany.reason, /more than 1 source files/);

  const knownTooLarge = await audit.scanRepository(fakeGithub(files), 'o', 'r', { maxTotalBytes: 7 });
  assert.match(knownTooLarge.reason, /inventory exceeds/);

  const unknownFiles = files.map((file) => ({ ...file, omitSize: true }));
  const decodedTooLarge = await audit.scanRepository(
    fakeGithub(unknownFiles), 'o', 'r', { maxTotalBytes: 7, concurrency: 1 }
  );
  assert.match(decodedTooLarge.reason, /decoded source exceeds/);
});

test('blob fetching honors the concurrency bound', async () => {
  const github = fakeGithub(Array.from({ length: 8 }, (_, i) => ({
    path: `src/${i}.js`, source: `export const n = ${i};`,
  })), { delay: 5 });
  const result = await audit.scanRepository(github, 'o', 'r', { concurrency: 3 });
  assert.equal(result.state, 'clean');
  assert.ok(github.stats().maxActive <= 3);
  assert.ok(github.stats().maxActive > 1);
});

test('a reader remains actionable when another concurrent blob is unreadable', async () => {
  const github = fakeGithub([
    { path: 'server.js', source: 'const key = process.env.JWT_SECRET;' },
    { path: 'src/broken.js', source: 'x', fetchError: new Error('gone') },
  ], { delay: 1 });
  const result = await audit.scanRepository(github, 'o', 'r', { concurrency: 2 });
  assert.equal(result.state, 'reader');
  assert.equal(result.hit.file, 'server.js');
});

test('a prioritized positive stops scheduling the rest of a large repository', async () => {
  let fetches = 0;
  const github = fakeGithub([
    { path: 'server.js', source: 'const key = process.env.JWT_SECRET;' },
    ...Array.from({ length: 20 }, (_, i) => ({ path: `src/${i}.js`, source: 'const ok = true;' })),
  ]);
  const original = github.getRepoBlob;
  github.getRepoBlob = async (...args) => {
    fetches += 1;
    return original(...args);
  };
  const result = await audit.scanRepository(github, 'o', 'r', { concurrency: 1 });
  assert.equal(result.state, 'reader');
  assert.equal(fetches, 1);
});

test('GitHub tree/blob helpers preserve completeness and encoding metadata', async () => {
  const githubService = require('../src/services/github');
  const calls = [];
  githubService._setOctokitFactoryForTests(() => ({
    rest: {
      repos: {
        async get(input) {
          calls.push(['repo', input]);
          return { data: { default_branch: 'trunk' } };
        },
        async getCommit(input) {
          calls.push(['commit', input]);
          return { data: { commit: { tree: { sha: 'tree-sha' } } } };
        },
      },
      git: {
        async getTree(input) {
          calls.push(['tree', input]);
          return { data: { sha: 'tree-sha', truncated: false, tree: [{ path: 'server.js' }] } };
        },
        async getBlob(input) {
          calls.push(['blob', input]);
          return { data: { encoding: 'base64', content: 'eA==', size: 1 } };
        },
      },
    },
  }));
  try {
    assert.deepEqual(await githubService.getRepoTree('owner', 'repo'), {
      sha: 'tree-sha', truncated: false, entries: [{ path: 'server.js' }],
    });
    assert.deepEqual(await githubService.getRepoBlob('owner', 'repo', 'blob-sha'), {
      encoding: 'base64', content: 'eA==', size: 1,
    });
    assert.deepEqual(calls, [
      ['repo', { owner: 'owner', repo: 'repo' }],
      ['commit', { owner: 'owner', repo: 'repo', ref: 'trunk' }],
      ['tree', { owner: 'owner', repo: 'repo', tree_sha: 'tree-sha', recursive: 'true' }],
      ['blob', { owner: 'owner', repo: 'repo', file_sha: 'blob-sha' }],
    ]);
  } finally {
    githubService._setOctokitFactoryForTests(null);
  }
});
