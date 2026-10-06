// Tests for the feedback-modal video attachment backend (#3940): magic-byte
// sniffing, upload validation, the embed line appended to filed issue
// bodies, the videoId gating on POST /api/feedback, and the public
// GET /issue-videos/:id serving route (with Range support, which video
// playback and seeking ask for).
//
// Same harness shape as tests/issue-screenshots.test.js.
//
// Run with: node --test tests/feedback-video.test.js

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
  validateVideoUpload,
  buildVideoEmbed,
  parseVideoId,
  MAX_VIDEO_BYTES,
  VIDEO_ID_RE,
} = require('../src/routes/feedback');
const { sniffVideoType } = require('../src/services/attachments');
const { issueVideoRoutes } = require('../src/routes/issue-videos');
const { USERNODE_DOMAIN } = require('../src/services/caddy');
const express = require('express');

function startServer() {
  const app = express();
  app.use((req, res, next) => { req.user = { id: 7, username: 'tester' }; next(); });
  app.use(express.json());
  app.use(feedbackRoutes({ platformRepoUrl: 'https://github.com/plat/repo' }));
  app.use(issueVideoRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function reset() {
  poolQueries = [];
  ghCreates = [];
  poolHandler = async () => ({ rows: [] });
}

const MP4 = Buffer.concat([Buffer.from('\x00\x00\x00\x18ftypisom'), Buffer.alloc(64, 1)]);
const MOV = Buffer.concat([Buffer.from('\x00\x00\x00\x18ftypqt  '), Buffer.alloc(64, 1)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 1)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);
const GOOD_ID = 'ab'.repeat(16);

// ── Pure sniffing and upload validation ─────────────────────────────

test('sniffVideoType: MP4, MOV and WebM by magic bytes, everything else null', () => {
  assert.equal(sniffVideoType(MP4), 'video/mp4');
  assert.equal(sniffVideoType(MOV), 'video/quicktime');
  assert.equal(sniffVideoType(WEBM), 'video/webm');
  assert.equal(sniffVideoType(PNG), null);
  assert.equal(sniffVideoType(Buffer.alloc(64, 7)), null);
  assert.equal(sniffVideoType(Buffer.alloc(0)), null);
  assert.equal(sniffVideoType(null), null);
});

test('validateVideoUpload: the three clip types accepted, others rejected', () => {
  assert.deepEqual(validateVideoUpload(MP4), { ok: true, contentType: 'video/mp4' });
  assert.deepEqual(validateVideoUpload(MOV), { ok: true, contentType: 'video/quicktime' });
  assert.deepEqual(validateVideoUpload(WEBM), { ok: true, contentType: 'video/webm' });
  assert.equal(validateVideoUpload(PNG).ok, false);
  assert.equal(validateVideoUpload(Buffer.alloc(0)).ok, false);
  assert.equal(validateVideoUpload(null).ok, false);
});

test('validateVideoUpload: over-cap upload rejected', () => {
  const big = Buffer.alloc(MAX_VIDEO_BYTES + 1, 1);
  MP4.copy(big, 0);
  const verdict = validateVideoUpload(big);
  assert.equal(verdict.ok, false);
  assert.match(verdict.error, /too large/i);
  assert.match(verdict.error, /50 MB/);
});

test('buildVideoEmbed: exact markdown suffix', () => {
  assert.equal(
    buildVideoEmbed('deadbeef'.repeat(4), 'example.org'),
    '\n\n**Video:**\n[Video recording](https://example.org/issue-videos/deadbeefdeadbeefdeadbeefdeadbeef)'
  );
});

test('parseVideoId: none, valid, malformed', () => {
  assert.deepEqual(parseVideoId({}), { ok: true, id: null });
  assert.deepEqual(parseVideoId({ videoId: null }), { ok: true, id: null });
  assert.deepEqual(parseVideoId({ videoId: '' }), { ok: true, id: null });
  assert.deepEqual(parseVideoId({ videoId: GOOD_ID }), { ok: true, id: GOOD_ID });
  assert.equal(parseVideoId({ videoId: 'not-a-hex-id' }).ok, false);
  assert.equal(parseVideoId({ videoId: 12345 }).ok, false);
  assert.equal(parseVideoId({ videoId: [GOOD_ID] }).ok, false);
  assert.equal(parseVideoId(null).ok, true);
  assert.equal(VIDEO_ID_RE.test(GOOD_ID), true);
  assert.equal(VIDEO_ID_RE.test('zz'.repeat(16)), false);
});

// ── Upload route ─────────────────────────────────────────────────────

test('POST /api/feedback/video stores an MP4 and returns a 32-hex id', async () => {
  reset();
  const server = await startServer();
  try {
    const res = await realFetch(`http://127.0.0.1:${server.address().port}/api/feedback/video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: MP4,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.match(data.id, /^[a-f0-9]{32}$/);
    const insert = poolQueries.find((q) => q.sql.includes('INSERT INTO issue_videos'));
    assert.ok(insert, 'expected the clip row to be inserted');
    assert.equal(insert.params[1], 7);
    assert.equal(insert.params[2], 'video/mp4');
    assert.equal(insert.params[3], MP4.length);
  } finally {
    server.close();
  }
});

test('POST /api/feedback/video rejects bad bytes and wrong content types', async () => {
  reset();
  const server = await startServer();
  try {
    const port = server.address().port;
    // A PNG is not a clip.
    const pngRes = await realFetch(`http://127.0.0.1:${port}/api/feedback/video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: PNG,
    });
    assert.equal(pngRes.status, 400);
    assert.match((await pngRes.json()).error, /MP4, WebM or MOV/);
    // Any other Content-Type is never parsed as a raw upload.
    const jsonRes = await realFetch(`http://127.0.0.1:${port}/api/feedback/video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: 'nope' }),
    });
    assert.equal(jsonRes.status, 400);
    assert.ok(poolQueries.every((q) => !q.sql.includes('INSERT INTO issue_videos')));
  } finally {
    server.close();
  }
});

// ── videoId on POST /api/feedback ────────────────────────────────────

async function postFeedback(server, body) {
  return realFetch(`http://127.0.0.1:${server.address().port}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('valid videoId appends the exact embed line and links the row', async () => {
  reset();
  // The ownership lookup finds the row; every other query is a no-op.
  poolHandler = async (sql) => {
    if (sql.includes('FROM issue_videos')) return { rows: [{ '?column?': 1 }] };
    return { rows: [] };
  };
  const server = await startServer();
  try {
    const res = await postFeedback(server, {
      description: 'Something is broken', title: 'My title', videoId: GOOD_ID,
    });
    assert.equal(res.status, 200);
    assert.equal(ghCreates.length, 1);
    const expectedSuffix = buildVideoEmbed(GOOD_ID, USERNODE_DOMAIN);
    assert.ok(ghCreates[0].body.endsWith(expectedSuffix),
      `issue body should end with the embed line, got: ${ghCreates[0].body}`);
    const link = poolQueries.find((q) => q.sql.includes('UPDATE issue_videos'));
    assert.ok(link, 'expected the row to be linked to the filed issue');
    assert.deepEqual(link.params, [GOOD_ID, 'plat', 'repo', 42, 7]);
  } finally {
    server.close();
  }
});

test('a clip rides AFTER the screenshots in the issue body', async () => {
  reset();
  poolHandler = async (sql) => {
    if (sql.includes('FROM issue_videos') || sql.includes('FROM issue_screenshots')) {
      return { rows: [{ '?column?': 1 }] };
    }
    return { rows: [] };
  };
  const server = await startServer();
  try {
    const shotId = 'cd'.repeat(16);
    const res = await postFeedback(server, {
      description: 'Something is broken', title: 'My title',
      screenshotId: shotId, videoId: GOOD_ID,
    });
    assert.equal(res.status, 200);
    assert.ok(ghCreates[0].body.includes('\n\n**Screenshot:**'));
    assert.ok(ghCreates[0].body.endsWith(buildVideoEmbed(GOOD_ID, USERNODE_DOMAIN)));
  } finally {
    server.close();
  }
});

test('unknown / foreign / already-linked videoId is a 400, nothing filed', async () => {
  reset();
  poolHandler = async () => ({ rows: [] }); // lookup finds nothing
  const server = await startServer();
  try {
    const res = await postFeedback(server, {
      description: 'Something is broken', title: 'My title', videoId: GOOD_ID,
    });
    assert.equal(res.status, 400);
    assert.equal(ghCreates.length, 0);
  } finally {
    server.close();
  }
});

test('malformed videoId is a 400 without any lookup', async () => {
  reset();
  const server = await startServer();
  try {
    const res = await postFeedback(server, {
      description: 'Something is broken', title: 'My title', videoId: 'not-a-hex-id',
    });
    assert.equal(res.status, 400);
    assert.equal(poolQueries.some((q) => q.sql.includes('issue_videos')), false);
    assert.equal(ghCreates.length, 0);
  } finally {
    server.close();
  }
});

test('omitted videoId leaves the issue body byte-identical to today', async () => {
  reset();
  const server = await startServer();
  try {
    const res = await postFeedback(server, { description: 'Something is broken', title: 'My title' });
    assert.equal(res.status, 200);
    assert.equal(ghCreates.length, 1);
    assert.equal(ghCreates[0].body, '**Source:** Homeroom user (tester)\n\nSomething is broken');
    assert.equal(poolQueries.some((q) => q.sql.includes('issue_videos')), false);
  } finally {
    server.close();
  }
});

// ── Serving route ────────────────────────────────────────────────────

const CLIP = Buffer.concat([MP4, Buffer.alloc(32, 2)]); // 79 bytes total

test('GET /issue-videos/:id serves stored bytes with the immutable cache header', async () => {
  reset();
  poolHandler = async (sql, params) => {
    if (sql.includes('FROM issue_videos')) {
      assert.deepEqual(params, [GOOD_ID]);
      return { rows: [{ content_type: 'video/mp4', size_bytes: CLIP.length, data: CLIP }] };
    }
    return { rows: [] };
  };
  const server = await startServer();
  try {
    const res = await realFetch(`http://127.0.0.1:${server.address().port}/issue-videos/${GOOD_ID}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'video/mp4');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(res.headers.get('accept-ranges'), 'bytes');
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(body.equals(CLIP));
  } finally {
    server.close();
  }
});

test('GET /issue-videos/:id answers Range requests', async () => {
  reset();
  poolHandler = async (sql) => {
    if (sql.includes('FROM issue_videos')) {
      return { rows: [{ content_type: 'video/mp4', size_bytes: CLIP.length, data: CLIP }] };
    }
    return { rows: [] };
  };
  const server = await startServer();
  try {
    const port = server.address().port;
    // bytes=8-15: exactly those bytes, with the full Content-Range.
    const slice = await realFetch(`http://127.0.0.1:${port}/issue-videos/${GOOD_ID}`, {
      headers: { Range: 'bytes=8-15' },
    });
    assert.equal(slice.status, 206);
    assert.equal(slice.headers.get('content-range'), `bytes 8-15/${CLIP.length}`);
    const sliced = Buffer.from(await slice.arrayBuffer());
    assert.ok(sliced.equals(CLIP.subarray(8, 16)));
    // An open-ended range reads to the end.
    const tail = await realFetch(`http://127.0.0.1:${port}/issue-videos/${GOOD_ID}`, {
      headers: { Range: 'bytes=-10' },
    });
    assert.equal(tail.status, 206);
    assert.equal(tail.headers.get('content-range'), `bytes ${CLIP.length - 10}-${CLIP.length - 1}/${CLIP.length}`);
    // An end past the file is clamped, not an error.
    const clamp = await realFetch(`http://127.0.0.1:${port}/issue-videos/${GOOD_ID}`, {
      headers: { Range: 'bytes=70-999' },
    });
    assert.equal(clamp.status, 206);
    assert.equal(clamp.headers.get('content-range'), `bytes 70-${CLIP.length - 1}/${CLIP.length}`);
    // A start past the end is unsatisfiable, per the Range spec.
    const bad = await realFetch(`http://127.0.0.1:${port}/issue-videos/${GOOD_ID}`, {
      headers: { Range: 'bytes=999-' },
    });
    assert.equal(bad.status, 416);
    assert.equal(bad.headers.get('content-range'), `bytes */${CLIP.length}`);
    // Garbage ranges are 416 too.
    const junk = await realFetch(`http://127.0.0.1:${port}/issue-videos/${GOOD_ID}`, {
      headers: { Range: 'notabytes=1-2' },
    });
    assert.equal(junk.status, 416);
  } finally {
    server.close();
  }
});

test('GET /issue-videos/:id 404s on bad or unknown ids', async () => {
  reset();
  const server = await startServer();
  try {
    const port = server.address().port;
    assert.equal((await realFetch(`http://127.0.0.1:${port}/issue-videos/${'f'.repeat(32)}`)).status, 404);
    assert.equal((await realFetch(`http://127.0.0.1:${port}/issue-videos/nope`)).status, 404);
    // The malformed id must never reach the DB.
    assert.equal(poolQueries.filter((q) => q.sql.includes('issue_videos')).length, 1);
  } finally {
    server.close();
  }
});
