// Import-free on purpose (a test loads this file on its own), so the three
// sentences a person can be shown come from the `PlatformI18n` global.
const message = (id) => globalThis.PlatformI18n.t(id);

// A system-browser trip must retain the app account as an expectation, never
// move its session cookie or OAuth state into the browser's independent realm.
export async function openNativeSocialConnect({
  bridge, provider, accountId, origin, intent = 'connect',
}) {
  if (!['github', 'x'].includes(provider)
      || !['connect', 'refresh', 'replace'].includes(intent)
      || !Number.isSafeInteger(accountId) || accountId <= 0) {
    throw new Error(message('settings:linkedAccounts.native.accountUnknown'));
  }
  if (typeof bridge?.openExternal !== 'function') {
    throw new Error(message('settings:linkedAccounts.native.updateApp'));
  }
  const url = new URL(`/api/me/social-identities/${provider}/connect`, origin);
  url.searchParams.set('account', String(accountId));
  url.searchParams.set('intent', intent);
  try {
    const opened = await bridge.openExternal(url.href);
    if (opened !== true) throw new Error('browser_not_opened');
  } catch {
    throw new Error(message('settings:linkedAccounts.native.browserNotOpened'));
  }
}

// Native foreground events refresh the original app session's proof. Keep
// listening after a cancellation too, so a later browser retry can complete.
export function watchSocialConnectReturn({ win, doc, refresh }) {
  let refreshing = false;
  let active = true;
  const onReturn = async () => {
    if (!active || doc.hidden || refreshing) return;
    refreshing = true;
    try { await refresh(); } finally { refreshing = false; }
  };
  win.addEventListener('focus', onReturn);
  doc.addEventListener('visibilitychange', onReturn);
  return () => {
    active = false;
    win.removeEventListener('focus', onReturn);
    doc.removeEventListener('visibilitychange', onReturn);
  };
}
