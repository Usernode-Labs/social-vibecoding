// Privacy-bounded UI experience telemetry.
//
// This module observes only call sites that name a stable screen/action code.
// It never walks the DOM for clicks, reads a route/query, serializes a thrown
// error, or accepts arbitrary metadata. Delivery is best-effort and bounded:
// user work never awaits this queue.
//
// The one thing it hears without being called is a script error after boot
// (`client_error`, platform signals wave 2). Such an error is reduced on the
// spot to a fixed name (TypeError…), the message as a template with every
// quoted string, number, id, URL and email replaced by a placeholder, the
// first frame in this origin's own scripts (`/js/app.js:12:34`) and a hash
// of the three. The message and the stack themselves never leave the page.
(function (root, factory) {
  'use strict';
  const create = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createUITelemetry: create, clientError: create.clientError };
  }
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
    'report_dialog', 'change_workspace', 'preview', 'ping_ask', 'notify_ask', ...NAV_SCREENS,
  ]);
  // A full page load is credited to the first REAL screen the shell showed
  // (#4965): the twelve screen roots people land on, never a first-run sheet
  // or the welcome tour. The other four NAV_SCREENS do not count as a
  // landing.
  const LOAD_SCREENS = [
    'home', 'discover', 'communities', 'challenges', 'profile', 'my_proposals',
    'settings', 'messages', 'assistant', 'agent_session', 'app', 'project',
  ];
  const SHEET_SCREENS = new Set([...NAV_SCREENS].filter(
    (code) => !LOAD_SCREENS.includes(code)
  ));
  const VIAS = new Set(['own', 'nudged', 'handed', 'address', 'back', 'returned']);
  const ACTIONS = new Set([
    'shell_boot', 'app_detail_load', 'app_discussion_load',
    'feedback_submit', 'content_report_submit', 'change_create', 'preview_open',
    'push_permission',
    // A request/proposal/governance page opened from a link (#4524): the
    // measure the fast-open work reports against. Keep identical with the
    // server's ACTIONS.
    'topic_load',
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
  // The page-load read (#4965) waits for Navigation Timing to complete:
  // every 500 ms, up to 30 s, then gives up silently.
  const LOAD_POLL_MS = 500;
  const LOAD_POLLS = 60;

  // ── Script errors after boot (`client_error`) ────────────────────────
  //
  // Keep the names, the two patterns, the template rules and the code
  // identical with src/services/ui-telemetry.js (tests/client-errors.test.js
  // holds the two copies to each other): the server re-normalizes the
  // template, computes the code again from what it was sent, and refuses a
  // name, a frame or a code that does not fit, and one refused event drops
  // the whole batch it rode in.
  const CLIENT_ERROR_NAMES = new Set([
    'Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError',
    'EvalError', 'URIError', 'AggregateError', 'InternalError', 'DOMException',
    'AbortError', 'NotAllowedError', 'NotFoundError', 'NotSupportedError',
    'InvalidStateError', 'SecurityError', 'QuotaExceededError', 'NetworkError',
    'TimeoutError', 'DataCloneError', 'InvalidAccessError',
    'HierarchyRequestError', 'InvalidCharacterError', 'NotReadableError',
    'OperationError',
  ]);
  const CLIENT_ERROR_CODE_RE = /^js_[a-z0-9]{6,16}$/;
  const CLIENT_ERROR_FRAME_RE = /^\/(?:js|shell\/assets)\/[A-Za-z0-9_.\/-]{1,160}:\d{1,7}:\d{1,7}$/;
  const MAX_TEMPLATE_CHARS = 120;
  // A visit reports at most this many script errors, each code once.
  const MAX_CLIENT_ERRORS = 5;
  // One frame of a stack, in the three engines' shapes, ending in
  // `url:line:col`: `at f (https://h/js/a.js:1:2)`, `f@https://h/js/a.js:1:2`.
  // The URL starts after a space, `(` or `@`, so Firefox's `f/<@https://…`
  // is never read as a path of this origin.
  const STACK_URL_RE = /(?:^|[\s(@])([a-z][a-z0-9+.-]*:\/\/[^\s()]+?|\/[^\s()@]*?):(\d+):(\d+)\)?\s*$/i;
  // A deployed document loads its scripts from `/b/<build sha>/js/…`
  // (frontend/src/lib/asset-url.ts); the build is reported on its own.
  const BUILD_PREFIX_RE = /^\/b\/[0-9a-f]{7,40}(?=\/)/;

  // Lone surrogates out: Postgres refuses them in jsonb.
  function wellFormed(text) {
    let out = '';
    for (let i = 0; i < text.length; i += 1) {
      const c = text.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const d = text.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) { out += text[i] + text[i + 1]; i += 1; }
        continue;
      }
      if (c >= 0xdc00 && c <= 0xdfff) continue;
      out += text[i];
    }
    return out;
  }

  function templatePass(text) {
    let out = text
      // Control, bidi and zero-width characters say nothing about an error.
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g, ' ')
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>]+/gi, '[url]')
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
      .replace(/"[^"]*"/g, '[string]')
      .replace(/`[^`]*`/g, '[string]')
      .replace(/[\u201c\u2018][^\u201d\u2019]*[\u201d\u2019]/g, '[string]');
    // A single quote opens a string only where it is not an apostrophe
    // ("can't"); repeated, because a replaced string can open the next.
    for (let i = 0; i < 20; i += 1) {
      const next = out.replace(/(^|[^A-Za-z0-9])'[^']*'/g, '$1[string]');
      if (next === out) break;
      out = next;
    }
    out = out
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[id]')
      .replace(/\b0x[0-9a-f]+\b/gi, '[hex]')
      .replace(/\b(?=[a-f]*\d)[0-9a-f]{6,}\b/gi, '[hex]')
      .replace(/(^|[^A-Za-z0-9])\d+(?:[.,]\d+)*/g, '$1[number]')
      .replace(/\s+/g, ' ')
      .trim();
    out = wellFormed(out);
    if (out.length > MAX_TEMPLATE_CHARS) out = `${wellFormed(out.slice(0, MAX_TEMPLATE_CHARS - 1))}\u2026`;
    return out;
  }

  /** Pure: an error's message as a template, placeholders for every value. */
  function normalizeErrorTemplate(raw) {
    let out = templatePass(wellFormed(String(raw == null ? '' : raw).slice(0, 2000)));
    // Run to a fixed point, so the server's second pass changes nothing.
    for (let i = 0; i < 3; i += 1) {
      const next = templatePass(out);
      if (next === out) break;
      out = next;
    }
    return out;
  }

  /** Pure: a short stable hash (cyrb53, base 36, 11 characters). */
  function errorHash(text) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36).padStart(11, '0');
  }

  /**
   * Pure: the code a script error is grouped by. The frame counts by its
   * file alone: its line and column move with every build of the shell
   * bundle, and one bug keeps one code (and one request) across releases.
   */
  function clientErrorCode(errorName, template, frame) {
    const path = String(frame || '').replace(/:\d+:\d+$/, '');
    return `js_${errorHash(`${errorName}|${template}|${path}`)}`;
  }

  // `{ origin, path }` of a frame's URL, or null when it is not one.
  function placeOf(url, origin) {
    try {
      const parsed = new URL(url, `${origin}/`);
      return { origin: parsed.origin, path: parsed.pathname };
    } catch (_) { return null; }
  }

  // `/js/app.js:12:34` for a frame in this origin's own scripts, else null.
  function ownFrame(path, line, col) {
    const bare = String(path || '').replace(BUILD_PREFIX_RE, '');
    if (bare.includes('..') || bare.includes('//')) return null;
    const frame = `${bare}:${line}:${col}`;
    return CLIENT_ERROR_FRAME_RE.test(frame) ? frame : null;
  }

  /**
   * Pure: what is reported of one `error` or `unhandledrejection` event:
   * { errorName, template, frame, errorCode }, or null when it is not this
   * origin's (an extension, another origin's script, a muted "Script
   * error."), not a thrown error (a resource that failed to load) or says
   * nothing (a rejection with a bare value).
   */
  function describeClientError(source, event, origin) {
    if (!event || typeof origin !== 'string' || !origin || origin === 'null') return null;
    let error = null;
    let message = '';
    let filename = '';
    let lineno = 0;
    let colno = 0;
    if (source === 'error') {
      // A script or stylesheet that failed to load: the boot watchdog's.
      const target = event.target;
      if (target && typeof target === 'object' && target.tagName) return null;
      error = event.error;
      message = typeof event.message === 'string' ? event.message : '';
      filename = typeof event.filename === 'string' ? event.filename : '';
      lineno = Number.isSafeInteger(event.lineno) ? event.lineno : 0;
      colno = Number.isSafeInteger(event.colno) ? event.colno : 0;
    } else if (source === 'unhandledrejection') {
      error = event.reason;
      if (!error || typeof error !== 'object') return null;
    } else {
      return null;
    }
    const errorLike = !!error && typeof error === 'object';
    let rawName = '';
    let text = '';
    if (errorLike) {
      try {
        rawName = typeof error.name === 'string' ? error.name : '';
        text = typeof error.message === 'string' ? error.message : '';
      } catch (_) { return null; }
    } else {
      text = message.replace(/^\s*Uncaught\s+/, '');
      if (/^\s*script error\.?\s*$/i.test(text)) return null;
      const named = /^([A-Z][A-Za-z]*(?:Error|Exception))(?::\s*|$)/.exec(text);
      if (named) { rawName = named[1]; text = text.slice(named[0].length); }
    }
    let stack = '';
    try { stack = errorLike && typeof error.stack === 'string' ? error.stack.slice(0, 8000) : ''; } catch (_) { stack = ''; }
    const places = [];
    for (const line of stack.split('\n').slice(0, 50)) {
      const m = STACK_URL_RE.exec(line);
      if (m) places.push({ url: m[1], line: m[2], col: m[3] });
    }
    if (filename) {
      const thrownAt = placeOf(filename, origin);
      if (thrownAt && thrownAt.origin !== origin) return null;
      places.push({ url: filename, line: String(lineno), col: String(colno) });
    }
    // The first frame that names a place decides whose error it is.
    let owner = null;
    let frame = null;
    for (const p of places) {
      const where = placeOf(p.url, origin);
      if (!where) continue;
      if (owner === null) owner = where.origin;
      if (where.origin !== origin) continue;
      frame = frame || ownFrame(where.path, p.line, p.col);
      if (frame) break;
    }
    if (owner !== null && owner !== origin) return null;
    // Nothing places a thrown error: muted, or not a script's.
    if (owner === null && source === 'error') return null;
    const errorName = CLIENT_ERROR_NAMES.has(rawName) ? rawName : 'Error';
    const template = normalizeErrorTemplate(text);
    if (!template && !frame) return null;
    return { errorName, template, frame, errorCode: clientErrorCode(errorName, template, frame) };
  }

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
    // One full page load (#4965): the first real screen the shell showed,
    // and whether that load has already been reported. Page-scoped on
    // purpose — resetObservations() clears a person's observations, not the
    // load this page is one of.
    let landingScreen = null;
    let loadRecorded = false;
    let loadEnded = false;
    let loadPolls = 0;
    let loadScheduled = false;
    // Script errors (`client_error`): heard only once the boot has been
    // classified, so an error is either a boot_failure or one of these,
    // never both. Page-scoped like the load: at most MAX_CLIENT_ERRORS per
    // visit, each code once.
    let booted = false;
    let clientErrorsSent = 0;
    const clientErrorCodes = new Set();

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
      if (kind === 'client_error') return emitClientError(screen, detail);
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
      return enqueue(item);
    }

    function enqueue(item) {
      const build = platformBuild();
      if (build) item.build = build;
      queue.push(item);
      trim(clock());
      persist();
      schedule();
      return item.id;
    }

    // A script error carries its own four fields and nothing else: no
    // attempt, action, app or duration (src/services/ui-telemetry.js
    // refuses any of them on a client_error).
    function emitClientError(screenCode, detail) {
      if (!CLIENT_ERROR_CODE_RE.test(detail.errorCode) || !CLIENT_ERROR_NAMES.has(detail.errorName)
          || typeof detail.template !== 'string' || detail.template.length > MAX_TEMPLATE_CHARS
          || (detail.frame != null && !CLIENT_ERROR_FRAME_RE.test(detail.frame))) return null;
      const item = {
        id: randomId(),
        visitId,
        kind: 'client_error',
        screen: screenCode,
        occurredAt: new Date(clock()).toISOString(),
        sequence: ++sequence,
        errorCode: detail.errorCode,
        errorName: detail.errorName,
        template: detail.template,
      };
      if (detail.frame) item.frame = detail.frame;
      return enqueue(item);
    }

    function ownOrigin() {
      try {
        const origin = env.location && env.location.origin;
        return typeof origin === 'string' && origin && origin !== 'null' ? origin : null;
      } catch (_) { return null; }
    }

    // The window's `error` / `unhandledrejection`, after boot. It never logs
    // and never throws: a second error raised from here would be heard here.
    function recordClientError(source, event) {
      try {
        if (!booted || collectionDisabled || clientErrorsSent >= MAX_CLIENT_ERRORS || adminRoute()) return;
        const fields = describeClientError(source, event, ownOrigin());
        if (!fields || clientErrorCodes.has(fields.errorCode)) return;
        const id = emit('client_error', currentNav ? currentNav.screen : 'shell_boot', fields);
        if (!id) return;
        clientErrorCodes.add(fields.errorCode);
        clientErrorsSent += 1;
      } catch (_) { /* the page's error is not made worse by its report */ }
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
      // The load is credited to the first real screen shown (#4965); a
      // first-run sheet or the welcome tour is not a landing.
      if (landingScreen === null && !SHEET_SCREENS.has(screenCode)) {
        landingScreen = screenCode;
        if (loadEnded) recordPageLoad();
      }
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

    // One measured full page load (#4965): browser start to load finish, read
    // from Navigation Timing once. It is credited to the first real screen
    // the shell showed; a load that ended before any screen did is kept
    // under shell_boot ("Left before a screen showed"). A page hidden before
    // its load finishes is dropped: browsers slow hidden pages on purpose.
    // Only the screen name and the milliseconds are sent.
    function readLoadMs() {
      try {
        if (typeof env.performance?.getEntriesByType !== 'function') return null;
        const nav = env.performance.getEntriesByType('navigation')[0];
        if (!nav || typeof nav.loadEventEnd !== 'number') return null;
        const start = Number.isFinite(nav.startTime) ? nav.startTime : 0;
        const durationMs = nav.loadEventEnd - start;
        return Number.isFinite(durationMs) && durationMs > 0 ? durationMs : null;
      } catch (_) { return null; }
    }

    function recordPageLoad() {
      if (loadRecorded) return;
      loadRecorded = true;
      const durationMs = readLoadMs();
      if (durationMs == null) return;
      emit('page_load', landingScreen || 'shell_boot', { durationMs });
    }

    function schedulePageLoad() {
      if (loadScheduled || adminRoute()) return;
      loadScheduled = true;
      const poll = () => {
        if (loadRecorded) return;
        const durationMs = readLoadMs();
        if (durationMs == null && ++loadPolls <= LOAD_POLLS) {
          setTimer(poll, LOAD_POLL_MS);
          return;
        }
        if (durationMs != null) {
          loadEnded = true;
          // No screen has landed yet: wait for one, or for pagehide to keep
          // the load under shell_boot.
          if (landingScreen) recordPageLoad();
        }
      };
      setTimer(poll, LOAD_POLL_MS);
    }

    function recordBoot() {
      // From here on an error is a client_error: everything before it is in
      // __unBoot.errors, read below as boot failures.
      booted = true;
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
          // A page hidden before its load finishes is not measured (#4965):
          // browsers slow hidden pages on purpose. A load that already ended
          // keeps the reading it took.
          if (!loadEnded) loadRecorded = true;
          void flush(true);
        } else if (doc.visibilityState === 'visible') {
          navShown();
        }
      });
      if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', recordBoot, { once: true });
      else setTimer(recordBoot, 0);
      schedulePageLoad();
    }
    // Back and Forward, where the browser says so (the Navigation API); a
    // browser without it reports those steps as the person's own.
    try {
      env?.navigation?.addEventListener?.('navigate', (event) => {
        if (event && event.navigationType === 'traverse') markNextVia('back');
      });
    } catch (_) { /* optional */ }
    if (env && typeof env.addEventListener === 'function') {
      env.addEventListener('pagehide', () => {
        // A load that finished but never landed on a screen is kept under
        // shell_boot (#4965); it rides out in this same flush.
        if (loadEnded) recordPageLoad();
        abandonPending();
        void flush(true);
      });
      env.addEventListener('online', () => schedule(0));
      env.addEventListener('hashchange', () => { if (!adminRoute()) schedule(0); });
      // Bubble phase: a resource that failed to load does not reach it (the
      // boot watchdog in frontend/src/head.html hears those in capture).
      // Nothing here calls preventDefault, so the browser still reports the
      // error as it always did.
      env.addEventListener('error', (event) => recordClientError('error', event));
      env.addEventListener('unhandledrejection', (event) => recordClientError('unhandledrejection', event));
    }

    return {
      screen, navigate, markNextVia, attempt, outcome, cancel, setUser, clearUser, flush,
      contextHeaders, errorCodeFor,
      // Content-free diagnostics for tests and an attached inspector. No
      // queued record body is exposed through the product API.
      diagnostics: () => ({ queued: queue.length, active: attempts.size, droppedEvents, failedBatches }),
    };
  }

  // The pure half of client_error, for tests/client-errors.test.js.
  createUITelemetry.clientError = Object.freeze({
    NAMES: CLIENT_ERROR_NAMES,
    CODE_RE: CLIENT_ERROR_CODE_RE,
    FRAME_RE: CLIENT_ERROR_FRAME_RE,
    MAX_TEMPLATE_CHARS,
    MAX_PER_VISIT: MAX_CLIENT_ERRORS,
    normalizeTemplate: normalizeErrorTemplate,
    code: clientErrorCode,
    describe: describeClientError,
  });

  return createUITelemetry;
}));
