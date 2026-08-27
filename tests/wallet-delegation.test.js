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

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

// ONE bundle per process: a second `loadTsx` entry would hand this file a
// different `walletSheetStore` from the one the components subscribe to.
let api = null;
const mod = () => (api || (api = loadTsx('tests/fixtures/wallet-sheet-api.ts')));

/**
 * The sheet body as the browser draws it, from the store the module published.
 *
 * `_renderStakingCard` used to RETURN a detached element and these tests
 * walked its children. The card is part of a component now, so the same
 * assertions run against real markup — reached the way the app reaches it,
 * through the module's own publish rather than by calling a renderer directly.
 */
function bodyHtml() {
  return renderToHtml(createElement(mod().WalletSheetBody, {}));
}

/** Publish `staking` through the module and return the rendered body. */
function stakingHtml(wallet, staking, { pending = false } = {}) {
  wallet._stakingSupported = true;
  wallet._stakingPending = pending;
  wallet._state = Object.assign({}, wallet._state || {}, { staking });
  wallet._publish();
  return bodyHtml();
}

/** Text content only, so a class string cannot satisfy a copy assertion. */
function textOf(html) {
  return html.replace(/<[^>]*>/g, '\n')
    .replace(/&#x27;/g, "'").replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
}

function loadWallet({ bridgeInfo, walletState = null, isNative = true } = {}) {
  let stateReads = 0;
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Date,
    Number,
    Promise,
    setInterval() { return 1; },
    clearInterval() {},
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
  // Bind the REAL store and stub the two portal helpers (the kit hand-off
  // needs a browser), then drop the import lines so the module body evaluates
  // as a script exactly as it did — tests/challenge-template-prefill.test.js
  // uses the same technique.
  mod().walletSheetStore.set({ ...mod().WALLET_EMPTY });
  sandbox.walletSheetStore = mod().walletSheetStore;
  sandbox.WALLET_EMPTY = mod().WALLET_EMPTY;
  sandbox.mountWalletSheet = () => {};
  sandbox.unmountWalletSheet = () => {};
  vm.createContext(sandbox);
  vm.runInContext(source.replace(/^import[^\n]*\n/gm, ''), sandbox);
  return {
    sandbox,
    wallet: sandbox.WalletSheet,
    get rowHtml() { return renderToHtml(createElement(mod().WalletRow, {})); },
    get bodyHtml() { return bodyHtml(); },
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

  const offHtml = stakingHtml(wallet, {
    delegate: null,
    delegated_since: '2026-08-11T10:30:00Z',
  });
  const off = textOf(offHtml);
  assert.match(off, /Producing blocks on this phone/);
  assert.match(off, /earns full points/);
  assert.ok(off.includes(disclosure));
  assert.ok(off.includes(selfHosted));
  assert.doesNotMatch(off, /Delegated since/,
    'delegated_since is not active-state evidence');
  assert.doesNotMatch(
    stakingHtml(wallet, { delegate: null, delegated_since: null }),
    /bg-violet-500\/10/,
    'the delegated highlight only appears while delegated');

  const activeValue = '2026-08-11T10:30:00Z';
  const activeHtml = stakingHtml(wallet, {
    delegate: 'B62qiTKpEPjGTSHZrtM8uXiKgn8So916pLmNJKDhKeyBQL9TDb3nvBG',
    delegated_since: activeValue,
  });
  const active = textOf(activeHtml);
  assert.match(active, /Delegated/);
  assert.match(active, /B62qiTKp…b3nvBG/);
  assert.match(active, /Block production on this phone is disabled/);
  assert.ok(active.includes('Delegated since ' +
    new Date(activeValue).toLocaleString()),
  'the timestamp follows the runtime user locale');
  assert.ok(active.includes(disclosure));
  assert.ok(active.includes(selfHosted));

  // The status line and the address live INSIDE the tinted container — the
  // containment the element walk used to prove, now read off the markup.
  const tinted = activeHtml.match(
    /<div class="rounded-lg bg-violet-500\/10 px-3 py-2">([\s\S]*?)<\/div><button/);
  assert.ok(tinted, 'the delegated state sits in a tinted container');
  assert.match(tinted[1], /Delegated/);
  assert.match(tinted[1], /B62qiTKp…b3nvBG/);

  const setup = textOf(stakingHtml(wallet, null));
  assert.match(setup, /Wallet setup is still in progress/);
  assert.match(setup, /Retry/);

  const pending = stakingHtml(wallet, {
    delegate: null,
    delegated_since: null,
  }, { pending: true });
  assert.match(textOf(pending), /Opening…/);
  // Disabled for the lifetime of the native promise.
  assert.match(pending, /<button[^>]*disabled=""[^>]*>Opening…<\/button>/);
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

    // The row is present for every native top frame — capabilities affect its
    // CONTENTS, never whether Wallet is reachable. Read off the rendered row
    // rather than a stub node's classList.
    assert.doesNotMatch(loaded.rowHtml, /class="hidden /);
    assert.match(loaded.rowHtml, /id="account-row-wallet"/);
    assert.equal(loaded.wallet._stakingSupported, false);
    assert.equal(loaded.stateReads, 0);
    // And no delegation card at all on an unsupported bridge.
    assert.doesNotMatch(loaded.bodyHtml, /Block production/);
  });

test('wallet implementation has no raw channel or delegation HTTP path', () => {
  assert.doesNotMatch(source, /Usernode\.postMessage/);
  assert.doesNotMatch(source, /fetch\s*\(/);
  assert.doesNotMatch(source, /delegate(?:\/|-)undelegate|\/staking/i);
});
