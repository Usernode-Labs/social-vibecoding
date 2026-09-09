'use strict';

const { z } = require('zod');
const nodeStatus = require('../node-status');

const PROTOCOL = 1;
const REQUEST_ID_RE = /^ndp_[A-Za-z0-9_-]{43}$/;
const MAX_ACCEPTED_EPOCH = 0xffff_fffd;

const canonicalRequestId = z.string().regex(REQUEST_ID_RE).refine((value) => {
  const encoded = value.slice(4);
  try {
    const decoded = Buffer.from(encoded, 'base64url');
    return decoded.length === 32 && decoded.toString('base64url') === encoded;
  } catch {
    return false;
  }
}, 'must contain a canonical 32-byte base64url value');

const policyRequestSchema = z.object({
  requestId: canonicalRequestId,
  delegated: z.boolean(),
}).strict();

class EpochDelegationError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'EpochDelegationError';
    this.status = status;
    this.code = code;
  }
}

function protocolError(status, code, message) {
  throw new EpochDelegationError(status, code, message);
}

async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  } finally {
    client.release();
  }
}

function canonicalEpoch(value) {
  const epoch = Number(value);
  return Number.isSafeInteger(epoch) && epoch >= 0 && epoch <= MAX_ACCEPTED_EPOCH
    ? epoch
    : null;
}

function formatCredential(row) {
  if (!row) {
    protocolError(401, 'invalid_native_delegation_credential', 'Unauthenticated.');
  }
  return Object.freeze({
    reference: row.credential_reference,
    generation: Number(row.credential_generation),
    userId: String(row.user_id),
    accountId: String(row.account_id),
    address: row.address,
    networkId: row.network_id,
    chainId: row.chain_id,
  });
}

function formatPolicyOperation(row, { replayed }) {
  return {
    requestId: row.request_id,
    requestRevision: String(row.id),
    delegated: !!row.delegated,
    changed: !!row.changed,
    acceptedEpoch: Number(row.accepted_epoch),
    effectiveEpoch: Number(row.effective_epoch),
    replayed,
  };
}

class EpochDelegationService {
  constructor({ pool, config, sampleEpoch = nodeStatus.sampleCanonicalEpoch }) {
    this.pool = pool;
    this.config = config;
    this.sampleEpoch = sampleEpoch;
  }

  _network() {
    const network = this.config.nativeSessionV2Network;
    if (!network || network.id !== 'testnet' || !network.chainId) {
      protocolError(503, 'native_delegation_unavailable', 'Native delegation is unavailable.');
    }
    return network;
  }

  async _sampleCanonicalEpoch() {
    const network = this._network();
    try {
      const sample = await this.sampleEpoch({
        rpcUrl: this.config.nodeRpcUrl,
        network,
      });
      const epoch = canonicalEpoch(sample && sample.epoch);
      if (epoch == null || sample.networkId !== network.id || sample.chainId !== network.chainId) {
        throw new Error('invalid canonical epoch sample');
      }
      return Object.freeze({ ...sample, epoch });
    } catch (error) {
      if (error instanceof EpochDelegationError) throw error;
      protocolError(503, 'node_epoch_unavailable', 'Canonical node epoch is temporarily unavailable.');
    }
  }

  async _loadCredential(client, { userId, mobileTokenId }) {
    const result = await client.query(
      `SELECT c.credential_reference, c.credential_generation, c.user_id,
              c.account_id, c.network_id, c.chain_id, a.address
         FROM native_session_credentials c
         JOIN mobile_auth_tokens t
           ON t.id = c.mobile_auth_token_id AND t.user_id = c.user_id
         JOIN onchain_accounts a
           ON a.id = c.account_id AND a.user_id = c.user_id
        WHERE c.mobile_auth_token_id = $1 AND c.user_id = $2
          AND c.state = 'valid' AND c.expires_at > NOW()
          AND t.ability = 'session' AND t.expires_at > NOW()
        FOR SHARE OF c`,
      [mobileTokenId, userId]
    );
    const { rows } = result;
    const credential = formatCredential(rows[0]);
    const network = this._network();
    if (credential.networkId !== network.id || credential.chainId !== network.chainId) {
      protocolError(409, 'native_delegation_network_mismatch', 'The native credential is bound to a different network.');
    }
    return credential;
  }

  async _findRequest(queryable, requestId) {
    const { rows } = await queryable.query(
      `SELECT p.id, p.request_id, p.credential_reference, p.credential_generation,
              p.user_id, p.account_id, p.account_address AS address,
              p.network_id, p.chain_id, p.delegated, p.changed, p.accepted_epoch,
              p.effective_epoch
         FROM native_epoch_delegation_policies p
        WHERE p.request_id = $1`,
      [requestId]
    );
    return rows[0] || null;
  }

  _replay(row, credential, delegated) {
    if (row.credential_reference !== credential.reference
        || Number(row.credential_generation) !== credential.generation
        || String(row.user_id) !== credential.userId
        || String(row.account_id) !== credential.accountId
        || row.address !== credential.address
        || row.network_id !== credential.networkId
        || row.chain_id !== credential.chainId
        || !!row.delegated !== delegated) {
      protocolError(409, 'native_delegation_request_conflict', 'The request id is already bound to a different policy.');
    }
    return formatPolicyOperation(row, { replayed: true });
  }

  async _lockFence(client, sample) {
    const { rows } = await client.query(
      `SELECT observed_epoch, cutover_epoch
         FROM native_epoch_delegation_fences
        WHERE network_id = $1 AND chain_id = $2
        FOR UPDATE`,
      [sample.networkId, sample.chainId]
    );
    const fence = rows[0];
    if (!fence || fence.cutover_epoch == null) {
      protocolError(503, 'native_delegation_cutover_missing', 'Native delegation cutover has not been established.');
    }
    return fence;
  }

  _assertFreshSample(sample, fence) {
    if (sample.epoch < Number(fence.observed_epoch)) {
      protocolError(503, 'node_epoch_sample_stale', 'The canonical node epoch advanced while the request was being accepted.');
    }
  }

  _assertCutoverActive(sample, fence) {
    if (sample.epoch < Number(fence.cutover_epoch)) {
      protocolError(503, 'native_delegation_cutover_pending', 'Native delegation cutover is not active yet.');
    }
  }

  async _advanceObservedEpoch(client, sample, fence) {
    if (sample.epoch === Number(fence.observed_epoch)) return;
    await client.query(
      `UPDATE native_epoch_delegation_fences
          SET observed_epoch = $3, updated_at = NOW()
        WHERE network_id = $1 AND chain_id = $2`,
      [sample.networkId, sample.chainId, sample.epoch]
    );
  }

  async setNativePolicy({ userId, mobileTokenId, body }) {
    const parsed = policyRequestSchema.safeParse(body);
    if (!parsed.success) {
      protocolError(422, 'invalid_native_delegation_request', 'The native delegation request is invalid.');
    }
    const request = parsed.data;
    const sample = await this._sampleCanonicalEpoch();

    return withTransaction(this.pool, async (client) => {
      const credential = await this._loadCredential(client, { userId, mobileTokenId });
      const fence = await this._lockFence(client, sample);
      this._assertFreshSample(sample, fence);
      this._assertCutoverActive(sample, fence);
      await this._advanceObservedEpoch(client, sample, fence);

      const replay = await this._findRequest(client, request.requestId);
      if (replay) {
        const operation = this._replay(replay, credential, request.delegated);
        return {
          ...await this._snapshot(client, credential, sample),
          operation,
        };
      }

      const target = await this._policyAt(client, credential, sample.epoch + 2);
      const changed = target.delegated !== request.delegated;

      const { rows } = await client.query(
        `INSERT INTO native_epoch_delegation_policies
           (request_id, source, credential_reference, credential_generation, user_id,
            account_id, account_address, network_id, chain_id, delegated,
            changed, accepted_epoch, effective_epoch, accepted_at)
         VALUES ($1, 'native', $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 $11::bigint, $11::bigint + 2, NOW())
         RETURNING id, request_id, credential_reference, credential_generation,
                   user_id, account_id, account_address AS address,
                   network_id, chain_id, delegated, changed,
                   accepted_epoch, effective_epoch`,
        [request.requestId, credential.reference, credential.generation,
          credential.userId, credential.accountId, credential.address,
          credential.networkId, credential.chainId, request.delegated,
          changed, sample.epoch]
      );
      return {
        ...await this._snapshot(client, credential, sample),
        operation: formatPolicyOperation(rows[0], { replayed: false }),
      };
    });
  }

  async _policyAt(client, credential, epoch) {
    const { rows } = await client.query(
      `SELECT p.delegated
         FROM native_epoch_delegation_policies p
        WHERE p.account_address = $1
          AND p.network_id = $2 AND p.chain_id = $3
          AND p.effective_epoch <= $4
        ORDER BY p.effective_epoch DESC, p.id DESC
        LIMIT 1`,
      [credential.address, credential.networkId, credential.chainId, epoch]
    );
    const row = rows[0];
    return {
      epoch,
      delegated: row ? !!row.delegated : false,
    };
  }

  async _maxPolicyRevision(client, credential) {
    const { rows } = await client.query(
      `SELECT COALESCE(MAX(id), 0)::text AS policy_revision
         FROM native_epoch_delegation_policies
        WHERE network_id = $1 AND chain_id = $2`,
      [credential.networkId, credential.chainId]
    );
    return rows[0]?.policy_revision || '0';
  }

  async _snapshot(queryable, credential, sample) {
    const epochs = [];
    for (const epoch of [sample.epoch, sample.epoch + 1, sample.epoch + 2]) {
      // eslint-disable-next-line no-await-in-loop
      epochs.push(await this._policyAt(queryable, credential, epoch));
    }
    const policyRevision = await this._maxPolicyRevision(queryable, credential);
    return {
      protocol: PROTOCOL,
      policyRevision,
      credentialReference: credential.reference,
      credentialGeneration: credential.generation,
      account: {
        accountId: credential.accountId,
        address: credential.address,
      },
      network: {
        id: credential.networkId,
        chainId: credential.chainId,
      },
      observedEpoch: sample.epoch,
      epochs,
    };
  }

  async getNativePolicy({ userId, mobileTokenId }) {
    const sample = await this._sampleCanonicalEpoch();
    return withTransaction(this.pool, async (client) => {
      const credential = await this._loadCredential(client, { userId, mobileTokenId });
      const fence = await this._lockFence(client, sample);
      this._assertFreshSample(sample, fence);
      this._assertCutoverActive(sample, fence);
      await this._advanceObservedEpoch(client, sample, fence);
      return this._snapshot(client, credential, sample);
    });
  }

  async _managedAssignmentAt(client, network, epoch) {
    const { rows } = await client.query(
      `SELECT latest.address
         FROM (
           SELECT DISTINCT ON (p.account_address)
                  p.account_address AS address, p.delegated,
                  p.effective_epoch, p.id
             FROM native_epoch_delegation_policies p
            WHERE p.network_id = $1 AND p.chain_id = $2
              AND p.effective_epoch <= $3
            ORDER BY p.account_address, p.effective_epoch DESC, p.id DESC
         ) latest
        WHERE latest.delegated = TRUE
        ORDER BY latest.address`,
      [network.id, network.chainId, epoch]
    );
    return {
      epoch,
      accounts: rows.map((row) => ({ account: row.address })),
    };
  }

  async getManagedAssignments() {
    const network = this._network();
    const sample = await this._sampleCanonicalEpoch();
    return withTransaction(this.pool, async (client) => {
      const fence = await this._lockFence(client, sample);
      this._assertFreshSample(sample, fence);
      this._assertCutoverActive(sample, fence);
      await this._advanceObservedEpoch(client, sample, fence);
      const current = await this._managedAssignmentAt(client, network, sample.epoch);
      const next = await this._managedAssignmentAt(client, network, sample.epoch + 1);
      const boundary = await this._managedAssignmentAt(client, network, sample.epoch + 2);
      return { success: true, epochs: [current, next, boundary] };
    });
  }
}

module.exports = {
  policyRequestSchema,
  EpochDelegationError,
  EpochDelegationService,
};
