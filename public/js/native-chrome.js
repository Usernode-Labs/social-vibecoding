// Native chrome glue — the shared seam between SV's web chrome and the
// Usernode app's bridge (app-as-SV-chrome migration, see NATIVE-BRIDGE.md).
//
// Owns:
//   - a single cached `getBridgeInfo()` probe (NativeChrome.getInfo()) so
//     node-pill.js / wallet-sheet.js / settings.js don't each round-trip
//     the channel;
//   - the drawer's Profile row (#profile hash route, profile.js) — its
//     click-to-close wiring only. The row is visible to everyone, web
//     included: it is no longer gated on the bridge's getProfileInfo
//     capability, because /challenges-api/me/* scopes to the platform
//     session server-side and the screen works in any browser. The old
//     native-push Profile / App Settings rows are gone
//     (profile-and-settings-to-web migration): App Settings is now
//     capability-gated sections inside the Settings modal (settings.js);
//   - the platform-login handoff + node lifecycle orchestration (bridge
//     v4, thin-shell migration): on every shell boot with a live web
//     session, exchange the session cookie for a mobile bearer
//     (POST /api/v4/mobile/auth/from-session), hand it to the native app
//     via completeLogin when native is unauthenticated, then request node
//     start bound to the provisioned wallet. SV logout tears both down
//     (settings.js calls NativeChrome.handleWebLogout()).
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
      //
      // NO capability gate: the row used to be revealed only when the
      // bridge reported getProfileInfo, which kept the screen
      // unreachable in an ordinary browser. Since the topochain merge
      // the /challenges-api/me/* routes scope to the platform session
      // server-side (src/routes/topochain/mobile.js), so the screen
      // works identically on the web — the probe was the only thing
      // still hiding it. The anchor now ships visible in index.html;
      // this handler only wires the drawer-close behaviour.
      const row = document.getElementById('drawer-row-profile');
      if (!row) return;
      row.classList.remove('hidden');
      row.addEventListener('click', () => {
        if (window.App && App.HeaderMenu) App.HeaderMenu.close();
      });
    },

    // ── Platform login handoff + node lifecycle (bridge v4) ──────────

    // Guards against concurrent handoffs (boot + an auth-status event
    // arriving mid-run) and against re-requesting node start every event.
    _handoffRunning: false,
    _nodeStartRequested: false,

    // Boot-time orchestration. Runs once a web session exists (init()
    // defers it to the `sv:session` boot stage — the SPA also boots
    // anonymously now) and safe to call again later. Sequence:
    //   1. If native identity is already ready → just ensure the node is
    //      started with its wallet.
    //   2. Otherwise exchange the web session for a mobile bearer and run
    //      completeLogin; the native side provisions/imports the
    //      custodial wallet and resolves { phase, address }.
    //   3. Request node start bound to that wallet.
    // Every failure is a console.warn and a clean exit — the web shell
    // keeps working without the native side.
    async runLoginHandoff() {
      if (NativeChrome._handoffRunning) return;
      if (!(await NativeChrome.has('completeLogin'))) return;
      NativeChrome._handoffRunning = true;
      try {
        const status = await window.usernode.getAuthStatus().catch(() => null);
        if (status && status.phase === 'ready' && status.address) {
          await NativeChrome._ensureNodeStarted(status.address);
          return;
        }

        const res = await fetch('/api/v4/mobile/auth/from-session', {
          method: 'POST',
          credentials: 'same-origin',
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success || !data.token) {
          console.warn('[native-chrome] from-session exchange failed',
            res.status, data && data.error);
          return;
        }

        const result = await window.usernode.completeLogin({
          token: data.token,
          user: data.user || null,
        });
        if (result && result.address) {
          await NativeChrome._ensureNodeStarted(result.address);
        }
      } catch (e) {
        console.warn('[native-chrome] login handoff failed:',
          e && e.message ? e.message : e);
      } finally {
        NativeChrome._handoffRunning = false;
      }
    },

    async _ensureNodeStarted(address) {
      if (!address || NativeChrome._nodeStartRequested) return;
      if (!(await NativeChrome.has('startNode'))) return;
      NativeChrome._nodeStartRequested = true;
      try {
        await window.usernode.startNode({ address });
      } catch (e) {
        NativeChrome._nodeStartRequested = false;
        console.warn('[native-chrome] startNode failed:',
          e && e.message ? e.message : e);
      }
    },

    // Web logout teardown — called by settings.js before it clears the
    // web session and bounces to login.html. Best-effort and bounded so
    // logout never hangs on a wedged bridge.
    async handleWebLogout() {
      if (!(await NativeChrome.has('completeLogin'))) return;
      const bounded = (p) => Promise.race([
        p.catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
      NativeChrome._nodeStartRequested = false;
      if (window.usernode && typeof window.usernode.stopNode === 'function') {
        await bounded(window.usernode.stopNode());
      }
      if (window.usernode && typeof window.usernode.logout === 'function') {
        await bounded(window.usernode.logout());
      }
    },

    // ── First-run permissions step (thin-shell onboarding) ───────────
    //
    // Replaces the native onboarding permission screens: after the first
    // successful login handoff on a device, offer the exact-alarm /
    // battery-optimization prompts the node needs for block production.
    // One-shot per device (localStorage marker, set on dismiss either
    // way) — the same rows live permanently in Settings → Usernode app,
    // so skipping here loses nothing.
    _FIRST_RUN_KEY: 'sv:onboarding_permissions_done',

    _markFirstRunDone() {
      try { localStorage.setItem(NativeChrome._FIRST_RUN_KEY, '1'); } catch (_) {}
    },

    async maybeShowFirstRunPermissions() {
      try {
        if (localStorage.getItem(NativeChrome._FIRST_RUN_KEY) === '1') return;
      } catch (_) {}
      if (!window.PlatformUI || typeof PlatformUI.sheet !== 'function') return;
      if (!(await NativeChrome.has('getSettingsState'))) return;

      let state = null;
      try { state = await window.usernode.getSettingsState(); } catch (_) {}
      if (!state) return;
      const perms = state.permissions || {};
      const isAndroid = perms.platform === 'android';
      const needsAlarm = !perms.exactAlarmGranted;
      // Battery optimization is Android-only; iOS never shows that row.
      const needsBattery = isAndroid && perms.batteryOptDisabled !== true;
      if (!needsAlarm && !needsBattery) {
        NativeChrome._markFirstRunDone();
        return;
      }

      const el = (tag, cls, text) => {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
      };

      const panel = el('div', 'px-4 pb-5');
      panel.appendChild(el('div', 'text-lg font-bold py-3', 'Set up your device'));
      panel.appendChild(el('p', 'text-sm text-zinc-600 dark:text-zinc-400 mb-3',
        'Your node can produce blocks while the app is in the background. ' +
        'That needs permission to wake your device at exact slot times' +
        (isAndroid ? ' and freedom from battery optimization.' : '.')));

      const statusRow = (label, ok) => {
        const row = el('div', 'flex items-center gap-2 mt-1 text-sm');
        row.appendChild(el('span', 'w-2 h-2 rounded-full shrink-0 ' +
          (ok ? 'bg-emerald-500' : 'bg-amber-500')));
        row.appendChild(el('span', 'text-zinc-800 dark:text-zinc-200', label));
        row.appendChild(el('span', 'ml-auto text-xs ' + (ok
          ? 'text-emerald-600 dark:text-emerald-400'
          : 'text-amber-600 dark:text-amber-400'),
        ok ? 'Granted' : 'Not granted'));
        return row;
      };

      const body = el('div');
      panel.appendChild(body);

      let sheet = null;
      const render = (p) => {
        body.textContent = '';
        const alarmOk = !!p.exactAlarmGranted;
        const batteryOk = p.batteryOptDisabled === true;
        body.appendChild(statusRow(
          isAndroid ? 'Exact alarms' : 'Alarm permissions', alarmOk));
        if (isAndroid) body.appendChild(statusRow('Battery optimization', batteryOk));

        const btns = el('div', 'mt-4 space-y-2');
        if (!alarmOk) {
          const b = el('button', 'w-full rounded-lg bg-violet-600 ' +
            'hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white',
          'Grant permissions');
          b.addEventListener('click', async () => {
            b.disabled = true;
            try {
              const next = await window.usernode.requestPermissions();
              if (next && next.permissions) render(next.permissions);
            } catch (e) {
              console.warn('[native-chrome] requestPermissions failed:', e);
            } finally { b.disabled = false; }
          });
          btns.appendChild(b);
        }
        if (isAndroid && !batteryOk) {
          const b = el('button', 'w-full rounded-lg border border-zinc-300 ' +
            'dark:border-zinc-700 px-4 py-2 text-sm font-medium ' +
            'text-zinc-700 dark:text-zinc-200',
          'Open battery settings');
          b.addEventListener('click', () => {
            window.usernode.openBatterySettings().catch(() => {});
          });
          btns.appendChild(b);
        }
        const done = el('button', 'w-full px-4 py-2 text-sm ' +
          'text-zinc-500 dark:text-zinc-400',
        (alarmOk && (!isAndroid || batteryOk)) ? 'Done' : 'Skip for now');
        done.addEventListener('click', () => {
          if (sheet && sheet.dismiss) sheet.dismiss();
        });
        btns.appendChild(done);
        body.appendChild(btns);
      };

      render(perms);
      sheet = PlatformUI.sheet({
        contentEl: panel,
        onDismiss: () => NativeChrome._markFirstRunDone(),
      });
      // Kit unavailable (degraded shell) — don't retry every boot; the
      // permanent Settings rows remain the fallback.
      if (!sheet) NativeChrome._markFirstRunDone();
    },

    _initAuthStatusEvents() {
      // Late identity transitions (e.g. wallet provisioning finishing
      // after boot) surface as `usernode:auth-status` CustomEvents; a
      // ready identity with a wallet is the signal to request node start.
      window.addEventListener('usernode:auth-status', (e) => {
        const d = e && e.detail;
        if (d && d.phase === 'ready' && d.address) {
          NativeChrome._ensureNodeStarted(d.address);
        }
      });
    },

    init() {
      NativeChrome._initDrawerRows();
      NativeChrome._initAuthStatusEvents();
      // Anonymous SPA boot (fold-auth-pages-into-SPA): the login handoff
      // needs a live web session (the from-session exchange 401s without
      // one), so it waits for the session boot stage. `sv:session` fires
      // on every enterAuthed — including the waiting room, since wallet
      // provisioning and the node work for unreleased users too — and the
      // handoff self-guards against repeat runs. First-run permissions
      // ride behind the handoff so a fresh install sees login → wallet →
      // node → permissions in one flow.
      const runHandoff = () => NativeChrome.runLoginHandoff().then(
        () => NativeChrome.maybeShowFirstRunPermissions()
      );
      if (window.App && App.user) runHandoff();
      else document.addEventListener('sv:session', runHandoff);
    },
  };

  window.NativeChrome = NativeChrome;
  NativeChrome.init();
})();
