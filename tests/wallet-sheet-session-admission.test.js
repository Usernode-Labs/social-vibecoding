const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const walletSheetSource = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'wallet-sheet.js'),
  'utf8'
);
const walletSandboxes = new WeakMap();

function loadWalletSheet() {
  const sandbox = { console: { warn() {} } };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(walletSheetSource, sandbox);
  walletSandboxes.set(sandbox.WalletSheet, sandbox);
  return sandbox.WalletSheet;
}

function installSendFormHarness(wallet) {
  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.listeners = {};
      this.value = '';
      this.disabled = false;
      this.textContent = '';
    }

    appendChild(child) { this.children.push(child); }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    focus() {}
  }

  const expand = new FakeElement('div');
  const document = {
    createElement(tagName) { return new FakeElement(tagName); },
    getElementById(id) {
      if (id === 'wallet-sheet-expand') return expand;
      return null;
    },
  };
  const toasts = [];
  const sends = [];
  const sandbox = walletSandboxes.get(wallet);
  sandbox.document = document;
  sandbox.PlatformUI = { toast(message) { toasts.push(message); } };
  sandbox.sendTransaction = async (...args) => { sends.push(args); };
  wallet._refreshRecords = async () => {};
  wallet._renderSheetBody = () => {};
  wallet._showSend();

  return {
    form: expand.children[0],
    sends,
    toasts,
  };
}

test('transfer amounts accept only canonical positive safe integers', () => {
  const wallet = loadWalletSheet();

  assert.equal(wallet._parseAmount('1'), 1);
  assert.equal(wallet._parseAmount('42'), 42);
  assert.equal(
    wallet._parseAmount(String(Number.MAX_SAFE_INTEGER)),
    Number.MAX_SAFE_INTEGER
  );

  for (const value of [
    '', '0', '00', '01', '-1', '+1', ' 1', '1 ', '1.9', '1e3', '12abc',
    String(Number.MAX_SAFE_INTEGER + 1),
  ]) {
    assert.equal(
      wallet._parseAmount(value), null, `reject ${JSON.stringify(value)}`
    );
  }
});

test('invalid transfer amount never reaches the native send bridge', async () => {
  const wallet = loadWalletSheet();
  const { form, sends, toasts } = installSendFormHarness(wallet);
  const [toInput, amountInput, sendButton] = form.children;
  toInput.value = 'ut1recipient';
  amountInput.value = '12abc';

  await sendButton.listeners.click();

  assert.equal(sends.length, 0);
  assert.deepEqual(toasts, [
    'Enter a positive whole-number amount (digits only)',
  ]);
  assert.equal(sendButton.disabled, false);
});

test('valid transfer amount reaches native confirmation unchanged', async () => {
  const wallet = loadWalletSheet();
  const { form, sends, toasts } = installSendFormHarness(wallet);
  const [toInput, amountInput, sendButton] = form.children;
  toInput.value = 'ut1recipient';
  amountInput.value = '42';

  await sendButton.listeners.click();

  assert.equal(sends.length, 1);
  assert.equal(sends[0][0], 'ut1recipient');
  assert.equal(sends[0][1], 42);
  assert.equal(sends[0][3].confirmSubtitle, 'Sending 42 UT to ut1recipient');
  assert.deepEqual(toasts, ['Transaction submitted']);
});

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
