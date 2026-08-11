// Installed Usernode app version in the hamburger drawer footer (#1101).
//
// The drawer already distinguishes the deployed web platform SHA from the
// currently-open dApp SHA. Inside the native Usernode WebView there is a third
// independently released layer: the installed app binary. The native bridge's
// existing getSettingsState snapshot already carries exactly the two fields we
// need (`buildInfo.appVersion` + `buildInfo.buildNumber`), so this renderer is
// deliberately device-local — it never asks the platform server to guess which
// app build is hosting the page.
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

        // A cold native start can make the first settings read inconclusive.
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
        if (!(await NativeChrome.has('getSettingsState'))) return null;
        const state = await window.usernode.getSettingsState();
        const value = NativeAppVersion._format(state && state.buildInfo);
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
