// Tests for the server-wide MAX_APPS cap config (src/config.js). Locks in
// the built-in default of 30, env-override parsing, and the "<= 0 disables
// the cap" contract that src/routes/apps.js relies on
// (`config.maxApps > 0`).
//
// Run with: node --test tests/max-apps-cap.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');

// load() exits the process when a required env var is missing, so give it
// dummy values for all five before every load. Returns the loaded config.
function loadWith(maxAppsEnv) {
  const prevMaxApps = process.env.MAX_APPS;
  process.env.DATABASE_URL = 'postgres://localhost/test';
  process.env.SESSION_SECRET = 'test-session-secret';
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'admin-pass';
  process.env.JWT_SECRET = 'test-jwt-secret';
  if (maxAppsEnv === undefined) {
    delete process.env.MAX_APPS;
  } else {
    process.env.MAX_APPS = maxAppsEnv;
  }

  // load() is chatty (a block of console.log lines); silence it so the
  // test output stays readable, then restore.
  const realLog = console.log;
  console.log = () => {};
  try {
    return config.load();
  } finally {
    console.log = realLog;
    if (prevMaxApps === undefined) delete process.env.MAX_APPS;
    else process.env.MAX_APPS = prevMaxApps;
  }
}

test('MAX_APPS defaults to 30 when unset', () => {
  assert.equal(loadWith(undefined).maxApps, 30);
});

test('MAX_APPS is overridable via env', () => {
  assert.equal(loadWith('5').maxApps, 5);
});

test('MAX_APPS=0 disables the cap (config.maxApps > 0 is false)', () => {
  const cfg = loadWith('0');
  assert.equal(cfg.maxApps, 0);
  assert.equal(cfg.maxApps > 0, false);
});
