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
 *   unNative.attachPullToRefresh(scrollEl, onRefresh, opts?) — pull-to-refresh
 *                                        (element container OR the window
 *                                        scroller; never throws on bad input)
 *   unNative.transition(fn, {type})   — View Transitions wrapper
 *   unNative.presentSheet(opts)       — bottom sheet (drag-to-dismiss)
 *   unNative.actionSheet(opts)        — iOS action sheet, Promise-based
 *   unNative.alert(opts)              — iOS alert dialog, Promise-based
 *   unNative.attachNavBar(bar, opts)  — blurred nav bar + large-title collapse
 *   unNative.gestures                 — the shared gesture arbiter
 *                                        { claim, owner, release }
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
  // Kept exported for compatibility; release decisions now use the bounded
  // projectDisplacement below (the full coast ≈ v·499ms over-weights tiny
  // flicks — issue #690).
  function projectMomentum(position, velocity, decelRate) {
    var d = decelRate == null ? DECEL_RATE : decelRate;
    return position + (velocity * d) / (1 - d);
  }

  // Bounded momentum projection for commit decisions: where the gesture
  // lands within a short horizon (default COMMIT_HORIZON_MS, tunable via
  // the ?un-tune=1 overlay). Matches the reference rebuild's x + v·0.12s.
  function projectDisplacement(position, velocity, horizonMs) {
    var h = horizonMs == null ? physics.COMMIT_HORIZON_MS : horizonMs;
    return position + velocity * h;
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
    var projected = projectDisplacement(input.x, input.v, input.horizonMs);
    if (input.canCommit && projected <= -0.6 * input.rowWidth) return 'commit';
    if (projected <= -0.5 * input.trayWidth) return 'open';
    return 'close';
  }

  // Pull-to-refresh release decision: commit on displayed distance OR on
  // projected momentum crossing the threshold (a fast short yank counts).
  function decidePtrRelease(input) {
    if (input.pull >= input.threshold) return true;
    return projectDisplacement(input.pull, input.v, input.horizonMs) >= input.threshold;
  }

  // Bottom-sheet release decision. y is the sheet's downward displacement
  // from rest (>= 0), v the release velocity in px/ms (positive = down).
  // Dismiss when the projected landing crosses half the sheet height.
  function decideSheetRelease(input) {
    return projectDisplacement(input.y, input.v, input.horizonMs) >= 0.5 * input.sheetHeight;
  }

  // Gesture arbiter core: one owner per gesture sequence, decided once —
  // the first recognizer to claim a sequence wins it, everyone else backs
  // off. Pure (no DOM); the kit wires one instance to real pointer/touch
  // sequences and exposes it as unNative.gestures.
  function createArbiter() {
    var owners = Object.create(null);
    return {
      // First claim wins; re-claiming with the same token is idempotent.
      claim: function (seq, token) {
        if (seq == null || token == null) return false;
        var key = String(seq);
        if (key in owners) return owners[key] === token;
        owners[key] = token;
        return true;
      },
      owner: function (seq) {
        var key = String(seq);
        return key in owners ? owners[key] : null;
      },
      release: function (seq) {
        delete owners[String(seq)];
      },
    };
  }

  var physics = {
    PRESETS: PRESETS,
    DECEL_RATE: DECEL_RATE,
    REST_VELOCITY: REST_VELOCITY,
    REST_DELTA: REST_DELTA,
    // Default horizon (ms) for release-decision projection. Mutable via the
    // ?un-tune=1 overlay; projectDisplacement reads it at call time.
    COMMIT_HORIZON_MS: 120,
    springStep: springStep,
    simulateSpring: simulateSpring,
    projectMomentum: projectMomentum,
    projectDisplacement: projectDisplacement,
    estimateVelocity: estimateVelocity,
    rubberband: rubberband,
    rubberbandInvert: rubberbandInvert,
    lockIntent: lockIntent,
    decideSwipeRelease: decideSwipeRelease,
    decidePtrRelease: decidePtrRelease,
    decideSheetRelease: decideSheetRelease,
    createArbiter: createArbiter,
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

  // Haptic tick for threshold crossings (arm/disarm cues). navigator.vibrate
  // exists on Android; iOS Safari has no vibration API — silently no-ops.
  function haptic(ms) {
    try {
      if (navigator.vibrate) navigator.vibrate(ms == null ? 10 : ms);
    } catch (e) { /* ignore */ }
  }

  /* ────────────────────────────────────────────────────────────────────
   * Gesture arbiter — one intent lock across kit AND app gestures.
   * Sequences: the primary touch (pointer or touch events) is 'touch' so
   * pointer-driven swipe rows and touch-driven PTR contend for the same
   * finger; non-touch pointers key by pointerId. Claims auto-clear when
   * the sequence ends. App gestures join via unNative.gestures: claim at
   * your own intent-lock moment (never before movement passes the lock
   * threshold) and back off when claim() returns false.
   * ──────────────────────────────────────────────────────────────────── */

  var gestures = createArbiter();

  function gestureSeq(e) {
    if (typeof e.pointerId === 'number') {
      return e.pointerType === 'touch' && e.isPrimary !== false ? 'touch' : e.pointerId;
    }
    return 'touch';
  }

  window.addEventListener('pointerup', function (e) { gestures.release(gestureSeq(e)); }, true);
  window.addEventListener('pointercancel', function (e) { gestures.release(gestureSeq(e)); }, true);
  window.addEventListener('touchend', function (e) {
    if (!e.touches || e.touches.length === 0) gestures.release('touch');
  }, true);
  window.addEventListener('touchcancel', function (e) {
    if (!e.touches || e.touches.length === 0) gestures.release('touch');
  }, true);

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
    var commitArmed = false;
    var trayNaturalW = 0; // measured shrink-wrap width; re-measured per drag

    function measureTray() {
      tray.style.width = '';
      trayNaturalW = tray.offsetWidth || 1;
      return trayNaturalW;
    }

    function trayWidth() { return trayNaturalW || measureTray(); }
    function rowWidth() { return wrap.offsetWidth || 1; }

    // Ride-along tray: the tray is anchored off the row's right edge and
    // translates in lockstep with it, so nothing is ever painted BEHIND
    // the row (rounded corners / margins / translucent rows stay clean).
    // Past the tray's natural width it is stretched to keep its right
    // edge flush while the destructive button grows to fill.
    function setOffset(x) {
      offset = x;
      var t = 'translateX(' + x + 'px)';
      rowEl.style.transform = t;
      tray.style.transform = t;
      var tw = trayWidth();
      tray.style.width = -x > tw ? -x + 'px' : '';
      var armed = canCommit && x <= -0.6 * rowWidth();
      if (armed !== commitArmed) {
        commitArmed = armed;
        wrap.classList.toggle('un-commit-armed', armed);
        haptic();
      }
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
      // An already-open or mid-spring row re-drags immediately — which
      // means claiming the gesture sequence up front.
      var immediate = offset !== 0 || !!activeSpring;
      if (immediate && !gestures.claim(gestureSeq(e), wrap)) return;
      if (!activeSpring) measureTray();
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
        locked: immediate ? 'x' : null,
        samples: [{ t: e.timeStamp - 16, x: base - seedV * 16 }, { t: e.timeStamp, x: base }],
      };
    }

    function onPointerMove(e) {
      if (!drag || e.pointerId !== drag.pointerId) return;
      var dx = e.clientX - drag.startX;
      var dy = e.clientY - drag.startY;
      if (!drag.locked) {
        var axis = lockIntent(dx, dy);
        if (axis === 'x' && !gestures.claim(gestureSeq(e), wrap)) {
          // Another recognizer owns this finger — back off for good.
          drag = null;
          return;
        }
        drag.locked = axis;
        if (axis === 'x') {
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

  // attachPullToRefresh(scrollEl, onRefresh, opts?) — scrollEl is either a
  // scrollable list container (needs `overscroll-behavior-y: contain`; the
  // kit sets it as a belt-and-braces default) OR the window scroller
  // (window / document / document.scrollingElement / <html> / <body>). In
  // window mode the rubberband translate is applied to opts.content
  // (default: document.body.firstElementChild — the #app-style root — or
  // document.body) and the puck is fixed-positioned. onRefresh() returns a
  // Promise; the spinner holds until it settles. No-op on desktop. Invalid
  // input NEVER throws: it warns once and returns a no-op { detach() }.
  function attachPullToRefresh(scrollEl, onRefresh, opts) {
    var noop = { detach: function () {} };
    if (platform === 'desktop') return noop;

    var windowMode = scrollEl === window || scrollEl === document ||
      scrollEl === document.scrollingElement ||
      scrollEl === document.documentElement || scrollEl === document.body;

    var content; // the element the rubberband translate is written to
    var listenEl; // where the touch listeners live
    var puckHome; // where the puck is inserted

    if (windowMode) {
      content = (opts && opts.content) || document.body.firstElementChild || document.body;
      if (!content || content.nodeType !== 1) {
        console.warn('[unNative] attachPullToRefresh: opts.content must be an Element — pull-to-refresh disabled.');
        return noop;
      }
      listenEl = window;
      puckHome = document.body;
      // Suppress the browser's own overscroll / native PTR on the page.
      document.documentElement.style.overscrollBehaviorY = 'contain';
      document.body.style.overscrollBehaviorY = 'contain';
    } else {
      if (!scrollEl || scrollEl.nodeType !== 1 ||
          !scrollEl.parentNode || scrollEl.parentNode.nodeType !== 1) {
        console.warn('[unNative] attachPullToRefresh: pass a scrollable Element with an Element parent, or the window/document scroller — pull-to-refresh disabled.');
        return noop;
      }
      content = scrollEl;
      listenEl = scrollEl;
      puckHome = scrollEl.parentNode;
      if (getComputedStyle(puckHome).position === 'static') puckHome.style.position = 'relative';
      scrollEl.style.overscrollBehaviorY = 'contain';
    }

    var puck = document.createElement('div');
    puck.className = 'un-ptr-puck' + (windowMode ? ' un-ptr-puck-fixed' : '');
    puck.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
      'stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9" /></svg>';
    if (windowMode) puckHome.appendChild(puck);
    else puckHome.insertBefore(puck, scrollEl);

    var ptrToken = { ptr: true }; // arbiter owner token for this instance
    var display = 0; // current displayed pull (px)
    var refreshing = false;
    var activeSpring = null;
    var drag = null; // { startY, startX, baseRaw, locked, samples }
    var armed = false;

    function scrollTop() {
      return windowMode ? (window.scrollY || 0) : scrollEl.scrollTop;
    }

    function render(y) {
      display = y;
      content.style.transform = y ? 'translateY(' + y + 'px)' : '';
      var progress = Math.min(1, y / PTR_THRESHOLD);
      puck.style.opacity = String(progress);
      puck.style.transform =
        'translate(-50%, ' + (y * 0.55 - 40) + 'px) scale(' + (0.5 + 0.5 * progress) + ') ' +
        'rotate(' + y * 2.2 + 'deg)';
      var nowArmed = !refreshing && y >= PTR_THRESHOLD;
      if (nowArmed !== armed) {
        armed = nowArmed;
        puck.classList.toggle('un-armed', armed);
        if (armed) haptic();
      }
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
      if (scrollTop() > 0 && !activeSpring && display === 0) return;
      var baseRaw = 0;
      if (activeSpring) {
        // Catch the list mid-settle — which means claiming the sequence
        // up front; re-enter the drag at the equivalent raw pull so
        // rubberband(raw) === the current displayed offset.
        if (!gestures.claim('touch', ptrToken)) return;
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
        if (scrollTop() > 0) { drag = null; return; }
        var axis = lockIntent(dx, dy);
        if (axis === 'x') { drag = null; return; }
        if (axis === 'y' && dy > 0) {
          if (!gestures.claim('touch', ptrToken)) {
            // Another recognizer (a swipe row, an app gesture) owns this
            // finger — back off for good.
            drag = null;
            return;
          }
          drag.locked = 'y';
        } else if (axis === 'y') { drag = null; return; }
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

    listenEl.addEventListener('touchstart', onTouchStart, { passive: true });
    listenEl.addEventListener('touchmove', onTouchMove, { passive: false });
    listenEl.addEventListener('touchend', onTouchEnd, { passive: true });
    listenEl.addEventListener('touchcancel', onTouchEnd, { passive: true });

    return {
      detach: function () {
        listenEl.removeEventListener('touchstart', onTouchStart);
        listenEl.removeEventListener('touchmove', onTouchMove);
        listenEl.removeEventListener('touchend', onTouchEnd);
        listenEl.removeEventListener('touchcancel', onTouchEnd);
        if (activeSpring) activeSpring.stop();
        if (puck.parentNode) puck.parentNode.removeChild(puck);
        content.style.transform = '';
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
   * Bottom sheet — spring presentation, grabber, 1:1 drag-to-dismiss with
   * momentum commit. A touch mid-spring inherits position + velocity.
   * ──────────────────────────────────────────────────────────────────── */

  // presentSheet({ content | contentEl, onDismiss }) — content is an HTML
  // string, contentEl an Element to adopt. Returns { dismiss(), el }.
  function presentSheet(options) {
    var opts = options || {};
    var backdrop = document.createElement('div');
    backdrop.className = 'un-backdrop';
    var sheet = document.createElement('div');
    sheet.className = 'un-sheet';
    var grabber = document.createElement('div');
    grabber.className = 'un-sheet-grabber';
    sheet.appendChild(grabber);
    var body = document.createElement('div');
    body.className = 'un-sheet-body';
    if (opts.contentEl) body.appendChild(opts.contentEl);
    else if (opts.content != null) body.innerHTML = opts.content;
    sheet.appendChild(body);
    document.body.appendChild(backdrop);
    document.body.appendChild(sheet);

    var height = sheet.offsetHeight || 1;
    var y = height; // translateY: 0 = presented, height = offscreen
    var activeSpring = null;
    var drag = null;
    var closed = false;
    var token = { sheet: true };

    function render(val) {
      y = val;
      sheet.style.transform = 'translateY(' + val + 'px)';
      backdrop.style.opacity = String(Math.max(0, Math.min(1, 1 - val / height)));
    }

    function springTo(to, velocity, onRest) {
      if (activeSpring) activeSpring.stop();
      activeSpring = spring(function (v) { render(v); }, {
        from: y, to: to, velocity: velocity || 0, preset: 'default',
        onRest: function () { activeSpring = null; if (onRest) onRest(); },
      });
    }

    function teardown() {
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      if (sheet.parentNode) sheet.parentNode.removeChild(sheet);
      if (opts.onDismiss) opts.onDismiss();
    }

    function dismiss(velocity) {
      if (closed) return;
      closed = true;
      springTo(height, velocity || 0, teardown);
    }

    backdrop.addEventListener('click', function () { dismiss(0); });

    function onPointerDown(e) {
      if (closed || e.button > 0) return;
      var immediate = !!activeSpring;
      if (immediate && !gestures.claim(gestureSeq(e), token)) return;
      var base = y;
      var seedV = 0;
      if (activeSpring) {
        var cur = activeSpring.current();
        activeSpring.stop();
        activeSpring = null;
        base = cur.x;
        seedV = cur.v;
        render(base);
      }
      drag = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        base: base,
        locked: immediate ? 'y' : null,
        samples: [{ t: e.timeStamp - 16, x: base - seedV * 16 }, { t: e.timeStamp, x: base }],
      };
    }

    function onPointerMove(e) {
      if (!drag || e.pointerId !== drag.pointerId) return;
      var dx = e.clientX - drag.startX;
      var dy = e.clientY - drag.startY;
      if (!drag.locked) {
        var axis = lockIntent(dx, dy);
        if (axis === 'x') { drag = null; return; }
        if (axis === 'y') {
          if (!gestures.claim(gestureSeq(e), token)) { drag = null; return; }
          drag.locked = 'y';
          try { sheet.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        }
      }
      if (drag.locked !== 'y') return;
      var raw = drag.base + dy;
      // 1:1 downward; small elastic give above the rest position.
      render(raw >= 0 ? raw : rubberband(raw, 32));
      drag.samples.push({ t: e.timeStamp, x: y });
      if (drag.samples.length > 24) drag.samples.shift();
    }

    function onPointerEnd(e) {
      if (!drag || e.pointerId !== drag.pointerId) return;
      var wasLocked = drag.locked === 'y';
      var samples = drag.samples;
      drag = null;
      if (!wasLocked || closed) return;
      // Release-time sample so a held-still dwell decays momentum.
      samples.push({ t: e.timeStamp, x: y });
      var v = e.type === 'pointercancel' ? 0 : estimateVelocity(samples);
      if (decideSheetRelease({ y: y, v: v, sheetHeight: height })) dismiss(v);
      else springTo(0, v);
    }

    sheet.addEventListener('pointerdown', onPointerDown);
    sheet.addEventListener('pointermove', onPointerMove);
    sheet.addEventListener('pointerup', onPointerEnd);
    sheet.addEventListener('pointercancel', onPointerEnd);

    render(height);
    springTo(0, 0);

    return {
      el: sheet,
      dismiss: function () { dismiss(0); },
    };
  }

  /* ────────────────────────────────────────────────────────────────────
   * Action sheet — iOS stack of actions + separate Cancel card. Resolves
   * with the chosen action object, or null on cancel/backdrop.
   * ──────────────────────────────────────────────────────────────────── */

  // actionSheet({ title?, actions: [{ label, destructive?, handler? }],
  // cancelLabel? }) — returns a Promise.
  function actionSheet(options) {
    var opts = options || {};
    var actions = opts.actions || [];
    return new Promise(function (resolve) {
      var backdrop = document.createElement('div');
      backdrop.className = 'un-backdrop';
      var wrap = document.createElement('div');
      wrap.className = 'un-action-sheet';

      var card = document.createElement('div');
      card.className = 'un-action-card';
      if (opts.title) {
        var title = document.createElement('div');
        title.className = 'un-action-title';
        title.textContent = opts.title;
        card.appendChild(title);
      }
      actions.forEach(function (action) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'un-action-btn' + (action.destructive ? ' un-destructive' : '');
        btn.textContent = action.label;
        btn.addEventListener('click', function () { settle(action); });
        card.appendChild(btn);
      });
      wrap.appendChild(card);

      var cancelCard = document.createElement('div');
      cancelCard.className = 'un-action-card';
      var cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'un-action-btn un-action-cancel';
      cancelBtn.textContent = opts.cancelLabel || 'Cancel';
      cancelBtn.addEventListener('click', function () { settle(null); });
      cancelCard.appendChild(cancelBtn);
      wrap.appendChild(cancelCard);

      document.body.appendChild(backdrop);
      document.body.appendChild(wrap);

      var height = wrap.offsetHeight || 1;
      var y = height;
      var activeSpring = null;
      var settled = false;

      function render(val) {
        y = val;
        wrap.style.transform = 'translateY(' + val + 'px)';
        backdrop.style.opacity = String(Math.max(0, Math.min(1, 1 - val / height)));
      }

      function springTo(to, onRest) {
        if (activeSpring) activeSpring.stop();
        activeSpring = spring(function (v) { render(v); }, {
          from: y, to: to, velocity: 0, preset: 'default',
          onRest: function () { activeSpring = null; if (onRest) onRest(); },
        });
      }

      function settle(action) {
        if (settled) return;
        settled = true;
        springTo(height, function () {
          if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
          if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
          if (action && action.handler) action.handler();
          resolve(action || null);
        });
      }

      backdrop.addEventListener('click', function () { settle(null); });

      render(height);
      springTo(0);
    });
  }

  /* ────────────────────────────────────────────────────────────────────
   * Alert dialog — the compact centered iOS alert. Fade + scale-down
   * entrance (alerts don't spring from an edge). Resolves with
   * { button, value } — value is the field text when a field was shown.
   * ──────────────────────────────────────────────────────────────────── */

  // alert({ title, message?, field?: { placeholder?, value? },
  // buttons?: [{ label, style?: 'cancel'|'default'|'destructive',
  // handler? }] }) — returns a Promise. Named alertDialog internally so it
  // can't be confused with window.alert; exposed as unNative.alert.
  function alertDialog(options) {
    var opts = options || {};
    var buttons = opts.buttons && opts.buttons.length
      ? opts.buttons
      : [{ label: 'OK', style: 'default' }];
    return new Promise(function (resolve) {
      var backdrop = document.createElement('div');
      backdrop.className = 'un-backdrop un-backdrop-fade';
      var card = document.createElement('div');
      card.className = 'un-alert';

      var title = document.createElement('div');
      title.className = 'un-alert-title';
      title.textContent = opts.title || '';
      card.appendChild(title);
      if (opts.message) {
        var msg = document.createElement('div');
        msg.className = 'un-alert-message';
        msg.textContent = opts.message;
        card.appendChild(msg);
      }
      var field = null;
      if (opts.field) {
        field = document.createElement('input');
        field.type = 'text';
        field.className = 'un-alert-field';
        if (opts.field.placeholder) field.placeholder = opts.field.placeholder;
        if (opts.field.value != null) field.value = opts.field.value;
        card.appendChild(field);
      }

      var row = document.createElement('div');
      row.className = 'un-alert-buttons' + (buttons.length > 2 ? ' un-stacked' : '');
      var settled = false;
      buttons.forEach(function (button) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'un-alert-btn' +
          (button.style === 'cancel' ? ' un-cancel' : '') +
          (button.style === 'destructive' ? ' un-destructive' : '');
        btn.textContent = button.label;
        btn.addEventListener('click', function () {
          if (settled) return;
          settled = true;
          var value = field ? field.value : undefined;
          card.classList.remove('un-in');
          backdrop.style.opacity = '0';
          setTimeout(function () {
            if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
            if (card.parentNode) card.parentNode.removeChild(card);
            if (button.handler) button.handler(value);
            resolve({ button: button, value: value });
          }, 180);
        });
        row.appendChild(btn);
      });
      card.appendChild(row);

      document.body.appendChild(backdrop);
      document.body.appendChild(card);
      // Next frame: engage the CSS entrance (scale 1.12 → 1, fade in).
      requestAnimationFrame(function () {
        backdrop.style.opacity = '1';
        card.classList.add('un-in');
        if (field) { try { field.focus(); } catch (e) { /* ignore */ } }
      });
    });
  }

  /* ────────────────────────────────────────────────────────────────────
   * Nav bars — blurred compact bar with hairline-on-scroll, optional
   * collapsing large title.
   * ──────────────────────────────────────────────────────────────────── */

  var NAVBAR_COLLAPSE_PX = 44; // scroll distance over which the large title fades

  // attachNavBar(barEl, { scrollEl?, largeTitleEl? }) — barEl is a
  // .un-navbar element; scrollEl defaults to the window scroller (same
  // detection as attachPullToRefresh). Toggles .un-scrolled (hairline) and,
  // when largeTitleEl is given, fades/scales it out and toggles
  // .un-collapsed on the bar (revealing the compact .un-navbar-title).
  // Returns { detach() }; never throws.
  function attachNavBar(barEl, options) {
    var noop = { detach: function () {} };
    if (!barEl || barEl.nodeType !== 1) {
      console.warn('[unNative] attachNavBar: barEl must be an Element — nav bar helper disabled.');
      return noop;
    }
    var opts = options || {};
    var scrollEl = opts.scrollEl;
    var windowMode = !scrollEl || scrollEl === window || scrollEl === document ||
      scrollEl === document.scrollingElement ||
      scrollEl === document.documentElement || scrollEl === document.body;
    var listenEl = windowMode ? window : scrollEl;
    var large = opts.largeTitleEl && opts.largeTitleEl.nodeType === 1 ? opts.largeTitleEl : null;
    if (large) barEl.classList.add('un-has-large');

    function update() {
      var top = windowMode ? (window.scrollY || 0) : scrollEl.scrollTop;
      barEl.classList.toggle('un-scrolled', top > 1);
      if (large) {
        var p = Math.max(0, Math.min(1, top / NAVBAR_COLLAPSE_PX));
        large.style.opacity = String(1 - p);
        large.style.transform = 'scale(' + (1 - 0.1 * p) + ')';
        barEl.classList.toggle('un-collapsed', p >= 1);
      }
    }

    listenEl.addEventListener('scroll', update, { passive: true });
    update();

    return {
      detach: function () {
        listenEl.removeEventListener('scroll', update);
        barEl.classList.remove('un-scrolled', 'un-collapsed', 'un-has-large');
        if (large) { large.style.opacity = ''; large.style.transform = ''; }
      },
    };
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
    // Commit-decision projection horizon (ms) — read at release time.
    (function () {
      var row = document.createElement('label');
      var span = document.createElement('span');
      var input = document.createElement('input');
      input.type = 'range';
      input.min = 40;
      input.max = 400;
      input.value = physics.COMMIT_HORIZON_MS;
      function label() { span.textContent = 'commit.horizonMs = ' + physics.COMMIT_HORIZON_MS; }
      input.addEventListener('input', function () {
        physics.COMMIT_HORIZON_MS = Number(input.value);
        label();
      });
      label();
      row.appendChild(span);
      row.appendChild(input);
      panel.appendChild(row);
    })();
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
    presentSheet: presentSheet,
    actionSheet: actionSheet,
    alert: alertDialog,
    attachNavBar: attachNavBar,
    gestures: gestures,
  };
})(typeof window !== 'undefined' ? window : globalThis);
