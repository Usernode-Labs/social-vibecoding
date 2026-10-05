// A system-browser trip must retain the app account as an expectation, never
// move its session cookie or OAuth state into the browser's independent realm.
export async function openNativeSocialConnect({
  bridge, provider, accountId, origin, intent = 'connect',
}) {
  if (!['github', 'x'].includes(provider)
      || !['connect', 'refresh', 'replace'].includes(intent)
      || !Number.isSafeInteger(accountId) || accountId <= 0) {
    throw new Error(globalThis.PlatformI18n.t("settings:your_account_could_not_be_identified_reopen_sett_e3cdf105"));
  }
  if (typeof bridge?.openExternal !== 'function') {
    throw new Error(globalThis.PlatformI18n.t("settings:update_the_homeroom_app_to_open_account_connecti_bd710b81"));
  }
  const url = new URL(`/api/me/social-identities/${provider}/connect`, origin);
  url.searchParams.set('account', String(accountId));
  url.searchParams.set('intent', intent);
  try {
    const opened = await bridge.openExternal(url.href);
    if (opened !== true) throw new Error('browser_not_opened');
  } catch {
    throw new Error(globalThis.PlatformI18n.t("settings:could_not_open_your_browser_tap_connect_to_try_a_e647128b"));
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
