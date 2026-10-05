// Native chrome glue — the shared seam between SV's web chrome and the
// Homeroom app's bridge (app-as-SV-chrome migration, see NATIVE-BRIDGE.md).
//
// Owns:
//   - a single cached `getBridgeInfo()` probe (NativeChrome.getInfo()) so
//     node-pill.js / wallet-sheet.js / settings.js don't each round-trip
//     the channel;
//   - the drawer's Profile row (#profile hash route, profile.js) — its
//     click-to-close wiring only. The row is visible to everyone because
//     /challenges-api/me/* scopes to the platform session server-side and
//     the screen works in any browser. The old
//     native-push Profile / App Settings rows are gone
//     (profile-and-settings-to-web migration): App Settings is now
//     capability-gated sections inside the Settings modal (settings.js);
//   - the protocol-2 native-session realm gate. Social prepares one exact
//     HttpOnly handoff and asks native to establish the whole session
//     atomically; ticket and credential authority stay outside JavaScript.
//
// Everything here is capability-gated: on desktop, in child-app iframes,
// and on old app builds the probe resolves { version: 0, capabilities: [] }
// and no UI appears.
(function () {
  'use strict';

  function isTerminalAttemptFailure(error) {
    const code = error && error.usernodeCode;
    return code === 'native_session_ticket_expired' ||
      code === 'native_session_attempt_revoked' ||
      code === 'native_session_attempt_conflict' ||
      // Drop a walletless replay refused for an older decoder so a later attempt
      // can provision a compatible wallet when one is available.
      // TODO(remove-build-1250-compat): Remove this classification together with
      // the server's wallet-required refusal once 1250-era builds are unsupported.
      code === 'native_session_wallet_required' ||
      code === 'native_session_credential_revoked' ||
      code === 'native_session_credential_expired';
  }

  const NativeChrome = {
    _infoPromise: null,

    // Resolves { version, capabilities: [...], appVersion?, buildNumber? }
    // — never rejects. The optional pair identifies the installed Flutter
    // binary on app builds that advertise it through the public probe.
    //
    // Concurrent callers share ONE in-flight probe, but a DEGRADED answer
    // (the bridge's marker for a probe that timed out or errored inside
    // the app) is never memoised: caching it would hide every
    // capability-gated row — the Settings → Homeroom app section included —
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

    // `_initDrawerRows()` lived here. It existed for one reason: the Profile
    // row sat in the hamburger drawer, so a tap had to close that drawer on
    // its way to #profile. The drawer is retired and Profile is reached from
    // Home's own account row, which is a plain anchor with nothing to
    // dismiss — so there is no wiring left to do. The capability gate this
    // function also used to carry (the row revealed only when the bridge
    // reported getProfileInfo, which kept the screen unreachable in an
    // ordinary browser) had already gone: /challenges-api/me/* scopes to the
    // platform session server-side since the topochain merge.

    // ── Protocol-2 native-session realm ──────────────────────────────
    _ATTEMPT_STORAGE_KEY: 'usernode.native-session-v2.attempt',
    _HANDOFF_ENDPOINT: '/api/v4/mobile/auth/native-establish-handoff',
    _realmGeneration: 0,
    _establishLease: null,
    _prepareLoginLease: null,
    _logoutRunning: false,
    _sessionAdmitted: false,
    _publicSessionStatus: null,

    isSessionAdmitted() {
      const bridge = window.usernode;
      return !bridge || bridge.isNative !== true ||
        NativeChrome._sessionAdmitted === true;
    },

    _webParticipantId() {
      const raw = window.App && App.user ? App.user.id : null;
      const id = raw == null ? '' : String(raw);
      return /^[1-9][0-9]*$/.test(id) ? id : null;
    },

    _setSessionAdmission(admitted) {
      const next = admitted === true;
      const changed = NativeChrome._sessionAdmitted !== next;
      NativeChrome._sessionAdmitted = next;
      NativeChrome._notifySessionAdmission(next, changed);
    },

    _notifySessionAdmission(admitted, changed) {
      const walletSheet = window.WalletSheet;
      try {
        if (walletSheet &&
            typeof walletSheet._setSessionWalletAdmission === 'function') {
          walletSheet._setSessionWalletAdmission(admitted);
        }
      } catch (error) {
        console.warn('[native-chrome] wallet admission sink failed:', error);
      }
      try {
        if (changed && typeof window.dispatchEvent === 'function' &&
            typeof window.CustomEvent === 'function') {
          window.dispatchEvent(new CustomEvent(
            'usernode:native-session-admission',
            { detail: { admitted } }
          ));
        }
      } catch (error) {
        console.warn('[native-chrome] admission event sink failed:', error);
      }
    },

    _removeStoredAttempt() {
      try { localStorage.removeItem(NativeChrome._ATTEMPT_STORAGE_KEY); }
      catch (_) {}
    },

    _readStoredAttempt() {
      let value = null;
      try {
        value = JSON.parse(
          localStorage.getItem(NativeChrome._ATTEMPT_STORAGE_KEY) || 'null'
        );
      } catch (_) {}
      const keys = value && typeof value === 'object'
        ? Object.keys(value).sort().join(',') : '';
      if (!value || keys !==
          'attemptId,desiredRuntime,protocol,userId' ||
          value.protocol !== 2 || value.desiredRuntime !== 'running' ||
          typeof value.userId !== 'string' ||
          !/^[1-9][0-9]*$/.test(value.userId) ||
          typeof value.attemptId !== 'string' ||
          !/^nsa_[A-Za-z0-9_-]{43}$/.test(value.attemptId)) {
        if (value !== null) NativeChrome._removeStoredAttempt();
        return null;
      }
      return value;
    },

    _writeStoredAttempt(value) {
      localStorage.setItem(
        NativeChrome._ATTEMPT_STORAGE_KEY, JSON.stringify(value)
      );
      return value;
    },

    _newAttemptId() {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      let binary = '';
      bytes.forEach((value) => { binary += String.fromCharCode(value); });
      return 'nsa_' + btoa(binary)
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    },

    _attemptFor(userId) {
      const stored = NativeChrome._readStoredAttempt();
      if (stored && stored.userId === userId) return stored;
      if (stored) NativeChrome._removeStoredAttempt();
      return NativeChrome._writeStoredAttempt({
        protocol: 2,
        userId,
        attemptId: NativeChrome._newAttemptId(),
        desiredRuntime: 'running',
      });
    },

    _isCurrentRealm(userId, generation) {
      return !NativeChrome._logoutRunning &&
        NativeChrome._realmGeneration === generation &&
        NativeChrome._webParticipantId() === userId;
    },

    _closeRealm({ discardAttempt = false, notifyBridge = true } = {}) {
      NativeChrome._realmGeneration++;
      NativeChrome._establishLease = null;
      NativeChrome._publicSessionStatus = null;
      const admissionChanged = NativeChrome._sessionAdmitted !== false;
      NativeChrome._sessionAdmitted = false;
      if (discardAttempt) NativeChrome._removeStoredAttempt();
      if (notifyBridge && typeof window.dispatchEvent === 'function' &&
          typeof window.CustomEvent === 'function') {
        try {
          window.dispatchEvent(new CustomEvent('sv:native-realm-close'));
        } catch (error) {
          console.warn('[native-chrome] realm-close event failed:', error);
        }
      }
      NativeChrome._notifySessionAdmission(false, admissionChanged);
    },

    // App calls this synchronously before publishing/replacing App.user.
    // A saved non-secret exact attempt survives Activity/WebView recreation
    // only for the same participant, so an already-Ready native session can
    // be reclaimed by exact replay rather than stranded behind a new attempt.
    prepareIdentityPublication(user) {
      const participantId = user && user.id != null ? String(user.id) : null;
      const stored = NativeChrome._readStoredAttempt();
      NativeChrome._closeRealm({
        discardAttempt: !!stored && stored.userId !== participantId,
      });
    },

    enterAnonymous() {
      NativeChrome._closeRealm({ discardAttempt: true });
      NativeChrome.maybeShowFirstRunPermissions();
      return Promise.resolve(false);
    },

    async _prepareNativeHandoff(attempt, userId, generation, info) {
      const headers = { 'Content-Type': 'application/json' };
      // Existing public discovery metadata; native protocol-2 DTOs stay closed.
      // TODO(remove-build-1250-compat): Remove these headers with the server's
      // temporary decoder gate once 1250-era apps are no longer supported.
      if (typeof info.appVersion === 'string' &&
          info.appVersion.trim() === info.appVersion && /^[0-9.]{1,32}$/.test(info.appVersion)) {
        headers['Usernode-Native-App-Version'] = info.appVersion;
      }
      if (typeof info.buildNumber === 'string' &&
          info.buildNumber.trim() === info.buildNumber && /^[0-9]{1,10}$/.test(info.buildNumber)) {
        headers['Usernode-Native-App-Build'] = info.buildNumber;
      }
      const response = await fetch(NativeChrome._HANDOFF_ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        headers,
        body: JSON.stringify({
          protocol: 2,
          attemptId: attempt.attemptId,
          desiredRuntime: 'running',
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.success !== true || !body.data) {
        const error = new Error(
          (body && body.error) || globalThis.PlatformI18n.t("core:native_session_handoff_request_failed_5ab3c2f7")
        );
        if (body && typeof body.code === 'string') {
          error.usernodeCode = body.code;
        }
        throw error;
      }
      if (!NativeChrome._isCurrentRealm(userId, generation) ||
          body.data.protocol !== 2 ||
          body.data.attemptId !== attempt.attemptId ||
          body.data.desiredRuntime !== 'running') {
        throw new Error(globalThis.PlatformI18n.t("core:native_session_handoff_was_stale_or_mismatched_1ceeb732"));
      }
    },

    establishCurrentSession() {
      if (NativeChrome._logoutRunning) return Promise.resolve(null);
      const userId = NativeChrome._webParticipantId();
      if (!userId) return Promise.resolve(null);
      const bridge = window.usernode;
      if (!bridge || bridge.isNative !== true) return Promise.resolve(null);
      if (NativeChrome._sessionAdmitted &&
          NativeChrome._publicSessionStatus &&
          NativeChrome._publicSessionStatus.identity.participantId === userId) {
        return Promise.resolve(NativeChrome._publicSessionStatus);
      }

      const generation = NativeChrome._realmGeneration;
      const active = NativeChrome._establishLease;
      if (active && active.generation === generation &&
          active.userId === userId) return active.promise;

      const lease = { generation, userId, attemptId: null, promise: null };
      const run = (async () => {
        const info = await NativeChrome.getInfo();
        const capabilities = Array.isArray(info && info.capabilities)
          ? info.capabilities : [];
        if (!info || info.sessionLifecycleProtocol !== 2 ||
            !capabilities.includes('establishNativeSession') ||
            typeof bridge.establishNativeSession !== 'function') {
          throw new Error(
            'This Homeroom app version must be updated for secure sign-in'
          );
        }
        if (!NativeChrome._isCurrentRealm(userId, generation)) return null;

        const attempt = NativeChrome._attemptFor(userId);
        lease.attemptId = attempt.attemptId;
        await NativeChrome._prepareNativeHandoff(
          attempt, userId, generation, info
        );
        if (!NativeChrome._isCurrentRealm(userId, generation)) return null;
        const result = await bridge.establishNativeSession({
          attemptId: attempt.attemptId,
          desiredRuntime: 'running',
        });
        if (!NativeChrome._isCurrentRealm(userId, generation)) return null;
        if (!result || !result.identity ||
            result.identity.participantId !== String(App.user.id)) {
          NativeChrome._closeRealm({ discardAttempt: true });
          throw new Error(
            globalThis.PlatformI18n.t("core:native_session_result_did_not_match_the_current__0c09c35d")
          );
        }
        NativeChrome._publicSessionStatus = result;
        NativeChrome._lastSessionFailure = null;
        NativeChrome._setSessionAdmission(true);
        NativeChrome.maybeShowFirstRunPermissions();
        return result;
      })().catch((error) => {
        if (NativeChrome._isCurrentRealm(userId, generation)) {
          // These server states cannot ever replay this exact attempt. Drop
          // only its non-secret metadata; this run still fails closed and a
          // later normal recovery may create a fresh attempt.
          if (isTerminalAttemptFailure(error)) {
            NativeChrome._removeStoredAttempt();
          }
          console.warn('[native-chrome] native session establishment failed:',
            error && error.message ? error.message : error);
          NativeChrome._recordSessionFailure(
            (error && /must be updated/.test(error.message || ''))
              ? 'update-required' : 'native-establish',
            error
          );
          // `native_session_wallet_pool_exhausted` used to dispatch
          // `usernode:wallet-recovery-required` here, which popped the
          // "Connect your existing wallet" dialog on every admission
          // attempt — and _initSessionRecoveryEvents() retries on every
          // online / pageshow / visibilitychange, so the dialog kept
          // coming back. The failure is RECORDED only now; Settings →
          // Homeroom app → connection reads lastSessionFailure() and offers
          // the recovery as a button the user presses on purpose.
        }
        return null;
      }).finally(() => {
        if (NativeChrome._establishLease === lease) {
          NativeChrome._establishLease = null;
        }
      });
      lease.promise = run;
      NativeChrome._establishLease = lease;
      return run;
    },

    recoverSessionAdmission() {
      if (NativeChrome._logoutRunning || NativeChrome._sessionAdmitted) {
        return Promise.resolve(NativeChrome._publicSessionStatus);
      }
      return NativeChrome.establishCurrentSession();
    },

    // An anonymous native shell may still have a recovered native A after its
    // HttpOnly web session expired. Close page admission synchronously, then
    // ask the app's private process root to drain and revoke A before Social
    // receives any request that could mint B. A live App.user must instead use
    // the ordinary explicit logout flow; the server enforces that boundary.
    prepareForLogin() {
      if (window.App && App.user) {
        return Promise.reject(new Error(globalThis.PlatformI18n.t("core:sign_out_before_signing_in_again_982c2c16")));
      }
      const bridge = window.usernode;
      if (!bridge || bridge.isNative !== true) return Promise.resolve(false);
      if (NativeChrome._prepareLoginLease) {
        return NativeChrome._prepareLoginLease;
      }

      NativeChrome._closeRealm({ discardAttempt: true });
      let run;
      run = NativeChrome.getInfo().then((info) => {
        if (window.App && App.user) {
          throw new Error(globalThis.PlatformI18n.t("core:sign_out_before_signing_in_again_982c2c16"));
        }
        const capabilities = Array.isArray(info && info.capabilities)
          ? info.capabilities : [];
        if (!info || info.degraded === true ||
            info.sessionLifecycleProtocol !== 2 ||
            !capabilities.includes('prepareForLogin') ||
            typeof bridge.prepareForLogin !== 'function') {
          throw new Error(
            'This Homeroom app version must be updated for secure sign-in'
          );
        }
        return bridge.prepareForLogin().then(() => {
          NativeChrome._lastSessionFailure = null;
          return true;
        });
      }).catch((error) => {
        NativeChrome._recordSessionFailure('prepare-login', error);
        throw error;
      }).finally(() => {
        if (NativeChrome._prepareLoginLease === run) {
          NativeChrome._prepareLoginLease = null;
        }
      });
      NativeChrome._prepareLoginLease = run;
      return run;
    },

    _webRecovery: null,
    _lastWebRenewal: 0,

    restoreWebSession({ force = false } = {}) {
      const bridge = window.usernode;
      if (!bridge || bridge.isNative !== true || NativeChrome._logoutRunning) {
        return Promise.resolve(false);
      }
      if (NativeChrome._webRecovery) return NativeChrome._webRecovery;
      if (!force && NativeChrome._lastWebRenewal &&
          Date.now() - NativeChrome._lastWebRenewal < 24 * 60 * 60 * 1000) {
        return Promise.resolve(false);
      }
      const generation = NativeChrome._realmGeneration;
      let run;
      run = (async () => {
        const info = await NativeChrome.getInfo();
        if (!info || info.degraded) throw new Error(globalThis.PlatformI18n.t("core:native_session_recovery_is_unavailable_ab086aae"));
        if (!Array.isArray(info.capabilities) || !info.capabilities.includes('restoreWebSession')) return false;
        if (NativeChrome._logoutRunning || generation !== NativeChrome._realmGeneration) return false;
        const result = await bridge.restoreWebSession();
        if (NativeChrome._logoutRunning || generation !== NativeChrome._realmGeneration) {
          throw new Error(globalThis.PlatformI18n.t("core:native_web_session_recovery_was_superseded_75c2559f"));
        }
        if (result && result.status === 'absent') return false;
        if (!result || result.status !== 'restored' || result.protocol !== 2 ||
            typeof result.userId !== 'string' || !/^[1-9][0-9]*$/.test(result.userId) ||
            typeof result.attemptId !== 'string' || !/^nsa_[A-Za-z0-9_-]{43}$/.test(result.attemptId)) {
          throw new Error(globalThis.PlatformI18n.t("core:invalid_native_web_session_recovery_2085d479"));
        }
        NativeChrome._writeStoredAttempt({
          protocol: 2, userId: result.userId, attemptId: result.attemptId, desiredRuntime: 'running',
        });
        NativeChrome._lastWebRenewal = Date.now();
        return true;
      })().finally(() => {
        if (NativeChrome._webRecovery === run) NativeChrome._webRecovery = null;
      });
      NativeChrome._webRecovery = run;
      return run;
    },

    // Close the JS/native realm synchronously before the first logout await.
    prepareWebLogout() {
      NativeChrome._logoutRunning = true;
      // TODO(session-lifecycle-v2): Once web logout reports an authoritative
      // success/failure result, retain this replay metadata until success.
      // Today a failed web logout followed by Activity recreation stays
      // safely closed but may require a process restart to recover.
      NativeChrome._closeRealm({ discardAttempt: true });
      const bridge = window.usernode;
      // Classification is deliberately non-fallible. Only an already-started
      // recovery must settle here; semantic protocol validation belongs to
      // the terminal native call after server authority has been revoked.
      return {
        nativeTerminal: !!bridge && bridge.isNative === true,
        // Settle any already-admitted cookie installation before sending the
        // logout request, so the server receives the latest exact cookie.
        webRecoverySettled: NativeChrome._webRecovery?.catch(() => {}),
      };
    },

    // Successful native logout replaces this WebView. Callers must return
    // this exact promise and perform no continuation work in the old document.
    commitNativeLogout() {
      const bridge = window.usernode;
      if (!bridge || bridge.isNative !== true) {
        return Promise.reject(new Error('Native sign-out is unavailable'));
      }
      return NativeChrome.getInfo().then((info) => {
        const capabilities = Array.isArray(info && info.capabilities)
          ? info.capabilities : [];
        if (!info || info.degraded === true ||
            info.sessionLifecycleProtocol !== 2 ||
            !capabilities.includes('logout') ||
            typeof bridge.logout !== 'function') {
          throw new Error(
            'This Homeroom app version must be updated for secure sign-out'
          );
        }
        return bridge.logout();
      });
    },

    // ── First-run permissions step (thin-shell onboarding) ───────────
    //
    // Replaces the native onboarding permission screens: after the first
    // successful native-session establishment on a device, offer the
    // notification, exact-alarm and battery-optimization prompts the
    // Android node needs. The same rows live permanently in Settings →
    // Homeroom app.
    //
    // iOS presents NOTHING here any more (#12, decision D10). Its sheet was
    // only ever the notification prompt, and asking for that on the first
    // screen of a fresh install, before the person has made anything worth
    // hearing about, is how the ask got answered "no" (or never seen) for
    // good: iOS shows its own prompt once. The ask now comes at the moment
    // it means something, when the Homeroom bot starts building a new app
    // (askForPing below, called from the create dialog). The Settings row
    // stays the way to allow notifications at any other time.
    //
    // Android waits for block production (#2960). Both of its rows (exact
    // alarms, unrestricted background / battery optimization) exist only so
    // the node can produce blocks, so asking before the account has asked
    // to produce is asking a stranger for a scary permission with no reason
    // attached. Until the server's block-producer queue says the account
    // has requested (or been released for) block production, the Android
    // sheet is deferred WITHOUT writing the marker, and the Settings
    // "Ask to produce blocks" action re-runs this trigger the moment the
    // request lands. See decideFirstRunSheet below.
    _FIRST_RUN_KEY: 'sv:onboarding_permissions_done',
    _firstRunPromise: null,
    _firstRunSheetPresented: false,
    _firstRunSheetOpen: false,
    // Settlement signal for the terms first-run gate (#1328): set only
    // when a sheet was actually presented this launch, resolved when that
    // sheet is dismissed. firstRunSheetSettled() below is the public read.
    _firstRunSettledPromise: null,
    // Delay between post-grant permission-status re-reads (the native
    // caches settle asynchronously after the OS dialog).
    _FIRST_RUN_RECHECK_MS: 800,
    // A dismissal sooner than this, with nothing on the sheet pressed,
    // cannot be an answer — nobody read it. Same window as the kit's
    // GHOST_CLICK_MS, because that is what it is defending against.
    _FIRST_RUN_MIN_SEEN_MS: 450,

    // The record that the sheet was answered, or had nothing left to ask.
    // Nothing reads it since iOS stopped presenting the sheet (#12): its one
    // reader was the iOS re-ask rule. Asking again is gated by the
    // once-a-day key below; this stays as the record of a finished first
    // run, which the first-run tests pin.
    _markFirstRunDone() {
      try { localStorage.setItem(NativeChrome._FIRST_RUN_KEY, '1'); } catch (_) {}
    },

    // Android asks again while something is still missing, but at most once
    // a day: the marker above used to end the asking for good, so a user
    // who skipped once, or turned a permission off later, was never asked
    // again.
    _ASKED_AT_KEY: 'sv:device_permissions_asked_at',
    _REASK_AFTER_MS: 24 * 60 * 60 * 1000,

    _markAsked() {
      try {
        localStorage.setItem(NativeChrome._ASKED_AT_KEY, String(Date.now()));
      } catch (_) {}
    },

    _askedRecently() {
      let at = NaN;
      try { at = Number(localStorage.getItem(NativeChrome._ASKED_AT_KEY)); } catch (_) {}
      return Number.isFinite(at) && at > 0 &&
        Date.now() - at < NativeChrome._REASK_AFTER_MS;
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
      return NativeChrome._permissionStatusOf(state && state.permissionStatus);
    },

    // One spelling for a native permission status, wherever it was read
    // from (the social push state above, or the settings snapshot's
    // `permissions.notificationPermission` on builds that report it):
    // 'undetermined' | 'granted' | 'denied', or null for anything else.
    _permissionStatusOf(value) {
      const raw = typeof value === 'string'
        ? value.toLowerCase().replace(/[_\s-]/g, '')
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

    // Public accessor for the same reason: the terms first-run gate
    // (frontend/src/features/settings/terms-first-run.js, issues #1297 and
    // #1328) presents one overlay at a time — on a launch where the
    // "Set up your device" sheet was presented, the terms prompt waits for
    // its dismissal — and it must not reach into an underscore-private.
    firstRunSheetPresented() {
      return NativeChrome._firstRunSheetPresented === true;
    },

    // Public, same reason: resolves when this launch's "Set up your
    // device" sheet has been dismissed — or immediately when no sheet was
    // presented. The terms first-run gate (#1328) SEQUENCES itself behind
    // this instead of skipping the launch, so a fresh install sees device
    // setup → terms consent in one session rather than deferring the ask
    // to the next app restart.
    firstRunSheetSettled() {
      return NativeChrome._firstRunSettledPromise || Promise.resolve();
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
            ? globalThis.PlatformI18n.t("core:not_running_inside_the_homeroom_app_4876969d")
            : globalThis.PlatformI18n.t("core:the_bridge_exposes_no_requestpermissions_92d74462"),
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
          get reason() { return globalThis.PlatformI18n.t("core:this_app_build_does_not_advertise_requestpermiss_27d8ba4c"); },
        };
      }
      if (s.isAndroid === true) return { verdict: 'request', settings: false };
      if (s.pushStatus === 'granted') {
        return {
          verdict: 'already',
          settings: false,
          get reason() { return globalThis.PlatformI18n.t("core:the_notification_permission_is_already_granted_39fe16f6"); },
        };
      }
      if (s.pushStatus === 'denied') {
        return {
          verdict: 'settings',
          settings: s.canOpenSettings === true,
          get reason() { return globalThis.PlatformI18n.t("core:the_notification_permission_is_denied_so_ios_sho_10df03fc"); },
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
              get reason() { return globalThis.PlatformI18n.t("core:the_alarm_permission_was_not_granted_3c3329b6"); },
            };
      }
      if (s.granted === true) return { verdict: 'granted', settings: false };
      if (s.pushStatus === 'denied') {
        return {
          verdict: 'settings',
          settings: s.canOpenSettings === true,
          get reason() { return globalThis.PlatformI18n.t("core:the_notification_permission_was_denied_c730c90c"); },
        };
      }
      return {
        verdict: 'silent',
        settings: s.canOpenSettings === true,
        get reason() { return globalThis.PlatformI18n.t("core:the_app_answered_without_granting_and_the_permis_70f77639"); },
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

    // ── Who needs the block-production permissions ──────────────────
    //
    // 'producing'  the phone produces blocks (staking.delegate is null)
    // 'delegated'  the stake is delegated to the server
    // 'none'       no wallet on this device yet
    // 'unknown'    the build or the wallet could not say in time
    //
    // Pure, so the tests can pin the table without a WebView. `unknown`
    // still asks: the sheet itself offers "Delegate instead", which is the
    // safer miss than a producer who never hears why their slots are late.
    producerNeedsDevicePermissions(producer) {
      return producer !== 'delegated' && producer !== 'none';
    },

    _PRODUCER_STATUS_TRIES: 4,
    _PRODUCER_STATUS_WAIT_MS: 1500,

    // Reads the wallet's staking snapshot. `staking == null` means wallet
    // setup is still running (NATIVE-BRIDGE.md), which is common on a
    // fresh sign-in, so it is re-read a few times before giving up.
    async _producerStatus() {
      const bridge = window.usernode;
      if (!bridge || typeof bridge.getWalletState !== 'function') return 'unknown';
      if ((await NativeChrome.supports('getWalletState')) === false) return 'unknown';
      for (let i = 0; i < NativeChrome._PRODUCER_STATUS_TRIES; i++) {
        let wallet = null;
        try { wallet = await bridge.getWalletState(); } catch (_) {}
        if (wallet && !wallet.address) return 'none';
        const staking = wallet && wallet.staking;
        if (staking) return staking.delegate == null ? 'producing' : 'delegated';
        await new Promise((resolve) => setTimeout(
          resolve, NativeChrome._PRODUCER_STATUS_WAIT_MS));
      }
      return 'unknown';
    },

    // What the first-run trigger does once the permission snapshot is in.
    // Pure, for the same reason decideNotificationTap is. Returns:
    //   "skip"     iOS: present nothing and record nothing. Its sheet was
    //              the notification prompt alone, and that ask moved to
    //              the create dialog (#12, D10; see askForPing)
    //   "done"     nothing left to ask; record the one-shot marker
    //   "defer"    Android, block production not enabled: present nothing
    //              and record NOTHING, so the sheet can still be offered
    //              once the account asks to produce blocks (#2960)
    //   "present"  show the "Set up your device" sheet
    decideFirstRunSheet(state) {
      const s = state || {};
      if (s.isAndroid !== true) return 'skip';
      if (!s.needsAlarm && !s.needsBattery && !s.needsNotifications) return 'done';
      // The Android notification prompt has nothing to do with block
      // production, so it never waits for the producer queue.
      if (s.isAndroid === true && s.blockProduction !== true &&
          !s.needsNotifications) return 'defer';
      return 'present';
    },

    // Whether this account has asked for block production, read from the
    // same session-authed endpoint Settings' block-production card reads
    // (GET /challenges-api/bp/state). Requested counts, not only released:
    // once an admin releases the keys the node starts producing on its
    // own, so the permissions have to be in place BEFORE that. Anything
    // that cannot say yes (anonymous, network error, non-2xx) is false,
    // which defers the Android sheet rather than asking without a reason.
    async _blockProductionEnabled() {
      if (!window.App || !App.user) return false;
      if (typeof window.fetch !== 'function') return false;
      try {
        const res = await window.fetch('/challenges-api/bp/state',
          { credentials: 'same-origin' });
        if (!res || !res.ok) return false;
        const body = await res.json();
        const data = body && body.success !== false ? body.data : null;
        return !!(data && (data.bp_requested === true ||
          data.bp_released === true));
      } catch (_) {
        return false;
      }
    },

    // Triggered by anonymous entry and successful native establishment. One
    // shared run keeps repeated session signals from stacking sheets, with a
    // document latch once a sheet was actually presented.
    //
    // `{ force: true }` is an explicit request from the user (Settings'
    // "Ask to produce blocks"): it skips the once-a-day wait and may present
    // again in a document that already showed the sheet, but never stacks
    // a second sheet over an open one.
    maybeShowFirstRunPermissions(options) {
      const force = !!(options && options.force);
      if (force && !NativeChrome._firstRunSheetOpen) {
        NativeChrome._firstRunPromise = null;
      }
      if (NativeChrome._firstRunPromise) return NativeChrome._firstRunPromise;
      const tracked = NativeChrome._maybeShowFirstRunPermissions({ force })
        .finally(() => {
          if (NativeChrome._firstRunPromise === tracked &&
              !NativeChrome._firstRunSheetPresented) {
            NativeChrome._firstRunPromise = null;
          }
        });
      NativeChrome._firstRunPromise = tracked;
      return tracked;
    },

    async _maybeShowFirstRunPermissions(options) {
      const force = !!(options && options.force);
      if (NativeChrome._firstRunSheetOpen) return;
      if (NativeChrome._firstRunSheetPresented && !force) return;
      // iOS has nothing to present here (#12, D10), so it returns before a
      // single bridge read. This is the fast path; decideFirstRunSheet says
      // the same thing again from the settings snapshot's own platform, for
      // a page whose kit could not tell.
      const kit = window.unNative;
      if (kit && kit.platform === 'ios') return;
      // Android already asked today: leave it until tomorrow, without a
      // single bridge read.
      if (!force && NativeChrome._askedRecently()) return;
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
      // Android notifications: asked of everyone whenever the build can
      // ask for them on their own. An older build that does not report the
      // permission is not asked.
      const notificationsAskable = isAndroid &&
        perms.notificationsGranted === false &&
        typeof window.usernode.requestNotificationPermission === 'function' &&
        (await NativeChrome.supports('requestNotificationPermission')) !== false;

      // Exact alarms and battery are only for people whose phone produces
      // blocks: a delegated account or a device with no wallet has no slots
      // to wake for. And they wait until the account has asked to produce
      // blocks (#2960), so nobody is asked for them without a reason.
      let needsBattery = isAndroid && perms.batteryOptDisabled !== true;
      let blockProduction = false;
      let productionDeferred = false;
      if (isAndroid && (needsAlarm || needsBattery)) {
        const producer = await NativeChrome._producerStatus();
        if (!NativeChrome.producerNeedsDevicePermissions(producer)) {
          needsAlarm = false;
          needsBattery = false;
        } else {
          blockProduction = await NativeChrome._blockProductionEnabled();
          productionDeferred = !blockProduction;
        }
      }
      const decision = NativeChrome.decideFirstRunSheet({
        isAndroid, needsAlarm, needsBattery, blockProduction,
        needsNotifications: notificationsAskable,
      });
      // iOS (by the snapshot's own word) and the Android deferral both
      // present nothing and record nothing.
      if (decision === 'skip' || decision === 'defer') return;
      if (decision === 'done') {
        NativeChrome._markFirstRunDone();
        return;
      }

      let settled = null;
      const settledPromise = new Promise((resolve) => { settled = resolve; });
      const handle = NativeChrome.presentPermissionsSheet({
        perms,
        isAndroid,
        blockProduction,
        productionDeferred,
        notificationsAskable,
        // A dismissal that arrives before the sheet could physically be
        // read, from a user who touched nothing on it, is not an answer —
        // it is the opening gesture's ghost click landing on the backdrop.
        // The kit guards its own backdrop against exactly that now
        // (decideBackdropDismiss in public/usernode-native/v1/native.js),
        // but THESE markers end the asking for a day, so they do not ride
        // on that guard alone: leave them unwritten and let a later launch
        // offer the sheet again.
        onDismiss: (info) => {
          NativeChrome._firstRunSheetOpen = false;
          if (info.interacted ||
              info.elapsedMs >= NativeChrome._FIRST_RUN_MIN_SEEN_MS) {
            NativeChrome._markFirstRunDone();
            if (isAndroid) NativeChrome._markAsked();
          }
          // Settlement fires on EVERY dismissal, ghost clicks included —
          // it reports "the sheet is gone", not "the marker was written".
          // The terms first-run gate (#1328) awaits it to present in the
          // same launch instead of deferring to the next app restart.
          settled();
        },
      });
      // Kit unavailable (degraded shell): present nothing and record
      // nothing. A later healthy launch retries; the permanent Settings
      // rows remain the in-session fallback.
      if (handle) {
        NativeChrome._firstRunSheetPresented = true;
        NativeChrome._firstRunSettledPromise = settledPromise;
        NativeChrome._firstRunSheetOpen = true;
      }
    },

    // The "Set up your device" sheet itself, split out from the trigger
    // above so it has exactly one definition: the first-run flow presents
    // it, and so does the `?shot=notif-permissions` screenshot-state link
    // in public/js/app.js, which means the dapp.json check that asserts
    // the sheet survives its opening tap is exercising the real sheet
    // rather than a stand-in. Its iOS variant is no longer presented by the
    // first-run trigger (#12, D10); the link still draws it, because what
    // that check pins is the kit sheet's ghost-click guard.
    //
    // opts: { perms, isAndroid, pushStatus, blockProduction,
    // productionDeferred, notificationsAskable, onDismiss }. onDismiss is
    // called with { interacted, elapsedMs } — `interacted` is true once
    // the user has pressed anything ON the sheet, which is what lets the
    // caller tell a real answer from a stray dismissal. Returns the kit's
    // sheet handle, or null when the UI kit is unavailable.
    presentPermissionsSheet(options) {
      const opts = options || {};
      const perms = opts.perms || {};
      const isAndroid = !!opts.isAndroid;
      let pushStatus = opts.pushStatus == null ? null : opts.pushStatus;
      // Android: which of the three asks this sheet carries. The producer
      // rows default to on so a caller that predates them keeps its sheet.
      const producerAsks = opts.blockProduction !== false;
      const productionDeferred = opts.productionDeferred === true;
      const notificationsAskable = opts.notificationsAskable === true;
      if (!window.PlatformUI || typeof PlatformUI.sheet !== 'function') return null;

      const el = (tag, cls, text) => {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
      };

      const panel = el('div', 'px-4 pb-5');
      panel.appendChild(el('div', 'text-lg font-bold py-3', globalThis.PlatformI18n.t("core:set_up_your_device_be470ccb")));
      // iOS: requestPermissions() maps to the notification prompt, and v4
      // turned iOS block production off — so the block-production pitch is
      // Android-only, and the iOS copy names what the OS will actually ask.
      panel.appendChild(el('p', 'text-sm text-zinc-600 dark:text-zinc-400 mb-3',
        isAndroid && producerAsks
          ? globalThis.PlatformI18n.t("core:your_phone_helps_run_homeroom_your_node_can_prod_8954db94")
          : isAndroid
            ? globalThis.PlatformI18n.t("core:allow_notifications_so_homeroom_can_tell_you_abo_35a0ec0c")
            : globalThis.PlatformI18n.t("core:allow_notifications_so_homeroom_can_alert_you_ab_9d98f246")));

      const statusRow = (label, ok) => {
        const row = el('div', 'flex items-center gap-2 mt-1 text-sm');
        row.appendChild(el('span', 'w-2 h-2 rounded-full shrink-0 ' +
          (ok ? 'bg-emerald-500' : 'bg-amber-500')));
        row.appendChild(el('span', 'text-zinc-800 dark:text-zinc-200', label));
        row.appendChild(el('span', 'ml-auto text-xs ' + (ok
          ? 'text-emerald-700 dark:text-emerald-400'
          : 'text-amber-800 dark:text-amber-400'),
        ok ? globalThis.PlatformI18n.t("core:granted_62026a42") : globalThis.PlatformI18n.t("core:not_granted_352a5b4c")));
        return row;
      };

      const body = el('div');
      panel.appendChild(body);

      let sheet = null;
      let interacted = false;
      const render = (p) => {
        body.textContent = '';
        if (isAndroid) {
          renderAndroid(p);
          return;
        }
        // iOS row truth: prefer the push permission status over the
        // alarm boolean whenever the build reports one (see above).
        const alarmOk = !isAndroid && pushStatus != null
          ? pushStatus === 'granted'
          : !!p.exactAlarmGranted;
        const batteryOk = p.batteryOptDisabled === true;
        body.appendChild(statusRow(
          isAndroid ? globalThis.PlatformI18n.t("core:exact_alarms_b39f0e41") : globalThis.PlatformI18n.t("core:notifications_78801183"), alarmOk));
        if (isAndroid) body.appendChild(statusRow(globalThis.PlatformI18n.t("core:battery_optimization_e2c2b8ef"), batteryOk));

        const btns = el('div', 'mt-4 space-y-2');
        if (!alarmOk) {
          const b = el('button', 'w-full rounded-lg bg-violet-600 ' +
            'hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white',
          isAndroid ? globalThis.PlatformI18n.t("core:grant_permissions_6d6a893f") : globalThis.PlatformI18n.t("core:allow_notifications_001559c8"));
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
          globalThis.PlatformI18n.t("core:open_battery_settings_3163b5dd"));
          b.addEventListener('click', () => {
            interacted = true;
            window.usernode.openBatterySettings().catch(() => {});
          });
          btns.appendChild(b);
        }
        const done = el('button', 'w-full px-4 py-2 text-sm ' +
          'text-zinc-500 dark:text-zinc-400',
        (alarmOk && (!isAndroid || batteryOk)) ? globalThis.PlatformI18n.t("core:done_11a6767d") : globalThis.PlatformI18n.t("core:skip_for_now_b58eb52c"));
        done.addEventListener('click', () => {
          interacted = true;
          if (sheet && sheet.dismiss) sheet.dismiss();
        });
        btns.appendChild(done);
        body.appendChild(btns);
      };

      const hint = (text) => el('p',
        'text-xs text-zinc-500 dark:text-zinc-400 mt-1 mb-2', text);
      const primaryButton = (label) => el('button', 'w-full rounded-lg ' +
        'bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium ' +
        'text-white', label);

      // Android asks one thing at a time, in order: each step opens a
      // system surface, and the copy under its button says what that
      // surface will show BEFORE it shows it, so its battery warning reads
      // as expected rather than alarming.
      // What is still missing on Android, given what this sheet asks for.
      const androidMissing = (p) => ({
        notifications: notificationsAskable && p.notificationsGranted === false,
        alarm: producerAsks && !p.exactAlarmGranted,
        battery: producerAsks && p.batteryOptDisabled !== true,
      });
      // After one "Allow notifications" that did not grant, Android shows no
      // dialog again for a while, so the button becomes the settings page.
      let notificationsAsked = false;

      const renderAndroid = (p) => {
        const missing = androidMissing(p);
        if (notificationsAskable) {
          body.appendChild(statusRow(globalThis.PlatformI18n.t("core:notifications_78801183"), !missing.notifications));
        }
        if (producerAsks) {
          body.appendChild(statusRow(globalThis.PlatformI18n.t("core:exact_alarms_b39f0e41"), !missing.alarm));
          body.appendChild(statusRow(globalThis.PlatformI18n.t("core:battery_optimization_e2c2b8ef"), !missing.battery));
        }

        const btns = el('div', 'mt-4 space-y-2');
        if (missing.notifications && !notificationsAsked) {
          const b = primaryButton(globalThis.PlatformI18n.t("core:allow_notifications_001559c8"));
          b.addEventListener('click', async () => {
            interacted = true;
            b.disabled = true;
            let next = null;
            try {
              next = await window.usernode.requestNotificationPermission();
            } catch (e) {
              console.warn('[native-chrome] requestNotificationPermission failed:', e);
            } finally { b.disabled = false; }
            notificationsAsked = true;
            const nextPerms = next && next.permissions ? next.permissions : p;
            if (next && next.granted === true) {
              nextPerms.notificationsGranted = true;
              // Register for pushes now rather than on the next resume.
              if (window.SocialPush && typeof SocialPush.getState === 'function') {
                SocialPush.getState();
              }
            }
            const left = androidMissing(nextPerms);
            if (!left.notifications && !left.alarm && !left.battery) {
              if (sheet && sheet.dismiss) sheet.dismiss();
              return;
            }
            body.textContent = '';
            renderAndroid(nextPerms);
          });
          btns.appendChild(b);
          btns.appendChild(hint(globalThis.PlatformI18n.t("core:android_will_ask_whether_homeroom_may_send_you_n_b51da97e")));
        } else if (missing.notifications) {
          const b = primaryButton(globalThis.PlatformI18n.t("core:open_notification_settings_c6885c8e"));
          b.addEventListener('click', () => {
            interacted = true;
            window.usernode.openNotificationSettings().catch(() => {});
          });
          btns.appendChild(b);
          btns.appendChild(hint(globalThis.PlatformI18n.t("core:notifications_are_off_for_homeroom_turn_them_on__caf3b42d")));
        } else if (missing.alarm) {
          const b = primaryButton(globalThis.PlatformI18n.t("core:allow_exact_alarms_fe8bbe78"));
          b.addEventListener('click', async () => {
            interacted = true;
            b.disabled = true;
            try {
              const bridge = window.usernode;
              const granular = typeof bridge.requestAlarmPermissions === 'function' &&
                (await NativeChrome.supports('requestAlarmPermissions')) !== false;
              await (granular
                ? bridge.requestAlarmPermissions()
                : bridge.requestPermissions());
            } catch (e) {
              console.warn('[native-chrome] requestAlarmPermissions failed:', e);
            } finally { b.disabled = false; }
            // The grant happens on a settings page; refresh() re-reads it
            // when the page is visible again.
          });
          btns.appendChild(b);
          btns.appendChild(hint(globalThis.PlatformI18n.t("core:android_opens_the_alarms_reminders_page_turn_on__5ed1f948")));
        } else if (missing.battery) {
          const b = primaryButton(globalThis.PlatformI18n.t("core:allow_background_use_5bdfdc55"));
          b.addEventListener('click', () => {
            interacted = true;
            window.usernode.openBatterySettings().catch(() => {});
          });
          btns.appendChild(b);
          btns.appendChild(hint(globalThis.PlatformI18n.t("core:android_will_ask_whether_homeroom_may_always_run_421a0c28")));
        }

        if ((missing.alarm || missing.battery) &&
            typeof window.usernode.manageStaking === 'function') {
          const delegate = el('button', 'w-full rounded-lg border ' +
            'border-zinc-300 dark:border-zinc-700 px-4 py-2 text-sm ' +
            'font-medium text-zinc-700 dark:text-zinc-200', globalThis.PlatformI18n.t("core:delegate_instead_355b9239"));
          delegate.addEventListener('click', async () => {
            interacted = true;
            delegate.disabled = true;
            try {
              // The native screen owns the delegation target and its
              // confirmation (NATIVE-BRIDGE.md, manageStaking).
              const staking = await window.usernode.manageStaking();
              if (staking && staking.delegate != null) {
                if (sheet && sheet.dismiss) sheet.dismiss();
                return;
              }
            } catch (e) {
              console.warn('[native-chrome] manageStaking failed:', e);
            } finally { delegate.disabled = false; }
          });
          btns.appendChild(hint(globalThis.PlatformI18n.t("core:prefer_not_to_change_these_settings_delegate_you_e9d9991f")));
          btns.appendChild(delegate);
        }

        if (productionDeferred) {
          btns.appendChild(hint(globalThis.PlatformI18n.t("core:block_production_settings_exact_alarms_and_batte_ca0d2f91")));
        }

        const allDone = !missing.notifications && !missing.alarm && !missing.battery;
        const done = el('button', 'w-full px-4 py-2 text-sm ' +
          'text-zinc-500 dark:text-zinc-400', allDone ? globalThis.PlatformI18n.t("core:done_11a6767d") : globalThis.PlatformI18n.t("core:skip_for_now_b58eb52c"));
        done.addEventListener('click', () => {
          interacted = true;
          if (sheet && sheet.dismiss) sheet.dismiss();
        });
        btns.appendChild(done);
        body.appendChild(btns);
      };

      render(perms);

      // The snapshot this sheet opened with can be stale: every Android
      // grant happens on a system settings page or dialog. Re-read whenever the page is visible again or the app reports
      // a change, and never keep asking for what the device already has.
      let closed = false;
      const refresh = async () => {
        if (closed || document.visibilityState === 'hidden') return;
        let state = null;
        try { state = await window.usernode.getSettingsState(); } catch (_) {}
        if (closed || !state || !state.permissions) return;
        const next = state.permissions;
        if (!isAndroid) {
          const status = await NativeChrome._iosPushPermissionStatus();
          if (status != null) pushStatus = status;
        }
        if (closed) return;
        let nothingLeft;
        if (isAndroid) {
          const left = androidMissing(next);
          nothingLeft = !left.notifications && !left.alarm && !left.battery;
        } else {
          nothingLeft = pushStatus != null
            ? pushStatus === 'granted'
            : !!next.exactAlarmGranted;
        }
        if (nothingLeft) {
          NativeChrome._markFirstRunDone();
          if (sheet && sheet.dismiss) sheet.dismiss();
          return;
        }
        render(next);
      };
      const stopRefreshing = () => {
        closed = true;
        window.removeEventListener('usernode:permissions-changed', refresh);
        document.removeEventListener('visibilitychange', refresh);
      };

      const presentedAt = Date.now();
      sheet = PlatformUI.sheet({
        contentEl: panel,
        onDismiss: () => {
          stopRefreshing();
          if (opts.onDismiss) {
            opts.onDismiss({
              interacted,
              elapsedMs: Date.now() - presentedAt,
            });
          }
        },
      });
      if (sheet) {
        window.addEventListener('usernode:permissions-changed', refresh);
        document.addEventListener('visibilitychange', refresh);
      }
      return sheet || null;
    },

    // Resolve what the iOS notification permission ACTUALLY ended up as
    // after requestPermissions() resolved. Shared by the sheet above and
    // Settings → Homeroom app (frontend/src/features/settings/settings.js)
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

    // ── The notification ask at Create (#12, decision D10) ────────────
    //
    // "Get a ping when your app is ready?", asked when the Homeroom bot
    // starts building a new app (frontend/src/features/dialogs/ping-ask.ts,
    // called by the create dialog once POST /api/apps answers with the
    // bot's chat). That is the moment the permission plainly means
    // something: the bot messages the person when the first version is
    // ready to try, and a push is how that message reaches a phone in a
    // pocket. It replaces the first-run sheet's iOS ask, which came on the
    // first screen of a fresh install.
    //
    // An in-app question first, and the OS prompt only behind "Notify me":
    // iOS presents its own prompt ONCE, so it must not be spent on someone
    // who has not said yes to the idea. And only while the permission is
    // still undetermined. Denied (or already allowed) shows nothing, since
    // iOS would present no prompt and "Notify me" would be a button that
    // does nothing; Settings → Homeroom app, with its way to the OS
    // settings page, is how a denial gets fixed. Android shows nothing
    // either: requestPermissions() there is the exact-alarm permission, and
    // its notification ask is the "Set up your device" sheet's.
    //
    // Presented with PlatformUI.confirm, the kit's alert card: the create
    // dialog is a kit modal, and the alert is the kit surface that stacks
    // over one (the members and secrets dialogs ask their questions the
    // same way).
    _PING_ASK_COPY: {
      'app-building': {
        get title() { return globalThis.PlatformI18n.t("core:get_a_ping_when_your_app_is_ready_0980bf4c"); },
        get message() { return globalThis.PlatformI18n.t("core:homeroom_bot_will_message_you_when_it_s_ready_to_2c9059b9"); },
      },
    },
    // Written once "Notify me" has called requestPermissions() on this
    // device. Read only where the build cannot report the real permission
    // (see decidePingAsk).
    _PING_ASK_PROMPTED_KEY: 'sv:ping_ask_prompted',
    // Reads slower than this mean the person has moved on from the create
    // dialog, and an ask arriving now would be about nothing on screen.
    _PING_ASK_STALE_MS: 8000,
    _pingAskOpen: false,
    // "Not now" holds for the rest of this document: a second app made in
    // the same sitting is not a reason to ask again.
    _pingAskDeclined: false,

    _pingAskPrompted() {
      try {
        return localStorage.getItem(NativeChrome._PING_ASK_PROMPTED_KEY) === '1';
      } catch (_) {
        return false;
      }
    },

    _markPingAskPrompted() {
      try { localStorage.setItem(NativeChrome._PING_ASK_PROMPTED_KEY, '1'); } catch (_) {}
    },

    // Whether the ask may be shown. Pure, like decideNotificationTap, so the
    // table is testable without a WebView. Returns { verdict: 'ask' } or
    // { verdict: 'skip', reason }.
    //
    // `notificationPermission` is the settings snapshot's own read of the
    // OS permission, independent of push configuration, and it wins when
    // the build reports it. An older build does not, and its only signal is
    // the social push state's `permissionStatus`, which a build without
    // push configured reports as undetermined forever. So that fallback is
    // trusted once per device: after "Notify me" has called
    // requestPermissions() here, an older build is never asked again.
    decidePingAsk(state) {
      const s = state || {};
      if (s.isNative !== true || s.hasRequestMethod !== true) {
        return { verdict: 'skip', get reason() { return globalThis.PlatformI18n.t("core:not_running_inside_the_homeroom_app_4876969d"); } };
      }
      if (s.platform !== 'ios') {
        return {
          verdict: 'skip',
          reason: 'only iOS asks here; Android asks in its first-run sheet',
        };
      }
      if (s.supported === false) {
        return {
          verdict: 'skip',
          get reason() { return globalThis.PlatformI18n.t("core:this_app_build_does_not_advertise_requestpermiss_27d8ba4c"); },
        };
      }
      const reported = NativeChrome._permissionStatusOf(s.notificationPermission);
      if (reported) {
        if (reported === 'undetermined') return { verdict: 'ask' };
        return {
          verdict: 'skip',
          reason: reported === 'granted'
            ? globalThis.PlatformI18n.t("core:notifications_are_already_allowed_e633c7ce")
            : globalThis.PlatformI18n.t("core:notifications_are_denied_and_ios_shows_no_prompt_35d6fe5a"),
        };
      }
      if (s.pushStatus !== 'undetermined') {
        return {
          verdict: 'skip',
          reason: s.pushStatus == null
            ? globalThis.PlatformI18n.t("core:the_notification_permission_could_not_be_read_c45b9a6d")
            : globalThis.PlatformI18n.t("core:the_notification_permission_is_already_c2e248a5") + s.pushStatus,
        };
      }
      if (s.promptedBefore === true) {
        return {
          verdict: 'skip',
          get reason() { return globalThis.PlatformI18n.t("core:this_build_cannot_report_the_permission_and_it_w_0c8b245f"); },
        };
      }
      return { verdict: 'ask' };
    },

    // Everything decidePingAsk needs, read without asking anything. Stops
    // reading as soon as the answer is already no.
    async _pingAskState() {
      const bridge = window.usernode;
      const isNative = !!bridge && bridge.isNative === true;
      const kit = window.unNative;
      const state = {
        isNative,
        hasRequestMethod: isNative &&
          typeof bridge.requestPermissions === 'function',
        platform: kit && typeof kit.platform === 'string' ? kit.platform : null,
        supported: null,
        notificationPermission: undefined,
        pushStatus: null,
        promptedBefore: NativeChrome._pingAskPrompted(),
      };
      if (!state.hasRequestMethod || state.platform === 'android') return state;
      state.supported = await NativeChrome.supports('requestPermissions');
      if (state.supported === false) return state;
      let perms = null;
      if (await NativeChrome.has('getSettingsState')) {
        try {
          const snapshot = await bridge.getSettingsState();
          perms = snapshot && snapshot.permissions;
        } catch (_) { /* unreadable: the fallback below decides */ }
      }
      if (perms && typeof perms.platform === 'string') {
        state.platform = perms.platform;
      }
      if (perms && perms.notificationPermission != null) {
        state.notificationPermission = perms.notificationPermission;
      } else if (state.platform === 'ios') {
        state.pushStatus = await NativeChrome._iosPushPermissionStatus();
      }
      return state;
    },

    // options: { reason }, a key of _PING_ASK_COPY. Never throws and never
    // asks the OS anything until "Notify me" is pressed. Resolves
    // { shown, outcome: 'skipped' | 'not-now' | 'notify', reason?, granted? }.
    async askForPing(options) {
      const reason = options && typeof options.reason === 'string'
        ? options.reason : '';
      const copy = Object.prototype.hasOwnProperty.call(
        NativeChrome._PING_ASK_COPY, reason)
        ? NativeChrome._PING_ASK_COPY[reason] : null;
      if (!copy) {
        console.warn('[native-chrome] askForPing: unknown reason', reason);
        return { shown: false, outcome: 'skipped', get reason() { return globalThis.PlatformI18n.t("core:unknown_reason_2767f149"); } };
      }
      if (NativeChrome._pingAskOpen) {
        return { shown: false, outcome: 'skipped', get reason() { return globalThis.PlatformI18n.t("core:already_asking_40c77958"); } };
      }
      if (NativeChrome._pingAskDeclined) {
        return {
          shown: false, outcome: 'skipped',
          get reason() { return globalThis.PlatformI18n.t("core:the_answer_was_not_now_earlier_in_this_session_d4732c5d"); },
        };
      }
      const startedAt = Date.now();
      NativeChrome._pingAskOpen = true;
      let shown = false;
      let attempt = null;
      try {
        const plan = NativeChrome.decidePingAsk(
          await NativeChrome._pingAskState());
        if (plan.verdict !== 'ask') {
          return { shown: false, outcome: 'skipped', reason: plan.reason };
        }
        if (Date.now() - startedAt > NativeChrome._PING_ASK_STALE_MS) {
          return { shown: false, outcome: 'skipped', get reason() { return globalThis.PlatformI18n.t("core:the_moment_passed_84ab4554"); } };
        }
        const ui = window.PlatformUI;
        // No kit, no ask: PlatformUI.confirm would fall back to the
        // browser's own confirm(), which a native WebView may not draw.
        if (!ui || typeof ui.confirm !== 'function' ||
            typeof ui.hasKit !== 'function' || !ui.hasKit()) {
          return { shown: false, outcome: 'skipped', get reason() { return globalThis.PlatformI18n.t("core:no_ui_kit_1c30ee05"); } };
        }
        shown = true;
        // The first-session plan's guardrail: how the ask is answered
        // (services/ui-telemetry.js push_permission).
        const telemetry = window.UITelemetry;
        attempt = telemetry && typeof telemetry.attempt === 'function'
          ? telemetry.attempt('push_permission', { screen: 'ping_ask' }) : null;
        const yes = await ui.confirm({
          title: copy.title,
          message: copy.message,
          get confirmLabel() { return globalThis.PlatformI18n.t("core:notify_me_a5b3a748"); },
          get cancelLabel() { return globalThis.PlatformI18n.t("core:not_now_a0e63d7c"); },
        });
        if (!yes) {
          NativeChrome._pingAskDeclined = true;
          if (attempt) telemetry.outcome(attempt, 'cancelled');
          return { shown, outcome: 'not-now' };
        }
        NativeChrome._markPingAskPrompted();
        let next = null;
        try {
          next = await window.usernode.requestPermissions();
        } catch (err) {
          console.warn('[native-chrome] requestPermissions failed:',
            err && err.message ? err.message : err);
          if (attempt) telemetry.outcome(attempt, 'failure', { errorCode: 'unknown' });
          return { shown, outcome: 'notify', granted: false };
        }
        const perms = next && next.permissions;
        const flag = !!(next && next.granted === true) ||
          NativeChrome._permissionStatusOf(
            perms && perms.notificationPermission) === 'granted';
        // Same completion as the Settings row: wait out a lagging status,
        // and start push registration now rather than on the next resume.
        const settled = await NativeChrome.settleIosPushGrant(flag);
        if (attempt) {
          telemetry.outcome(attempt, settled.granted ? 'success' : 'failure',
            settled.granted ? {} : { errorCode: 'access_denied' });
        }
        return { shown, outcome: 'notify', granted: settled.granted };
      } catch (err) {
        console.warn('[native-chrome] askForPing failed:',
          err && err.message ? err.message : err);
        return { shown, outcome: 'skipped', reason: 'failed' };
      } finally {
        NativeChrome._pingAskOpen = false;
      }
    },

    // ── "Notify me when it's ready" (the plan card, 5 October) ────────
    //
    // Under a plan Build it was just pressed on, Homeroom bot's card offers
    // "Notify me when it's ready" (frontend/src/features/messages/
    // notify-me.tsx). Its tap is the only thing that asks: nothing here runs
    // on render, and nothing asks twice. The platform rules stay in this
    // file, beside askForPing's:
    //   iOS      requestPermissions() presents the OS prompt, while the
    //            permission is undetermined (iOS shows it once); then
    //            settleIosPushGrant reads what it became and starts push
    //            registration. A denial can only be undone in the OS
    //            settings page.
    //   Android  requestNotificationPermission(), the notification
    //            permission (requestPermissions() there is the exact-alarm
    //            one). Android may ask again after a "Don't allow".
    //   browser  nothing to ask: Homeroom has no web push. The card says
    //            the bot will message them in Homeroom.
    // A grant also turns this phone's Activity notifications back on when
    // they were off: "Notify me" is asking for exactly that.
    //
    // Pure, like decidePingAsk. `permission` is 'granted' | 'denied' |
    // 'undetermined' | null (unreadable). Returns { verdict }: 'no-app',
    // 'granted' (already allowed: confirm, ask nothing), 'ask', 'denied'
    // (iOS shows no prompt any more) or 'unknown' (this build can neither
    // say nor ask).
    decideReadyPing(state) {
      const s = state || {};
      if (s.isNative !== true) return { verdict: 'no-app' };
      if (s.permission === 'granted') return { verdict: 'granted' };
      if (s.canRequest !== true) {
        return { verdict: s.permission === 'denied' ? 'denied' : 'unknown' };
      }
      // Android asks again after a "Don't allow" (and, past its own limit,
      // resolves without a dialog, which the answer then says).
      if (s.platform === 'android') return { verdict: 'ask' };
      if (s.permission === 'denied') return { verdict: 'denied' };
      // Undetermined, or unreadable: a tap may ask. iOS resolves at once,
      // with nothing shown, when it was decided after all, and the settle
      // below reads what it is.
      return { verdict: 'ask' };
    },

    // Everything decideReadyPing needs, read without asking anything.
    async _readyPingState() {
      const bridge = window.usernode;
      const isNative = !!bridge && bridge.isNative === true;
      const kit = window.unNative;
      const state = {
        isNative,
        platform: kit && typeof kit.platform === 'string' ? kit.platform : null,
        permission: null,
        canRequest: false,
        canOpenSettings: false,
      };
      if (!isNative) return state;
      let perms = null;
      if (typeof bridge.getSettingsState === 'function' &&
          (await NativeChrome.supports('getSettingsState')) !== false) {
        try {
          const snapshot = await bridge.getSettingsState();
          perms = snapshot && snapshot.permissions;
        } catch (_) { /* unreadable: decided from what else is known */ }
      }
      if (perms && typeof perms.platform === 'string') state.platform = perms.platform;
      const can = async (method) => typeof bridge[method] === 'function' &&
        (await NativeChrome.supports(method)) !== false;
      if (state.platform === 'android') {
        if (perms && perms.notificationsGranted === true) state.permission = 'granted';
        else if (perms && perms.notificationsGranted === false) state.permission = 'denied';
        state.canRequest = await can('requestNotificationPermission');
      } else {
        state.permission = NativeChrome._permissionStatusOf(
          perms && perms.notificationPermission);
        if (!state.permission) state.permission = await NativeChrome._iosPushPermissionStatus();
        state.canRequest = await can('requestPermissions');
      }
      state.canOpenSettings = await can('openNotificationSettings');
      return state;
    },

    // This phone's Activity notifications, on. Best effort: the permission
    // is what the tap was about, and Settings shows the switch either way.
    async _activityPushOn() {
      const push = window.SocialPush;
      if (!push || typeof push.getState !== 'function' ||
          typeof push.setEnabled !== 'function') return;
      try {
        const state = await push.getState();
        if (state && state.enabled === false) await push.setEnabled(true);
      } catch (err) {
        console.warn('[native-chrome] Activity notifications not turned on:',
          err && err.message ? err.message : err);
      }
    },

    // From the tap only. Never throws. Resolves { outcome, settings }:
    // outcome 'granted' | 'denied' | 'no-app' | 'unknown', and settings true
    // when a denial can be undone from the OS settings page
    // (usernode.openNotificationSettings).
    async notifyWhenReady() {
      let state = null;
      try {
        state = await NativeChrome._readyPingState();
        const plan = NativeChrome.decideReadyPing(state);
        let outcome = plan.verdict;
        if (plan.verdict === 'ask') {
          const bridge = window.usernode;
          if (state.platform === 'android') {
            const next = await bridge.requestNotificationPermission();
            const granted = !!(next && (next.granted === true ||
              (next.permissions && next.permissions.notificationsGranted === true)));
            outcome = granted ? 'granted' : 'denied';
          } else {
            // The same record askForPing keeps: this device has been asked.
            NativeChrome._markPingAskPrompted();
            const next = await bridge.requestPermissions();
            const perms = next && next.permissions;
            const reported = NativeChrome._permissionStatusOf(
              perms && perms.notificationPermission);
            const flag = !!(next && next.granted === true) || reported === 'granted';
            const settled = await NativeChrome.settleIosPushGrant(flag);
            outcome = settled.granted ? 'granted'
              : (settled.status === 'denied' || reported === 'denied') ? 'denied' : 'unknown';
          }
        }
        if (outcome === 'granted') {
          // Registration now, not on the next resume; settleIosPushGrant
          // already did on iOS.
          if (state.platform === 'android' && window.SocialPush &&
              typeof SocialPush.getState === 'function') {
            try { SocialPush.getState(); } catch (_) {}
          }
          await NativeChrome._activityPushOn();
        }
        return {
          outcome,
          settings: outcome === 'denied' && state.canOpenSettings === true,
        };
      } catch (err) {
        console.warn('[native-chrome] notifyWhenReady failed:',
          err && err.message ? err.message : err);
        return { outcome: state && state.isNative === false ? 'no-app' : 'unknown', settings: false };
      }
    },

    _initSessionRecoveryEvents() {
      const recover = () => {
        if (document.visibilityState === 'hidden') return;
        if (window.App && App.user && !App._sessionFromSnapshot) {
          NativeChrome.restoreWebSession().then(() => NativeChrome.recoverSessionAdmission())
            .catch((error) => NativeChrome._recordSessionFailure('web-recovery', error));
        } else {
          NativeChrome.recoverSessionAdmission();
        }
      };
      window.addEventListener('online', recover);
      window.addEventListener('pageshow', recover);
      window.addEventListener('pagehide', () => {
        NativeChrome._closeRealm({ notifyBridge: false });
      });
      document.addEventListener('visibilitychange', recover);
      // Long foreground sessions count as activity even without a wallet or
      // producer requests. The recovery owner coalesces renewal to once/day.
      setInterval(recover, 60 * 1000);
    },

    // ── Appearance publish (the cold-launch white flash) ─────────────
    //
    // The Flutter shell paints a launch screen before this document
    // exists, and had no way to know what colour to paint it: SV's theme
    // is in this WebView's localStorage, the app's is in its own
    // SharedPreferences, and the two never met. So it fell back to the OS
    // preference and painted WHITE for everyone who had picked Dark on a
    // light-mode phone — a full-screen white frame ahead of a near-black
    // shell, on every cold launch.
    //
    // Nothing web-side can fix that launch, because it happens before any
    // web code runs. What we can do is fix the NEXT one: tell the app
    // which appearance this document settled on, and let it store that as
    // the colour to open with. Published on boot and on every theme
    // change, so a user who switches to Light gets a light launch screen
    // from then on.
    _appearancePublished: null,
    _appearancePublishPromise: null,
    _appearanceRerun: false,

    // The RESOLVED appearance, read back off the document rather than
    // recomputed. `.dark` on <html> and the ground behind it are both
    // written by the head's theme module (frontend/src/head.html), which
    // has already folded the tri-state stored mode against the OS
    // preference — so reading them here keeps ONE source of truth for the
    // two ground colours instead of a third copy that drifts.
    _resolvedAppearance() {
      let dark = false;
      let background = null;
      try {
        dark = document.documentElement.classList.contains('dark');
      } catch (_) { /* no document — light is the shell's own default */ }
      try {
        // `rgb(r, g, b)` / `rgba(r, g, b, a)` — the critical <style> in the
        // head sets it, so a miss means something replaced that block.
        // Omitting the colour is fine: the app keeps its own default for
        // the scheme, which is the part that actually stops the flash.
        const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(
          getComputedStyle(document.documentElement).backgroundColor || ''
        );
        if (match) {
          background = '#' + [1, 2, 3].map((i) => (
            Number(match[i]).toString(16).padStart(2, '0')
          )).join('');
        }
      } catch (_) { /* no layout yet — publish the scheme alone */ }
      return { scheme: dark ? 'dark' : 'light', background };
    },

    // Fire-and-forget. Never throws into a caller's render path, and never
    // latches "unsupported" from a DEGRADED probe — same rule as every
    // other capability gate here (issue #978): one cold-start hiccup must
    // not disable the publish for the rest of the document.
    publishAppearance() {
      const bridge = window.usernode;
      if (!bridge || bridge.isNative !== true ||
          typeof bridge.setAppearance !== 'function') {
        return Promise.resolve(false);
      }
      // Coalesce onto the in-flight run rather than queueing a call per
      // event: a theme change mid-publish re-runs the loop once with the
      // latest value. Callers get the SAME promise back, so awaiting a
      // publish means awaiting the one that is actually happening.
      if (NativeChrome._appearancePublishPromise) {
        NativeChrome._appearanceRerun = true;
        return NativeChrome._appearancePublishPromise;
      }
      const run = NativeChrome._runAppearancePublish();
      NativeChrome._appearancePublishPromise = run;
      return run.then((published) => {
        NativeChrome._appearancePublishPromise = null;
        return published;
      }, () => {
        NativeChrome._appearancePublishPromise = null;
        return false;
      });
    },

    async _runAppearancePublish() {
      try {
        do {
          NativeChrome._appearanceRerun = false;
          const appearance = NativeChrome._resolvedAppearance();
          const key = appearance.scheme + '|' + (appearance.background || '');
          if (key === NativeChrome._appearancePublished) continue;
          const info = await NativeChrome.getInfo();
          if (info && info.degraded === true) return false;
          const capabilities = Array.isArray(info && info.capabilities)
            ? info.capabilities : [];
          if (!capabilities.includes('setAppearance')) return false;
          await window.usernode.setAppearance(appearance);
          NativeChrome._appearancePublished = key;
        } while (NativeChrome._appearanceRerun);
        return true;
      } catch (err) {
        // An old build that drops the unknown method times out here. That
        // is the expected answer, not an error worth a console.error —
        // proposal checks fail any route that logs one.
        console.warn('[native-chrome] appearance publish failed:',
          err && err.message);
        return false;
      }
    },

    _initAppearancePublish() {
      NativeChrome.publishAppearance();
      // Theme.onChange fires on an explicit Light/Dark pick AND on an OS
      // flip while in system mode — both change the resolved appearance,
      // so both have to reach the app.
      if (window.Theme && typeof Theme.onChange === 'function') {
        Theme.onChange(() => NativeChrome.publishAppearance());
      }
    },

    // ── Status-bar tone (#26) ─────────────────────────────────────────
    //
    // The app draws the status bar's clock and battery from its own theme,
    // which is the appearance published above. That is right over the
    // shell's own screens and wrong over the surfaces drawn in a tone of
    // their own: the fullscreen staging preview and the before/after
    // compare overlay are always dark, and a running app paints its own
    // page colour up behind the bar (`data-app-tone`,
    // frontend/src/features/app-frame/app-tone.js). On the light shell that
    // put dark glyphs on the preview's near-black bar, where nobody could
    // read them.
    //
    // So the app is told the tone of the GROUND under the status bar
    // whenever it changes: 'dark' while the fullscreen preview or the
    // compare overlay is open, else the running app's tone, else null,
    // which hands the bar back to the app's theme. A 'dark' ground wants
    // light glyphs. Unprivileged and not persisted (NATIVE-BRIDGE.md,
    // `setStatusBarTone`), and capability-gated like setAppearance, so an
    // older build never sees the call.
    //
    // Until a build takes the tone, app.css paints the fullscreen preview
    // bar's safe-area band in the shell's ground colour, so the glyphs the
    // theme picked sit on the ground they were picked for. The first tone
    // the app accepts puts _STATUS_TONE_CLASS on <html>, which retires that
    // stopgap: from then on the band is the bar's own dark and the glyphs
    // follow it.
    _STATUS_TONE_CLASS: 'native-status-bar-tone',
    // `undefined` until the first publish, so the boot publish always goes
    // out: null at boot also clears an override a previous document left
    // behind (a reload while the preview was open).
    _statusBarTonePublished: undefined,
    _statusBarTonePromise: null,
    _statusBarToneRerun: false,

    // Pure: 'dark' | 'light' | null for the ground under the status bar.
    statusBarToneFor(state) {
      const s = state || {};
      if (s.previewFullscreen === true || s.compareOpen === true) return 'dark';
      return s.appTone === 'dark' || s.appTone === 'light' ? s.appTone : null;
    },

    // Read off the document: the overlays' classes (React toggles them
    // through refs, frontend/src/features/staging/) and the app-tone
    // attribute. The preview counts only when FULLSCREEN: docked it sits
    // mid-page, and under a session's chrome the platform header is what
    // the status bar is over.
    _statusBarToneState() {
      const state = { previewFullscreen: false, compareOpen: false, appTone: null };
      try {
        const shown = (el) => !!el && !el.classList.contains('hidden');
        const preview = document.getElementById('staging-overlay');
        state.previewFullscreen = shown(preview) &&
          !preview.classList.contains('staging-overlay-docked') &&
          !preview.classList.contains('staging-overlay-under-chrome');
        state.compareOpen = shown(document.getElementById('visual-compare-overlay'));
        state.appTone = document.documentElement.getAttribute('data-app-tone');
      } catch (_) { /* no document to read: the theme's bar */ }
      return state;
    },

    // A framed copy of the shell (a platform change's staging preview is
    // this same document inside the preview's iframe) is not what the
    // status bar sits over, so only the top document publishes.
    _isTopDocument() {
      try {
        return !window.parent || window.parent === window;
      } catch (_) {
        return false;
      }
    },

    _statusBarToneCallable() {
      const bridge = window.usernode;
      return !!bridge && bridge.isNative === true &&
        typeof bridge.setStatusBarTone === 'function' &&
        NativeChrome._isTopDocument();
    },

    // Fire-and-forget, never throws, sends only a CHANGED tone. Same
    // coalescing as publishAppearance, plus one more pass when a change
    // lands after the loop has already decided it was done, because an
    // overlay can open and close again inside one bridge round trip.
    publishStatusBarTone() {
      if (!NativeChrome._statusBarToneCallable()) return Promise.resolve(false);
      if (NativeChrome._statusBarTonePromise) {
        NativeChrome._statusBarToneRerun = true;
        return NativeChrome._statusBarTonePromise;
      }
      const run = NativeChrome._runStatusBarTonePublish()
        .catch(() => false)
        .then((published) => {
          NativeChrome._statusBarTonePromise = null;
          if (NativeChrome._statusBarToneRerun) {
            NativeChrome._statusBarToneRerun = false;
            return NativeChrome.publishStatusBarTone();
          }
          return published;
        });
      NativeChrome._statusBarTonePromise = run;
      return run;
    },

    async _runStatusBarTonePublish() {
      try {
        do {
          NativeChrome._statusBarToneRerun = false;
          const tone = NativeChrome.statusBarToneFor(
            NativeChrome._statusBarToneState());
          if (tone === NativeChrome._statusBarTonePublished) continue;
          // A degraded probe is "don't know" (#978): no latch, and the
          // next change asks again.
          const info = await NativeChrome.getInfo();
          if (info && info.degraded === true) return false;
          const capabilities = Array.isArray(info && info.capabilities)
            ? info.capabilities : [];
          if (!capabilities.includes('setStatusBarTone')) return false;
          await window.usernode.setStatusBarTone({ tone });
          NativeChrome._statusBarTonePublished = tone;
          try {
            document.documentElement.classList.add(NativeChrome._STATUS_TONE_CLASS);
          } catch (_) { /* no document: nothing to retire */ }
        } while (NativeChrome._statusBarToneRerun);
        return true;
      } catch (err) {
        // A build that advertised the method and then failed it, or timed
        // out. Never a console.error: proposal checks fail any route that
        // logs one, and the bar keeps the app's theme, which is the old
        // behaviour.
        console.warn('[native-chrome] status-bar tone publish failed:',
          err && err.message);
        return false;
      }
    },

    // Publishes on boot and on every change to what decides the tone.
    // Nothing is observed where nothing could be sent (a browser, an
    // embedded copy, a bridge without the method).
    _initStatusBarTonePublish() {
      if (!NativeChrome._statusBarToneCallable()) return;
      NativeChrome.publishStatusBarTone();
      if (typeof MutationObserver !== 'function') return;
      try {
        const observer = new MutationObserver(() => {
          NativeChrome.publishStatusBarTone();
        });
        observer.observe(document.documentElement,
          { attributes: true, attributeFilter: ['data-app-tone'] });
        // Both overlays are in the shell's static markup ahead of this
        // script, and their islands never unmount (the staging one holds
        // the preview iframe, whose identity is pinned).
        ['staging-overlay', 'visual-compare-overlay'].forEach((id) => {
          const el = document.getElementById(id);
          if (el) observer.observe(el, { attributes: true, attributeFilter: ['class'] });
        });
      } catch (err) {
        console.warn('[native-chrome] status-bar tone observer failed:',
          err && err.message);
      }
    },

    init() {
      // The bridge loads before wallet-sheet.js and before App resolves its
      // web session. Start closed so native A cannot be cached/rendered while
      // the shell is still deciding whether this document is anonymous or B.
      NativeChrome._setSessionAdmission(false);
      NativeChrome._initSessionRecoveryEvents();
      // Deliberately NOT behind session establishment below: the launch this
      // is fixing is the one before sign-in, and the appearance it
      // publishes is presentation state with no account in it.
      NativeChrome._initAppearancePublish();
      // Same reasoning: the tone under the status bar is presentation state.
      NativeChrome._initStatusBarTonePublish();
      // Native session establishment needs a verified web session, so it
      // waits for the session boot stage. Always observe later SPA account
      // changes, even when a session was already present at script load.
      document.addEventListener('sv:session', () => {
        NativeChrome.establishCurrentSession();
      });
      if (window.App && App.user) NativeChrome.establishCurrentSession();
    },
  };

  window.NativeChrome = NativeChrome;
  NativeChrome.init();
})();
