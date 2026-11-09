'use strict';

// 5 Nov 2026 (docs/plans/bot-one-model.md, step 4, decisions 6 and 8): Main
// Chat holds only the conversation, so a message reporting how a request is
// going is not sent there (homeroom-bot-dm.js sendDm). Which messages those
// are is a named list of kinds (conversations.js REQUEST_NEWS_KINDS), never
// inferred from an issue number: the bot's reply to a tap that opened a
// close vote names its request and is still a reply.
//
// Run with: node --test tests/request-news-kinds.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { isRequestNewsMeta, REQUEST_NEWS_KINDS } = require('../src/services/conversations');

test('a request\'s news is named by its kind', () => {
  for (const kind of ['activity', 'step', 'question', 'proposal', 'build_failed', 'live', 'merged', 'needs_look', 'request_closed']) {
    assert.equal(isRequestNewsMeta({ kind, issueNumber: 12 }), true, kind);
  }
  assert.equal(isRequestNewsMeta({ kind: 'activity' }), true, 'with or without its number');
});

test('a reply about a request is the conversation', () => {
  for (const kind of ['closing', 'ack', 'reply', 'confirm', 'close_request', 'filed', 'move_request', 'design_filed', 'allowance', 'paused']) {
    assert.equal(isRequestNewsMeta({ kind, issueNumber: 6 }), false, kind);
  }
  assert.equal(isRequestNewsMeta({ kind: 'proposal', issueNumber: 6, moment: 'reply' }), false, 'said as a reply');
  assert.equal(isRequestNewsMeta(null), false);
  assert.equal(isRequestNewsMeta({ issueNumber: 6 }), false, 'no kind: not news');
});

test('a first version\'s news is still told: it has no request page yet', () => {
  assert.equal(isRequestNewsMeta({ kind: 'step', issueNumber: 1, firstVersion: true }), false);
  assert.equal(isRequestNewsMeta({ kind: 'live', issueNumber: 1, firstVersion: true }), false);
});

test('every kind on the list is one a sender stamps', () => {
  const src = ['src/services/homeroom-bot-dm.js', 'src/services/homeroom-bot-live.js', 'src/services/homeroom-bot.js',
    'src/services/homeroom-bot-closed-requests.js', 'src/services/homeroom-bot-holds.js', 'src/services/homeroom-bot-flaky-checks.js']
    .map((p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')).join('\n');
  for (const kind of REQUEST_NEWS_KINDS) {
    assert.ok(src.includes(`'${kind}'`), `${kind} is stamped somewhere`);
  }
});
