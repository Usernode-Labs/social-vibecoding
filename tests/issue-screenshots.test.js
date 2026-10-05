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
  buildScreenshotsEmbed,
  MAX_SCREENSHOT_BYTES,
  // #3940: video uploads.
  MAX_VIDEO_BYTES,
  validateVideoUpload,
  classifyAttachmentUpload,
  buildAttachmentsEmbed,
} = require('../src/routes/feedback');
const { sniffVideoType } = require('../src/services/attachments');
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
// A minimal MP4 (ftyp box at offset 4) and WebM (EBML at offset 0), the two
// formats screen recorders produce.
const MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]),
  Buffer.alloc(64, 1),
]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 1)]);
const VIDEO_ID = 'cd'.repeat(16);
const VIDEO_ID_2 = 'ef'.repeat(16);

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
    // #3027: linking takes the list of ids and stays bound to the uploader.
    assert.deepEqual(link.params, [[GOOD_ID], 'plat', 'repo', 42, 7]);
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
    assert.equal(ghCreates[0].body, '**Source:** Homeroom user (tester)\n\nSomething is broken');
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

// ── #3940: video uploads ─────────────────────────────────────────────

test('sniffVideoType: MP4 and WebM accepted, a renamed PNG and garbage rejected', () => {
  assert.equal(sniffVideoType(MP4), 'video/mp4');
  assert.equal(sniffVideoType(WEBM), 'video/webm');
  assert.equal(sniffVideoType(PNG), null, 'a PNG is not a video, by its bytes');
  assert.equal(sniffVideoType(GIF), null);
  assert.equal(sniffVideoType(Buffer.from([0x1a, 0x45, 0xdf])), null, 'truncated signature');
  assert.equal(sniffVideoType(Buffer.alloc(0)), null);
  assert.equal(sniffVideoType(null), null);
});

test('validateVideoUpload: MP4 and WebM accepted with their content types', () => {
  assert.deepEqual(validateVideoUpload(MP4), { ok: true, contentType: 'video/mp4' });
  assert.deepEqual(validateVideoUpload(WEBM), { ok: true, contentType: 'video/webm' });
  assert.equal(validateVideoUpload(PNG).ok, false);
  assert.equal(validateVideoUpload(Buffer.alloc(0)).ok, false);
  assert.equal(validateVideoUpload(null).ok, false);
});

test('validateVideoUpload: refusals name the rule that was hit', () => {
  const bad = validateVideoUpload(PNG);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /MP4 or WebM/);
  const big = Buffer.alloc(MAX_VIDEO_BYTES + 1, 1);
  MP4.copy(big, 0);
  const over = validateVideoUpload(big);
  assert.equal(over.ok, false);
  assert.match(over.error, /Video too large/);
  assert.equal(MAX_VIDEO_BYTES, 16 * 1024 * 1024);
});

test('classifyAttachmentUpload: images keep their rules, videos keep theirs', () => {
  assert.deepEqual(classifyAttachmentUpload(PNG), { ok: true, kind: 'image', contentType: 'image/png' });
  assert.deepEqual(classifyAttachmentUpload(MP4), { ok: true, kind: 'video', contentType: 'video/mp4' });
  assert.deepEqual(classifyAttachmentUpload(WEBM), { ok: true, kind: 'video', contentType: 'video/webm' });
  // An over-cap image still answers the image copy…
  const bigImage = Buffer.alloc(MAX_SCREENSHOT_BYTES + 1, 1);
  PNG.copy(bigImage, 0);
  const imageVerdict = classifyAttachmentUpload(bigImage);
  assert.equal(imageVerdict.ok, false);
  assert.match(imageVerdict.error, /Screenshot too large/);
  // …and an over-cap recording answers the video copy, not the image one.
  const bigVideo = Buffer.alloc(MAX_VIDEO_BYTES + 1, 1);
  MP4.copy(bigVideo, 0);
  const videoVerdict = classifyAttachmentUpload(bigVideo);
  assert.equal(videoVerdict.ok, false);
  assert.match(videoVerdict.error, /Video too large/);
  // A non-image, non-video body refuses with a sentence about both.
  const junk = classifyAttachmentUpload(Buffer.alloc(64, 7));
  assert.equal(junk.ok, false);
  assert.ok(junk.error);
});

test('buildAttachmentsEmbed: images keep the exact lines, a video is a link', () => {
  const A = 'a1'.repeat(16);
  const V = VIDEO_ID;
  const domain = 'example.org';
  // Image-only is byte-identical to buildScreenshotsEmbed.
  assert.equal(buildAttachmentsEmbed([], domain), '');
  assert.equal(buildAttachmentsEmbed([{ id: A, contentType: 'image/png' }], domain),
    buildScreenshotsEmbed([A], domain));
  const images = ['11'.repeat(16), '22'.repeat(16), '33'.repeat(16)];
  assert.equal(
    buildAttachmentsEmbed(images.map((id) => ({ id, contentType: 'image/jpeg' })), domain),
    buildScreenshotsEmbed(images, domain),
  );
  // One video: the exact line the spec fixes.
  assert.equal(
    buildAttachmentsEmbed([{ id: V, contentType: 'video/mp4' }], domain),
    `\n\n**Screen recording:**\n[Screen recording](https://${domain}/issue-images/${V})`,
  );
  // Mixed: images first, then the recording link.
  assert.equal(
    buildAttachmentsEmbed(
      [{ id: A, contentType: 'image/png' }, { id: V, contentType: 'video/webm' }],
      domain,
    ),
    `${buildScreenshotEmbed(A, domain)}\n\n**Screen recording:**\n[Screen recording](https://${domain}/issue-images/${V})`,
  );
});

test('POST /api/feedback/screenshot stores a video with its sniffed content type', async () => {
  reset();
  const server = await startServer();
  try {
    for (const [body, contentType] of [[MP4, 'video/mp4'], [WEBM, 'video/webm']]) {
      const res = await realFetch(`http://127.0.0.1:${server.address().port}/api/feedback/screenshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body,
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.match(data.id, /^[a-f0-9]{32}$/);
      const insert = poolQueries.find((q) => q.sql.includes('INSERT INTO issue_screenshots')
        && q.params[2] === contentType);
      assert.ok(insert, `expected a ${contentType} row`);
      assert.equal(insert.params[3], body.length);
    }
  } finally {
    server.close();
  }
});

test('the raised raw limit lets an over-cap upload reach the friendly 400, not a parser 413', async () => {
  reset();
  const server = await startServer();
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/feedback/screenshot`;
    // 6 MB of PNG-named bytes: over the 4 MB image cap, and (before #3940)
    // over the old 5 MB parser limit, which answered a bare 413.
    const bigImage = Buffer.alloc(MAX_SCREENSHOT_BYTES + 2 * 1024 * 1024, 1);
    PNG.copy(bigImage, 0);
    const imageRes = await realFetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bigImage,
    });
    assert.equal(imageRes.status, 400, 'expected the validator, not a parser 413');
    assert.match((await imageRes.json()).error, /Screenshot too large/);
    // 16 MB + 1 of MP4-named bytes: over the video cap, under the parser's.
    const bigVideo = Buffer.alloc(MAX_VIDEO_BYTES + 1, 1);
    MP4.copy(bigVideo, 0);
    const videoRes = await realFetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bigVideo,
    });
    assert.equal(videoRes.status, 400);
    assert.match((await videoRes.json()).error, /Video too large/);
    assert.equal(poolQueries.some((q) => q.sql.includes('INSERT INTO issue_screenshots')), false);
  } finally {
    server.close();
  }
});

// ── #3940: one video per submit, and its link in the issue body ──────

function contentTypeLookup(owned) {
  // owned: Map(id → content_type) of rows this user owns, unlinked.
  return async (sql, params) => {
    if (sql.includes('FROM issue_screenshots')) {
      const asked = Array.isArray(params[0]) ? params[0] : [params[0]];
      return { rows: asked.filter((id) => owned.has(id)).map((id) => ({ id, content_type: owned.get(id) })) };
    }
    return { rows: [] };
  };
}

test('two videos are refused with the one-video sentence, nothing filed', async () => {
  reset();
  poolHandler = contentTypeLookup(new Map([
    [GOOD_ID, 'video/mp4'], [VIDEO_ID, 'video/webm'], [VIDEO_ID_2, 'video/mp4'],
  ]));
  const server = await startServer();
  try {
    const res = await postFeedback(server, {
      description: 'Two recordings', title: 'T',
      screenshotIds: [GOOD_ID, VIDEO_ID, VIDEO_ID_2],
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /at most one video/);
    assert.equal(ghCreates.length, 0);
    assert.equal(poolQueries.some((q) => q.sql.includes('UPDATE issue_screenshots')), false);
  } finally {
    server.close();
  }
});

test('one video beside images embeds as a Screen recording link and links every row', async () => {
  reset();
  poolHandler = contentTypeLookup(new Map([
    [GOOD_ID, 'image/png'], [VIDEO_ID, 'video/mp4'],
  ]));
  const server = await startServer();
  try {
    const res = await postFeedback(server, {
      description: 'A stuck loading screen', title: 'T', screenshotIds: [GOOD_ID, VIDEO_ID],
    });
    assert.equal(res.status, 200);
    assert.equal(ghCreates.length, 1);
    const body = ghCreates[0].body;
    // Images keep their embeds…
    assert.ok(body.endsWith(buildScreenshotEmbed(GOOD_ID, USERNODE_DOMAIN)
      + `\n\n**Screen recording:**\n[Screen recording](https://${USERNODE_DOMAIN}/issue-images/${VIDEO_ID})`),
      `issue body should end with the image embed then the recording link, got: ${body}`);
    assert.ok(body.includes(`![Screenshot](https://${USERNODE_DOMAIN}/issue-images/${GOOD_ID})`));
    // …and the video is a link, not an embed.
    assert.equal(body.includes(`![Screenshot](${USERNODE_DOMAIN}/issue-images/${VIDEO_ID})`), false);
    const link = poolQueries.find((q) => q.sql.includes('UPDATE issue_screenshots'));
    assert.deepEqual(link.params, [[GOOD_ID, VIDEO_ID], 'plat', 'repo', 42, 7]);
  } finally {
    server.close();
  }
});

test('a video-only report carries only the Screen recording line', async () => {
  reset();
  poolHandler = contentTypeLookup(new Map([[VIDEO_ID, 'video/webm']]));
  const server = await startServer();
  try {
    const res = await postFeedback(server, {
      description: 'Button does nothing when tapped', title: 'T', screenshotIds: [VIDEO_ID],
    });
    assert.equal(res.status, 200);
    assert.equal(ghCreates[0].body.endsWith(
      `\n\n**Screen recording:**\n[Screen recording](https://${USERNODE_DOMAIN}/issue-images/${VIDEO_ID})`,
    ), true);
    assert.equal(ghCreates[0].body.includes('Screenshot'), false);
  } finally {
    server.close();
  }
});

// ── #3940: serving a recording with Range support ────────────────────

test('a stored video answers a Range request with 206 and Content-Range', async () => {
  reset();
  poolHandler = async (sql) => {
    if (sql.includes('FROM issue_screenshots')) {
      return { rows: [{ content_type: 'video/mp4', data: MP4 }] };
    }
    return { rows: [] };
  };
  const server = await startServer();
  try {
    const res = await realFetch(`http://127.0.0.1:${server.address().port}/issue-images/${VIDEO_ID}`, {
      headers: { Range: 'bytes=4-11' },
    });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-type'), 'video/mp4');
    assert.equal(res.headers.get('accept-ranges'), 'bytes');
    assert.equal(res.headers.get('content-range'), `bytes 4-11/${MP4.length}`);
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(body.equals(MP4.subarray(4, 12)));
  } finally {
    server.close();
  }
});

test('a stored video answers an unparsable range with 416', async () => {
  reset();
  poolHandler = async (sql) => (sql.includes('FROM issue_screenshots')
    ? { rows: [{ content_type: 'video/mp4', data: MP4 }] }
    : { rows: [] });
  const server = await startServer();
  try {
    const res = await realFetch(`http://127.0.0.1:${server.address().port}/issue-images/${VIDEO_ID}`, {
      headers: { Range: 'bytes=9999-' },
    });
    assert.equal(res.status, 416);
    assert.equal(res.headers.get('content-range'), `bytes */${MP4.length}`);
  } finally {
    server.close();
  }
});

test('a stored video without a range header, and an image row, still answer a plain 200', async () => {
  reset();
  poolHandler = async (sql, params) => {
    if (sql.includes('FROM issue_screenshots')) {
      const type = params[0] === GOOD_ID ? 'image/png' : 'video/webm';
      return { rows: [{ content_type: type, data: params[0] === GOOD_ID ? PNG : WEBM }] };
    }
    return { rows: [] };
  };
  const server = await startServer();
  try {
    const port = server.address().port;
    const videoRes = await realFetch(`http://127.0.0.1:${port}/issue-images/${VIDEO_ID}`);
    assert.equal(videoRes.status, 200);
    assert.equal(videoRes.headers.get('accept-ranges'), 'bytes', 'video keeps its range advert');
    assert.ok(Buffer.from(await videoRes.arrayBuffer()).equals(WEBM));
    const imageRes = await realFetch(`http://127.0.0.1:${port}/issue-images/${GOOD_ID}`);
    assert.equal(imageRes.status, 200);
    assert.equal(imageRes.headers.get('accept-ranges'), null, 'an image response stays as it was');
    assert.ok(Buffer.from(await imageRes.arrayBuffer()).equals(PNG));
  } finally {
    server.close();
  }
});
