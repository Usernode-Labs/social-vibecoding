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
  // Message family + the two request types the shell dispatches on.
  assert.match(bridge, /__usernode_llm/);
  assert.match(bridge, /"request-access"/);
  assert.match(bridge, /"get-access"/);
  // Two-stage timeout: a short ack window detects a missing/old shell;
  // after the ack the user may take minutes on the consent dialog.
  assert.match(bridge, /_LLM_ACK_TIMEOUT_MS/);
  assert.match(bridge, /_LLM_DECISION_TIMEOUT_MS/);
});

test('shell side handles the same LLM message family', () => {
  const shell = fs.readFileSync(path.join(root, 'public', 'js', 'app-view.js'), 'utf8');
  assert.match(shell, /handleLlmBridgeMessage/);
  assert.match(shell, /__usernode_llm/);
  assert.match(shell, /'request-access'/);
  assert.match(shell, /'get-access'/);
  assert.match(shell, /showLlmConsentModal/);
});
