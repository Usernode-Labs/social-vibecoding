// Tests for src/services/anthropic-stream.js — the shared Anthropic
// stream-forwarding mechanics extracted from routes/anthropic-proxy.js
// (issue #34) and now consumed by both the worker proxy and the
// app-LLM proxy. Covers the SSE tee parser (fragmented chunks, CRLF,
// multi-line data, comments) and the forward-header builder
// (hop-by-hop + credential stripping, key injection).
//
// Run with: node --test tests/anthropic-stream.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { makeSseTee, buildForwardHeaders, HOP_BY_HOP } = require('../src/services/anthropic-stream');

test('SSE tee parses a complete event', () => {
  const events = [];
  const feed = makeSseTee((e) => events.push(e));
  feed('event: message_start\ndata: {"a":1}\n\n');
  assert.deepEqual(events, [{ event: 'message_start', data: '{"a":1}' }]);
});

test('SSE tee handles events fragmented across chunks', () => {
  const events = [];
  const feed = makeSseTee((e) => events.push(e));
  feed('event: messa');
  feed('ge_delta\nda');
  feed('ta: {"usage":{"output_tokens"');
  feed(':42}}\n');
  assert.equal(events.length, 0, 'no event until the blank-line terminator');
  feed('\n');
  assert.deepEqual(events, [{ event: 'message_delta', data: '{"usage":{"output_tokens":42}}' }]);
});

test('SSE tee joins multiple data lines with newlines', () => {
  const events = [];
  const feed = makeSseTee((e) => events.push(e));
  feed('data: line1\ndata: line2\n\n');
  assert.deepEqual(events, [{ event: 'message', data: 'line1\nline2' }]);
});

test('SSE tee strips CR and ignores comments', () => {
  const events = [];
  const feed = makeSseTee((e) => events.push(e));
  feed(': heartbeat\r\nevent: ping\r\ndata: {}\r\n\r\n');
  assert.deepEqual(events, [{ event: 'ping', data: '{}' }]);
});

test('SSE tee survives a throwing handler', () => {
  let calls = 0;
  const feed = makeSseTee(() => { calls++; throw new Error('boom'); });
  feed('data: one\n\ndata: two\n\n');
  assert.equal(calls, 2, 'second event still delivered after the first handler threw');
});

test('buildForwardHeaders drops hop-by-hop, strips credentials, injects the key', () => {
  const fwd = buildForwardHeaders({
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
    connection: 'keep-alive',
    host: 'usernode:3000',
    'content-length': '123',
    'x-api-key': 'caller-jwt-or-token',
    'x-usernode-app-token': 'a'.repeat(64),
    'x-usernode-user-token': 'user.jwt.here',
    cookie: 'session=secret',
  }, 'sk-ant-real', {
    strip: ['x-usernode-app-token', 'x-usernode-user-token', 'cookie'],
  });

  assert.equal(fwd['x-api-key'], 'sk-ant-real');
  assert.equal(fwd['anthropic-version'], '2023-06-01');
  assert.equal(fwd['content-type'], 'application/json');
  for (const gone of ['connection', 'host', 'content-length',
    'x-usernode-app-token', 'x-usernode-user-token', 'cookie']) {
    assert.equal(fwd[gone], undefined, `${gone} must not be forwarded`);
  }
});

test('buildForwardHeaders joins array header values', () => {
  const fwd = buildForwardHeaders({ 'anthropic-beta': ['a', 'b'] }, 'k');
  assert.equal(fwd['anthropic-beta'], 'a, b');
});

test('HOP_BY_HOP covers the RFC 7230 set', () => {
  for (const h of ['connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade']) {
    assert.ok(HOP_BY_HOP.has(h), h);
  }
});
