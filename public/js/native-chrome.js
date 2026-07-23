// Native chrome glue — the shared seam between SV's web chrome and the
// Usernode app's bridge (app-as-SV-chrome migration, see NATIVE-BRIDGE.md).
//
// Owns:
//   - a single cached `getBridgeInfo()` probe (NativeChrome.getInfo()) so
//     node-pill.js / wallet-sheet.js don't each round-trip the channel;
//   - the drawer's native-only rows (Profile / App Settings), which push
//     allowlisted native screens via `usernode.openNativeScreen`.
//
// Everything here is capability-gated: on desktop, in child-app iframes,
// and on old app builds the probe resolves { version: 0, capabilities: [] }
// and no UI appears.
(function () {
  'use strict';

  const NativeChrome = {
    _infoPromise: null,

    // Resolves { version, capabilities: [...] } — never rejects.
    getInfo() {
      if (NativeChrome._infoPromise) return NativeChrome._infoPromise;
      const bridge = window.usernode;
      if (!bridge || !bridge.isNative ||
          typeof bridge.getBridgeInfo !== 'function') {
        NativeChrome._infoPromise =
          Promise.resolve({ version: 0, capabilities: [] });
      } else {
        NativeChrome._infoPromise = bridge.getBridgeInfo().catch(() => (
          { version: 0, capabilities: [] }
        ));
      }
      return NativeChrome._infoPromise;
    },

    async has(capability) {
      const info = await NativeChrome.getInfo();
      return Array.isArray(info.capabilities) &&
        info.capabilities.includes(capability);
    },

    async _initDrawerRows() {
      if (!(await NativeChrome.has('openNativeScreen'))) return;
      const wire = (rowId, screen) => {
        const row = document.getElementById(rowId);
        if (!row) return;
        row.classList.remove('hidden');
        row.addEventListener('click', () => {
          if (window.App && App.HeaderMenu) App.HeaderMenu.close();
          window.usernode.openNativeScreen(screen).catch((err) => {
            console.warn('[native-chrome] openNativeScreen failed:', err);
            if (window.PlatformUI) {
              PlatformUI.toast('Could not open the native screen');
            }
          });
        });
      };
      wire('drawer-row-native-profile', 'profile');
      wire('drawer-row-native-settings', 'settings');
    },

    init() {
      NativeChrome._initDrawerRows();
    },
  };

  window.NativeChrome = NativeChrome;
  NativeChrome.init();
})();
