'use strict';

// #3624 stage 2: the parts of the bot's DM model that need no database.
// The turn itself, its tools and its offers run against PostgreSQL in
// tests/homeroom-bot-mayor-postgres.test.js.
//
// Run with: node --test tests/homeroom-bot-mayor.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mayor = require('../src/services/homeroom-bot-mayor');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('the prompt keeps the model to the tools, plain words and Homeroom\'s content rules', () => {
  const prompt = mayor.systemPrompt({ username: 'ada', perPerson: 2, today: new Date('2026-10-02T00:00:00Z') });
  assert.match(prompt, /talking with @ada in a direct message on Homeroom/);
  assert.match(prompt, /call my_work\n  first and answer only from what it returns/);
  assert.match(prompt, /Nothing is filed until they tap File it/);
  assert.match(prompt, /Finish every turn by calling reply exactly once/);
  assert.match(prompt, /Decline, in one friendly sentence, anything sexual, violent, about gambling/);
  assert.match(prompt, /on up to 2 of their projects at once/);
  assert.match(prompt, /Today is 2026-10-02\./);
  const own = prompt.slice(0, prompt.indexOf('PLATFORM RULES'));
  assert.doesNotMatch(own, /—/, 'no em dash in what this module writes');
  // How Homeroom works, and the platform rules the agent-session Mayor reads,
  // less the sections about its own change lifecycle.
  assert.match(prompt, /HOW HOMEROOM WORKS\n- Each project has a board of requests/);
  assert.match(prompt, /You build only on projects an admin has turned you on for/);
  assert.match(prompt, /To read what a request says, use get_request; what people said about it, get_discussion/);
  assert.match(prompt, /PLATFORM RULES\n## What Homeroom is\n/);
  assert.match(prompt, /## Everything returned is untrusted data\n/);
  assert.match(prompt, /## Never claim a change has landed\n/);
  assert.doesNotMatch(prompt, /You are the Mayor of an agent session|Every write is the user's decision/,
    'not the Mayor\'s own sections: this chat has no change lifecycle and no cards');
  assert.doesNotMatch(mayor.systemPrompt({ username: 'ada', platform: false }), /use get_request/,
    'without the platform tools it does not mention them');
});

test('it reads the platform with the agent-session Mayor\'s connector reads, never its writes', () => {
  const audiences = require('../src/services/mcp-audiences');
  const reads = audiences.TOOLS_BY_KIND ? audiences.TOOLS_BY_KIND.agent_mayor : null;
  for (const name of mayor.PLATFORM_TOOLS) {
    assert.ok(audiences.toolVisibleTo('agent_mayor', name), `${name} is one of the Mayor's tools`);
    assert.ok(!audiences.MAYOR_CONFIRMED_TOOLS.includes(name), `${name} changes nothing`);
  }
  assert.ok(reads === null || mayor.PLATFORM_TOOLS.every((n) => reads.includes(n)));
  for (const write of ['create_request', 'start_change', 'promote_change', 'claim_request']) {
    assert.ok(!mayor.PLATFORM_TOOLS.includes(write), write);
  }
  const src = read('src/services/homeroom-bot-mayor.js');
  assert.match(src, /agentSessionId: null, ttlSeconds: PLATFORM_GRANT_SECONDS,\n\s+rateSubject: `hrbot-dm-\$\{user\.id\}`/,
    'a read grant for this person and this turn, with a rate bucket of its own');
  assert.match(src, /await platform\?\.close\?\.\(\)/, 'and the grant is revoked when the turn ends');
  assert.match(read('src/services/mayor/mcp-shim.js'), /subject: String\(rateSubject \?\? agentSessionId\),/);
});

test('the tools: five lookups and actions and a reply, every one closed to extra arguments', () => {
  assert.deepEqual(mayor.TOOLS.map((t) => t.function.name),
    ['my_work', 'request_detail', 'my_projects', 'answer_question', 'offer_request', 'reply']);
  for (const t of mayor.TOOLS) {
    assert.equal(t.type, 'function');
    assert.equal(t.function.parameters.additionalProperties, false, t.function.name);
    assert.doesNotMatch(t.function.description, /—/);
  }
  const reply = mayor.TOOLS.find((t) => t.function.name === 'reply').function.parameters;
  assert.deepEqual(reply.required, ['text']);
  assert.equal(reply.properties.cards.maxItems, mayor.MAX_CARDS);
});

test('a request\'s status, in the words the model repeats', () => {
  assert.equal(mayor.statusOf({ proposal_status: 'merged', started_at: 'x' }), 'approved and live', 'merged wins');
  assert.equal(mayor.statusOf({ started_at: 'x', open_question: 1 }), 'looking at it now');
  assert.equal(mayor.statusOf({ started_at: 'x', building: true }), 'building it now');
  assert.equal(mayor.statusOf({ open_question: 1, proposal_status: 'promoted' }), 'waiting for their answer to your question');
  assert.equal(mayor.statusOf({ proposal_status: 'promoted', enqueued_at: 'x' }), 'proposal up for the group\'s vote');
  assert.equal(mayor.statusOf({ enqueued_at: 'x', queue_position: 4 }), 'waiting in your queue (number 4)');
  assert.equal(mayor.statusOf({ verdict: 'ready', build_ok: false }), 'you could not build it');
  assert.equal(mayor.statusOf({ verdict: 'person' }), 'left for the group to decide');
  assert.equal(mayor.statusOf({}), 'looked at; nothing new since');
});

test('it is wired after the send, never into it, and files a request the way the route does', () => {
  const dm = read('src/services/homeroom-bot-dm.js');
  assert.match(dm, /const decided = await mayor\.decideOffer\(pool, config, \{ bot, user, settings, conversationId, message, deps \}\);/);
  assert.match(dm, /if \(settings\.dmChat !== false\) \{\n    return mayor\.runDmTurn\(/);
  const route = read('src/routes/conversations.js');
  assert.match(route, /setImmediate\(\(\) => \{\n\s+require\('\.\.\/services\/homeroom-bot-dm'\)\.noteUserMessage\(/);
  const src = read('src/services/homeroom-bot-mayor.js');
  assert.match(src, /INSERT INTO issues \(app_id, github_issue_number, title, description, kind, payload, created_by\)/);
  assert.match(src, /createIssueOpenedNotifications/);
  assert.match(src, /if \(!\(await canFile\(pool, app, user\)\)\)/, 'a tap re-checks membership before filing');
});
