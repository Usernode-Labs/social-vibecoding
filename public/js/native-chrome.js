// Native chrome glue — the shared seam between SV's web chrome and the
// Usernode app's bridge (app-as-SV-chrome migration, see NATIVE-BRIDGE.md).
//
// Owns:
//   - a single cached `getBridgeInfo()` probe (NativeChrome.getInfo()) so
//     node-pill.js / wallet-sheet.js / settings.js don't each round-trip
//     the channel;
//   - the drawer's Profile row (#profile hash route, profile.js), shown
//     when the bridge reports getProfileInfo. The old native-push
//     Profile / App Settings rows are gone (profile-and-settings-to-web
//     migration): App Settings is now capability-gated sections inside
//     the Settings modal (settings.js).
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
      // The Profile row is a plain #profile anchor; hash navigation
      // drives the screen (App.navigateToProfile), the click handler
      // only closes the drawer — same wiring as the Challenges row.
      if (!(await NativeChrome.has('getProfileInfo'))) return;
      const row = document.getElementById('drawer-row-profile');
      if (!row) return;
      row.classList.remove('hidden');
      row.addEventListener('click', () => {
        if (window.App && App.HeaderMenu) App.HeaderMenu.close();
      });
    },

    init() {
      NativeChrome._initDrawerRows();
    },
  };

  window.NativeChrome = NativeChrome;
  NativeChrome.init();
})();
