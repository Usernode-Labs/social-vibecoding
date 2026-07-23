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
//   actionSheet / sheet / modal → null (callers keep their legacy
//   DOM path and must branch on the return / isTouch()).
//
// Adaptive rule (spec decision): touch platforms get action sheets and
// bottom sheets; desktop keeps anchored popovers and dropdown panels.
// Callers branch via PlatformUI.isTouch() at open time.

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

    /** Bottom sheet. Returns the kit handle { dismiss, el } or null
        when unavailable (caller keeps its legacy panel). */
    sheet(opts) {
      const un = kit();
      if (!un || typeof un.presentSheet !== 'function') return null;
      return un.presentSheet(opts || {});
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
        fallback — forward to the kit untouched). Falls back to running
        the mutation directly — both halves, since zoom callers split it
        into fn (reveal) + after (conceal) — when the kit is absent. */
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

  // ── Static-modal adoption ────────────────────────────────────────
  // index.html's full-screen modals (create, rename, fork, share, …)
  // all follow one pattern: a `hidden` fixed overlay root containing a
  // [data-modal-backdrop] wrapper and a centered card, toggled by
  // per-modal open/close JS. Rather than rewriting every open/close
  // path, we watch each root's class list: when `hidden` is removed we
  // lift the card into a kit presentModal (fade + scale-settle, kit
  // backdrop, Escape); when legacy close paths re-add `hidden` we
  // dismiss it. A kit-initiated dismissal (backdrop tap / Escape) is
  // routed back through the modal's own backdrop click handler so its
  // close function still runs (form resets, state cleanup).
  function adoptStaticModal(root) {
    let handle = null;
    let placeholder = null;
    let card = null;

    const restore = () => {
      if (card) card.classList.remove('platform-modal-card');
      if (placeholder && card && placeholder.parentNode) {
        placeholder.parentNode.replaceChild(card, placeholder);
      }
      placeholder = null;
      card = null;
      root.classList.remove('platform-modal-adopted');
    };

    const present = () => {
      if (handle) return;
      const un = kit();
      if (!un) return;
      const backdrop = root.querySelector('[data-modal-backdrop]');
      card = (backdrop && backdrop.firstElementChild) || root.firstElementChild;
      if (!card) return;
      // The kit modal draws the card chrome (surface, radius, shadow,
      // 20/16 padding). The legacy card's own bg/radius/shadow/padding
      // would stack on top of it — double borders, double whitespace —
      // so it is neutralized while presented (class removed on restore).
      // Measure the card's design width first so the kit shell can hug
      // it instead of the kit's default 480px.
      let designWidth = null;
      try {
        const mw = getComputedStyle(card).maxWidth;
        if (mw && mw.endsWith('px')) designWidth = mw;
      } catch {}
      card.classList.add('platform-modal-card');
      placeholder = document.createComment('platform-modal-home');
      card.parentNode.replaceChild(placeholder, card);
      // Hide the legacy scrim while the kit owns presentation.
      root.classList.add('platform-modal-adopted');
      handle = un.presentModal({
        contentEl: card,
        onDismiss: () => {
          handle = null;
          restore();
          if (!root.classList.contains('hidden')) {
            // Kit-initiated dismissal: run the legacy close path via
            // the backdrop handler so per-modal cleanup executes.
            const target = root.querySelector('[data-modal-backdrop]') || root;
            target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            // Modals with no backdrop-dismiss wiring: force-hide.
            if (!root.classList.contains('hidden')) root.classList.add('hidden');
          }
        },
      });
      if (!handle) restore();
      else if (handle.el && designWidth) {
        handle.el.style.width = `min(${designWidth}, calc(100vw - 32px))`;
      }
    };

    const sync = () => {
      const hidden = root.classList.contains('hidden');
      if (!hidden && !handle) present();
      else if (hidden && handle) {
        const h = handle;
        handle = null;
        restore();
        h.dismiss();
      }
    };

    new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ['class'] });
    sync();
  }

  const STATIC_MODAL_IDS = [
    'create-modal', 'rename-modal', 'close-issue-modal', 'fork-modal',
    'import-pr-modal', 'members-modal', 'feedback-modal', 'share-modal',
    'settings-modal', 'app-secrets-modal',
  ];

  function adoptAll() {
    if (!kit()) return; // no kit → legacy modals keep working as-is
    for (const id of STATIC_MODAL_IDS) {
      const el = document.getElementById(id);
      if (el) adoptStaticModal(el);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', adoptAll);
  } else {
    adoptAll();
  }

  window.PlatformUI = PlatformUI;
})();
