'use strict';

// The "Sign-in token read after the bridge" row (services/token-order-check.js,
// RecipeBot #175). Pins which scripts count as running before the bridge,
// what counts as a token read, the introduced-only rule (a read the merge
// base already had is never flagged), advisory vs blocking, fail-open, and
// one compare per head.

const test = require('node:test');
const assert = require('node:assert/strict');

const check = require('../src/services/token-order-check');
const { classifyTests } = require('../src/services/visuals');

const HEAD = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const LOADS = [{ name: 'loads with no console errors', path: '/', status: 'pass' }];

const BRIDGE = '<script src="/usernode-bridge/v1/bridge.js"></script>';
const READ = "<script>\n  var token = new URLSearchParams(location.search).get('token') || '';\n</script>";

// RecipeBot's page before PR 176: the fetch wrapper above the bridge tag.
const READ_FIRST = `<!DOCTYPE html>\n<html><head>\n${READ}\n${BRIDGE}\n</head><body></body></html>\n`;
// The same page with the read moved below the bridge, as PR 176 left it.
const BRIDGE_FIRST = `<!DOCTYPE html>\n<html><head>\n${BRIDGE}\n${READ}\n</head><body></body></html>\n`;

// A fake code host: `trees[ref][path]` is a file's text at that ref.
function fakeGithub({ files = [{ filename: 'public/index.html', status: 'modified' }], trees = {}, compareError, readError, mergeBaseSha = BASE } = {}) {
  const calls = { compare: 0, reads: [] };
  return {
    calls,
    github: {
      isEnabled: () => true,
      async compareFiles(owner, repo, basehead) {
        calls.compare += 1;
        calls.basehead = basehead;
        if (compareError) throw compareError;
        return { files, diff: '', truncated: false, complete: true, mergeBaseSha };
      },
      async getFileContent(owner, repo, p, ref) {
        calls.reads.push(`${ref.slice(0, 1)}:${p}`);
        if (readError) throw readError;
        const tree = trees[ref] || {};
        return Object.prototype.hasOwnProperty.call(tree, p) ? tree[p] : null;
      },
    },
  };
}

async function run(fake, extra = {}) {
  check._resetCache();
  return check.maybeRunTokenOrderCheck({
    pool: null, sessionId: 1, appSlug: 'recipebot-33b169', repoOwner: 'apps', repoName: 'recipebot-33b169',
    commitHash: HEAD, deps: { github: fake.github }, ...extra,
  });
}

function withMode(value, fn) {
  const prev = process.env.TOKEN_ORDER_CHECK_MODE;
  if (value === undefined) delete process.env.TOKEN_ORDER_CHECK_MODE; else process.env.TOKEN_ORDER_CHECK_MODE = value;
  return Promise.resolve().then(fn).finally(() => {
    if (prev === undefined) delete process.env.TOKEN_ORDER_CHECK_MODE; else process.env.TOKEN_ORDER_CHECK_MODE = prev;
  });
}

test('an inline read above a classic bridge tag runs before it; one below does not', () => {
  assert.equal(check.scriptsBeforeBridge(READ_FIRST).scripts.length, 1);
  assert.equal(check.scriptsBeforeBridge(BRIDGE_FIRST).scripts.length, 0);
  assert.equal(check.scriptsBeforeBridge(BRIDGE_FIRST).bridge, true);
});

test('module and deferred scripts run after a classic bridge, wherever they sit', () => {
  const html = '<script type="module" src="/src/main.ts"></script>\n<script defer src="/app.js"></script>\n' + BRIDGE;
  assert.deepEqual(check.scriptsBeforeBridge(html).scripts, []);
});

test('with a deferred bridge, every classic script and the earlier deferred ones come first', () => {
  const html = '<script>var a = 1;</script>\n<script defer src="/first.js"></script>\n'
    + '<script defer src="/usernode-bridge/v1/bridge.js"></script>\n<script defer src="/after.js"></script>\n<script>var b = 2;</script>';
  const before = check.scriptsBeforeBridge(html).scripts.map((s) => s.src || s.body.trim());
  assert.deepEqual(before, ['var a = 1;', '/first.js', 'var b = 2;']);
});

test('a page with no hosted bridge counts every script; a vendored copy is not the bridge', () => {
  const html = '<script src="/usernode-bridge.js"></script>\n' + READ;
  const out = check.scriptsBeforeBridge(html);
  assert.equal(out.bridge, false);
  assert.equal(out.scripts.length, 2);
});

test('a commented-out tag and a JSON block are not scripts', () => {
  const html = `<!-- ${BRIDGE} -->\n<script type="application/json">{"token":"x"}</script>\n${READ}`;
  const out = check.scriptsBeforeBridge(html);
  assert.equal(out.bridge, false);
  assert.equal(out.scripts.length, 1);
});

test('token reads: the query getter, a parsed query on a later line, and a token= match', () => {
  assert.equal(check.tokenReads("var t = new URLSearchParams(location.search).get('token');").length, 1);
  const runClub = "var params = new URLSearchParams(window.location.search);\nvar keys = (function () {\n  var token = params.get('token') || '';\n})();";
  assert.deepEqual(check.tokenReads(runClub).map((r) => r.line), [3]);
  assert.equal(check.tokenReads('var m = location.search.match(/[?&]token=([^&]+)/);').length, 1);
});

test('token reads: other parameters and code that never reads the address do not count', () => {
  assert.deepEqual(check.tokenReads("var t = new URLSearchParams(location.search).get('invite_token');"), []);
  assert.deepEqual(check.tokenReads('var m = location.href.match(/invite_token=([^&]+)/);'), []);
  assert.deepEqual(check.tokenReads("if (location.hash.indexOf('#un-token=') === 0) {}"), []);
  assert.deepEqual(check.tokenReads("var t = form.get('token');"), []);
  assert.deepEqual(check.tokenReads("var theme = new URLSearchParams(location.search).get('un-theme');"), []);
});

test('script paths: same-origin files resolve from the page; platform files and other origins do not', () => {
  assert.deepEqual(check.scriptPaths('public/index.html', '/js/auth.js?v=2'), ['public/js/auth.js', 'js/auth.js']);
  assert.deepEqual(check.scriptPaths('public/admin/index.html', 'auth.js'), ['public/admin/auth.js']);
  assert.equal(check.scriptPaths('public/index.html', '/usernode-native/v1/native.js'), null);
  assert.equal(check.scriptPaths('public/index.html', 'https://cdn.example.com/x.js'), null);
  assert.equal(check.scriptPaths('public/index.html', '//cdn.example.com/x.js'), null);
});

test('a change that adds a read above the bridge is flagged, advisory by default', () => withMode(undefined, async () => {
  const fake = fakeGithub({ trees: { [HEAD]: { 'public/index.html': READ_FIRST }, [BASE]: { 'public/index.html': BRIDGE_FIRST } } });
  const { row } = await run(fake);
  assert.equal(row.status, 'fail');
  assert.equal(row.advisory, true);
  assert.equal(row.index, check.TOKEN_ORDER_CHECK_INDEX);
  assert.equal(row.checkedSha, HEAD);
  assert.match(row.failureReason, /public\/index\.html line 4/);
  assert.match(row.failureReason, /before the bridge tag/);
  assert.match(row.failureReason, /Move this code below the bridge tag/);
  assert.equal(fake.calls.basehead, `main...${HEAD}`);
  // An advisory flag never closes the gate.
  assert.equal(classifyTests(LOADS, 1, { extraRows: [row] }).state, 'passing');
}));

test('in blocking mode the flag fails the checks', () => withMode('blocking', async () => {
  const fake = fakeGithub({ trees: { [HEAD]: { 'public/index.html': READ_FIRST }, [BASE]: { 'public/index.html': BRIDGE_FIRST } } });
  const { row } = await run(fake);
  assert.equal(row.advisory, false);
  assert.notEqual(classifyTests(LOADS, 1, { extraRows: [row] }).state, 'passing');
}));

test('a read the merge base already had is not this change\'s (introduced only)', () => withMode('blocking', async () => {
  const fake = fakeGithub({
    files: [{ filename: 'public/app.js', status: 'modified' }],
    trees: { [HEAD]: { 'public/index.html': READ_FIRST }, [BASE]: { 'public/index.html': READ_FIRST } },
  });
  const { row } = await run(fake);
  assert.equal(row.status, 'pass');
}));

test('moving the bridge tag below an existing read is flagged', () => withMode(undefined, async () => {
  const fake = fakeGithub({ trees: { [HEAD]: { 'public/index.html': READ_FIRST }, [BASE]: { 'public/index.html': BRIDGE_FIRST } } });
  const { row } = await run(fake);
  assert.equal(row.status, 'fail');
}));

test('a same-origin script above the bridge is read from the repository', () => withMode(undefined, async () => {
  const page = `<html><head>\n<script src="/js/auth.js"></script>\n${BRIDGE}\n</head></html>`;
  const fake = fakeGithub({
    files: [{ filename: 'public/js/auth.js', status: 'modified' }],
    trees: {
      [HEAD]: { 'public/index.html': page, 'public/js/auth.js': "const t = new URLSearchParams(location.search).get('token');\n" },
      [BASE]: { 'public/index.html': page, 'public/js/auth.js': 'const t = "";\n' },
    },
  });
  const { row } = await run(fake);
  assert.equal(row.status, 'fail');
  assert.match(row.failureReason, /public\/js\/auth\.js line 1/);
}));

test('a new page with no bridge that reads the token is flagged and says so', () => withMode(undefined, async () => {
  const fake = fakeGithub({
    files: [{ filename: 'public/admin.html', status: 'added' }],
    trees: { [HEAD]: { 'public/admin.html': `<html>${READ}</html>`, 'public/index.html': BRIDGE_FIRST }, [BASE]: { 'public/index.html': BRIDGE_FIRST } },
  });
  const { row } = await run(fake);
  assert.equal(row.status, 'fail');
  assert.match(row.failureReason, /on a page that loads no bridge/);
}));

test('a change with no page or script passes without reading any file', () => withMode(undefined, async () => {
  const fake = fakeGithub({ files: [{ filename: 'README.md', status: 'modified' }] });
  const { row } = await run(fake);
  assert.equal(row.status, 'pass');
  assert.match(row.summary, /no page or script changed/);
  assert.deepEqual(fake.calls.reads, []);
}));

test('fails open when the change cannot be compared or read', () => withMode('blocking', async () => {
  const broken = await run(fakeGithub({ compareError: new Error('boom') }));
  assert.equal(broken.row.status, 'pass');
  assert.match(broken.row.summary, /not checked/);
  const unreadable = await run(fakeGithub({ readError: new Error('boom') }));
  assert.equal(unreadable.row.status, 'pass');
  assert.match(unreadable.row.summary, /not checked/);
}));

test('off, the platform\'s own repository, or no code host: no row', async () => {
  await withMode('off', async () => {
    assert.equal(await run(fakeGithub()), null);
  });
  await withMode(undefined, async () => {
    assert.equal(await run(fakeGithub(), { config: { selfAppSlug: 'recipebot-33b169' } }), null);
    const fake = fakeGithub();
    fake.github.isEnabled = () => false;
    assert.equal(await run(fake), null);
  });
});

test('one compare per head: a second settlement reuses the verdict', () => withMode(undefined, async () => {
  const fake = fakeGithub({ trees: { [HEAD]: { 'public/index.html': READ_FIRST }, [BASE]: { 'public/index.html': BRIDGE_FIRST } } });
  check._resetCache();
  const args = { pool: null, sessionId: 9, repoOwner: 'apps', repoName: 'x', commitHash: HEAD, deps: { github: fake.github } };
  await check.maybeRunTokenOrderCheck(args);
  await check.maybeRunTokenOrderCheck(args);
  assert.equal(fake.calls.compare, 1);
}));

test('the row is declared in the platform\'s settings', () => {
  const manifest = require('../dapp.json');
  const entry = (manifest.platform_env || []).find((e) => e.key === 'TOKEN_ORDER_CHECK_MODE');
  assert.ok(entry, 'TOKEN_ORDER_CHECK_MODE is in platform_env');
  assert.equal(entry.default, 'advisory');
});

test('the conventions\' Auth section states the rule this row holds', () => {
  const section = require('../src/services/prompts').getConventionSection('auth-iframe-token-injection');
  assert.ok(section && section.content, 'the Auth section is there');
  assert.match(section.content, /\*\*Read the token in a script AFTER the bridge tag\.\*\*/);
  assert.match(section.content, /The bridge never removes `\?token=` from the address/);
});
