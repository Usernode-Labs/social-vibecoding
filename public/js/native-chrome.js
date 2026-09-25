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
          (body && body.error) || 'Native session handoff request failed'
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
        throw new Error('Native session handoff was stale or mismatched');
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
            'Native session result did not match the current participant'
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
        return Promise.reject(new Error('Sign out before signing in again.'));
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
          throw new Error('Sign out before signing in again.');
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
        if (!info || info.degraded) throw new Error('Native session recovery is unavailable');
        if (!Array.isArray(info.capabilities) || !info.capabilities.includes('restoreWebSession')) return false;
        if (NativeChrome._logoutRunning || generation !== NativeChrome._realmGeneration) return false;
        const result = await bridge.restoreWebSession();
        if (NativeChrome._logoutRunning || generation !== NativeChrome._realmGeneration) {
          throw new Error('Native web session recovery was superseded');
        }
        if (result && result.status === 'absent') return false;
        if (!result || result.status !== 'restored' || result.protocol !== 2 ||
            typeof result.userId !== 'string' || !/^[1-9][0-9]*$/.test(result.userId) ||
            typeof result.attemptId !== 'string' || !/^nsa_[A-Za-z0-9_-]{43}$/.test(result.attemptId)) {
          throw new Error('Invalid native web session recovery');
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
    // successful native-session establishment on a device, ask for
    // notification permission through the OS on both platforms. Android's
    // separate sheet covers the exact-alarm and battery settings its node
    // needs. The same controls remain in Settings.
    //
    // Android waits for block production (#2960). Both sheet rows (exact
    // alarms, unrestricted background / battery optimization) exist only so
    // the node can produce blocks, so asking before the account has asked
    // to produce is asking a stranger for a scary permission with no reason
    // attached. Until the server's block-producer queue says the account
    // has requested (or been released for) block production, the Android
    // sheet is deferred WITHOUT writing the marker, and the Settings
    // "Ask to produce blocks" action re-runs this trigger the moment the
    // request lands. See decideFirstRunSheet below.
    // Retained for older WebViews and the Android setup completion signal.
    // Notification consent uses the separate request marker below.
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

    _markFirstRunDone() {
      try { localStorage.setItem(NativeChrome._FIRST_RUN_KEY, '1'); } catch (_) {}
    },

    // Android asks about block production again while something is missing,
    // but at most once a day. Notification permission is requested once per
    // device on Android; iOS uses its determined status to stop asking.
    _ASKED_AT_KEY: 'sv:device_permissions_asked_at',
    _REASK_AFTER_MS: 24 * 60 * 60 * 1000,
    _NOTIFICATION_ASKED_KEY: 'sv:notification_permission_requested',

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

    _notificationAsked() {
      try {
        return localStorage.getItem(NativeChrome._NOTIFICATION_ASKED_KEY) === '1';
      } catch (_) { return false; }
    },

    _markNotificationAsked() {
      try { localStorage.setItem(NativeChrome._NOTIFICATION_ASKED_KEY, '1'); } catch (_) {}
    },

    // A first-run notification request is a native OS prompt, not a web
    // overlay. iOS status distinguishes an unanswered prompt from a denial;
    // Android's settings snapshot cannot, so record an answered request and
    // leave later changes to the permanent Settings control.
    async _requestFirstRunNotificationPermission(isAndroid, perms, pushStatus) {
      const bridge = window.usernode;
      const needsNotification = isAndroid
        ? perms.notificationsGranted === false
        : pushStatus === 'undetermined' ||
          (pushStatus == null && perms.exactAlarmGranted === false);
      if (!needsNotification ||
          (pushStatus !== 'undetermined' && NativeChrome._notificationAsked())) {
        return false;
      }
      const granular = typeof bridge.requestNotificationPermission === 'function' &&
        (await NativeChrome.supports('requestNotificationPermission')) !== false;
      const legacyIos = !isAndroid &&
        typeof bridge.requestPermissions === 'function' &&
        (await NativeChrome.supports('requestPermissions')) !== false;
      if (!granular && !legacyIos) return false;
      try {
        const result = await (granular
          ? bridge.requestNotificationPermission()
          : bridge.requestPermissions());
        NativeChrome._markNotificationAsked();
        if (isAndroid) {
          if (result && result.granted === true &&
              window.SocialPush && typeof SocialPush.getState === 'function') {
            SocialPush.getState();
          }
        } else {
          await NativeChrome.settleIosPushGrant(result && result.granted === true);
        }
        return true;
      } catch (err) {
        // A bridge failure did not present a prompt. Keep the next native
        // entry eligible, and leave Settings available in this session.
        console.warn('[native-chrome] notification permission request failed:', err);
        return false;
      }
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
    // must read the same truth this file's first-run request reads, and it
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
            ? 'not running inside the Homeroom app'
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
          reason: 'the notification permission is denied, so iOS shows no ' +
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
          'still un-determined, no OS prompt was presented',
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
    //   "done"     no block-production permissions left to ask
    //   "defer"    Android, block production not enabled: present nothing
    //              and record NOTHING, so the sheet can still be offered
    //              once the account asks to produce blocks (#2960)
    //   "present"  show the "Set up your device" sheet
    // iOS has no block-production sheet.
    decideFirstRunSheet(state) {
      const s = state || {};
      if (!s.needsAlarm && !s.needsBattery) return 'done';
      if (s.isAndroid === true && s.blockProduction !== true) return 'defer';
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
      const pushStatus = isAndroid ? null
        : await NativeChrome._iosPushPermissionStatus();
      const notificationRequested = await NativeChrome._requestFirstRunNotificationPermission(
        isAndroid, perms, pushStatus);
      if (!isAndroid) {
        if (notificationRequested || pushStatus === 'granted' ||
            pushStatus === 'denied') NativeChrome._markFirstRunDone();
        return;
      }
      // The daily limit applies to Android's block-production sheet, not
      // to the native notification prompt above.
      if (!force && NativeChrome._askedRecently()) return;
      if (!window.PlatformUI || typeof PlatformUI.sheet !== 'function') return;
      let needsAlarm = !perms.exactAlarmGranted;

      // Exact alarms and battery are only for people whose phone produces
      // blocks: a delegated account or a device with no wallet has no slots
      // to wake for. And they wait until the account has asked to produce
      // blocks (#2960), so nobody is asked for them without a reason.
      let needsBattery = perms.batteryOptDisabled !== true;
      let blockProduction = false;
      if (needsAlarm || needsBattery) {
        const producer = await NativeChrome._producerStatus();
        if (!NativeChrome.producerNeedsDevicePermissions(producer)) {
          needsAlarm = false;
          needsBattery = false;
        } else {
          blockProduction = await NativeChrome._blockProductionEnabled();
        }
      }
      const decision = NativeChrome.decideFirstRunSheet({
        isAndroid, needsAlarm, needsBattery, blockProduction,
      });
      if (decision === 'done') {
        NativeChrome._markFirstRunDone();
        return;
      }
      if (decision === 'defer') return;

      let settled = null;
      const settledPromise = new Promise((resolve) => { settled = resolve; });
      const handle = NativeChrome.presentPermissionsSheet({
        perms,
        // A dismissal that arrives before the sheet could physically be
        // read, from a user who touched nothing on it, is not an answer —
        // it is the opening gesture's ghost click landing on the backdrop.
        // The kit guards its own backdrop against exactly that now
        // (decideBackdropDismiss in public/usernode-native/v1/native.js),
        // so leave the Android reminder unwritten and let a later launch
        // offer the sheet again.
        onDismiss: (info) => {
          NativeChrome._firstRunSheetOpen = false;
          if (info.interacted ||
              info.elapsedMs >= NativeChrome._FIRST_RUN_MIN_SEEN_MS) {
            NativeChrome._markFirstRunDone();
            NativeChrome._markAsked();
          }
          // Settlement fires on EVERY dismissal, ghost clicks included —
          // it reports "the sheet is gone", not "the marker was written".
          // The terms first-run gate (#1328) awaits it to present in the
          // same launch instead of deferring to the next app restart.
          settled();
        },
      });
      // Kit unavailable: leave the Android sheet eligible for a later
      // healthy launch. Notification consent is requested independently.
      if (handle) {
        NativeChrome._firstRunSheetPresented = true;
        NativeChrome._firstRunSettledPromise = settledPromise;
        NativeChrome._firstRunSheetOpen = true;
      }
    },

    // The Android block-production sheet, split out from the trigger
    // above so it has exactly one definition: the first-run flow presents
    // it, and so does the existing `?shot=notif-permissions` test fixture
    // in public/js/app.js, which means the dapp.json check that asserts
    // the sheet survives its opening tap is exercising the real sheet
    // rather than a stand-in.
    //
    // opts: { perms, onDismiss }. onDismiss is
    // called with { interacted, elapsedMs } — `interacted` is true once
    // the user has pressed anything ON the sheet, which is what lets the
    // caller tell a real answer from a stray dismissal. Returns the kit's
    // sheet handle, or null when the UI kit is unavailable.
    presentPermissionsSheet(options) {
      const opts = options || {};
      const perms = opts.perms || {};
      if (!window.PlatformUI || typeof PlatformUI.sheet !== 'function') return null;

      const el = (tag, cls, text) => {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
      };

      const panel = el('div', 'px-4 pb-5');
      panel.appendChild(el('div', 'text-lg font-bold py-3', 'Set up your device'));
      panel.appendChild(el('p', 'text-sm text-zinc-600 dark:text-zinc-400 mb-3',
        'Your phone helps run Homeroom: your node can produce blocks ' +
          'while the app is in the background. For that, Android needs ' +
          'to wake it at exact slot times and leave it free of battery ' +
          'optimization. These settings only schedule wake-ups. They ' +
          'give Homeroom no access to your data.'));

      const statusRow = (label, ok) => {
        const row = el('div', 'flex items-center gap-2 mt-1 text-sm');
        row.appendChild(el('span', 'w-2 h-2 rounded-full shrink-0 ' +
          (ok ? 'bg-emerald-500' : 'bg-amber-500')));
        row.appendChild(el('span', 'text-zinc-800 dark:text-zinc-200', label));
        row.appendChild(el('span', 'ml-auto text-xs ' + (ok
          ? 'text-emerald-700 dark:text-emerald-400'
          : 'text-amber-800 dark:text-amber-400'),
        ok ? 'Granted' : 'Not granted'));
        return row;
      };

      const body = el('div');
      panel.appendChild(body);

      let sheet = null;
      let interacted = false;
      const render = (p) => {
        body.textContent = '';
        renderAndroid(p);
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
      // What is still missing for block production.
      const androidMissing = (p) => ({
        alarm: !p.exactAlarmGranted,
        battery: p.batteryOptDisabled !== true,
      });

      const renderAndroid = (p) => {
        const missing = androidMissing(p);
        body.appendChild(statusRow('Exact alarms', !missing.alarm));
        body.appendChild(statusRow('Battery optimization', !missing.battery));

        const btns = el('div', 'mt-4 space-y-2');
        if (missing.alarm) {
          const b = primaryButton('Allow exact alarms');
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
          btns.appendChild(hint('Android opens the "Alarms & reminders" ' +
            'page. Turn on Allow for Homeroom, then come back here. Your ' +
            'node only wakes a few minutes before each of its slots.'));
        } else if (missing.battery) {
          const b = primaryButton('Allow background use');
          b.addEventListener('click', () => {
            interacted = true;
            window.usernode.openBatterySettings().catch(() => {});
          });
          btns.appendChild(b);
          btns.appendChild(hint('Android will ask whether Homeroom may ' +
            'always run in the background, and warn that this can use more ' +
            'battery. Tap Allow. Your node still sleeps between slots, so ' +
            'the real impact is small, and you can change it any time in ' +
            'Settings.'));
        }

        if ((missing.alarm || missing.battery) &&
            typeof window.usernode.manageStaking === 'function') {
          const delegate = el('button', 'w-full rounded-lg border ' +
            'border-zinc-300 dark:border-zinc-700 px-4 py-2 text-sm ' +
            'font-medium text-zinc-700 dark:text-zinc-200', 'Delegate instead');
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
          btns.appendChild(hint('Prefer not to change these settings? ' +
            'Delegate your stake to the server instead. You still earn ' +
            'half the block-production points, and you can switch back any ' +
            'time.'));
          btns.appendChild(delegate);
        }

        const allDone = !missing.alarm && !missing.battery;
        const done = el('button', 'w-full px-4 py-2 text-sm ' +
          'text-zinc-500 dark:text-zinc-400', allDone ? 'Done' : 'Skip for now');
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
        if (closed) return;
        const left = androidMissing(next);
        const nothingLeft = !left.alarm && !left.battery;
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
    // after the native bridge request resolved. Shared by first-run and
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
