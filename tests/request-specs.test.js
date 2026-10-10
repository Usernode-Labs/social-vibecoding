'use strict';

// Specs posted on a request (services/request-specs.js, routes/request-specs.js).
//
// What these pin:
//   1. a spec is checked before anything is stored, and an oversized one is
//      refused with the numbers rather than kept as its projection alone;
//   2. a post lives on ONE planning record per author per request: a paused,
//      branchless session linked to the request, so it uses no container and
//      counts against no session cap, and a repost is its next version;
//   3. every version is shared with the group on the way in, and announced
//      with the bot's own spec card in the request's thread and a markdown
//      copy on the GitHub issue, neither of which can take the post back;
//   4. the list reads every session linked to the request, shared versions
//      and the viewer's own only;
//   5. the route asks for membership, collaborator access and an open
//      request, and refuses a bad spec before reading GitHub.
//
// Run with: node --test tests/request-specs.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const specs = require('../src/services/request-specs');
const specHtml = require('../src/services/spec-html');

const HTML = [
  '<article data-spec>',
  '  <h1>Spinner on the being-made screen</h1>',
  '  <p>Show progress apart from the thumbnail.</p>',
  '  <section data-spec-tab="user">',
  '    <figure data-screens><ol data-changes><li data-change="1">A spinner replaces Step N of 7</li></ol>',
  '      <template data-screen data-size="phone"><div data-side="before">Step 1 of 7</div><div data-side="after" data-change="1">Spinning up your app</div></template>',
  '    </figure>',
  '    <h3>Questions</h3><p>None.</p>',
  '  </section>',
  '  <section data-spec-tab="tech"><table><tr><th>File</th></tr><tr><td>made.tsx</td></tr></table></section>',
  '</article>',
].join('\n');

const MARKDOWN = '# Pre-fill the make screen\n\n## User-facing changes\n\nIt says what you told us.\n\n## Technical implementation\n\nRead the waitlist answer.';

// ── 1. Checked before anything is stored ───────────────────────────────

test('prepareSpec takes an HTML document or markdown, and refuses nothing silently', () => {
  const html = specs.prepareSpec(HTML);
  assert.equal(html.ok, true);
  assert.equal(html.format, 'html');
  assert.ok(html.html.startsWith('<article data-spec>'));
  assert.match(html.markdown, /^# Spinner on the being-made screen/, 'the markdown copy leads with the title');

  const fenced = specs.prepareSpec('```html\n' + HTML + '\n```');
  assert.equal(fenced.format, 'html', 'a fenced document is unwrapped like the scout output is');

  const md = specs.prepareSpec(MARKDOWN);
  assert.deepEqual([md.ok, md.format, md.html], [true, 'markdown', null]);

  for (const bad of ['', '   ', null, 42]) {
    const out = specs.prepareSpec(bad);
    assert.equal(out.ok, false);
    assert.equal(out.code, 'invalid_request');
  }
});

test('an oversized spec is refused with the numbers, never kept as its projection', () => {
  const pad = '<p>' + 'x'.repeat(specs.MAX_SPEC_HTML_CHARS) + '</p>';
  const huge = HTML.replace('</article>', pad + '</article>');
  const out = specs.prepareSpec(huge);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'spec_too_long');
  assert.equal(out.limitChars, specHtml.MAX_SPEC_HTML_CHARS);
  assert.equal(out.actualChars, huge.length);
  assert.match(out.message, /Nothing was posted/);

  const longMd = specs.prepareSpec('# T\n\n' + 'y'.repeat(specs.MAX_SPEC_MARKDOWN_CHARS));
  assert.equal(longMd.code, 'spec_too_long');
  assert.equal(longMd.limitChars, specs.MAX_SPEC_MARKDOWN_CHARS);
});

test('the GitHub copy says who posted it and where it is whole, and says when it is clipped', () => {
  const short = specs.specCommentText({
    username: 'ada', version: 2, markdown: MARKDOWN, format: 'html', webPath: 'https://h.example/#app/a/dev/issues/9',
  });
  assert.match(short, /^\*\*ada\*\* posted a plan for this request \(version 2\)\./);
  assert.match(short, /before\/after screens are in the plan card on Homeroom: https:\/\/h\.example/);
  assert.match(short, /<details><summary>The plan<\/summary>/);
  assert.ok(short.includes(MARKDOWN));
  assert.doesNotMatch(short, /@ada/, 'no @mention of the poster');

  const long = 'z'.repeat(specs.MAX_COMMENT_SPEC_CHARS + 10);
  const clipped = specs.specCommentText({ username: 'ada', version: 1, markdown: long, format: 'markdown' });
  assert.match(clipped, new RegExp(`The first ${specs.MAX_COMMENT_SPEC_CHARS} of ${long.length} characters`));
});

test('the thread card is the spec card the bot and the share route post', () => {
  const card = specs.specCard({ sessionId: 41, version: 3, markdown: MARKDOWN, user: { id: 7, username: 'ada' } });
  assert.equal(card.msgType, 'spec_share');
  assert.equal(card.content, '📋 ada posted a plan for this request: "Pre-fill the make screen" (version 3).');
  assert.deepEqual(Object.keys(card.metadata.specShare).sort(),
    ['builtAt', 'commitSha', 'prNumber', 'sessionId', 'sharedBy', 'snippet', 'title', 'totalChars', 'version']);
  assert.equal(card.metadata.specShare.sessionId, 41);
  assert.equal(card.metadata.specShare.version, 3);
  assert.deepEqual(card.metadata.specShare.sharedBy, { id: 7, username: 'ada' });
});

// ── 2/3. One planning record, versions, and the announcements ──────────

// A pool whose client records every statement and answers the few this
// module reads. `existing` is the author's record for the request, if any.
function fakePool({ existing = null, failOn = null } = {}) {
  const calls = [];
  let nextVersion = 1;
  const query = async (sql, params) => {
    const text = String(sql);
    calls.push({ sql: text, params });
    if (failOn && failOn.test(text)) throw new Error('boom');
    if (/FROM chat_sessions\s+WHERE app_id = \$1 AND user_id = \$2 AND source = \$3/.test(text)) {
      return { rows: existing ? [{ id: existing }] : [] };
    }
    if (/INSERT INTO chat_sessions/.test(text)) return { rows: [{ id: 501 }] };
    if (/INSERT INTO chat_session_specs/.test(text)) return { rows: [{ version: nextVersion++ }] };
    return { rows: [] };
  };
  return {
    calls,
    query,
    async connect() { return { query, release() {} }; },
  };
}

function fakeDeps({ cardThrows = false, commentThrows = false } = {}) {
  const sent = { cards: [], comments: [] };
  return {
    sent,
    ws: {
      async sendBotMessage(pool, appId, msg) {
        if (cardThrows) throw new Error('ws down');
        sent.cards.push({ appId, ...msg });
        return { id: 1 };
      },
    },
    github: {
      isEnabled: () => true,
      async createIssueComment(owner, repo, number, body) {
        if (commentThrows) throw new Error('github down');
        sent.comments.push({ owner, repo, number, body });
        return { id: 2 };
      },
    },
  };
}

const APP = { id: 9, slug: 'cool-app', self_hosted: false };
const REPO = { owner: 'acme', repo: 'cool-app' };
const ADA = { id: 7, username: 'ada' };

test('the first post opens a paused, branchless record linked to the request, and shares version 1', async () => {
  const pool = fakePool();
  const deps = fakeDeps();
  const out = await specs.postRequestSpec(pool, {
    app: APP, repo: REPO, issueNumber: 4041, issueTitle: 'Being made screen', user: ADA, text: HTML,
    webPath: 'https://h.example/#app/cool-app/dev/issues/4041',
  }, deps);
  assert.deepEqual(
    { sessionId: out.sessionId, version: out.version, createdRecord: out.createdRecord, format: out.format },
    { sessionId: 501, version: 1, createdRecord: true, format: 'html' }
  );
  assert.equal(out.title, 'Spinner on the being-made screen');
  assert.equal(out.commentPosted, true);

  const sqls = pool.calls.map((c) => c.sql);
  assert.match(sqls[0], /^BEGIN$/);
  assert.match(sqls[1], /pg_advisory_xact_lock/, 'one record per author per request, even under two posts at once');
  const insert = pool.calls.find((c) => /INSERT INTO chat_sessions/.test(c.sql));
  assert.match(insert.sql, /VALUES \(\$1, \$2, NULL, 'paused', \$3, \$4, ARRAY\[\$4::int\], TRUE, \$5, FALSE\)/,
    'no branch, paused: no container, and no session cap');
  assert.deepEqual(insert.params.slice(0, 4), [9, 7, specs.SPEC_SOURCE, 4041]);
  assert.equal(insert.params[4], 'Plan for #4041 Being made screen');

  const stored = pool.calls.find((c) => /UPDATE chat_sessions SET spec_md/.test(c.sql));
  assert.match(stored.params[2], /^<article data-spec-styles="kit" data-spec>/,
    'another app\'s screens draw with the native kit, as the scout\'s do');
  const version = pool.calls.find((c) => /INSERT INTO chat_session_specs/.test(c.sql));
  assert.match(version.sql, /shared_to_group_at\)[\s\S]*NOW\(\)/, 'shared with the group on the way in');
  assert.match(sqls[sqls.length - 1], /^COMMIT$/);

  assert.equal(deps.sent.cards.length, 1);
  assert.deepEqual(deps.sent.cards[0].thread, { type: 'issue', ref: 4041 });
  assert.equal(deps.sent.cards[0].msgType, 'spec_share');
  assert.deepEqual(deps.sent.cards[0].user, ADA, 'posted as the person, not the bot');
  assert.equal(deps.sent.comments.length, 1);
  assert.deepEqual([deps.sent.comments[0].owner, deps.sent.comments[0].repo, deps.sent.comments[0].number],
    ['acme', 'cool-app', 4041]);
});

test('a repost is the next version on the same record', async () => {
  const pool = fakePool({ existing: 333 });
  const out = await specs.postRequestSpec(pool, {
    app: APP, repo: REPO, issueNumber: 4041, user: ADA, text: MARKDOWN,
  }, fakeDeps());
  assert.equal(out.sessionId, 333);
  assert.equal(out.createdRecord, false);
  assert.equal(out.format, 'markdown');
  assert.ok(!pool.calls.some((c) => /INSERT INTO chat_sessions/.test(c.sql)), 'no second record');
  const stored = pool.calls.find((c) => /UPDATE chat_sessions SET spec_md/.test(c.sql));
  assert.equal(stored.params[2], null, 'a markdown spec clears any earlier HTML document');
});

test('the platform\'s own app draws its screens with the shell\'s stylesheet', async () => {
  const pool = fakePool();
  await specs.postRequestSpec(pool, {
    app: { id: 1, slug: 'usernode-2d5619', self_hosted: false }, repo: REPO, issueNumber: 1, user: ADA, text: HTML,
  }, fakeDeps());
  const stored = pool.calls.find((c) => /UPDATE chat_sessions SET spec_md/.test(c.sql));
  assert.match(stored.params[2], /data-spec-styles="platform"/);
});

test('a failed write stores nothing, and a failed card or comment never takes the post back', async () => {
  const failing = fakePool({ failOn: /INSERT INTO chat_session_specs/ });
  await assert.rejects(() => specs.postRequestSpec(failing, {
    app: APP, repo: REPO, issueNumber: 1, user: ADA, text: HTML,
  }, fakeDeps()), /boom/);
  assert.ok(failing.calls.some((c) => c.sql === 'ROLLBACK'));

  const pool = fakePool();
  const out = await specs.postRequestSpec(pool, {
    app: APP, repo: REPO, issueNumber: 1, user: ADA, text: HTML,
  }, fakeDeps({ cardThrows: true, commentThrows: true }));
  assert.equal(out.version, 1, 'stored and readable');
  assert.equal(out.commentPosted, false);
});

test('a refused spec reaches no database', async () => {
  const pool = fakePool();
  await assert.rejects(() => specs.postRequestSpec(pool, {
    app: APP, repo: REPO, issueNumber: 1, user: ADA, text: '',
  }, fakeDeps()), (err) => err instanceof specs.SpecError && err.code === 'invalid_request');
  assert.equal(pool.calls.length, 0);
});

// ── 4. The list ────────────────────────────────────────────────────────

test('the list reads every session on the request, shared versions and the viewer\'s own', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return {
        rows: [
          { session_id: 501, version: 2, created_at: '2026-10-06T12:00:00Z', shared_to_group_at: '2026-10-06T12:00:00Z',
            is_html: true, markdown_chars: 900, html_chars: 4000, head: '# Spinner\n\nBody', user_id: 7, source: 'request_spec', status: 'paused', username: 'ada' },
          { session_id: 88, version: 1, created_at: '2026-10-05T12:00:00Z', shared_to_group_at: '2026-10-05T12:00:00Z',
            is_html: false, markdown_chars: 300, html_chars: 0, head: 'No title here', user_id: 3, source: null, status: 'active', username: 'homeroom-bot' },
        ],
      };
    },
  };
  const out = await specs.listRequestSpecs(pool, { appId: 9, issueNumber: 4041, viewerId: 7 });
  assert.match(calls[0].sql, /cs\.created_from_issue_number = \$2 OR \$2 = ANY\(cs\.linked_issues\)/);
  assert.match(calls[0].sql, /s\.shared_to_group_at IS NOT NULL OR cs\.user_id = \$3/);
  assert.deepEqual(calls[0].params, [9, 4041, 7, specs.MAX_LISTED_SPECS]);
  assert.deepEqual(out[0], {
    sessionId: 501, version: 2, author: 'ada', authorId: 7, kind: 'posted', format: 'html',
    title: 'Spinner', markdownChars: 900, htmlChars: 4000, shared: true, createdAt: '2026-10-06T12:00:00.000Z',
  });
  assert.equal(out[1].kind, 'session');
  assert.equal(out[1].title, null);
});

// ── 5. The routes ──────────────────────────────────────────────────────

function loadRoutes({ app = { id: 9, slug: 'cool-app', self_hosted: false, repo_url: 'https://github.com/acme/cool-app' }, openIssues = [{ number: 4041, title: 'Being made' }], note = null, enabled = true, posted = null } = {}) {
  const ids = {
    pool: require.resolve('../src/db/pool'),
    github: require.resolve('../src/services/github'),
    appAccess: require.resolve('../src/services/app-access'),
    communities: require.resolve('../src/services/communities'),
    service: require.resolve('../src/services/request-specs'),
    subject: require.resolve('../src/routes/request-specs'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];
  const seen = { fetches: 0, posts: [], accessLevels: [] };
  const stub = (id, exports) => { require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] }; };
  stub(ids.pool, { getPool: () => ({}) });
  stub(ids.github, {
    isEnabled: () => enabled,
    fetchPublicIssues: async () => { seen.fetches += 1; return { issues: openIssues, note }; },
  });
  stub(ids.appAccess, {
    ACCESS_COLUMNS: 'id, slug',
    getAppForUser: async (pool, slug, user, level) => { seen.accessLevels.push(level); return app; },
  });
  stub(ids.communities, { requireAppMembership: () => (req, res, next) => next() });
  stub(ids.service, {
    ...specs,
    postRequestSpec: async (pool, args) => {
      seen.posts.push(args);
      return posted || { sessionId: 501, version: 1, createdRecord: true, format: 'html', title: 'T', markdownChars: 10, htmlChars: 20, commentPosted: true };
    },
    listRequestSpecs: async () => [{ sessionId: 501, version: 1 }],
  });
  delete require.cache[ids.subject];
  const { requestSpecRoutes } = require('../src/routes/request-specs');
  const router = requestSpecRoutes({});
  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  const handler = (method, routePath) => {
    for (const layer of router.stack) {
      if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
        return { all: layer.route.stack.map((l) => l.handle), last: layer.route.stack[layer.route.stack.length - 1].handle };
      }
    }
    throw new Error(`${method} ${routePath} not found`);
  };
  return { router, seen, restore, handler };
}

function mockRes() {
  return {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

const POST = '/api/apps/:slug/issues/:number/spec';
const LIST = '/api/apps/:slug/issues/:number/specs';

test('posting takes part: limited, membership-gated, collaborator access, open request only', async () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/request-specs.js'), 'utf8');
  assert.match(src, /router\.post\('\/api\/apps\/:slug\/issues\/:number\/spec', requestSpecLimiter, communities\.requireAppMembership\(pool\)/);

  const r = loadRoutes();
  try {
    const res = mockRes();
    await r.handler('post', POST).last({
      params: { slug: 'cool-app', number: '4041' }, user: ADA, body: { spec: HTML },
    }, res);
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.equal(res.body.version, 1);
    assert.deepEqual(r.seen.accessLevels, ['collab']);
    assert.equal(r.seen.posts.length, 1);
    assert.equal(r.seen.posts[0].issueNumber, 4041);
    assert.equal(r.seen.posts[0].issueTitle, 'Being made');
    assert.deepEqual(r.seen.posts[0].repo, { owner: 'acme', repo: 'cool-app' });
    assert.match(r.seen.posts[0].webPath, /\/#app\/cool-app\/dev\/issues\/4041$/);
  } finally { r.restore(); }
});

test('a bad spec is refused before GitHub is read; a closed or unreadable request files nothing', async () => {
  let r = loadRoutes();
  try {
    const res = mockRes();
    await r.handler('post', POST).last({ params: { slug: 'cool-app', number: '4041' }, user: ADA, body: { spec: '' } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'invalid_request');
    assert.equal(r.seen.fetches, 0);
    const notString = mockRes();
    await r.handler('post', POST).last({ params: { slug: 'cool-app', number: '4041' }, user: ADA, body: { spec: 5 } }, notString);
    assert.equal(notString.statusCode, 400);
    const badNumber = mockRes();
    await r.handler('post', POST).last({ params: { slug: 'cool-app', number: 'x' }, user: ADA, body: { spec: HTML } }, badNumber);
    assert.equal(badNumber.statusCode, 400);
  } finally { r.restore(); }

  r = loadRoutes({ openIssues: [{ number: 1 }] });
  try {
    const res = mockRes();
    await r.handler('post', POST).last({ params: { slug: 'cool-app', number: '4041' }, user: ADA, body: { spec: HTML } }, res);
    assert.equal(res.statusCode, 404);
    assert.match(res.body.error, /isn't open/);
    assert.equal(r.seen.posts.length, 0);
  } finally { r.restore(); }

  r = loadRoutes({ note: 'rate limited' });
  try {
    const res = mockRes();
    await r.handler('post', POST).last({ params: { slug: 'cool-app', number: '4041' }, user: ADA, body: { spec: HTML } }, res);
    assert.equal(res.statusCode, 422);
    assert.equal(r.seen.posts.length, 0);
  } finally { r.restore(); }

  r = loadRoutes({ app: null });
  try {
    const res = mockRes();
    await r.handler('post', POST).last({ params: { slug: 'cool-app', number: '4041' }, user: ADA, body: { spec: HTML } }, res);
    assert.equal(res.statusCode, 404);
  } finally { r.restore(); }
});

test('an oversized spec answers with the numbers', async () => {
  const r = loadRoutes();
  try {
    const res = mockRes();
    const huge = HTML.replace('</article>', '<p>' + 'x'.repeat(specs.MAX_SPEC_HTML_CHARS) + '</p></article>');
    await r.handler('post', POST).last({ params: { slug: 'cool-app', number: '4041' }, user: ADA, body: { spec: huge } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'spec_too_long');
    assert.equal(res.body.limitChars, specs.MAX_SPEC_HTML_CHARS);
    assert.equal(res.body.actualChars, huge.length);
  } finally { r.restore(); }
});

test('listing needs only view access', async () => {
  const r = loadRoutes();
  try {
    const res = mockRes();
    await r.handler('get', LIST).last({ params: { slug: 'cool-app', number: '4041' }, user: ADA }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(r.seen.accessLevels, ['view']);
    assert.deepEqual(res.body.specs, [{ sessionId: 501, version: 1 }]);
    assert.equal(res.body.listLimit, specs.MAX_LISTED_SPECS);
  } finally { r.restore(); }
});

test('the post route gets its own body limit, scoped to that one path', () => {
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const scoped = server.indexOf("/^\\/api\\/apps\\/[^/]+\\/issues\\/[^/]+\\/spec$/.test(req.path)");
  assert.ok(scoped > 0, 'the spec path has its own test');
  assert.match(server.slice(scoped, scoped + 120), /return express\.json\(\{ limit: '1mb' \}\)/);
  assert.match(server, /app\.use\(requestSpecRoutes\(config\)\);/);
});
