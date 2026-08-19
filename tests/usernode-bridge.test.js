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

test('hosted bridge exposes the realm-bound readiness handshake', () => {
  const bridge = readBridge(versionedBridgePath);

  assert.match(bridge, /window\.usernode\.markPrivilegedBridgeReady/);
  assert.match(bridge, /markPrivilegedBridgeReady: true/);
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
  // `|| null` rather than a conditional spread, and that matters more
  // now than it did: SV decides what the installed build can store by
  // sending ONE pair and reading `has_icon_dark` back, so the native
  // side has to be able to tell a pair from a single without inspecting
  // key presence. An explicitly-null field is that signal, and it is
  // also the unambiguous "clear the dark slot" on a re-add — which is
  // what the corrective re-send after a failed confirmation relies on.
  assert.equal(
    /icon_url_dark: opts\.icon_url_dark \? [^\n]*: undefined/.test(call[0]),
    false,
    'a single-icon add still names the field, so the two shapes differ'
  );
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

test('hosted bridge exposes the user-directory API', () => {
  const bridge = readBridge(versionedBridgePath);

  assert.match(bridge, /window\.usernode\.lookupUser/);
  assert.match(bridge, /window\.usernode\.searchUsers/);
  // Message family + the request/ack/response types the shell uses.
  assert.match(bridge, /__usernode_directory/);
  assert.match(bridge, /"lookup"/);
  assert.match(bridge, /"search"/);
  assert.match(bridge, /_DIR_ACK_TIMEOUT_MS/);
  assert.match(bridge, /_DIR_RESULT_TIMEOUT_MS/);
  // Client-side mirror of the server's limit clamp.
  assert.match(bridge, /_DIR_MAX_LIMIT/);
  // Only the parent shell may answer a pending directory call.
  assert.match(bridge, /__USERNODE_DIRECTORY_BEGIN__/);
  assert.match(bridge, /__USERNODE_DIRECTORY_END__/);
});

// Unlike getUserLocale, which resolves a token-derived fallback, both
// directory calls REJECT with no shell: an existence check that quietly
// answered "nobody" would read as a real answer. Apps degrade open.
test('directory calls reject rather than fall back when there is no shell', () => {
  const bridge = readBridge(versionedBridgePath);
  const block = bridge.slice(
    bridge.indexOf('__USERNODE_DIRECTORY_BEGIN__'),
    bridge.indexOf('__USERNODE_DIRECTORY_END__')
  );
  assert.ok(block.length > 0);
  assert.match(block, /if \(window === window\.parent\)/);
  assert.match(block, /User directory requires the Usernode platform shell/);
  // The relay is the parent shell only — never a sibling frame.
  assert.match(block, /if \(e\.source !== window\.parent\) return;/);
});

test('shell side handles the same directory message family', () => {
  const shell = fs.readFileSync(path.join(root, 'public', 'js', 'app-view.js'), 'utf8');
  assert.match(shell, /handleDirectoryBridgeMessage/);
  assert.match(shell, /__usernode_directory/);
  assert.match(shell, /\/api\/app-directory\/users\/lookup/);
  assert.match(shell, /\/api\/app-directory\/users\/search/);
  // Both iframes are accepted — the staging one is the ONLY way handle
  // lookup is exercisable in a PR preview (no platform token there).
  const relay = shell.slice(
    shell.indexOf('async handleDirectoryBridgeMessage'),
    shell.indexOf('── Issue-state snapshots')
  );
  assert.ok(relay.length > 0);
  assert.match(relay, /getElementById\('app-iframe'\)/);
  assert.match(relay, /getElementById\('staging-iframe'\)/);
  assert.match(relay, /if \(!fromApp && !fromStaging\) return;/);
  // Session-authenticated, same-origin — the bridge holds no credential.
  assert.match(relay, /credentials: 'same-origin'/);
  // Wired into the single top-level message listener.
  assert.match(shell, /AppView\.handleDirectoryBridgeMessage\(e\)/);
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

// External links can only leave the app's webview through the system
// browser (#1312): iOS App-Bound Domains refuse an in-page navigation to
// any non-bound domain, anchors and window.open alike. The native
// openExternal handler is pre-existing v1 — this pins the web wrapper that
// was never exposed, and the contract nav-link.js's external-link routing
// depends on.
test('hosted bridge exposes openExternal for the trip out of the webview', () => {
  const bridge = readBridge(versionedBridgePath);

  assert.match(bridge, /window\.usernode\.openExternal = function \(url\)/);
  // http/https only, enforced before the channel is touched — same rule
  // NATIVE-BRIDGE.md states for the native side.
  assert.match(bridge, /openExternal requires an http\(s\) URL/);
  // REJECTS on non-native and on old builds (no-op-proof, like
  // openNativeScreen) so callers can fall back to plain anchor behaviour.
  assert.match(bridge, /openExternal is only available inside the Usernode mobile app\./);
  assert.match(bridge, /openExternal is not supported by this app build/);
  assert.match(bridge, /callNative\("openExternal", \{ url: parsed \}\)/);
});
