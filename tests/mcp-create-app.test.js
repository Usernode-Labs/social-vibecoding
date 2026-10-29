'use strict';

// #6026 — create_app: the connector makes a new project for the person who
// connected it, the one the Create screen makes. What the tool sends, what it
// refuses before calling the platform, and how it reports the route's own
// refusals. tests/mcp-connector-policy.test.js holds the route-side half (the
// allowlist entry and the four-field narrowing); tests/create-options.test.js
// holds the rule itself.
//
// Run with: node --test tests/mcp-create-app.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { z } = require('zod');

const tools = require('../src/services/mcp-tools');
const charter = require('../src/services/mcp-charter');
const createOptions = require('../src/services/create-options');
const { READ_SCOPE, WRITE_SCOPE } = require('../src/services/mcp-connect-constants');

const ORIGIN = 'https://social-vibecoding.usernodelabs.org';

// registerTools takes an McpServer; a recorder standing in for one is enough
// to get at the handler. `platform` answers the loopback calls, and an answer
// of `{ __http: { ok, status, body } }` makes that call fail.
function connector(platform, { scopes = [READ_SCOPE, WRITE_SCOPE] } = {}) {
  const handlers = new Map();
  const specs = new Map();
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const method = (init && init.method) || 'GET';
    const pathname = String(url).replace('http://platform.internal', '');
    calls.push({ method, pathname, body: init && init.body ? JSON.parse(init.body) : null });
    const answer = platform(method, pathname);
    const http = answer && answer.__http ? answer.__http : null;
    return {
      ok: http ? !!http.ok : true,
      status: http ? http.status : 201,
      text: async () => JSON.stringify(http ? http.body : answer),
    };
  };
  tools.registerTools({
    registerTool(name, spec, handler) { handlers.set(name, handler); specs.set(name, spec); },
  }, {
    accessToken: 'svmcp_test',
    scopes,
    user: { id: 7, username: 'ada' },
    clientName: 'Claude', clientId: 'c1',
    origin: ORIGIN, baseUrl: 'http://platform.internal',
    pool: null, config: {}, tokenId: null, grantId: null,
  });
  return { handlers, specs, calls, restore: () => { globalThis.fetch = realFetch; } };
}

const made = (over = {}) => ({ app: { id: 91, slug: 'the-best-color-a1b2c3', name: 'The Best Color', status: 'creating', ...over }, invited: 0 });

test('it makes a private community for the caller from the four fields, and says what comes next', async () => {
  const c = connector(() => made());
  try {
    const out = await c.handlers.get('create_app')({ name: '  The Best Color ', description: 'Find your favorite color, then compare.' });
    assert.ok(!out.isError, JSON.stringify(out));
    assert.deepEqual(c.calls, [{
      method: 'POST', pathname: '/api/apps',
      body: { name: 'The Best Color', audience: 'invited', description: 'Find your favorite color, then compare.' },
    }], 'one call, the trimmed name, the Create screen\'s default audience, no brief');
    const s = out.structuredContent;
    assert.equal(s.slug, 'the-best-color-a1b2c3');
    assert.match(s.name, /^<untrusted-content>The Best Color<\/untrusted-content>$/);
    assert.equal(s.status, 'creating');
    assert.equal(s.audience, 'invited');
    assert.equal(s.firstVersion, 'yours');
    assert.equal(s.webPath, `${ORIGIN}/app/the-best-color-a1b2c3`);
    assert.match(s.nextStep, /get_app/);
    assert.match(s.nextStep, /create_request/);
    assert.match(s.nextStep, /prepare_work and submit_work/);
    assert.equal(z.object(c.specs.get('create_app').outputSchema).safeParse(s).success, true, 'the answer fits the tool\'s own schema');
  } finally { c.restore(); }
});

test('with a brief, Homeroom bot builds the first version and the agent is told not to', async () => {
  const c = connector(() => ({ ...made(), homeroomBot: { dm: 12 } }));
  try {
    const brief = 'Tap the color you like more until it knows your favorite.';
    const out = await c.handlers.get('create_app')({ name: 'The Best Color', audience: 'solo', brief });
    assert.deepEqual(c.calls[0].body, { name: 'The Best Color', audience: 'solo', brief });
    assert.equal(out.structuredContent.firstVersion, 'homeroom_bot');
    assert.equal(out.structuredContent.audience, 'solo');
    assert.match(out.structuredContent.nextStep, /do not build a first version of your own/);
  } finally { c.restore(); }
});

test('nothing is made without the write scope, and nothing is sent for a bad call', async () => {
  const readOnly = connector(() => made(), { scopes: [READ_SCOPE] });
  try {
    const out = await readOnly.handlers.get('create_app')({ name: 'The Best Color' });
    assert.equal(out.isError, true);
    assert.equal(out.structuredContent.code, 'insufficient_scope');
    assert.deepEqual(readOnly.calls, []);
  } finally { readOnly.restore(); }

  const c = connector(() => made());
  try {
    const cases = [
      [{ name: '   ' }, 'invalid_request'],
      [{ name: 'x'.repeat(tools.CREATE_APP_NAME_MAX + 1) }, 'name_too_long'],
      [{ name: 'Notes', description: 'y'.repeat(createOptions.DESCRIPTION_MAX + 1) }, 'description_too_long'],
      [{ name: 'Notes', audience: 'public' }, 'invalid_request'],
      [{ name: 'Notes', brief: 'too short' }, 'invalid_request'],
      [{ name: 'Notes', brief: 'b'.repeat(tools.CREATE_APP_BRIEF_MAX + 1) }, 'brief_too_long'],
    ];
    for (const [input, code] of cases) {
      const out = await c.handlers.get('create_app')(input);
      assert.equal(out.isError, true, JSON.stringify(input));
      assert.equal(out.structuredContent.code, code, JSON.stringify(input));
    }
    assert.deepEqual(c.calls, [], 'every refusal came before the platform was asked');
    // A name at the limit is sent whole, never shortened.
    const atLimit = 'n'.repeat(tools.CREATE_APP_NAME_MAX);
    await c.handlers.get('create_app')({ name: atLimit });
    assert.equal(c.calls[0].body.name, atLimit);
  } finally { c.restore(); }
});

test('the route\'s refusals come back as what they are', async () => {
  const answer = (status, body) => () => ({ __http: { ok: false, status, body } });
  const run = async (platform) => {
    const c = connector(platform);
    try { return (await c.handlers.get('create_app')({ name: 'The Best Color' })).structuredContent; } finally { c.restore(); }
  };

  // Out of app slots is the person's allowance, not this connection's
  // permission, so nobody is told to reconnect.
  const slots = await run(answer(403, { code: 'app_allowance_exhausted', error: 'You have used 2 of 2 app slots. Request more slots from the app allowance panel.' }));
  assert.equal(slots.code, 'app_allowance_exhausted');
  assert.match(slots.message, /2 of 2 app slots/);

  const taken = await run(answer(409, { error: 'An app with that name already exists' }));
  assert.equal(taken.code, 'name_taken');
  assert.match(taken.message, /already exists\. Choose another name/);

  const full = await run(answer(429, { error: 'This server is at its app limit (50). Ask an admin to remove an app or raise the limit.' }));
  assert.equal(full.code, 'at_capacity');
  assert.match(full.message, /app limit/);

  const narrowed = await run(answer(400, { error: 'invalid_request', message: 'A connector makes a project from name, audience, description, brief only.' }));
  assert.equal(narrowed.code, 'platform_error');
  assert.equal(narrowed.platformCode, 'invalid_request');
  assert.match(narrowed.message, /A connector makes a project/);

  // Made, but the answer does not say what it is called: never guess, and
  // never invite a second attempt that would make a second project.
  const unnamed = await run(() => ({ app: { status: 'creating' } }));
  assert.equal(unnamed.code, 'platform_error');
  assert.match(unnamed.message, /list_apps/);
});

test('its bounds are the platform\'s, and it is an acting tool on the external connector only', () => {
  const dm = require('../src/services/homeroom-bot-dm');
  assert.equal(tools.CREATE_APP_BRIEF_MIN, dm.MIN_BRIEF_CHARS, 'a brief the bot would drop is refused instead');
  assert.equal(tools.CREATE_APP_BRIEF_MAX, dm.MAX_BRIEF_CHARS, 'and one the bot would cut is refused instead');

  assert.ok(tools.ACTING_TOOLS.includes('create_app'), 'kept out of the read-only allow rules and the setup hint');
  const c = connector(() => made());
  try {
    const spec = c.specs.get('create_app');
    assert.equal(spec.annotations.readOnlyHint, false);
    assert.equal(spec.annotations.destructiveHint, false);
    assert.deepEqual(Object.keys(spec.inputSchema).sort(), [...createOptions.CONNECTOR_CREATE_FIELDS].sort(),
      'the tool takes exactly the fields the route lets a connector send');
  } finally { c.restore(); }

  const section = charter.CHARTER_SECTIONS.find((s) => s.id === 'making-a-project');
  assert.ok(section, 'the charter says when to use it');
  assert.match(section.text, /create_app/);
  assert.ok(!section.brief, 'charter-only: the tool description carries the rest at the point of use');
  assert.ok(!section.audiences, 'external only, like the tool');
});
