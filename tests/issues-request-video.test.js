'use strict';

// POST /api/apps/:slug/issues takes a `videoId` on an ordinary request.
//
// The feedback dialog has attached one clip to a request since #3940; this
// is the same for the request route the connector's create_request files
// through, so a request an agent files can carry a walkthrough too. The
// route holds the id to the feedback route's rules: 32-hex, owned by the
// caller and not yet linked, checked before GitHub is called. The body gets
// the same link line Send feedback writes, after any screenshots (the request
// page plays that link inline), the row is stamped with the filed issue so
// the orphan sweep keeps it, and a body the line pushes past GitHub's limit
// is refused with the numbers rather than trimmed.
//
// Same harness as tests/issues-request-screenshots.test.js.
//
// Run with: node --test tests/issues-request-video.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { USERNODE_DOMAIN } = require('../src/services/caddy');
const { buildScreenshotsEmbed, buildVideoEmbed } = require('../src/routes/feedback');

const APP = { id: 9, slug: 'cool-app', repo_url: 'https://github.com/acme/cool-app' };
const SHOT = 'a1'.repeat(16);
const CLIP = 'f6'.repeat(16);
const OTHER = '0e'.repeat(16);

function makePool(handlers) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql: String(sql), params });
    for (const [re, fn] of handlers) {
      if (re.test(sql)) return { rows: fn(params) };
    }
    return { rows: [] };
  };
  return { calls, query, async connect() { return { query, release() {} }; } };
}

// The lookups answer with the asked ids this user owns and has not linked.
function poolFor({ shots = [], clips = [], linkThrows = false } = {}) {
  return makePool([
    [/SELECT id FROM issue_screenshots/, (params) => params[0].filter((id) => shots.includes(id)).map((id) => ({ id }))],
    [/SELECT id FROM issue_videos/, (params) => {
      assert.equal(params[1], 42, 'looked up for the caller');
      return clips.includes(params[0]) ? [{ id: params[0] }] : [];
    }],
    [/UPDATE issue_videos/, () => {
      if (linkThrows) throw new Error('connection reset');
      return [];
    }],
    [/INSERT INTO issues/, (params) => [{
      id: 62, app_id: 9, github_issue_number: params[1], title: params[2],
      description: params[3], kind: params[4],
    }]],
  ]);
}

function loadIssues(pool) {
  const ids = {
    pool: require.resolve('../src/db/pool'),
    ws: require.resolve('../src/services/ws'),
    github: require.resolve('../src/services/github'),
    appAccess: require.resolve('../src/services/app-access'),
    subject: require.resolve('../src/routes/issues'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];
  const spies = { ghCreates: [] };
  const stub = (id, exports) => {
    require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
  };
  stub(ids.pool, { getPool: () => pool });
  const realWs = orig.ws ? orig.ws.exports : require('../src/services/ws');
  stub(ids.ws, {
    ...realWs,
    sendSystemMessage: async () => {},
    pushIssueUpdate: () => {},
    pushAppUpdate: () => {},
  });
  stub(ids.github, {
    isEnabled: () => true,
    safeMention: (s) => s,
    createIssue: async (owner, repo, args) => {
      spies.ghCreates.push({ owner, repo, args });
      return { number: 777 };
    },
  });
  stub(ids.appAccess, {
    ACCESS_COLUMNS: '*',
    issueCollabGuard: () => (_req, _res, next) => next(),
    getAppForUser: async () => ({ ...APP }),
  });
  delete require.cache[ids.subject];
  const subject = require('../src/routes/issues');
  const router = subject.issueRoutes({ databaseUrl: 'postgres://test', jwtSecret: 's' });
  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
    delete require.cache[ids.subject];
  };
  let handler = null;
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === '/api/apps/:slug/issues' && layer.route.methods.post) {
      handler = layer.route.stack[layer.route.stack.length - 1].handle;
    }
  }
  assert.ok(handler, 'the create route is mounted');
  return { subject, handler, spies, restore };
}

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

async function file(handler, body) {
  const res = mockRes();
  await handler({
    params: { slug: 'cool-app' },
    user: { id: 42, username: 'maker' },
    cliAuthenticated: true,
    body,
  }, res);
  return res;
}

test('a video is verified, linked after the screenshots like Send feedback\'s, stored and stamped', async () => {
  const pool = poolFor({ shots: [SHOT], clips: [CLIP] });
  const { handler, spies, restore } = loadIssues(pool);
  try {
    const res = await file(handler, {
      kind: 'general', title: 'Discussions become threads', description: 'The walkthrough.',
      screenshotIds: [SHOT], videoId: CLIP,
    });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));

    const expected = `The walkthrough.${buildScreenshotsEmbed([SHOT], USERNODE_DOMAIN)}`
      + buildVideoEmbed(CLIP, USERNODE_DOMAIN);
    assert.equal(spies.ghCreates[0].args.body, expected, 'the stills, then the clip');
    // The exact link the request page turns into an inline player.
    assert.match(expected, new RegExp(`\\[Video recording\\]\\(https://${USERNODE_DOMAIN.replace(/\./g, '\\.')}/issue-videos/${CLIP}\\)$`));

    const sqls = pool.calls.map((c) => c.sql);
    const lookup = sqls.findIndex((s) => /SELECT id FROM issue_videos/.test(s));
    const insert = sqls.findIndex((s) => /INSERT INTO issues/.test(s));
    const link = sqls.findIndex((s) => /UPDATE issue_videos/.test(s));
    assert.ok(lookup >= 0 && lookup < insert && insert < link, 'verify, file, then link');
    assert.match(sqls[lookup], /user_id = \$2 AND issue_number IS NULL/);
    assert.deepEqual(pool.calls[link].params, [CLIP, 'acme', 'cool-app', 777, 42]);
  } finally { restore(); }
});

test('a video with no description: the body is its link alone', async () => {
  const pool = poolFor({ clips: [CLIP] });
  const { handler, spies, restore } = loadIssues(pool);
  try {
    const res = await file(handler, { kind: 'general', title: 'Watch this', videoId: CLIP });
    assert.equal(res.statusCode, 201);
    assert.equal(spies.ghCreates[0].args.body,
      `**Video:**\n[Video recording](https://${USERNODE_DOMAIN}/issue-videos/${CLIP})`);
  } finally { restore(); }
});

test('a foreign or already-linked video files nothing', async () => {
  const pool = poolFor({ clips: [CLIP] });
  const { handler, spies, restore } = loadIssues(pool);
  try {
    const res = await file(handler, { kind: 'general', title: 'T', videoId: OTHER });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'Unknown or already-used video');
    assert.equal(spies.ghCreates.length, 0);
    assert.ok(!pool.calls.some((c) => /INSERT INTO issues/.test(c.sql)));
  } finally { restore(); }
});

test('a malformed id, and a video on a governance kind, are refused before any lookup', async () => {
  const pool = poolFor({ clips: [CLIP] });
  const { handler, spies, restore } = loadIssues(pool);
  try {
    for (const videoId of ['short', CLIP.toUpperCase().replace(/F/g, 'G'), 12]) {
      const res = await file(handler, { kind: 'general', title: 'T', videoId });
      assert.equal(res.statusCode, 400, String(videoId));
      assert.equal(res.body.error, 'Invalid videoId');
    }
    const gov = await file(handler, { kind: 'close_issue', payload: { issueNumber: 3 }, videoId: CLIP });
    assert.equal(gov.statusCode, 400);
    assert.match(gov.body.error, /only be attached to an ordinary request/);
    assert.equal(pool.calls.length, 0);
    assert.equal(spies.ghCreates.length, 0);
  } finally { restore(); }
});

test('a body the video line pushes past GitHub\'s limit is refused with the numbers', async () => {
  const pool = poolFor({ clips: [CLIP] });
  const { subject, handler, spies, restore } = loadIssues(pool);
  try {
    const max = subject.MAX_GITHUB_ISSUE_BODY_CHARS;
    const embed = buildVideoEmbed(CLIP, USERNODE_DOMAIN);
    const description = 'x'.repeat(max - embed.length + 1);
    const res = await file(handler, { kind: 'general', title: 'T', description, videoId: CLIP });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'description_too_long');
    assert.match(res.body.message, /its video line come to/);
    assert.match(res.body.message, new RegExp(`come to ${max + 1} characters, over GitHub's ${max}-character`));
    assert.equal(spies.ghCreates.length, 0);

    const fits = await file(handler, { kind: 'general', title: 'T', description: description.slice(1), videoId: CLIP });
    assert.equal(fits.statusCode, 201);
    assert.equal(spies.ghCreates[0].args.body.length, max);
  } finally { restore(); }
});

test('a failed link never fails a request that is already filed', async () => {
  const pool = poolFor({ clips: [CLIP], linkThrows: true });
  const { handler, spies, restore } = loadIssues(pool);
  try {
    const res = await file(handler, { kind: 'general', title: 'T', videoId: CLIP });
    assert.equal(res.statusCode, 201);
    assert.equal(spies.ghCreates.length, 1);
  } finally { restore(); }
});

test('without a video the route files exactly as before', async () => {
  const pool = poolFor();
  const { handler, spies, restore } = loadIssues(pool);
  try {
    const res = await file(handler, { kind: 'general', title: 'Dark mode', description: 'Please.' });
    assert.equal(res.statusCode, 201);
    assert.equal(spies.ghCreates[0].args.body, 'Please.');
    assert.ok(!pool.calls.some((c) => /issue_videos/.test(c.sql)), 'no video query at all');
  } finally { restore(); }
});
