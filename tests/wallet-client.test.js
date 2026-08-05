const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const MODULE_PATH = path.join(ROOT, 'public', 'usernode-bridge', 'v1', 'wallet-client.mjs');
let wallet;

test.before(async () => {
  wallet = await import(`${pathToFileURL(MODULE_PATH).href}?test=${Date.now()}`);
});

test('module is versioned, dependency-free, side-effect-free and named-exported', () => {
  const source = fs.readFileSync(MODULE_PATH, 'utf8');
  assert.equal(wallet.WALLET_CLIENT_VERSION, '1.0.0');
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /localStorage|sessionStorage|console\./);
  assert.doesNotMatch(source, /\.secret_key|\.privateKey|\.seedPhrase/);
  assert.doesNotMatch(source, /headers\s*:\s*\{[^}]*authorization/is);
  assert.match(source, /export function createWalletClient/);
  assert.match(source, /export function reconcileTransactionRecords/);
});

test('address and amount validation rejects EVM, whitespace and lossy values', () => {
  assert.equal(wallet.normalizeUsernodeAddress(' ut1abcde234567 '), 'ut1abcde234567');
  assert.equal(wallet.normalizeBaseUnitAmount('42'), 42);
  assert.equal(wallet.normalizeBaseUnitAmount(42n), 42);
  for (const value of ['0x1234567890', 'ut1bad address', 'ut1short']) {
    assert.throws(() => wallet.normalizeUsernodeAddress(value), { code: 'invalid_argument' });
  }
  for (const value of [0, -1, 1.5, '1e3', '1.2', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => wallet.normalizeBaseUnitAmount(value), { code: 'invalid_argument' });
  }
});

test('client exposes only explicitly requested methods', () => {
  const bridge = { getNodeAddress: async () => 'ut1abcde234567', usernode: {} };
  const client = wallet.createWalletClient({ capabilities: ['address'], bridge });
  assert.deepEqual(client.capabilities, ['address']);
  assert.equal(typeof client.getAddress, 'function');
  for (const method of ['getState', 'getTransactions', 'signChallenge', 'send']) {
    assert.equal(client[method], undefined);
  }
  assert.throws(
    () => wallet.createWalletClient({ capabilities: ['admin'], bridge }),
    { code: 'invalid_argument' }
  );
});

test('capability discovery respects native advertisement and browser limits', async () => {
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://app.example' },
  });
  const bridge = {
    getNodeAddress: async () => 'ut1abcde234567',
    sendTransaction: async () => ({}),
    signMessage: async () => 'sig',
    usernode: {
      isNative: true,
      getBridgeInfo: async () => ({ capabilities: ['signMessage'] }),
    },
  };
  const client = wallet.createWalletClient({
    capabilities: ['address', 'send', 'sign', 'state'],
    bridge,
  });
  assert.deepEqual(await client.availableCapabilities(), {
    transport: 'native',
    available: ['address', 'send', 'sign'],
  });
  if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
  else delete globalThis.location;
});

test('signing challenge is deterministic and bound to origin, nonce and expiry', async () => {
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://app.example' },
  });
  const signed = [];
  const bridge = {
    signMessage: async (message) => { signed.push(message); return 'signature'; },
    usernode: { isNative: true },
  };
  const client = wallet.createWalletClient({
    capabilities: ['sign'],
    bridge,
  });
  const now = new Date();
  const input = {
    origin: 'https://attacker.invalid', // client origin must override input
    purpose: 'login',
    nonce: 'server_nonce_123456789',
    subject: 'user:42',
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 4 * 60_000).toISOString(),
  };
  const result = await client.signChallenge(input);
  assert.equal(result.payload.origin, 'https://app.example');
  assert.equal(result.payload.nonce, input.nonce);
  assert.equal(result.payload.expiresAt, input.expiresAt);
  assert.equal(result.signature, 'signature');
  assert.equal(signed[0], result.message);
  assert.equal(JSON.parse(result.message).schema, 'usernode-wallet-challenge/v1');

  assert.throws(() => wallet.createSigningChallenge(
    { ...input, issuedAt: '2026-08-05T00:00:00.000Z', expiresAt: '2026-08-05T00:06:00.000Z' },
    { now: '2026-08-05T00:01:00.000Z' }
  ), { code: 'invalid_argument' });
  assert.throws(() => wallet.createSigningChallenge(
    { ...input, nonce: 'client-short' },
    { now: '2026-08-05T00:01:00.000Z' }
  ), { code: 'invalid_argument' });
  if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
  else delete globalThis.location;
});

test('send validates and forwards once with pending-by-default semantics', async () => {
  const calls = [];
  const bridge = {
    sendTransaction: async (...args) => { calls.push(args); return { tx_id: 'tx-1', queued: true }; },
    usernode: {},
  };
  const client = wallet.createWalletClient({ capabilities: ['send'], bridge });
  const result = await client.send({ to: 'ut1abcde234567', amount: '7', memo: 'order:1' });
  assert.equal(calls.length, 1, 'the client must never implicitly retry a send');
  assert.deepEqual(calls[0], [
    'ut1abcde234567',
    7,
    'order:1',
    { waitForInclusion: false, forcePolling: false },
  ]);
  assert.deepEqual(result, { status: 'submitted', txId: 'tx-1', transaction: null });
});

test('send maps bridge failures to stable privacy-safe errors', async () => {
  const bridge = {
    sendTransaction: async () => { throw new Error('handoff denied token=private'); },
    usernode: {},
  };
  const client = wallet.createWalletClient({ capabilities: ['send'], bridge });
  await assert.rejects(
    client.send({ to: 'ut1abcde234567', amount: 1 }),
    (err) => err.code === 'session_not_admitted' && !err.message.includes('private')
  );
});

test('wallet state is allowlisted and excludes unexpected secret-bearing fields', async () => {
  const client = wallet.createWalletClient({
    capabilities: ['state'],
    bridge: {
      usernode: {
        isNative: true,
        getWalletState: async () => ({
          address: 'ut1abcde234567', balance: '10', tokenAmount: '1',
          tokenSymbol: 'UT', lastUpdatedMs: 42, secretMaterial: 'never-return',
        }),
      },
    },
  });
  assert.deepEqual(await client.getState(), {
    address: 'ut1abcde234567', balance: '10', tokenAmount: '1',
    tokenSymbol: 'UT', lastUpdatedMs: 42,
  });
});

test('transaction reconciliation deduplicates only concrete transaction IDs', () => {
  const result = wallet.reconcileTransactionRecords([
    { tx_id: 'same', to: 'ut1abcde234567', amount: 1, status: 'queued' },
    { txId: 'same', to: 'ut1abcde234567', amount: 1, status: 'confirmed', blockHeight: 8 },
    { to: 'ut1abcde234567', amount: 1, status: 'queued' },
    { to: 'ut1abcde234567', amount: 1, status: 'queued' },
  ]);
  assert.equal(result.duplicates, 1);
  assert.equal(result.items.length, 3, 'idless lookalikes must remain separate');
  assert.equal(result.items[0].status, 'confirmed');
  assert.equal(result.items[0].blockHeight, 8);
  assert.equal(result.items[0].to, 'ut1abcde234567', 'safe detail survives a sparse confirmation');
  assert.throws(
    () => wallet.reconcileTransactionRecords(Array.from({ length: 101 }, () => ({}))),
    { code: 'invalid_argument' }
  );
});

test('hosted module inherits the public bridge boundary, CORS and revalidation policy', () => {
  const auth = fs.readFileSync(path.join(ROOT, 'src', 'middleware', 'auth.js'), 'utf8');
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const selfHosting = fs.readFileSync(path.join(ROOT, 'SELF-HOSTING.md'), 'utf8');
  const conventions = fs.readFileSync(path.join(ROOT, 'src', 'prompts', 'app-conventions.md'), 'utf8');
  assert.match(auth, /'\/usernode-bridge\/'/);
  assert.match(server, /app\.use\('\/usernode-bridge'/);
  assert.match(server, /Access-Control-Allow-Origin', '\*'/);
  assert.match(server, /no-cache, must-revalidate/);
  for (const doc of [selfHosting, conventions]) assert.match(doc, /wallet-client\.mjs/);
  assert.match(conventions, /requested capabilities.*not an authorization boundary/is);
  assert.match(conventions, /Do not assume `0x` addresses, wei, EVM `chainId`/);
  assert.match(conventions, /atomically consume the nonce/);
  assert.match(conventions, /Reconcile duplicates only by a concrete transaction ID/);
});
