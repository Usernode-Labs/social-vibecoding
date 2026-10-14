// #5028: a file-storage rejection reaches the app with the platform's
// structured code, not only its message. The server answers
// `{ code, error }` (src/routes/app-files.js); the shell's relay used to
// forward `error` alone and the bridge rejected with `new Error(error)`, so
// an app could not tell a full quota from an outage.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the shell relays the server\'s code with its message', () => {
  const view = read('public/js/app-view.js');
  const start = view.indexOf('async handleStorageBridgeMessage(e)');
  assert.ok(start > 0);
  const body = view.slice(start, view.indexOf('\n  },\n', start));
  assert.match(body, /const reply = \(value, error, code\) =>/);
  assert.match(body, /code: typeof code === 'string' && code \? code : null,/);
  for (const key of ['uploadFailed', 'deleteFailed', 'usageFailed']) {
    assert.ok(body.includes(`PlatformI18n.t('changes:bridge.${key}', { status: r.status }), j.code);`),
      `the ${key} failure forwards j.code`);
  }
});

test('the bridge puts it on the rejection as err.code, in both served copies', () => {
  const live = read('public/usernode-bridge.js');
  assert.equal(read('public/usernode-bridge/v1/bridge.js'), live, 'the /v1/ copy is the same file');
  const at = live.indexOf('if (data.__usernode_storage === "response") {');
  const handler = live.slice(at, at + 700);
  assert.match(handler, /var err = new Error\(data\.error\);\s*if \(typeof data\.code === "string" && data\.code\) err\.code = data\.code;\s*entry\.reject\(err\);/);
});
