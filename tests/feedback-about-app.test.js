// #7215: a report sent to Homeroom's own board from a project's page records
// which project it was about. The platform's board is public and the project
// may be private, so the request carries the project's app id only: never its
// name or slug. A project the reporter cannot see records nothing, and the
// platform's own repository is never "about" a project.
//
// Run with: node --test tests/feedback-about-app.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const PRIVATE_APP = {
  id: 412, slug: 'secret-project', name: 'Secret Project',
  repo_url: 'https://github.com/acme/secret-project',
  created_by: 1, self_hosted: false, view_visibility: 'private', collab_visibility: 'private',
};
const PUBLIC_APP = {
  ...PRIVATE_APP, id: 413, slug: 'open-project', name: 'Open Project',
  repo_url: 'https://github.com/acme/open-project',
  view_visibility: 'public', collab_visibility: 'public',
};
const PLATFORM_APP = {
  ...PRIVATE_APP, id: 1, slug: 'usernode-2d5619', name: 'Homeroom',
  repo_url: 'https://github.com/Usernode-Labs/social-vibecoding', self_hosted: true,
};

let user;
let queries;
let receipts;
let issueBodies;
let aboutRow;
let viewerCanSee;
let nextIssue;

require('../src/db/pool').getPool = () => ({
  async query(sql, params = []) {
    const s = String(sql);
    queries.push({ sql: s, params });
    if (/INSERT INTO feedback_reports/.test(s)) {
      const id = receipts.length + 1;
      receipts.push({ id, params });
      return { rows: [{ id }] };
    }
    if (/FROM feedback_reports fr/.test(s)) return { rows: receipts.filter((r) => r.id === params[0]) };
    if (/FROM apps WHERE slug = \$1/.test(s)) return { rows: aboutRow && aboutRow.slug === params[0] ? [aboutRow] : [] };
    // checkAppAccess's private-project collaborator check.
    if (/FROM app_collaborators/.test(s)) return { rows: viewerCanSee ? [{ '?column?': 1 }] : [] };
    if (/FROM user_app_blocks/.test(s)) return { rows: [] };
    // findAppByRepo's unqualified read: no app here has the platform repo.
    if (/FROM apps/.test(s)) return { rows: [] };
    return { rows: [] };
  },
});

const github = require('../src/services/github');
github.createIssue = async (_owner, _repo, { body } = {}) => {
  issueBodies.push(body);
  const number = nextIssue++;
  return { number, html_url: `https://app.example.test/#app/x/dev/issues/${number}` };
};

const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = { id: wsId, filename: wsId, loaded: true, exports: { pushIssueUpdate() {} } };

const { feedbackRoutes } = require('../src/routes/feedback');
const { feedbackSubmitLimiter } = require('../src/middleware/rate-limits');

let server;
test.before(async () => {
  const serverApp = express();
  serverApp.use(express.json());
  serverApp.use((req, _res, next) => { req.user = user; next(); });
  serverApp.use(feedbackRoutes({ platformRepoUrl: 'https://github.com/Usernode-Labs/social-vibecoding' }));
  server = await new Promise((resolve) => {
    const listener = serverApp.listen(0, () => resolve(listener));
  });
});

test.after(() => server.close());

test.beforeEach(() => {
  feedbackSubmitLimiter.resetKey('user:7');
  user = { id: 7, username: 'reporter' };
  queries = [];
  receipts = [];
  issueBodies = [];
  aboutRow = null;
  viewerCanSee = true;
  nextIssue = 41;
});

async function submit(overrides = {}) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description: 'A request still shows after its change is done.', title: 'Still shows', ...overrides }),
  });
  return { status: response.status, data: await response.json() };
}

const receipt = () => receipts[0];
const aboutParam = () => receipt()?.params[13];
const lastBody = () => issueBodies[issueBodies.length - 1] || '';

test('platform feedback from a private project\'s page records its id, never its name', async () => {
  aboutRow = PRIVATE_APP;
  const { status } = await submit({ target: 'platform', aboutAppSlug: 'secret-project' });
  assert.equal(status, 200);

  assert.equal(aboutParam(), 412, 'the receipt records the project by app id');
  assert.match(lastBody(), /^\*\*Source:\*\* .*\n\*\*About:\*\* a private project \(app id 412\)\n/);
  assert.doesNotMatch(lastBody(), /Secret Project/);
  assert.doesNotMatch(lastBody(), /secret-project/);
});

test('a public project is recorded too, still by id only', async () => {
  aboutRow = PUBLIC_APP;
  await submit({ target: 'platform', aboutAppSlug: 'open-project' });
  assert.equal(aboutParam(), 413);
  assert.match(lastBody(), /\*\*About:\*\* a project \(app id 413\)/);
  assert.doesNotMatch(lastBody(), /Open Project/);
  assert.doesNotMatch(lastBody(), /open-project/);
});

test('a project the reporter cannot see records nothing and adds no line', async () => {
  aboutRow = PRIVATE_APP;
  viewerCanSee = false;
  const { status } = await submit({ target: 'platform', aboutAppSlug: 'secret-project' });
  assert.equal(status, 200);
  assert.equal(aboutParam(), null);
  assert.doesNotMatch(lastBody(), /\*\*About:\*\*/);
});

test('the platform\'s own repository is never recorded as the project it is about', async () => {
  aboutRow = PLATFORM_APP;
  await submit({ target: 'platform', aboutAppSlug: 'usernode-2d5619' });
  assert.equal(aboutParam(), null);
  assert.doesNotMatch(lastBody(), /\*\*About:\*\*/);
});

test('an unknown or malformed slug is ignored, and the report files as before', async () => {
  aboutRow = null;
  await submit({ target: 'platform', aboutAppSlug: 'not-a-real-project' });
  assert.equal(aboutParam(), null);
  assert.doesNotMatch(lastBody(), /\*\*About:\*\*/);

  await submit({ target: 'platform', aboutAppSlug: 'Not A Slug' });
  assert.equal(aboutParam(), null);
});

test('a report sent to a project\'s own board is unchanged', async () => {
  aboutRow = PUBLIC_APP;
  await submit({ target: 'app', appSlug: 'open-project', aboutAppSlug: 'secret-project' });
  const appReceipt = receipts[0];
  assert.equal(appReceipt.params[1], 'app');
  assert.equal(Number(appReceipt.params[2]), 413, 'the app it files on');
  assert.equal(aboutParam(), null, 'app feedback has no about project');
  assert.doesNotMatch(lastBody(), /\*\*About:\*\*/);
});
