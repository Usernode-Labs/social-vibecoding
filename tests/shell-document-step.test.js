'use strict';

// frontend/scripts/build-shell.mjs --keep-prerender and --document.
//
// Dockerfile.kubernetes builds the shell in two runs. The first has no commit
// id: both Vite passes, a `dev` document for Tailwind to scan, and the
// prerender bundle left in place. The second runs after GIT_SHA is declared
// and writes only the document. The split is what lets BuildKit reuse the
// Vite and Tailwind steps for a commit that left their inputs alone
// (tests/kubernetes-deployment-contract.test.js pins the order).
//
// The second run is what these tests exercise, on a small copy of the tree:
// the real script and the real stamp logic, a stand-in prerender bundle that
// reads GIT_SHA the way frontend/src/lib/asset-url.ts does, and no Vite. The
// first run needs the frontend workspace and is what every image build and
// `npm run ensure:shell` already run for real.
//
// --no-bundle, the test preflight's mode, is exercised the same way at the
// end of this file, with a stand-in for the Vite CLI that records each pass.

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

test('the dev document and the commit document differ by the id and nothing else', (t) => {
  const f = fixture(t);
  assert.equal(f.run(['--document', '--keep-prerender'], undefined).status, 0);
  const dev = f.html();
  assert.equal(f.stamp.readBuildMeta(dev), 'dev');
  assert.ok(!dev.includes('/b/'), 'a dev document keeps the plain paths');
  assert.notEqual(f.read('frontend/.ssr/prerender.js'), null, '--keep-prerender leaves the bundle for the next run');

  assert.equal(f.run(['--document'], SHA).status, 0);
  const built = f.html();
  assert.equal(
    built.split(`/b/${SHA}`).join('').replace(f.stamp.formatBuildMeta(SHA), f.stamp.formatBuildMeta('dev')),
    dev,
    'take the id out of the commit document and it is the document Tailwind was given',
  );
});

test('--document refuses a bundle that was not built from these sources', (t) => {
  const f = fixture(t);
  f.put('frontend/src/main.tsx', 'export const changed = true;\n');
  const res = f.run(['--document'], SHA);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--document needs public\/shell\/assets\/shell\.js built from these sources \(it carries another stamp\)/);
  assert.match(res.stderr, /--keep-prerender first/);
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
  assert.match(second.stderr, /--document needs frontend\/\.ssr\/prerender\.js/);
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
  assert.match(script, /const documentOnly = process\.argv\.includes\('--document'\);/);
  assert.match(script, /const noBundle = process\.argv\.includes\('--no-bundle'\);/);
  assert.match(script, /if \(documentOnly\) \{[\s\S]+?\} else if \(noBundle\) \{[\s\S]+?\} else \{[\s\S]+?runVite\(\['build'\]\);[\s\S]+?buildPrerender\(\);\n\}/,
    'pass 1 is skipped only for --document and --no-bundle, pass 2 only for --document');
  assert.match(script, /if \(!documentOnly\) require\(path\.join\(ROOT, 'scripts\/language-packs\.js'\)\)\.buildLanguagePacks\(ROOT\);/,
    'the language packs, an input of the bundle, are built by every run that builds it');
  assert.match(script, /if \(!keepPrerender\) fs\.rmSync\(ssrDir, \{ recursive: true, force: true \}\);/,
    'and the prerender bundle is still removed unless a later run was asked to reuse it');
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
