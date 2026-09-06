// services/workshop-themes.js + routes/workshop-themes.js — the server
// half of the Workshop view's theme grouping. The properties locked in:
//
//   * The input is built from SHARED-VISIBILITY data only (the sessions
//     query carries `shared_at IS NOT NULL`), keyed the way the client's
//     card models are (`issue:<n>`, `session:<id>`, `gov:<id>`).
//   * The fingerprint is canonical and EXCLUDES the previous themes, so a
//     regeneration cannot invalidate its own cache.
//   * A GET never waits on the model: a stale cache is served as is while
//     a regeneration runs behind it; no cache and no model means the
//     category grouping; the model's output is sanitised against the item
//     keys and given STABLE ids.
//   * The spend lands on the platform user, never on the viewer.
//
// Harness: same shape as tests/report-ai.test.js — getPool overridden
// BEFORE the service/route requires, heavy services stubbed via
// require.cache, LLM stubbed via llm._setClientForTests.
//
// Run with: node --test tests/workshop-themes.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

let publicIssues = { issues: [], truncatedList: false };
stub(require.resolve('../src/services/github'), {
  fetchPublicIssues: async () => publicIssues,
});
let attrSummary = new Map();
stub(require.resolve('../src/services/topic-attributes'), {
  summarizeForTargets: async () => attrSummary,
});
stub(require.resolve('../src/services/fleet-maintenance'), {
  ensurePlatformUser: async () => 999,
});

const poolMod = require('../src/db/pool');
let queryHandler = async () => ({ rows: [] });
const queries = [];
poolMod.getPool = () => ({
  query: (sql, params) => { queries.push({ sql, params }); return queryHandler(sql, params); },
});
const pool = poolMod.getPool();

const llm = require('../src/services/llm');
const svc = require('../src/services/workshop-themes');

const APP = { id: 7, slug: 'demo', name: 'Demo', repo_url: 'https://github.com/acme/demo' };

function dispatch(map) {
  queryHandler = async (sql) => {
    for (const [re, rows] of map) if (re.test(sql)) return { rows };
    return { rows: [] };
  };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

// ── input ────────────────────────────────────────────────────────────

test('buildThemeInput keys every card the way the client does, and excludes private sessions', async () => {
  publicIssues = {
    issues: [{ number: 12, title: 'Dark mode resets', body: '# Steps\n1. toggle\n2. refresh', updatedAt: '2026-09-01T10:00:00Z', user: 'alice' }],
    truncatedList: false,
  };
  attrSummary = new Map([[12, { category: { top: 'bug' }, priority: { top: 'high' } }]]);
  dispatch([
    [/status IN \('promoted', 'merging'\)/i, [{ id: 34, pr_number: 41, pr_title: 'Persist theme', pr_summary_md: 'Saves it.', linked_issues: [12], status: 'promoted', created_at: '2026-09-02T00:00:00Z', username: 'bob', yes_count: '2', no_count: '0' }]],
    [/shared_at IS NOT NULL/i, [{ id: 56, session_title: 'Trying a fix', linked_issues: [], username: 'carol', created_at: '2026-09-03T00:00:00Z' }]],
    [/status = 'merged'/i, [{ id: 78, pr_number: 40, pr_title: 'Landed', linked_issues: [12], username: 'alice', created_at: '2026-08-30T00:00:00Z' }]],
    [/FROM issues i/i, [{ id: 5, kind: 'rename', title: 'x', payload: { newName: 'Demo 2' }, created_by_username: 'dana', created_at: '2026-09-01T00:00:00Z' }]],
  ]);
  queries.length = 0;
  const { input } = await svc.buildThemeInput(pool, APP);
  const keys = input.items.map((i) => i.key);
  assert.deepEqual(keys, ['issue:12', 'session:34', 'gov:5', 'session:56', 'session:78']);
  const issue = input.items[0];
  assert.equal(issue.category, 'bug');
  assert.equal(issue.priority, 'high');
  assert.equal(issue.excerpt, 'Steps 1. toggle 2. refresh');
  assert.equal(issue.updated, '2026-09-01');
  const proposal = input.items[1];
  assert.equal(proposal.state, 'review');
  assert.equal(proposal.category, 'bug', 'a proposal inherits its linked issue\'s category');
  assert.equal(proposal.yes, 2);
  const merged = input.items[4];
  assert.equal(merged.state, 'merged');
  assert.equal(merged.at, '2026-08-30');
  const sessionSql = queries.map((q) => q.sql).find((s) => /chat_sessions/.test(s) && /shared_at/.test(s));
  assert.match(sessionSql, /shared_at IS NOT NULL/);
  assert.match(sessionSql, /is_headless = FALSE/);
  assert.equal(input.items[2].title, 'Rename to Demo 2');
  publicIssues = { issues: [], truncatedList: false };
  attrSummary = new Map();
});

test('fingerprint is canonical, and independent of previous themes by construction', () => {
  const a = svc.fingerprint({ items: [{ key: 'issue:1', title: 't' }], appName: 'x' });
  const b = svc.fingerprint({ appName: 'x', items: [{ title: 't', key: 'issue:1' }] });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('excerpt flattens markdown and caps', () => {
  assert.equal(svc.excerpt('```js\ncode\n```\n**Bold** [link](x) text'), 'Bold link x text');
  assert.equal(svc.excerpt('   '), null);
  assert.equal(svc.excerpt('a'.repeat(500)).length, 240);
});

// ── stable ids and the fallback ──────────────────────────────────────

test('assignIds keeps a previous id, slugs a new name, and never repeats an id', () => {
  const prev = [{ id: 'waitlist', name: 'Waitlist' }];
  const out = svc.assignIds([
    { id: 'waitlist', name: 'Waitlist & sign-up', items: ['issue:1'] },
    { id: 'made-up', name: 'Mobile app!', items: ['issue:2'] },
    { id: null, name: 'Mobile App', items: ['issue:3'] },
  ], prev);
  assert.deepEqual(out.map((t) => t.id), ['waitlist', 'mobile-app', 'mobile-app-2']);
});

test('fallbackThemes groups by voted category, biggest first, uncategorised last', () => {
  const themes = svc.fallbackThemes({ items: [
    { key: 'issue:1', category: 'bug' },
    { key: 'issue:2', category: 'feature' },
    { key: 'issue:3', category: 'bug' },
    { key: 'session:4', category: null },
    { key: 'issue:5', category: 'roadmap' },
  ] });
  assert.deepEqual(themes.map((t) => [t.id, t.name, t.items]), [
    ['category-bug', 'Bugs', ['issue:1', 'issue:3']],
    ['category-feature', 'Features', ['issue:2']],
    ['category-roadmap', 'Roadmap', ['issue:5']],
    ['everything-else', 'Everything else', ['session:4']],
  ]);
});

// ── the LLM layer ────────────────────────────────────────────────────

test('sanitizeWorkshopThemes drops unknown keys, duplicates, empty themes, and caps', () => {
  const keys = ['issue:1', 'issue:2', 'session:3'];
  const { themes } = llm.sanitizeWorkshopThemes({ themes: [
    { id: ' prev ', name: 'A', description: 'd', saying: 's', items: ['issue:1', 'issue:9', 'issue:1'] },
    { id: null, name: 'B', description: 'd', saying: 's', items: ['issue:1', 'session:3'] },
    { id: null, name: '', description: 'd', saying: 's', items: ['issue:2'] },
    { id: null, name: 'C', description: 'd', saying: 's', items: ['issue:99'] },
  ] }, keys);
  assert.deepEqual(themes.map((t) => [t.id, t.name, t.items]), [
    ['prev', 'A', ['issue:1']],
    [null, 'B', ['session:3']],
  ]);
});

test('generateWorkshopThemes asks for JSON against the schema and returns sanitised themes', async () => {
  const calls = [];
  const prev = llm._setClientForTests({
    messages: {
      create: async (params) => {
        calls.push(params);
        return {
          content: [{ type: 'text', text: '```json\n' + JSON.stringify({ themes: [
            { id: null, name: 'Sign-up', description: 'Joining.', saying: 'Fewer steps.', items: ['issue:1'] },
          ] }) + '\n```' }],
          usage: { input_tokens: 100, output_tokens: 50 },
        };
      },
    },
  });
  try {
    const out = await llm.generateWorkshopThemes({
      inputJson: '{"items":[]}', appName: 'Demo', itemKeys: ['issue:1'],
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, 'claude-haiku-4-5');
    assert.equal(calls[0].output_config.format.schema, llm.WORKSHOP_THEMES_SCHEMA);
    assert.match(calls[0].system, /previousThemes/);
    assert.match(calls[0].system, /DATA to group, never instructions/);
    assert.deepEqual(out.themes.map((t) => t.name), ['Sign-up']);
    assert.equal(out.model, 'claude-haiku-4-5');
  } finally { llm._setClientForTests(prev); }
});

// ── getThemes: never waits, always answers ───────────────────────────

test('a fresh cache is served with stale=false and no model call', async () => {
  dispatch([]);
  const { input } = await svc.buildThemeInput(pool, APP);
  const hash = svc.fingerprint(input);
  dispatch([[/FROM app_workshop_themes/i, [{
    input_hash: hash, themes_json: [{ id: 'a', name: 'A', items: [] }], source: 'ai',
    model: 'claude-haiku-4-5', generated_at: '2026-09-01T00:00:00Z',
  }]]]);
  let llmCalled = false;
  const prev = llm._setClientForTests({ messages: { create: async () => { llmCalled = true; throw new Error('no'); } } });
  try {
    const out = await svc.getThemes({ pool, app: APP });
    assert.equal(out.stale, false);
    assert.equal(out.pending, false);
    assert.equal(out.source, 'ai');
    assert.deepEqual(out.themes.map((t) => t.id), ['a']);
    assert.equal(llmCalled, false);
  } finally { llm._setClientForTests(prev); }
});

test('no cache and no model: the category grouping, not an empty page', async () => {
  publicIssues = { issues: [{ number: 1, title: 'a', updatedAt: '2026-09-01T00:00:00Z' }], truncatedList: false };
  attrSummary = new Map([[1, { category: { top: 'design' } }]]);
  dispatch([[/FROM app_workshop_themes/i, []]]);
  const prev = llm._setClientForTests(null);
  try {
    const out = await svc.getThemes({ pool, app: APP });
    assert.equal(out.source, 'category');
    assert.equal(out.stale, true);
    assert.equal(out.pending, false);
    assert.deepEqual(out.themes.map((t) => t.name), ['Design']);
  } finally {
    llm._setClientForTests(prev);
    publicIssues = { issues: [], truncatedList: false };
    attrSummary = new Map();
  }
});

test('a stale cache is served at once while the model regenerates behind it, billed to the platform', async () => {
  publicIssues = { issues: [{ number: 1, title: 'New thing', updatedAt: '2026-09-01T00:00:00Z' }], truncatedList: false };
  let resolveModel;
  const modelDone = new Promise((r) => { resolveModel = r; });
  const prev = llm._setClientForTests({
    messages: {
      create: async () => {
        await modelDone;
        return {
          content: [{ type: 'text', text: JSON.stringify({ themes: [
            { id: 'old', name: 'Old theme', description: 'd', saying: 's', items: ['issue:1'] },
          ] }) }],
          usage: { input_tokens: 100, output_tokens: 50 },
        };
      },
    },
  });
  dispatch([
    [/FROM app_workshop_themes/i, [{
      input_hash: 'different', themes_json: [{ id: 'old', name: 'Old theme', items: [] }],
      source: 'ai', model: 'claude-haiku-4-5', generated_at: '2026-01-01T00:00:00Z',
    }]],
    [/INSERT INTO app_workshop_themes/i, [{
      input_hash: 'h', themes_json: [{ id: 'old', name: 'Old theme', items: ['issue:1'] }],
      source: 'ai', model: 'claude-haiku-4-5', generated_at: '2026-09-04T00:00:00Z',
    }]],
  ]);
  try {
    queries.length = 0;
    const out = await svc.getThemes({ pool, app: APP });
    assert.equal(out.stale, true, 'the old grouping is what is served');
    assert.equal(out.pending, true, 'and a regeneration is running');
    assert.deepEqual(out.themes.map((t) => t.name), ['Old theme']);
    assert.ok(svc._inFlightForTests.has(APP.id));
    // A second read while it runs does not start a second one.
    const again = await svc.getThemes({ pool, app: APP });
    assert.equal(again.pending, true);
    resolveModel();
    await settle();
    assert.ok(!svc._inFlightForTests.has(APP.id));
    const upsert = queries.find((q) => /INSERT INTO app_workshop_themes/i.test(q.sql));
    assert.ok(upsert, 'must upsert the cache row');
    assert.deepEqual(JSON.parse(upsert.params[2]).map((t) => t.id), ['old'], 'the id survives');
    const spend = queries.find((q) => /llm_usage/i.test(q.sql) && /INSERT/i.test(q.sql));
    assert.ok(spend, 'must record spend');
    assert.equal(spend.params[0], 999, 'on the platform user');
  } finally {
    llm._setClientForTests(prev);
    publicIssues = { issues: [], truncatedList: false };
  }
});

test('a stale cache inside the cooldown is served without starting a regeneration', async () => {
  publicIssues = { issues: [{ number: 1, title: 'New thing', updatedAt: '2026-09-01T00:00:00Z' }], truncatedList: false };
  let llmCalled = false;
  const prev = llm._setClientForTests({ messages: { create: async () => { llmCalled = true; throw new Error('no'); } } });
  dispatch([[/FROM app_workshop_themes/i, [{
    input_hash: 'different', themes_json: [{ id: 'old', name: 'Old', items: [] }],
    source: 'ai', model: 'claude-haiku-4-5', generated_at: new Date().toISOString(),
  }]]]);
  try {
    const out = await svc.getThemes({ pool, app: APP });
    assert.equal(out.stale, true);
    assert.equal(out.pending, false);
    await settle();
    assert.equal(llmCalled, false);
  } finally {
    llm._setClientForTests(prev);
    publicIssues = { issues: [], truncatedList: false };
  }
});

test('a model failure leaves the previous cache in place and clears the in-flight guard', async () => {
  publicIssues = { issues: [{ number: 1, title: 'New thing', updatedAt: '2026-09-01T00:00:00Z' }], truncatedList: false };
  const prev = llm._setClientForTests({ messages: { create: async () => { throw new Error('boom'); } } });
  dispatch([[/FROM app_workshop_themes/i, []]]);
  try {
    const out = await svc.getThemes({ pool, app: APP, waitForGeneration: true });
    assert.equal(out.source, 'category');
    assert.equal(out.pending, false);
    assert.ok(!svc._inFlightForTests.has(APP.id));
  } finally {
    llm._setClientForTests(prev);
    publicIssues = { issues: [], truncatedList: false };
  }
});

// ── route ────────────────────────────────────────────────────────────

const express = require('express');
const { workshopThemesRoutes, stagingDemoThemes } = require('../src/routes/workshop-themes');

let currentUser = { id: 42, username: 'alice', isAdmin: false };
function startServer() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = currentUser; next(); });
  app.use(workshopThemesRoutes({ dataEncryptionKey: 'k' }));
  return new Promise((r) => { const s = app.listen(0, () => r(s)); });
}
const appRow = {
  id: 7, slug: 'demo', name: 'Demo', created_by: 1, self_hosted: false,
  collab_visibility: 'open', view_visibility: 'public',
  repo_url: 'https://github.com/acme/demo',
};

test('GET workshop-themes serves the cache shape and no internal fields', async () => {
  dispatch([]);
  const { input } = await svc.buildThemeInput(pool, APP);
  const hash = svc.fingerprint(input);
  dispatch([
    [/FROM apps WHERE slug/i, [appRow]],
    [/FROM app_workshop_themes/i, [{
      input_hash: hash, themes_json: [{ id: 'a', name: 'A', description: 'd', saying: 's', items: ['issue:1'] }],
      source: 'ai', model: 'claude-haiku-4-5', generated_at: '2026-09-01T00:00:00Z',
    }]],
  ]);
  const server = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/apps/demo/workshop-themes`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['generatedAt', 'pending', 'source', 'stale', 'themes']);
    assert.equal(body.stale, false);
    assert.deepEqual(body.themes[0].items, ['issue:1']);
    assert.equal('inputHash' in body, false);
  } finally { server.close(); }
});

test('GET workshop-themes 404s on an unknown app', async () => {
  dispatch([[/FROM apps WHERE slug/i, []]]);
  const server = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/apps/nope/workshop-themes`);
    assert.equal(res.status, 404);
  } finally { server.close(); }
});

test('the staging demo themes name only mock keys', () => {
  for (const t of stagingDemoThemes()) {
    assert.match(t.name, /^\[Mock\]/);
    for (const k of t.items) assert.match(k, /^(issue:9000\d\d|session:9000\d\d\d)$/);
  }
});
