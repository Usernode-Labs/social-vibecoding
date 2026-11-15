// #2599: beginSessionOperation's release closure is idempotent.
//
// The direct OpenRouter turn this file was written for released its session
// operation in two places (its own exit, then the chat route's `finally`),
// and the guard below is what made that safe. That turn is gone with the
// session Mayor, but the hand-offs that survive it lean on the same property:
// the promote holds its operation until the response ends and releases it on
// both 'finish' and 'close' (src/routes/proposal-handoff.js), and every owner
// cleans up in a `finally`. A second release must not drop another
// operation's reference or announce the session idle twice.
//
// Run with: node --test tests/openrouter-turn-done-ordering.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('beginSessionOperation\'s release is idempotent, so releasing it twice is safe', () => {
  const svc = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'active-workers.js'), 'utf8');
  assert.match(svc, /let released = false;\s*\n\s*const release = \(\) => \{\s*\n\s*if \(released\) return;/,
    'the release closure guards against a second call');
});
