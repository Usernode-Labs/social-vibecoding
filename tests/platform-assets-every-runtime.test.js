'use strict';

// The other two runtimes that have to answer the same three relative paths.
//
// tests/platform-assets-on-app-origin.test.js covers Kubernetes, where a
// per-app Ingress rule routes them. This file covers the two places that
// rule does not reach: the docker runtime, which routes every app through
// the static Caddyfile, and a plain `node server.js`, which has no edge in
// front of it at all. An app can only drop the platform's hostname from its
// markup once ALL of them answer — otherwise "use a relative path" is
// advice that silently breaks a self-hosted fork or local development.
//
// CI has no caddy binary, so the Caddyfile assertions are structural. The
// adapted-config ordering was verified with caddy v2.8.4 while writing this:
// the asset route resolves ahead of the gate, and the gate carries the
// complementary matcher, so an asset request never reaches it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { getTemplateFiles } = require('../src/services/template');
const { PLATFORM_ASSET_PREFIXES } = require('../src/services/kubernetes');

const root = path.join(__dirname, '..');
const CADDYFILE = fs.readFileSync(path.join(root, 'Caddyfile'), 'utf8');
const scaffold = () => getTemplateFiles('Demo App', 'demo-app-abc123', 'postgres://x');
const scaffoldServer = () => scaffold().find((f) => f.path === 'server.js').content;

// The Caddyfile spells the prefixes as path globs; kubernetes.js spells them
// as Ingress prefixes. Same three, one source of truth for the test.
const GLOBS = PLATFORM_ASSET_PREFIXES.map((p) => `${p}*`);

test('the docker runtime serves the asset prefixes on the app hostname', () => {
  const site = CADDYFILE.slice(CADDYFILE.indexOf('*.{$USERNODE_DOMAIN} {'));
  assert.ok(site.includes(`@platform_assets path ${GLOBS.join(' ')}`),
    'the wildcard app site matches exactly the prefixes Kubernetes routes');
  assert.match(site, /handle @platform_assets \{\s*\n\s*import platform_upstream\n\s*\}/,
    'assets go to the platform, via the blue/green snippet the apex uses');
});

test('assets bypass the per-app visibility gate', () => {
  // The gate answers a non-2xx with a 404 or an authorize redirect. An HTML
  // redirect body arriving where a <script> was expected is the same class
  // of breakage this whole line of work exists to end, and it is why
  // middleware/auth.js serves these three prefixes anonymously from any
  // app origin. `handle` blocks are mutually exclusive, so wrapping the
  // gate in the complementary matcher is what enforces that.
  const site = CADDYFILE.slice(CADDYFILE.indexOf('*.{$USERNODE_DOMAIN} {'));
  assert.ok(site.includes(`@not_platform_assets not path ${GLOBS.join(' ')}`),
    'the complementary matcher covers exactly the same three prefixes');
  assert.match(site, /handle @not_platform_assets \{\s*\n\s*import platform_gate\n\s*\}/,
    'the gate runs only for non-asset requests');
  // And the gate is not ALSO imported bare, which would reinstate it for
  // asset requests and undo the whole point.
  assert.equal((site.match(/^\t*import platform_gate$/gm) || []).length, 1);
});

test('a scaffolded app answers the same paths with no edge in front of it', () => {
  const server = scaffoldServer();
  assert.match(server, /app\.get\(\/\^\\\/usernode-\(\?:bridge\|native\|tailwind\)\\\/\//,
    'the generated source carries a real regex, not a mangled one');
  assert.match(server, /USERNODE_PLATFORM_ORIGIN/,
    'the origin comes from the platform-injected env var, never a literal');
});

test('a scaffolded app prefers the INJECTED origin over the one baked in', () => {
  // The scaffold does still write a platform origin into the app, as a
  // fallback for a container that was handed no env var. What matters is
  // which one wins: the injected value is read first, so the app follows
  // the platform when its domain moves instead of pointing at wherever it
  // was the day the app was created. That ordering is the whole fix — a
  // baked-in origin that took precedence is what broke the fleet before.
  const server = scaffoldServer();
  const line = server.match(/const PLATFORM_ORIGIN = .*/)[0];
  assert.match(line, /process\.env\.USERNODE_PLATFORM_ORIGIN \|\|/,
    'the injected origin is read first and the literal is only the fallback');

  // And the platform LINKS follow that constant rather than embedding a
  // hostname of their own — they are the case a relative path cannot serve,
  // because the platform is genuinely a different origin from the app.
  assert.match(server, /res\.redirect\(302, PLATFORM_ORIGIN \+/);
  assert.match(server, /<a href="\$\{PLATFORM_ORIGIN\}/);
  const hosts = server.match(/https:\/\/[a-z0-9.-]+/g) || [];
  assert.equal(hosts.length, 1, `exactly one origin literal, as the fallback: ${hosts}`);
});

test('the scaffolded asset route is public — it precedes the auth middleware', () => {
  // Registered after the auth middleware it would 401 a <script> tag, which
  // is the failure a relative path is supposed to remove.
  const server = scaffoldServer();
  const route = server.indexOf('usernode-(?:bridge|native|tailwind)');
  const auth = server.search(/Verify platform-issued JWT/);
  assert.ok(route > 0 && auth > 0, 'both are present');
  assert.ok(route < auth, 'the asset route is registered before auth');
});

test('the generated server.js is syntactically valid', () => {
  // The handler lives inside a template literal in template.js, so every
  // backslash in that regex has to be doubled. Get it wrong and the scaffold
  // ships an app that will not boot — this is the test that catches it.
  const server = scaffoldServer();
  assert.doesNotThrow(() => new vm.Script(server, { filename: 'server.js' }));
});

test('the generated regex matches the three prefixes and nothing else', () => {
  const server = scaffoldServer();
  const source = server.match(/app\.get\((\/\^[^,]+\/),/)[1];
  // eslint-disable-next-line no-new-func
  const re = vm.runInNewContext(source);
  for (const prefix of PLATFORM_ASSET_PREFIXES) {
    assert.ok(re.test(`${prefix}v1/thing.js`), `${prefix} is proxied`);
  }
  for (const other of ['/api/todos', '/', '/index.html', '/usernode-other/v1/x.js']) {
    assert.ok(!re.test(other), `${other} is left to the app`);
  }
});
