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
//     session, always exchange the session cookie for a fresh mobile bearer
//     (POST /api/v4/mobile/auth/from-session), hand it to the native app
//     via completeLogin, then request node start bound to the current native
//     participant + identity epoch. SV logout crosses one hard native boundary
//     (settings.js prepares, commits its web cleanup, then calls the terminal
//     NativeChrome.commitNativeLogout()).
//
// Everything here is capability-gated: on desktop, in child-app iframes,
// and on old app builds the probe resolves { version: 0, capabilities: [] }
// and no UI appears.
(function () {
  'use strict';

  const NativeChrome = {
    _infoPromise: null,

    // Resolves { version, capabilities: [...], appVersion?, buildNumber? }
    // — never rejects. The optional pair identifies the installed Flutter
    // binary on app builds that advertise it through the public probe.
    //
    // Concurrent callers share ONE in-flight probe, but a DEGRADED answer
    // (the bridge's marker for a probe that timed out or errored inside
    // the app) is never memoised: caching it would hide every
    // capability-gated row — the Settings → Usernode app section included —
    // for the rest of the document over one cold-start hiccup (issue #978).
    // Same discipline prepareWebLogout() already applies to a version-0
    // probe below.
    getInfo() {
      if (NativeChrome._infoPromise) return NativeChrome._infoPromise;
      const bridge = window.usernode;
      if (!bridge || !bridge.isNative ||
          typeof bridge.getBridgeInfo !== 'function') {
        NativeChrome._infoPromise =
          Promise.resolve({ version: 0, capabilities: [] });
        return NativeChrome._infoPromise;
      }
      const probe = bridge.getBridgeInfo().catch(() => (
        { version: 0, capabilities: [], degraded: true }
      )).then((info) => {
        if (info && info.degraded === true &&
            NativeChrome._infoPromise === probe) {
          NativeChrome._infoPromise = null;
        }
        return info;
      });
      NativeChrome._infoPromise = probe;
      return probe;
    },

    async has(capability) {
      const info = await NativeChrome.getInfo();
      return Array.isArray(info.capabilities) &&
        info.capabilities.includes(capability);
    },

    // Why the last native chrome read of `method` came back empty. The
    // bridge's reads resolve a fallback instead of rejecting (so callers
    // can always await and render "unavailable"), and park the reason
    // here: { method, kind, message, at } or null. One accessor so
    // settings.js and maybeShowFirstRunPermissions report identically.
    lastReadError(method) {
      const bridge = window.usernode;
      if (!bridge || typeof bridge.getLastNativeReadError !== 'function') {
        return null;
      }
      try {
        return bridge.getLastNativeReadError(method) || null;
      } catch (_) {
        return null;
      }
    },

    // ── Session-admission failure record ─────────────────────────────
    //
    // The admission paths below fail by console.warn + clean exit, which
    // is right for the shell (it keeps working without the native side)
    // but leaves the user staring at "Finishing secure app sign-in…"
    // forever with nothing to report. Park the last reason here so the
    // Settings diagnostics panel can name it. Same discipline and same
    // shape as lastReadError(): a stage, the message, an optional
    // machine-readable code from the app, and when.
    _lastSessionFailure: null,

    _recordSessionFailure(stage, error) {
      const message = (error && error.message)
        ? String(error.message)
        : (typeof error === 'string' ? error : null);
      NativeChrome._lastSessionFailure = {
        stage,
        message,
        code: (error && typeof error.usernodeCode === 'string')
          ? error.usernodeCode : null,
        kind: (error && typeof error.usernodeKind === 'string')
          ? error.usernodeKind : null,
        at: Date.now(),
      };
      return NativeChrome._lastSessionFailure;
    },

    // { stage, message, code, kind, at } or null when the last admission
    // attempt succeeded (or none has run). Copied on the way out.
    lastSessionFailure() {
      const rec = NativeChrome._lastSessionFailure;
      if (!rec) return null;
      return {
        stage: rec.stage,
        message: rec.message,
        code: rec.code,
        kind: rec.kind,
        at: rec.at,
      };
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
      row.addEventListener('click', () => {
        if (window.App && App.HeaderMenu) App.HeaderMenu.close();
      });
    },

    // ── Platform login handoff + node lifecycle (bridge v4) ──────────

    // Overlapping boot/session signals share one authoritative exchange. If
    // the web participant changes while it is running, the latest session is
    // exchanged once the active run settles.
    _handoffPromise: null,
    _handoffRerunRequested: false,
    _handoffGeneration: 0,
    _nodeStartKey: null,
    _nodeStartInFlight: null,
    _logoutRunning: false,
    _authenticatedSessionAdmitted: true,
    _authenticatedSessionKey: null,
    _sessionWalletRelayAdmitted: true,

    isSessionAdmitted() {
      return NativeChrome._authenticatedSessionAdmitted === true;
    },

    _participantId(value) {
      const id = Number(value);
      return Number.isSafeInteger(id) && id > 0 ? id : null;
    },

    _webParticipantId() {
      return NativeChrome._participantId(
        window.App && App.user ? App.user.id : null
      );
    },

    _isCurrentWebParticipant(participantId, generation) {
      return !NativeChrome._logoutRunning &&
        NativeChrome._handoffGeneration === generation &&
        NativeChrome._webParticipantId() === participantId;
    },

    _boundReadyStatus(value, expectedParticipantId) {
      if (!value || value.phase !== 'ready' || !value.address) return null;
      const participantId = NativeChrome._participantId(value.participantId);
      const epoch = Number(value.epoch);
      if (participantId !== expectedParticipantId ||
          !Number.isSafeInteger(epoch) || epoch < 0) return null;
      return { address: value.address, participantId, epoch };
    },

    _boundAuthenticatedStatus(value, expectedParticipantId) {
      if (!value ||
          (value.phase !== 'reconciling' && value.phase !== 'ready')) {
        return null;
      }
      const participantId = NativeChrome._participantId(value.participantId);
      const epoch = Number(value.epoch);
      if (participantId !== expectedParticipantId ||
          !Number.isSafeInteger(epoch) || epoch < 0) return null;
      return { phase: value.phase, participantId, epoch };
    },

    _authenticatedStatusKey(status) {
      return status
        ? `${status.participantId}:${status.epoch}`
        : null;
    },

    _authenticatedStatusMatches(status) {
      return NativeChrome._authenticatedSessionAdmitted === true &&
        NativeChrome._authenticatedSessionKey ===
          NativeChrome._authenticatedStatusKey(status);
    },

    _setAuthenticatedSessionAdmission(admitted, status) {
      const next = admitted === true;
      const nextKey = next
        ? NativeChrome._authenticatedStatusKey(status)
        : null;
      const changed = NativeChrome._authenticatedSessionAdmitted !== next ||
        NativeChrome._authenticatedSessionKey !== nextKey;
      NativeChrome._authenticatedSessionAdmitted = next;
      NativeChrome._authenticatedSessionKey = nextKey;
      // Social push is bound to the authenticated participant, not to wallet
      // readiness. Notify it as soon as native accepts the bearer; wallet
      // consumers remain behind the separate relay admission below.
      if (changed && typeof window.dispatchEvent === 'function' &&
          typeof window.CustomEvent === 'function') {
        window.dispatchEvent(new CustomEvent(
          'usernode:native-session-admission', { detail: { admitted: next } }
        ));
      }
    },

    _setSessionWalletRelayAdmission(admitted) {
      const next = admitted === true;
      NativeChrome._sessionWalletRelayAdmitted = next;
      const bridge = window.usernode;
      if (bridge &&
          typeof bridge._setSessionWalletRelayAdmission === 'function') {
        bridge._setSessionWalletRelayAdmission(next);
      }
      const walletSheet = window.WalletSheet;
      if (walletSheet &&
          typeof walletSheet._setSessionWalletAdmission === 'function') {
        walletSheet._setSessionWalletAdmission(next);
      }
    },

    enterAnonymous() {
      NativeChrome._setAuthenticatedSessionAdmission(false);
      NativeChrome._setSessionWalletRelayAdmission(false);
      if (NativeChrome._logoutRunning) return Promise.resolve(false);
      const generation = ++NativeChrome._handoffGeneration;
      const isCurrentAnonymous = () =>
        !NativeChrome._logoutRunning &&
        NativeChrome._handoffGeneration === generation &&
        NativeChrome._webParticipantId() == null;
      return (async () => {
        const bridge = window.usernode;
        if (!bridge || bridge.isNative !== true) {
          if (!isCurrentAnonymous()) return false;
          NativeChrome._setAuthenticatedSessionAdmission(true);
          NativeChrome._setSessionWalletRelayAdmission(true);
          return true;
        }

        const info = await NativeChrome.getInfo();
        const capabilities = Array.isArray(info.capabilities)
          ? info.capabilities
          : [];
        if (capabilities.includes('enterAnonymousSession')) {
          if (!isCurrentAnonymous()) return false;
          if (typeof bridge.enterAnonymousSession !== 'function') {
            console.warn('[native-chrome] anonymous-session admission is unavailable');
            NativeChrome._recordSessionFailure('anonymous-admission',
              'Anonymous-session admission is unavailable on this app build');
            return false;
          }
          const admission = await bridge.enterAnonymousSession();
          if (!admission || admission.admitted !== true) {
            console.warn('[native-chrome] anonymous session was not admitted');
            NativeChrome._recordSessionFailure('anonymous-admission',
              'The Usernode app did not admit the anonymous session');
            return false;
          }
          if (!isCurrentAnonymous()) return false;
          NativeChrome._lastSessionFailure = null;
          NativeChrome._setAuthenticatedSessionAdmission(true);
          NativeChrome._setSessionWalletRelayAdmission(true);
          return true;
        }

        // Pre-v4 builds have no native handoff gate to acknowledge. Preserve
        // their existing local wallet behavior after a conclusive probe;
        // a v4/inconclusive native result stays fail-closed.
        const confirmedPreV4 = Number.isInteger(info.version) &&
          info.version > 0 && info.version < 4;
        if (confirmedPreV4 && isCurrentAnonymous()) {
          NativeChrome._setAuthenticatedSessionAdmission(true);
          NativeChrome._setSessionWalletRelayAdmission(true);
          return true;
        }
        return false;
      })().then((admitted) => {
        // Device permissions are not account-level: the iOS notification
        // prompt (and the Android alarm/battery asks) should reach
        // signed-out users too, so a settled anonymous session is a
        // first-run trigger just like the post-login handoff. The run is
        // shared/latched, so a login racing this cannot stack a second
        // sheet. In a plain browser the capability probe bails it out.
        if (admitted) NativeChrome.maybeShowFirstRunPermissions();
        return admitted;
      }).catch((error) => {
        console.warn('[native-chrome] anonymous-session admission failed:',
          error && error.message ? error.message : error);
        NativeChrome._recordSessionFailure('anonymous-admission', error);
        return false;
      });
    },

    // Boot-time orchestration. Runs once a web session exists (init()
    // defers it to the `sv:session` boot stage — the SPA also boots
    // anonymously now) and safe to call again later. Sequence:
    //   1. Close local wallet admission and, when supported, the native latch.
    //   2. Always exchange the current web session for a fresh mobile bearer.
    //   3. Verify the exchange still describes the current web participant.
    //   4. Run completeLogin, then start only the matching native
    //      participant + identity epoch. A cross-participant result asks the
    //      native runtime to restart; this document does no further work.
    // Every failure is a console.warn and a clean exit — the web shell
    // keeps working without the native side.
    runLoginHandoff() {
      // Close synchronously with the `sv:session` listener invocation. No
      // wallet read/sign/send may reach the previous native identity while
      // the new web participant is being exchanged and verified.
      NativeChrome._setAuthenticatedSessionAdmission(false);
      NativeChrome._setSessionWalletRelayAdmission(false);
      if (NativeChrome._logoutRunning) return Promise.resolve(null);
      if (NativeChrome._handoffPromise) {
        NativeChrome._handoffRerunRequested = true;
        return NativeChrome._handoffPromise;
      }
      const run = (async () => {
        let result = null;
        do {
          NativeChrome._handoffRerunRequested = false;
          const generation = ++NativeChrome._handoffGeneration;
          result = await NativeChrome._runLoginHandoff(generation);
          if (result && result.restarting === true) {
            // This document is terminal once native accepts a runtime
            // replacement. Ignore session signals queued while cleanup was
            // being admitted; the replacement WebView starts a fresh run.
            NativeChrome._handoffRerunRequested = false;
            break;
          }
        } while (NativeChrome._handoffRerunRequested &&
          !NativeChrome._logoutRunning);
        return result;
      })();
      const tracked = run.finally(() => {
        if (NativeChrome._handoffPromise === tracked) {
          NativeChrome._handoffPromise = null;
          NativeChrome._handoffRerunRequested = false;
        }
      });
      NativeChrome._handoffPromise = tracked;
      return tracked;
    },

    // A failed cold-start exchange leaves the native gate closed on purpose,
    // but the web session may remain healthy and emit no later auth change.
    // Foreground/network recovery signals therefore need an explicit retry.
    // Unlike a new `sv:session` signal, these retries do not request a second
    // pass when an authoritative handoff is already in flight.
    recoverSessionAdmission() {
      if (NativeChrome._logoutRunning ||
          NativeChrome._authenticatedSessionAdmitted) {
        return Promise.resolve(null);
      }
      if (NativeChrome._handoffPromise) return NativeChrome._handoffPromise;
      if (NativeChrome._webParticipantId() == null) {
        return NativeChrome.enterAnonymous();
      }
      return NativeChrome.runLoginHandoff();
    },

    async _runLoginHandoff(generation) {
      const info = await NativeChrome.getInfo();
      const capabilities = Array.isArray(info.capabilities)
        ? info.capabilities
        : [];
      if (!capabilities.includes('completeLogin')) {
        // Pre-v4 app builds have no platform-session handoff to verify. Keep
        // their existing wallet behavior only when a real older bridge version
        // confirms that absence. A version-0 timeout/fallback remains closed.
        const confirmedPreV4 = Number.isInteger(info.version) &&
          info.version > 0 && info.version < 4;
        if (confirmedPreV4 && !NativeChrome._logoutRunning &&
            !NativeChrome._handoffRerunRequested) {
          NativeChrome._setAuthenticatedSessionAdmission(true);
          NativeChrome._setSessionWalletRelayAdmission(true);
        }
        return null;
      }
      const webParticipantId = NativeChrome._webParticipantId();
      if (webParticipantId == null) return null;
      try {
        if (capabilities.includes('beginSessionHandoff')) {
          if (typeof window.usernode.beginSessionHandoff !== 'function') {
            console.warn('[native-chrome] session handoff latch is unavailable');
            NativeChrome._recordSessionFailure('login-handoff',
              'The session handoff latch is unavailable on this app build');
            return null;
          }
          const admission = await window.usernode.beginSessionHandoff();
          if (!admission || admission.blocked !== true) {
            console.warn('[native-chrome] native wallet handoff was not blocked');
            NativeChrome._recordSessionFailure('login-handoff',
              'The Usernode app did not block its wallet for the handoff');
            return null;
          }
          if (!NativeChrome._isCurrentWebParticipant(
            webParticipantId, generation
          )) return null;
        }
        const res = await fetch('/api/v4/mobile/auth/from-session', {
          method: 'POST',
          credentials: 'same-origin',
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success || !data.token) {
          console.warn('[native-chrome] from-session exchange failed',
            res.status, data && data.error);
          return null;
        }
        const exchangedParticipantId = NativeChrome._participantId(
          data.user && data.user.id
        );
        if (exchangedParticipantId !== webParticipantId ||
            !NativeChrome._isCurrentWebParticipant(
              webParticipantId, generation)) {
          console.warn('[native-chrome] stale or mismatched web session exchange');
          return null;
        }

        const result = await window.usernode.completeLogin({
          token: data.token,
          user: data.user || null,
        });
        if (result && result.restarting === true) return result;
        if (!NativeChrome._isCurrentWebParticipant(
          webParticipantId, generation)) return null;

        const sessionBound = await NativeChrome.has('sessionBoundAuthStatus');
        if (sessionBound) {
          const authenticatedStatus = NativeChrome._boundAuthenticatedStatus(
            result, webParticipantId
          );
          if (!authenticatedStatus) {
            console.warn('[native-chrome] native login result did not match '
              + 'the current participant/epoch');
            return null;
          }
          NativeChrome._setAuthenticatedSessionAdmission(
            true, authenticatedStatus
          );
          const readyStatus = NativeChrome._boundReadyStatus(
            result, webParticipantId
          );
          if (readyStatus) {
            await NativeChrome._ensureNodeStarted(readyStatus, generation);
            if (!NativeChrome._handoffRerunRequested &&
                NativeChrome._isCurrentWebParticipant(
              webParticipantId, generation
            ) && NativeChrome._authenticatedStatusMatches(
              authenticatedStatus
            )) {
              NativeChrome._setSessionWalletRelayAdmission(true);
            }
          }
        } else if (result && result.address) {
          // Compatibility for bridge v4 builds. New builds advertise
          // sessionBoundAuthStatus and take the participant/epoch path above.
          NativeChrome._setAuthenticatedSessionAdmission(true);
          await NativeChrome._ensureLegacyNodeStarted(
            result.address, webParticipantId, generation
          );
          if (!NativeChrome._handoffRerunRequested &&
              NativeChrome._isCurrentWebParticipant(
            webParticipantId, generation
          )) {
            NativeChrome._setSessionWalletRelayAdmission(true);
          }
        }
        return result || null;
      } catch (e) {
        console.warn('[native-chrome] login handoff failed:',
          e && e.message ? e.message : e);
        NativeChrome._recordSessionFailure('login-handoff', e);
        return null;
      }
    },

    _ensureNodeStarted(status, generation) {
      const key = `${status.participantId}:${status.epoch}:${status.address}`;
      return NativeChrome._startNodeOnce(
        key,
        {
          address: status.address,
          participantId: status.participantId,
          epoch: status.epoch,
        },
        status.participantId,
        generation
      );
    },

    _ensureLegacyNodeStarted(address, participantId, generation) {
      return NativeChrome._startNodeOnce(
        `legacy:${participantId}:${address}`,
        { address },
        participantId,
        generation
      );
    },

    _startNodeOnce(key, payload, participantId, generation) {
      if (!payload.address || !NativeChrome._isCurrentWebParticipant(
        participantId, generation)) return Promise.resolve(false);
      if (NativeChrome._nodeStartKey === key) return Promise.resolve(true);
      const inFlight = NativeChrome._nodeStartInFlight;
      if (inFlight) {
        if (inFlight.key === key) return inFlight.promise;
        // FIXME(#514): a different native identity epoch can arrive while a
        // start is in flight. We intentionally defer queueing that extreme
        // transition until native operation fencing is worth the complexity.
        return Promise.resolve(false);
      }

      // Store the full capability-check + start promise immediately so two
      // callers cannot both cross the await above and start the same node.
      const promise = (async () => {
        if (!(await NativeChrome.has('startNode')) ||
            !NativeChrome._isCurrentWebParticipant(
              participantId, generation)) return false;
        try {
          await window.usernode.startNode(payload);
          if (NativeChrome._isCurrentWebParticipant(
            participantId, generation)) {
            NativeChrome._nodeStartKey = key;
          }
          return true;
        } catch (e) {
          console.warn('[native-chrome] startNode failed:',
            e && e.message ? e.message : e);
          return false;
        }
      })().finally(() => {
        if (NativeChrome._nodeStartInFlight &&
            NativeChrome._nodeStartInFlight.promise === promise) {
          NativeChrome._nodeStartInFlight = null;
        }
      });
      NativeChrome._nodeStartInFlight = { key, promise };
      return promise;
    },

    // Close every local/native wallet admission path before the first web
    // logout await. This preflight does not tear down the WebView.
    //
    // It RESOLVES a report and no longer throws:
    //   { nativeTerminal, latch, reason, code }
    // with `latch` one of
    //   'acknowledged'  the native wallet latch closed for this logout
    //   'unsupported'   this build has no latch to close (pre-v4)
    //   'unavailable'   the app refused or could not answer the latch call
    //   'inconclusive'  two probes running and we still cannot tell
    //
    // Rejecting is what stranded a device whose privileged handshake was
    // refused: Settings aborted before POST /api/auth/logout, so the web
    // session survived and there was no way out of the app at all. The
    // admission-closing above is unchanged and still synchronous — a
    // refused latch means the caller must confirm with the user before
    // clearing the web session, NOT that it may not.
    prepareWebLogout() {
      NativeChrome._logoutRunning = true;
      NativeChrome._setAuthenticatedSessionAdmission(false);
      NativeChrome._setSessionWalletRelayAdmission(false);
      NativeChrome._handoffGeneration++;
      NativeChrome._handoffRerunRequested = false;
      NativeChrome._nodeStartKey = null;
      return (async () => {
        const report = (nativeTerminal, latch, reason, error) => {
          if (latch !== 'acknowledged' && latch !== 'unsupported') {
            NativeChrome._recordSessionFailure('logout-preflight',
              error || reason);
          }
          return {
            nativeTerminal,
            latch,
            reason: reason || null,
            code: (error && typeof error.usernodeCode === 'string')
              ? error.usernodeCode : null,
          };
        };
        const isNative = () => {
          const bridge = window.usernode;
          return !!bridge && bridge.isNative === true;
        };
        const conclusive = (info) => Number.isInteger(info.version) &&
          info.version > 0;

        let info = await NativeChrome.getInfo();
        if (isNative() && !conclusive(info)) {
          // One cached probe may merely have timed out, so re-probe ONCE in
          // place rather than making the user click again — that retry loop
          // is exactly what a stuck device cannot escape.
          NativeChrome._infoPromise = null;
          info = await NativeChrome.getInfo();
        }
        if (isNative() && !conclusive(info)) {
          NativeChrome._infoPromise = null;
          return report(false, 'inconclusive',
            'Native bridge probe was inconclusive');
        }

        const capabilities = Array.isArray(info.capabilities)
          ? info.capabilities
          : [];
        if (capabilities.includes('beginSessionHandoff')) {
          if (typeof window.usernode.beginSessionHandoff !== 'function') {
            return report(false, 'unavailable',
              'Native session handoff latch is unavailable');
          }
          let admission = null;
          try {
            admission = await window.usernode.beginSessionHandoff();
          } catch (error) {
            // The privileged handshake being refused lands here, and is the
            // whole reason this resolves instead of throwing.
            return report(false, 'unavailable',
              (error && error.message)
                ? String(error.message)
                : 'Native session handoff latch failed',
              error);
          }
          if (!admission || admission.blocked !== true) {
            return report(false, 'unavailable',
              'Native wallet handoff was not blocked');
          }
        }

        const nativeTerminal = capabilities.includes('logout') &&
          !!window.usernode && typeof window.usernode.logout === 'function';
        NativeChrome._lastSessionFailure = null;
        return report(nativeTerminal,
          capabilities.includes('beginSessionHandoff')
            ? 'acknowledged'
            : 'unsupported',
          null);
      })();
    },

    // Successful native logout replaces this WebView. Callers must return
    // this exact promise and perform no continuation work in the old document.
    commitNativeLogout() {
      return window.usernode.logout();
    },

    // ── First-run permissions step (thin-shell onboarding) ───────────
    //
    // Replaces the native onboarding permission screens: after the first
    // successful login handoff on a device, offer the exact-alarm /
    // battery-optimization prompts (Android) or the notification prompt
    // (iOS) the node needs. One-shot per device via a localStorage
    // marker set on dismiss — except on iOS while the OS notification
    // prompt has never been presented (permission still un-determined),
    // where the marker is not final: the OS prompt itself is one-shot,
    // so an un-asked device must keep its chance. The same rows live
    // permanently in Settings → Usernode app.
    _FIRST_RUN_KEY: 'sv:onboarding_permissions_done',
    _firstRunPromise: null,
    _firstRunSheetPresented: false,
    // Delay between post-grant permission-status re-reads (the native
    // caches settle asynchronously after the OS dialog).
    _FIRST_RUN_RECHECK_MS: 800,
    // A dismissal sooner than this, with nothing on the sheet pressed,
    // cannot be an answer — nobody read it. Same window as the kit's
    // GHOST_CLICK_MS, because that is what it is defending against.
    _FIRST_RUN_MIN_SEEN_MS: 450,

    _markFirstRunDone() {
      try { localStorage.setItem(NativeChrome._FIRST_RUN_KEY, '1'); } catch (_) {}
    },

    // iOS: whether the app has ever presented the OS notification prompt.
    // The settings snapshot only carries the exactAlarmGranted boolean,
    // which cannot distinguish "denied" from "never asked" — the social
    // push state can. Resolves 'undetermined' | 'granted' | 'denied', or
    // null when the build doesn't expose it (callers fall back to the
    // boolean). Tolerates both notDetermined / not_determined spellings.
    async _iosPushPermissionStatus() {
      if (!(await NativeChrome.has('getSocialPushState'))) return null;
      const bridge = window.usernode;
      if (!bridge || typeof bridge.getSocialPushState !== 'function') {
        return null;
      }
      let state = null;
      try { state = await bridge.getSocialPushState(); } catch (_) {
        return null;
      }
      const raw = state && typeof state.permissionStatus === 'string'
        ? state.permissionStatus.toLowerCase().replace(/[_\s-]/g, '')
        : '';
      if (raw === 'notdetermined' || raw === 'undetermined') {
        return 'undetermined';
      }
      if (raw === 'authorized' || raw === 'provisional' ||
          raw === 'granted') {
        return 'granted';
      }
      if (raw === 'denied') return 'denied';
      return null;
    },

    // Public alias. Settings (frontend/src/features/settings/settings.js)
    // must read the same truth this file's first-run sheet reads, and it
    // has no business reaching into an underscore-private.
    iosPushPermissionStatus() {
      return NativeChrome._iosPushPermissionStatus();
    },

    // ── The notification-permission tap ──────────────────────────────
    //
    // Pure, so it is unit-testable without a WebView (same discipline as
    // the kit's decideBackdropDismiss). Given everything knowable BEFORE
    // the tap, say what the tap must do. The one verdict this must never
    // return is "call requestPermissions and hope": on iOS that method
    // resolves immediately and shows NO dialog once the permission is
    // determined, so a screen that always calls it is a tap that does
    // nothing at all — for good, however many times it is pressed.
    //
    // `verdict` is one of:
    //   "request"      ask the app to present the OS prompt
    //   "already"      it is already granted; repaint, don't ask
    //   "settings"     determined-denied — only the OS settings app can
    //                  change it now, so send the user there
    //   "unsupported"  this build does not advertise requestPermissions
    //   "no-bridge"    there is no app-side channel at all
    // Every non-"request" verdict carries a `reason` for the log line and
    // `settings: true` when the OS settings page is the way out.
    decideNotificationTap(state) {
      const s = state || {};
      if (s.isNative !== true || s.hasRequestMethod !== true) {
        return {
          verdict: 'no-bridge',
          settings: false,
          reason: s.isNative !== true
            ? 'not running inside the Usernode app'
            : 'the bridge exposes no requestPermissions()',
        };
      }
      // `supported` is tri-state: false only when the build positively
      // advertised a capability list without this method. An unknown
      // (degraded probe, old build with no list) must still try — a
      // cold-start hiccup must not disable the only control there is.
      if (s.supported === false) {
        return {
          verdict: 'unsupported',
          settings: s.canOpenSettings === true,
          reason: 'this app build does not advertise requestPermissions',
        };
      }
      if (s.isAndroid === true) return { verdict: 'request', settings: false };
      if (s.pushStatus === 'granted') {
        return {
          verdict: 'already',
          settings: false,
          reason: 'the notification permission is already granted',
        };
      }
      if (s.pushStatus === 'denied') {
        return {
          verdict: 'settings',
          settings: s.canOpenSettings === true,
          reason: 'the notification permission is denied — iOS shows no ' +
            'prompt for a determined permission',
        };
      }
      return { verdict: 'request', settings: false };
    },

    // What the tap ends up as AFTER the app answered. Same purity, same
    // vocabulary, minus the pre-flight verdicts. "silent" is the one that
    // matters: the app answered, nothing was granted, and the permission
    // is STILL un-determined — i.e. the OS prompt was never presented, so
    // from the user's seat the tap did nothing. That is a defect to
    // report, not a decline to accept quietly.
    decideNotificationOutcome(state) {
      const s = state || {};
      if (s.isAndroid === true) {
        return s.granted === true
          ? { verdict: 'granted', settings: false }
          : {
              verdict: 'declined',
              settings: false,
              reason: 'the alarm permission was not granted',
            };
      }
      if (s.granted === true) return { verdict: 'granted', settings: false };
      if (s.pushStatus === 'denied') {
        return {
          verdict: 'settings',
          settings: s.canOpenSettings === true,
          reason: 'the notification permission was denied',
        };
      }
      return {
        verdict: 'silent',
        settings: s.canOpenSettings === true,
        reason: 'the app answered without granting and the permission is ' +
          'still un-determined — no OS prompt was presented',
      };
    },

    // Whether this build advertises a chrome method. Tri-state on
    // purpose: `null` means "the probe could not say" (a degraded
    // getBridgeInfo answers with an empty capability list, which is not
    // the same as a build that has none — issue #978), and callers must
    // treat that as "try anyway", never as "unsupported".
    async supports(method) {
      const bridge = window.usernode;
      if (!bridge || typeof bridge.getBridgeInfo !== 'function') return null;
      let info = null;
      try { info = await NativeChrome.getInfo(); } catch (_) { return null; }
      if (!info || info.degraded === true) return null;
      const caps = info.capabilities;
      if (!Array.isArray(caps) || caps.length === 0) return null;
      return caps.indexOf(method) !== -1;
    },

    // Triggered from init()'s boot handoff, every `sv:session`, and the
    // `usernode:auth-status` recovery chain — one shared run so the
    // trigger storm cannot stack sheets, and a document latch once a
    // sheet was actually presented.
    maybeShowFirstRunPermissions() {
      if (NativeChrome._firstRunPromise) return NativeChrome._firstRunPromise;
      const tracked = NativeChrome._maybeShowFirstRunPermissions()
        .finally(() => {
          if (NativeChrome._firstRunPromise === tracked &&
              !NativeChrome._firstRunSheetPresented) {
            NativeChrome._firstRunPromise = null;
          }
        });
      NativeChrome._firstRunPromise = tracked;
      return tracked;
    },

    async _maybeShowFirstRunPermissions() {
      if (NativeChrome._firstRunSheetPresented) return;
      let marked = false;
      try {
        marked = localStorage.getItem(NativeChrome._FIRST_RUN_KEY) === '1';
      } catch (_) {}
      let pushStatus;
      if (marked) {
        // The OS notification prompt on iOS is system-one-shot, so the
        // only unrecoverable state is "never asked". Old shell/app
        // versions (and a dismissed sheet) wrote this marker without the
        // prompt ever being presented — while iOS still reports the
        // permission as un-prompted, the marker must not be final.
        // Android keeps its instant-return fast path.
        const kit = window.unNative;
        if (!kit || kit.platform !== 'ios') return;
        pushStatus = await NativeChrome._iosPushPermissionStatus();
        if (pushStatus !== 'undetermined') return;
      }
      if (!window.PlatformUI || typeof PlatformUI.sheet !== 'function') return;
      if (!(await NativeChrome.has('getSettingsState'))) return;

      let state = null;
      try { state = await window.usernode.getSettingsState(); } catch (_) {}
      if (!state) {
        // Silent skip (the permanent Settings rows are the fallback), but
        // name the reason from the shared record so this and the Settings
        // section agree on why the read came back empty.
        const why = NativeChrome.lastReadError('getSettingsState');
        console.warn('[native-chrome] first-run permissions skipped:',
          why ? `${why.kind}: ${why.message || 'no message'}` : 'no settings state');
        return;
      }
      const perms = state.permissions || {};
      const isAndroid = perms.platform === 'android';
      let needsAlarm = !perms.exactAlarmGranted;
      // iOS: the notification permission is the real subject of this
      // sheet, so when the build exposes the push permission status let
      // it override the alarm boolean — there are no exact alarms on
      // iOS, and a build reporting exactAlarmGranted: true must not
      // swallow a never-shown notification prompt.
      if (!isAndroid) {
        if (pushStatus === undefined) {
          pushStatus = await NativeChrome._iosPushPermissionStatus();
        }
        if (pushStatus === 'undetermined') needsAlarm = true;
        else if (pushStatus === 'granted') needsAlarm = false;
      } else {
        pushStatus = null;
      }
      // Battery optimization is Android-only; iOS never shows that row.
      const needsBattery = isAndroid && perms.batteryOptDisabled !== true;
      if (!needsAlarm && !needsBattery) {
        NativeChrome._markFirstRunDone();
        return;
      }

      const handle = NativeChrome.presentPermissionsSheet({
        perms,
        isAndroid,
        pushStatus,
        // A dismissal that arrives before the sheet could physically be
        // read, from a user who touched nothing on it, is not an answer —
        // it is the opening gesture's ghost click landing on the backdrop.
        // The kit guards its own backdrop against exactly that now
        // (decideBackdropDismiss in public/usernode-native/v1/native.js),
        // but THIS marker is one-shot and silences the iOS notification
        // prompt forever, so it does not ride on that guard alone: leave
        // it unwritten and let a later launch offer the sheet again.
        onDismiss: (info) => {
          if (!info.interacted &&
              info.elapsedMs < NativeChrome._FIRST_RUN_MIN_SEEN_MS) return;
          NativeChrome._markFirstRunDone();
        },
      });
      // Kit unavailable (degraded shell): present nothing and record
      // nothing — burning the one-shot marker here silenced the iOS
      // notification prompt forever. A later healthy launch retries;
      // the permanent Settings rows remain the in-session fallback.
      if (handle) NativeChrome._firstRunSheetPresented = true;
    },

    // The "Set up your device" sheet itself, split out from the trigger
    // above so it has exactly one definition: the first-run flow presents
    // it, and so does the `?shot=notif-permissions` screenshot-state link
    // in public/js/app.js, which means the dapp.json check that asserts
    // the sheet survives its opening tap is exercising the real sheet
    // rather than a stand-in.
    //
    // opts: { perms, isAndroid, pushStatus, onDismiss }. onDismiss is
    // called with { interacted, elapsedMs } — `interacted` is true once
    // the user has pressed anything ON the sheet, which is what lets the
    // caller tell a real answer from a stray dismissal. Returns the kit's
    // sheet handle, or null when the UI kit is unavailable.
    presentPermissionsSheet(options) {
      const opts = options || {};
      const perms = opts.perms || {};
      const isAndroid = !!opts.isAndroid;
      let pushStatus = opts.pushStatus == null ? null : opts.pushStatus;
      if (!window.PlatformUI || typeof PlatformUI.sheet !== 'function') return null;

      const el = (tag, cls, text) => {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
      };

      const panel = el('div', 'px-4 pb-5');
      panel.appendChild(el('div', 'text-lg font-bold py-3', 'Set up your device'));
      // iOS: requestPermissions() maps to the notification prompt, and v4
      // turned iOS block production off — so the block-production pitch is
      // Android-only, and the iOS copy names what the OS will actually ask.
      panel.appendChild(el('p', 'text-sm text-zinc-600 dark:text-zinc-400 mb-3',
        isAndroid
          ? 'Your node can produce blocks while the app is in the ' +
            'background. That needs permission to wake your device at ' +
            'exact slot times and freedom from battery optimization.'
          : 'Allow notifications so Usernode can alert you about node ' +
            'and account activity.'));

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
      let interacted = false;
      const render = (p) => {
        body.textContent = '';
        // iOS row truth: prefer the push permission status over the
        // alarm boolean whenever the build reports one (see above).
        const alarmOk = !isAndroid && pushStatus != null
          ? pushStatus === 'granted'
          : !!p.exactAlarmGranted;
        const batteryOk = p.batteryOptDisabled === true;
        body.appendChild(statusRow(
          isAndroid ? 'Exact alarms' : 'Notifications', alarmOk));
        if (isAndroid) body.appendChild(statusRow('Battery optimization', batteryOk));

        const btns = el('div', 'mt-4 space-y-2');
        if (!alarmOk) {
          const b = el('button', 'w-full rounded-lg bg-violet-600 ' +
            'hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white',
          isAndroid ? 'Grant permissions' : 'Allow notifications');
          b.addEventListener('click', async () => {
            interacted = true;
            b.disabled = true;
            try {
              const next = await window.usernode.requestPermissions();
              const nextPerms = next && next.permissions
                ? next.permissions
                : p;
              let granted = !!(next && next.granted === true);
              if (isAndroid) {
                granted = granted || !!nextPerms.exactAlarmGranted;
              } else {
                // The native permission caches can lag right after the
                // OS dialog — and some builds resolve requestPermissions
                // before the user answers it. Poll briefly for a
                // determined status instead of trusting one stale read;
                // a determined answer wins over the grant flag.
                const settled = await NativeChrome.settleIosPushGrant(granted);
                granted = settled.granted;
                pushStatus = settled.status || pushStatus;
              }
              const batteryOk = !isAndroid ||
                nextPerms.batteryOptDisabled === true;
              if (granted && batteryOk) {
                // Nothing left to ask — close (which records first-run
                // done) instead of re-rendering a sheet with no job.
                if (sheet && sheet.dismiss) sheet.dismiss();
                return;
              }
              render(nextPerms);
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
            interacted = true;
            window.usernode.openBatterySettings().catch(() => {});
          });
          btns.appendChild(b);
        }
        const done = el('button', 'w-full px-4 py-2 text-sm ' +
          'text-zinc-500 dark:text-zinc-400',
        (alarmOk && (!isAndroid || batteryOk)) ? 'Done' : 'Skip for now');
        done.addEventListener('click', () => {
          interacted = true;
          if (sheet && sheet.dismiss) sheet.dismiss();
        });
        btns.appendChild(done);
        body.appendChild(btns);
      };

      render(perms);
      const presentedAt = Date.now();
      sheet = PlatformUI.sheet({
        contentEl: panel,
        onDismiss: () => {
          if (opts.onDismiss) {
            opts.onDismiss({
              interacted,
              elapsedMs: Date.now() - presentedAt,
            });
          }
        },
      });
      return sheet || null;
    },

    // Resolve what the iOS notification permission ACTUALLY ended up as
    // after requestPermissions() resolved. Shared by the sheet above and
    // Settings → Usernode app (frontend/src/features/settings/settings.js)
    // so both screens read the grant the same way.
    //
    // The native permission caches settle asynchronously after the OS
    // dialog, and some builds resolve requestPermissions() BEFORE the
    // user has answered it at all — so a single read reports "not
    // granted" moments after a real grant. Poll for a determined status;
    // a determined answer wins over the resolved grant flag. A fresh
    // grant also kicks push registration rather than waiting for the next
    // app resume. Resolves { granted, status }.
    async settleIosPushGrant(grantedFlag) {
      let granted = grantedFlag === true;
      let status = await NativeChrome._iosPushPermissionStatus();
      for (let i = 0; !granted && status === 'undetermined' && i < 4; i++) {
        await new Promise((resolve) => setTimeout(
          resolve, NativeChrome._FIRST_RUN_RECHECK_MS));
        status = await NativeChrome._iosPushPermissionStatus();
      }
      if (status === 'granted') granted = true;
      else if (status === 'denied') granted = false;
      if (granted) {
        status = 'granted';
        if (window.SocialPush && typeof SocialPush.getState === 'function') {
          SocialPush.getState();
        }
      }
      return { granted, status };
    },

    _initAuthStatusEvents() {
      // Late identity transitions (e.g. wallet provisioning finishing
      // after boot) surface as `usernode:auth-status` CustomEvents; a
      // ready identity for the current web participant is the signal to
      // request node start. New builds bind the request to the native epoch;
      // old builds retain their address-only compatibility path.
      window.addEventListener('usernode:auth-status', (e) => {
        const d = e && e.detail;
        if (!d || NativeChrome._logoutRunning) return;
        const participantId = NativeChrome._webParticipantId();
        if (!NativeChrome._authenticatedSessionAdmitted) {
          // onPageFinished may be the first signal after the privileged bridge
          // becomes available. Recover the explicit anonymous admission when
          // there is no web participant; otherwise retry the authoritative
          // web-session exchange. The event itself admits nothing.
          if (participantId == null) {
            NativeChrome.enterAnonymous();
            return;
          }
          // Identity transitions emitted by the completeLogin currently in
          // flight are progress, not a request to exchange the same web
          // session again.
          if (NativeChrome._handoffPromise) return;
          // Preserve the normal post-handoff first-run permissions step on
          // the authenticated recovery path.
          NativeChrome.runLoginHandoff().then((result) =>
            result && result.restarting === true
              ? undefined
              : NativeChrome.maybeShowFirstRunPermissions()
          );
          return;
        }
        if (participantId == null) return;
        const authenticatedStatus = NativeChrome._boundAuthenticatedStatus(
          d, participantId
        );
        if (!authenticatedStatus ||
            !NativeChrome._authenticatedStatusMatches(authenticatedStatus)) {
          NativeChrome._setAuthenticatedSessionAdmission(false);
          NativeChrome._setSessionWalletRelayAdmission(false);
          return;
        }
        if (d.phase === 'reconciling') {
          NativeChrome._setSessionWalletRelayAdmission(false);
          return;
        }
        if (d.phase !== 'ready' || !d.address) return;
        const generation = NativeChrome._handoffGeneration;
        NativeChrome.has('sessionBoundAuthStatus').then((sessionBound) => {
          if (sessionBound) {
            const status = NativeChrome._boundReadyStatus(d, participantId);
            if (status) {
              NativeChrome._ensureNodeStarted(status, generation).then(() => {
                if (NativeChrome._isCurrentWebParticipant(
                  participantId, generation
                ) && NativeChrome._authenticatedStatusMatches(
                  authenticatedStatus
                )) {
                  NativeChrome._setSessionWalletRelayAdmission(true);
                }
              });
            }
          } else {
            NativeChrome._ensureLegacyNodeStarted(
              d.address, participantId, generation
            );
          }
        });
      });
    },

    _initSessionRecoveryEvents() {
      const recover = () => {
        if (document.visibilityState === 'hidden') return;
        NativeChrome.recoverSessionAdmission();
      };
      window.addEventListener('online', recover);
      document.addEventListener('visibilitychange', recover);
    },

    init() {
      // The bridge loads before wallet-sheet.js and before App resolves its
      // web session. Start closed so native A cannot be cached/rendered while
      // the shell is still deciding whether this document is anonymous or B.
      NativeChrome._setAuthenticatedSessionAdmission(false);
      NativeChrome._setSessionWalletRelayAdmission(false);
      NativeChrome._initDrawerRows();
      NativeChrome._initAuthStatusEvents();
      NativeChrome._initSessionRecoveryEvents();
      // Anonymous SPA boot (fold-auth-pages-into-SPA): the login handoff
      // needs a live web session (the from-session exchange 401s without
      // one), so it waits for the session boot stage. `sv:session` fires
      // on every enterAuthed — including the waiting room, since wallet
      // provisioning and the node work for unreleased users too — and the
      // handoff self-guards against repeat runs. First-run permissions
      // ride behind the handoff so a fresh install sees login → wallet →
      // node → permissions in one flow.
      const runHandoff = () => NativeChrome.runLoginHandoff().then(
        (result) => result && result.restarting === true
          ? undefined
          : NativeChrome.maybeShowFirstRunPermissions()
      );
      // Always observe later SPA account changes, even when a session was
      // already present when this script loaded.
      document.addEventListener('sv:session', runHandoff);
      if (window.App && App.user) runHandoff();
    },
  };

  window.NativeChrome = NativeChrome;
  NativeChrome.init();
})();
