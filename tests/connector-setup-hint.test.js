// The in-band connector setup hint.
//
// The problem: a user who never opens Settings → Connectors has no way to
// learn that the per-call permission prompts are fixable at all. The only
// channel this server has to a human is a tool result routed through the
// model — no MCP surface renders to a person directly — so the hint has to be
// phrased as an explicit instruction to relay, and the model has to have been
// told at initialize that such a block exists and is not app data.
//
// Everything below is about the ways that goes wrong quietly:
//
//   1. Attached to the wrong tool. On a write it arrives as a change reaches
//      a group vote; on prepare_work it sits beside a work order the model
//      was told to reproduce character for character. Eligibility is derived
//      from the read-only naming contract so it cannot drift onto one.
//   2. Attached the wrong way. Eight read tools declare eight outputSchemas
//      and the SDK validates structuredContent against them, so the hint
//      rides as a second content block — which only works if the SDK accepts
//      an extra block, verified here against a real round trip rather than
//      assumed.
//   3. Shown too often. /mcp is stateless, so "once per session" cannot be
//      expressed; the throttle is per-request, per-token and per-grant, and
//      an off-by-one there is a connector that nags every single call.
//
// Run with: node --test tests/connector-setup-hint.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tools = require('../src/services/mcp-tools');
const throttle = require('../src/services/mcp-hint-throttle');
const constants = require('../src/services/mcp-connect-constants');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const TOOLS_SRC = read('src/services/mcp-tools.js');
const REMOTE_SRC = read('src/routes/mcp-remote.js');
const SCHEMA_SQL = read('src/db/schema.sql');

const ORIGIN = 'https://usernode.example';

// ── 1. The model is told the block exists ──────────────────────────────

test('the initialize instructions set up the relay', () => {
  // Without this the hint is an unexplained block in a tool result, which a
  // model can reasonably read as noise and drop — and then nobody is reached
  // at all, which is the failure the whole feature exists to avoid.
  const instructions = tools.SERVER_INSTRUCTIONS;
  assert.match(instructions, /Usernode setup tip/);
  assert.match(instructions, /relay it once/i);
  assert.match(instructions, /not data about their apps/);
  // It says the block is NOT untrusted content, because every other line of
  // these instructions says the opposite about everything else returned.
  assert.match(instructions, /never in <untrusted-content> tags/);
});

test('the marker in the instructions is the marker the hint actually uses', () => {
  // Two literals, in two files, that only work if identical.
  assert.ok(tools.buildSetupHint(ORIGIN).startsWith('Usernode setup tip'));
  assert.match(tools.SERVER_INSTRUCTIONS, /"Usernode setup tip"/);
});

// ── 2. What the hint says ──────────────────────────────────────────────

test('the hint carries the shipped rules, from the shipped constant', () => {
  const hint = tools.buildSetupHint(ORIGIN);
  for (const rule of constants.READ_ONLY_ALLOW_RULES) {
    assert.ok(hint.includes(`"${rule}"`), `${rule} is named in the hint`);
  }
  assert.match(hint, /permissions\.allow|"permissions\.allow"/);
  assert.match(hint, /~\/\.claude\/settings\.json/);
  assert.match(hint, /in every repo at once/);
});

test('the hint tells the model to correct the server segment itself', () => {
  // #1218's real failure was an account registered as `Uesrnode`, so every
  // rule Usernode ships missed it silently. The server cannot see the name
  // the client built its tool names from; the model can. So the correction is
  // delegated to the only party in the exchange that knows.
  const hint = tools.buildSetupHint(ORIGIN);
  assert.match(hint, /substitute the server\s+segment you can actually see/);
  assert.match(hint, /names the server literally/);
  assert.match(hint, /matches nothing, with no error/);
});

test('the hint does not oversell what it turns off', () => {
  const hint = tools.buildSetupHint(ORIGIN);
  assert.match(hint, /still ask every time, by design/);
  assert.ok(hint.includes(`${ORIGIN}/#settings/connectors`),
    'it deep-links the page that has the copy button');
});

test('the hint is not wrapped as untrusted content', () => {
  // It is platform-authored and meant to be acted on — the same reasoning as
  // get_platform_conventions' preamble. Wrapping it would tell the model to
  // treat an instruction to relay as data not to follow.
  assert.doesNotMatch(tools.buildSetupHint(ORIGIN), /<untrusted-content>/);
});

// ── 3. Which tools carry it ────────────────────────────────────────────

test('eligibility is DERIVED from the read-only naming contract', () => {
  // Not a hand-kept list: a new get_*/list_* tool carries the hint with no
  // extra edit, and a tool renamed to something that acts stops carrying it
  // in the same edit that renames it.
  for (const name of ['get_app', 'get_proposal', 'list_apps', 'list_requests',
                      'get_platform_build', 'get_platform_conventions',
                      'list_my_proposals', 'whoami']) {
    assert.equal(tools.isHintEligibleTool(name), true, `${name} is a read`);
  }
  for (const name of tools.ACTING_TOOLS) {
    assert.equal(tools.isHintEligibleTool(name), false, `${name} acts`);
  }
  // answer_questions is a write that is deliberately NOT in ACTING_TOOLS, so
  // assert it separately or it slips through both lists.
  assert.equal(tools.isHintEligibleTool('answer_questions'), false);
  assert.equal(tools.isHintEligibleTool(''), false);
  assert.equal(tools.isHintEligibleTool(undefined), false);
});

test('the eight read tools return through readResult and no others do', () => {
  // The wiring itself, since eligibility is only consulted on the path that
  // asks for it. Everything that acts must still return plain toolResult().
  const hinted = [...TOOLS_SRC.matchAll(/return readResult\('([a-z_]+)'/g)]
    .map((m) => m[1]);
  assert.deepEqual([...new Set(hinted)].sort(), [
    'get_app', 'get_platform_build', 'get_platform_conventions', 'get_proposal',
    'list_apps', 'list_my_proposals', 'list_requests', 'whoami',
  ]);
  for (const name of hinted) {
    assert.equal(tools.isHintEligibleTool(name), true);
  }

  // And the acting tools' handlers still return plain results.
  for (const name of [...tools.ACTING_TOOLS, 'answer_questions']) {
    const idx = TOOLS_SRC.indexOf(`server.registerTool('${name}'`);
    assert.ok(idx > 0, `${name} is registered`);
    const next = TOOLS_SRC.indexOf('server.registerTool(', idx + 10);
    const body = TOOLS_SRC.slice(idx, next > 0 ? next : undefined);
    assert.doesNotMatch(body, /readResult\(/,
      `${name} acts — it must not carry a setup tip`);
  }
});

test('prepare_work in particular never carries it', () => {
  // Its workOrder is reproduced character for character by the model. A
  // second block of platform prose next to it competes with that instruction
  // at the one moment precision matters most.
  const idx = TOOLS_SRC.indexOf("server.registerTool('prepare_work'");
  const next = TOOLS_SRC.indexOf('server.registerTool(', idx + 10);
  assert.doesNotMatch(TOOLS_SRC.slice(idx, next), /readResult|buildSetupHint/);
});

test('an error result never carries a hint', () => {
  // A failing call is not a teaching moment, and toolError is the shape every
  // failure goes through.
  const err = tools.toolError('no_access', 'nope');
  assert.equal(err.content.length, 1);
  assert.equal(err.isError, true);
  const src = TOOLS_SRC.slice(TOOLS_SRC.indexOf('function toolError('));
  assert.doesNotMatch(src.slice(0, src.indexOf('\n}')), /hint/);
});

// ── 4. The shape on the wire ───────────────────────────────────────────

test('the hint is a second content block, leaving structuredContent alone', () => {
  const structured = { a: 1, b: 'two' };
  const plain = tools.toolResult(structured);
  assert.equal(plain.content.length, 1);
  assert.deepEqual(plain.structuredContent, structured);

  const hinted = tools.toolResult(structured, 'Usernode setup tip — hello');
  assert.equal(hinted.content.length, 2);
  assert.equal(hinted.content[1].type, 'text');
  assert.equal(hinted.content[1].text, 'Usernode setup tip — hello');

  // The JSON block and the structured object are byte-identical either way:
  // a caller parsing content[0], and a caller reading structuredContent, both
  // see exactly what they saw before the hint existed.
  assert.equal(hinted.content[0].text, plain.content[0].text);
  assert.deepEqual(hinted.structuredContent, plain.structuredContent);
  assert.equal(JSON.stringify(hinted.structuredContent),
               JSON.stringify(plain.structuredContent));

  // A falsy hint adds nothing, so a refused throttle claim leaves the result
  // exactly as it was.
  for (const empty of [null, undefined, '']) {
    assert.equal(tools.toolResult(structured, empty).content.length, 1);
  }
});

test('the SDK accepts the extra block against a declared outputSchema', async () => {
  // The assumption the whole approach rests on, checked rather than assumed:
  // @modelcontextprotocol/sdk validates structuredContent against each tool's
  // outputSchema on both sides. If an extra content block tripped that
  // validation, the hint would have to move inside the first block instead.
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { z } = require('zod');

  const server = new McpServer({ name: 'usernode', version: '1.0.0' });
  const structured = { username: 'ada', scopes: ['usernode:apps:read'] };
  server.registerTool('get_thing', {
    title: 'thing', description: 'thing',
    inputSchema: {},
    outputSchema: { username: z.string(), scopes: z.array(z.string()) },
  }, async () => tools.toolResult(structured, tools.buildSetupHint(ORIGIN)));

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const res = await client.callTool({ name: 'get_thing', arguments: {} });
  assert.ok(!res.isError, 'the extra block does not fail output validation');
  assert.equal(res.content.length, 2);
  assert.deepEqual(res.structuredContent, structured);
  assert.deepEqual(JSON.parse(res.content[0].text), structured);
  assert.ok(res.content[1].text.startsWith('Usernode setup tip'));

  await client.close();
  await server.close();
});

// ── 5. The throttle ────────────────────────────────────────────────────

test('the client suppression covers the surfaces with no prompts to stop', () => {
  for (const name of ['ChatGPT', 'chatgpt.com', 'OpenAI', 'Codex CLI', 'openai codex']) {
    assert.equal(tools.hintSuppressedForClient(name), true, `${name} is suppressed`);
  }
  for (const name of ['Claude', 'claude.ai', 'Claude Code', 'Unknown client', '', null]) {
    assert.equal(tools.hintSuppressedForClient(name), false, `${name} is not suppressed`);
  }
});

// A pool that records what it was asked and answers with whatever the test
// queued. The claim is one atomic statement by design, so "did it return a
// row" is the entire contract.
function fakePool(responses) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return { rows: next || [] };
    },
  };
}

test('the claim is a single atomic statement against one table', () => {
  // Two reads racing on the same grant must not both win the slot, which
  // rules out read-then-write. And this module owns exactly one table.
  const src = read('src/services/mcp-hint-throttle.js');
  assert.equal((src.match(/pool\.query\(/g) || []).length, 1);
  assert.match(src, /ON CONFLICT \(grant_id\) DO UPDATE/);
  assert.match(src, /RETURNING shown_count/);
  const tables = [...src.matchAll(/(?:INSERT INTO|UPDATE|FROM)\s+([a-z_]+)/g)]
    .map((m) => m[1]);
  assert.deepEqual([...new Set(tables)], ['mcp_connector_hints']);
});

test('a returned row is a granted claim, no row is a refusal', async () => {
  const pool = fakePool([[{ shown_count: 1 }], []]);
  assert.equal(await throttle.claimHintShow(pool, {
    grantId: 'g1', userId: 7, tokenId: 100,
  }), true);
  assert.equal(await throttle.claimHintShow(pool, {
    grantId: 'g1', userId: 7, tokenId: 100,
  }), false, 'the same token does not get a second showing');

  // The guards that produce that refusal are in the statement, not in JS.
  const { text, params } = pool.calls[0];
  assert.match(text, /last_token_id IS DISTINCT FROM EXCLUDED\.last_token_id/);
  assert.match(text, /shown_count < \$4/);
  assert.deepEqual(params, ['g1', 7, 100, throttle.MAX_SHOWS_PER_GRANT]);
  assert.equal(throttle.MAX_SHOWS_PER_GRANT, 3);
});

test('a missing grant, user or pool refuses without touching the database', async () => {
  const pool = fakePool([[{ shown_count: 1 }]]);
  assert.equal(await throttle.claimHintShow(pool, { grantId: null, userId: 7 }), false);
  assert.equal(await throttle.claimHintShow(pool, { grantId: 'g', userId: null }), false);
  assert.equal(await throttle.claimHintShow(null, { grantId: 'g', userId: 7 }), false);
  assert.equal(pool.calls.length, 0);
});

test('a failed claim costs a tip, never the result', async () => {
  // The table is advisory. A read that worked must not become an error
  // because a hint could not be booked — the same posture as the
  // fire-and-forget last_used_at update at the /mcp edge.
  const pool = fakePool([new Error('relation "mcp_connector_hints" does not exist')]);
  assert.equal(await throttle.claimHintShow(pool, {
    grantId: 'g1', userId: 7, tokenId: 1,
  }), false);
});

test('the per-request memo means one claim however many reads run', () => {
  // registerTools runs once per HTTP request (the transport is stateless), so
  // memoising the promise on that closure is what bounds it. It also keeps
  // initialize and tools/list from burning the slot: nothing is claimed until
  // a read handler actually returns.
  const start = TOOLS_SRC.indexOf('const claimSetupHint = () => {');
  assert.ok(start > 0);
  const body = TOOLS_SRC.slice(start, TOOLS_SRC.indexOf('\n  };', start));
  assert.match(body, /if \(hintClaim\) return hintClaim;/);
  assert.match(body, /hintClaim = \(async \(\) => \{/);
  assert.match(body, /hintSuppressedForClient\(clientName\)/);
});

test('the throttle keys are threaded in from the authenticated token', () => {
  // There is no MCP session id to key on — sessionIdGenerator is undefined —
  // so the token and the grant are the two durable stand-ins, and they have
  // to reach registerTools for any of this to work.
  assert.match(REMOTE_SRC, /sessionIdGenerator: undefined/);
  const start = REMOTE_SRC.indexOf('mcpTools.registerTools(server, {');
  const ctx = REMOTE_SRC.slice(start, REMOTE_SRC.indexOf('});', start));
  assert.match(ctx, /tokenId: auth\.tokenId/);
  assert.match(ctx, /grantId: auth\.grantId/);
});

// ── 6. End to end through registerTools ────────────────────────────────

// A pool that answers both queries a whoami round trip makes: the github-link
// lookup, and the hint claim. Routed by statement text so the order of the two
// does not matter.
function wiringPool({ claimGranted }) {
  const claims = [];
  return {
    claims,
    async query(text, params) {
      if (/mcp_connector_hints/.test(text)) {
        claims.push(params);
        return { rows: claimGranted() ? [{ shown_count: claims.length }] : [] };
      }
      return { rows: [{ github_login: null, github_linked_at: null }] };
    },
  };
}

// registerTools takes an McpServer; all this needs is the handlers it hands
// over, so a recorder standing in for one keeps the loopback stack out of it.
function collectTools(ctx) {
  const handlers = new Map();
  const server = {
    registerTool(name, _spec, handler) { handlers.set(name, handler); },
  };
  tools.registerTools(server, {
    accessToken: 'svmcp_test', scopes: [constants.READ_SCOPE],
    user: { id: 7, username: 'ada' },
    clientName: 'Claude', clientId: 'c1',
    origin: ORIGIN, baseUrl: 'http://platform.internal',
    pool: ctx.pool, config: {}, tokenId: ctx.tokenId, grantId: ctx.grantId,
  });
  return handlers;
}

test('a read tool really does emit the hint, once per request', async () => {
  const pool = wiringPool({ claimGranted: () => true });
  const handlers = collectTools({ pool, tokenId: 100, grantId: 'g1' });

  const first = await handlers.get('whoami')({});
  assert.equal(first.content.length, 2, 'the hint rides along on the read');
  assert.ok(first.content[1].text.startsWith('Usernode setup tip'));
  assert.equal(first.structuredContent.username, 'ada');

  // Same request (same registerTools closure): the memo spends one slot even
  // if the model calls two reads before the response is written.
  const second = await handlers.get('whoami')({});
  assert.equal(second.content.length, 2, 'the memoised hint is the same one');
  assert.equal(pool.claims.length, 1, 'exactly one claim per HTTP request');
});

test('a refused claim leaves the read exactly as it was', async () => {
  const pool = wiringPool({ claimGranted: () => false });
  const handlers = collectTools({ pool, tokenId: 100, grantId: 'g1' });
  const res = await handlers.get('whoami')({});
  assert.equal(res.content.length, 1);
  assert.equal(res.structuredContent.username, 'ada');
});

test('a suppressed client never even asks for a slot', async () => {
  const pool = wiringPool({ claimGranted: () => true });
  const handlers = collectTools({ pool, tokenId: 100, grantId: 'g1' });
  // Re-register with a ChatGPT client name.
  const chatgpt = new Map();
  tools.registerTools({
    registerTool(name, _spec, handler) { chatgpt.set(name, handler); },
  }, {
    accessToken: 'svmcp_test', scopes: [constants.READ_SCOPE],
    user: { id: 7, username: 'ada' },
    clientName: 'ChatGPT', clientId: 'c1',
    origin: ORIGIN, baseUrl: 'http://platform.internal',
    pool, config: {}, tokenId: 100, grantId: 'g1',
  });
  const res = await chatgpt.get('whoami')({});
  assert.equal(res.content.length, 1);
  assert.equal(pool.claims.length, 0, 'no row is written for a suppressed client');
  assert.ok(handlers.size > 0);
});

// ── 7. The table ───────────────────────────────────────────────────────

test('the throttle table is declared and kept out of staging', () => {
  assert.match(SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS mcp_connector_hints/);
  const start = SCHEMA_SQL.indexOf('CREATE TABLE IF NOT EXISTS mcp_connector_hints');
  const ddl = SCHEMA_SQL.slice(start, SCHEMA_SQL.indexOf(');', start));
  assert.match(ddl, /grant_id\s+TEXT PRIMARY KEY/);
  assert.match(ddl, /user_id\s+INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(ddl, /shown_count\s+INTEGER NOT NULL DEFAULT 0/);
  assert.match(ddl, /last_token_id BIGINT/);
  // Same treatment as every other mcp_* table: connector state does not get
  // copied into a staging container.
  assert.match(SCHEMA_SQL, /COMMENT ON TABLE mcp_connector_hints IS 'staging:private'/);
});
