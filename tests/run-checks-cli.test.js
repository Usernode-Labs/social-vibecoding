// Unit tests for worker/usernode-run-checks — the in-loop declared-checks
// runner that lets a build turn execute its dapp.json checks BEFORE
// committing, with the same semantics the capture container applies to
// staging after the turn (see that script's header for the why).
//
// The browser path is exercised through runGroup with a fake Playwright
// page (same approach as tests/capture-pool.test.js); manifest reading and
// the --changed fingerprint logic are pure.
//
// Run with: node --test tests/run-checks-cli.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  readTests, checkFingerprint, validatePath, parseArgs, runGroup,
} = require(path.join(__dirname, '..', 'worker', 'usernode-run-checks'));

// ── manifest normalization (mirrors app-manifest readTests) ─────────────

test('readTests keeps valid entries, drops invalid paths, de-dupes name+path', () => {
  const tests = readTests({
    tests: [
      { name: 'home', path: '/' },
      { name: 'home', path: '/' },                       // duplicate
      { name: 'abs', path: 'https://evil.example/x' },    // scheme
      { name: 'rel', path: 'no-slash' },                  // not rooted
      { path: '/named-after-path', expectSelector: ' #x ' },
      null,
      'string',
    ],
  });
  assert.equal(tests.length, 2);
  assert.deepEqual(tests[0], {
    name: 'home', path: '/', expectSelector: null, expectText: null, allowConsoleErrors: false,
  });
  assert.equal(tests[1].name, '/named-after-path', 'name falls back to the path');
  assert.equal(tests[1].expectSelector, '#x', 'selector is trimmed');
});

test('validatePath rejects protocol-relative, whitespace and markup', () => {
  assert.equal(validatePath('//evil.example'), null);
  assert.equal(validatePath('/ok path'), null);
  assert.equal(validatePath('/x<script>'), null);
  assert.equal(validatePath('/fine?shot=state#hash'), '/fine?shot=state#hash');
});

test('checkFingerprint changes when assertions change, so --changed re-runs edited checks', () => {
  const a = { name: 'n', path: '/p', expectSelector: '#a', expectText: null, allowConsoleErrors: false };
  const b = { ...a, expectSelector: '#b' };
  const c = { ...a };
  assert.notEqual(checkFingerprint(a), checkFingerprint(b));
  assert.equal(checkFingerprint(a), checkFingerprint(c));
});

test('parseArgs understands the documented flags', () => {
  const args = parseArgs(['--changed', '--filter', 'feedback', '--base-url', 'http://127.0.0.1:4000']);
  assert.equal(args.changed, true);
  assert.equal(args.filter, 'feedback');
  assert.equal(args.baseUrl, 'http://127.0.0.1:4000');
  assert.equal(args.manifest, 'dapp.json');
});

// ── runGroup semantics against a fake page ───────────────────────────────

function fakeContext({ status = 200, selectors = {}, text = '', consoleErrorsOnLoad = [], failNav = false } = {}) {
  return {
    async newPage() {
      let navAt = 0;
      const handlers = {};
      return {
        on(event, fn) { handlers[event] = fn; },
        async goto() {
          if (failNav) throw new Error('connection refused');
          navAt = Date.now();
          for (const msg of consoleErrorsOnLoad) {
            handlers.console({ type: () => 'error', text: () => msg });
          }
          return { status: () => status };
        },
        async $(sel) {
          const lateMs = selectors[sel];
          if (lateMs == null) return null;
          return (Date.now() - navAt >= lateMs) ? {} : null;
        },
        async evaluate(fn, arg) {
          return text.toLowerCase().includes(String(arg).toLowerCase());
        },
        async close() {},
      };
    },
  };
}

test('a passing check passes; console errors fail it unless allowed', async () => {
  const ctx = fakeContext({ selectors: { '#ok': 0 }, consoleErrorsOnLoad: ['boom'] });
  const results = await runGroup(ctx, 'http://x/', [
    { name: 'strict', path: '/', expectSelector: '#ok', expectText: null, allowConsoleErrors: false },
    { name: 'lenient', path: '/', expectSelector: '#ok', expectText: null, allowConsoleErrors: true },
  ]);
  assert.equal(results[0].pass, false);
  assert.match(results[0].reason, /console error/);
  assert.equal(results[1].pass, true);
});

test('selector assertions WAIT for late-rendering elements (capture parity)', async () => {
  const ctx = fakeContext({ selectors: { '[data-shot-done]': 400 } });
  const results = await runGroup(ctx, 'http://x/?shot=s', [
    { name: 'shot', path: '/?shot=s', expectSelector: '[data-shot-done]', expectText: null, allowConsoleErrors: false },
  ]);
  assert.equal(results[0].pass, true, 'the element appears 400ms after load and must still pass');
});

test('a failed navigation fails every check in the group with the load reason', async () => {
  const ctx = fakeContext({ failNav: true });
  const results = await runGroup(ctx, 'http://x/', [
    { name: 'a', path: '/', expectSelector: null, expectText: null, allowConsoleErrors: false },
    { name: 'b', path: '/', expectSelector: '#x', expectText: null, allowConsoleErrors: false },
  ]);
  assert.equal(results.length, 2);
  for (const r of results) {
    assert.equal(r.pass, false);
    assert.match(r.reason, /Page failed to load/);
  }
});

test('expectText matches rendered text case-insensitively', async () => {
  const ctx = fakeContext({ text: 'WELCOME BACK' });
  const results = await runGroup(ctx, 'http://x/', [
    { name: 't', path: '/', expectSelector: null, expectText: 'welcome', allowConsoleErrors: false },
  ]);
  assert.equal(results[0].pass, true);
});
