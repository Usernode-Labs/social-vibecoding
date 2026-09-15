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

// Blue-green: the apex proxy and the access gate live in snippets defined
// by the active-color file (rewritten by scripts/platform-rollout.sh on
// every flip). The hold-and-retry directives (#711) therefore get pinned
// in BOTH copies of that snippet content: the committed bootstrap file and
// the rollout script's write_active() heredoc.
const activeFile = fs.readFileSync(
  path.join(root, 'caddy', 'active', 'platform-upstream.caddy'), 'utf8'
);
const rolloutSh = fs.readFileSync(
  path.join(root, 'scripts', 'platform-rollout.sh'), 'utf8'
);

test('apex site + gate import the blue-green active-color snippets', () => {
  assert.match(caddyfile, /^import \/etc\/caddy\/active\/platform-upstream\.caddy$/m,
    'Caddyfile must import the rollout-managed active-color file');
  assert.match(apexSite, /^\timport platform_upstream$/m,
    'apex site must proxy via the active-color snippet');
  // Nested one level: the gate now sits inside `handle @not_platform_assets`
  // so that the three centrally hosted asset prefixes bypass it (a gate
  // redirect returns HTML where a <script> was expected). Still exactly one
  // import, still the active-color snippet.
  assert.match(wildcardSite, /^\t+import platform_gate$/m,
    'wildcard gate must forward_auth via the active-color snippet');
  assert.equal((wildcardSite.match(/^\t+import platform_gate$/gm) || []).length, 1,
    'and only once — a second, unmatched import would reinstate the gate for assets');
  assert.doesNotMatch(apexSite, /reverse_proxy usernode:3000/,
    'apex must not pin a single-container upstream any more');
  assert.doesNotMatch(wildcardSite, /forward_auth usernode:3000/,
    'gate must not pin a single-container upstream any more');
});

for (const [label, src] of [
  ['committed bootstrap file', activeFile],
  ['platform-rollout.sh write_active()', rolloutSh],
]) {
  test(`apex platform proxy holds and retries across restarts (${label})`, () => {
    const proxy = sliceBetween(
      src, 'reverse_proxy usernode-', '(platform_gate)', `apex proxy (${label})`
    );
    assert.match(proxy, /lb_try_duration 30s/, 'apex proxy must hold requests across the restart window');
    assert.match(proxy, /lb_try_interval 250ms/, 'apex proxy must re-dial frequently within the hold');
    assert.match(proxy, /dial_timeout 2s/, 'apex proxy must fail dials fast so retries re-resolve DNS');
  });

  test(`wildcard forward_auth gate holds and retries across restarts (${label})`, () => {
    const gate = sliceBetween(
      src, 'forward_auth usernode-', null, `forward_auth (${label})`
    );
    assert.match(gate, /uri \/__caddy\/access/, 'gate snippet must target the access route');
    assert.match(gate, /lb_try_duration 30s/, 'app-subdomain gate must not 502 during platform restarts');
    assert.match(gate, /lb_try_interval 250ms/);
    assert.match(gate, /dial_timeout 2s/);
  });
}

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

test('the deploy no longer rebuilds caddy on routine deploys', () => {
  // The remote deploy logic lives in scripts/deploy.sh (shared by the
  // Deploy workflow and the host deployer), so the compose-command pins
  // point there; the paths-filter that feeds CADDY_FILES_CHANGED is
  // still the workflow's.
  const deploy = fs.readFileSync(path.join(root, 'scripts', 'deploy.sh'), 'utf8');
  const workflow = fs.readFileSync(
    path.join(root, '.github', 'workflows', 'deploy.yml'), 'utf8'
  );
  // The build and the recreate are two commands rather than one
  // `up -d --build`: the platform-env materializer has to run off the
  // freshly built image, before any color is recreated with the resolved
  // .env. Everything stays scoped to named services — under blue-green an
  // unscoped `up` is doubly wrong (it would also start BOTH colors).
  assert.match(deploy, /^\s*docker compose build usernode-blue\s*$/m,
    'the routine build must name a platform color (shared image tag), not the whole stack');
  assert.match(deploy, /^\s*docker compose up -d usernode-db usernode-node usernode-minio acme-dns caddy\s*$/m,
    'infra up must list services explicitly — never the platform colors');
  assert.match(deploy, /platform-rollout\.sh(?!.*--ensure-active-file)/m,
    'the platform cutover must go through the blue-green rollout script');
  assert.doesNotMatch(deploy, /^\s*docker compose build\s*$/m,
    'an unscoped `build` rebuilds the caddy image on every deploy');
  assert.doesNotMatch(deploy, /^\s*docker compose up -d( --build)?( --remove-orphans)?\s*$/m,
    'an unscoped `up` would start both colors (and --build would rebuild caddy)');
  const rollout = fs.readFileSync(path.join(root, 'scripts', 'platform-rollout.sh'), 'utf8');
  assert.match(rollout, /docker compose up -d --no-deps --force-recreate "usernode-\$(IDLE|LIVE)"/,
    'the rollout must start exactly one color at a time, without bouncing deps');
  assert.doesNotMatch(rollout, /^\s*docker compose up -d\s*$/m,
    'the rollout must never do an unscoped up');
  assert.match(deploy, /CADDY_FILES_CHANGED/,
    'caddy rebuilds must be gated on the caddy paths-filter');
  assert.match(workflow, /caddy:\n\s+- 'caddy\.Dockerfile'/,
    'paths-filter must watch caddy.Dockerfile');
});

// A blue-green flip is a `caddy reload`. Caddy applies the new config, then
// tears the OLD one down — and two parts of that teardown are unbounded by
// default: http.Server.Shutdown waits forever for in-flight requests
// (long-lived SSE), and the reverse_proxy Cleanup writes a WebSocket Close
// frame to every hijacked client inline, under the handler's connection
// lock, with no write deadline. One client in TCP zero-window (a suspended
// mobile tab) blocks that write on the TLS mutex, the reload never returns,
// the rollout never stops the old color (which keeps the leader lock), and
// the deployer's flock blocks every later merge. Observed 2026-09-09: a
// 45-minute hang with the old server's write stuck in
// reverseproxy.writeCloseControl -> crypto/tls.(*Conn).Write.
//
// Three pins: bound the Shutdown wait (global grace_period), take the
// WebSocket close off the reload's critical path (stream_close_delay, which
// makes Cleanup schedule the close on a timer), and bound the reload call
// itself so a wedge surfaces as a failed deploy instead of a silent hang.

function graceSeconds() {
  const m = caddyfile.match(/^\{\n(?:\t[^\n]*\n)*?\tgrace_period (\d+)s\n/m);
  assert.ok(m, 'Caddyfile must open with a global options block that sets grace_period');
  return Number(m[1]);
}

test('global options bound how long a reload waits for in-flight requests', () => {
  const firstBlock = caddyfile.indexOf('\n{\n');
  const firstSnippet = caddyfile.indexOf('\n(');
  const firstSite = caddyfile.indexOf('\n{$USERNODE_DOMAIN} {');
  assert.notStrictEqual(firstBlock, -1, 'global options block missing');
  assert.ok(firstBlock < firstSnippet && firstBlock < firstSite,
    'the global options block must be the first block in the Caddyfile (Caddy rejects it elsewhere)');
  const grace = graceSeconds();
  assert.ok(grace > 0 && grace <= 60,
    `grace_period (${grace}s) should be long enough for a normal SSE stream to notice and ` +
    'short enough that a deploy is not held open by stragglers');
});

for (const [label, src] of [
  ['committed bootstrap file', activeFile],
  ['platform-rollout.sh write_active()', rolloutSh],
  ['rollback.sh kill-switch copy', fs.readFileSync(path.join(root, 'scripts', 'rollback.sh'), 'utf8')],
]) {
  test(`apex platform proxy closes old WebSockets on a timer, not inline (${label})`, () => {
    const proxy = sliceBetween(
      src, 'reverse_proxy usernode-', '(platform_gate)', `apex proxy (${label})`
    );
    assert.match(proxy, /stream_close_delay \d+(ms|s)/,
      'without stream_close_delay Caddy closes hijacked streams inline during the reload, ' +
      'holding the connection lock across an undeadlined TLS write');
  });
}

test('app-container proxy also closes old WebSockets on a timer', () => {
  const appProxy = sliceBetween(
    wildcardSite, 'reverse_proxy {upstream}:3000 {', 'encode gzip', 'app proxy'
  );
  assert.match(appProxy, /stream_close_delay \d+(ms|s)/,
    'app WebSockets (falling sands et al.) are hijacked through this proxy and wedge a reload the same way');
});

test('the rollout bounds `caddy reload` and does not revert on a timeout', () => {
  assert.match(rolloutSh, /timeout "\$RELOAD_TIMEOUT" docker compose exec -T caddy caddy reload/,
    'the reload must run under `timeout` so a wedged Caddy fails the deploy instead of hanging it');
  const m = rolloutSh.match(/^RELOAD_TIMEOUT="\$\{RELOAD_TIMEOUT:-(\d+)\}"/m);
  assert.ok(m, 'RELOAD_TIMEOUT default not found');
  assert.ok(Number(m[1]) > graceSeconds() * 2,
    `RELOAD_TIMEOUT (${m[1]}s) must comfortably exceed the global grace_period ` +
    `(${graceSeconds()}s) a healthy reload may legitimately spend draining`);
  // Exit 124 is `timeout` expiring. It must map to a distinct return code
  // and short-circuit the retry loop — more reloads only queue on Caddy's
  // config lock.
  assert.match(rolloutSh, /\[ "\$rc" -eq 124 \][\s\S]*?return 2/,
    'a timed-out reload must return a distinct code without retrying');
  // The caller: on timeout, leave both colors up. Reverting the active
  // file or stopping the new color would break the traffic the new
  // config is already serving.
  const flip = rolloutSh.indexOf('write_active "$IDLE"');
  const timeoutBranch = sliceBetween(
    rolloutSh.slice(flip), '-eq 2 ]; then', 'elif', 'timeout branch'
  );
  assert.doesNotMatch(timeoutBranch, /write_active "\$LIVE"/,
    'the timeout branch must not flip the active file back');
  assert.doesNotMatch(timeoutBranch, /docker compose stop/,
    'the timeout branch must not stop either color');
  assert.match(timeoutBranch, /exit 1/, 'the timeout branch must still fail the deploy');
});
