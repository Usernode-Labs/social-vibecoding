'use strict';

// Read-only staging fixtures: no native bridge calls or wallet mutations.
const CHAIN = 'staking-preview-chain';
const WALLET = 'ut1stakingpreview000000000000000000000000';
function previewEpoch(epoch) {
  const number = epoch === 'current' ? 128 : Number(epoch);
  if (!Number.isInteger(number) || number < 0 || number > 128) return null;
  const complete = number < 128;
  return { chainId: CHAIN, wallet: WALLET, epoch: number, currentEpoch: 128, complete,
    counts: { won: complete ? 14 : 16, upcoming: complete ? 0 : 5,
      produced: complete ? 12 : 10, missed: complete ? 2 : 1, unobserved: 0, dropped: 0 },
    observability: { fixture: true, stats: { epoch: number }, slots: { obligations: [], fullResponseMarker: 'retained on device' } } };
}
module.exports = { CHAIN, WALLET, previewEpoch };
