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
