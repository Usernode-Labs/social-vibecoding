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

// Homescreen shortcuts are trust-gated by the app on the TOP frame's
// origin (no per-add confirmation screen anymore), so the parent relay
// must refuse to forward shortcut calls for child iframes — otherwise
// any embedded sub-app could piggyback on the parent's trust.
test('hosted bridge relay refuses homescreen-shortcut calls from iframes', () => {
  const bridge = readBridge(versionedBridgePath);
  assert.match(bridge, /refusing to relay/);
  assert.match(bridge, /indexOf\("HomeScreenShortcut"\)/);
  assert.match(
    bridge,
    /Homescreen shortcuts can only be managed by the top-level page/
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
