'use strict';

// POST /api/apps/:slug/issues takes `screenshotIds` on an ordinary request.
//
// The connector's create_request uploads each image through the feedback
// dialog's route (POST /api/feedback/screenshot) and files the request with
// the ids. The route holds them to the feedback route's own rules: 32-hex,
// at most three, every one owned by the caller and not yet linked, all
// checked before GitHub is called. The body gets the same embed lines a
// person's report does, the rows are stamped with the filed issue so the
// orphan sweep keeps them, and a body the embeds push past GitHub's limit is
// refused with the numbers rather than trimmed.
//
// Same harness shape as tests/close-issue-proposal.test.js: collaborators
// stubbed through require.cache, the handler driven off the router stack.
//
// Run with: node --test tests/issues-request-screenshots.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { USERNODE_DOMAIN } = require('../src/services/caddy');
const { buildScreenshotsEmbed } = require('../src/routes/feedback');

const APP = { id: 9, slug: 'cool-app', repo_url: 'https://github.com/acme/cool-app' };
const A = 'a1'.repeat(16);
const B = 'b2'.repeat(16);
const C = 'c3'.repeat(16);
const D = 'd4'.repeat(16);

// First matching [regex, fn] wins; fn may throw. Every call is recorded.
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

// The ownership lookup answers with exactly the asked ids this user owns
// and has not linked yet; the INSERT echoes the row it was given.
function poolFor({ owned = [], linkThrows = false } = {}) {
  return makePool([
    [/SELECT id FROM issue_screenshots/, (params) => {
      assert.equal(params[1], 42, 'looked up for the caller');
      return params[0].filter((id) => owned.includes(id)).map((id) => ({ id }));
    }],
    [/UPDATE issue_screenshots/, () => {
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
    noteIssueCreated: () => {},
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

test('screenshots are verified, embedded like a person\'s, stored and linked to the issue', async () => {
  const pool = poolFor({ owned: [A, B] });
  const { handler, spies, restore } = loadIssues(pool);
  try {
    const res = await file(handler, {
      kind: 'general', title: 'Save does nothing', description: 'Tap Save.', screenshotIds: [A, B],
    });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));

    const expected = `Tap Save.${buildScreenshotsEmbed([A, B], USERNODE_DOMAIN)}`;
    assert.equal(spies.ghCreates.length, 1);
    assert.equal(spies.ghCreates[0].args.body, expected, 'GitHub gets the embed lines, in order');
    assert.match(expected, new RegExp(`/issue-images/${A}\\)\\n!\\[Screenshot 2\\]`));

    const sqls = pool.calls.map((c) => c.sql);
    const lookup = sqls.findIndex((s) => /SELECT id FROM issue_screenshots/.test(s));
    const insert = sqls.findIndex((s) => /INSERT INTO issues/.test(s));
    const link = sqls.findIndex((s) => /UPDATE issue_screenshots/.test(s));
    assert.ok(lookup >= 0 && lookup < insert && insert < link, 'verify, file, then link');
    assert.match(sqls[lookup], /user_id = \$2 AND issue_number IS NULL/);
    assert.equal(pool.calls[insert].params[3], expected, 'the local row holds the same body');
    assert.deepEqual(pool.calls[link].params, [[A, B], 'acme', 'cool-app', 777, 42]);
    assert.match(sqls[link], /WHERE id = ANY\(\$1::varchar\[\]\) AND user_id = \$5 AND issue_number IS NULL/);
  } finally { restore(); }
});

test('no description: the body is the embed alone', async () => {
  const pool = poolFor({ owned: [A] });
  const { handler, spies, restore } = loadIssues(pool);
  try {
    const res = await file(handler, { kind: 'general', title: 'Look at this', screenshotIds: [A] });
    assert.equal(res.statusCode, 201);
    assert.equal(spies.ghCreates[0].args.body,
      `**Screenshot:**\n![Screenshot](https://${USERNODE_DOMAIN}/issue-images/${A})`);
  } finally { restore(); }
});

test('one foreign or already-linked id files nothing', async () => {
  const pool = poolFor({ owned: [A] });
  const { handler, spies, restore } = loadIssues(pool);
  try {
    const res = await file(handler, { kind: 'general', title: 'T', screenshotIds: [A, B] });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: 'Unknown or already-used screenshot' });
    assert.equal(spies.ghCreates.length, 0);
    assert.ok(!pool.calls.some((c) => /INSERT INTO issues|UPDATE issue_screenshots/.test(c.sql)));
  } finally { restore(); }
});

test('malformed ids, too many, and a governance kind are refused before any lookup', async () => {
  for (const [name, body, error] of [
    ['not an array', { kind: 'general', title: 'T', screenshotIds: A }, /must be an array/],
    ['not hex', { kind: 'general', title: 'T', screenshotIds: ['../../etc/passwd'] }, /Invalid screenshotId/],
    ['four', { kind: 'general', title: 'T', screenshotIds: [A, B, C, D] }, /at most 3 images/],
    ['close vote', {
      kind: 'close_issue', title: 'T', screenshotIds: [A],
      payload: { issueNumber: 3, reason: 'done' },
    }, /only be attached to an ordinary request/],
  ]) {
    const pool = poolFor({ owned: [A, B, C, D] });
    const { handler, spies, restore } = loadIssues(pool);
    try {
      const res = await file(handler, body);
      assert.equal(res.statusCode, 400, name);
      assert.match(res.body.error, error, name);
      assert.equal(pool.calls.length, 0, `${name}: no database call`);
      assert.equal(spies.ghCreates.length, 0, `${name}: nothing filed`);
    } finally { restore(); }
  }
});

test('the legacy single screenshotId is not this route\'s', async () => {
  const pool = poolFor({ owned: [A] });
  const { handler, spies, restore } = loadIssues(pool);
  try {
    const res = await file(handler, { kind: 'general', title: 'T', description: 'x', screenshotId: A });
    assert.equal(res.statusCode, 201);
    assert.equal(spies.ghCreates[0].args.body, 'x', 'ignored, as before');
    assert.ok(!pool.calls.some((c) => /issue_screenshots/.test(c.sql)));
  } finally { restore(); }
});

test('a body the embeds push past GitHub\'s limit is refused with the numbers', async () => {
  const pool = poolFor({ owned: [A] });
  const { subject, handler, spies, restore } = loadIssues(pool);
  try {
    const max = subject.MAX_GITHUB_ISSUE_BODY_CHARS;
    assert.equal(max, 65536);
    const embed = buildScreenshotsEmbed([A], USERNODE_DOMAIN);
    // Fits on its own; does not fit once the image line is appended.
    const description = 'x'.repeat(max - embed.length + 1);
    const res = await file(handler, { kind: 'general', title: 'T', description, screenshotIds: [A] });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'description_too_long');
    assert.match(res.body.message, new RegExp(`come to ${max + 1} characters, over GitHub's ${max}-character`));
    assert.match(res.body.message, /Nothing was filed\. Shorten the description by at least 1 characters\./);
    assert.equal(spies.ghCreates.length, 0);

    // One character less and it files.
    const fits = await file(handler, {
      kind: 'general', title: 'T', description: description.slice(1), screenshotIds: [A],
    });
    assert.equal(fits.statusCode, 201);
    assert.equal(spies.ghCreates[0].args.body.length, max);
  } finally { restore(); }
});

test('a failed link never fails a request that is already filed', async () => {
  const pool = poolFor({ owned: [A], linkThrows: true });
  const { handler, spies, restore } = loadIssues(pool);
  try {
    const res = await file(handler, { kind: 'general', title: 'T', screenshotIds: [A] });
    assert.equal(res.statusCode, 201);
    assert.equal(spies.ghCreates.length, 1);
  } finally { restore(); }
});

test('without screenshots the route files exactly as before', async () => {
  const pool = poolFor();
  const { handler, spies, restore } = loadIssues(pool);
  try {
    const res = await file(handler, { kind: 'general', title: 'Dark mode', description: 'Please.' });
    assert.equal(res.statusCode, 201);
    assert.equal(spies.ghCreates[0].args.body, 'Please.');
    assert.ok(!pool.calls.some((c) => /issue_screenshots/.test(c.sql)), 'no screenshot query at all');
  } finally { restore(); }
});
