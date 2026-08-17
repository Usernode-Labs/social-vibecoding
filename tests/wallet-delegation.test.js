const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'header',
    'wallet-sheet.js'),
  'utf8'
);

function element({ hidden = false } = {}) {
  const classes = new Set(hidden ? ['hidden'] : []);
  return {
    children: [],
    className: '',
    textContent: '',
    disabled: false,
    listeners: {},
    classList: {
      contains(name) { return classes.has(name); },
      remove(name) { classes.delete(name); },
    },
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(type, listener) { this.listeners[type] = listener; },
  };
}

function loadWallet({ bridgeInfo, walletState = null, isNative = true } = {}) {
  const walletRow = element({ hidden: true });
  const balance = element();
  let stateReads = 0;
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Date,
    Number,
    Promise,
    setInterval() { return 1; },
    clearInterval() {},
    document: {
      createElement() { return element(); },
      getElementById(id) {
        return {
          'drawer-row-wallet': walletRow,
          'drawer-wallet-balance': balance,
        }[id] || null;
      },
    },
    NativeChrome: {
      async getInfo() {
        return bridgeInfo || { version: 4, capabilities: [
          'getWalletState', 'getTransactionRecords', 'manageStaking',
        ] };
      },
      lastReadError() { return null; },
    },
    usernode: {
      isNative,
      async getWalletState() {
        stateReads += 1;
        return walletState;
      },
      async getTransactionRecords() { return { items: [] }; },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return {
    sandbox,
    wallet: sandbox.WalletSheet,
    walletRow,
    get stateReads() { return stateReads; },
  };
}

function textTree(node) {
  return [node.textContent, ...node.children.flatMap(textTree)]
    .filter(Boolean).join('\n');
}

function findText(node, text) {
  if (node.textContent === text) return node;
  for (const child of node.children) {
    const match = findText(child, text);
    if (match) return match;
  }
  return null;
}

function findClass(node, className) {
  if (typeof node.className === 'string' &&
      node.className.split(/\s+/).includes(className)) {
    return node;
  }
  for (const child of node.children) {
    const match = findClass(child, className);
    if (match) return match;
  }
  return null;
}

test('delegate alone determines active delegation', () => {
  const { wallet } = loadWallet();

  assert.equal(wallet._isDelegated({
    delegate: null,
    delegated_since: '2026-08-11T10:30:00Z',
  }), false, 'a timestamp must not turn delegation on');
  assert.equal(wallet._isDelegated({
    delegate: 'B62qiTKpEPjGTSHZrtM8uXiKgn8So916pLmNJKDhKeyBQL9TDb3nvBG',
    delegated_since: null,
  }), true, 'an address turns delegation on without a timestamp');
});

test('delegation card renders off, active and setup states with disclosure', () => {
  const { wallet } = loadWallet();
  const disclosure = 'When delegated, you receive half the points you would ' +
    'earn by producing blocks directly from your phone.';
  const selfHosted = 'Want to run a node on your own laptop or server and ' +
    'monitor it from your phone? Start the node there using the same ' +
    'account you use on this phone.';

  const off = textTree(wallet._renderStakingCard({
    delegate: null,
    delegated_since: '2026-08-11T10:30:00Z',
  }));
  assert.match(off, /Producing blocks on this phone/);
  assert.match(off, /earns full points/);
  assert.ok(off.includes(disclosure));
  assert.ok(off.includes(selfHosted));
  assert.doesNotMatch(off, /Delegated since/,
    'delegated_since is not active-state evidence');
  assert.equal(findClass(wallet._renderStakingCard({
    delegate: null,
    delegated_since: null,
  }), 'bg-violet-500/10'), null,
  'the delegated highlight only appears while delegated');

  const activeValue = '2026-08-11T10:30:00Z';
  const activeCard = wallet._renderStakingCard({
    delegate: 'B62qiTKpEPjGTSHZrtM8uXiKgn8So916pLmNJKDhKeyBQL9TDb3nvBG',
    delegated_since: activeValue,
  });
  const active = textTree(activeCard);
  assert.match(active, /Delegated/);
  assert.match(active, /B62qiTKp…b3nvBG/);
  assert.match(active, /Block production on this phone is disabled/);
  assert.ok(active.includes('Delegated since ' +
    new Date(activeValue).toLocaleString()),
  'the timestamp follows the runtime user locale');
  assert.ok(active.includes(disclosure));
  assert.ok(active.includes(selfHosted));
  const highlight = findClass(activeCard, 'bg-violet-500/10');
  assert.ok(highlight, 'the delegated state sits in a tinted container');
  assert.ok(findText(highlight, 'Delegated'),
    'the status line lives inside the highlighted container');
  assert.ok(findText(highlight, 'B62qiTKp…b3nvBG'),
    'the delegate address lives inside the highlighted container');

  const setup = textTree(wallet._renderStakingCard(null));
  assert.match(setup, /Wallet setup is still in progress/);
  assert.match(setup, /Retry/);

  wallet._stakingPending = true;
  const pending = wallet._renderStakingCard({
    delegate: null,
    delegated_since: null,
  });
  const opening = findText(pending, 'Opening…');
  assert.ok(opening);
  assert.equal(opening.disabled, true,
    'the action is disabled for the lifetime of the native promise');
});

test('manage action sends no values, applies native result, then refreshes',
  async () => {
    const { wallet, sandbox } = loadWallet();
    const oldState = {
      address: 'ut1-wallet',
      staking: { delegate: null, delegated_since: null },
    };
    const returned = {
      delegate: 'B62qdelegate',
      delegated_since: '2026-08-11T10:30:00Z',
    };
    wallet._state = oldState;
    wallet._stakingSupported = true;
    wallet._renderSheetBody = () => {};
    wallet._renderChip = () => {};
    let argumentCount = -1;
    let refreshed = 0;
    sandbox.usernode.manageStaking = async function () {
      argumentCount = arguments.length;
      return returned;
    };
    wallet._refreshState = async () => {
      refreshed += 1;
      assert.equal(wallet._state.staking.delegate, 'B62qdelegate',
        'native result is visible before the full snapshot refresh');
    };

    await wallet._manageStaking();

    assert.equal(argumentCount, 0);
    assert.equal(refreshed, 1);
    assert.equal(wallet._stakingPending, false);
    assert.equal(wallet._state.address, 'ut1-wallet');
  });

test('manage failure retains last state and reports a non-blocking error',
  async () => {
    const { wallet, sandbox } = loadWallet();
    const lastKnown = {
      staking: { delegate: null, delegated_since: null },
    };
    wallet._state = lastKnown;
    wallet._stakingSupported = true;
    wallet._renderSheetBody = () => {};
    wallet._renderChip = () => {};
    sandbox.usernode.manageStaking = async () => {
      throw new Error('native screen unavailable');
    };

    await wallet._manageStaking();

    assert.equal(wallet._state, lastKnown);
    assert.equal(wallet._stateError, 'native screen unavailable');
    assert.equal(wallet._stakingPending, false);
  });

test('wallet read failure retains the last snapshot and records an error',
  async () => {
    const loaded = loadWallet();
    const lastKnown = {
      address: 'ut1-wallet',
      staking: { delegate: null, delegated_since: null },
    };
    loaded.wallet._state = lastKnown;
    loaded.sandbox.usernode.getWalletState = async () => null;
    loaded.sandbox.NativeChrome.lastReadError = () => ({
      message: 'wallet provider is reconciling',
    });

    await loaded.wallet._refreshState();

    assert.equal(loaded.wallet._state, lastKnown);
    assert.equal(loaded.wallet._stateError, 'wallet provider is reconciling');
  });

test('unsupported native bridge keeps Wallet navigation but hides delegation',
  async () => {
    const loaded = loadWallet({
      bridgeInfo: { version: 3, capabilities: [] },
      walletState: null,
    });

    await loaded.wallet.init();

    assert.equal(loaded.walletRow.classList.contains('hidden'), false);
    assert.equal(loaded.wallet._stakingSupported, false);
    assert.equal(loaded.stateReads, 0);
  });

test('wallet implementation has no raw channel or delegation HTTP path', () => {
  assert.doesNotMatch(source, /Usernode\.postMessage/);
  assert.doesNotMatch(source, /fetch\s*\(/);
  assert.doesNotMatch(source, /delegate(?:\/|-)undelegate|\/staking/i);
});
