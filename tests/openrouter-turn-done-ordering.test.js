// #2599: the direct OpenRouter turn in POST /api/sessions/:id/chat
// (src/services/mayor/turn.js since #2779) must stop reporting the session as busy BEFORE it
// tells clients the turn is over.
//
// The Claude path ends with its `finally` — which releases the session
// operation taken by beginSessionOperation and drops the turn's stop handle
// — and only THEN emits send('done'). The OpenRouter branch returns from
// inside the `try`, so its send('done') used to run first, and a GET /status
// (the client's reload path) or the coalesced session_state broadcast that
// raced the event still answered "running, stoppable" for a turn the client
// had just been told was finished — one half of the report's "it stops with
// a check, but a refresh says it is running again".
//
// Source guard over the branch: every terminal emit in it is preceded, in
// its own exit block, by the release and the handle drop, in that order.
// The reference — the Claude path's `finally` ahead of its send('done') — is
// pinned too, so the two exits cannot drift apart again unnoticed.
//
// Run with: node --test tests/openrouter-turn-done-ordering.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// #2779: the dev-chat turn moved from routes/sessions.js into
// services/mayor/turn.js, two indentation levels shallower.
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'mayor', 'turn.js'), 'utf8');

function sliceBetween(start, end, what) {
  const a = SRC.indexOf(start);
  assert.ok(a > 0, `could not locate ${what} (start marker moved)`);
  const b = SRC.indexOf(end, a);
  assert.ok(b > a, `could not locate the end of ${what}`);
  return SRC.slice(a, b);
}

// The direct OpenRouter turn of the chat route. Since #2809 it is a closure
// the route runs when an OpenRouter session has no usable Mayor (and when
// that Mayor's first call fails), so it spans from its definition to the
// Mayor setup that follows it. Its last exit is the closure's end rather
// than a `return;`, and the split below still yields it as its own exit.
const BRANCH = sliceBetween(
  '    const runOpenRouterDirectTurn = async () => {\n      // #1949',
  "    // The Mayor's model, key and payer for this turn.",
  'the direct OpenRouter branch',
);

// Each `return;` closes one exit of the branch. Split on them so an exit is
// judged by what IT does, not by what an earlier exit did.
const EXITS = BRANCH.split(/\n\s*return;\n/).filter((s) => /send\('done', \{\}\)/.test(s));

test('the branch has the two terminal exits this pins (stopped, finished) plus the busy refusal', () => {
  assert.equal(EXITS.length, 3, `expected 3 exits emitting done, found ${EXITS.length}`);
});

test('every OpenRouter exit that dispatched a turn releases the busy hold and stop handle before done', () => {
  let checked = 0;
  for (const exit of EXITS) {
    // The busy refusal never took the session operation (it returns before
    // beginSessionOperation), so it has nothing to release.
    if (/is already running for this session/.test(exit)) continue;
    checked += 1;
    const release = exit.indexOf('releaseDispatchOperation();');
    const drop = exit.indexOf('stopRegistry.deleteIf(session.id, stopHandle);');
    const done = exit.indexOf("send('done', {});");
    assert.ok(release > -1, 'the exit releases the dispatch operation itself');
    assert.ok(drop > -1, 'the exit drops the stop handle itself');
    assert.ok(release < drop && drop < done,
      'release → drop handle → done, so /status can never answer busy for a finished turn');
    const stopped = exit.indexOf("send('stopped'");
    if (stopped > -1) {
      assert.ok(release < stopped, "the stop exit releases before 'stopped' too");
    }
  }
  assert.equal(checked, 2, 'the stopped exit and the finished exit were both checked');
});

test('the reference: the Claude path releases in its finally ahead of its own send(\'done\')', () => {
  const tail = sliceBetween(
    '  } finally {\n    if (releaseDispatchOperation) releaseDispatchOperation();',
    '  setTimeout(() => sessionBus.clearSession(session.id), 30000);\n}',
    "the chat route's finally + done tail",
  );
  const release = tail.indexOf('releaseDispatchOperation();');
  const drop = tail.indexOf('stopRegistry.deleteIf(session.id, stopHandle);');
  const done = tail.indexOf("send('done', {});");
  assert.ok(release > -1 && drop > -1 && done > -1);
  assert.ok(release < drop && drop < done);
});

test('beginSessionOperation\'s release is idempotent, so the finally re-running it is safe', () => {
  const svc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'active-workers.js'), 'utf8');
  assert.match(svc, /let released = false;\s*\n\s*return \(\) => \{\s*\n\s*if \(released\) return;/,
    'the release closure guards against a second call');
});
