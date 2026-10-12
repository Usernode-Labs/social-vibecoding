// #4817: the PR-import routes must not answer a GitHub failure as a fact
// about the repository. "Nothing to import" and "not found" are GitHub's own
// answers; a rate limit, timeout, bad token or GitHub 5xx is an unreachable
// GitHub, and each route says so instead.
//
// Source pins, sliced per route handler, the same way
// tests/pr-import-capture-routes.test.js pins the import route: the root
// suite runs with no live GitHub client to stub, so the contract lives in
// what the handlers actually answer. The dialog side of the same change is
// pinned in tests/dialog-import-pr.test.js.
//
// Run with: node --test tests/pr-import-github-errors.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const VOTES_SRC = fs.readFileSync(path.join(__dirname, '../src/routes/votes.js'), 'utf8');

/** The body of one pr-import route handler, from its `router.<verb>(` line. */
function routeBody(verb, suffix) {
  const at = VOTES_SRC.indexOf(`router.${verb}('/api/apps/:slug/pr-import${suffix}`);
  assert.ok(at > 0, `found the ${verb} ${suffix || '(import)'} route`);
  // Route handlers in votes.js end with the closing `  });` of the callback
  // at the same indent depth; the next `router.` line is a safe fence.
  let end = VOTES_SRC.indexOf('\n  router.', at);
  if (end === -1) end = VOTES_SRC.length;
  return VOTES_SRC.slice(at, end);
}

const CANDIDATES = routeBody('get', '/candidates');
const PREVIEW = routeBody('get', '/preview');
const IMPORT = routeBody('post', '');

// ── candidates ───────────────────────────────────────────────────────

test('candidates: a not-configured app is a stated answer, not an empty list', () => {
  assert.match(CANDIDATES, /if \(!gh\.isEnabled\(\) \|\| !repo\) return res\.json\(\{ candidates: \[\], configured: false \}\)/,
    'GitHub-off answers configured: false on a 200');
  // The success path carries the flag too, so the client never has to infer
  // "configured" from the absence of it.
  assert.match(CANDIDATES, /res\.json\(\{ candidates, configured: true \}\)/,
    'success answers configured: true');
});

test('candidates: a failed listOpenPulls is a 502, never an empty list', () => {
  const catchBlock = CANDIDATES.slice(
    CANDIDATES.indexOf('catch (err) {\n        log.warn'),
    CANDIDATES.indexOf('const candidates = pulls'),
  );
  assert.ok(catchBlock.length > 0, 'the listOpenPulls catch is present');
  assert.match(catchBlock, /log\.warn\('votes', 'listOpenPulls failed'/, 'still logged');
  assert.match(catchBlock, /res\.status\(502\)\.json\(/, 'answered 502');
  assert.match(catchBlock, /configured: true/, 'with the app still known to be configured');
  assert.doesNotMatch(catchBlock, /return res\.json\(\{ candidates: \[\] \}\)/,
    'no longer answered as an empty list');
});

// ── preview and import: getPR failures ───────────────────────────────

test('preview: getPR fails as 404 only for GitHub’s own 404, else 502', () => {
  const catchBlock = PREVIEW.slice(
    PREVIEW.indexOf('try {\n        pr = await gh.getPR'),
    PREVIEW.indexOf('const headSha = pr.head?.sha'),
  );
  assert.ok(catchBlock.length > 0, 'the getPR catch is present');
  assert.match(catchBlock, /err\.status === 404/, 'GitHub’s own 404 is checked first');
  assert.match(catchBlock, /res\.status\(404\)\.json\(\{ error: `PR #\$\{prNumber\} not found on GitHub` \}\)/,
    'and keeps the not-found answer');
  assert.match(catchBlock, /res\.status\(502\)\.json\(/, 'anything else is a 502');
  assert.match(catchBlock, /Couldn’t reach GitHub to read PR #\$\{prNumber\}/,
    'saying GitHub could not be reached');
});

test('import: getPR fails as 404 only for GitHub’s own 404, else 502', () => {
  const catchBlock = IMPORT.slice(
    IMPORT.indexOf('try {\n        pr = await gh.getPR'),
    IMPORT.indexOf("if (pr.state !== 'open')"),
  );
  assert.ok(catchBlock.length > 0, 'the getPR catch is present');
  assert.match(catchBlock, /err\.status === 404/, 'GitHub’s own 404 is checked first');
  assert.match(catchBlock, /res\.status\(404\)\.json\(\{ error: `PR #\$\{prNumber\} not found on GitHub` \}\)/,
    'and keeps the not-found answer');
  assert.match(catchBlock, /res\.status\(502\)\.json\(/, 'anything else is a 502');
  assert.match(catchBlock, /Couldn’t reach GitHub to read PR #\$\{prNumber\}/,
    'the same sentence the preview gives');
});
