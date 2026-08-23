// Every name the platform hands to a resolver fits in a DNS label (#1381).
//
// 63 bytes is the hard ceiling on a single DNS label, and it is not a soft
// one: Chrome's resolver, Go's `isDomainName` (which is what Caddy uses to
// validate an upstream) and glibc's ns_name_pton all refuse to emit a query
// for a longer label. So an over-long name does not fail slowly or
// intermittently — it fails identically every time, with
// ERR_NAME_NOT_RESOLVED, before a byte of the app runs.
//
// The platform derives several names from an app slug, and only some of them
// are bounded:
//
//   usernode-app-<slug>                     production container name
//   usernode-staging-<slug>--<sessionId>    staging container name  ← unbounded
//   <slug>--s<sessionId>.<domain>           staging preview host label
//
// The middle one cannot be made to fit for every app (the slug and the
// session id both have to be in it, and it is parsed back apart by
// staging-reap), so it is no longer resolved at all: containers carry a short
// network alias, and that is what the browser and the proxy are given.
//
// This test pins the whole budget end to end — the alias, the origins built
// from it, the upstream Caddy derives from a request host, and the slug cap
// that keeps the two BOUNDED names inside the ceiling in the first place.
//
// Run with: node --test tests/dns-label-limits.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const applicationRuntime = require('../src/services/application-runtime');
const appManifest = require('../src/services/app-manifest');

const MAX_LABEL = 63;

// The production case, exactly as it stands in the database today.
const WQ_SLUG = 'workquest-escape-from-the-underclass-831ec5';
const WQ_SESSION = 3539;
const WQ_STAGING = `usernode-staging-${WQ_SLUG}--${WQ_SESSION}`;
const WQ_PROD = `usernode-app-${WQ_SLUG}`;

// The worst case the OLD slug rule allowed: a 64-character app name (the
// rename flow's own cap) with a 6-hex suffix — 71 bytes of slug.
const WORST_NAME = 'W'.repeat(appManifest.MAX_APP_NAME_LENGTH);

test('the fixtures really do bust the ceiling — otherwise this file proves nothing', () => {
  assert.equal(WQ_STAGING.length, 66);
  assert.ok(WQ_STAGING.length > MAX_LABEL);
  assert.ok(WQ_PROD.length <= MAX_LABEL, 'the prod name fit, which is why prod loaded and staging did not');
});

// ── The alias the deploy registers ─────────────────────────────────────

test('every staging session gets a short alias, whatever the slug', () => {
  for (const sessionId of [1, 3539, 9999999]) {
    const alias = applicationRuntime.dnsAlias({ environment: 'staging', sessionId });
    assert.equal(alias, `usernode-staging-s${sessionId}`);
    assert.ok(alias.length <= MAX_LABEL);
    // No slug in it at all — that is what makes it derivable by a proxy that
    // only ever sees the request host, and safe for an app of any name.
    assert.equal(alias.includes(WQ_SLUG), false);
  }
});

test('the staging alias is unconditional, the production alias is not', () => {
  // Staging: same shape for a long name and a short one.
  assert.equal(
    applicationRuntime.dnsAlias({ environment: 'staging', sessionId: 42, dockerName: 'usernode-staging-tiny--42' }),
    'usernode-staging-s42'
  );
  // Production: `usernode-app-<slug>` is the name operators, `docker logs`
  // and the Caddyfile all use, and it already resolves whenever it fits.
  assert.equal(applicationRuntime.dnsAlias({ environment: 'production', dockerName: WQ_PROD }), null);
  const longProd = `usernode-app-${'z'.repeat(60)}`;
  const alias = applicationRuntime.dnsAlias({ environment: 'production', dockerName: longProd });
  assert.ok(alias && alias.length <= MAX_LABEL);
});

// ── The origins the capture browser is pointed at ──────────────────────

test('the capture origin for an over-long container name is the alias', () => {
  const { dnsHostname } = require('../src/services/visuals');
  const alias = applicationRuntime.dnsAlias({ environment: 'staging', sessionId: WQ_SESSION });
  // Even when the alias could not be confirmed: for a name this long there
  // is no working fallback to prefer, so report honestly rather than aim at
  // a name that provably cannot resolve.
  assert.equal(dnsHostname(WQ_STAGING, alias, { aliasConfirmed: false }), alias);
  assert.equal(dnsHostname(WQ_STAGING, alias, { aliasConfirmed: true }), alias);
  assert.ok(dnsHostname(WQ_STAGING, alias, { aliasConfirmed: true }).length <= MAX_LABEL);
});

test('a name that already resolves is only swapped for a CONFIRMED alias', () => {
  const { dnsHostname } = require('../src/services/visuals');
  const short = 'usernode-staging-tiny--42';
  assert.equal(dnsHostname(short, 'usernode-staging-s42', { aliasConfirmed: true }), 'usernode-staging-s42');
  // The unconfirmed case is the whole reason this is not a blind swap: an
  // alias we failed to attach is strictly worse than a name that works.
  assert.equal(dnsHostname(short, 'usernode-staging-s42', { aliasConfirmed: false }), short);
  assert.equal(dnsHostname(short, null), short);
});

// ── The upstream Caddy derives from a request host ─────────────────────

function caddyfile() {
  return fs.readFileSync(path.join(__dirname, '..', 'Caddyfile'), 'utf8');
}

// Re-implement the map row the way Caddy evaluates it: find the row, read its
// regex and its {upstream} template, and expand ${n} from the match.
function mapUpstream(host) {
  const block = caddyfile().match(/map \{host\} \{upstream\} \{applink\} \{([\s\S]*?)\n\t\}/);
  assert.ok(block, 'the wildcard site must still route by a {host} -> {upstream} map');
  for (const line of block[1].split('\n').map((l) => l.trim()).filter(Boolean)) {
    if (line.startsWith('default ')) return line.split(/\s+/)[1];
    const m = line.match(/^~(\S+)\s+(\S+)/);
    if (!m) continue;
    const hit = new RegExp(m[1]).exec(host);
    if (hit) return m[2].replace(/\$\{(\d+)\}/g, (_, n) => hit[Number(n)]);
  }
  return null;
}

test('Caddy resolves a preview host to the short alias, not the long container name', () => {
  const upstream = mapUpstream(`${WQ_SLUG}--s${WQ_SESSION}.usernode.test`);
  assert.equal(upstream, `usernode-staging-s${WQ_SESSION}`);
  assert.ok(upstream.length <= MAX_LABEL,
    'Go rejects an over-long label outright, so this row 502s the preview if it busts');
  // The legacy `--<commitHash>` suffix keeps routing to the same container.
  assert.equal(mapUpstream(`${WQ_SLUG}--s${WQ_SESSION}--abc123.usernode.test`),
    `usernode-staging-s${WQ_SESSION}`);
});

test('production hosts are untouched by the staging flip', () => {
  // A production app is still reached by its container NAME — that row is
  // load-bearing for operators and for the {applink} chromeless redirect,
  // and `usernode-app-<slug>` fits for every slug the cap below allows.
  assert.equal(mapUpstream(`${WQ_SLUG}.usernode.test`), WQ_PROD);
  assert.equal(mapUpstream('my-cool-app-460fe8.usernode.test'), 'usernode-app-my-cool-app-460fe8');
  // A host matching nothing falls through to the platform itself. (The apex
  // is served by its own site block, not by this map.)
  assert.match(caddyfile(), /\n\t\tdefault usernode ""/);
});

// ── The slug cap that keeps the bounded names bounded ──────────────────

test('a maximum-length app name yields a slug that still fits every derived label', () => {
  const slug = appManifest.buildAppSlug(WORST_NAME, 'abc123');
  assert.ok(slug.length <= appManifest.MAX_APP_SLUG_LENGTH, `slug was ${slug.length} bytes`);
  assert.ok(slug.endsWith('-abc123'), 'the uniqueness suffix is never what gets cut');
  assert.equal(/-$/.test(slug.slice(0, -7)), false, 'no hyphen left dangling at the cut');
  assert.ok(`usernode-app-${slug}`.length <= MAX_LABEL);
  assert.ok(`${slug}--s9999999`.length <= MAX_LABEL);
});

test('buildAppSlug leaves a name that already fits completely alone', () => {
  assert.equal(appManifest.buildAppSlug('My Cool App', '460fe8'), 'my-cool-app-460fe8');
  assert.equal(appManifest.buildAppSlug('  Trailing punctuation!!  ', 'ff00aa'),
    'trailing-punctuation-ff00aa');
  assert.equal(appManifest.buildAppSlug('!!!', 'ff00aa'), null, 'no alphanumerics is not a slug');
});

test('a truncation that lands mid-hyphen does not leave a trailing hyphen', () => {
  // 43 characters of base is the budget; force the 43rd to be a hyphen.
  const name = `${'a'.repeat(42)} tail`;
  const slug = appManifest.buildAppSlug(name, 'abc123');
  assert.equal(slug, `${'a'.repeat(42)}-abc123`);
  assert.ok(slug.length <= appManifest.MAX_APP_SLUG_LENGTH);
});
