/**
 * usernode-native v1 — native.js
 *
 * The behavior half of the Usernode native-feel UI kit. Centrally hosted
 * (like usernode-bridge.js) at:
 *
 *   https://<USERNODE_DOMAIN>/usernode-native/v1/native.js
 *
 * Canonical source: social-vibecoding/public/usernode-native/v1/native.js.
 * Never vendor per app; load the hosted URL. /v1/ is a frozen API surface —
 * additive changes ship in place, breaking changes bump to /v2/.
 *
 * Load together with native.css. Exposes `window.unNative`:
 *
 *   unNative.platform                 — 'ios' | 'android' | 'desktop'
 *   unNative.presets                  — named spring presets (tunable)
 *   unNative.spring(target, opts)     — rAF spring integrator
 *   unNative.attachSwipeActions(row, {actions}) — swipe-to-act list rows
 *   unNative.attachPullToRefresh(scrollEl, onRefresh) — pull-to-refresh
 *   unNative.transition(fn, {type})   — View Transitions wrapper
 *   unNative.physics                  — the pure math (also the node export)
 *
 * Fidelity requirements this file implements (binding; see the kit section
 * of app-conventions.md): 1:1 finger tracking after intent lock, gestures
 * interruptible mid-spring at current position+velocity, commit-vs-cancel
 * by projected momentum (not just distance), spring physics for every
 * gesture release (no duration+bezier), destructive actions fire only on
 * gesture end, high-frequency UI gets no animation.
 *
 * In Node (unit tests) requiring this file exports { physics } and touches
 * no DOM.
 */
(function (global) {
  'use strict';

  /* ────────────────────────────────────────────────────────────────────
   * Physics — pure functions, no DOM. Unit-tested in
   * tests/native-kit.test.js via `require(...).physics`.
   * ──────────────────────────────────────────────────────────────────── */

  // Named spring presets (mass / tension / friction, per Comeau's damped
  // harmonic oscillator model). Tuned on-device via the demo page's
  // ?un-tune=1 overlay; the CSS linear() curves in native.css are
  // pre-computed from these same numbers so JS and CSS motion match.
  var PRESETS = {
    default: { mass: 1, tension: 170, friction: 26 },
    stiff: { mass: 1, tension: 250, friction: 30 },
    gentle: { mass: 1, tension: 120, friction: 24 },
  };

  // iOS-style deceleration rate, per millisecond.
  var DECEL_RATE = 0.998;

  // Rest thresholds: a spring is settled when both are under these.
  var REST_VELOCITY = 0.004; // px per ms (= 4 px/s)
  var REST_DELTA = 0.4; // px

  var STEP_MS = 1; // fixed integration timestep

  // One fixed-timestep integration step of a damped harmonic oscillator.
  // state: { x, v } with x in px and v in px/ms. Mutates and returns state.
  function springStep(state, target, params, dtMs) {
    var dt = (dtMs == null ? STEP_MS : dtMs) / 1000; // seconds
    var vSec = state.v * 1000; // px/s for the classic tension/friction units
    var a = (-params.tension * (state.x - target) - params.friction * vSec) / params.mass;
    vSec += a * dt;
    state.x += vSec * dt;
    state.v = vSec / 1000;
    return state;
  }

  function isAtRest(state, target) {
    return Math.abs(state.v) < REST_VELOCITY && Math.abs(state.x - target) < REST_DELTA;
  }

  // Run a spring to rest synchronously (tests, curve pre-computation).
  // Returns { x, v, durationMs, samples: [{t, x}] }. Hard cap keeps a
  // mis-tuned preset from hanging.
  function simulateSpring(from, to, velocity, params, maxMs) {
    var state = { x: from, v: velocity || 0 };
    var samples = [{ t: 0, x: from }];
    var t = 0;
    var cap = maxMs || 5000;
    while (t < cap) {
      springStep(state, to, params, STEP_MS);
      t += STEP_MS;
      samples.push({ t: t, x: state.x });
      if (isAtRest(state, to)) break;
    }
    return { x: state.x, v: state.v, durationMs: t, samples: samples };
  }

  // Momentum projection: where a gesture released at `position` with
  // velocity `velocity` (px/ms) would coast to under standard deceleration.
  // projected = position + velocity * decelRate / (1 - decelRate)
  function projectMomentum(position, velocity, decelRate) {
    var d = decelRate == null ? DECEL_RATE : decelRate;
    return position + (velocity * d) / (1 - d);
  }

  // Release velocity from a short pointer-sample history. samples is an
  // array of { t (ms), x (px) } in time order; only the trailing
  // `windowMs` (default 100) participates. Returns px/ms (0 if unknowable).
  function estimateVelocity(samples, windowMs) {
    if (!samples || samples.length < 2) return 0;
    var win = windowMs == null ? 100 : windowMs;
    var last = samples[samples.length - 1];
    var first = null;
    for (var i = 0; i < samples.length; i++) {
      if (last.t - samples[i].t <= win) { first = samples[i]; break; }
    }
    if (!first || first === last || last.t === first.t) return 0;
    return (last.x - first.x) / (last.t - first.t);
  }

  // iOS-style rubber-band resistance: asymptotically approaches `limit`,
  // with initial slope `coeff`. Sign-preserving.
  function rubberband(distance, limit, coeff) {
    var c = coeff == null ? 0.55 : coeff;
    var d = Math.abs(distance);
    var out = (1 - 1 / ((d * c) / limit + 1)) * limit;
    return distance < 0 ? -out : out;
  }

  // Inverse of rubberband (same limit/coeff): recovers the raw drag
  // distance that produced a displayed offset. Used to re-enter a drag
  // mid-settle without a position jump.
  function rubberbandInvert(display, limit, coeff) {
    var c = coeff == null ? 0.55 : coeff;
    var y = Math.min(Math.abs(display), limit * 0.999);
    var d = (y * limit) / (c * (limit - y));
    return display < 0 ? -d : d;
  }

  // Axis intent lock: null until movement exceeds `threshold` px on some
  // axis, then 'x' or 'y' — decided once, at lock time.
  function lockIntent(dx, dy, threshold) {
    var t = threshold == null ? 10 : threshold;
    if (Math.abs(dx) < t && Math.abs(dy) < t) return null;
    return Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
  }

  // Swipe-row release decision. x is the row's current offset (<= 0 when
  // revealing right-side actions), v the release velocity in px/ms.
  // Returns 'commit' | 'open' | 'close'. Commit only when the row has a
  // destructive full-swipe action (canCommit).
  function decideSwipeRelease(input) {
    var projected = projectMomentum(input.x, input.v, input.decelRate);
    if (input.canCommit && projected <= -0.6 * input.rowWidth) return 'commit';
    if (projected <= -0.5 * input.trayWidth) return 'open';
    return 'close';
  }

  // Pull-to-refresh release decision: commit on displayed distance OR on
  // projected momentum crossing the threshold (a fast short yank counts).
  function decidePtrRelease(input) {
    if (input.pull >= input.threshold) return true;
    return projectMomentum(input.pull, input.v, input.decelRate) >= input.threshold;
  }

  var physics = {
    PRESETS: PRESETS,
    DECEL_RATE: DECEL_RATE,
    REST_VELOCITY: REST_VELOCITY,
    REST_DELTA: REST_DELTA,
    springStep: springStep,
    simulateSpring: simulateSpring,
    projectMomentum: projectMomentum,
    estimateVelocity: estimateVelocity,
    rubberband: rubberband,
    rubberbandInvert: rubberbandInvert,
    lockIntent: lockIntent,
    decideSwipeRelease: decideSwipeRelease,
    decidePtrRelease: decidePtrRelease,
  };

  // Node (unit tests): export the math and stop — no DOM below this line.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { physics: physics };
  }
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  /* ────────────────────────────────────────────────────────────────────
   * Platform detection
   * ──────────────────────────────────────────────────────────────────── */

  function detectPlatform() {
    try {
      var qp = new URLSearchParams(window.location.search).get('un-platform');
      if (qp === 'ios' || qp === 'android' || qp === 'desktop') return qp;
    } catch (e) { /* no URL API / opaque origin — fall through */ }
    var ua = navigator.userAgent || '';
    // iPadOS 13+ reports MacIntel; maxTouchPoints disambiguates.
    var isIOS = /iPhone|iPad|iPod/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isIOS) return 'ios';
    if (/Android/.test(ua)) return 'android';
    // Other touch-mobile UAs get the Material skin; everything else desktop.
    if (navigator.maxTouchPoints > 0 && /Mobi/.test(ua)) return 'android';
    return 'desktop';
  }

  var platform = detectPlatform();
  document.documentElement.classList.add('un-' + platform);

  var prefersReducedMotion = false;
  try {
    prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) { /* ignore */ }

  /* ────────────────────────────────────────────────────────────────────
   * Runtime spring — rAF loop over the same integrator, fixed-timestep
   * accumulator so feel is frame-rate independent.
   * ──────────────────────────────────────────────────────────────────── */

  function resolvePreset(opts) {
    var base = PRESETS[(opts && opts.preset) || 'default'] || PRESETS.default;
    return {
      mass: (opts && opts.mass) != null ? opts.mass : base.mass,
      tension: (opts && opts.tension) != null ? opts.tension : base.tension,
      friction: (opts && opts.friction) != null ? opts.friction : base.friction,
    };
  }

  // spring(target, opts) — target is an Element (transform written per
  // frame; opts.axis 'x'|'y' picks translateX/translateY) or a callback
  // called with the current value. opts: { from, to, velocity (px/ms),
  // preset | mass/tension/friction, onUpdate, onRest }.
  // Returns { current(): {x, v}, stop(), done }.
  function spring(target, opts) {
    var params = resolvePreset(opts);
    var to = opts.to;
    var state = { x: opts.from, v: opts.velocity || 0 };
    var axis = opts.axis === 'y' ? 'Y' : 'X';
    var apply = typeof target === 'function'
      ? target
      : function (val) { target.style.transform = 'translate' + axis + '(' + val + 'px)'; };
    var handle = {
      done: false,
      current: function () { return { x: state.x, v: state.v }; },
      stop: function () {
        if (handle.done) return;
        handle.done = true;
        if (raf) cancelAnimationFrame(raf);
      },
    };
    var last = performance.now();
    var acc = 0;
    var raf = null;
    function frame(now) {
      if (handle.done) return;
      // Clamp huge gaps (background tab) so the spring can't explode.
      acc += Math.min(now - last, 64);
      last = now;
      var rested = false;
      while (acc >= STEP_MS) {
        springStep(state, to, params, STEP_MS);
        acc -= STEP_MS;
        if (isAtRest(state, to)) {
          state.x = to;
          state.v = 0;
          rested = true;
          break;
        }
      }
      apply(state.x);
      if (opts.onUpdate) opts.onUpdate(state.x, state.v);
      if (rested) {
        handle.done = true;
        if (opts.onRest) opts.onRest();
      } else {
        raf = requestAnimationFrame(frame);
      }
    }
    apply(state.x);
    raf = requestAnimationFrame(frame);
    return handle;
  }

  /* ────────────────────────────────────────────────────────────────────
   * Swipe-to-act rows
   * ──────────────────────────────────────────────────────────────────── */

  var openSwipeRow = null; // at most one revealed row at a time

  document.addEventListener('pointerdown', function (e) {
    if (openSwipeRow && !openSwipeRow.wrap.contains(e.target)) {
      openSwipeRow.close();
    }
  }, true);

  // attachSwipeActions(rowEl, { actions: [{ label, color, destructive,
  // handler }] }). The LAST action is the full-swipe action when it is
  // destructive. The kit wraps rowEl in a .un-swipe container and renders
  // the action tray behind it; rowEl's own markup is untouched.
  // Destructive commit: the row collapses and is removed from the DOM,
  // THEN handler() runs (do the API call / re-render there).
  // Returns { close(), detach() }.
  function attachSwipeActions(rowEl, options) {
    var actions = (options && options.actions) || [];
    if (!actions.length) return { close: function () {}, detach: function () {} };

    var wrap = document.createElement('div');
    wrap.className = 'un-swipe';
    rowEl.parentNode.insertBefore(wrap, rowEl);

    var tray = document.createElement('div');
    tray.className = 'un-swipe-tray';
    actions.forEach(function (action) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'un-swipe-action' + (action.destructive ? ' un-destructive' : '');
      btn.textContent = action.label;
      if (action.color) btn.style.background = action.color;
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (action.destructive) commit(action);
        else { close(); action.handler && action.handler(); }
      });
      tray.appendChild(btn);
    });
    wrap.appendChild(tray);
    wrap.appendChild(rowEl);
    rowEl.classList.add('un-swipe-row');

    var lastAction = actions[actions.length - 1];
    var canCommit = !!lastAction.destructive;

    var offset = 0; // current translateX of the row (<= 0 when revealed)
    var activeSpring = null;
    var drag = null; // { pointerId, startX, startY, base, locked, samples }
    var committing = false;

    function trayWidth() { return tray.offsetWidth || 1; }
    function rowWidth() { return wrap.offsetWidth || 1; }

    function setOffset(x) {
      offset = x;
      rowEl.style.transform = 'translateX(' + x + 'px)';
      wrap.classList.toggle('un-commit-armed', canCommit && x <= -0.6 * rowWidth());
    }

    function springTo(to, velocity, preset, onRest) {
      if (activeSpring) activeSpring.stop();
      activeSpring = spring(function (x) { setOffset(x); }, {
        from: offset, to: to, velocity: velocity, preset: preset || 'default',
        onRest: function () { activeSpring = null; if (onRest) onRest(); },
      });
    }

    function close(velocity) {
      if (openSwipeRow && openSwipeRow.wrap === wrap) openSwipeRow = null;
      springTo(0, velocity || 0, 'stiff');
    }

    function open(velocity) {
      if (openSwipeRow && openSwipeRow.wrap !== wrap) openSwipeRow.close();
      openSwipeRow = api;
      springTo(-trayWidth(), velocity || 0, 'default');
    }

    // Destructive commit: fires only from a release/click (never while a
    // finger is down — the drag handler only previews). Slide fully out,
    // collapse the row's height, remove from DOM, then run the handler.
    function commit(action, velocity) {
      if (committing) return;
      committing = true;
      if (openSwipeRow && openSwipeRow.wrap === wrap) openSwipeRow = null;
      wrap.classList.add('un-committing');
      springTo(-rowWidth(), velocity || 0, 'stiff', function () {
        wrap.style.height = wrap.offsetHeight + 'px';
        // Next frame: transition height -> 0 (CSS handles the curve).
        requestAnimationFrame(function () {
          wrap.classList.add('un-collapsing');
          wrap.style.height = '0px';
          var fired = false;
          function finish() {
            if (fired) return;
            fired = true;
            if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
            action.handler && action.handler();
          }
          wrap.addEventListener('transitionend', finish, { once: true });
          setTimeout(finish, 400); // safety if transitionend never fires
        });
      });
    }

    function onPointerDown(e) {
      if (committing || e.button > 0) return;
      var base = offset;
      var seedV = 0;
      if (activeSpring) {
        // Interrupt: grab the row at its rendered position + velocity.
        var cur = activeSpring.current();
        activeSpring.stop();
        activeSpring = null;
        base = cur.x;
        seedV = cur.v;
        setOffset(base);
      }
      drag = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        base: base,
        locked: base !== 0 ? 'x' : null, // an already-open row re-drags immediately
        samples: [{ t: e.timeStamp - 16, x: base - seedV * 16 }, { t: e.timeStamp, x: base }],
      };
    }

    function onPointerMove(e) {
      if (!drag || e.pointerId !== drag.pointerId) return;
      var dx = e.clientX - drag.startX;
      var dy = e.clientY - drag.startY;
      if (!drag.locked) {
        drag.locked = lockIntent(dx, dy);
        if (drag.locked === 'x') {
          try { rowEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
          wrap.classList.add('un-dragging');
        }
      }
      if (drag.locked !== 'x') return;
      var raw = drag.base + dx;
      var display;
      var tw = trayWidth();
      if (raw > 0) {
        // No leading actions in v1: small elastic give to the right.
        display = rubberband(raw, 48);
      } else if (canCommit || raw >= -tw) {
        // 1:1 while revealing; with a destructive full-swipe the drag stays
        // 1:1 past the tray toward the commit point (finger owns the row).
        display = raw;
      } else {
        // No full-swipe action: rubber-band past the tray's rest width.
        display = -tw + rubberband(raw + tw, 64);
      }
      setOffset(display);
      drag.samples.push({ t: e.timeStamp, x: display });
      if (drag.samples.length > 24) drag.samples.shift();
    }

    function onPointerEnd(e) {
      if (!drag || e.pointerId !== drag.pointerId) return;
      var wasLocked = drag.locked === 'x';
      var samples = drag.samples;
      drag = null;
      wrap.classList.remove('un-dragging');
      if (!wasLocked) return;
      // Anchor the velocity window at the RELEASE moment: dwelling with the
      // finger held still must decay momentum to zero (pointermove stops
      // firing while stationary, so without this the last movement's speed
      // would wrongly survive the pause).
      samples.push({ t: e.timeStamp, x: offset });
      // pointercancel = the browser claimed the gesture (vertical scroll
      // won) — retreat without momentum.
      var v = e.type === 'pointercancel' ? 0 : estimateVelocity(samples);
      var decision = decideSwipeRelease({
        x: offset, v: v, trayWidth: trayWidth(), rowWidth: rowWidth(), canCommit: canCommit,
      });
      if (decision === 'commit') commit(lastAction, v);
      else if (decision === 'open') open(v);
      else close(v);
    }

    // Suppress the click that follows a completed horizontal drag so a
    // swipe never also activates the row's own tap behavior.
    function onClickCapture(e) {
      if (wrap.classList.contains('un-dragging')) { e.stopPropagation(); e.preventDefault(); }
    }

    rowEl.addEventListener('pointerdown', onPointerDown);
    rowEl.addEventListener('pointermove', onPointerMove);
    rowEl.addEventListener('pointerup', onPointerEnd);
    rowEl.addEventListener('pointercancel', onPointerEnd);
    rowEl.addEventListener('click', onClickCapture, true);

    var api = {
      wrap: wrap,
      close: function () { close(0); },
      detach: function () {
        rowEl.removeEventListener('pointerdown', onPointerDown);
        rowEl.removeEventListener('pointermove', onPointerMove);
        rowEl.removeEventListener('pointerup', onPointerEnd);
        rowEl.removeEventListener('pointercancel', onPointerEnd);
        rowEl.removeEventListener('click', onClickCapture, true);
        if (openSwipeRow === api) openSwipeRow = null;
        if (wrap.parentNode) {
          wrap.parentNode.insertBefore(rowEl, wrap);
          wrap.parentNode.removeChild(wrap);
        }
        rowEl.classList.remove('un-swipe-row');
        rowEl.style.transform = '';
      },
    };
    return api;
  }

  /* ────────────────────────────────────────────────────────────────────
   * Pull-to-refresh
   * ──────────────────────────────────────────────────────────────────── */

  var PTR_THRESHOLD = 70; // px of displayed pull that arms a refresh
  var PTR_HOLD = 56; // px the content holds at while refreshing
  var PTR_LIMIT = 150; // rubber-band asymptote
  var PTR_COEFF = 0.4; // initial resistance slope (~dy/2.5)

  // attachPullToRefresh(scrollEl, onRefresh) — scrollEl is the scrollable
  // list container (needs `overscroll-behavior-y: contain`; the kit sets it
  // as a belt-and-braces default). onRefresh() returns a Promise; the
  // spinner holds until it settles. No-op on desktop. Returns { detach() }.
  function attachPullToRefresh(scrollEl, onRefresh) {
    if (platform === 'desktop') return { detach: function () {} };

    var parent = scrollEl.parentNode;
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    scrollEl.style.overscrollBehaviorY = 'contain';

    var puck = document.createElement('div');
    puck.className = 'un-ptr-puck';
    puck.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
      'stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9" /></svg>';
    parent.insertBefore(puck, scrollEl);

    var display = 0; // current displayed pull (px)
    var refreshing = false;
    var activeSpring = null;
    var drag = null; // { startY, startX, baseRaw, locked, samples }

    function render(y) {
      display = y;
      scrollEl.style.transform = y ? 'translateY(' + y + 'px)' : '';
      var progress = Math.min(1, y / PTR_THRESHOLD);
      puck.style.opacity = String(progress);
      puck.style.transform =
        'translate(-50%, ' + (y * 0.55 - 40) + 'px) scale(' + (0.5 + 0.5 * progress) + ') ' +
        'rotate(' + y * 2.2 + 'deg)';
      puck.classList.toggle('un-armed', !refreshing && y >= PTR_THRESHOLD);
    }

    function springTo(to, velocity, onRest) {
      if (activeSpring) activeSpring.stop();
      activeSpring = spring(function (y) { render(Math.max(0, y)); }, {
        from: display, to: to, velocity: velocity, preset: 'gentle',
        onRest: function () { activeSpring = null; if (onRest) onRest(); },
      });
    }

    function startRefresh(velocity) {
      refreshing = true;
      puck.classList.add('un-refreshing');
      puck.classList.remove('un-armed');
      springTo(PTR_HOLD, velocity);
      Promise.resolve()
        .then(function () { return onRefresh(); })
        .catch(function () { /* refresh failures still settle the UI */ })
        .then(function () {
          refreshing = false;
          puck.classList.remove('un-refreshing');
          springTo(0, 0);
        });
    }

    function onTouchStart(e) {
      if (refreshing || e.touches.length !== 1) return;
      if (scrollEl.scrollTop > 0 && !activeSpring && display === 0) return;
      var baseRaw = 0;
      if (activeSpring) {
        // Catch the list mid-settle: re-enter the drag at the equivalent
        // raw pull so rubberband(raw) === the current displayed offset.
        activeSpring.stop();
        activeSpring = null;
        baseRaw = rubberbandInvert(display, PTR_LIMIT, PTR_COEFF);
      }
      drag = {
        startY: e.touches[0].clientY,
        startX: e.touches[0].clientX,
        baseRaw: baseRaw,
        locked: baseRaw > 0 ? 'y' : null,
        samples: [{ t: e.timeStamp, x: display }],
      };
    }

    function onTouchMove(e) {
      if (!drag || refreshing) return;
      var dy = e.touches[0].clientY - drag.startY;
      var dx = e.touches[0].clientX - drag.startX;
      if (!drag.locked) {
        if (scrollEl.scrollTop > 0) { drag = null; return; }
        var axis = lockIntent(dx, dy);
        if (axis === 'x') { drag = null; return; }
        if (axis === 'y' && dy > 0) drag.locked = 'y';
        else if (axis === 'y') { drag = null; return; }
      }
      if (drag.locked !== 'y') return;
      var raw = drag.baseRaw + dy;
      if (raw <= 0) { render(0); drag.samples.push({ t: e.timeStamp, x: 0 }); return; }
      // We own the gesture: stop the browser from scrolling / native PTR.
      // (Registered non-passive for exactly this call.)
      e.preventDefault();
      render(rubberband(raw, PTR_LIMIT, PTR_COEFF));
      drag.samples.push({ t: e.timeStamp, x: display });
      if (drag.samples.length > 24) drag.samples.shift();
    }

    function onTouchEnd(e) {
      if (!drag) return;
      var samples = drag.samples;
      var locked = drag.locked === 'y';
      drag = null;
      if (!locked || display === 0) return;
      // Anchor the velocity window at release (see the swipe handler) so a
      // held-still pause decays momentum before the commit decision.
      samples.push({ t: e.timeStamp, x: display });
      var v = estimateVelocity(samples);
      if (decidePtrRelease({ pull: display, v: v, threshold: PTR_THRESHOLD })) startRefresh(v);
      else springTo(0, v);
    }

    scrollEl.addEventListener('touchstart', onTouchStart, { passive: true });
    scrollEl.addEventListener('touchmove', onTouchMove, { passive: false });
    scrollEl.addEventListener('touchend', onTouchEnd, { passive: true });
    scrollEl.addEventListener('touchcancel', onTouchEnd, { passive: true });

    return {
      detach: function () {
        scrollEl.removeEventListener('touchstart', onTouchStart);
        scrollEl.removeEventListener('touchmove', onTouchMove);
        scrollEl.removeEventListener('touchend', onTouchEnd);
        scrollEl.removeEventListener('touchcancel', onTouchEnd);
        if (activeSpring) activeSpring.stop();
        if (puck.parentNode) puck.parentNode.removeChild(puck);
        scrollEl.style.transform = '';
      },
    };
  }

  /* ────────────────────────────────────────────────────────────────────
   * Page transitions — View Transitions wrapper. type 'none' (the default,
   * and the REQUIRED choice for high-frequency UI like tab switches, menus
   * and panels) runs the mutation with no animation. Re-entrant: a
   * navigation during an active transition skips animation, never queues.
   * ──────────────────────────────────────────────────────────────────── */

  var vtActive = false;

  function transition(fn, opts) {
    var type = (opts && opts.type) || 'none';
    if (
      type === 'none' || vtActive || prefersReducedMotion ||
      typeof document.startViewTransition !== 'function'
    ) {
      fn();
      return Promise.resolve();
    }
    vtActive = true;
    document.documentElement.setAttribute('data-un-vt', type);
    var vt;
    try {
      vt = document.startViewTransition(fn);
    } catch (e) {
      vtActive = false;
      document.documentElement.removeAttribute('data-un-vt');
      fn();
      return Promise.resolve();
    }
    return vt.finished.catch(function () {}).then(function () {
      vtActive = false;
      document.documentElement.removeAttribute('data-un-vt');
    });
  }

  /* ────────────────────────────────────────────────────────────────────
   * Spring tuner (?un-tune=1) — device-tuning aid for the demo page.
   * Mutates unNative.presets live; springs read presets at start time.
   * ──────────────────────────────────────────────────────────────────── */

  function maybeMountTuner() {
    var enabled = false;
    try {
      enabled = new URLSearchParams(window.location.search).get('un-tune') === '1';
    } catch (e) { /* ignore */ }
    if (!enabled) return;
    var panel = document.createElement('div');
    panel.className = 'un-tuner';
    Object.keys(PRESETS).forEach(function (name) {
      ['tension', 'friction'].forEach(function (key) {
        var row = document.createElement('label');
        var span = document.createElement('span');
        var input = document.createElement('input');
        input.type = 'range';
        input.min = key === 'tension' ? 40 : 5;
        input.max = key === 'tension' ? 500 : 60;
        input.value = PRESETS[name][key];
        function label() { span.textContent = name + '.' + key + ' = ' + PRESETS[name][key]; }
        input.addEventListener('input', function () {
          PRESETS[name][key] = Number(input.value);
          label();
        });
        label();
        row.appendChild(span);
        row.appendChild(input);
        panel.appendChild(row);
      });
    });
    document.body.appendChild(panel);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', maybeMountTuner);
  } else {
    maybeMountTuner();
  }

  /* ──────────────────────────────────────────────────────────────────── */

  global.unNative = {
    version: 1,
    platform: platform,
    presets: PRESETS,
    physics: physics,
    spring: spring,
    attachSwipeActions: attachSwipeActions,
    attachPullToRefresh: attachPullToRefresh,
    transition: transition,
  };
})(typeof window !== 'undefined' ? window : globalThis);
