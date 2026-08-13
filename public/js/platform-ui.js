// PlatformUI — the platform frontend's single seam over the hosted
// usernode-native kit (window.unNative, loaded in index.html <head>).
//
// All platform code calls PlatformUI.*, never unNative directly, so a
// future kit /v2/ migration (or a CDN hiccup) is one file's problem.
// Every method degrades gracefully when the kit failed to load:
//   toast   → console.log (non-blocking, nothing to click through)
//   alert   → window.alert
//   confirm → window.confirm
//   prompt  → window.prompt
//   actionSheet / sheet / panel / modal → null (callers keep their legacy
//   DOM path and must branch on the return / isTouch()).
//
// Adaptive rule (spec decision): touch platforms get action sheets and
// bottom sheets; desktop gets anchored popovers — now also kit-owned
// (unNative.popover / unNative.menu, #741). New menu call sites should
// use PlatformUI.menu() and let the kit pick the idiom; isTouch()
// remains for surfaces the kit doesn't cover yet.

(function () {
  'use strict';

  function kit() {
    const un = window.unNative;
    return un && typeof un.toast === 'function' ? un : null;
  }

  const PlatformUI = {
    /** True when the kit is present and reports a touch platform
        (un-ios / un-android). Desktop and kit-missing both → false,
        so legacy anchored-popover paths stay the fallback. */
    isTouch() {
      const un = kit();
      return !!un && un.platform !== 'desktop';
    },

    /** Whether the kit loaded at all (sheet/modal/actionSheet work). */
    hasKit() {
      return !!kit();
    },

    /** Transient, non-blocking feedback ("Copied", "Failed to save").
        Fire-and-forget; returns the kit handle or null. */
    toast(message, opts) {
      const un = kit();
      if (!un) {
        console.log('[toast]', message);
        return null;
      }
      return un.toast(String(message), opts || {});
    },

    /** Copy text to the clipboard. Resolves true on success, false on
        failure — NEVER throws, so callers can `await` it and branch on
        the boolean rather than wrapping every call site in try/catch.

        Deliberately NOT a kit seam: usernode-native exposes no clipboard
        primitive, so this is plain DOM. It lives here anyway because
        PlatformUI loads first (see index.html) and every screen already
        has it, which is what makes one shared implementation of the
        fallback possible. That fallback — an off-screen textarea driven
        by the deprecated document.execCommand('copy') — covers contexts
        where navigator.clipboard is missing or rejects (an insecure
        http: origin, a permission-blocked webview); see the same
        rationale at the share dialog's copy handler, which is
        frontend/src/features/dialogs/share.tsx as of #1078 chunk I. */
    async copyText(text) {
      const value = text == null ? '' : String(text);
      if (!value) return false;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(value);
          return true;
        }
      } catch {}
      // Fallback: a hidden textarea + execCommand. Off-screen rather
      // than display:none — a non-rendered element can't be selected.
      let ta = null;
      try {
        ta = document.createElement('textarea');
        ta.value = value;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-9999px';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, value.length);
        return document.execCommand('copy');
      } catch {
        return false;
      } finally {
        if (ta && ta.parentNode) ta.parentNode.removeChild(ta);
      }
    },

    /** Blocking informational dialog. Resolves when dismissed. */
    alert(opts) {
      const o = typeof opts === 'string' ? { title: opts } : (opts || {});
      const un = kit();
      if (!un || typeof un.alert !== 'function') {
        try { window.alert([o.title, o.message].filter(Boolean).join('\n\n')); } catch {}
        return Promise.resolve({ button: null });
      }
      return un.alert({
        title: o.title || '',
        message: o.message || undefined,
        buttons: o.buttons || [{ label: o.okLabel || 'OK', style: 'default' }],
      });
    },

    /** Native-style confirm card. Resolves boolean. */
    confirm(opts) {
      const o = typeof opts === 'string' ? { title: opts } : (opts || {});
      const un = kit();
      if (!un || typeof un.alert !== 'function') {
        let ok = false;
        try { ok = window.confirm([o.title, o.message].filter(Boolean).join('\n\n')); } catch {}
        return Promise.resolve(ok);
      }
      return un
        .alert({
          title: o.title || 'Are you sure?',
          message: o.message || undefined,
          buttons: [
            { label: o.cancelLabel || 'Cancel', style: 'cancel' },
            { label: o.confirmLabel || 'OK', style: o.danger ? 'destructive' : 'default' },
          ],
        })
        .then((res) => !!(res && res.button && res.button.style !== 'cancel'));
    },

    /** Single-field prompt (replaces window.prompt — the kit alert's
        inset text field). Resolves the string, or null on cancel. */
    prompt(opts) {
      const o = typeof opts === 'string' ? { title: opts } : (opts || {});
      const un = kit();
      if (!un || typeof un.alert !== 'function') {
        let v = null;
        try { v = window.prompt([o.title, o.message].filter(Boolean).join('\n\n'), o.value || ''); } catch {}
        return Promise.resolve(v);
      }
      return un
        .alert({
          title: o.title || '',
          message: o.message || undefined,
          field: { placeholder: o.placeholder || '', value: o.value || '' },
          buttons: [
            { label: o.cancelLabel || 'Cancel', style: 'cancel' },
            { label: o.confirmLabel || 'OK', style: 'default' },
          ],
        })
        .then((res) => {
          if (!res || !res.button || res.button.style === 'cancel') return null;
          return res.value != null ? String(res.value) : '';
        });
    },

    /** iOS-style action sheet. Resolves the chosen action or null.
        Returns Promise.resolve(null) when the kit is missing — callers
        should only route here when isTouch() (or hasKit()) is true. */
    actionSheet(opts) {
      const un = kit();
      if (!un || typeof un.actionSheet !== 'function') return Promise.resolve(null);
      return un.actionSheet(opts || {});
    },

    /** Anchored popover / dropdown (the desktop menu idiom). Items mode
        resolves the chosen item or null (with .dismiss() attached);
        content mode returns the kit handle { dismiss, el }. Returns
        null when the kit is missing. */
    popover(opts) {
      const un = kit();
      if (!un || typeof un.popover !== 'function') return null;
      return un.popover(opts || {});
    },

    /** Adaptive menu: bottom action sheet on touch, anchored popover on
        desktop, from one actionSheet-shaped call. Resolves the chosen
        item or null — including when the kit is missing (same silent
        degradation as actionSheet). */
    menu(opts) {
      const un = kit();
      if (!un || typeof un.menu !== 'function') return Promise.resolve(null);
      return un.menu(opts || {});
    },

    /** Bottom sheet. Returns the kit handle { dismiss, el } or null
        when unavailable (caller keeps its legacy panel). */
    sheet(opts) {
      const un = kit();
      if (!un || typeof un.presentSheet !== 'function') return null;
      return un.presentSheet(opts || {});
    },

    /** Side drawer / panel sliding in from an edge ({ side, contentEl,
        width?, onDismiss }). Returns the kit handle { dismiss, el } or
        null when unavailable (caller keeps its legacy panel). */
    panel(opts) {
      const un = kit();
      if (!un || typeof un.presentPanel !== 'function') return null;
      return un.presentPanel(opts || {});
    },

    /** Centered modal card. Returns the kit handle or null. */
    modal(opts) {
      const un = kit();
      if (!un || typeof un.presentModal !== 'function') return null;
      return un.presentModal(opts || {});
    },

    /** Swipe-to-act row actions (kit ride-along tray). No-op stub on
        desktop / kit-missing so callers can attach unconditionally on
        their touch path. */
    swipeActions(rowEl, opts) {
      const un = kit();
      if (!un || typeof un.attachSwipeActions !== 'function' || !rowEl) {
        return { close() {}, detach() {} };
      }
      return un.attachSwipeActions(rowEl, opts || {});
    },

    /** Pull-to-refresh on a scrollable container (element mode — the
        platform is a fixed shell). No-op on desktop by kit design. */
    pullToRefresh(scrollEl, onRefresh, opts) {
      const un = kit();
      if (!un || typeof un.attachPullToRefresh !== 'function' || !scrollEl) {
        return { detach() {} };
      }
      return un.attachPullToRefresh(scrollEl, onRefresh, opts || {});
    },

    /** App-side gestures join the kit's intent lock through here. */
    gestures() {
      const un = kit();
      return un && un.gestures ? un.gestures : null;
    },

    /** Per-screen scroll polish: nav-bar hairline-on-scroll treatment
        plus fixed-shell keyboard avoidance on the screen's content
        scroller. Keyed so re-renders (these screens rebuild their
        innerHTML) detach stale handles before re-attaching. Call
        detachScreenFx(key) from the screen's close path. */
    _screenFx: Object.create(null),
    attachScreenFx(key, scrollEl, topEl, opts) {
      PlatformUI.detachScreenFx(key);
      const un = kit();
      if (!un || !scrollEl) return;
      const navBar = !opts || opts.navBar !== false;
      const handles = [];
      if (topEl && navBar && typeof un.attachNavBar === 'function') {
        topEl.classList.add('platform-chat-header');
        handles.push(un.attachNavBar(topEl, { scrollEl }));
      }
      if (typeof un.attachKeyboardAvoidance === 'function') {
        handles.push(un.attachKeyboardAvoidance(scrollEl, { topEl: topEl || undefined }));
      }
      PlatformUI._screenFx[key] = handles;
    },
    detachScreenFx(key) {
      const handles = PlatformUI._screenFx[key];
      if (!handles) return;
      delete PlatformUI._screenFx[key];
      for (const h of handles) {
        try { if (h && typeof h.detach === 'function') h.detach(); } catch {}
      }
    },

    /** Screen transition wrapper. type: 'push' | 'pop' | 'none' |
        'zoom-in' | 'zoom-out' (zoom opts — el, fromEl/fromRect, after,
        fallback, outEl — forward to the kit untouched). Falls back to running
        the mutation directly — both halves, since zoom callers split it
        into fn (reveal) + after (conceal) — when the kit is absent.

        EVERY VISIBLE MUTATION OF THE NAVIGATION GOES INSIDE `fn`. For
        push/pop the kit wraps it in a View Transition, and a View
        Transition captures the OUTGOING page at the next rendering
        opportunity — NOT at this call — so anything mutated
        synchronously after calling this (hiding the screen being left,
        retitling the header, mounting the incoming screen) is baked into
        the "previous page" snapshot the animation slides out. That is
        what made the Settings animation show the incoming page behind
        itself (#979).

        AND A DUPLICATE DISPATCH THAT RE-APPLIES THE SAME NAVIGATION MUST BE
        SKIPPED BY THE CALLER, NOT ABSORBED BY THE KIT (#1102). One history
        traversal fires popstate AND hashchange, so an in-screen router can
        be called twice in one tick; the second call resolves the same
        target, asks for 'none', and the kit runs 'none' SYNCHRONOUSLY —
        inside the first call's still-uncaptured snapshot window. Only the
        caller knows "already showing this", so the caller early-outs (see
        Settings.route / AdminConsole.route / Browse.route). The kit only
        guarantees it will not ANIMATE a corrupted snapshot: it skips the
        pending transition instead, so the worst case is no animation. */
    transition(fn, opts) {
      const un = kit();
      if (!un || typeof un.transition !== 'function') {
        fn();
        if (opts && typeof opts.after === 'function') opts.after();
        return;
      }
      un.transition(fn, opts || { type: 'none' });
    },
  };

  // ── Static-modal adoption: RETIRED (#1078 chunk I) ───────────────
  //
  // What was here: an `adoptStaticModal(root)` that put a MutationObserver on
  // each of nine hard-coded modal roots (`STATIC_MODAL_IDS`) and, when
  // `hidden` came off, lifted the card out of the root into a kit
  // `presentModal`. It existed so the kit could present dialogs whose
  // open/close paths lived in app.js and app-view.js, without rewriting them.
  //
  // Its cost was that it made those dialogs permanently markup-only: two
  // owners wrote to the same nodes, and the one React did not control moved
  // React's DOM out from under it. The lift is frontend/src/lib/static-modal.ts
  // now, driven by React state from the dialog islands, so there is exactly
  // one owner and all nine dialogs are stateful. Nothing in public/js/**
  // called `adoptStaticModal` or read `STATIC_MODAL_IDS` — the whole seam was
  // self-contained here, which is why it could go in one piece.
  //
  // `PlatformUI.modal()` above is untouched: that is the kit entry point the
  // hook calls, and the rest of the shell (confirm dialogs, sheets, the
  // compare overlay) still uses it directly.

  window.PlatformUI = PlatformUI;
})();
