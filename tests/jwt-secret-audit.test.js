// Detection tests for scripts/audit-jwt-secret-readers.js.
//
// The audit is what gates deleting the `JWT_SECRET` line from
// services/app-identity-env.js (see the removal criterion there). A false
// NEGATIVE is the dangerous direction: it would report an app as clean, the
// alias would be deleted, and every user of that app would be silently logged
// out. So the patterns are pinned against the shapes real app source actually
// uses, plus the near-misses that must NOT count.
//
// The script is require()d as a module — its main() is guarded on
// require.main — so nothing connects to a database or to GitHub here.
//
// Run with: node --test tests/jwt-secret-audit.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const audit = require('../scripts/audit-jwt-secret-readers.js');

test('detects the pre-cutover scaffold shape verbatim', () => {
  // The exact two lines tests/scaffold-token-compat.test.js freezes.
  const src = [
    "const jwt = require('jsonwebtoken');",
    'const JWT_SECRET = process.env.JWT_SECRET;',
    'app.use((req, res, next) => {',
    '  const token = req.query.token;',
    '  try { req.user = jwt.verify(token, JWT_SECRET); } catch {}',
    '  next();',
    '});',
  ].join('\n');
  const hit = audit.findReader(src);
  assert.ok(hit, 'the canonical legacy shape must be found');
  assert.equal(hit.line, 2, 'and reported at the line an author can go fix');
  assert.match(hit.text, /process\.env\.JWT_SECRET/);
});

test('detects bracket access and destructuring', () => {
  assert.ok(audit.findReader("const k = process.env['JWT_SECRET'];"));
  assert.ok(audit.findReader('const k = process.env["JWT_SECRET"];'));
  assert.ok(audit.findReader('const k = process.env[`JWT_SECRET`];'));
  assert.ok(audit.findReader('const { JWT_SECRET } = process.env;'));
  assert.ok(audit.findReader('const { PORT, JWT_SECRET, DATABASE_URL } = process.env;'));
});

// The fallback shape the scaffold used to ship. An app generated during the
// cutover window has BOTH names, and it still depends on the alias whenever
// the platform stops setting the new one — so it counts as a reader.
test('detects the two-name fallback the old scaffold shipped', () => {
  const hit = audit.findReader(
    "const K = (process.env.USERNODE_JWT_PUBLIC_KEY || process.env.JWT_SECRET || '');"
  );
  assert.ok(hit, 'a fallback reader is still a reader');
});

test('does NOT flag an app that reads only the new name', () => {
  const src = [
    "const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')",
    "  .replace(/\\\\n/g, '\\n');",
    "const APP_AUDIENCE = 'usernode:app:' + process.env.USERNODE_APP_ID;",
  ].join('\n');
  assert.equal(audit.findReader(src), null);
});

// Near-misses. These must not count, or the audit never reaches zero and the
// alias can never be removed.
test('does NOT flag the sibling platform key names', () => {
  assert.equal(audit.findReader('const a = process.env.WORKER_JWT_SECRET;'), null);
  assert.equal(audit.findReader('const b = process.env.EDGE_JWT_SECRET;'), null);
  assert.equal(audit.findReader('const c = process.env.USERNODE_JWT_SECRET;'), null);
  assert.equal(audit.findReader('const d = process.env.JWT_SECRET_OLD;'), null,
    'a longer name is a different variable — \\b must hold the right edge');
});

test('does NOT flag a bare mention with no process.env read', () => {
  assert.equal(audit.findReader('// JWT_SECRET was removed in the RSA cutover'), null);
  assert.equal(audit.findReader('const label = "JWT_SECRET";'), null);
});

test('handles empty and non-string input without throwing', () => {
  assert.equal(audit.findReader(''), null);
  assert.equal(audit.findReader(null), null);
  assert.equal(audit.findReader(undefined), null);
});

// ── repo_url parsing ────────────────────────────────────────────────────

test('parses the repo_url shapes apps.repo_url actually holds', () => {
  assert.deepEqual(
    audit.parseRepoUrl('https://github.com/usernode-bot/whiteboard-0d337f'),
    { owner: 'usernode-bot', repo: 'whiteboard-0d337f' }
  );
  assert.deepEqual(
    audit.parseRepoUrl('https://github.com/usernode-bot/whiteboard-0d337f.git'),
    { owner: 'usernode-bot', repo: 'whiteboard-0d337f' }
  );
  assert.deepEqual(
    audit.parseRepoUrl('http://github.com/Usernode-Labs/social-vibecoding'),
    { owner: 'Usernode-Labs', repo: 'social-vibecoding' }
  );
});

test('an unparseable repo_url is null, never a wrong guess', () => {
  assert.equal(audit.parseRepoUrl(''), null);
  assert.equal(audit.parseRepoUrl(null), null);
  assert.equal(audit.parseRepoUrl('https://gitlab.com/someone/thing'), null);
});

// The entrypoint list is the audit's coverage. If an app keeps its auth
// middleware somewhere unlisted, the app reports as unreadable rather than
// clean — which is why `unreadable` counts AGAINST safeToRemoveAlias.
test('the candidate entrypoint list covers the scaffold and the vendored server', () => {
  assert.ok(audit.CANDIDATE_FILES.includes('server.js'),
    'every scaffold generation puts auth in server.js');
  assert.ok(audit.CANDIDATE_FILES.includes('lib/dapp-server.js'),
    'the vendored shared server is where several fleet apps keep it');
  assert.equal(audit.CANDIDATE_FILES[0], 'server.js', 'cheapest, likeliest first');
});
