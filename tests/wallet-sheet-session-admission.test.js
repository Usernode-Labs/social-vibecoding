const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const walletSheetSource = fs.readFileSync(
  // #1079 chunk B: same module, now inside the React bundle.
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'header', 'wallet-sheet.js'),
  'utf8'
);

function loadWalletSheet() {
  const sandbox = { console: { warn() {} } };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(walletSheetSource, sandbox);
  return sandbox.WalletSheet;
}

test('session admission drops old wallet snapshots and refreshes on reopen',
  async () => {
    const wallet = loadWalletSheet();
    let chipRenders = 0;
    let sheetRenders = 0;
    wallet._state = { address: 'wallet-A' };
    wallet._records = [{ hash: 'tx-A' }];
    wallet._sheet = {};
    wallet._renderChip = () => { chipRenders += 1; };
    wallet._renderSheetBody = () => { sheetRenders += 1; };

    await wallet._setSessionWalletAdmission(false);

    assert.equal(wallet._state, null);
    assert.equal(wallet._records, null);
    assert.equal(chipRenders, 1);
    assert.equal(sheetRenders, 1);

    wallet._refreshState = async () => { wallet._state = { address: 'wallet-B' }; };
    wallet._refreshRecords = async () => { wallet._records = [{ hash: 'tx-B' }]; };
    await wallet._setSessionWalletAdmission(true);

    assert.equal(wallet._state.address, 'wallet-B');
    assert.equal(wallet._records[0].hash, 'tx-B');
    assert.equal(chipRenders, 2);
    assert.equal(sheetRenders, 2);
  });
