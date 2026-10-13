// #4194: a request filed or edited in the app may be as long as GitHub
// allows (65,536 characters), not the 2,000 the feedback dialog stopped at.
// Pins the shared numbers on both sides, that every surface reads them, and
// that POST /api/feedback files a description at its limit whole, refuses
// one over it, and fits an app's state snapshot into the room that is left.
//
// Same harness shape as tests/feedback-page-state.test.js.
//
// Run with: node --test tests/issue-body-limit.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const poolMod = require('../src/db/pool');
poolMod.getPool = () => ({
  query: async (sql) => {
    if (/SELECT name, repo_url, .* FROM apps WHERE slug/.test(String(sql))) {
      return {
        rows: [{ id: 3, slug: 'demo-app', name: 'Demo App', repo_url: 'https://github.com/owner/demo-app',
          view_visibility: 'public', collab_visibility: 'public' }],
      };
    }
    return { rows: [] };
  },
});

const limits = require('../src/services/limits');
limits.resolveBillingPath = async () => ({ apiKey: null, byok: false });
const llm = require('../src/services/llm');
let titledFrom = [];
llm.isEnabled = () => true;
llm.generateIssueTitle = async ({ description }) => {
  titledFrom.push(description);
  return { title: 'Generated title', usage: undefined, model: 'claude-haiku-4-5' };
};

const github = require('../src/services/github');
github.isEnabled = () => true;
github.noteIssueCreated = () => {};
let appCreates = [];
github.createIssue = async (owner, repo, { title, body }) => {
  appCreates.push({ owner, repo, title, body });
  return { number: 9, html_url: `https://github.com/${owner}/${repo}/issues/9` };
};

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

const bodyLimit = require('../src/services/issue-body-limit');
const {
  feedbackRoutes,
  fitPageState,
  buildPageStateEmbed,
  TITLE_SOURCE_MAX,
  FEEDBACK_DESCRIPTION_MAX,
} = require('../src/routes/feedback');
const { MAX_GITHUB_ISSUE_BODY_CHARS } = require('../src/routes/issues');
const { MAX_REQUEST_BODY_CHARS } = require('../src/services/mcp-tools');
const express = require('express');

let nextUserId = 400;
function startServer() {
  const app = express();
  // The platform mounts a 1mb parser for this route (server.js); the
  // default 100kb would refuse a long report before the route saw it.
  app.use(express.json({ limit: '1mb' }));
  const userId = nextUserId++;
  app.use((req, res, next) => { req.user = { id: userId, username: 'tester' }; next(); });
  app.use(feedbackRoutes({ platformRepoUrl: 'https://github.com/plat/repo' }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function reset() {
  titledFrom = [];
  appCreates = [];
  ghCreates = [];
}

async function post(server, url, body) {
  const port = server.address().port;
  return realFetch(`http://127.0.0.1:${port}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── The numbers, once ────────────────────────────────────────────────

test('one limit: GitHub\'s, shared by every server surface', () => {
  assert.equal(bodyLimit.GITHUB_ISSUE_BODY_MAX, 65536);
  assert.equal(MAX_GITHUB_ISSUE_BODY_CHARS, 65536);
  assert.equal(MAX_REQUEST_BODY_CHARS, 65536);
  assert.equal(FEEDBACK_DESCRIPTION_MAX, 65536 - bodyLimit.FEEDBACK_BODY_RESERVE);
  assert.equal(FEEDBACK_DESCRIPTION_MAX, 64000);
  // The request asked for at least four times the old 2,000.
  assert.ok(FEEDBACK_DESCRIPTION_MAX >= 4 * 2000);
});

test('the client\'s numbers equal the server\'s, and the fields read them', () => {
  const lib = read('frontend/src/lib/issue-body-limit.ts');
  const num = (name) => Number(lib.match(new RegExp(`export const ${name} = (\\d+);`))[1]);
  assert.equal(num('ISSUE_BODY_MAX'), bodyLimit.GITHUB_ISSUE_BODY_MAX);
  assert.equal(num('FEEDBACK_DESCRIPTION_MAX'), FEEDBACK_DESCRIPTION_MAX);
  assert.equal(num('TITLE_SOURCE_MAX'), TITLE_SOURCE_MAX);

  const dialog = read('frontend/src/features/dialogs/feedback.tsx');
  assert.match(dialog, /id="feedback-text"\s+rows=\{4\}\s+maxLength=\{FEEDBACK_DESCRIPTION_MAX\}/);
  assert.doesNotMatch(dialog, /maxLength=\{2000\}/);

  const editor = read('frontend/src/features/dev-board/topic/topic-head.tsx');
  assert.match(editor, /id="dev-issue-body-input"[\s\S]{0,200}maxLength=\{ISSUE_BODY_MAX\}/);

  const controller = read('frontend/src/features/dialogs/feedback-controller.js');
  assert.equal(Number(controller.match(/const TITLE_GEN_SOURCE_MAX = (\d+);/)[1]), TITLE_SOURCE_MAX);
  assert.match(controller, /JSON\.stringify\(\{ description: desc\.slice\(0, TITLE_GEN_SOURCE_MAX\) \}\)/);
});

test('server.js gives the feedback submit and the body edit a parser that fits them', () => {
  const server = read('server.js');
  assert.match(server, /req\.method === 'POST' && req\.path === '\/api\/feedback'\)/);
  assert.match(server, /github-issues\\\/\[\^\/\]\+\\\/body\$/);
});

// ── POST /api/feedback ───────────────────────────────────────────────

test('platform feedback at the description limit files whole; the title is named from its start', async () => {
  reset();
  const server = await startServer();
  try {
    const description = 'z'.repeat(FEEDBACK_DESCRIPTION_MAX);
    const res = await post(server, '/api/feedback', { description });
    assert.equal(res.status, 200);
    assert.equal(ghCreates.length, 1);
    assert.ok(ghCreates[0].body.includes(description), 'the whole description reaches GitHub');
    assert.ok(ghCreates[0].body.length <= 65536);
    assert.deepEqual(titledFrom.map((d) => d.length), [TITLE_SOURCE_MAX]);
  } finally {
    server.close();
  }
});

test('a description over the limit is refused with the limit, and nothing is filed', async () => {
  reset();
  const server = await startServer();
  try {
    const res = await post(server, '/api/feedback', { description: 'z'.repeat(FEEDBACK_DESCRIPTION_MAX + 1) });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /max 64000 chars/);
    assert.equal(ghCreates.length, 0);
    assert.equal(titledFrom.length, 0);
  } finally {
    server.close();
  }
});

test('an app\'s state snapshot is cut to the room a long report leaves, and says so', async () => {
  reset();
  const server = await startServer();
  try {
    const description = 'z'.repeat(FEEDBACK_DESCRIPTION_MAX - 20000);
    const res = await post(server, '/api/feedback', {
      description, target: 'app', appSlug: 'demo-app', pageState: 's'.repeat(40000),
    });
    assert.equal(res.status, 200);
    const { body } = appCreates[0];
    assert.ok(body.includes(description));
    assert.equal(body.length, 65536, 'the snapshot fills exactly what is left');
    assert.match(body, /App state snapshot \(provided by the app, truncated\)/);
  } finally {
    server.close();
  }
});

test('the title preview still takes at most its own 2,000 characters', async () => {
  reset();
  const server = await startServer();
  try {
    let res = await post(server, '/api/feedback/title', { description: 'z'.repeat(TITLE_SOURCE_MAX) });
    assert.equal(res.status, 200);
    res = await post(server, '/api/feedback/title', { description: 'z'.repeat(TITLE_SOURCE_MAX + 1) });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

// ── fitPageState ─────────────────────────────────────────────────────

test('fitPageState: whole when it fits, cut when it does not, left out when no room', () => {
  assert.equal(fitPageState('short', '', false), '');
  assert.equal(fitPageState('short', '{"a":1}', false), buildPageStateEmbed('{"a":1}', false));
  const fixed = 'x'.repeat(1000);
  const cut = fitPageState(fixed, 'y'.repeat(5000), false, 3000);
  assert.equal(fixed.length + cut.length, 3000);
  assert.match(cut, /truncated/);
  assert.equal(fitPageState('x'.repeat(2950), 'y'.repeat(5000), false, 3000), '');
});
