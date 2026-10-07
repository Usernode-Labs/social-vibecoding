// Tests for the raised request-description limit (#4194): a report typed in
// the "Suggest an improvement" dialog is filed whole instead of being cut
// off at 2,000 characters, and the author-body edit on a request topic takes
// GitHub's own 65,536-character limit instead of 10,000.
//
//  - a 2,001-character description is accepted and reaches GitHub whole;
//  - 64,000 is accepted, 64,001 is refused;
//  - the title preview accepts a 2,001-character description too;
//  - an app submission whose page-state snapshot pushes the body past
//    GitHub's limit is filed without the snapshot, never refused;
//  - static reads pin the textarea caps and the scoped JSON parser.
//
// Run with: node --test tests/feedback-description-limit.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const app = {
  id: 3, slug: 'demo-app', name: 'Demo', repo_url: 'https://github.com/owner/demo',
  created_by: 1, self_hosted: false, view_visibility: 'public', collab_visibility: 'public',
};
let user;
let queries;
let seen;
let createCalls;
let githubFails;

require('../src/db/pool').getPool = () => ({
  async query(sql, params = []) {
    queries.push({ sql, params });
    if (/UPDATE users SET first_feedback_at/.test(sql)) {
      assert.match(sql, /WHERE id = \$1 AND first_feedback_at IS NULL\s+RETURNING id/);
      if (seen.has(params[0])) return { rows: [] };
      seen.add(params[0]);
      return { rows: [{ id: params[0] }] };
    }
    if (/FROM apps WHERE slug = \$1/.test(sql)) return { rows: [app] };
    if (/FROM apps/.test(sql)) return { rows: [app] };
    return { rows: [] };
  },
});
const github = require('../src/services/github');
github.isEnabled = () => true;
github.noteIssueCreated = () => {};
github.createIssue = async (owner, repo, { title, body }) => {
  createCalls.push({ title, body });
  if (githubFails) throw new Error('GitHub unavailable');
  return { number: 41, html_url: `https://github.com/owner/demo/issues/41` };
};
const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = { id: wsId, filename: wsId, loaded: true, exports: { pushIssueUpdate() {} } };

const llm = require('../src/services/llm');
llm.isEnabled = () => true;
llm.generateIssueTitle = async () => ({ title: 'Generated title', usage: { input_tokens: 30, output_tokens: 12 }, model: 'claude-haiku-4-5' });
llm.estimateCostCents = () => 0.05;
const limits = require('../src/services/limits');
limits.resolveBillingPath = async () => ({ apiKey: null, byok: false });
limits.recordSpend = async () => {};

const oldToken = process.env.GITHUB_BOT_TOKEN;
process.env.GITHUB_BOT_TOKEN = 'test-token';
const { feedbackRoutes, MAX_FEEDBACK_DESCRIPTION_CHARS } = require('../src/routes/feedback');
const { feedbackSubmitLimiter, feedbackTitleLimiter } = require('../src/middleware/rate-limits');
let server;
test.before(async () => {
  const serverApp = express();
  // The same scoped parser server.js gives POST /api/feedback: a 64,000-
  // character description plus a 40,000-character pageState exceeds the
  // 100kb default once JSON-escaped. The static read below pins the
  // middleware itself.
  serverApp.use(express.json({ limit: '512kb' }));
  serverApp.use((req, _res, next) => { req.user = user; next(); });
  serverApp.use(feedbackRoutes({ platformRepoUrl: 'https://github.com/platform/repo' }));
  server = await new Promise(resolve => {
    const listener = serverApp.listen(0, () => resolve(listener));
  });
});
test.after(() => {
  server.close();
  if (oldToken === undefined) delete process.env.GITHUB_BOT_TOKEN;
  else process.env.GITHUB_BOT_TOKEN = oldToken;
});
test.beforeEach(() => {
  // POST /api/feedback is limited to 10 submissions per hour and the title
  // preview to 20 per minute; this suite files several, so every test
  // starts from fresh buckets.
  feedbackSubmitLimiter.resetKey('user:7');
  feedbackTitleLimiter.resetKey('user:7');
  user = { id: 7, username: 'reporter' };
  seen = new Set(); queries = []; createCalls = [];
  githubFails = false;
});
async function post(url, body) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}
function submit(overrides = {}) {
  return post('/api/feedback', {
    description: 'The board jumps when scrolling.', title: 'Board jumps',
    target: 'app', appSlug: app.slug, ...overrides,
  });
}

test('a 2,001-character description is filed whole', async () => {
  const description = 'a'.repeat(2001);
  const { status, data } = await submit({ description });
  assert.equal(status, 200);
  assert.ok(data.url);
  assert.equal(createCalls.length, 1);
  assert.ok(createCalls[0].body.includes(description), 'the whole description reaches GitHub');
});

test(`the description cap is ${MAX_FEEDBACK_DESCRIPTION_CHARS}: 64,000 is accepted, 64,001 is refused`, async () => {
  assert.equal(MAX_FEEDBACK_DESCRIPTION_CHARS, 64000);
  const { status } = await submit({ description: 'd'.repeat(64000) });
  assert.equal(status, 200);
  assert.ok(createCalls[0].body.includes('d'.repeat(64000)));

  createCalls = [];
  const refused = await submit({ description: 'd'.repeat(64001) });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /max 64000 chars/);
  assert.equal(createCalls.length, 0);
});

test('the title preview accepts a description past the old 2,000 cap', async () => {
  const { status, data } = await post('/api/feedback/title', {
    description: 't'.repeat(2001),
  });
  assert.equal(status, 200);
  assert.equal(data.title, 'Generated title');
});

test('an app submission with a huge page-state snapshot drops the snapshot, not the request', async () => {
  // 64,000 + 40,000 cannot both fit under GitHub's 65,536-char issue
  // limit: the snapshot is left out and the person's words are filed
  // whole, rather than the submission being refused.
  const description = 'd'.repeat(64000);
  const { status, data } = await submit({
    description,
    pageState: 'p'.repeat(40000),
    pageStateTruncated: true,
  });
  assert.equal(status, 200, `filed anyway: ${JSON.stringify(data)}`);
  assert.equal(createCalls.length, 1);
  const { body } = createCalls[0];
  assert.ok(!body.includes('<details>'), 'the snapshot embed is dropped');
  assert.ok(!body.includes('pppp'), 'the snapshot content is dropped');
  assert.ok(body.length <= 65536, `body fits GitHub's limit (${body.length})`);
  assert.ok(body.includes(description), 'the description is filed whole');
});

test('a small page-state snapshot still embeds when the body fits', async () => {
  const { status } = await submit({
    description: 'Short report.',
    pageState: '{"tab":"leaderboard"}',
  });
  assert.equal(status, 200);
  assert.ok(createCalls[0].body.includes('<details>'), 'the snapshot is kept when it fits');
});

// Static reads: the form and the editor must stop limiting typing at the
// old numbers, and the scoped parser must cover /api/feedback.
test('the feedback textarea takes 64,000 characters', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../frontend/src/features/dialogs/feedback.tsx'), 'utf8'
  );
  const textarea = source.slice(source.indexOf('id="feedback-text"'), source.indexOf('id="feedback-text-error"'));
  assert.match(textarea, /maxLength=\{64000\}/);
  assert.doesNotMatch(textarea, /maxLength=\{2000\}/);
});

test('the request-body editor takes GitHub’s 65,536 characters', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../frontend/src/features/dev-board/topic/topic-head.tsx'), 'utf8'
  );
  const editor = source.slice(source.indexOf('id="dev-issue-body-input"'));
  assert.match(editor, /maxLength=\{65536\}/);
  assert.doesNotMatch(editor, /maxLength=\{10000\}/);
});

test('server.js gives POST /api/feedback a 512kb parser', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const at = source.indexOf("'/api/feedback'");
  assert.ok(at > -1, 'the middleware names /api/feedback');
  assert.ok(source.slice(at - 400, at + 400).includes("512kb"), 'the scoped parser is 512kb');
});
