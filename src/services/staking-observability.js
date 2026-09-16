'use strict';

const { canonicalNativeSessionV2Network } = require('../config');

// The configured observability receiver serves the deployment's admitted
// chain. Neither its origin nor the chain binding comes from a client URL.
class StakingDataError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'error',
    headers: { accept: 'application/json' } });
  if (!response.ok) throw new StakingDataError(502, 'Epoch data is temporarily unavailable.');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 8 * 1024 * 1024) throw new Error('Response too large');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

function createStakingObservability(config, {
  read = fetchJson,
  now = Date.now,
  previewPlatformUrl = process.env.USERNODE_ENV === 'staging'
    ? process.env.USERNODE_PLATFORM_API_URL || process.env.USERNODE_PLATFORM_API_V1_URL : null,
} = {}) {
  const inFlight = new Map();
  let previewNetwork = null;
  let networkRequest = null;
  async function context() {
    const chainId = config.nativeSessionV2Network?.chainId;
    if (!config.stakingObservabilityUrl) {
      throw new StakingDataError(503, 'Staking epoch data is not configured for this network.');
    }
    if (chainId) return { chainId };
    if (!previewPlatformUrl) {
      throw new StakingDataError(503, 'Staking epoch data is not configured for this network.');
    }
    // Preview environments are built by the deployed parent, not this PR.
    // Older parents do not inject the native chain ID. Their existing public
    // status endpoint reports the explorer's cached chain identity, so a
    // preview can bind its cache without guessing an ID or calling a node.
    // Only the identity is used here; epoch statistics still come solely
    // from the configured observability receiver.
    if (previewNetwork && now() - previewNetwork.checkedAt < 30000) {
      return { chainId: previewNetwork.chainId };
    }
    if (!networkRequest) networkRequest = (async () => {
      try {
        const url = new URL('/api/node-status/full', previewPlatformUrl);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
        const { explorer } = await read(url.toString());
        const network = canonicalNativeSessionV2Network(explorer?.chainId);
        if (!network || explorer.status !== 'ok' || !Number.isFinite(explorer.at)
            || now() - explorer.at > 120000 || explorer.at - now() > 30000) throw new Error();
        previewNetwork = { chainId: network.chainId, checkedAt: now() };
        return { chainId: network.chainId };
      } catch {
        throw new StakingDataError(503, 'Could not read the preview network. Please retry.');
      }
    })().finally(() => { networkRequest = null; });
    return networkRequest;
  }
  function upstream(path, parameters) {
    const url = new URL(config.stakingObservabilityUrl.replace(/\/+$/, '') + '/v1/observability/' + path);
    url.search = new URLSearchParams(parameters).toString();
    return read(url.toString());
  }
  async function epochs({ wallet, chainId, epoch }) {
    const binding = await context();
    if (chainId !== binding.chainId) throw new StakingDataError(409, 'The network changed. Refresh staking data.');
    if (typeof wallet !== 'string' || !/^(?:ut1|B62)[a-zA-Z0-9]{20,120}$/.test(wallet)) {
      throw new StakingDataError(400, 'A valid wallet address is required.');
    }
    const current = epoch === 'current';
    if (!current && (typeof epoch !== 'string' || !/^(0|[1-9]\d{0,8})$/.test(epoch))) {
      throw new StakingDataError(400, 'A valid epoch is required.');
    }
    const key = JSON.stringify([chainId, wallet, epoch]);
    if (inFlight.has(key)) return inFlight.get(key);
    const result = (async () => {
      const requested = current ? null : Number(epoch);
      const stats = await upstream('vrf/producer-stats', {
        sender: wallet, period: current ? 'current_epoch' : 'epoch',
        ...(current ? {} : { epoch }),
      });
      const number = stats.epoch;
      if (!Number.isInteger(number) || number < 0 || !Number.isInteger(stats.slots_per_epoch)
          || stats.slots_per_epoch <= 0 || !Number.isInteger(stats.current_slot)
          || !Number.isFinite(stats.generated_at_ms) || (!current && number !== requested)) {
        throw new StakingDataError(502, 'Epoch data is not available yet.');
      }
      const currentEpoch = Math.floor(stats.current_slot / stats.slots_per_epoch);
      if (number > currentEpoch) throw new StakingDataError(400, 'That epoch has not started yet.');
      const slots = await upstream('vrf/slots', { sender: wallet, epoch: String(number) });
      const start = number * stats.slots_per_epoch;
      const end = start + stats.slots_per_epoch - 1;
      const summary = slots.summary;
      const countFields = ['total', 'produced', 'missed', 'pending', 'dropped', 'unobserved'];
      const valid = slots.from_slot === start && slots.to_slot === end
        && slots.cache?.complete === true && stats.cache?.complete === true
        && slots.participant_count === 1 && Array.isArray(slots.obligations)
        && countFields.every((field) => Number.isSafeInteger(summary?.[field]) && summary[field] >= 0)
        && summary.total === slots.obligations.length
        && slots.obligations.every((slot) => slot.epoch === number && Number.isFinite(slot.slot_time_ms));
      const counts = valid ? {
        won: summary.total,
        upcoming: slots.obligations.filter((slot) => slot.status === 'pending' && slot.slot_time_ms > stats.generated_at_ms).length,
        produced: summary.produced, missed: summary.missed,
        unobserved: summary.unobserved, dropped: summary.dropped,
      } : null;
      // An ended epoch is permanent only after the receiver has closed the
      // entire range and resolved every obligation. Gaps stay refreshable.
      const complete = valid && number < currentEpoch
        && summary.pending === 0 && summary.unobserved === 0
        && stats.from_slot === start && stats.to_slot === end
        && stats.covered_slot_count === stats.slots_per_epoch
        && stats.receiver_observation_complete === true
        && Number.isInteger(stats.closed_through_slot) && stats.closed_through_slot >= end;
      // Preserve every upstream field, not just the four counters the card uses.
      return { chainId, wallet, epoch: number, currentEpoch, complete, counts,
        observability: { stats, slots } };
    })().catch((error) => {
      if (error instanceof StakingDataError) throw error;
      throw new StakingDataError(502, 'Epoch data is temporarily unavailable.');
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, result);
    return result;
  }
  return { context, epochs };
}

module.exports = { createStakingObservability, StakingDataError };
