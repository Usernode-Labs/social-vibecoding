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
  assert.doesNotMatch(prompt, /—/, 'no em dash in anything a person might be shown');
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
  assert.equal(mayor.statusOf({ started_at: 'x', open_question: 1 }), 'working on it now');
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
