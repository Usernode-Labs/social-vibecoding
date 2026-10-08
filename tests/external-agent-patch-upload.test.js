// Work-order patch uploads (#4264): a coding agent hands in a large patch by
// piping `git format-patch` into a one-time upload command, instead of
// retyping it into submit_work's `patch` argument.
//
// What these pin, in the order a credential lives:
//
//   1. The credential: 256 random bits, stored as a SHA-256 hash only, minted
//      for an OPEN task of the caller's that opens new work, and printed in
//      the work order and nowhere else.
//   2. The route (src/routes/external-agent-patch-upload.js): the address
//      bucket before any lookup, the token before any body byte, and the
//      body read against a hard limit. Wrong task, expired, closed, oversize
//      and empty are each refused, and nothing is stored.
//   3. submit_work with `patchUploadId` is the inline patch path exactly:
//      the stored bytes go to the same applyPatch at the same recorded base,
//      and the inline `patch` is untouched.
//   4. The token never reaches a log line, and the redactor masks its shape
//      anyway.
//
// The real SQL against a real PostgreSQL is in
// external-agent-patch-upload-postgres.test.js; this file runs everywhere.
//
// Run with: node --test tests/external-agent-patch-upload.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const express = require('express');

const uploads = require('../src/services/external-agent-patch-upload');
const patchSvc = require('../src/services/external-agent-patch');
const svc = require('../src/services/external-agent-tasks');
const logger = require('../src/services/logger');
const { redactString } = require('../src/services/log-redaction');
const { externalAgentPatchUploadRoutes } = require('../src/routes/external-agent-patch-upload');

const SERVICE_SRC = fs.readFileSync(
  path.join(__dirname, '../src/services/external-agent-patch-upload.js'), 'utf8'
);
const ROUTE_SRC = fs.readFileSync(
  path.join(__dirname, '../src/routes/external-agent-patch-upload.js'), 'utf8'
);
const SERVER_SRC = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const SCHEMA_SRC = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
const MCP_SRC = fs.readFileSync(path.join(__dirname, '../src/services/mcp-tools.js'), 'utf8');

const BASE_SHA = '0123456789abcdef0123456789abcdef01234567';
const PATCH = [
  `From ${'a'.repeat(40)} Mon Sep 17 00:00:00 2001`,
  'From: Someone <someone@example.invalid>',
  'Subject: [PATCH] Add tags',
  '',
  '---',
  'diff --git a/README.md b/README.md',
  'index 1111111..2222222 100644',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1 +1,2 @@',
  ' # Recipe box',
  '+Recipes can carry tags now.',
  '',
].join('\n');

// A pool that answers by SQL substring, recording every call.
function fakePool(handlers, queries = []) {
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      for (const [needle, rows] of handlers) {
        if (sql.includes(needle)) return { rows: typeof rows === 'function' ? rows(params) : rows };
      }
      throw new Error(`unstubbed query: ${sql.slice(0, 80)}`);
    },
  };
}

// Every argument any logger method was called with, BEFORE redaction: a
// token that reached a log call is a leak even if the redactor masks it.
function captureLogs() {
  const seen = [];
  const real = {};
  for (const level of ['debug', 'info', 'warn', 'error']) {
    real[level] = logger[level];
    logger[level] = (...args) => { seen.push(JSON.stringify(args)); return real[level](...args); };
  }
  return {
    seen,
    restore() { Object.assign(logger, real); },
  };
}

// ── 1. The credential ──────────────────────────────────────────────────

test('an upload token is 256 random bits behind a fixed prefix, and only its hash is ever stored', () => {
  const a = uploads.makeToken();
  const b = uploads.makeToken();
  assert.notEqual(a, b);
  for (const token of [a, b]) {
    assert.match(token, /^svpu_[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(token.slice(5), 'base64url').length, 32, '32 bytes of crypto randomness');
    assert.equal(uploads.isCanonicalToken(token), true);
    assert.equal(uploads.hashToken(token), crypto.createHash('sha256').update(token).digest('hex'));
  }
  assert.match(SERVICE_SRC, /crypto\.randomBytes\(32\)/);
  assert.equal(uploads.isCanonicalToken('svpu_short'), false);
  assert.equal(uploads.isCanonicalToken(`svmcp_${'a'.repeat(43)}`), false, 'a connector bearer is not an upload token');

  // Exactly `Authorization: Bearer svpu_…`, nothing looser.
  assert.equal(uploads.tokenFromHeader(`Bearer ${a}`), a);
  assert.equal(uploads.tokenFromHeader(a), null);
  assert.equal(uploads.tokenFromHeader(`Basic ${a}`), null);
  assert.equal(uploads.tokenFromHeader(`Bearer ${a}x`), null);
  assert.equal(uploads.tokenFromHeader(''), null);
});

test('the credential is minted only for an open task of the caller that opens new work, and stores the hash', async () => {
  const queries = [];
  const expires = new Date(Date.now() + 24 * 3600 * 1000);
  const pool = fakePool([
    ['DELETE FROM external_agent_upload_tokens', []],
    ['DELETE FROM external_agent_patch_uploads', []],
    ['INSERT INTO external_agent_upload_tokens', [{ id: 9, expires_at: expires }]],
  ], queries);
  const issued = await uploads.issueUploadCredential(pool, {
    taskId: 31, userId: 3, origin: 'https://homeroom.example/some/path',
  });
  assert.ok(issued);
  assert.match(issued.token, /^svpu_/);
  assert.equal(issued.url, 'https://homeroom.example/api/external-tasks/31/patch');
  assert.equal(issued.maxBytes, patchSvc.MAX_UPLOADED_PATCH_BYTES);
  assert.equal(issued.expiresAt.getTime(), expires.getTime());

  const insert = queries.find((q) => q.sql.includes('INSERT INTO external_agent_upload_tokens'));
  assert.deepEqual(insert.params.slice(0, 3), [31, 3, uploads.hashToken(issued.token)]);
  assert.equal(insert.params[3], uploads.TOKEN_TTL_HOURS);
  assert.equal(uploads.TOKEN_TTL_HOURS, 24);
  // The task has to be this user's, open, unexpired, and NEW work: an update
  // submits a branch on this base, so an upload would have nowhere to go.
  assert.match(insert.sql, /t\.user_id = \$2/);
  assert.match(insert.sql, /t\.status = 'open'/);
  assert.match(insert.sql, /t\.target_session_id IS NULL/);
  assert.match(insert.sql, /LEAST\(NOW\(\) \+ make_interval\(hours => \$4::int\), t\.expires_at\)/,
    'never outlives the task');
  // The live credentials per task are bounded.
  const prune = queries.find((q) => /DELETE FROM external_agent_upload_tokens\s+WHERE task_id = \$1/.test(q.sql));
  assert.deepEqual(prune.params, [31, uploads.MAX_LIVE_TOKENS_PER_TASK]);
  // The token itself is never sent to the database.
  for (const q of queries) {
    assert.ok(!JSON.stringify(q.params || []).includes(issued.token), 'no query carries the token');
  }
});

test('no credential is minted without a task row to bind it to, or without an origin', async () => {
  const pool = fakePool([
    ['DELETE FROM', []],
    ['INSERT INTO external_agent_upload_tokens', []],
  ]);
  assert.equal(await uploads.issueUploadCredential(pool, { taskId: 31, userId: 3, origin: 'https://h.example' }), null);
  assert.equal(await uploads.issueUploadCredential(pool, { taskId: 31, userId: 3, origin: '' }), null);
  assert.equal(await uploads.issueUploadCredential(pool, { taskId: 0, userId: 3, origin: 'https://h.example' }), null);
});

// Canned rows for authenticateUpload, as its SELECT returns them.
function tokenRows(entries) {
  return entries.map(([token, over = {}], index) => ({
    id: index + 1,
    token_hash: uploads.hashToken(token),
    live: true,
    user_id: 3,
    task_status: 'open',
    task_live: true,
    ...over,
  }));
}

test('a token is checked against its own task only, in constant time', async () => {
  const mine = uploads.makeToken();
  const other = uploads.makeToken();
  const pool = (rows) => fakePool([['FROM external_agent_upload_tokens k', rows]]);

  const ok = await uploads.authenticateUpload(pool(tokenRows([[other], [mine]])), { taskId: 31, token: mine });
  assert.equal(ok.ok, true);
  assert.equal(ok.taskId, 31);
  assert.equal(ok.tokenId, 2);

  // A token minted for ANOTHER task is not among this task's rows.
  const wrong = await uploads.authenticateUpload(pool(tokenRows([[other]])), { taskId: 31, token: mine });
  assert.equal(wrong.code, 'invalid_upload_token');
  assert.equal(wrong.status, 401);
  // A malformed token never reaches the database.
  const q = [];
  const bad = await uploads.authenticateUpload(fakePool([], q), { taskId: 31, token: 'svpu_nope' });
  assert.equal(bad.code, 'invalid_upload_token');
  assert.equal(q.length, 0);

  // Expired, and closed: told apart only for the holder of a matching token.
  const expired = await uploads.authenticateUpload(pool(tokenRows([[mine, { live: false }]])), { taskId: 31, token: mine });
  assert.equal(expired.code, 'upload_token_expired');
  const taskExpired = await uploads.authenticateUpload(pool(tokenRows([[mine, { task_live: false }]])), { taskId: 31, token: mine });
  assert.equal(taskExpired.code, 'upload_token_expired');
  const closed = await uploads.authenticateUpload(pool(tokenRows([[mine, { task_status: 'submitted' }]])), { taskId: 31, token: mine });
  assert.equal(closed.code, 'task_closed');
  assert.equal(closed.status, 409);

  // The comparison: every row, timingSafeEqual, no early exit.
  assert.match(SERVICE_SRC, /crypto\.timingSafeEqual\(stored, presented\)/);
  const loop = SERVICE_SRC.slice(SERVICE_SRC.indexOf('for (const row of rows)'), SERVICE_SRC.indexOf('if (!match)'));
  assert.doesNotMatch(loop, /\bbreak\b|\breturn\b/, 'the loop compares every row');
});

test('an upload that is empty, not a patch, or over the limit is refused before it is stored', async () => {
  const queries = [];
  const pool = fakePool([['INSERT INTO external_agent_patch_uploads', [{ id: 77 }]]], queries);
  const refuse = async (body) => uploads.storeUpload(pool, { taskId: 31, tokenId: 2, body });

  assert.equal((await refuse(Buffer.alloc(0))).code, 'patch_empty');
  assert.equal((await refuse(Buffer.from('  \n'))).code, 'patch_empty');
  assert.equal((await refuse(Buffer.from('fatal: ambiguous argument'))).code, 'not_a_patch');
  const big = Buffer.concat([Buffer.from('diff --git a/x b/x\n'), Buffer.alloc(patchSvc.MAX_UPLOADED_PATCH_BYTES)]);
  const tooBig = await refuse(big);
  assert.equal(tooBig.code, 'patch_too_large');
  assert.equal(tooBig.status, 413);
  assert.equal(queries.length, 0, 'nothing was written');

  const stored = await refuse(Buffer.from(PATCH));
  assert.equal(stored.ok, true);
  assert.equal(stored.uploadId, 77);
  assert.equal(stored.sha256, crypto.createHash('sha256').update(PATCH).digest('hex'));
  // A replaced upload takes a NEW id, so a submission naming the old one fails.
  assert.match(queries[0].sql, /ON CONFLICT \(task_id\) DO UPDATE\s+SET id = DEFAULT/);
  assert.ok(Buffer.isBuffer(queries[0].params[2]), 'stored as the exact bytes');
});

test('the 1 MB upload ceiling is documented and above the inline one', () => {
  assert.equal(patchSvc.MAX_UPLOADED_PATCH_BYTES, 1024 * 1024);
  assert.equal(patchSvc.MAX_PATCH_BYTES, 256 * 1024);
  assert.equal(uploads.MAX_UPLOADED_PATCH_BYTES, patchSvc.MAX_UPLOADED_PATCH_BYTES);
});

// ── 2. The route ───────────────────────────────────────────────────────

const TOKEN = uploads.makeToken();
const OTHER_TASK_TOKEN = uploads.makeToken();

// The route against canned rows: task 31 holds TOKEN, task 32 holds the
// other one. `state` lets a test expire or close task 31.
function routePool(state, queries) {
  return fakePool([
    ['FROM external_agent_upload_tokens k', (params) => {
      if (Number(params[0]) === 31) {
        return tokenRows([[TOKEN, { live: !state.expired, task_status: state.closed ? 'submitted' : 'open' }]]);
      }
      if (Number(params[0]) === 32) return tokenRows([[OTHER_TASK_TOKEN]]);
      return [];
    }],
    ['INSERT INTO external_agent_patch_uploads', () => [{ id: ++state.uploadId }]],
  ], queries);
}

async function withRoute(fn, { limiter } = {}) {
  const state = { expired: false, closed: false, uploadId: 100 };
  const queries = [];
  const limits = [];
  const app = express();
  // The global JSON parser sits AFTER this router in server.js; mounting one
  // here too proves the route does not depend on that order for a JSON type.
  app.use(externalAgentPatchUploadRoutes({}, {
    pool: routePool(state, queries),
    limiter: async (opts) => {
      limits.push(opts);
      return limiter ? limiter(opts) : { allowed: true, retryAfter: 0 };
    },
  }));
  app.use(express.json());
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const put = (taskId, body, headers = {}) => fetch(`${base}/api/external-tasks/${taskId}/patch`, {
    method: 'PUT', headers, body,
  });
  try {
    await fn({ put, base, state, queries, limits });
  } finally {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close();
  }
}

const auth = (token = TOKEN) => ({ authorization: `Bearer ${token}` });

test('the route stores the exact bytes a curl upload sends, and answers with the id to submit', async () => {
  await withRoute(async ({ put, base, queries, limits }) => {
    // curl's default Content-Type for --data-binary is form-encoded; a byte
    // that is not UTF-8 must survive as sent.
    const body = Buffer.concat([Buffer.from(PATCH), Buffer.from([0xe9, 0x0a])]);
    const res = await put(31, body, { ...auth(), 'content-type': 'application/x-www-form-urlencoded' });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.taskId, 31);
    assert.equal(json.uploadId, 101);
    assert.equal(json.bytes, body.length);
    assert.equal(json.sha256, crypto.createHash('sha256').update(body).digest('hex'));
    assert.match(json.nextStep, /submit_work with taskId 31 and patchUploadId 101/);
    const insert = queries.find((q) => q.sql.includes('INSERT INTO external_agent_patch_uploads'));
    assert.ok(insert.params[2].equals(body), 'byte for byte');
    assert.deepEqual(insert.params.slice(0, 2), [31, 1]);

    // The address bucket first, then the task's.
    assert.deepEqual(limits.map((l) => l.namespace), ['patch-upload-ip', 'patch-upload-task']);
    assert.equal(limits[1].subject, '31');

    // POST works too (curl without -X PUT), and a second upload replaces the
    // first under a new id.
    const again = await fetch(`${base}/api/external-tasks/31/patch`, {
      method: 'POST', headers: { ...auth(), 'content-type': 'application/json' }, body: PATCH,
    });
    assert.equal(again.status, 201);
    assert.equal((await again.json()).uploadId, 102);
  });
});

test('the route refuses a missing, wrong, other-task, expired or closed credential and stores nothing', async () => {
  await withRoute(async ({ put, state, queries }) => {
    const none = await put(31, PATCH);
    assert.equal(none.status, 401);
    assert.equal((await none.json()).error, 'invalid_upload_token');

    const wrong = await put(31, PATCH, auth(uploads.makeToken()));
    assert.equal(wrong.status, 401);

    // Task 32's own token, presented for task 31, and task 31's for 32.
    assert.equal((await put(31, PATCH, auth(OTHER_TASK_TOKEN))).status, 401);
    assert.equal((await put(32, PATCH, auth(TOKEN))).status, 401);
    assert.equal((await put('31abc', PATCH, auth())).status, 401);

    state.expired = true;
    const expired = await put(31, PATCH, auth());
    assert.equal(expired.status, 401);
    const expiredJson = await expired.json();
    assert.equal(expiredJson.error, 'upload_token_expired');
    assert.match(expiredJson.message, /inline as `patch`/);

    state.expired = false;
    state.closed = true;
    const closed = await put(31, PATCH, auth());
    assert.equal(closed.status, 409);
    assert.equal((await closed.json()).error, 'task_closed');

    assert.ok(!queries.some((q) => q.sql.includes('INSERT')), 'nothing was stored');
  });
});

test('the route refuses an oversize or empty upload, and a token is checked before any body is read', async () => {
  await withRoute(async ({ put, queries }) => {
    const big = Buffer.alloc(patchSvc.MAX_UPLOADED_PATCH_BYTES + 10, 0x61);
    const tooBig = await put(31, big, auth());
    assert.equal(tooBig.status, 413);
    const json = await tooBig.json();
    assert.equal(json.error, 'patch_too_large');
    assert.equal(json.limitBytes, patchSvc.MAX_UPLOADED_PATCH_BYTES);

    const empty = await put(31, '', auth());
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).error, 'patch_empty');
    assert.ok(!queries.some((q) => q.sql.includes('INSERT')), 'nothing was stored');
  });
  // The order is the security property: buckets and token before the body.
  assert.match(ROUTE_SRC, /router\.put\('\/api\/external-tasks\/:taskId\/patch', noStore, authenticate, rawBody, store\)/);
  assert.match(ROUTE_SRC, /router\.post\('\/api\/external-tasks\/:taskId\/patch', noStore, authenticate, rawBody, store\)/);
  assert.equal(uploads.uploadPath(31), '/api/external-tasks/31/patch', 'the path the work order prints');
  const authBody = ROUTE_SRC.slice(ROUTE_SRC.indexOf('const authenticate'), ROUTE_SRC.indexOf('const rawBody'));
  assert.ok(authBody.indexOf("'patch-upload-ip'") < authBody.indexOf('authenticateUpload'),
    'the address bucket runs before the lookup');
  assert.ok(authBody.indexOf('authenticateUpload') < authBody.indexOf("'patch-upload-task'"));
});

test('the route is rate-limited like the connector, and closed on a staging preview', async () => {
  await withRoute(async ({ put, queries }) => {
    const res = await put(31, PATCH, auth());
    assert.equal(res.status, 429);
    assert.equal((await res.json()).error, 'rate_limited');
    assert.equal(queries.length, 0, 'refused before the token was even looked up');
  }, { limiter: () => ({ allowed: false, retryAfter: 30 }) });

  await withRoute(async ({ put, queries }) => {
    const res = await put(31, PATCH, auth());
    assert.equal(res.status, 503);
    assert.equal(queries.length, 0, 'a limiter that cannot run lets nothing through');
  }, { limiter: () => { throw new Error('db down'); } });

  // The same shared bucket the connector's POST /mcp uses.
  assert.match(ROUTE_SRC, /consumeSharedTokenBucket/);

  const prior = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  try {
    await withRoute(async ({ put }) => {
      assert.equal((await put(31, PATCH, auth())).status, 404);
    });
  } finally {
    if (prior === undefined) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = prior;
  }
});

test('the route is mounted before the JSON parser and before authMiddleware', () => {
  const mount = SERVER_SRC.indexOf('externalAgentPatchUploadRoutes(config)');
  assert.ok(mount > 0, 'mounted');
  assert.ok(mount < SERVER_SRC.indexOf('express.json()(req, res, next)'), 'before the global JSON parser');
  assert.ok(mount < SERVER_SRC.indexOf('app.use(authMiddleware(config))'), 'before authMiddleware');
  assert.ok(mount < SERVER_SRC.indexOf('app.use(cliApiBearerAuth(config))'), 'before the CLI bearer');
});

// ── 3. The work order ──────────────────────────────────────────────────

function orderWith(overrides = {}) {
  return svc.buildWorkOrder({
    appName: 'Recipe Box',
    appSlug: 'recipe-box',
    upstreamUrl: 'https://github.com/usernode-bot/recipe-box',
    upstreamSlug: 'usernode-bot/recipe-box',
    forkUrl: 'https://github.com/someuser/recipe-box',
    forkCloneUrl: 'https://github.com/someuser/recipe-box.git',
    forkRepo: 'recipe-box',
    forkPageUrl: 'https://github.com/usernode-bot/recipe-box/fork',
    forkStatus: 'ready',
    branch: 'usernode/recipe-box-issue-4-abc123',
    baseSha: BASE_SHA,
    issueNumber: 4,
    brief: '<untrusted-content>Add tags</untrusted-content>',
    webPath: 'https://homeroom.example/#app/recipe-box',
    taskId: 31,
    agentLabelText: 'claude-code',
    ...overrides,
  });
}

const UPLOAD = {
  token: TOKEN,
  url: 'https://homeroom.example/api/external-tasks/31/patch',
  expiresAt: new Date('2026-10-08T14:05:00Z'),
  maxBytes: patchSvc.MAX_UPLOADED_PATCH_BYTES,
};

test('the work order offers the upload for a large patch, keeps inline for small ones and the branch last', () => {
  const order = orderWith({ patchUpload: UPLOAD });
  const done = order.slice(order.lastIndexOf('WHEN YOU ARE DONE'));
  // The command, verbatim and runnable: the base commit, the token, the URL.
  assert.ok(done.includes(
    `    git format-patch ${BASE_SHA}..HEAD --stdout | curl -sS --max-time 120 -X PUT \\\n`
    + `      -H 'Authorization: Bearer ${TOKEN}' \\\n`
    + '      --data-binary @- https://homeroom.example/api/external-tasks/31/patch\n'
  ), done);
  assert.match(done, /until 2026-10-08 14:05 UTC/);
  assert.match(done, /never print, commit or share it/);
  assert.match(done, /which not\s+every\s+sandbox can, so try it once/, 'says it may not reach');
  assert.doesNotMatch(done, /hosted\s+sandbox usually cannot/, 'and guesses at no sandbox (#4263)');
  assert.match(done, /pass its\s+`uploadId` as `patchUploadId` in step 2 instead of `patch`/);
  assert.match(done, /Uploads take up to 1 MB, inline patches\s+about 250 KB/);
  // Order of preference: inline first, upload for large, branch last.
  assert.ok(done.indexOf('git format-patch') < done.indexOf('UPLOAD it'));
  assert.ok(done.indexOf('UPLOAD it') < done.indexOf('git push -u origin HEAD'));
  assert.match(done, /as `patch` \(or the\n {3}`patchUploadId` its upload printed/);
  assert.match(done, /4\. IF THE PATCH IS REFUSED as too large, upload it as in step 1/);
  // The token appears in the command and nowhere else in the order.
  assert.equal(order.split(TOKEN).length - 1, 1);
  assert.doesNotMatch(order, /gho_|ghp_|x-access-token/);
});

test('without a credential, and on an update, the work order is exactly what it was', () => {
  const plain = orderWith();
  assert.doesNotMatch(plain, /svpu_|patchUploadId|Bearer /);
  assert.match(plain, /Patches over about 250 KB are refused\. For a change that large, or when/);
  assert.match(plain, /4\. IF THE PATCH IS REFUSED as too large, push a branch as in step 1 and/);
  assert.equal(orderWith({ patchUpload: null }), plain);

  // An update's patch (#4263) is sent inline through the update route, so
  // even a credential handed in is not shown.
  const update = orderWith({
    patchUpload: UPLOAD,
    targetProposal: { id: 4223, branchHome: 'app_repo', title: 'Tags', webPath: null },
  });
  assert.doesNotMatch(update, /svpu_|patchUploadId/);
});

test('prepareWork mints the credential for the work order it renders, and only when asked', async () => {
  const APP = { id: 7, slug: 'recipe-box', name: 'Recipe Box', repo_url: 'https://github.com/usernode-bot/recipe-box' };
  const deps = (pool) => ({
    pool,
    config: {},
    gh: {
      isEnabled: () => true,
      parseGithubUrl: () => ({ owner: 'usernode-bot', repo: 'recipe-box' }),
      getBranchSha: async () => BASE_SHA,
    },
    githubLink: { isEnabled: () => true, linkStatus: async () => ({ linked: true, login: 'someuser' }) },
    limits: { checkOpenWorkOrders: async () => null, checkPromotedCap: async () => null },
  });
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 404, text: async () => '{}' });
  const logs = captureLogs();
  try {
    const run = async (extra) => {
      const queries = [];
      const pool = fakePool([
        ['INSERT INTO external_agent_tasks', [{ id: 31 }]],
        ['DELETE FROM external_agent_upload_tokens', []],
        ['DELETE FROM external_agent_patch_uploads', []],
        ['INSERT INTO external_agent_upload_tokens', [{ id: 5, expires_at: new Date(Date.now() + 3600e3) }]],
      ], queries);
      const result = await svc.prepareWork(deps(pool), {
        user: { id: 3 }, app: APP, issueNumber: 4, brief: 'Add tags',
        clientName: 'Claude', origin: 'https://homeroom.example', ...extra,
      });
      return { result, queries };
    };

    const asked = await run({ patchUpload: true });
    assert.equal(asked.result.ok, true);
    const insert = asked.queries.find((q) => q.sql.includes('INSERT INTO external_agent_upload_tokens'));
    assert.ok(insert, 'a credential was minted');
    const token = /Bearer (svpu_[A-Za-z0-9_-]{43})/.exec(asked.result.workOrder)[1];
    assert.equal(insert.params[2], uploads.hashToken(token), 'the work order carries the token whose hash was stored');
    assert.ok(asked.result.workOrder.includes('https://homeroom.example/api/external-tasks/31/patch'));
    // Only in the work order: no structured field carries it.
    const { workOrder, ...rest } = asked.result;
    assert.ok(!JSON.stringify(rest).includes(token), 'the token is in workOrder and nowhere else');
    assert.ok(!logs.seen.some((line) => line.includes(token)), 'and never in a log call');

    // The browser walkthrough does not ask, and gets the order it always got.
    const plain = await run({});
    assert.ok(!plain.queries.some((q) => q.sql.includes('external_agent_upload_tokens')));
    assert.doesNotMatch(plain.result.workOrder, /svpu_/);
  } finally {
    logs.restore();
    global.fetch = realFetch;
  }
});

test('a credential that cannot be minted costs the command, never the work order', async () => {
  const issued = await (async () => {
    const pool = fakePool([['INSERT INTO external_agent_tasks', [{ id: 31 }]]]);
    const realFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 404, text: async () => '{}' });
    try {
      return await svc.prepareWork({
        pool,
        config: {},
        gh: {
          isEnabled: () => true,
          parseGithubUrl: () => ({ owner: 'usernode-bot', repo: 'recipe-box' }),
          getBranchSha: async () => BASE_SHA,
        },
        githubLink: { isEnabled: () => true, linkStatus: async () => ({ linked: true, login: 'someuser' }) },
        limits: { checkOpenWorkOrders: async () => null },
      }, {
        user: { id: 3 },
        app: { id: 7, slug: 'recipe-box', name: 'Recipe Box', repo_url: 'https://github.com/usernode-bot/recipe-box' },
        brief: 'Add tags', clientName: 'Claude', origin: 'https://homeroom.example', patchUpload: true,
      });
    } finally {
      global.fetch = realFetch;
    }
  })();
  assert.equal(issued.ok, true);
  assert.doesNotMatch(issued.workOrder, /svpu_/);
  assert.match(issued.workOrder, /Patches over about 250 KB are refused/);
});

// ── 4. submit_work with the upload ─────────────────────────────────────

const TASK_ROW = {
  id: 31, user_id: 3, app_id: 7, issue_number: 4,
  fork_owner: 'someuser', fork_repo: 'recipe-box',
  branch_name: 'usernode/recipe-box-issue-4-abc123',
  base_sha: BASE_SHA, brief: 'Add tags', status: 'open',
  app_slug: 'recipe-box', app_name: 'Recipe Box',
  repo_url: 'https://github.com/usernode-bot/recipe-box', linked_issues: [4],
};

function submitDeps(pool, created) {
  return {
    pool,
    config: {},
    gh: {
      isEnabled: () => true,
      parseGithubUrl: () => ({ owner: 'usernode-bot', repo: 'recipe-box' }),
      createPR: async (owner, repo, opts) => {
        created.push(opts);
        return { number: 88, html_url: 'https://github.com/usernode-bot/recipe-box/pull/88', head: { sha: 'f'.repeat(40) } };
      },
      compareCommitAncestry: async () => ({ status: 'ahead' }),
    },
    githubLink: { isEnabled: () => true, linkStatus: async () => ({ linked: true, login: 'someuser' }) },
    limits: { checkPromotedCap: async () => null },
  };
}

// applyPatch is the shared seam: both paths must reach it with the patch.
async function withStubbedApply(fn) {
  const real = patchSvc.applyPatch;
  const applied = [];
  patchSvc.applyPatch = async (args) => {
    applied.push(args);
    return { ok: true, branch: 'usernode/patch-u3-t31-x', headSha: 'f'.repeat(40), cleanup: async () => {} };
  };
  try {
    return await fn(applied);
  } finally {
    patchSvc.applyPatch = real;
  }
}

function uploadPool(queries, upload) {
  return fakePool([
    ['FROM external_agent_patch_uploads u', (params) => (upload && Number(params[0]) === upload.id
      && Number(params[1]) === 3 ? [upload] : [])],
    ['FROM external_agent_tasks t JOIN apps a', [TASK_ROW]],
    ['UPDATE chat_sessions SET external_agent', []],
    ['UPDATE external_agent_tasks', []],
    ['DELETE FROM external_agent_patch_uploads', []],
    ['DELETE FROM external_agent_upload_tokens', []],
  ], queries);
}

test('submit_work with patchUploadId applies the uploaded bytes exactly as an inline patch, then clears the upload', async () => {
  const bytes = Buffer.concat([Buffer.from(PATCH), Buffer.from([0xe9, 0x0a])]);
  const queries = [];
  const created = [];
  const imports = [];
  await withStubbedApply(async (applied) => {
    const result = await svc.submitWork(
      submitDeps(uploadPool(queries, { id: 101, task_id: 31, patch: bytes, bytes: bytes.length, sha256: 'x' }), created),
      {
        user: { id: 3 }, taskId: 31, patchUploadId: 101, title: 'Add tags',
        importProposal: async (slug, pr, extra) => { imports.push({ slug, pr, extra }); return { ok: true, body: { sessionId: 555 } }; },
      }
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.submittedVia, 'patch', 'recorded as the patch path it is');
    assert.equal(result.prNumber, 88);
    assert.equal(applied.length, 1);
    assert.ok(Buffer.isBuffer(applied[0].patch) && applied[0].patch.equals(bytes), 'the stored bytes, unchanged');
    assert.equal(applied[0].baseSha, BASE_SHA, 'at the recorded base');
    assert.equal(applied[0].maxBytes, patchSvc.MAX_UPLOADED_PATCH_BYTES, 'under the upload ceiling');
    assert.equal(created[0].branch, 'usernode/patch-u3-t31-x');
    assert.deepEqual(imports.map((i) => i.pr), [88]);
    // Used once: the upload and every credential for the task are deleted.
    assert.ok(queries.some((q) => /DELETE FROM external_agent_patch_uploads WHERE task_id = \$1/.test(q.sql)
      && q.params[0] === 31));
    assert.ok(queries.some((q) => /DELETE FROM external_agent_upload_tokens WHERE task_id = \$1/.test(q.sql)
      && q.params[0] === 31));
  });
});

test('the inline patch path is unchanged: a string, the inline ceiling, no upload lookup', async () => {
  const queries = [];
  await withStubbedApply(async (applied) => {
    const result = await svc.submitWork(
      submitDeps(uploadPool(queries, null), []),
      {
        user: { id: 3 }, taskId: 31, patch: PATCH,
        importProposal: async () => ({ ok: true, body: { sessionId: 556 } }),
      }
    );
    assert.equal(result.ok, true);
    assert.equal(applied[0].patch, PATCH);
    assert.equal(applied[0].maxBytes, undefined, 'the inline ceiling applies');
    assert.ok(!queries.some((q) => q.sql.includes('external_agent_patch_uploads')));
  });
  // And a caller cannot raise the ceiling by naming the internal marker.
  await withStubbedApply(async (applied) => {
    await svc.submitWork(submitDeps(uploadPool([], null), []), {
      user: { id: 3 }, taskId: 31, patch: PATCH, uploadedPatch: { uploadId: 1 },
      importProposal: async () => ({ ok: true, body: { sessionId: 557 } }),
    });
    assert.equal(applied[0].maxBytes, undefined);
  });
});

test('submit_work refuses an upload of another task, a replaced or unknown one, and ambiguous calls', async () => {
  await withStubbedApply(async (applied) => {
    const deps = (upload) => submitDeps(uploadPool([], upload), []);
    const base = { user: { id: 3 }, taskId: 31, importProposal: async () => ({ ok: true, body: {} }) };

    const otherTask = await svc.submitWork(deps({ id: 101, task_id: 32, patch: Buffer.from(PATCH), bytes: 1 }),
      { ...base, patchUploadId: 101 });
    assert.equal(otherTask.code, 'patch_upload_wrong_task');
    assert.match(otherTask.message, /task 32, not task 31/);

    const missing = await svc.submitWork(deps(null), { ...base, patchUploadId: 100 });
    assert.equal(missing.code, 'patch_upload_not_found');
    assert.match(missing.message, /only the newest upload counts/);
    assert.doesNotMatch(missing.message, /\b10[1-9]\b/, 'never points at a newer upload it did not send');

    const both = await svc.submitWork(deps(null), { ...base, patchUploadId: 101, patch: PATCH });
    assert.equal(both.code, 'invalid_request');

    const noTask = await svc.submitWork(deps(null), { user: { id: 3 }, patchUploadId: 101, slug: 'recipe-box', branch: 'x' });
    assert.equal(noTask.code, 'invalid_request');
    assert.match(noTask.message, /taskId/);
    assert.equal(applied.length, 0, 'nothing was applied');
  });
});

// #4263. An update task's patch is sent inline: no upload command is printed
// for one, and naming an upload id says so rather than "no such upload".
test('an update task refuses patchUploadId and points at the inline patch', async () => {
  const queries = [];
  const pool = fakePool([
    ['FROM external_agent_tasks t JOIN apps a', [{ ...TASK_ROW, target_session_id: 4223 }]],
  ], queries);
  await withStubbedApply(async (applied) => {
    const result = await svc.submitWork(submitDeps(pool, []), {
      user: { id: 3 }, taskId: 31, patchUploadId: 101,
      updateProposal: async () => { throw new Error('must not update'); },
    });
    assert.equal(result.code, 'invalid_request');
    assert.match(result.message, /Task 31 revises proposal 4223, and an update's patch is sent\s+inline as `patch`/);
    assert.equal(applied.length, 0);
    assert.ok(!queries.some((q) => q.sql.includes('external_agent_patch_uploads')), 'no upload was looked up');
  });
});

test('a task already submitted answers already_submitted, upload id or not', async () => {
  const pool = fakePool([
    ["t.status = 'open'", []],
    ['LEFT JOIN chat_sessions', [{ ...TASK_ROW, status: 'submitted', session_id: 55, proposal_id: 55 }]],
  ]);
  const result = await svc.submitWork(submitDeps(pool, []), {
    user: { id: 3 }, taskId: 31, patchUploadId: 101, importProposal: async () => ({ ok: true, body: {} }),
  });
  assert.equal(result.code, 'already_submitted');
  assert.equal(result.proposalId, 55);
});

// ── applyPatch takes the exact bytes ───────────────────────────────────

test('applyPatch: an inline patch over 256 KB points at the upload; an uploaded one may be larger', async () => {
  const head = require('../src/services/external-agent-head');
  const real = head.resolveWriteCredential;
  let reached = 0;
  head.resolveWriteCredential = async () => { reached += 1; throw new Error('stop here'); };
  try {
    const big = `diff --git a/x b/x\n${'x'.repeat(patchSvc.MAX_PATCH_BYTES)}`;
    const inline = await patchSvc.applyPatch({ owner: 'o', repo: 'r', patch: big, baseSha: BASE_SHA, userId: 3, taskId: 31 });
    assert.equal(inline.code, 'patch_too_large');
    assert.match(inline.message, /Upload it with the command in your work order \(up to 1024 KB\)/);
    assert.equal(reached, 0, 'refused before any credential is resolved');

    const uploaded = await patchSvc.applyPatch({
      owner: 'o', repo: 'r', patch: Buffer.from(big), baseSha: BASE_SHA, userId: 3, taskId: 31,
      maxBytes: patchSvc.MAX_UPLOADED_PATCH_BYTES,
    });
    assert.equal(uploaded.code, 'platform_unavailable', 'past the size gate');
    assert.equal(reached, 1);

    const huge = Buffer.alloc(patchSvc.MAX_UPLOADED_PATCH_BYTES + 1, 0x61);
    const over = await patchSvc.applyPatch({
      owner: 'o', repo: 'r', patch: huge, baseSha: BASE_SHA, userId: 3, taskId: 31, maxBytes: 50 * 1024 * 1024,
    });
    assert.equal(over.code, 'patch_too_large', 'a caller cannot raise the ceiling past the upload limit');
    assert.match(over.message, /an uploaded patch/);
  } finally {
    head.resolveWriteCredential = real;
  }
});

function gitIn(dir, args) {
  const result = spawnSync('git', [
    '-C', dir, '-c', 'user.name=Local Tester', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', ...args,
  ], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(String(result.stderr) || `git ${args[0]} failed`);
  return result.stdout;
}

test('an uploaded patch is applied byte for byte, a non-UTF-8 file included', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-patch-upload-'));
  const head = require('../src/services/external-agent-head');
  const realRemote = head.authenticatedRemote;
  const realToken = process.env.GITHUB_BOT_TOKEN;
  try {
    const work = path.join(root, 'work');
    const bare = path.join(root, 'app.git');
    fs.mkdirSync(work);
    gitIn(work, ['init', '-q']);
    fs.writeFileSync(path.join(work, 'README.md'), '# Recipe box\n');
    gitIn(work, ['add', '-A']);
    gitIn(work, ['commit', '-qm', 'Base']);
    const base = String(gitIn(work, ['rev-parse', 'HEAD'])).trim();
    gitIn(root, ['clone', '--bare', '-q', work, bare]);
    // A Latin-1 file: its bytes are not valid UTF-8, so a patch that went
    // through a JavaScript string would no longer reproduce it.
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
    fs.writeFileSync(path.join(work, 'menu.txt'), latin1);
    gitIn(work, ['add', '-A']);
    gitIn(work, ['commit', '-qm', 'Add the menu']);
    const patch = gitIn(work, ['format-patch', '--stdout', `${base}..HEAD`]);
    assert.ok(Buffer.isBuffer(patch) && patch.includes(latin1.subarray(3, 4)));

    head.authenticatedRemote = () => `file://${bare}`;
    process.env.GITHUB_BOT_TOKEN = 'local-test-token';
    const result = await patchSvc.applyPatch({
      owner: 'usernode-bot', repo: 'recipe-box', patch, baseSha: base, userId: 3, taskId: 31,
      maxBytes: patchSvc.MAX_UPLOADED_PATCH_BYTES,
    });
    assert.equal(result.ok, true, `${result.code}: ${result.message} ${result.detail || ''}`);
    const blob = gitIn(bare, ['show', `${result.headSha}:menu.txt`]);
    assert.ok(blob.equals(latin1), 'the file is exactly what the agent committed');
  } finally {
    head.authenticatedRemote = realRemote;
    if (realToken === undefined) delete process.env.GITHUB_BOT_TOKEN;
    else process.env.GITHUB_BOT_TOKEN = realToken;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── 5. The connector's two tools ───────────────────────────────────────

function connector() {
  const tools = require('../src/services/mcp-tools');
  const { READ_SCOPE, WRITE_SCOPE } = require('../src/services/mcp-connect-constants');
  const handlers = new Map();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ app: { id: 7, slug: 'recipe-box', name: 'Recipe Box', repo_url: 'https://github.com/usernode-bot/recipe-box' } }) });
  tools.registerTools({ registerTool(name, _spec, handler) { handlers.set(name, handler); } }, {
    accessToken: 'svmcp_test', scopes: [READ_SCOPE, WRITE_SCOPE], user: { id: 3, username: 'ada' },
    clientName: 'Claude', clientId: 'c1', origin: 'https://homeroom.example',
    baseUrl: 'http://platform.internal', pool: null, config: {}, tokenId: null, grantId: null,
  });
  return { handlers, restore: () => { globalThis.fetch = realFetch; } };
}

test('submit_work takes patchUploadId with a taskId, passes it to the service, and refuses it alone or beside a patch', async () => {
  const realSubmit = svc.submitWork;
  const reached = [];
  svc.submitWork = async (_deps, params) => {
    reached.push(params);
    return { ok: true, proposalId: 555, prNumber: 88, prUrl: null, appSlug: 'recipe-box', externalAgent: 'claude-code', submittedVia: 'patch' };
  };
  const c = connector();
  try {
    const submit = c.handlers.get('submit_work');
    const ok = await submit({ taskId: 31, patchUploadId: 101 });
    assert.ok(!ok.isError, JSON.stringify(ok.structuredContent));
    assert.equal(reached[0].patchUploadId, 101);
    assert.equal(reached[0].taskId, 31);
    assert.equal(reached[0].patch, undefined);

    const alone = await submit({ patchUploadId: 101 });
    assert.equal(alone.isError, true);
    assert.match(alone.structuredContent.message, /patchUploadId needs the taskId/);
    const both = await submit({ taskId: 31, patchUploadId: 101, patch: PATCH });
    assert.equal(both.isError, true);
    assert.match(both.structuredContent.message, /not both/);
    assert.equal(reached.length, 1, 'the refusals never reached the service');

    // An inline patch is sent as it always was, with no upload id.
    await submit({ taskId: 31, patch: PATCH });
    assert.equal(reached[1].patch, PATCH);
    assert.ok(!('patchUploadId' in reached[1]));
  } finally {
    c.restore();
    svc.submitWork = realSubmit;
  }
});

test('prepare_work asks the service for the upload command, and submit_work documents the field', async () => {
  const realPrepare = svc.prepareWork;
  const gh = require('../src/services/github');
  const githubLink = require('../src/services/github-link');
  const saved = { gh: gh.isEnabled, link: githubLink.isEnabled };
  gh.isEnabled = () => true;
  githubLink.isEnabled = () => true;
  let seen = null;
  svc.prepareWork = async (_deps, params) => {
    seen = params;
    return {
      ok: true, taskId: 31, forkUrl: 'https://github.com/ada/recipe-box', forkPageUrl: 'https://github.com/ada/recipe-box',
      forkStatus: 'ready', branch: 'usernode/12', baseSha: 'a'.repeat(40), guidance: ['step one'],
      workOrder: 'WORK ORDER', openProposals: [],
    };
  };
  const c = connector();
  try {
    const res = await c.handlers.get('prepare_work')({ slug: 'recipe-box', brief: 'Add tags' });
    assert.ok(!res.isError, JSON.stringify(res.structuredContent));
    assert.equal(seen.patchUpload, true);
  } finally {
    c.restore();
    svc.prepareWork = realPrepare;
    gh.isEnabled = saved.gh;
    githubLink.isEnabled = saved.link;
  }
  const block = MCP_SRC.slice(MCP_SRC.indexOf("server.registerTool('submit_work'"));
  assert.match(block, /patchUploadId: z\.number\(\)\.int\(\)\.positive\(\)\.optional\(\)/);
  assert.match(block, /Uploads may be up to 1 MB/);
  assert.match(block, /if yours cannot, send `patch` inline/);
});

// ── 6. Never logged, never readable ────────────────────────────────────

test('the token never reaches a log call, and the redactor masks its shape anyway', async () => {
  const logs = captureLogs();
  try {
    await withRoute(async ({ put, state }) => {
      await put(31, PATCH, auth());
      await put(31, PATCH, auth(OTHER_TASK_TOKEN));
      await put(31, 'not a patch', auth());
      state.expired = true;
      await put(31, PATCH, auth());
    });
  } finally {
    logs.restore();
  }
  assert.ok(logs.seen.length >= 3, 'the route did log');
  for (const line of logs.seen) {
    assert.ok(!line.includes(TOKEN) && !line.includes(OTHER_TASK_TOKEN), `a token reached a log call: ${line}`);
    assert.ok(!line.includes(uploads.hashToken(TOKEN)), 'not its hash either');
  }
  assert.equal(redactString(`curl -H 'Authorization: Bearer ${TOKEN}'`), "curl -H 'Authorization: Bearer ****'");

  // The credential table is denied to the production debugger, and its
  // hash column is tagged for the staging scrub.
  const debugAccess = require('../src/services/debug-access');
  assert.ok(debugAccess.DENIED_TABLES.has('external_agent_upload_tokens'));
  assert.match(SCHEMA_SRC, /COMMENT ON COLUMN external_agent_upload_tokens\.token_hash IS 'staging:private'/);
  assert.match(SCHEMA_SRC, /COMMENT ON TABLE external_agent_patch_uploads IS 'staging:private'/);
});
