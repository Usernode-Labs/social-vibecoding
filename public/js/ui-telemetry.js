// Privacy-bounded UI experience telemetry.
//
// This module observes only call sites that name a stable screen/action code.
// It never walks the DOM for clicks, reads a route/query, serializes a thrown
// error, or accepts arbitrary metadata. Delivery is best-effort and bounded:
// user work never awaits this queue.
(function (root, factory) {
  'use strict';
  const create = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = { createUITelemetry: create };
  if (root && root.document) root.UITelemetry = create(root);
}(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // Navigation codes (#3369) are the server's NAV_SCREENS: one per screen
  // root the shell reveals. Keep the two lists identical.
  const NAV_SCREENS = new Set([
    'home', 'discover', 'communities', 'challenges', 'profile', 'my_proposals',
    'settings', 'messages', 'assistant', 'agent_session', 'app', 'project',
    'username_sheet', 'terms_sheet', 'join_sheet', 'tour',
  ]);
  const SCREENS = new Set([
    'shell_boot', 'app_detail', 'app_discussion', 'feedback_dialog',
    'report_dialog', 'change_workspace', 'preview', 'ping_ask', ...NAV_SCREENS,
  ]);
  const VIAS = new Set(['own', 'nudged', 'handed', 'address', 'back', 'returned']);
  const ACTIONS = new Set([
    'shell_boot', 'app_detail_load', 'app_discussion_load',
    'feedback_submit', 'content_report_submit', 'change_create', 'preview_open',
    'push_permission',
    // #4524: a push tap's routing chain, from the bridge claim to the screen
    // it names starting to route (social-push.js _drainOnce).
    'push_tap_route',
  ]);
  const OUTCOMES = new Set(['success', 'failure', 'cancelled']);
  const ERRORS = new Set([
    'access_denied', 'app_blocked', 'boot_incomplete', 'boot_rejection',
    'boot_resource_failed', 'boot_script_error', 'boot_step_failed',
    'conflict', 'invalid_response', 'network', 'not_found', 'offline',
    'rate_limited', 'server_error', 'target_unavailable', 'unavailable',
    'unknown',
  ]);
  const MAX_QUEUE = 80;
  const MAX_BATCH = 25;
  const MAX_AGE_MS = 24 * 60 * 60 * 1000;
  const MAX_DURATION_MS = 30 * 60 * 1000;
  const REPEAT_MS = 2000;
  const ABANDON_MIN_MS = 1000;
  const DELIVERY_TIMEOUT_MS = 10_000;
  const STORE_PREFIX = 'ui-telemetry-v1:';
  const SCHEMA_VERSION = 2;
  // A page hidden this long and shown again is a new visit: the current
  // screen is reported again, marked `returned`. Same 30 minutes the
  // Journey queries use to end a visit.
  const RETURN_AFTER_MS = 30 * 60 * 1000;
  // A mark from markNextVia explains the navigation that follows it at once;
  // one that no navigation used goes stale rather than mislabel a later step.
  const NEXT_VIA_MS = 5000;

  function createUITelemetry(env) {
    env = env || {};
    const doc = env.document || null;
    const clock = typeof env.now === 'function' ? env.now : () => Date.now();
    const setTimer = env.setTimeout ? env.setTimeout.bind(env) : setTimeout;
    const clearTimer = env.clearTimeout ? env.clearTimeout.bind(env) : clearTimeout;
    const fetcher = typeof env.fetch === 'function' ? env.fetch.bind(env) : null;
    const storage = (() => {
      try { return env.localStorage || null; } catch (_) { return null; }
    })();
    const randomId = () => {
      try {
        if (env.crypto && typeof env.crypto.randomUUID === 'function') return env.crypto.randomUUID();
      } catch (_) { /* use the content-free fallback */ }
      let out = '';
      for (let i = 0; i < 4; i += 1) out += Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
      return `local-${out}`;
    };
    const visitId = randomId();
    let sequence = 0;
    let currentUser = null;
    let pendingUser = null;
    let queue = [];
    let droppedEvents = 0;
    let failedBatches = 0;
    let flushTimer = null;
    let retryMs = 1000;
    let nextDeliveryAt = 0;
    let sending = false;
    let pendingBatch = null;
    let userEpoch = 0;
    let activeRequest = null;
    // Boot observations are held in memory until the verified session says
    // whether this is a product user or a synthetic browser-check identity.
    let collectionDisabled = false;
    const attempts = new Map();
    const lastAttempts = new Map();
    const troubledActions = new Set();
    // The navigation screen showing now, so a repeat report of the same root
    // is dropped and "hidden" knows which screen it ends.
    let currentNav = null;
    let hiddenAt = null;
    let nextVia = null;
    let nextViaAt = 0;

    function adminRoute() {
      try { return String(env.location?.hash || '').startsWith('#admin'); } catch (_) { return false; }
    }

    function storeKey(userId) { return `${STORE_PREFIX}${userId}`; }

    function validStored(item, now) {
      return item && typeof item === 'object' && typeof item.id === 'string'
        && typeof item.occurredAt === 'string'
        && Number.isFinite(Date.parse(item.occurredAt))
        && Date.parse(item.occurredAt) >= now - MAX_AGE_MS;
    }

    function trim(now) {
      const before = queue.length;
      queue = queue.filter((item) => validStored(item, now));
      droppedEvents += before - queue.length;
      if (queue.length > MAX_QUEUE) {
        droppedEvents += queue.length - MAX_QUEUE;
        queue = queue.slice(queue.length - MAX_QUEUE);
      }
    }

    function persist() {
      if (!storage || !currentUser || collectionDisabled) return;
      try { storage.setItem(storeKey(currentUser), JSON.stringify(queue)); } catch (_) { /* memory queue remains */ }
    }

    function load(userId) {
      if (!storage) return [];
      try {
        const value = JSON.parse(storage.getItem(storeKey(userId)) || '[]');
        return Array.isArray(value) ? value : [];
      } catch (_) { return []; }
    }

    function clearStored(userId) {
      if (!storage || !userId) return;
      try { storage.removeItem(storeKey(userId)); } catch (_) { /* best effort */ }
    }

    function resetObservations() {
      queue = [];
      pendingBatch = null;
      currentNav = null;
      hiddenAt = null;
      nextVia = null;
      attempts.forEach((record) => { if (record.timer) clearTimer(record.timer); });
      attempts.clear();
      lastAttempts.clear();
      troubledActions.clear();
      droppedEvents = 0;
      failedBatches = 0;
      retryMs = 1000;
      nextDeliveryAt = 0;
    }

    function cancelInFlight() {
      if (!activeRequest) return;
      try { activeRequest.controller?.abort(); } catch (_) { /* the deadline still releases it */ }
      activeRequest.reject();
      activeRequest = null;
    }

    function schedule(delay) {
      if (collectionDisabled || !currentUser || sending || flushTimer || !queue.length || adminRoute()) return;
      flushTimer = setTimer(() => {
        flushTimer = null;
        void flush(false);
      }, delay == null ? 1500 : delay);
    }

    function safeAppSlug(value) {
      return typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value)
        ? value : null;
    }

    function platformBuild() {
      try {
        const value = doc?.querySelector?.('meta[name="platform-build"]')?.content || '';
        return /^(?:[0-9a-f]{7,40}|dev)$/.test(value) ? value : null;
      } catch (_) { return null; }
    }

    function emit(kind, screen, detail) {
      if (collectionDisabled || adminRoute() || !SCREENS.has(screen)) return null;
      detail = detail || {};
      const item = {
        id: randomId(),
        visitId,
        kind,
        screen,
        occurredAt: new Date(clock()).toISOString(),
        sequence: ++sequence,
      };
      if (detail.attemptId) item.attemptId = detail.attemptId;
      if (ACTIONS.has(detail.action)) item.action = detail.action;
      if (OUTCOMES.has(detail.outcome)) item.outcome = detail.outcome;
      if (ERRORS.has(detail.errorCode)) item.errorCode = detail.errorCode;
      if (Number.isFinite(detail.durationMs)) {
        item.durationMs = Math.max(0, Math.min(MAX_DURATION_MS, Math.round(detail.durationMs)));
      }
      const appSlug = safeAppSlug(detail.appSlug);
      if (appSlug) item.appSlug = appSlug;
      if (kind === 'screen_visit' && NAV_SCREENS.has(screen) && VIAS.has(detail.via)) {
        item.via = detail.via;
      }
      const build = platformBuild();
      if (build) item.build = build;
      queue.push(item);
      trim(clock());
      persist();
      schedule();
      return item.id;
    }

    function screen(screenCode, context) {
      return emit('screen_visit', screenCode, context);
    }

    // One navigation step (#3369). Reported only when the screen root (or the
    // app it is about) actually changes, so a redraw is never read as a step.
    // `via` defaults to the person's own navigation; a caller that knows
    // better (a notification, an invite link, Back) says so, either directly
    // or through markNextVia just before it navigates.
    function navigate(screenCode, context) {
      if (!NAV_SCREENS.has(screenCode)) return null;
      context = context || {};
      const appSlug = safeAppSlug(context.appSlug);
      if (currentNav && currentNav.screen === screenCode && currentNav.appSlug === appSlug) return null;
      const marked = nextVia && clock() - nextViaAt <= NEXT_VIA_MS ? nextVia : null;
      const via = VIAS.has(context.via) ? context.via : (marked || 'own');
      nextVia = null;
      currentNav = { screen: screenCode, appSlug };
      return emit('screen_visit', screenCode, { appSlug, via });
    }

    function markNextVia(via) {
      nextVia = VIAS.has(via) ? via : null;
      nextViaAt = clock();
    }

    function navHidden() {
      if (!currentNav) return;
      hiddenAt = clock();
      emit('screen_hidden', currentNav.screen, { appSlug: currentNav.appSlug });
    }

    function navShown() {
      const since = hiddenAt;
      hiddenAt = null;
      if (!currentNav || since == null || clock() - since < RETURN_AFTER_MS) return;
      emit('screen_visit', currentNav.screen, { appSlug: currentNav.appSlug, via: 'returned' });
    }

    function attempt(action, context) {
      context = context || {};
      if (collectionDisabled || adminRoute() || !ACTIONS.has(action) || !SCREENS.has(context.screen)) return null;
      const id = randomId();
      const startedAt = clock();
      const appSlug = safeAppSlug(context.appSlug);
      const repeatKey = `${action}:${context.screen}:${appSlug || ''}`;
      const previous = lastAttempts.get(repeatKey);
      if (previous != null && startedAt - previous <= REPEAT_MS) {
        emit('repeated_action', context.screen, { attemptId: id, action, appSlug });
      }
      lastAttempts.set(repeatKey, startedAt);
      const record = {
        id, action, screen: context.screen, appSlug, startedAt,
        abandonOnHide: context.abandonOnHide === true,
        abandoned: false, timedOut: false, timer: null,
      };
      const timeoutMs = Number(context.timeoutMs);
      if (Number.isFinite(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= MAX_DURATION_MS) {
        record.timer = setTimer(() => {
          const live = attempts.get(id);
          if (!live || live.timedOut) return;
          live.timedOut = true;
          troubledActions.add(action);
          emit('loading_timeout', live.screen, {
            attemptId: id, action, appSlug: live.appSlug, durationMs: clock() - live.startedAt,
          });
        }, timeoutMs);
      }
      attempts.set(id, record);
      emit('action_attempt', context.screen, { attemptId: id, action, appSlug });
      return id;
    }

    function outcome(attemptId, outcomeCode, detail) {
      const record = attempts.get(attemptId);
      if (!record || !OUTCOMES.has(outcomeCode)) return false;
      detail = detail || {};
      if (record.timer) clearTimer(record.timer);
      const durationMs = clock() - record.startedAt;
      const errorCode = outcomeCode === 'failure'
        ? (ERRORS.has(detail.errorCode) ? detail.errorCode : 'unknown')
        : null;
      emit('action_outcome', record.screen, {
        attemptId, action: record.action, outcome: outcomeCode, errorCode,
        appSlug: record.appSlug, durationMs,
      });
      if (outcomeCode === 'failure') troubledActions.add(record.action);
      if (outcomeCode === 'success' && troubledActions.has(record.action)) {
        emit('recovery', record.screen, {
          attemptId, action: record.action, appSlug: record.appSlug, durationMs,
        });
        troubledActions.delete(record.action);
      }
      attempts.delete(attemptId);
      return true;
    }

    function cancel(attemptId) { return outcome(attemptId, 'cancelled'); }

    function abandonPending() {
      const at = clock();
      for (const record of attempts.values()) {
        if (!record.abandonOnHide || record.abandoned || at - record.startedAt < ABANDON_MIN_MS) continue;
        record.abandoned = true;
        emit('navigation_abandonment', record.screen, {
          attemptId: record.id, action: record.action, appSlug: record.appSlug,
          durationMs: at - record.startedAt,
        });
      }
    }

    function errorCodeFor(status, code) {
      if (code === 'app_blocked') return 'app_blocked';
      if (status === 401 || status === 403) return 'access_denied';
      if (status === 404) return 'not_found';
      if (status === 409) return 'conflict';
      if (status === 429) return 'rate_limited';
      if (Number(status) >= 500) return 'server_error';
      if (Number(status) >= 400) return 'unavailable';
      return 'unknown';
    }

    function contextHeaders(attemptId) {
      if (collectionDisabled) return {};
      const headers = { 'X-UI-Visit-ID': visitId };
      if (attempts.has(attemptId)) headers['X-UI-Attempt-ID'] = attemptId;
      return headers;
    }

    function setUser(user, verifiedSession = true) {
      const descriptor = user && typeof user === 'object' ? user : null;
      const userId = descriptor ? descriptor.id : user;
      const next = userId == null ? null : String(userId);
      if (!next) { clearUser(); return; }
      // Product wiring passes the /api/auth/me user object. Only an explicit
      // server-owned TRUE enables delivery. An old/offline snapshot has no
      // decision: keep its bounded observations in memory for same-account
      // reconciliation, but do not load storage or send. Numeric/string
      // callers remain supported for the small public API and isolated tests.
      const decision = descriptor && verifiedSession === true
        && typeof descriptor.uiTelemetryEligible === 'boolean'
        ? descriptor.uiTelemetryEligible : (descriptor ? null : true);
      if (decision === null) {
        cancelInFlight();
        if (flushTimer) clearTimer(flushTimer);
        flushTimer = null;
        if ((currentUser && currentUser !== next) || (pendingUser && pendingUser !== next)) {
          clearStored(currentUser);
          clearStored(pendingUser);
          resetObservations();
        }
        currentUser = null;
        pendingUser = next;
        userEpoch += 1;
        collectionDisabled = false;
        return;
      }
      if (!decision) {
        cancelInFlight();
        if (flushTimer) clearTimer(flushTimer);
        flushTimer = null;
        clearStored(currentUser);
        clearStored(pendingUser);
        clearStored(next);
        currentUser = null;
        pendingUser = null;
        userEpoch += 1;
        resetObservations();
        collectionDisabled = true;
        return;
      }
      collectionDisabled = false;
      const samePendingUser = pendingUser === next;
      if (pendingUser && pendingUser !== next) {
        clearStored(pendingUser);
        resetObservations();
      }
      pendingUser = null;
      if (currentUser === next) { schedule(0); return; }
      cancelInFlight();
      if (currentUser) {
        clearStored(currentUser);
        resetObservations();
      }
      currentUser = next;
      userEpoch += 1;
      if (!samePendingUser) {
        attempts.forEach((record) => { if (record.timer) clearTimer(record.timer); });
        attempts.clear();
      }
      pendingBatch = null;
      queue = load(next).concat(queue);
      trim(clock());
      persist();
      schedule(0);
    }

    function clearUser() {
      cancelInFlight();
      if (flushTimer) clearTimer(flushTimer);
      flushTimer = null;
      clearStored(currentUser);
      clearStored(pendingUser);
      currentUser = null;
      pendingUser = null;
      userEpoch += 1;
      resetObservations();
      collectionDisabled = false;
    }

    function retryAfterDelay(response) {
      if (response?.status !== 429) return 0;
      let raw = null;
      try { raw = response.headers?.get?.('retry-after'); } catch (_) { return 0; }
      if (typeof raw !== 'string' || !raw.trim()) return 0;
      const value = raw.trim();
      const seconds = Number(value);
      const delay = Number.isFinite(seconds)
        ? seconds * 1000
        : Date.parse(value) - clock();
      if (!Number.isFinite(delay) || delay <= 0) return 0;
      return Math.max(1000, Math.min(60_000, Math.ceil(delay)));
    }

    async function flush(keepalive) {
      if (collectionDisabled || !fetcher || !currentUser || sending || !queue.length || adminRoute()) return false;
      const cooldown = nextDeliveryAt - clock();
      if (cooldown > 0) {
        schedule(cooldown);
        return false;
      }
      // A direct flush (pagehide, reconnect, or a caller) supersedes the
      // ordinary debounce. Its result installs the next appropriate timer.
      if (flushTimer) clearTimer(flushTimer);
      flushTimer = null;
      trim(clock());
      if (!queue.length) { persist(); return true; }
      if (!pendingBatch) {
        pendingBatch = { id: randomId(), ids: queue.slice(0, MAX_BATCH).map((item) => item.id) };
      }
      const wanted = new Set(pendingBatch.ids);
      const batchEvents = queue.filter((item) => wanted.has(item.id));
      if (!batchEvents.length) { pendingBatch = null; return flush(keepalive); }
      const sendingUser = currentUser;
      const sendingEpoch = userEpoch;
      let drainImmediately = false;
      const Abort = env.AbortController || (typeof AbortController === 'function' ? AbortController : null);
      const controller = Abort ? new Abort() : null;
      let deadlineTimer = null;
      let rejectDeadline;
      const deadline = new Promise((_, reject) => {
        rejectDeadline = () => reject(new Error('UI telemetry delivery deadline'));
        deadlineTimer = setTimer(() => {
          try { controller?.abort(); } catch (_) { /* rejecting still releases the queue */ }
          rejectDeadline();
        }, DELIVERY_TIMEOUT_MS);
      });
      activeRequest = { controller, reject: rejectDeadline, epoch: sendingEpoch };
      sending = true;
      try {
        const request = fetcher('/api/ui-telemetry/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          keepalive: keepalive === true,
          ...(controller ? { signal: controller.signal } : {}),
          body: JSON.stringify({
            schemaVersion: SCHEMA_VERSION,
            batchId: pendingBatch.id,
            events: batchEvents,
            delivery: { failedBatches, droppedEvents },
          }),
        });
        const response = await Promise.race([request, deadline]);
        // An account switch invalidates every queue mutation from the old
        // request. Its response may still arrive, but it must not clear or
        // sign out the new account's telemetry.
        if (sendingEpoch !== userEpoch || sendingUser !== currentUser) return false;
        if (response && response.ok) {
          queue = queue.filter((item) => !wanted.has(item.id));
          pendingBatch = null;
          failedBatches = 0;
          droppedEvents = 0;
          retryMs = 1000;
          nextDeliveryAt = 0;
          persist();
          drainImmediately = queue.length > 0;
          return true;
        }
        if (response && (response.status === 401 || response.status === 403)) {
          clearUser();
          return false;
        }
        if (response && response.status === 400) {
          queue = queue.filter((item) => !wanted.has(item.id));
          droppedEvents += batchEvents.length;
          pendingBatch = null;
          persist();
          drainImmediately = queue.length > 0;
        }
        retryMs = Math.max(retryMs, retryAfterDelay(response));
        failedBatches = Math.min(10_000, failedBatches + 1);
      } catch (_) {
        if (sendingEpoch === userEpoch && sendingUser === currentUser) {
          failedBatches = Math.min(10_000, failedBatches + 1);
        }
      } finally {
        if (deadlineTimer) clearTimer(deadlineTimer);
        if (activeRequest?.epoch === sendingEpoch) activeRequest = null;
        sending = false;
        if (sendingEpoch !== userEpoch || sendingUser !== currentUser || drainImmediately) schedule(0);
      }
      if (sendingEpoch !== userEpoch || sendingUser !== currentUser) {
        return false;
      }
      if (drainImmediately) return false;
      nextDeliveryAt = clock() + retryMs;
      schedule(retryMs);
      retryMs = Math.min(60_000, retryMs * 2);
      return false;
    }

    function bootErrorCode(step) {
      if (step === 'resource') return 'boot_resource_failed';
      if (step === 'unhandledrejection') return 'boot_rejection';
      if (step === 'error') return 'boot_script_error';
      return 'boot_step_failed';
    }

    function recordBoot() {
      if (adminRoute()) return;
      screen('shell_boot');
      const attemptId = attempt('shell_boot', { screen: 'shell_boot' });
      if (!attemptId) return;
      const store = env.__unBoot || {};
      const rawErrors = Array.isArray(store.errors) ? store.errors : [];
      const codes = [];
      for (const entry of rawErrors) {
        const code = bootErrorCode(entry && entry.step);
        if (!codes.includes(code)) codes.push(code);
        if (codes.length >= 4) break;
      }
      for (const errorCode of codes) {
        emit('boot_failure', 'shell_boot', { attemptId, action: 'shell_boot', errorCode });
      }
      if (codes.length) troubledActions.add('shell_boot');
      const steps = Array.isArray(store.steps) ? store.steps : [];
      const hydrated = steps.some((entry) => entry && entry.step === 'hydrate');
      outcome(attemptId, hydrated ? 'success' : 'failure', hydrated ? {} : { errorCode: 'boot_incomplete' });
    }

    if (doc && typeof doc.addEventListener === 'function') {
      doc.addEventListener('sv:session', (event) => setUser(
        event?.detail?.user,
        event?.detail?.verifiedSession === true,
      ));
      doc.addEventListener('visibilitychange', () => {
        // A hidden document may only be a tab switch. Flush while the browser
        // gives us time, but reserve navigation_abandonment for pagehide.
        // The navigation mark goes first so it rides in that same flush.
        if (doc.visibilityState === 'hidden') {
          navHidden();
          void flush(true);
        } else if (doc.visibilityState === 'visible') {
          navShown();
        }
      });
      if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', recordBoot, { once: true });
      else setTimer(recordBoot, 0);
    }
    // Back and Forward, where the browser says so (the Navigation API); a
    // browser without it reports those steps as the person's own.
    try {
      env?.navigation?.addEventListener?.('navigate', (event) => {
        if (event && event.navigationType === 'traverse') markNextVia('back');
      });
    } catch (_) { /* optional */ }
    if (env && typeof env.addEventListener === 'function') {
      env.addEventListener('pagehide', () => { abandonPending(); void flush(true); });
      env.addEventListener('online', () => schedule(0));
      env.addEventListener('hashchange', () => { if (!adminRoute()) schedule(0); });
    }

    return {
      screen, navigate, markNextVia, attempt, outcome, cancel, setUser, clearUser, flush,
      contextHeaders, errorCodeFor,
      // Content-free diagnostics for tests and an attached inspector. No
      // queued record body is exposed through the product API.
      diagnostics: () => ({ queued: queue.length, active: attempts.size, droppedEvents, failedBatches }),
    };
  }

  return createUITelemetry;
}));
