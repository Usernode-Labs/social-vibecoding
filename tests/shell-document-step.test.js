'use strict';

// frontend/scripts/build-shell.mjs --bundle-only, --prerender-only and
// --document.
//
// Dockerfile.kubernetes builds the shell in three runs. Two have no commit id
// and run at the same time, each in a stage of its own: the browser bundle
// (pass 1) and the prerender bundle (pass 2), which is kept. The third runs
// after GIT_SHA is declared, in the stage that copies both in, and writes only
// the document. The split is what lets BuildKit run the two passes and
// Tailwind at once, and reuse them for a commit that left their inputs alone
// (tests/kubernetes-deployment-contract.test.js pins the stages).
//
// The document run is what most of these tests exercise, on a small copy of
// the tree: the real script and the real stamp logic, a stand-in prerender
// bundle that reads GIT_SHA the way frontend/src/lib/asset-url.ts does, and no
// Vite. The runs that build, and --no-bundle (the test preflight's mode), are
// exercised further down with a stand-in for the Vite CLI that records each
// pass.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SHA = '0123456789abcdef0123456789abcdef01234567';

// The rendered tree ends in <script> tags whose URLs carry the build, so the
// stand-in does too. Padded past the script's "the tree looks empty" floor.
const PRERENDER = `
const id = /^[0-9a-f]{7,40}$/.test(String(process.env.GIT_SHA || '').trim().toLowerCase())
  ? String(process.env.GIT_SHA).trim().toLowerCase() : null;
const url = (p) => (id ? '/b/' + id + p : p);
const body = () => '<main id="app">' + 'x'.repeat(10000) + '</main><script src="' + url('/js/app.js') + '"></script>';
export const renderShell = body;
export const renderShellWithSeparators = body;
`;

const HEAD = [
  '  <meta charset="utf-8">',
  '  <link rel="manifest" href="/manifest.webmanifest">',
  '  <link rel="stylesheet" href="/css/app.css">',
  '  <script src="/vendor/marked.js"></script>',
  '',
].join('\n');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-document-step-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (rel, body) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };
  put('frontend/scripts/build-shell.mjs', fs.readFileSync(path.join(ROOT, 'frontend/scripts/build-shell.mjs')));
  put('scripts/shell-stamp.js', fs.readFileSync(path.join(ROOT, 'scripts/shell-stamp.js')));
  put('frontend/package.json', '{ "type": "module" }\n');
  put('frontend/src/head.html', HEAD);
  put('frontend/src/main.tsx', 'export {};\n');
  put('frontend/.ssr/prerender.js', PRERENDER);

  // What the first run leaves behind: the bundle, stamped for these sources.
  const stamp = require(path.join(root, 'scripts/shell-stamp.js'));
  const bundle = `${stamp.formatJsStamp(stamp.expectedStamp().stamp)}\nconsole.log('shell');\n`;
  put(stamp.JS_OUTPUT, bundle);

  const run = (args, gitSha) => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    if (gitSha === undefined) delete env.GIT_SHA; else env.GIT_SHA = gitSha;
    return spawnSync(process.execPath, [path.join(root, 'frontend/scripts/build-shell.mjs'), ...args], { cwd: root, env, encoding: 'utf8' });
  };
  const read = (rel) => {
    try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  };
  return { root, stamp, bundle, put, run, read, html: () => read(stamp.HTML_OUTPUT), js: () => read(stamp.JS_OUTPUT) };
}

test('--document writes the document for the commit id and leaves the bundle alone', (t) => {
  const f = fixture(t);
  const res = f.run(['--document'], SHA.toUpperCase());
  assert.equal(res.status, 0, res.stderr);

  const html = f.html();
  assert.equal(f.stamp.readBuildMeta(html), SHA, 'the id is narrowed and written to the meta');
  assert.equal(f.stamp.readHtmlStamp(html), f.stamp.expectedStamp().stamp, 'under the stamp of these sources');
  assert.ok(html.includes(`<link rel="stylesheet" href="/b/${SHA}/css/app.css">`), 'head stylesheets are scoped');
  assert.ok(html.includes(`<script src="/b/${SHA}/vendor/marked.js"></script>`), 'head scripts are scoped');
  assert.ok(html.includes(`<script type="module" src="/b/${SHA}/shell/assets/shell.js"></script>`), 'the entry is scoped');
  assert.ok(html.includes(`<script src="/b/${SHA}/js/app.js"></script></body>`), 'the tree was rendered again, under the id');
  assert.ok(html.includes('<link rel="manifest" href="/manifest.webmanifest">'), 'the manifest keeps its fixed URL');

  assert.equal(f.js(), f.bundle, 'the bundle is byte-for-byte what the first run wrote: not rebuilt, not stamped twice');
  assert.equal(f.read('frontend/.ssr/prerender.js'), null, 'the prerender bundle is removed once the document is final');
  assert.doesNotMatch(res.stdout, /pass 1\/2|pass 2\/2/, 'no Vite pass ran');
  // This tree has no scripts/language-packs.js: the first run built the packs,
  // and a --document run that reached for them again died here (#4302, #4332).
  assert.equal(fs.existsSync(path.join(f.root, 'public/locales')), false, 'the language packs are not built again');
});

test('--document refuses a bundle that was not built from these sources', (t) => {
  const f = fixture(t);
  f.put('frontend/src/main.tsx', 'export const changed = true;\n');
  const res = f.run(['--document'], SHA);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--document needs public\/shell\/assets\/shell\.js built from these sources \(it carries another stamp\)/);
  assert.match(res.stderr, /--bundle-only first/);
  assert.equal(f.html(), null, 'no document is written over a stale bundle');
});

test('--document refuses to run without the bundle or without the kept prerender', (t) => {
  const unstamped = fixture(t);
  unstamped.put(unstamped.stamp.JS_OUTPUT, "console.log('shell');\n");
  const first = unstamped.run(['--document'], SHA);
  assert.equal(first.status, 1);
  assert.match(first.stderr, /it is missing or unstamped/);

  const dropped = fixture(t);
  fs.rmSync(path.join(dropped.root, 'frontend/.ssr'), { recursive: true });
  const second = dropped.run(['--document'], SHA);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /--document needs frontend\/\.ssr\/prerender\.js\. Run this script with --prerender-only first/);
  assert.equal(dropped.html(), null);
});

test('an unknown argument stops the script before it builds anything', (t) => {
  // A misspelt --document would otherwise fall through to the full build: two
  // Vite passes under the commit id, a green image, and the reuse gone.
  const f = fixture(t);
  const res = f.run(['--documnet'], SHA);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /unknown argument --documnet/);
  assert.equal(f.html(), null);
  assert.equal(f.js(), f.bundle);
});

test('the script still runs both passes when no flag asks otherwise', () => {
  const script = fs.readFileSync(path.join(ROOT, 'frontend/scripts/build-shell.mjs'), 'utf8');
  // `npm run build:shell` and the runtime preflight call it bare.
  assert.match(script, /const MODES = \['--bundle-only', '--prerender-only', '--document', '--no-bundle'\];/);
  assert.match(script, /const documentOnly = modes\[0\] === '--document';/);
  assert.match(script, /const noBundle = modes\[0\] === '--no-bundle';/);
  assert.match(script, /if \(documentOnly\) \{[\s\S]+?\} else if \(noBundle\) \{[\s\S]+?\} else \{\n  buildBundle\(\);[\s\S]+?buildPrerender\(\);\n\}/,
    'pass 1 is skipped only for --document and --no-bundle, pass 2 only for --document');
  assert.match(script, /if \(bundleOnly\) \{[\s\S]+?process\.exit\(0\);\n\}\n\nif \(prerenderOnly\) \{[\s\S]+?process\.exit\(0\);\n\}\n\nif \(documentOnly\) \{/,
    'the two single-pass modes stop before the document; every other run reaches it');
  assert.match(script, /if \(!documentOnly\) require\(path\.join\(ROOT, 'scripts\/language-packs\.js'\)\)\.buildLanguagePacks\(ROOT\);/,
    'the language packs, an input of both bundles, are built by every run that builds one');
  assert.match(script, /\nfs\.rmSync\(ssrDir, \{ recursive: true, force: true \}\);\n/,
    'and every run that writes the document removes the prerender bundle after it');
  const ensure = fs.readFileSync(path.join(ROOT, 'scripts/ensure-shell-artifacts.js'), 'utf8');
  assert.match(ensure, /runNode\('frontend\/scripts\/build-shell\.mjs', htmlOnly \? \['--no-bundle'\] : \[\]\);/,
    'the runtime preflight runs the whole build; only the test preflight leaves the bundle out');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['build:shell'], 'node frontend/scripts/build-shell.mjs');
});

// ── --no-bundle ──────────────────────────────────────────────────────────
//
// The same small tree, plus what a run that builds needs: a Vite CLI, the
// language packs and, for the preflight, an installed frontend workspace.
// Each is a stand-in that leaves a trace of having run.
const VITE = `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync('vite-calls.log', args.join(' ') + '\\n');
if (args.includes('--config')) {
  fs.mkdirSync('.ssr', { recursive: true });
  fs.copyFileSync('prerender.stub.js', '.ssr/prerender.js');
} else {
  fs.mkdirSync('../public/shell/assets', { recursive: true });
  fs.writeFileSync('../public/shell/assets/shell.js', "console.log('rebuilt');\\n");
}
`;

const LANGUAGE_PACKS = `
const fs = require('node:fs');
const path = require('node:path');
exports.buildLanguagePacks = (root) => {
  const file = path.join(root, 'frontend/src/lib/i18n/catalogs.generated.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}');
};
`;

function buildable(t) {
  const f = fixture(t);
  fs.rmSync(path.join(f.root, 'frontend/.ssr'), { recursive: true });
  f.put('frontend/prerender.stub.js', PRERENDER);
  f.put('frontend/node_modules/vite/package.json', '{ "bin": { "vite": "cli.js" } }\n');
  f.put('frontend/node_modules/vite/cli.js', VITE);
  f.put('frontend/node_modules/react/package.json', '{}\n');
  f.put('frontend/package-lock.json', '{}\n');
  const lock = fs.readFileSync(path.join(f.root, 'frontend/package-lock.json'));
  f.put('frontend/node_modules/.usernode-shell-lock', `${crypto.createHash('sha256').update(lock).digest('hex')}\n`);
  // An input of the stamp, so the bundle the fixture wrote is now a stale one.
  f.put('scripts/language-packs.js', LANGUAGE_PACKS);
  f.put('scripts/ensure-shell-artifacts.js', fs.readFileSync(path.join(ROOT, 'scripts/ensure-shell-artifacts.js')));
  const ensure = (args) => {
    const env = { ...process.env };
    for (const name of ['NODE_TEST_CONTEXT', 'GIT_SHA', 'USERNODE_SHELL_ASSETS_PREBUILT']) delete env[name];
    return spawnSync(process.execPath, [path.join(f.root, 'scripts/ensure-shell-artifacts.js'), ...args], { cwd: f.root, env, encoding: 'utf8' });
  };
  const passes = () => (f.read('frontend/vite-calls.log') || '').split('\n').filter(Boolean)
    .map((line) => (line.includes('--config') ? 'prerender' : 'bundle'));
  const current = () => f.stamp.expectedStamp().stamp;
  return { ...f, ensure, passes, current };
}

test('--no-bundle runs the prerender pass alone and leaves the bundle on disk as it was', (t) => {
  const f = buildable(t);
  assert.notEqual(f.stamp.readJsStamp(f.bundle), f.current(), 'the bundle on disk is from older sources');

  const res = f.run(['--no-bundle'], undefined);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(f.passes(), ['prerender'], 'pass 1 did not run');
  assert.equal(f.stamp.readHtmlStamp(f.html()), f.current(), 'the document is stamped for these sources');
  assert.equal(f.stamp.readBuildMeta(f.html()), 'dev');
  assert.equal(f.js(), f.bundle, 'the bundle is not rebuilt, removed or given a stamp it has not earned');
  assert.notEqual(f.read('frontend/src/lib/i18n/catalogs.generated.json'), null, 'the language catalog the tests import is still built');
  assert.equal(f.read('frontend/.ssr/prerender.js'), null, 'the prerender bundle is removed as after a full build');

  // With no bundle at all it writes the document and still makes none.
  const bare = buildable(t);
  fs.rmSync(path.join(bare.root, bare.stamp.JS_OUTPUT));
  assert.equal(bare.run(['--no-bundle'], undefined).status, 0);
  assert.equal(bare.stamp.readHtmlStamp(bare.html()), bare.current());
  assert.equal(bare.js(), null);
});

test('--no-bundle and --document cannot be combined', (t) => {
  const f = buildable(t);
  const res = f.run(['--document', '--no-bundle'], SHA);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--document and --no-bundle cannot be combined/);
  assert.deepEqual(f.passes(), []);
  assert.equal(f.html(), null);
});

test('--bundle-only runs pass 1 alone and stamps the bundle, with no document', (t) => {
  const f = buildable(t);
  const res = f.run(['--bundle-only'], SHA);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(f.passes(), ['bundle'], 'pass 2 did not run');
  assert.equal(f.stamp.readJsStamp(f.js()), f.current(), 'the bundle is stamped for these sources');
  assert.match(f.js(), /rebuilt/);
  assert.equal(f.html(), null, 'no document: this run has no say in it');
  assert.equal(f.read('frontend/.ssr/prerender.js'), null);
  assert.notEqual(f.read('frontend/src/lib/i18n/catalogs.generated.json'), null, 'the language packs the bundle imports are built');
});

test('--prerender-only runs pass 2 alone and keeps its bundle, with no document', (t) => {
  const f = buildable(t);
  const res = f.run(['--prerender-only'], SHA);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(f.passes(), ['prerender'], 'pass 1 did not run');
  assert.notEqual(f.read('frontend/.ssr/prerender.js'), null, 'the prerender bundle is kept for --document');
  assert.equal(f.html(), null);
  assert.equal(f.js(), f.bundle, 'the browser bundle is left as it was');
  assert.notEqual(f.read('frontend/src/lib/i18n/catalogs.generated.json'), null, 'the language packs the prerender imports are built');
});

test('the image order: both passes on their own, then --document under the commit id', (t) => {
  // In the image the two passes run in separate stages over the same sources
  // and their outputs are copied into one; on one tree the order of the two
  // runs does not matter, so run them the other way round from the image.
  const f = buildable(t);
  assert.equal(f.run(['--prerender-only'], undefined).status, 0);
  assert.equal(f.run(['--bundle-only'], undefined).status, 0);
  const bundle = f.js();
  const res = f.run(['--document'], SHA);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(f.passes(), ['prerender', 'bundle'], 'the document run started no Vite pass');
  assert.equal(f.stamp.readBuildMeta(f.html()), SHA);
  assert.equal(f.stamp.readHtmlStamp(f.html()), f.current());
  assert.equal(f.js(), bundle, 'the bundle is the one --bundle-only stamped');
  assert.equal(f.read('frontend/.ssr/prerender.js'), null, 'the prerender bundle is removed once the document is final');
});

test('two modes cannot be combined', (t) => {
  const f = buildable(t);
  for (const pair of [['--bundle-only', '--prerender-only'], ['--bundle-only', '--document'], ['--prerender-only', '--no-bundle']]) {
    const res = f.run(pair, SHA);
    assert.equal(res.status, 1, pair.join(' '));
    assert.match(res.stderr, new RegExp(`${pair[0]} and ${pair[1]} cannot be combined`));
  }
  assert.deepEqual(f.passes(), []);
  assert.equal(f.html(), null);
});

test('the test preflight builds the document without the bundle, and the runtime check still rebuilds that bundle', (t) => {
  const f = buildable(t);
  const first = f.ensure(['--html-only']);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(f.passes(), ['prerender']);
  assert.equal(f.stamp.readHtmlStamp(f.html()), f.current());
  assert.equal(f.js(), f.bundle);

  const again = f.ensure(['--html-only']);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /HTML is current/);
  assert.deepEqual(f.passes(), ['prerender'], 'a current document is not built twice');

  // Without --html-only the freshness check reads the bundle's own stamp, as
  // --runtime does (that flag adds the Tailwind and release steps after it).
  // A current document beside the stale bundle is therefore not "current".
  const full = f.ensure([]);
  assert.equal(full.status, 0, full.stderr);
  assert.deepEqual(f.passes(), ['prerender', 'bundle', 'prerender']);
  assert.equal(f.stamp.readJsStamp(f.js()), f.current(), 'the bundle is rebuilt and stamped for these sources');
});
