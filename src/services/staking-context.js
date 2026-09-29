'use strict';

const { canonicalNativeSessionV2Network } = require('../config');

// Configuration only: the device reads epoch data directly from the public
// receiver. The server never receives a wallet or computes epoch statistics.
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

function createStakingContext(config, {
  read = fetchJson,
  now = Date.now,
  previewPlatformUrl = process.env.USERNODE_ENV === 'staging'
    ? process.env.USERNODE_PLATFORM_API_URL || process.env.USERNODE_PLATFORM_API_V1_URL : null,
} = {}) {
  let previewNetwork = null;
  let networkRequest = null;
  async function context() {
    let observabilityUrl;
    try {
      const url = new URL(config.stakingObservabilityUrl);
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
          || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
      observabilityUrl = url.origin;
    } catch {
      throw new StakingDataError(503, 'The epoch data service is not configured correctly.');
    }
    const chainId = config.nativeSessionV2Network?.chainId;
    if (chainId) return { chainId, observabilityUrl };
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
      return { chainId: previewNetwork.chainId, observabilityUrl };
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
        return { chainId: network.chainId, observabilityUrl };
      } catch {
        throw new StakingDataError(503, 'Could not read the preview network. Please retry.');
      }
    })().finally(() => { networkRequest = null; });
    return networkRequest;
  }
  return { context };
}

module.exports = { createStakingContext, StakingDataError };
