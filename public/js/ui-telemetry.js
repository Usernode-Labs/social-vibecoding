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

  const SCREENS = new Set([
    'shell_boot', 'app_detail', 'app_discussion', 'feedback_dialog',
    'report_dialog', 'change_workspace', 'preview',
  ]);
  const ACTIONS = new Set([
    'shell_boot', 'app_detail_load', 'app_discussion_load',
    'feedback_submit', 'content_report_submit', 'change_create', 'preview_open',
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
    let queue = [];
    let droppedEvents = 0;
    let failedBatches = 0;
    let flushTimer = null;
    let retryMs = 1000;
    let sending = false;
    let pendingBatch = null;
    let userEpoch = 0;
    let activeRequest = null;
    const attempts = new Map();
    const lastAttempts = new Map();
    const troubledActions = new Set();

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
      if (!storage || !currentUser) return;
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

    function cancelInFlight() {
      if (!activeRequest) return;
      try { activeRequest.controller?.abort(); } catch (_) { /* the deadline still releases it */ }
      activeRequest.reject();
      activeRequest = null;
    }

    function schedule(delay) {
      if (!currentUser || sending || flushTimer || !queue.length || adminRoute()) return;
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
      if (adminRoute() || !SCREENS.has(screen)) return null;
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

    function attempt(action, context) {
      context = context || {};
      if (adminRoute() || !ACTIONS.has(action) || !SCREENS.has(context.screen)) return null;
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
      const headers = { 'X-UI-Visit-ID': visitId };
      if (attempts.has(attemptId)) headers['X-UI-Attempt-ID'] = attemptId;
      return headers;
    }

    function setUser(userId) {
      const next = userId == null ? null : String(userId);
      if (!next) { clearUser(); return; }
      if (currentUser === next) { schedule(0); return; }
      cancelInFlight();
      if (currentUser) {
        clearStored(currentUser);
        queue = [];
        droppedEvents = 0;
        failedBatches = 0;
      }
      currentUser = next;
      userEpoch += 1;
      attempts.forEach((record) => { if (record.timer) clearTimer(record.timer); });
      attempts.clear();
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
      currentUser = null;
      userEpoch += 1;
      queue = [];
      pendingBatch = null;
      attempts.forEach((record) => { if (record.timer) clearTimer(record.timer); });
      attempts.clear();
      lastAttempts.clear();
      troubledActions.clear();
      droppedEvents = 0;
      failedBatches = 0;
    }

    async function flush(keepalive) {
      if (!fetcher || !currentUser || sending || !queue.length || adminRoute()) return false;
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
            schemaVersion: 1,
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
      doc.addEventListener('sv:session', (event) => setUser(event?.detail?.user?.id));
      doc.addEventListener('visibilitychange', () => {
        // A hidden document may only be a tab switch. Flush while the browser
        // gives us time, but reserve navigation_abandonment for pagehide.
        if (doc.visibilityState === 'hidden') void flush(true);
      });
      if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', recordBoot, { once: true });
      else setTimer(recordBoot, 0);
    }
    if (env && typeof env.addEventListener === 'function') {
      env.addEventListener('pagehide', () => { abandonPending(); void flush(true); });
      env.addEventListener('online', () => schedule(0));
      env.addEventListener('hashchange', () => { if (!adminRoute()) schedule(0); });
    }

    return {
      screen, attempt, outcome, cancel, setUser, clearUser, flush,
      contextHeaders, errorCodeFor,
      // Content-free diagnostics for tests and an attached inspector. No
      // queued record body is exposed through the product API.
      diagnostics: () => ({ queued: queue.length, active: attempts.size, droppedEvents, failedBatches }),
    };
  }

  return createUITelemetry;
}));
