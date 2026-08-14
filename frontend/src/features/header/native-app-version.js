// Installed Flutter mobile-app version in the hamburger drawer footer (#1101).
//
// A Git SHA identifies the deployed platform version, while this value identifies
// the independently released binary hosting the WebView. New app builds put
// `appVersion` + `buildNumber` on the public getBridgeInfo response, which is
// readable from staging as well as production. Existing builds fall back to
// the same fields in their privileged getSettingsState snapshot. Neither path
// ever substitutes the currently-open dApp's commit hash.
//
// Like node-pill.js and wallet-sheet.js, this module owns a static, initially
// hidden row inside the React drawer island. It evaluates as part of the bundle
// but init() runs from the island's layout effect, after hydration has adopted
// that markup. Data is then written imperatively because other legacy modules
// still own sibling slots in the same subtree.
(function () {
  'use strict';

  const MAX_PART_LENGTH = 50;

  const NativeAppVersion = {
    _value: null,
    _inFlight: null,
    _bound: false,

    init() {
      if (!window.NativeChrome || !window.usernode ||
          window.usernode.isNative !== true) return;

      if (!NativeAppVersion._bound) {
        NativeAppVersion._bound = true;

        // A cold native start can make the first bridge read inconclusive.
        // Retry when the user next opens the only surface that displays the
        // value, without repeating a successful device-local read.
        window.addEventListener('usernode:header-menu-open', () => {
          if (!NativeAppVersion._value) NativeAppVersion.refresh();
        });

        // The native runtime also announces when its identity is ready. That
        // is the earliest useful automatic retry after a cold-start miss and
        // mirrors the recovery path used by Settings itself.
        window.addEventListener('usernode:auth-status', (event) => {
          if (event && event.detail && event.detail.phase === 'ready' &&
              !NativeAppVersion._value) {
            NativeAppVersion.refresh();
          }
        });
      }

      // Warm the footer in the background so the value is normally present
      // before the drawer is opened for the first time.
      NativeAppVersion.refresh();
    },

    refresh() {
      if (NativeAppVersion._value) {
        NativeAppVersion._render(NativeAppVersion._value);
        return Promise.resolve(NativeAppVersion._value);
      }
      if (NativeAppVersion._inFlight) return NativeAppVersion._inFlight;

      NativeAppVersion._inFlight = NativeAppVersion._read()
        .finally(() => { NativeAppVersion._inFlight = null; });
      return NativeAppVersion._inFlight;
    },

    async _read() {
      try {
        const info = await NativeChrome.getInfo();
        let value = NativeAppVersion._format(info);

        // Compatibility for installed app builds that predate build metadata
        // on getBridgeInfo. Production SV can read the older privileged
        // settings snapshot; staging cannot, and will begin rendering once the
        // paired Flutter change reaches the installed binary.
        const capabilities = info && Array.isArray(info.capabilities)
          ? info.capabilities : [];
        if (!value && capabilities.includes('getSettingsState') &&
            typeof window.usernode.getSettingsState === 'function') {
          const state = await window.usernode.getSettingsState();
          value = NativeAppVersion._format(state && state.buildInfo);
        }
        if (!value) return null;
        NativeAppVersion._value = value;
        NativeAppVersion._render(value);
        return value;
      } catch (_) {
        // Chrome reads are designed to degrade without breaking the web
        // shell. Keep the row hidden; the open/readiness hooks above retry.
        return null;
      }
    },

    _part(value) {
      if (typeof value !== 'string' && typeof value !== 'number') return '';
      return String(value).trim().slice(0, MAX_PART_LENGTH);
    },

    _format(buildInfo) {
      if (!buildInfo || typeof buildInfo !== 'object') return '';
      const version = NativeAppVersion._part(buildInfo.appVersion);
      if (!version) return '';
      const build = NativeAppVersion._part(buildInfo.buildNumber);
      return build ? `${version}/${build}` : version;
    },

    _render(value) {
      const row = document.getElementById('drawer-row-native-app-version');
      const slot = document.getElementById('native-app-version-slot');
      if (!row || !slot) return;
      // Native data is still an external input. textContent keeps it text even
      // if a malformed producer returns markup characters.
      slot.textContent = value;
      row.classList.remove('hidden');
    },
  };

  // The prerender pass evaluates this module graph in Node, so publication
  // must remain guarded just like the other drawer-owned modules.
  if (typeof window !== 'undefined') {
    window.NativeAppVersion = NativeAppVersion;
  }
})();
