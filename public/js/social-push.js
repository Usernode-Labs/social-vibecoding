// Native Social activity-notification coordinator.
//
// Firebase payloads are deliberately content-free. The mobile shell exposes
// one opaque notification id only after its normal bridge-v4 session
// admission; this module resolves it through the authenticated Social API and
// reuses the existing notification router.
(function () {
  'use strict';

  const REQUIRED_CAPABILITIES = [
    'getSocialPushState',
    'setSocialPushEnabled',
    'claimPendingSocialNotification',
    'ackPendingSocialNotification',
  ];

  const SocialPush = {
    _supportPromise: null,
    _supported: false,
    _state: null,
    _stateReadPromise: null,
    _stateReadGeneration: -1,
    _stateRerunGeneration: -1,
    _admissionGeneration: 0,
    _drainPromise: null,
    _drainRerunRequested: false,

    _sessionAdmitted() {
      return !window.NativeChrome ||
        typeof NativeChrome.isSessionAdmitted !== 'function' ||
        NativeChrome.isSessionAdmitted();
    },

    async isSupported() {
      if (SocialPush._supportPromise) return SocialPush._supportPromise;
      SocialPush._supportPromise = (async () => {
        if (!window.usernode || window.usernode.isNative !== true ||
            !window.NativeChrome) return false;
        const info = await NativeChrome.getInfo();
        const capabilities = Array.isArray(info && info.capabilities)
          ? info.capabilities
          : [];
        const supported = REQUIRED_CAPABILITIES.every((name) =>
          capabilities.includes(name) && typeof window.usernode[name] === 'function'
        );
        SocialPush._supported = supported;
        return supported;
      })().catch(() => false);
      return SocialPush._supportPromise;
    },

    _normalizeState(value) {
      if (!value || typeof value !== 'object' ||
          typeof value.enabled !== 'boolean' ||
          typeof value.permissionStatus !== 'string' ||
          typeof value.registrationStatus !== 'string' ||
          typeof value.deliveryActive !== 'boolean') return null;
      return {
        enabled: value.enabled,
        permissionStatus: value.permissionStatus,
        registrationStatus: value.registrationStatus,
        deliveryActive: value.deliveryActive,
      };
    },

    _applyState(value) {
      const state = SocialPush._normalizeState(value);
      if (!state) return null;
      SocialPush._state = state;
      if (window.DevAlerts &&
          typeof DevAlerts.setRemoteDeliveryActive === 'function') {
        DevAlerts.setRemoteDeliveryActive(state.deliveryActive);
      }
      window.dispatchEvent(new CustomEvent('usernode:social-push-state', {
        detail: state,
      }));
      return state;
    },

    _clearState() {
      SocialPush._state = null;
      if (window.DevAlerts &&
          typeof DevAlerts.setRemoteDeliveryActive === 'function') {
        DevAlerts.setRemoteDeliveryActive(false);
      }
    },

    getState(options) {
      const refresh = !options || options.refresh !== false;
      const generation = SocialPush._admissionGeneration;
      if (!SocialPush._sessionAdmitted()) {
        SocialPush._clearState();
        return Promise.resolve(null);
      }
      if (!refresh && SocialPush._state) return SocialPush._state;
      if (SocialPush._stateReadPromise &&
          SocialPush._stateReadGeneration === generation) {
        return SocialPush._stateReadPromise;
      }
      const read = (async () => {
        if (!await SocialPush.isSupported()) return null;
        try {
          const value = await window.usernode.getSocialPushState();
          return generation === SocialPush._admissionGeneration
            ? SocialPush._applyState(value)
            : SocialPush._state;
        } catch (err) {
          console.warn('[social-push] state read failed:',
            err && err.message ? err.message : err);
          return SocialPush._state;
        }
      })();
      const tracked = read.finally(() => {
        if (SocialPush._stateReadPromise === tracked) {
          const rerun = SocialPush._stateRerunGeneration === generation &&
            SocialPush._admissionGeneration === generation;
          SocialPush._stateReadPromise = null;
          SocialPush._stateReadGeneration = -1;
          if (SocialPush._stateRerunGeneration === generation) {
            SocialPush._stateRerunGeneration = -1;
          }
          if (rerun) SocialPush.getState();
        }
      });
      SocialPush._stateReadPromise = tracked;
      SocialPush._stateReadGeneration = generation;
      return tracked;
    },

    _refreshFromNativeInvalidation() {
      const generation = SocialPush._admissionGeneration;
      if (SocialPush._stateReadPromise &&
          SocialPush._stateReadGeneration === generation) {
        // The active read may already have captured the state that was just
        // invalidated. Coalesce repeated events, but always run once more
        // after that older snapshot settles.
        SocialPush._stateRerunGeneration = generation;
        return SocialPush._stateReadPromise;
      }
      return SocialPush.getState();
    },

    async setEnabled(enabled) {
      if (!await SocialPush.isSupported()) {
        throw new Error('Activity notifications are not supported by this app build');
      }
      if (!SocialPush._sessionAdmitted()) {
        throw new Error('Secure app sign-in is still finishing. Try again shortly');
      }
      const generation = SocialPush._admissionGeneration;
      const value = await window.usernode.setSocialPushEnabled(enabled === true);
      if (generation !== SocialPush._admissionGeneration) {
        throw new Error('The native session changed while updating notifications');
      }
      const state = SocialPush._applyState(value);
      if (!state) throw new Error('The app returned an invalid notification state');
      return state;
    },

    _notificationId(value) {
      const id = value && value.notificationId;
      return Number.isSafeInteger(id) && id > 0 && id <= 2147483647
        ? id
        : null;
    },

    async _drainOnce() {
      if (!window.App || !App.user || !window.Notifications ||
          !SocialPush._sessionAdmitted() ||
          !await SocialPush.isSupported()) return false;
      const claim = await window.usernode.claimPendingSocialNotification();
      if (claim == null) return true;
      const notificationId = SocialPush._notificationId(claim);
      if (notificationId == null) return false;
      const opened = await Notifications.openById(notificationId);
      if (!opened) return false;
      return await window.usernode.ackPendingSocialNotification(
        notificationId
      ) === true;
    },

    drainPending() {
      if (SocialPush._drainPromise) {
        SocialPush._drainRerunRequested = true;
        return SocialPush._drainPromise;
      }
      const run = (async () => {
        let result = false;
        do {
          SocialPush._drainRerunRequested = false;
          try {
            result = await SocialPush._drainOnce();
          } catch (err) {
            console.warn('[social-push] pending notification failed:',
              err && err.message ? err.message : err);
            result = false;
          }
        } while (SocialPush._drainRerunRequested);
        return result;
      })();
      SocialPush._drainPromise = run.finally(() => {
        SocialPush._drainPromise = null;
        SocialPush._drainRerunRequested = false;
      });
      return SocialPush._drainPromise;
    },

    async refreshAfterForegroundPush() {
      if (!window.App || !App.user || !window.Notifications ||
          !await SocialPush.isSupported()) return false;
      return Notifications.refreshAfterInvalidation();
    },

    async init() {
      if (!await SocialPush.isSupported()) return;
      await SocialPush.getState();
      await SocialPush.drainPending();
    },
  };

  // Install listeners immediately so an event arriving while the remaining
  // page scripts initialize is retained by the async coordinator call.
  window.addEventListener('usernode:social-push-pending', () => {
    SocialPush.drainPending();
  });
  window.addEventListener('usernode:social-push-foreground', () => {
    SocialPush.refreshAfterForegroundPush();
  });
  // A tap remains in native storage until exact Social routing succeeds.
  // Retry it when an offline launch regains connectivity.
  window.addEventListener('online', () => {
    SocialPush.drainPending();
  });
  // The native shell refreshes registration/delivery status when it resumes.
  // Treat its state event as an invalidation and read through the admitted
  // bridge instead of trusting event payloads from page JavaScript.
  window.addEventListener('usernode:social-push-native-state-changed', () => {
    SocialPush._refreshFromNativeInvalidation();
  });
  window.addEventListener('usernode:native-session-admission', (event) => {
    SocialPush._admissionGeneration += 1;
    SocialPush._stateRerunGeneration = -1;
    if (!event || !event.detail || event.detail.admitted !== true) {
      SocialPush._clearState();
      return;
    }
    SocialPush.getState();
    SocialPush.drainPending();
  });
  document.addEventListener('DOMContentLoaded', () => SocialPush.init());

  window.SocialPush = SocialPush;
})();
