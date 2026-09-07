// Signing in from the MCP consent page must come back to the consent page.
//
// The bug this pins: the consent page used to bounce an anonymous visitor to
// `/#login?next=<encoded request>`. That value had exactly one writer and no
// reader. A fragment never reaches the server; `restoreFromHash` splits the
// fragment's own query off and drops it on the auth-route branch; and
// `AuthScreens.finishLogin` — the single completion point for every
// credential exchange — reads `location.search`, which on that URL is empty.
// So the encoded request sat in the address bar, unread, and signing in
// landed on the feed. The person had to go back to Claude or ChatGPT and
// start the connect flow a second time, which is exactly what was reported.
//
// The fix reuses the carrier the platform already honours — `?return_to=` in
// the QUERY string, the form the CLI consent page uses — and widens
// finishLogin's allowlist from one exact string to a pathname allowlist, so
// that a consent request can keep the query string that IS the request.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const AUTH_SRC = fs.readFileSync(path.join(ROOT, 'public/js/auth-screens.js'), 'utf8');
const CONNECT_SRC = fs.readFileSync(path.join(ROOT, 'public/js/connect-authorize.js'), 'utf8');
// Comments in that file necessarily QUOTE the broken form they explain, so the
// absence assertions below have to look at code alone or they match the very
// explanation of the fix.
const CONNECT_CODE = CONNECT_SRC
  .split('\n')
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join('\n');
const CONSTANTS_SRC = fs.readFileSync(path.join(ROOT, 'src/services/mcp-connect-constants.js'), 'utf8');

const ORIGIN = 'https://usernode.example';

// Load the browser IIFE under a stub window. Only the pieces the
// return-to branch touches need to be real; everything else exists so the
// module's load-time wiring does not throw.
function loadAuthScreens(search) {
  const location = {
    origin: ORIGIN,
    href: ORIGIN + '/' + (search || ''),
    search: search || '',
    hash: '#login',
    pathname: '/',
    replace(value) { location.href = value; },
  };
  const noopEl = {
    addEventListener: () => {},
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    style: {},
    hidden: false,
  };
  const sandbox = {
    console,
    URL,
    URLSearchParams,
    location,
    setTimeout,
    clearTimeout,
    fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    document: {
      addEventListener: () => {},
      removeEventListener: () => {},
      getElementById: () => noopEl,
      querySelector: () => noopEl,
      querySelectorAll: () => [],
      createElement: () => noopEl,
      body: noopEl,
      documentElement: noopEl,
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    App: { clearSessionSnapshot: () => {}, enterAuthed: () => {}, restoreFromHash: () => {} },
    PlatformUI: null,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(AUTH_SRC, sandbox);
  return { AuthScreens: sandbox.AuthScreens, location, sandbox };
}

// ── returnToUrl: what the platform will and will not navigate to ───────

test('the consent request keeps its query string, which IS the request', () => {
  const { AuthScreens } = loadAuthScreens();
  const target = '/connect/authorize?response_type=code&client_id=abc123'
    + '&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fcallback'
    + '&code_challenge=xyz&code_challenge_method=S256&state=s1';
  // An exact-string allowlist could never have carried these five parameters,
  // which is the reason the old code reached for a fragment in the first place.
  assert.equal(AuthScreens.returnToUrl(target), target);
});

test('the CLI consent page keeps working, unchanged', () => {
  const { AuthScreens } = loadAuthScreens();
  assert.equal(AuthScreens.returnToUrl('/cli/authorize'), '/cli/authorize');
});

test('nothing but an allowlisted same-origin path is accepted', () => {
  const { AuthScreens } = loadAuthScreens();
  // The whole reason finishLogin had an exact-match check: this must not
  // become a general redirector just because it now carries a query string.
  const refused = [
    'https://evil.example/connect/authorize',
    'http://evil.example/cli/authorize',
    '//evil.example/connect/authorize',
    '/\\evil.example',
    'javascript:alert(1)',
    'javascript:/connect/authorize',
    '/connect/authorize/../../evil',
    '/feed',
    '/connect/authorize.html',
    '/connect/authorizex',
    'connect/authorize',
    '',
    null,
    undefined,
  ];
  for (const value of refused) {
    assert.equal(AuthScreens.returnToUrl(value), '',
      `refuses ${JSON.stringify(value)}`);
  }
});

test('a traversal that lands back on an allowed path is normalised, not smuggled', () => {
  const { AuthScreens } = loadAuthScreens();
  // Resolved through URL(), so this really is the consent page and is allowed;
  // the point is that the decision is made on the RESOLVED pathname.
  assert.equal(AuthScreens.returnToUrl('/cli/../connect/authorize?a=1'),
    '/connect/authorize?a=1');
});

test('the fragment is dropped rather than forwarded', () => {
  const { AuthScreens } = loadAuthScreens();
  assert.equal(AuthScreens.returnToUrl('/connect/authorize?a=1#frag'),
    '/connect/authorize?a=1');
});

// ── finishLogin: the single completion point for every sign-in ─────────

test('finishLogin returns to the consent request it was given', async () => {
  const target = '/connect/authorize?client_id=abc&state=s1';
  const { AuthScreens, location } = loadAuthScreens('?return_to=' + encodeURIComponent(target));
  await AuthScreens.finishLogin();
  assert.equal(location.href, target,
    'the pending authorization request is reopened, not dropped for the feed');
});

test('finishLogin still honours the CLI consent page', async () => {
  const { AuthScreens, location } = loadAuthScreens('?return_to=%2Fcli%2Fauthorize');
  await AuthScreens.finishLogin();
  assert.equal(location.href, '/cli/authorize');
});

// Refusing the return branch means falling through to the ordinary boot,
// which navigates on its own. So the assertion is that the crafted target is
// NOT where we ended up, not that nothing moved.
async function refusedTarget(search) {
  const { AuthScreens, location } = loadAuthScreens(search);
  await AuthScreens.finishLogin();
  return location.href;
}

test('finishLogin refuses a return_to smuggled alongside other parameters', async () => {
  // Unchanged guard: exactly one return_to and no other query key. A second
  // parameter is how a crafted link would try to reach this branch.
  const href = await refusedTarget('?return_to=%2Fconnect%2Fauthorize&shot=offline');
  assert.ok(!href.includes('/connect/authorize'), 'did not follow a mixed query');
});

test('finishLogin refuses two return_to values', async () => {
  const href = await refusedTarget(
    '?return_to=%2Fconnect%2Fauthorize&return_to=%2Fcli%2Fauthorize'
  );
  assert.ok(!href.includes('/connect/authorize'));
  assert.ok(!href.includes('/cli/authorize'));
});

test('finishLogin does not navigate to an off-allowlist return_to', async () => {
  const href = await refusedTarget(
    '?return_to=' + encodeURIComponent('https://evil.example/')
  );
  assert.ok(!href.includes('evil.example'), 'falls through to the ordinary boot');
});

// ── The consent page's half of the contract ────────────────────────────

test('the consent page sends its return target in the query, not the fragment', () => {
  // The fragment form is the bug. Pinned as an absence so it cannot come
  // back: a `?` after a `#` is not a query string, and nothing reads it.
  assert.doesNotMatch(CONNECT_CODE, /#login\?next=/,
    'the unreadable fragment form is gone');
  assert.doesNotMatch(CONNECT_CODE, /next=/,
    'and so is the parameter name that had no reader');
  assert.match(CONNECT_CODE, /window\.location\.replace\('\/\?return_to='/,
    'the return target is the query string');
  assert.match(CONNECT_CODE, /\+ '#login'\)/,
    'and the fragment only selects the screen');
});

test('the page the consent page asks to return to is the page it is served at', () => {
  // The two halves are in different files and neither imports the other, so
  // this is the pin that keeps them agreeing: if CONSENT_PATH moves, the
  // allowlist has to move with it or signing in silently stops returning.
  const m = CONSTANTS_SRC.match(/const CONSENT_PATH = '([^']+)'/);
  assert.ok(m, 'CONSENT_PATH is declared in mcp-connect-constants.js');
  const consentPath = m[1];
  assert.equal(consentPath, '/connect/authorize');

  const { AuthScreens } = loadAuthScreens();
  assert.equal(
    AuthScreens.returnToUrl(consentPath + '?client_id=abc'),
    consentPath + '?client_id=abc',
    'finishLogin accepts the path the consent page is actually served at'
  );

  // And the allowlist is a pathname list, which is what lets it.
  assert.match(AUTH_SRC, /const RETURN_TO_PATHS = \[/);
  assert.ok(AUTH_SRC.includes("'" + consentPath + "'"),
    'the consent path is on the allowlist verbatim');
  assert.ok(AUTH_SRC.includes("'/cli/authorize'"),
    'and the CLI path it already carried is still there');
});
