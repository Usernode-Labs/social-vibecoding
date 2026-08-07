// #967: the connector's CONFIGURATION contract — what it declares, and how
// it behaves on a deployment where none of it is set.
//
// Two failure modes this pins, both of which would be discovered late and
// expensively:
//
//   1. A `required: true` platform_env declaration with no value set BLOCKS
//      THE MERGE — src/services/platform-env-check.js diffs the block
//      against the merge base and fails the proposal check. A connector
//      whose GitHub OAuth credentials are declared required would therefore
//      have to have its values set before it could ship, which is backwards:
//      the code degrades cleanly without them, so it must be mergeable
//      without them.
//   2. An UNSET deployment must degrade, not half-work. The link routes 404
//      (pinned in github-link.test.js), and the connector's fork tooling has
//      to say the deployment cannot fork — pointing at the platform-build
//      fallback — rather than sending the user to Settings to press a button
//      that isn't there. Everything that does NOT depend on the OAuth app
//      keeps working: the OAuth connector itself, the read-only tools, and
//      the out-of-credits card.
//
// Run with: node --test tests/connector-config-unset.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appManifest = require('../src/services/app-manifest');
const githubLink = require('../src/services/github-link');
const mcpOauth = require('../src/services/mcp-oauth');
const svc = require('../src/services/external-agent-tasks');
const { DEFAULT_REDIRECT_HOSTS } = require('../src/services/mcp-connect-constants');

const ROOT = path.join(__dirname, '..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'dapp.json'), 'utf8'));
const ENTRIES = appManifest.readPlatformEnv(MANIFEST);
const BY_KEY = new Map(ENTRIES.map((e) => [e.key, e]));

// The three variables this change taught the platform to read.
const NEW_KEYS = ['MCP_CONNECTOR_REDIRECT_HOSTS', 'GITHUB_LINK_CLIENT_ID', 'GITHUB_LINK_CLIENT_SECRET'];

// ── the declaration side ───────────────────────────────────────────────

test('every env var the connector introduced is declared in platform_env', () => {
  for (const key of NEW_KEYS) {
    assert.ok(BY_KEY.has(key), `${key} is read by the platform but not declared in dapp.json`);
    assert.ok(BY_KEY.get(key).description.length > 40,
      `${key}'s description has to tell an admin what setting it does`);
    assert.equal(BY_KEY.get(key).group, 'Chat connectors',
      'all three belong to one panel heading so they are set together');
  }
});

test('none of them can block this proposal from merging', () => {
  // This is the whole point of the audit: platform-env-check fails a
  // proposal that ADDS a required variable with no value, and all three of
  // these have a working unset behaviour. Rather than assert `required` and
  // hope that is what the check reads, run the check's own predicate over
  // the real manifest — the same source-parse it performs on a branch, and
  // the same filter it applies to the result.
  const check = require('../src/services/platform-env-check');
  const parsed = check.platformEnvFromManifestSource(
    fs.readFileSync(path.join(ROOT, 'dapp.json'), 'utf8')
  );
  assert.ok(Array.isArray(parsed), 'the check can parse this manifest at all');
  const overlay = check.unwritableOverlayFromSource(
    fs.readFileSync(path.join(ROOT, check.MANIFEST_MODULE_PATH), 'utf8')
  );
  const wouldBlock = new Set(
    parsed
      .filter((e) => e.required && !check.isUnwritableWithOverlay(e, overlay))
      .map((e) => e.key)
  );
  for (const key of NEW_KEYS) {
    assert.ok(parsed.some((e) => e.key === key), `${key} survives the check's own parse`);
    assert.equal(BY_KEY.get(key).required, false, `${key} must be required:false`);
    assert.ok(!wouldBlock.has(key),
      `${key} would be reported as a missing required value and block the merge`);
  }
});

test('the redirect-host default is the committed allowlist, verbatim', () => {
  // A declared default that drifts from the compiled-in one is worse than
  // no default: the admin panel would document a value the code does not
  // use. Pin them to each other.
  assert.equal(
    BY_KEY.get('MCP_CONNECTOR_REDIRECT_HOSTS').default,
    DEFAULT_REDIRECT_HOSTS.join(','),
    'the documented default must be exactly what mcp-connect-constants compiles in'
  );
  // Unset resolves to that same list, and setting it replaces rather than
  // extends — so the default is a complete value, not a seed.
  const before = process.env.MCP_CONNECTOR_REDIRECT_HOSTS;
  delete process.env.MCP_CONNECTOR_REDIRECT_HOSTS;
  try {
    assert.equal(mcpOauth.isAllowedRedirectUri('https://claude.ai/api/mcp/auth_callback', {}), true);
    assert.equal(mcpOauth.isAllowedRedirectUri('https://chatgpt.com/connector_platform_oauth_redirect', {}), true);
    assert.equal(mcpOauth.isAllowedRedirectUri('https://evil.example/cb', {}), false);
    process.env.MCP_CONNECTOR_REDIRECT_HOSTS = 'claude.ai';
    assert.equal(mcpOauth.isAllowedRedirectUri('https://claude.ai/cb', {}), true);
    assert.equal(mcpOauth.isAllowedRedirectUri('https://chatgpt.com/cb', {}), false,
      'an explicit value narrows the allowlist instead of adding to the default');
  } finally {
    if (before === undefined) delete process.env.MCP_CONNECTOR_REDIRECT_HOSTS;
    else process.env.MCP_CONNECTOR_REDIRECT_HOSTS = before;
  }
});

test('the OAuth client secret is declared private; the other two are not', () => {
  // private:true means encrypted at rest and never returned by any API —
  // right for a value that can mint GitHub authorizations for this
  // deployment, and wrong for a host list and a public client id.
  assert.equal(BY_KEY.get('GITHUB_LINK_CLIENT_SECRET').private, true);
  assert.equal(BY_KEY.get('GITHUB_LINK_CLIENT_ID').private, false);
  assert.equal(BY_KEY.get('MCP_CONNECTOR_REDIRECT_HOSTS').private, false);
  // No committed default for either credential: there is no sane real
  // value to commit, and unset is a supported state.
  assert.equal(BY_KEY.get('GITHUB_LINK_CLIENT_SECRET').default, null);
  assert.equal(BY_KEY.get('GITHUB_LINK_CLIENT_ID').default, null);
  // Both are settable from the panel — they are NOT deploy-owned
  // credentials, and an operator has no other way to turn linking on.
  assert.equal(BY_KEY.get('GITHUB_LINK_CLIENT_SECRET').unwritable, false);
  assert.equal(BY_KEY.get('GITHUB_LINK_CLIENT_ID').unwritable, false);
});

test('no connector module reads an undeclared new variable', () => {
  // Drift guard. A later connector change that starts reading a new
  // process.env value has to declare it in the same commit, or this fails.
  const MODULES = [
    'src/services/mcp-oauth.js',
    'src/services/mcp-tools.js',
    'src/services/mcp-connect-constants.js',
    'src/services/github-link.js',
    'src/services/external-agent-tasks.js',
    'src/services/connector-limits.js',
    'src/routes/mcp-remote.js',
  ];
  // Keys that predate this change and are owned by the deploy elsewhere.
  const PRE_EXISTING = new Set(['PLATFORM_INTERNAL_URL', 'SESSION_SECRET', 'USERNODE_ENV']);
  const seen = new Set();
  for (const rel of MODULES) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) seen.add(m[1]);
  }
  assert.ok(seen.size >= NEW_KEYS.length, 'sanity: the scrape found the reads');
  for (const key of seen) {
    if (PRE_EXISTING.has(key)) continue;
    assert.ok(BY_KEY.has(key),
      `${key} is read by a connector module but is not declared in dapp.json platform_env`);
  }
});

// ── the unset deployment ───────────────────────────────────────────────

const APP = { id: 7, slug: 'recipe-box', repo_url: 'https://github.com/usernode-bot/recipe-box' };
const okLimits = {
  checkPrepareRate: async () => null,
  checkProposalRate: async () => null,
  checkPromotedCap: async () => null,
};
const baseGh = () => ({
  isEnabled: () => true,
  parseGithubUrl: () => ({ owner: 'usernode-bot', repo: 'recipe-box' }),
  getBranchSha: async () => '0123456789abcdef0123456789abcdef01234567',
});

// The real module, reading the real (unset) environment — not a stub. That
// is what makes this a test of the deployment's behaviour rather than of a
// mock's.
function withNoOauthApp(fn) {
  const saved = {
    id: process.env.GITHUB_LINK_CLIENT_ID,
    secret: process.env.GITHUB_LINK_CLIENT_SECRET,
  };
  delete process.env.GITHUB_LINK_CLIENT_ID;
  delete process.env.GITHUB_LINK_CLIENT_SECRET;
  try {
    return fn();
  } finally {
    if (saved.id === undefined) delete process.env.GITHUB_LINK_CLIENT_ID;
    else process.env.GITHUB_LINK_CLIENT_ID = saved.id;
    if (saved.secret === undefined) delete process.env.GITHUB_LINK_CLIENT_SECRET;
    else process.env.GITHUB_LINK_CLIENT_SECRET = saved.secret;
  }
}

// A pool that throws: an unconfigured deployment must refuse before it goes
// looking for a per-user link it could never use anyway.
const noPool = { query: async () => { throw new Error('should not query'); } };

test('prepare_work reports the DEPLOYMENT cannot fork, not that the user forgot to click', async () => {
  await withNoOauthApp(async () => {
    let fetched = false;
    const original = global.fetch;
    global.fetch = async () => { fetched = true; throw new Error('should not be called'); };
    try {
      const result = await svc.prepareWork(
        { pool: noPool, config: {}, gh: baseGh(), githubLink, limits: okLimits },
        { user: { id: 3 }, app: APP, brief: 'x', origin: 'https://usernode.example' }
      );
      assert.equal(result.ok, false);
      assert.equal(result.code, 'github_link_unavailable');
      assert.equal(result.retryable, false, 'nothing changes until an operator sets a value');
      // It must NOT be the "go to Settings" refusal: that screen correctly
      // says linking is not configured, so sending the user there is a dead
      // end. Point at the route that still works instead.
      assert.notEqual(result.code, 'github_not_linked');
      assert.equal(result.settingsUrl, undefined);
      assert.match(result.message, /start_platform_build/);
      assert.match(result.message, /GITHUB_LINK_CLIENT_ID/);
      assert.equal(fetched, false, 'and no GitHub call is attempted');
    } finally {
      global.fetch = original;
    }
  });
});

test('submit_work refuses the same way rather than importing unattributable work', async () => {
  await withNoOauthApp(async () => {
    // Attribution is decided by comparing a PR's head owner to the
    // caller's VERIFIED github_login. With no OAuth app there is no
    // verified login to compare against, so the only safe answer is to
    // refuse — never to skip the gate.
    const result = await svc.submitWork(
      { pool: noPool, config: {}, gh: baseGh(), githubLink, limits: okLimits },
      { user: { id: 3 }, taskId: 4, confirm: true, origin: 'https://usernode.example' }
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'github_link_unavailable');
  });
});

test('the assistant is told the two refusals need different answers', () => {
  const toolsSrc = fs.readFileSync(path.join(ROOT, 'src/services/mcp-tools.js'), 'utf8');
  const instructions = toolsSrc.slice(0, toolsSrc.indexOf('function registerTools'));
  assert.match(instructions, /github_not_linked[\s\S]{0,200}settings/i);
  assert.match(
    instructions,
    /github_link_unavailable[\s\S]{0,200}start_platform_build/,
    'the unconfigured case must route to the fallback, not to Settings'
  );
});

// ── what keeps working ─────────────────────────────────────────────────

test('the OAuth connector itself does not depend on the GitHub OAuth app', () => {
  withNoOauthApp(() => {
    assert.equal(githubLink.isEnabled({}), false, 'precondition: linking is off');
    // Registration, PKCE and scope handling are entirely independent — a
    // deployment with no GitHub app can still be connected from Claude.ai
    // and ChatGPT, and every read-only tool works.
    assert.equal(mcpOauth.isAllowedRedirectUri('https://claude.ai/api/mcp/auth_callback', {}), true);
    const verifier = 'a'.repeat(64);
    const challenge = require('node:crypto').createHash('sha256').update(verifier, 'utf8').digest('base64url');
    assert.equal(mcpOauth.verifyPkce(verifier, challenge), true);
    assert.deepEqual(mcpOauth.normalizeScopes('usernode:apps:read'), ['usernode:apps:read']);
  });
});

test('no read-only tool is gated on the GitHub OAuth app', () => {
  // whoami reports link STATUS (a plain column read) and every other read
  // tool goes to the platform over loopback. Only the two fork tools ask
  // githubLink whether the deployment can fork at all.
  const svcSrc = fs.readFileSync(path.join(ROOT, 'src/services/external-agent-tasks.js'), 'utf8');
  const guards = [...svcSrc.matchAll(/githubLink\.isEnabled\(config\)/g)];
  assert.equal(guards.length, 2, 'exactly prepareWork and submitWork');
  const toolsSrc = fs.readFileSync(path.join(ROOT, 'src/services/mcp-tools.js'), 'utf8');
  assert.doesNotMatch(toolsSrc, /githubLink\.isEnabled/,
    'the tool layer must not add a second, drifting gate');
});

test('the out-of-credits card is unaffected by any of this', () => {
  // The card renders from a 429 the client already receives; it has no
  // server config of its own, and must not learn one. All three of its
  // routes stay reachable on a deployment with no GitHub app: two are
  // Settings screens, and the third is the connector section, which works
  // precisely because the connector does not need the fork credentials.
  const src = fs.readFileSync(path.join(ROOT, 'public/js/credit-options.js'), 'utf8');
  assert.doesNotMatch(src, /GITHUB_LINK|MCP_CONNECTOR|process\.env/);
  const opts = [...src.matchAll(/'(#settings\/[a-z-]+)'/g)].map((m) => m[1]);
  assert.deepEqual(opts, ['#settings/api-key', '#settings/cli', '#settings/connectors']);
});
