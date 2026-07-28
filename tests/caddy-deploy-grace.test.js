'use strict';

// Pins the deploy-grace configuration that eliminates the 502 window
// during platform deploys (#711). These are text-pinning tests (same
// pattern as tests/pwa-shell-wiring.test.js): the Caddyfile is config,
// not code, so the strongest cheap guard is asserting the load-bearing
// directives are present in the right blocks — and ABSENT from the one
// block that must fail fast (the app-container proxy). If any of these
// fail, a deploy goes back to 502ing every request for the duration of
// the platform restart.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const caddyfile = fs.readFileSync(path.join(root, 'Caddyfile'), 'utf8');

// Slice the Caddyfile into its site blocks by line-anchored markers.
// Site addresses start at column 0; the same strings inside comments
// are prefixed with "# " so they never match.
function sliceBetween(src, startMarker, endMarker, label) {
  const start = src.indexOf(startMarker);
  assert.notStrictEqual(start, -1, `${label}: start marker not found: ${startMarker}`);
  const end = endMarker ? src.indexOf(endMarker, start + startMarker.length) : src.length;
  assert.notStrictEqual(end, -1, `${label}: end marker not found: ${endMarker}`);
  return src.slice(start, end);
}

const apexSite = sliceBetween(
  caddyfile, '\n{$USERNODE_DOMAIN} {', '\n*.{$USERNODE_DOMAIN} {', 'apex site'
);
const wildcardSite = sliceBetween(
  caddyfile, '\n*.{$USERNODE_DOMAIN} {', '\n:8999 {', 'wildcard site'
);

test('apex platform proxy holds and retries across restarts', () => {
  const proxy = sliceBetween(
    apexSite, 'reverse_proxy usernode:3000 {', 'encode gzip', 'apex proxy'
  );
  assert.match(proxy, /lb_try_duration 30s/, 'apex proxy must hold requests across the restart window');
  assert.match(proxy, /lb_try_interval 250ms/, 'apex proxy must re-dial frequently within the hold');
  assert.match(proxy, /dial_timeout 2s/, 'apex proxy must fail dials fast so retries re-resolve DNS');
});

test('wildcard forward_auth gate holds and retries across restarts', () => {
  const gate = sliceBetween(
    wildcardSite, 'forward_auth usernode:3000 {', 'reverse_proxy {upstream}:3000', 'forward_auth'
  );
  assert.match(gate, /lb_try_duration 30s/, 'app-subdomain gate must not 502 during platform restarts');
  assert.match(gate, /lb_try_interval 250ms/);
  assert.match(gate, /dial_timeout 2s/);
});

test('app-container proxy stays fail-fast (no retry hold)', () => {
  const appProxy = sliceBetween(
    wildcardSite, 'reverse_proxy {upstream}:3000 {', 'encode gzip', 'app proxy'
  );
  assert.doesNotMatch(appProxy, /lb_try_duration/,
    'a dead APP must drop into /__app_unavailable immediately, not stall in a retry hold');
  assert.match(appProxy, /dial_timeout 2s/, 'dead app containers should fail dials fast');
});

test('wildcard error handler falls back to the static updating page when the platform is down', () => {
  const errHandler = sliceBetween(
    wildcardSite, 'handle_errors {', '\n}', 'wildcard handle_errors'
  );
  assert.match(errHandler, /rewrite \* \/__app_unavailable/);
  assert.match(errHandler, /reverse_proxy usernode:3000 127\.0\.0\.1:8999 \{/,
    'error-page proxy must carry the :8999 static fallback upstream');
  assert.match(errHandler, /lb_policy first/,
    'platform-rendered page must stay authoritative whenever the platform is up');
  assert.match(errHandler, /fail_duration 10s/,
    'without passive-health memory, lb_policy first never reaches the fallback upstream');
});

test('apex error handler serves the updating page to document navigations', () => {
  const errHandler = sliceBetween(apexSite, 'handle_errors {', '\n}', 'apex handle_errors');
  assert.match(errHandler, /\{err\.status_code\} in \[502, 503, 504\]/,
    'updating page is scoped to the upstream-down status family');
  assert.match(errHandler, /header Sec-Fetch-Dest document/,
    'only top-level document navigations get the HTML page; fetches keep real status codes');
  assert.match(errHandler, /import updating_page/);
  assert.match(errHandler, /respond "\{err\.status_code\} \{err\.status_text\}"/,
    'non-document / non-5xx errors must keep the terse status text');
});

test('updating page snippet self-refreshes and is cache-safe', () => {
  const snippet = sliceBetween(caddyfile, '\n(updating_page) {', '\n}', 'updating_page snippet');
  assert.match(snippet, /respond <<HTML/, 'page body is an inline heredoc (no bind mount needed)');
  assert.match(snippet, /fetch\('\/health'/, 'page must poll /health to reconnect automatically');
  assert.match(snippet, /location\.reload\(\)/);
  assert.match(snippet, /header Retry-After 5/);
  assert.match(snippet, /header Cache-Control "no-store"/,
    'the 503 page must never stick in a browser or service-worker cache');
  assert.match(caddyfile, /\n:8999 \{\n\timport updating_page\n\}/,
    'the :8999 fallback vhost must serve the same page');
  // Heredoc integrity: the closing marker must terminate with status 503.
  assert.match(caddyfile, /\n\s*HTML 503\n/,
    'heredoc must close with the 503 status');
});

test('drain budget stays inside the compose stop_grace_period', () => {
  const serverJs = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const drainMatch = serverJs.match(/const DRAIN_TIMEOUT_MS = (\d+);/);
  assert.ok(drainMatch, 'DRAIN_TIMEOUT_MS constant not found in server.js');
  const drainMs = Number(drainMatch[1]);

  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  const graceMatch = compose.match(/stop_grace_period:\s*(\d+)s/);
  assert.ok(graceMatch, 'stop_grace_period not found in docker-compose.yml (usernode service)');
  const graceMs = Number(graceMatch[1]) * 1000;

  assert.ok(drainMs < graceMs,
    `DRAIN_TIMEOUT_MS (${drainMs}ms) must stay below stop_grace_period (${graceMs}ms) ` +
    'or the drain gets SIGKILLed mid-flush');
  assert.ok(drainMs >= 1000, 'drain must still give in-flight handlers a real window to flush');

  // #767: closing the pg pool now happens AFTER the handler drain, inside
  // the same grace. Both budgets have to fit or the pool close is what gets
  // SIGKILLed — severing in-flight queries, the exact thing it was added to
  // prevent.
  const poolMatch = serverJs.match(/const POOL_CLOSE_TIMEOUT_MS = (\d+);/);
  assert.ok(poolMatch, 'POOL_CLOSE_TIMEOUT_MS constant not found in server.js');
  const poolMs = Number(poolMatch[1]);
  assert.ok(drainMs + poolMs < graceMs,
    `DRAIN_TIMEOUT_MS + POOL_CLOSE_TIMEOUT_MS (${drainMs + poolMs}ms) must stay below ` +
    `stop_grace_period (${graceMs}ms)`);
});

// #767: the app-container stop grace is a separate budget from the
// platform's own. It must sit ABOVE the drain deadline the app conventions
// prescribe, or a correctly-draining app gets SIGKILLed mid-drain — the
// ugly failure mode that makes the whole graceful-shutdown change
// pointless for the apps that actually adopted it.
test('app stop grace stays above the drain deadline the conventions prescribe', () => {
  const dockerJs = fs.readFileSync(path.join(root, 'src', 'services', 'docker.js'), 'utf8');
  const graceMatch = dockerJs.match(/DOCKER_STOP_GRACE_SEC \|\| '(\d+)'/);
  assert.ok(graceMatch, 'STOP_GRACE_SEC default not found in src/services/docker.js');
  const graceMs = Number(graceMatch[1]) * 1000;

  const conventions = fs.readFileSync(
    path.join(root, 'src', 'prompts', 'app-conventions.md'), 'utf8'
  );
  const drainMatch = conventions.match(/const DRAIN_MS = (\d+);/);
  assert.ok(drainMatch, 'DRAIN_MS not found in the app-conventions shutdown example');
  const drainMs = Number(drainMatch[1]);

  assert.ok(drainMs < graceMs,
    `the app drain deadline (${drainMs}ms) must stay below the platform's stop grace ` +
    `(${graceMs}ms) or a draining app is force-killed`);
});

test('deploy workflow no longer rebuilds caddy on routine deploys', () => {
  const deploy = fs.readFileSync(
    path.join(root, '.github', 'workflows', 'deploy.yml'), 'utf8'
  );
  // The build and the recreate are two commands rather than one
  // `up -d --build usernode`: the platform-env materializer has to run
  // off the freshly built image, before the long-running container is
  // recreated with the resolved .env. Both halves stay scoped to
  // `usernode`, which is the property #711 actually cares about.
  assert.match(deploy, /^\s*docker compose build usernode\s*$/m,
    'the routine build must name the platform service, not the whole stack');
  assert.match(deploy, /^\s*docker compose up -d usernode\s*$/m,
    'final up must scope the recreate to the platform service');
  assert.doesNotMatch(deploy, /^\s*docker compose build\s*$/m,
    'an unscoped `build` rebuilds the caddy image on every deploy');
  assert.doesNotMatch(deploy, /^\s*docker compose up -d --build( --remove-orphans)?\s*$/m,
    'the old unscoped `up -d --build` rebuilt the caddy image on every deploy');
  assert.match(deploy, /^\s*docker compose up -d --remove-orphans\s*$/m,
    'the unscoped no-build up must still ensure the rest of the stack is running');
  assert.match(deploy, /CADDY_FILES_CHANGED/,
    'caddy rebuilds must be gated on the caddy paths-filter');
  assert.match(deploy, /caddy:\n\s+- 'caddy\.Dockerfile'/,
    'paths-filter must watch caddy.Dockerfile');
});
