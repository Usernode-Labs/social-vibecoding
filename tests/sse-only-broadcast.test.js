// #889: a Stop is announced to every tab watching the change at once. POST
// /api/sessions/:id/stop runs in a different request from the turn, so it has
// no access to the turn's own `send` closure; the stop handle carries it,
// which is what lets a click announce `stopping` immediately instead of when
// the turn finally unwinds, and what makes OTHER tabs (and the phone app)
// show the stopping state at all.
//
// requestSessionStop is a closure-heavy route body, so rather than spin up
// the whole route we slice it out of the source and assert the announcement,
// its ordering and the answer the client branches on are still wired the way
// this invariant assumes. /status is held to the same: a reload repaints the
// Stopping button from it.
//
// Run with: node --test tests/sse-only-broadcast.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'sessions.js'), 'utf8');

const stopRoute = () => SRC.slice(
  SRC.indexOf('async function requestSessionStop('),
  SRC.indexOf('async function requestOrdinaryStop(')
);

test('POST /stop emits stopping with the requesting user, before the kill', () => {
  const route = stopRoute();
  const emit = route.search(/handle\.send\?\.\(\s*'stopping'/);
  assert.ok(emit >= 0, 'the stop route emits a stopping event');
  assert.match(route.slice(emit, emit + 200), /by:\s*user\.username/,
    'carries who requested it, so other viewers can name them');

  // Ordering: the announcement is a synchronous broadcast, so it must sit
  // ahead of the worker kill. Being immediate is the entire point; anything
  // in front of it is dead air for the user.
  const kill = route.indexOf('requestOrdinaryStop(sessionId, user,', emit);
  assert.ok(kill > emit, 'stopping is announced before the worker kill is dispatched');
  const abort = route.indexOf('handle.abort.abort()', emit);
  assert.ok(abort > emit, 'stopping is announced before the local stream is cancelled');
});

test('the stop route still answers with a stopped flag the client can branch on', () => {
  const route = stopRoute();
  // The client reads both of these: `stopped` decides whether a `stopped`
  // event is coming at all, and the reason drives the already-ended branch.
  assert.match(route, /stopped:\s*false,\s*reason:\s*'no active turn'/);
  assert.match(route, /body:\s*\{\s*ok:\s*true,\s*stopped:\s*true,\s*phase:\s*handle\.phase\s*\}/);
});

test('/status exposes stopping so a reload repaints the Stopping button', () => {
  // #1378 widened the derivation: an in-process handle still answers first,
  // but a stop clicked just before a restart lives on the turn record, so
  // with no handle /status falls back to the durable stamp. Without that
  // fallback a reload repaints a calm red Stop for a turn already ending.
  assert.match(SRC, /const\s+stopHandleNow\s*=\s*stopRegistry\.get\(sessionId\);/,
    '/status still reads the live stop registry');
  assert.match(SRC, /const\s+stopping\s*=\s*stopHandleNow\s*\?\s*!!stopHandleNow\.stopped\s*:\s*!!durableStop;/,
    '/status derives stopping from the handle, falling back to the durable stop stamp');
  assert.match(SRC, /const\s+durableStop\s*=\s*turnLifecycle\.stopRequestOf\(durableTurn\);/,
    'and the durable half comes from the turn record via stopRequestOf');
  // Window widened from 200 in #907, which added runner/runnerLabel/
  // localAgent as siblings, and again for #3177's optional `delivery`; the
  // assertion below is key presence, not size.
  const payload = SRC.match(/res\.json\(\{\s*\n?\s*busy,[\s\S]{0,600}?\}\);/);
  assert.ok(payload, 'found the /status res.json payload');
  assert.match(payload[0], /\bstopping\b/, 'stopping is included in the /status payload');
});
