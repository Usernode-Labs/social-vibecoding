import { createStore } from '../../lib/plain-store.js';
import { createEpochCache } from './staking-cache.js';

async function readJson(path, signal) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not load epoch data.');
  return data;
}

// Each opened Active sheet owns one history. Unmounting it on delegation or a
// wallet change cancels reads and fences late responses before they touch UI.
export function createStakingHistory(wallet, { read = readJson, cache = createEpochCache() } = {}) {
  const store = createStore({ chainId: null, currentEpoch: null, selectedEpoch: null,
    records: {}, errors: {}, loading: true, error: null });
  const controller = new AbortController();
  const pending = new Map();
  let disposed = false;
  let generation = 0;
  let refreshing = null;

  async function load(epoch, force = false) {
    if (disposed) return null;
    const { chainId, records } = store.get();
    if (!chainId) return null;
    if (!force && records[epoch]?.complete) return records[epoch];
    const key = `${generation}:${epoch}`;
    if (pending.has(key)) return pending.get(key);
    const version = generation;
    const current = () => !disposed && version === generation;
    const promise = (async () => {
      try {
        let data = epoch === 'current' ? null : await cache.get(chainId, wallet, epoch);
        if (!current()) return null;
        if (!data) {
          const params = new URLSearchParams({ wallet, chainId, epoch: String(epoch) });
          data = await read(`/api/me/staking/epochs?${params}`, controller.signal);
        }
        if (!current()) return null;
        if (data.chainId !== chainId || data.wallet !== wallet
            || !Number.isInteger(data.epoch) || data.epoch < 0
            || (epoch !== 'current' && data.epoch !== epoch)) {
          throw new Error('The wallet or network changed. Retry to refresh epoch data.');
        }
        if (data.complete) await cache.put(data);
        if (!current()) return null;
        const s = store.get();
        const errors = { ...s.errors }; delete errors[epoch]; delete errors[data.epoch];
        store.set({ records: { ...s.records, [data.epoch]: data }, errors });
        return data;
      } catch (error) {
        if (current()) store.set({ errors: { ...store.get().errors,
          [epoch]: error.message || 'Could not load epoch data.' } });
        return null;
      } finally { pending.delete(key); }
    })();
    pending.set(key, promise);
    return promise;
  }

  async function prefetchPrevious(epoch) {
    if (!disposed && epoch > 0) await load(epoch - 1);
  }

  function refresh() {
    if (disposed) return Promise.resolve();
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const context = await read('/api/me/staking/context', controller.signal);
        if (disposed) return;
        if (!context.chainId) throw new Error('The network is unavailable.');
        if (context.chainId !== store.get().chainId) {
          generation += 1;
          store.set({ chainId: context.chainId, currentEpoch: null, selectedEpoch: null,
            records: {}, errors: {}, loading: true, error: null });
        }
        const data = await load('current', true);
        if (disposed) return;
        if (!data) throw new Error(store.get().errors.current || 'Could not load the current epoch.');
        const s = store.get();
        // Follow an epoch rollover only while viewing the former current card.
        const selectedEpoch = s.selectedEpoch === null || s.selectedEpoch === s.currentEpoch
          ? data.epoch : s.selectedEpoch;
        store.set({ currentEpoch: data.epoch, selectedEpoch, loading: false, error: null });
        // The current response paints first. Only then warm its older neighbor.
        await prefetchPrevious(data.epoch);
        const selected = store.get().selectedEpoch;
        if (selected !== data.epoch && !store.get().records[selected]?.complete) await load(selected, true);
      } catch (error) {
        if (!disposed) store.set({ loading: false, error: error.message || 'Could not load epoch data.' });
      } finally { refreshing = null; }
    })();
    return refreshing;
  }

  return {
    store, refresh,
    async select(epoch) {
      const s = store.get();
      if (disposed || !Number.isInteger(epoch) || epoch < 0 || epoch > s.currentEpoch) return;
      store.set({ selectedEpoch: epoch });
      await load(epoch);
      await prefetchPrevious(epoch);
    },
    async retry() {
      const epoch = store.get().selectedEpoch;
      if (epoch === null) return refresh();
      await load(epoch, true);
      await prefetchPrevious(epoch);
    },
    dispose() { disposed = true; generation += 1; controller.abort(); },
  };
}
