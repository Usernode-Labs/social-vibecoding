// Tests for the feedback-modal screenshot attachment backend (#683):
// upload validation, the embed line appended to filed issue bodies, the
// screenshotId gating on POST /api/feedback, and the public
// GET /issue-images/:id serving route.
//
// Same harness shape as tests/feedback-custom-title.test.js: override
// getPool BEFORE requiring the route modules, stub the GitHub fetch, and
// hit the routers over HTTP.
//
// Run with: node --test tests/issue-screenshots.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const poolMod = require('../src/db/pool');
let poolQueries = [];
let poolHandler = async () => ({ rows: [] });
poolMod.getPool = () => ({
  query: async (sql, params) => {
    poolQueries.push({ sql: String(sql), params });
    return poolHandler(String(sql), params);
  },
});

const llm = require('../src/services/llm');
llm.generateIssueTitle = async () => ({ title: 'Generated title', usage: undefined, model: 'claude-haiku-4-5' });

const github = require('../src/services/github');
github.isEnabled = () => true;
github.noteIssueCreated = () => {};

process.env.GITHUB_BOT_TOKEN = 'test-pat';
let ghCreates = [];
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).includes('api.github.com')) {
    ghCreates.push(JSON.parse(opts.body));
    return {
      ok: true,
      status: 201,
      json: async () => ({ number: 42, html_url: 'https://github.com/plat/repo/issues/42' }),
    };
  }
  return realFetch(url, opts);
};

const {
  feedbackRoutes,
  validateScreenshotUpload,
  buildScreenshotEmbed,
  MAX_SCREENSHOT_BYTES,
} = require('../src/routes/feedback');
const { issueImageRoutes } = require('../src/routes/issue-images');
const { USERNODE_DOMAIN } = require('../src/services/caddy');
const express = require('express');

function startServer() {
  const app = express();
  app.use((req, res, next) => { req.user = { id: 7, username: 'tester' }; next(); });
  app.use(express.json());
  app.use(feedbackRoutes({ platformRepoUrl: 'https://github.com/plat/repo' }));
  app.use(issueImageRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function reset() {
  poolQueries = [];
  ghCreates = [];
  poolHandler = async () => ({ rows: [] });
}

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64, 1)]);
const GOOD_ID = 'ab'.repeat(16);

// ── Pure upload validation ───────────────────────────────────────────

test('validateScreenshotUpload: PNG and JPEG accepted, others rejected', () => {
  assert.deepEqual(validateScreenshotUpload(PNG), { ok: true, contentType: 'image/png' });
  assert.deepEqual(validateScreenshotUpload(JPEG), { ok: true, contentType: 'image/jpeg' });
  assert.equal(validateScreenshotUpload(GIF).ok, false);
  assert.equal(validateScreenshotUpload(Buffer.alloc(64, 7)).ok, false);
  assert.equal(validateScreenshotUpload(Buffer.alloc(0)).ok, false);
  assert.equal(validateScreenshotUpload(null).ok, false);
});

test('validateScreenshotUpload: over-cap upload rejected', () => {
  const big = Buffer.alloc(MAX_SCREENSHOT_BYTES + 1, 1);
  PNG.copy(big, 0);
  const verdict = validateScreenshotUpload(big);
  assert.equal(verdict.ok, false);
  assert.match(verdict.error, /too large/i);
});

test('buildScreenshotEmbed: exact markdown suffix', () => {
  assert.equal(
    buildScreenshotEmbed('deadbeef'.repeat(4), 'example.org'),
    '\n\n**Screenshot:**\n![Screenshot](https://example.org/issue-images/deadbeefdeadbeefdeadbeefdeadbeef)'
  );
});

// ── Upload route ─────────────────────────────────────────────────────

test('POST /api/feedback/screenshot stores a PNG and returns a 32-hex id', async () => {
  reset();
  const server = await startServer();
  try {
    const res = await realFetch(`http://127.0.0.1:${server.address().port}/api/feedback/screenshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: PNG,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.match(data.id, /^[a-f0-9]{32}$/);
    const insert = poolQueries.find((q) => q.sql.includes('INSERT INTO issue_screenshots'));
    assert.ok(insert, 'expected an issue_screenshots INSERT');
    assert.equal(insert.params[0], data.id);
    assert.equal(insert.params[1], 7); // req.user.id
    assert.equal(insert.params[2], 'image/png');
    assert.equal(insert.params[3], PNG.length);
  } finally {
    server.close();
  }
});

test('POST /api/feedback/screenshot rejects a non-image body with 400', async () => {
  reset();
  const server = await startServer();
  try {
    const res = await realFetch(`http://127.0.0.1:${server.address().port}/api/feedback/screenshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.alloc(64, 7),
    });
    assert.equal(res.status, 400);
    assert.equal(poolQueries.some((q) => q.sql.includes('INSERT INTO issue_screenshots')), false);
  } finally {
    server.close();
  }
});

// ── screenshotId on POST /api/feedback ───────────────────────────────

async function postFeedback(server, body) {
  return realFetch(`http://127.0.0.1:${server.address().port}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('valid screenshotId appends the exact embed line and links the row', async () => {
  reset();
  // The ownership lookup finds the row; every other query is a no-op.
  poolHandler = async (sql) => {
    if (sql.includes('FROM issue_screenshots')) return { rows: [{ '?column?': 1 }] };
    return { rows: [] };
  };
  const server = await startServer();
  try {
    const res = await postFeedback(server, {
      description: 'Something is broken', title: 'My title', screenshotId: GOOD_ID,
    });
    assert.equal(res.status, 200);
    assert.equal(ghCreates.length, 1);
    const expectedSuffix = buildScreenshotEmbed(GOOD_ID, USERNODE_DOMAIN);
    assert.ok(ghCreates[0].body.endsWith(expectedSuffix),
      `issue body should end with the embed line, got: ${ghCreates[0].body}`);
    const link = poolQueries.find((q) => q.sql.includes('UPDATE issue_screenshots'));
    assert.ok(link, 'expected the row to be linked to the filed issue');
    assert.deepEqual(link.params, [GOOD_ID, 'plat', 'repo', 42]);
  } finally {
    server.close();
  }
});

test('unknown / foreign / already-linked screenshotId is a 400, nothing filed', async () => {
  reset();
  poolHandler = async () => ({ rows: [] }); // lookup finds nothing
  const server = await startServer();
  try {
    const res = await postFeedback(server, {
      description: 'Something is broken', title: 'My title', screenshotId: GOOD_ID,
    });
    assert.equal(res.status, 400);
    assert.equal(ghCreates.length, 0);
  } finally {
    server.close();
  }
});

test('malformed screenshotId is a 400 without any lookup', async () => {
  reset();
  const server = await startServer();
  try {
    const res = await postFeedback(server, {
      description: 'Something is broken', title: 'My title', screenshotId: 'not-a-hex-id',
    });
    assert.equal(res.status, 400);
    assert.equal(poolQueries.some((q) => q.sql.includes('issue_screenshots')), false);
    assert.equal(ghCreates.length, 0);
  } finally {
    server.close();
  }
});

test('omitted screenshotId leaves the issue body byte-identical to today', async () => {
  reset();
  const server = await startServer();
  try {
    const res = await postFeedback(server, { description: 'Something is broken', title: 'My title' });
    assert.equal(res.status, 200);
    assert.equal(ghCreates.length, 1);
    assert.equal(ghCreates[0].body, '**Source:** usernode user (tester)\n\nSomething is broken');
    assert.equal(poolQueries.some((q) => q.sql.includes('issue_screenshots')), false);
  } finally {
    server.close();
  }
});

// ── Serving route ────────────────────────────────────────────────────

test('GET /issue-images/:id serves stored bytes with the immutable cache header', async () => {
  reset();
  poolHandler = async (sql, params) => {
    if (sql.includes('FROM issue_screenshots')) {
      assert.deepEqual(params, [GOOD_ID]);
      return { rows: [{ content_type: 'image/png', data: PNG }] };
    }
    return { rows: [] };
  };
  const server = await startServer();
  try {
    const res = await realFetch(`http://127.0.0.1:${server.address().port}/issue-images/${GOOD_ID}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(body.equals(PNG));
  } finally {
    server.close();
  }
});

test('GET /issue-images/:id 404s on bad or unknown ids', async () => {
  reset();
  const server = await startServer();
  try {
    const port = server.address().port;
    assert.equal((await realFetch(`http://127.0.0.1:${port}/issue-images/${'f'.repeat(32)}`)).status, 404);
    assert.equal((await realFetch(`http://127.0.0.1:${port}/issue-images/nope`)).status, 404);
    // The malformed id must never reach the DB.
    assert.equal(poolQueries.filter((q) => q.sql.includes('issue_screenshots')).length, 1);
  } finally {
    server.close();
  }
});
