/**
 * Usernode wallet client v1.
 *
 * A dependency-free, side-effect-free convenience layer over the hosted
 * bridge. This module deliberately does not implement a wallet: private keys,
 * authorization, signing and transaction confirmation remain native-shell
 * responsibilities.
 */

export const WALLET_CLIENT_VERSION = '1.0.0';

export const WalletCapability = Object.freeze({
  ADDRESS: 'address',
  STATE: 'state',
  TRANSACTIONS: 'transactions',
  SIGN: 'sign',
  SEND: 'send',
});

export const WalletErrorCode = Object.freeze({
  INVALID_ARGUMENT: 'invalid_argument',
  INVALID_RESPONSE: 'invalid_response',
  CAPABILITY_UNAVAILABLE: 'capability_unavailable',
  SESSION_NOT_ADMITTED: 'session_not_admitted',
  USER_REJECTED: 'user_rejected',
  TIMEOUT: 'timeout',
  TRANSACTION_REJECTED: 'transaction_rejected',
  BRIDGE_ERROR: 'bridge_error',
});

const CAPABILITIES = new Set(Object.values(WalletCapability));
const MAX_SAFE_BASE_UNITS = Number.MAX_SAFE_INTEGER;
const MAX_MEMO_LENGTH = 256;
const MAX_CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;
const MAX_TRANSACTION_RECORDS = 100;

export class WalletClientError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WalletClientError';
    this.code = code;
  }
}

function error(code, message) {
  return new WalletClientError(code, message);
}

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw error(WalletErrorCode.INVALID_ARGUMENT, `${name} must be an object.`);
  }
  return value;
}

function boundedString(value, name, { min = 1, max = 255, pattern } = {}) {
  if (typeof value !== 'string') {
    throw error(WalletErrorCode.INVALID_ARGUMENT, `${name} must be a string.`);
  }
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max ||
      (pattern && !pattern.test(normalized))) {
    throw error(WalletErrorCode.INVALID_ARGUMENT, `${name} is invalid.`);
  }
  return normalized;
}

/**
 * Performs syntax and size checks only. The native wallet remains the final
 * authority for whether an address exists or is valid for the active chain.
 */
export function normalizeUsernodeAddress(value) {
  return boundedString(value, 'address', {
    min: 11,
    max: 255,
    pattern: /^ut1[0-9a-z]+$/,
  });
}

/**
 * Converts a positive integer base-unit value to the Number shape accepted by
 * every current bridge transport. Values above MAX_SAFE_INTEGER are rejected
 * rather than silently rounded by QR/JSON transports.
 */
export function normalizeBaseUnitAmount(value) {
  let number;
  if (typeof value === 'bigint') {
    if (value > BigInt(MAX_SAFE_BASE_UNITS)) {
      throw error(WalletErrorCode.INVALID_ARGUMENT, 'amount exceeds the safe bridge range.');
    }
    number = Number(value);
  } else if (typeof value === 'string') {
    if (!/^[0-9]+$/.test(value)) {
      throw error(WalletErrorCode.INVALID_ARGUMENT, 'amount must be positive integer base units.');
    }
    number = Number(value);
  } else {
    number = value;
  }
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw error(WalletErrorCode.INVALID_ARGUMENT, 'amount must be positive integer base units.');
  }
  return number;
}

function normalizeOrigin(value) {
  const origin = boundedString(value, 'origin', { max: 2048 });
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw error(WalletErrorCode.INVALID_ARGUMENT, 'origin is invalid.');
  }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== origin ||
      parsed.username || parsed.password) {
    throw error(WalletErrorCode.INVALID_ARGUMENT, 'origin must be an HTTP(S) origin without a path.');
  }
  return parsed.origin;
}

function normalizeDate(value, name) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw error(WalletErrorCode.INVALID_ARGUMENT, `${name} is invalid.`);
  }
  return date;
}

/**
 * Creates the exact deterministic message to sign. The nonce must be issued
 * by an authenticated backend; this helper intentionally never invents one.
 */
export function createSigningChallenge(input, { now = new Date() } = {}) {
  const value = requireObject(input, 'challenge');
  const origin = normalizeOrigin(value.origin);
  const purpose = boundedString(value.purpose, 'purpose', {
    max: 64,
    pattern: /^[a-z0-9][a-z0-9._:-]*$/,
  });
  const nonce = boundedString(value.nonce, 'nonce', {
    min: 22,
    max: 128,
    pattern: /^[A-Za-z0-9_-]+$/,
  });
  const issuedAt = normalizeDate(value.issuedAt, 'issuedAt');
  const expiresAt = normalizeDate(value.expiresAt, 'expiresAt');
  const current = normalizeDate(now, 'now');
  const lifetime = expiresAt.getTime() - issuedAt.getTime();
  if (lifetime <= 0 || lifetime > MAX_CHALLENGE_LIFETIME_MS) {
    throw error(WalletErrorCode.INVALID_ARGUMENT, 'challenge lifetime must be between 1 ms and 5 minutes.');
  }
  if (issuedAt.getTime() > current.getTime() + 60_000) {
    throw error(WalletErrorCode.INVALID_ARGUMENT, 'challenge issuedAt is too far in the future.');
  }
  if (expiresAt.getTime() <= current.getTime()) {
    throw error(WalletErrorCode.INVALID_ARGUMENT, 'challenge has expired.');
  }
  const subject = boundedString(value.subject, 'subject', { max: 128 });
  const payload = Object.freeze({
    schema: 'usernode-wallet-challenge/v1',
    origin,
    purpose,
    nonce,
    subject,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
  return Object.freeze({ payload, message: JSON.stringify(payload) });
}

export function transactionId(value) {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized && normalized.length <= 255 ? normalized : null;
  }
  if (!value || typeof value !== 'object') return null;
  const candidates = [
    value.txId, value.tx_id, value.txid, value.hash, value.txHash,
    value.tx_hash, value.id,
  ];
  if (value.tx && typeof value.tx === 'object') {
    candidates.push(
      value.tx.txId, value.tx.tx_id, value.tx.txid, value.tx.hash,
      value.tx.txHash, value.tx.tx_hash, value.tx.id
    );
  }
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const normalized = candidate.trim();
      if (normalized && normalized.length <= 255) return normalized;
    }
  }
  return null;
}

function pick(value, names) {
  for (const name of names) {
    if (value[name] != null) return value[name];
  }
  return null;
}

function safeString(value, max) {
  if (typeof value === 'string') return value.length <= max ? value : value.slice(0, max);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return String(value);
  return null;
}

export function normalizeTransactionRecord(value) {
  requireObject(value, 'transaction record');
  const txId = transactionId(value);
  const amount = pick(value, ['amount', 'baseUnits', 'base_units']);
  const blockHeight = pick(value, ['blockHeight', 'block_height']);
  return Object.freeze({
    txId,
    from: safeString(pick(value, ['from', 'source', 'from_pubkey']), 255),
    to: safeString(pick(value, ['to', 'destination', 'destination_pubkey']), 255),
    amount: safeString(amount, 100),
    memo: safeString(value.memo, MAX_MEMO_LENGTH),
    status: safeString(pick(value, ['onChainStatus', 'on_chain_status', 'status']), 64) || 'unknown',
    blockHeight: Number.isFinite(Number(blockHeight)) ? Number(blockHeight) : null,
    sentAt: safeString(pick(value, ['sentAt', 'sent_at', 'createdAt', 'created_at', 'timestamp']), 100),
    confirmedAt: safeString(pick(value, ['confirmedAt', 'confirmed_at']), 100),
  });
}

function recordRank(record) {
  const confirmed = record.status === 'confirmed' || record.confirmedAt != null ||
    record.blockHeight != null;
  return (confirmed ? 100 : 0) + Object.values(record).filter((v) => v != null).length;
}

/**
 * Deduplicates only records carrying the same concrete transaction ID. Idless
 * records remain distinct because guessing by amount/address/time can merge
 * unrelated transfers.
 */
export function reconcileTransactionRecords(records) {
  if (!Array.isArray(records)) {
    throw error(WalletErrorCode.INVALID_ARGUMENT, 'transaction records must be an array.');
  }
  if (records.length > MAX_TRANSACTION_RECORDS) {
    throw error(WalletErrorCode.INVALID_ARGUMENT, 'transaction records exceed the 100-item bridge limit.');
  }
  const output = [];
  const indexes = new Map();
  let duplicates = 0;
  for (const raw of records) {
    const record = normalizeTransactionRecord(raw);
    if (!record.txId || !indexes.has(record.txId)) {
      if (record.txId) indexes.set(record.txId, output.length);
      output.push(record);
      continue;
    }
    duplicates += 1;
    const index = indexes.get(record.txId);
    const old = output[index];
    const preferred = recordRank(record) >= recordRank(old) ? record : old;
    const fallback = preferred === record ? old : record;
    output[index] = Object.freeze(Object.fromEntries(
      Object.keys(preferred).map((key) => [key, preferred[key] == null ? fallback[key] : preferred[key]])
    ));
  }
  return Object.freeze({ items: Object.freeze(output), duplicates });
}

function requestedCapabilities(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw error(WalletErrorCode.INVALID_ARGUMENT, 'capabilities must be a non-empty array.');
  }
  const result = [];
  for (const value of values) {
    if (!CAPABILITIES.has(value)) {
      throw error(WalletErrorCode.INVALID_ARGUMENT, `unknown wallet capability: ${String(value)}.`);
    }
    if (!result.includes(value)) result.push(value);
  }
  return Object.freeze(result);
}

function bridgeError(err) {
  const message = err && typeof err.message === 'string' ? err.message : '';
  if (/session|handoff|admission|not admitted/i.test(message)) {
    return error(WalletErrorCode.SESSION_NOT_ADMITTED, 'The wallet session is not admitted.');
  }
  if (/cancel|declin|reject.*user|user.*reject/i.test(message)) {
    return error(WalletErrorCode.USER_REJECTED, 'The user declined the wallet request.');
  }
  if (/timeout|timed out/i.test(message)) {
    return error(WalletErrorCode.TIMEOUT, 'The wallet request timed out.');
  }
  return error(WalletErrorCode.BRIDGE_ERROR, 'The wallet bridge request failed.');
}

function normalizeMemo(value) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > MAX_MEMO_LENGTH) {
    throw error(WalletErrorCode.INVALID_ARGUMENT, 'memo must be a string of at most 256 characters.');
  }
  return value;
}

function submissionResult(value) {
  if (value && typeof value === 'object' && (value.error || value.queued === false)) {
    throw error(WalletErrorCode.TRANSACTION_REJECTED, 'The wallet rejected the transaction.');
  }
  const candidate = value && typeof value === 'object' && value.tx ? value.tx : null;
  const transaction = candidate ? normalizeTransactionRecord(candidate) : null;
  const confirmed = transaction && (transaction.status === 'confirmed' ||
    transaction.confirmedAt != null || transaction.blockHeight != null);
  return Object.freeze({
    status: confirmed ? 'confirmed' : 'submitted',
    txId: transactionId(value),
    transaction,
  });
}

/**
 * Builds an API-minimized facade. The requested capability list reduces
 * accidental use by app code; it is not an authorization boundary. The
 * hosted bridge and native shell still enforce origin/session/capability
 * admission and user confirmation.
 */
export function createWalletClient({
  capabilities = [WalletCapability.ADDRESS],
  bridge = globalThis,
} = {}) {
  const requested = requestedCapabilities(capabilities);
  const requestedSet = new Set(requested);
  const usernode = bridge && bridge.usernode;

  async function call(fn, args) {
    if (typeof fn !== 'function') {
      throw error(WalletErrorCode.CAPABILITY_UNAVAILABLE, 'The requested wallet capability is unavailable.');
    }
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof WalletClientError) throw err;
      throw bridgeError(err);
    }
  }

  const client = {
    version: WALLET_CLIENT_VERSION,
    capabilities: requested,
    async availableCapabilities() {
      const native = !!(usernode && usernode.isNative);
      let advertised = [];
      if (native && typeof usernode.getBridgeInfo === 'function') {
        try {
          const info = await usernode.getBridgeInfo();
          if (info && Array.isArray(info.capabilities)) advertised = info.capabilities;
        } catch { /* capability discovery is best-effort and read-only */ }
      }
      const available = requested.filter((capability) => {
        if (capability === WalletCapability.ADDRESS) return typeof bridge.getNodeAddress === 'function';
        if (capability === WalletCapability.SEND) return typeof bridge.sendTransaction === 'function';
        if (capability === WalletCapability.SIGN) {
          return native && typeof bridge.signMessage === 'function' &&
            (advertised.length === 0 || advertised.includes('signMessage'));
        }
        if (capability === WalletCapability.STATE) {
          return native && typeof usernode.getWalletState === 'function' &&
            (advertised.length === 0 || advertised.includes('getWalletState'));
        }
        return native && typeof usernode.getTransactionRecords === 'function' &&
          (advertised.length === 0 || advertised.includes('getTransactionRecords'));
      });
      return Object.freeze({ transport: native ? 'native' : 'browser', available: Object.freeze(available) });
    },
  };

  if (requestedSet.has(WalletCapability.ADDRESS)) {
    client.getAddress = async () => {
      const value = await call(bridge.getNodeAddress, []);
      try {
        return normalizeUsernodeAddress(value);
      } catch {
        throw error(WalletErrorCode.INVALID_RESPONSE, 'The wallet returned an invalid address.');
      }
    };
  }

  if (requestedSet.has(WalletCapability.STATE)) {
    client.getState = async () => {
      const value = await call(usernode && usernode.getWalletState, []);
      if (!value || typeof value !== 'object') {
        throw error(WalletErrorCode.CAPABILITY_UNAVAILABLE, 'Wallet state is unavailable.');
      }
      let address;
      try {
        address = normalizeUsernodeAddress(value.address);
      } catch {
        throw error(WalletErrorCode.INVALID_RESPONSE, 'The wallet returned invalid state.');
      }
      return Object.freeze({
        address,
        balance: value.balance == null ? null : String(value.balance),
        tokenAmount: value.tokenAmount == null ? null : String(value.tokenAmount),
        tokenSymbol: typeof value.tokenSymbol === 'string' ? value.tokenSymbol.slice(0, 32) : null,
        lastUpdatedMs: Number.isFinite(Number(value.lastUpdatedMs)) ? Number(value.lastUpdatedMs) : null,
      });
    };
  }

  if (requestedSet.has(WalletCapability.TRANSACTIONS)) {
    client.getTransactions = async () => {
      const value = await call(usernode && usernode.getTransactionRecords, []);
      if (!value || !Array.isArray(value.items)) {
        throw error(WalletErrorCode.CAPABILITY_UNAVAILABLE, 'Transaction records are unavailable.');
      }
      return reconcileTransactionRecords(value.items);
    };
  }

  if (requestedSet.has(WalletCapability.SIGN)) {
    // Never accept a caller-supplied origin. Browser code cannot use the
    // convenience layer to ask for a signature branded as another origin.
    const clientOrigin = normalizeOrigin(globalThis.location && globalThis.location.origin);
    client.signChallenge = async (challenge) => {
      const input = { ...requireObject(challenge, 'challenge'), origin: clientOrigin };
      const prepared = createSigningChallenge(input);
      const signature = await call(bridge.signMessage, [prepared.message]);
      if (typeof signature !== 'string' || !signature.trim()) {
        throw error(WalletErrorCode.INVALID_RESPONSE, 'The wallet returned an invalid signature.');
      }
      return Object.freeze({ ...prepared, signature: signature.trim() });
    };
  }

  if (requestedSet.has(WalletCapability.SEND)) {
    client.send = async ({
      to,
      amount,
      memo: memoValue = '',
      waitForInclusion = false,
      timeoutMs,
      pollIntervalMs,
      forcePolling = false,
      confirmTitle,
      confirmSubtitle,
    } = {}) => {
      const destination = normalizeUsernodeAddress(to);
      const baseUnits = normalizeBaseUnitAmount(amount);
      const options = { waitForInclusion: waitForInclusion === true, forcePolling: forcePolling === true };
      if (timeoutMs != null) {
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
          throw error(WalletErrorCode.INVALID_ARGUMENT, 'timeoutMs must be between 1000 and 300000.');
        }
        options.timeoutMs = timeoutMs;
      }
      if (pollIntervalMs != null) {
        if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 250 || pollIntervalMs > 30_000) {
          throw error(WalletErrorCode.INVALID_ARGUMENT, 'pollIntervalMs must be between 250 and 30000.');
        }
        options.pollIntervalMs = pollIntervalMs;
      }
      if (confirmTitle != null) options.confirmTitle = boundedString(confirmTitle, 'confirmTitle', { max: 80 });
      if (confirmSubtitle != null) options.confirmSubtitle = boundedString(confirmSubtitle, 'confirmSubtitle', { max: 160 });
      const value = await call(bridge.sendTransaction, [destination, baseUnits, normalizeMemo(memoValue), options]);
      return submissionResult(value);
    };
  }

  return Object.freeze(client);
}
