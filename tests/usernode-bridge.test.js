const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const unversionedBridgePath = path.join(root, 'public', 'usernode-bridge.js');
const versionedBridgePath = path.join(root, 'public', 'usernode-bridge', 'v1', 'bridge.js');

function readBridge(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

test('hosted bridge copies stay identical', () => {
  assert.equal(readBridge(unversionedBridgePath), readBridge(versionedBridgePath));
});

test('hosted bridge keeps server-cache inclusion support', () => {
  const bridge = readBridge(versionedBridgePath);

  assert.match(bridge, /serverCacheUrl/);
  assert.match(bridge, /\/waitForTx\?/);
  assert.match(bridge, /clientId/);
  assert.match(bridge, /new EventSource/);
  assert.match(bridge, /\/getTransactions/);
  assert.match(bridge, /attachMatchedTx/);
});

test('hosted bridge exposes the validated native external-link wrapper', () => {
  const bridge = readBridge(versionedBridgePath);

  assert.match(bridge, /window\.usernode\.openExternal = function \(url\)/);
  assert.match(bridge, /typeof url !== "string" \|\| !url\.trim\(\)/);
  assert.match(bridge, /parsed\.protocol !== "http:"/);
  assert.match(bridge, /parsed\.protocol !== "https:"/);
  assert.match(bridge, /parsed\.username/);
  assert.match(bridge, /parsed\.password/);
  assert.match(
    bridge,
    /"openExternal", \{ url: parsed\.href \}, _CHROME_PROBE_TIMEOUT_MS/
  );
});

// LLM-access consent flow (issue #34) — additive within v1. The shell
// (public/js/app-view.js) answers the `__usernode_llm` message family;
// these assertions pin the message shape both sides agree on, plus
// the no-shell fallback (a request must reject, not hang, when no
// parent acks).
test('hosted bridge exposes the LLM-access consent API', () => {
  const bridge = readBridge(versionedBridgePath);

  assert.match(bridge, /window\.usernode\.requestLlmAccess/);
  assert.match(bridge, /window\.usernode\.getLlmAccess/);
  assert.match(bridge, /window\.usernode\.getLlmUsage/);
  // Message family + the three request types the shell dispatches on.
  assert.match(bridge, /__usernode_llm/);
  assert.match(bridge, /"request-access"/);
  assert.match(bridge, /"get-access"/);
  assert.match(bridge, /"get-usage"/);
  // Two-stage timeout: a short ack window detects a missing/old shell;
  // after the ack the user may take minutes on the consent dialog.
  assert.match(bridge, /_LLM_ACK_TIMEOUT_MS/);
  assert.match(bridge, /_LLM_DECISION_TIMEOUT_MS/);
});

// Flutter sees only the trusted top-frame origin. The hosted bridge therefore
// treats child iframes as a separate caller class with an explicit allowlist;
// source/origin binding and behavioral rejection coverage live in
// usernode-bridge-relay.test.js.
test('hosted bridge relay is deny-by-default for child iframes', () => {
  const bridge = readBridge(versionedBridgePath);
  assert.match(bridge, /_CHILD_NATIVE_RELAY_METHODS/);
  assert.match(bridge, /isDirectChildFrame/);
  assert.match(bridge, /isDiscoveredChildRelayCaller/);
  assert.match(bridge, /filterChildBridgeInfo/);
  assert.match(bridge, /refusing to relay/);
  assert.match(
    bridge,
    /Native capability is not available to embedded child apps/
  );
});

// Native chrome actions are authorized with a top-frame capability. The
// parent relay must deny both the private bootstrap and every privileged
// method so an embedded app cannot borrow the shell's authority.
test('hosted bridge relay refuses privileged calls from iframes', () => {
  const bridge = readBridge(versionedBridgePath);
  assert.match(bridge, /getPrivilegedBridgeCapability/);
  assert.match(bridge, /isPrivilegedNativeMethod\(data\.method\)/);
  assert.match(bridge, /refusing privileged relay/);
  assert.match(
    bridge,
    /Privileged Usernode methods are only available to the top-level page/
  );
});

test('hosted bridge forwards the versioned app identity shortcut contract', () => {
  const bridge = readBridge(versionedBridgePath);
  assert.match(bridge, /var id = String\(Date\.now\(\)\) \+ "-" \+ Math\.random\(\)\.toString\(16\)\.slice\(2\)/);
  assert.match(bridge, /var payload = \{ method: method, id: id, args: args \|\| \{\} \}/);
  assert.match(bridge, /contract: opts\.contract \|\| null/);
  assert.match(bridge, /contract_version: opts\.contract_version \|\| null/);
  assert.match(bridge, /route_contract: opts\.route_contract \|\| null/);
  assert.match(bridge, /identity: opts\.identity \|\| null/);
  assert.match(bridge, /identity\.appearance_hash/);
});

// Per-appearance widget icons (issue #948) — additive within v1, gated
// on the shell's `homeScreenShortcutDarkIcon` capability. The wrapper
// builds an explicit arg object, so a field it doesn't name is dropped
// on the floor: forwarding icon_url_dark has to be deliberate, and the
// other four args must survive alongside it.
test('hosted bridge forwards the paired homescreen-shortcut icons', () => {
  const bridge = readBridge(versionedBridgePath);
  const call = bridge.match(
    /callNative\("addHomeScreenShortcut", \{[\s\S]*?\n    \}\);/
  );
  assert.ok(call, 'addHomeScreenShortcut forwards an arg object');
  assert.match(call[0], /name: opts\.name/);
  assert.match(call[0], /url: opts\.url/);
  assert.match(call[0], /icon_url: opts\.icon_url \|\| null/);
  assert.match(call[0], /icon_url_dark: opts\.icon_url_dark \|\| null/,
    'the dark companion asset reaches the native side');
  assert.match(call[0], /silent: opts\.silent === true/);
});

// User locale (issue #757) — additive within v1. The shell
// (public/js/app-view.js) answers the `__usernode_locale` message
// family; these assertions pin the message shape both sides agree on,
// the JWT-claim fallback, and the live-update event.
test('hosted bridge exposes the user-locale API', () => {
  const bridge = readBridge(versionedBridgePath);

  assert.match(bridge, /window\.usernode\.getUserLocale/);
  // Message family + the request/response/push types the shell uses.
  assert.match(bridge, /__usernode_locale/);
  assert.match(bridge, /"get"/);
  assert.match(bridge, /"response"/);
  assert.match(bridge, /"changed"/);
  // Live-update event dispatched when the parent pushes a change.
  assert.match(bridge, /usernode:locale-changed/);
  // No-shell fallback: resolve (never reject) from the iframe JWT's
  // `locale` claim, captured at script load.
  assert.match(bridge, /_LOCALE_TIMEOUT_MS/);
  assert.match(bridge, /_tokenLocale/);
});

test('shell side handles the same locale message family', () => {
  const shell = fs.readFileSync(path.join(root, 'public', 'js', 'app-view.js'), 'utf8');
  assert.match(shell, /handleLocaleBridgeMessage/);
  assert.match(shell, /__usernode_locale/);
  assert.match(shell, /notifyLocaleChanged/);
});

test('shell side handles the same LLM message family', () => {
  const shell = fs.readFileSync(path.join(root, 'public', 'js', 'app-view.js'), 'utf8');
  assert.match(shell, /handleLlmBridgeMessage/);
  assert.match(shell, /__usernode_llm/);
  assert.match(shell, /'request-access'/);
  assert.match(shell, /'get-access'/);
  assert.match(shell, /'get-usage'/);
  // The usage reply shape the bridge's getLlmUsage() resolves with.
  assert.match(shell, /spentCentsToday/);
  assert.match(shell, /showLlmConsentModal/);
});

// Floating "Open in Usernode" pill on chromeless share views — additive
// within v1. Shown only on a production app subdomain
// (<label>.<platformHost>, no "--" in the label, platform host derived
// from the bridge's own script src), top frame, no native channel;
// links back to the in-chrome App tab. Dismissing via × only hides the
// pill for the current page load — no storage flag, so it reappears on
// every refresh.
test('hosted bridge injects the back-to-platform pill on share views', () => {
  const bridge = readBridge(versionedBridgePath);

  assert.match(bridge, /__un-platform-link/);
  // Canonical App-tab deep link: https://<platformHost>/#app/<slug>/app.
  assert.match(bridge, /"\/#app\/" \+ label \+ "\/app"/);
  // Staging previews (<slug>--s<id>) must not get the pill.
  assert.match(bridge, /label\.indexOf\("--"\) !== -1/);
  // Never inside the platform iframe or the Flutter WebView.
  assert.match(bridge, /_inIframe \|\| _hasNativeChannel/);
  // Dismiss must NOT persist anywhere — the pill comes back on refresh.
  assert.doesNotMatch(bridge, /__un_platform_link_dismissed/);
  assert.doesNotMatch(bridge, /sessionStorage[^\n]*platform_link/i);
  // Platform host comes from the script's own src, not a hard-coded
  // domain (keeps self-hosted forks correct).
  assert.match(bridge, /document\.currentScript/);
});
