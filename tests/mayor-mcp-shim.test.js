'use strict';

// The in-process MCP Homeroom bot reaches the platform through
// (services/mayor/mcp-shim.js, #2779): a genuine McpServer and client over
// the SDK's in-memory transport, built for a delegated `agent_mayor` grant
// minted for one turn. Only the database answers are faked, so each test says
// which statements a call makes: the audience's tools and nothing else, a
// `token_used` audit row and a rate bucket per call, no write on a read
// grant, and the grant revoked on close. The pure helpers that flatten a tool
// result for the model, pictures included, are tested directly.
//
// Run with: node --test tests/mayor-mcp-shim.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const audiences = require('../src/services/mcp-audiences');
const { READ_SCOPE } = require('../src/services/mcp-connect-constants');

const DATA_KEY = 'test-only-data-key';
const CONFIG = { dataEncryptionKey: DATA_KEY, port: 3000 };

function recordingPool(handlers = {}) {
  const calls = [];
  const answer = async (sql, params) => {
    calls.push({ sql, params });
    for (const [pattern, fn] of Object.entries(handlers)) {
      if (new RegExp(pattern).test(sql)) return fn(sql, params);
    }
    return { rows: [], rowCount: 0 };
  };
  return { calls, query: answer, async connect() { return { query: answer, release() {} }; } };
}

test('the shim serves the Mayor\'s tools in-process, audits each call and revokes on close', async () => {
  const grant = 'g'.repeat(22);
  const pool = recordingPool({
    'INSERT INTO mcp_delegations': () => ({ rows: [{ expires_at: new Date(Date.now() + 60_000) }] }),
    'INSERT INTO mcp_tokens': () => ({ rows: [{ id: 91 }] }),
    'FROM mcp_tokens t': (_sql, params) => ({
      rows: [{
        id: 91, user_id: 7, client_id: 'homeroom:agent_mayor', grant_id: grant, scopes: [READ_SCOPE],
        expires_at: new Date(Date.now() + 60_000), revoked_at: null, client_name: null,
        d_grant_id: grant, d_kind: 'agent_mayor', d_change_id: null, d_app_id: null,
        d_expires_at: new Date(Date.now() + 60_000), d_revoked_at: null, app_slug: null,
        change_user_id: null, change_status: null, change_app_id: null,
        now: new Date(), _hash: params[0],
      }],
    }),
    'FROM users WHERE id': () => ({ rows: [{ id: 7, username: 'ada', is_admin: false, admin_readonly: false, app_quota: 3, locale: null }] }),
    'UPDATE mcp_delegations SET revoked_at': () => ({ rows: [{ user_id: 7, kind: 'agent_mayor' }] }),
  });
  const cliAuth = require('../src/services/cli-auth');
  const bucket = cliAuth.consumeSharedTokenBucket;
  const buckets = [];
  cliAuth.consumeSharedTokenBucket = async (_pool, options) => { buckets.push(options); return { allowed: true }; };
  const { openMayorMcp } = require('../src/services/mayor/mcp-shim');
  try {
    const shim = await openMayorMcp({ pool, config: CONFIG, userId: 7, rateSubject: 'hrbot-dm-7' });
    assert.deepEqual([...shim.toolNames].sort(), [...audiences.AGENT_MAYOR_TOOLS].sort(),
      'exactly the Mayor\'s audience');
    assert.ok(shim.modelTools.every((t) => t.input_schema && t.input_schema.type === 'object'));
    const conventions = await shim.call('get_platform_conventions', {});
    assert.equal(conventions.isError, false);
    assert.match(conventions.text, /Don't `git push` yourself/, 'the Mayor\'s own preamble');
    assert.deepEqual(buckets.map((b) => [b.namespace, b.subject]), [['agent-mayor-mcp', 'hrbot-dm-7']]);
    const audit = pool.calls.filter((c) => /INSERT INTO mcp_auth_audit_events/.test(c.sql)).map((c) => c.params[0]);
    assert.deepEqual(audit, ['token_issued', 'token_used']);

    const refused = await shim.call('create_request', { slug: 'recipe-box', title: 'x', body: 'y' });
    assert.equal(refused.isError, true, 'a read grant cannot write, whatever the model asks');

    await shim.close();
    assert.ok(pool.calls.some((c) => /UPDATE mcp_delegations SET revoked_at/.test(c.sql)));
    const after = await shim.call('get_app', { slug: 'recipe-box' });
    assert.equal(after.isError, true, 'nothing runs after close');
  } finally {
    cliAuth.consumeSharedTokenBucket = bucket;
  }
});

test('a refused bucket stops the call before it is audited', async () => {
  const { normalizeResult, toModelTools } = require('../src/services/mayor/mcp-shim');
  assert.deepEqual(normalizeResult({ isError: true, content: [{ type: 'text', text: 'x' }] }),
    { isError: true, structured: null, text: 'x', images: [] });
  assert.deepEqual(toModelTools([{ name: 'a', description: 'd' }])[0].input_schema, { type: 'object', properties: {} });
});

// ── A request's screenshots ────────────────────────────────────────────
//
// get_request returns a request's screenshots as MCP image blocks, each after
// a Homeroom line naming it. The bot sees them when its model can.

const PICTURE = { label: '[Homeroom: screenshot 1 of 1 embedded in request #5\'s description.]', mimeType: 'image/png', data: 'iVBORw0KGgo=' };

test('the shim keeps each picture with its line, out of the text', () => {
  const { normalizeResult, toolResultContent, turnImageBudget } = require('../src/services/mayor/mcp-shim');
  const answer = normalizeResult({
    content: [
      { type: 'text', text: '{"number":5}' },
      { type: 'text', text: PICTURE.label },
      { type: 'image', data: PICTURE.data, mimeType: 'image/png' },
      { type: 'text', text: 'a setup tip' },
    ],
  });
  assert.equal(answer.text, '{"number":5}\na setup tip', 'the label travels with its picture, not in the text');
  assert.deepEqual(answer.images, [PICTURE]);

  assert.equal(toolResultContent({ text: 'plain', images: [] }), 'plain', 'no pictures: the text, as before');
  assert.deepEqual(toolResultContent(answer), [
    { type: 'text', text: '{"number":5}\na setup tip' },
    { type: 'text', text: PICTURE.label },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PICTURE.data } },
  ]);

  // One turn's allowance, across calls.
  const take = turnImageBudget(3);
  const first = take({ text: 'a', images: [PICTURE, PICTURE] });
  const second = take({ text: 'b', images: [PICTURE, PICTURE] });
  assert.deepEqual([first.images.length, first.omitted, second.images.length, second.omitted], [2, 0, 1, 1]);
  const content = toolResultContent(second);
  assert.match(content[0].text, /^b\n\[Homeroom: 1 more screenshot left out/);
  assert.equal(content.filter((b) => b.type === 'image').length, 1);
  assert.equal(toolResultContent(take({ text: 'c', images: [PICTURE] })).includes('1 more screenshot'), true,
    'past the allowance: text only, saying what was left out');
});
