// Tests for the read-only "GitHub Actions secrets (platform repo)" group:
// github.listActionsSecrets() plus the merge/dedupe inside
// platformSecretsView() (src/routes/apps.js).
//
// Two invariants and one failure mode:
//
//  1. NO VALUE EXISTS TO LEAK. GitHub's API returns { name, created_at,
//     updated_at } and nothing else, for any credential — so the rows the
//     panel gets must carry value/valueLast4 as hard nulls, and the UI
//     must never imply a reveal is possible.
//  2. AN EXACT NAME MATCH ANNOTATES, IT DOESN'T DUPLICATE. deploy.yml
//     renames most secrets on their way into the env
//     (secrets.USERNODE_JWT_SECRET → JWT_SECRET), so exact-name is the
//     only case where the GitHub secret and the panel row are the same
//     object.
//  3. THE LISTING FAILS OPEN. Reading Actions secrets is an admin-level
//     capability the platform's token may simply not have; a 403 must
//     degrade to one explanatory line, never an error on a panel whose
//     real job is elsewhere.
//
// Run with: node --test tests/github-actions-secrets.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const github = require('../src/services/github');

const root = path.join(__dirname, '..');
const appsJs = fs.readFileSync(path.join(root, 'src/routes/apps.js'), 'utf8');
const secretsUiJs = fs.readFileSync(path.join(root, 'public/js/app-secrets.js'), 'utf8');

// A stub octokit whose request() answers the Actions-secrets endpoint.
// `pages` is a list of { secrets, total_count } responses.
function stubOctokit(pages, { fail } = {}) {
  const requests = [];
  return {
    requests,
    client: {
      request: async (route, params) => {
        requests.push({ route, params });
        if (fail) {
          const err = new Error(fail.message || 'stubbed failure');
          err.status = fail.status;
          throw err;
        }
        const page = pages[(params.page || 1) - 1] || { secrets: [], total_count: 0 };
        return { data: page };
      },
    },
  };
}

function withStub(t, stub) {
  github._setOctokitFactoryForTests(() => stub.client);
  t.after(() => {
    github._setOctokitFactoryForTests(null);
    github.invalidateActionsSecretsCache();
  });
  github.invalidateActionsSecretsCache();
}

test('maps name + timestamps and sorts by name', async (t) => {
  const stub = stubOctokit([{
    total_count: 2,
    secrets: [
      { name: 'ZEBRA_TOKEN', created_at: '2024-01-01T00:00:00Z', updated_at: '2025-02-02T00:00:00Z' },
      { name: 'ALPHA_TOKEN', created_at: '2023-05-05T00:00:00Z', updated_at: '2023-05-05T00:00:00Z' },
    ],
  }]);
  withStub(t, stub);

  const result = await github.listActionsSecrets('acme', 'platform');
  assert.equal(result.ok, true);
  assert.deepEqual(result.secrets.map((s) => s.name), ['ALPHA_TOKEN', 'ZEBRA_TOKEN']);
  assert.deepEqual(result.secrets[1], {
    name: 'ZEBRA_TOKEN',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2025-02-02T00:00:00Z',
  });
  // The whole point: nothing value-shaped comes back, because nothing
  // value-shaped exists on this endpoint.
  assert.ok(!Object.keys(result.secrets[0]).some((k) => /value/i.test(k)));
});

test('a missing updated_at falls back to created_at rather than rendering blank', async (t) => {
  const stub = stubOctokit([{ total_count: 1, secrets: [{ name: 'ONLY_CREATED', created_at: '2024-03-03T00:00:00Z' }] }]);
  withStub(t, stub);
  const { secrets } = await github.listActionsSecrets('acme', 'platform');
  assert.equal(secrets[0].updatedAt, '2024-03-03T00:00:00Z');
});

test('caches: a second call issues no request', async (t) => {
  const stub = stubOctokit([{ total_count: 1, secrets: [{ name: 'A', updated_at: '2025-01-01T00:00:00Z' }] }]);
  withStub(t, stub);

  await github.listActionsSecrets('acme', 'platform');
  await github.listActionsSecrets('ACME', 'platform');   // case-insensitive key
  assert.equal(stub.requests.length, 1, 'one panel open per TTL, not one per render');
});

test('pages until total_count is satisfied', async (t) => {
  const page1 = { total_count: 150, secrets: Array.from({ length: 100 }, (_, i) => ({ name: `K${String(i).padStart(3, '0')}`, updated_at: '2025-01-01T00:00:00Z' })) };
  const page2 = { total_count: 150, secrets: Array.from({ length: 50 }, (_, i) => ({ name: `L${String(i).padStart(3, '0')}`, updated_at: '2025-01-01T00:00:00Z' })) };
  const stub = stubOctokit([page1, page2]);
  withStub(t, stub);

  const { secrets } = await github.listActionsSecrets('acme', 'platform');
  assert.equal(secrets.length, 150);
  assert.equal(stub.requests.length, 2);
  assert.equal(stub.requests[1].params.page, 2);
});

test('stops at the hard cap so a pathological repo cannot stall the panel', async (t) => {
  const huge = (n) => ({
    total_count: 10000,
    secrets: Array.from({ length: 100 }, (_, i) => ({ name: `P${n}_${i}`, updated_at: '2025-01-01T00:00:00Z' })),
  });
  const stub = stubOctokit([huge(1), huge(2), huge(3), huge(4), huge(5)]);
  withStub(t, stub);

  const { secrets } = await github.listActionsSecrets('acme', 'platform');
  assert.equal(secrets.length, github.ACTIONS_SECRETS_MAX);
  assert.ok(stub.requests.length <= 3, 'and no more pages than the cap needs');
});

test('a 403 fails open with the operator-facing reason', async (t) => {
  const stub = stubOctokit([], { fail: { status: 403, message: 'Resource not accessible' } });
  withStub(t, stub);

  const result = await github.listActionsSecrets('acme', 'platform');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'forbidden');
  assert.equal(result.message, github.ACTIONS_SECRETS_FORBIDDEN_MESSAGE);
  assert.match(result.message, /admin access/);
  assert.match(result.message, /secrets: read/, 'names both ways an operator can grant it');
});

test("a 404 says the same thing as a 403 (GitHub hides what you can't read)", async (t) => {
  const stub = stubOctokit([], { fail: { status: 404, message: 'Not Found' } });
  withStub(t, stub);
  const result = await github.listActionsSecrets('acme', 'platform');
  assert.equal(result.code, 'not_found');
  assert.equal(result.message, github.ACTIONS_SECRETS_FORBIDDEN_MESSAGE,
    'implying the repo is gone would send an operator down the wrong path');
});

test('a transport error fails open too, and is cached briefly', async (t) => {
  const stub = stubOctokit([], { fail: { status: 500, message: 'boom' } });
  withStub(t, stub);

  const first = await github.listActionsSecrets('acme', 'platform');
  assert.equal(first.ok, false);
  assert.equal(first.code, 'github_error');
  const requestsAfterFirst = stub.requests.length;
  await github.listActionsSecrets('acme', 'platform');
  assert.equal(stub.requests.length, requestsAfterFirst,
    'a token that cannot read the list is not re-probed on every panel open');
});

test('no repo means no call at all', async (t) => {
  const stub = stubOctokit([{ total_count: 0, secrets: [] }]);
  withStub(t, stub);
  const result = await github.listActionsSecrets('', '');
  assert.equal(result.ok, false);
  assert.equal(stub.requests.length, 0);
});

// ── platformSecretsView: the merge + dedupe ──────────────────────────
//
// The function is a module-local helper, so it is exercised through a
// tiny extraction rather than a require: it is pure (rows + manifest +
// options in, rows out) and has no dependencies beyond process.env.
function extractPlatformSecretsView() {
  const start = appsJs.indexOf('function platformSecretsView(');
  assert.notStrictEqual(start, -1, 'platformSecretsView not found');
  // Its body ends at the next top-level declaration.
  const end = appsJs.indexOf('\n// If app creation hasn\'t reached', start);
  assert.notStrictEqual(end, -1, 'end of platformSecretsView not found');
  const src = appsJs.slice(start, end);
  const groupConst = "const GITHUB_ACTIONS_GROUP = 'GitHub Actions secrets (platform repo)';\n";
  // eslint-disable-next-line no-new-func
  return new Function(`${groupConst}${src}; return platformSecretsView;`)();
}

const platformSecretsView = extractPlatformSecretsView();

function declRow(over = {}) {
  return {
    key: 'MAX_GLOBAL_SESSIONS',
    declared: true,
    hasValue: true,
    description: 'ceiling',
    required: false,
    private: false,
    group: 'Scaling',
    defaultValue: '75',
    unwritable: false,
    value: '90',
    valueLast4: null,
    updatedAt: null,
    updatedBy: null,
    state: 'set',
    ...over,
  };
}

test('an unmatched GitHub secret becomes its own read-only row', () => {
  const view = platformSecretsView([declRow()], { secrets: [] }, {
    includeValues: true,
    actionsSecrets: { ok: true, secrets: [{ name: 'DEPLOY_SSH_KEY', updatedAt: '2025-06-01T00:00:00Z' }] },
  });

  const row = view.find((r) => r.key === 'DEPLOY_SSH_KEY');
  assert.ok(row, 'a deploy-only secret that was never an env var still shows up');
  assert.equal(row.group, 'GitHub Actions secrets (platform repo)');
  assert.equal(row.state, 'managed');
  assert.equal(row.unwritable, true, 'so the client strips every control');
  assert.equal(row.source, 'github-actions');
  assert.equal(row.hasValue, true);
  assert.equal(row.value, null, 'there is no value to return, ever');
  assert.equal(row.valueLast4, null);
  assert.equal(row.updatedAt, '2025-06-01T00:00:00Z');
});

test('an exact-name match annotates the existing row instead of duplicating it', () => {
  const view = platformSecretsView(
    [declRow({ key: 'ZEROSSL_API_KEY', unwritable: true, state: 'managed', group: 'TLS' })],
    { secrets: [] },
    {
      includeValues: true,
      actionsSecrets: { ok: true, secrets: [{ name: 'ZEROSSL_API_KEY', updatedAt: '2025-04-04T00:00:00Z' }] },
    }
  );

  const rows = view.filter((r) => r.key === 'ZEROSSL_API_KEY');
  assert.equal(rows.length, 1, 'one variable, one row');
  assert.deepEqual(rows[0].githubSecret, { name: 'ZEROSSL_API_KEY', updatedAt: '2025-04-04T00:00:00Z' });
  assert.equal(rows[0].group, 'TLS', 'it stays where it was');
  assert.ok(!view.some((r) => r.source === 'github-actions'),
    'and no separate GitHub row is added for it');
});

test('a synthesized deploy-owned row (from the `secrets` block) also annotates', () => {
  const view = platformSecretsView([declRow()], {
    secrets: [{ key: 'GITHUB_BOT_TOKEN', description: 'PAT', required: true, private: true, default: null }],
  }, {
    includeValues: true,
    actionsSecrets: {
      ok: true,
      secrets: [
        { name: 'GITHUB_BOT_TOKEN', updatedAt: '2025-07-07T00:00:00Z' },
        // The renamed case: deploy.yml maps this onto ADMIN_PASSWORD, so
        // it does NOT match and gets its own row — that's accurate, they
        // are different objects.
        { name: 'USERNODE_ADMIN_PASSWORD', updatedAt: '2025-07-07T00:00:00Z' },
      ],
    },
  });

  const bot = view.filter((r) => r.key === 'GITHUB_BOT_TOKEN');
  assert.equal(bot.length, 1);
  assert.ok(bot[0].githubSecret);
  assert.ok(view.some((r) => r.key === 'USERNODE_ADMIN_PASSWORD' && r.source === 'github-actions'),
    'a renamed secret is its own row rather than being guessed at');
});

test('the GitHub group sinks below the groups people can act on', () => {
  const view = platformSecretsView([declRow()], { secrets: [] }, {
    includeValues: true,
    actionsSecrets: { ok: true, secrets: [{ name: 'AAA_FIRST_ALPHABETICALLY', updatedAt: null }] },
  });
  const actionableAt = view.findIndex((r) => r.key === 'MAX_GLOBAL_SESSIONS');
  const githubAt = view.findIndex((r) => r.source === 'github-actions');
  assert.ok(actionableAt < githubAt,
    'an all-unwritable group must not push the editable variables below the fold');
});

test('no actionsSecrets argument leaves the view byte-for-byte as before', () => {
  const rows = [declRow()];
  const withNull = platformSecretsView(rows, { secrets: [] }, { includeValues: true, actionsSecrets: null });
  const without = platformSecretsView(rows, { secrets: [] }, { includeValues: true });
  assert.deepEqual(withNull, without);
  assert.ok(!withNull.some((r) => r.source === 'github-actions'));
  assert.ok(!withNull.some((r) => r.githubSecret));
});

// ── Route + client wiring ────────────────────────────────────────────

test('the fetch is admin-only and never blocks the panel', () => {
  assert.match(appsJs, /const includeValues = !!req\.user\?\.isAdmin;/);
  assert.match(appsJs, /includeValues\s*\n?\s*\? await resolveActionsSecrets\(app\)\s*\n?\s*: \{ state: 'hidden', result: null \}/);
  const resolver = appsJs.slice(
    appsJs.indexOf('async function resolveActionsSecrets('),
    appsJs.indexOf('// Fold the keys with a declaration PR in flight')
  );
  assert.match(resolver, /github\.isEnabled\(\)/);
  assert.match(resolver, /stagingMockActionsSecrets\(\)/, 'staging previews get a demo list');
  assert.match(resolver, /state: 'unavailable', reason: result\.message/,
    'a failure becomes a reason to print, not an exception');
});

test('the staging mock is gated on USERNODE_ENV and covers the annotation path', () => {
  const mock = appsJs.slice(
    appsJs.indexOf('function stagingMockActionsSecrets('),
    appsJs.indexOf('// If app creation hasn\'t reached')
  );
  assert.match(mock, /if \(!IS_STAGING\) return null;/, 'strictly a no-op outside staging');
  assert.match(mock, /STAGING_DEMO_GH_DEPLOY_KEY/);
  assert.match(mock, /STAGING_DEMO_GH_API_TOKEN/);
  assert.match(mock, /GITHUB_BOT_TOKEN/,
    'an exact match with a key the platform\'s own secrets block declares, so the '
    + 'annotation path is reviewable in a preview and not only in production');
});

test('the client renders presence only, and says why no value can be shown', () => {
  assert.match(secretsUiJs, /source === 'github-actions'/);
  assert.match(secretsUiJs, /Set on GitHub/);
  assert.match(secretsUiJs, /never returns/,
    'the UI must not imply a future reveal button');
  assert.match(secretsUiJs, /Settings → Secrets and variables → Actions/,
    'and must say where the change actually happens');
  assert.match(secretsUiJs, /state === 'unavailable'/, 'the fail-open line has a renderer');
  assert.match(secretsUiJs, /No Actions secrets on this repo/,
    '"none" and "couldn\'t read them" are different answers');
  assert.match(secretsUiJs, /gh\.state !== 'hidden'/,
    'a non-admin sees no group at all rather than an empty one');
});
