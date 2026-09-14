import { createStore } from '../../lib/plain-store.js';

export const appAllowanceStore = createStore({ quota: null, requestedAt: null, loading: false, error: '' });
let pending = null;
let revision = 0;

function normalizeQuota(raw) {
  if (!raw) return null;
  const validCount = (value) => value === null || (Number.isInteger(value) && value >= 0);
  if (!validCount(raw.used) || !validCount(raw.limit) || !validCount(raw.remaining)) return null;
  return { used: raw.used, limit: raw.limit, remaining: raw.remaining };
}

export function seedAppAllowance(user) {
  revision++;
  pending = null;
  appAllowanceStore.set({
    quota: normalizeQuota(user?.appCreationQuota),
    requestedAt: user?.appQuotaRequestedAt || null,
    loading: false,
    error: '',
  });
}

function publish(data) {
  const quota = normalizeQuota(data?.quota);
  if (!quota) throw new Error('Could not load your app allowance.');
  appAllowanceStore.set({ quota, requestedAt: data.requestedAt || null, error: '' });
  if (typeof window !== 'undefined' && window.App?.user) {
    Object.assign(window.App.user, {
      appCreationQuota: quota,
      appQuotaRequestedAt: data.requestedAt || null,
      canCreateApps: data.canCreateApps,
    });
    window.HomePanels?.render?.();
  }
  return data;
}

export function refreshAppAllowance(fetcher = (url, init) => fetch(url, init)) {
  if (pending) return pending;
  const current = revision;
  appAllowanceStore.set({ loading: true });
  pending = (async () => {
    try {
      const res = await fetcher('/api/me/app-allowance', { credentials: 'same-origin', cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load your app allowance.');
      if (current === revision) publish(data);
    } catch (err) {
      if (current === revision) appAllowanceStore.set({ error: err.message || 'Could not load your app allowance.' });
    } finally {
      if (current === revision) {
        pending = null;
        appAllowanceStore.set({ loading: false });
      }
    }
  })();
  return pending;
}

export function invalidateAppAllowance() {
  revision++;
  pending = null;
  return refreshAppAllowance();
}

export async function requestMoreApps(fetcher = (url, init) => fetch(url, init)) {
  // Discard a GET started before the mutation, which could otherwise replace
  // the successful pending state with its earlier "no request" snapshot.
  const current = ++revision;
  pending = null;
  appAllowanceStore.set({ loading: false });
  const res = await fetcher('/api/me/app-allowance/request', { method: 'POST', credentials: 'same-origin' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Could not send your request.');
  if (current === revision) {
    revision++;
    pending = null;
    appAllowanceStore.set({ loading: false });
    publish(data);
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined'
    && typeof document.addEventListener === 'function' && typeof window.addEventListener === 'function') {
  window.UsernodeReact = window.UsernodeReact || {};
  window.UsernodeReact.appAllowance = { refresh: refreshAppAllowance, invalidate: invalidateAppAllowance };
  document.addEventListener('sv:session', (event) => seedAppAllowance(event.detail?.user));
  const refreshIfSignedIn = () => {
    if (window.App?.user && !window.App?._sessionFromSnapshot) void refreshAppAllowance();
  };
  window.addEventListener('focus', refreshIfSignedIn);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshIfSignedIn();
  });
}
