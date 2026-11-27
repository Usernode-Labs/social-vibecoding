// QA 2026-09-24 Q11: POST /api/auth/register applies the account rules the
// rest of the platform already enforces.
//
// Registration took any non-empty string for both fields, so a one-character
// password (`x`) and the handle `qa flow-3!` went straight through, while
// Change password asks for eight characters and a rename refuses anything but
// letters, numbers and underscores (services/usernames.js validateUsername,
// services/password-policy.js validatePassword). The route now answers such a
// form with a 400 naming the FIELD to fix, before it spends a query on the
// activation code or a cost-12 bcrypt on the password, and the register form
// states both rules under their fields and shows the refusal there.
//
// Run with: node --test tests/register-account-rules.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');

const poolMod = require('../src/db/pool');
let queries = [];
poolMod.getPool = () => ({
  query: async (sql, params) => {
    queries.push({ sql, params });
    return { rows: [] };
  },
});

const logger = require('../src/services/logger');
for (const level of ['info', 'warn', 'error', 'debug']) logger[level] = () => {};

const { authRoutes } = require('../src/routes/auth');
const express = require('express');
const cookieParser = require('cookie-parser');

function startApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authRoutes({ nodeRpcUrl: 'http://unused' }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function register(server, body) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const registerQueries = () => queries.filter((q) => /activation_codes|INSERT INTO users/.test(q.sql));

test('the QA shapes are refused, each on its own field, before any code lookup', async () => {
  const server = await startApp();
  try {
    queries = [];
    let r = await register(server, { code: 'ANY', username: 'qa flow-3!', password: 'long enough pw' });
    assert.equal(r.status, 400);
    assert.equal(r.body.field, 'username');
    assert.match(r.body.error, /letters, numbers and underscores/i);

    r = await register(server, { code: 'ANY', username: 'qa_flow_3', password: 'x' });
    assert.equal(r.status, 400);
    assert.equal(r.body.field, 'password');
    assert.match(r.body.error, /at least 8 characters/i);

    r = await register(server, { code: 'ANY', username: 'ab', password: 'long enough pw' });
    assert.equal(r.body.field, 'username', 'too short');
    r = await register(server, { code: 'ANY', username: 'usernode_helper', password: 'long enough pw' });
    assert.equal(r.body.field, 'username', 'the reserved platform namespace');
    assert.match(r.body.error, /reserved/);

    assert.deepEqual(registerQueries(), [], 'nothing touched the codes or the users table');
  } finally { server.close(); }
});

test('a valid form still reaches the activation-code preflight', async () => {
  const server = await startApp();
  try {
    queries = [];
    const r = await register(server, { code: 'NOPE', username: 'Good_Name1', password: 'long enough pw' });
    // The stubbed table has no such code: the old answer, reached as before.
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'Invalid or already used activation code');
    assert.equal(r.body.field, undefined);
    assert.ok(queries.some((q) => /FROM activation_codes WHERE code = \$1 AND used_by IS NULL/.test(q.sql)));
  } finally { server.close(); }
});

test('the activation-code step states both rules and shows a field refusal under its field', () => {
  // The sign-in sheet's register step (#register[/<code>]), the one sign-in
  // since the full-page register screen went.
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend/src/features/auth/sign-in-sheet.tsx'), 'utf8');
  const routes = fs.readFileSync(path.join(__dirname, '..', 'frontend/src/features/auth/sign-in-routes.ts'), 'utf8');
  const shared = fs.readFileSync(path.join(__dirname, '..', 'frontend/src/features/auth/shared.ts'), 'utf8');
  // The rules' words are catalog entries, one for each place they are said.
  assert.equal(message('auth:signInSheet.register.usernameRule'), 'Letters, numbers and underscores, 3 to 32 characters.');
  assert.equal(message('auth:signInSheet.register.passwordRule'), 'At least 8 characters.');
  assert.match(src, /id="sign-in-sheet-reg-username-hint"[\s\S]{0,200}?regFieldError\.message : t\('auth:signInSheet\.register\.usernameRule'\)/);
  // #3575: and, directly under the field, ahead of the rule, who will see it.
  assert.match(src, /<p id="sign-in-sheet-reg-username-public" className=\{FIELD_HINT\}>\{t\('auth:signInSheet\.register\.usernamePublic'\)\}<\/p>\s*<p id="sign-in-sheet-reg-username-hint"/);
  assert.equal(message('auth:signInSheet.register.usernamePublic'), 'Your username will be public to other users on Homeroom.');
  assert.match(src, /aria-describedby="sign-in-sheet-reg-username-public sign-in-sheet-reg-username-hint"/);
  assert.match(src, /id="sign-in-sheet-reg-password-hint"[\s\S]{0,200}?regFieldError\.message : t\('auth:signInSheet\.register\.passwordRule'\)/);
  assert.match(routes, /data\.field === 'username' \|\| data\.field === 'password'/);
  assert.match(routes, /fetchSessionMint\('\/api\/auth\/register',/);
  // And the handle fields do not let a phone capitalise or correct them.
  assert.match(shared, /HANDLE_FIELD = \{ autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false \}/);
  assert.match(src, /id="sign-in-sheet-reg-username"[\s\S]{0,700}?\{\.\.\.HANDLE_FIELD\}/);
  assert.match(src, /id="sign-in-sheet-identifier"[^\n]*\{\.\.\.HANDLE_FIELD\}/);
});
