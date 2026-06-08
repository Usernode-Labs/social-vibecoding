// Mobile / webview handling for GitHub links — follow-up to issue #61.
//
// Issue #61 first pass added `target="_blank" rel="noopener noreferrer"`
// to every GitHub anchor, which is the right behavior on desktop. But
// the platform web UI also runs inside the Usernode *native mobile app*,
// where the page lives in a webview. There a plain `target="_blank"`
// frequently does the wrong thing: the webview either swallows the tap
// or navigates the whole app away to github.com in-place, with no way
// back. The user asked for these to instead open in the device's native
// browser (a new tab / "open in browser"), so they never lose the app.
//
// Strategy: one delegated, capture-phase click listener on the document.
// Because it's delegated it covers *every* GitHub anchor uniformly — the
// static header/drawer links in index.html and all the JS-rendered ones
// (dev-chat PR links, app-view version pills and PR links, status pages)
// — including anchors that don't exist yet at load time. No per-call-site
// wiring, so new GitHub links added later get the behavior for free.
//
// Desktop is left completely untouched: the handler bails before doing
// anything, so the existing `target="_blank"` opens a normal new tab.
(function () {
  'use strict';

  // Matches github.com and any subdomain (gist.github.com, etc.).
  var GH_HOST_RE = /(^|\.)github\.com$/i;

  function isGithubHref(rawHref) {
    if (!rawHref) return false;
    try {
      var u = new URL(rawHref, window.location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      return GH_HOST_RE.test(u.hostname);
    } catch (_) {
      return false;
    }
  }

  // Touch-first mobile UA. The explicit confirm below makes the rare
  // desktop-touch false positive harmless (worst case: a desktop touch
  // user gets one extra "open in browser?" tap).
  function isMobile() {
    var ua = navigator.userAgent || '';
    if (/Android|iPhone|iPad|iPod|IEMobile|Opera Mini/i.test(ua)) return true;
    // iPadOS 13+ masquerades as desktop Safari but is touch-first.
    if (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1) return true;
    return false;
  }

  // Best-effort webview sniff. We don't *require* this to be right — it's
  // an extra trigger on top of isMobile(), and the native-bridge channels
  // in openExternal() only fire when those globals actually exist.
  function isWebview() {
    var ua = navigator.userAgent || '';
    if (/; wv\)/.test(ua)) return true; // Android System WebView
    // iOS WKWebView: WebKit-on-iOS but lacking the "Safari" token that
    // mobile Safari proper always carries.
    if (/(iPhone|iPod|iPad)/i.test(ua) && !/Safari/i.test(ua)) return true;
    // Some webview hosts (incl. the Usernode shell) expose a native bridge.
    if (nativeHandoff('', true)) return true;
    return false;
  }

  function isMobileContext() {
    return isMobile() || isWebview();
  }

  // Try to hand the URL off to a native host (the mobile app shell), if
  // one is listening. Returns true when a channel was used. When
  // `probeOnly` is true we only report whether a channel *exists* without
  // sending anything (used by isWebview()).
  function nativeHandoff(url, probeOnly) {
    // iOS WKWebView message handler, if the native app registered one.
    try {
      var mh = window.webkit && window.webkit.messageHandlers;
      if (mh && mh.usernodeOpenExternal) {
        if (probeOnly) return true;
        mh.usernodeOpenExternal.postMessage(String(url));
        return true;
      }
    } catch (_) {}
    // Android: a @JavascriptInterface named UsernodeNative, if present.
    try {
      if (window.UsernodeNative && typeof window.UsernodeNative.openExternal === 'function') {
        if (probeOnly) return true;
        window.UsernodeNative.openExternal(String(url));
        return true;
      }
    } catch (_) {}
    return false;
  }

  // Open `url` outside the current webview/iframe. Tries the most reliable
  // channels first; later fallbacks cover hosts that block earlier ones.
  function openExternal(url) {
    // 1. Native bridge — most reliable when the app provides it, and it
    //    doesn't depend on a live user-activation token.
    if (nativeHandoff(url, false)) return true;

    // 2. Ask the embedding shell to open it (harmless no-op if nobody is
    //    listening). Also activation-independent.
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'usernode:open-external', url: String(url) }, '*');
      }
    } catch (_) {}

    // 3. window.open with _blank — in most webviews a genuine user
    //    gesture here escapes to the device's default browser.
    var w = null;
    try {
      w = window.open(url, '_blank', 'noopener,noreferrer');
    } catch (_) {}
    if (w) {
      try { w.opener = null; } catch (_) {}
      return true;
    }

    // 4. Last resort: synthesize a fresh anchor activation. Some hosts
    //    honour this when they ignore window.open().
    try {
      var a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      return true;
    } catch (_) {}

    return false;
  }

  // "Ask to open in native browser" — uses the app's webview-safe modal
  // when available (native window.confirm is suppressed in several hosts;
  // that's exactly why ConfirmModal exists), else falls back gracefully.
  function confirmOpen(url) {
    if (window.ConfirmModal && typeof window.ConfirmModal.show === 'function') {
      window.ConfirmModal.show({
        title: 'Open GitHub in your browser?',
        message: 'This link leaves the app and opens in your device browser.\n\n' + url,
        confirmLabel: 'Open',
        cancelLabel: 'Cancel',
      }).then(function (ok) {
        if (ok) openExternal(url);
      });
      return;
    }
    // No modal available (e.g. the status pages). Native confirm may be
    // suppressed in a webview, in which case it returns false and we
    // simply don't navigate — never worse than the old in-place redirect.
    var proceed = true;
    try { proceed = window.confirm('Open this GitHub page in your browser?\n\n' + url); }
    catch (_) { proceed = true; }
    if (proceed) openExternal(url);
  }

  function onClick(e) {
    // Respect anything that already handled the event, and let modified /
    // non-primary clicks fall through to native behavior.
    if (e.defaultPrevented) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;

    var raw = a.getAttribute('href');
    if (!raw || raw === '#') return;        // placeholder anchors not yet wired
    if (!isGithubHref(a.href)) return;      // a.href is the resolved absolute URL
    if (!isMobileContext()) return;         // desktop: leave target="_blank" alone

    // Take over: stop the in-webview redirect and route to the browser.
    e.preventDefault();
    confirmOpen(a.href);
  }

  // Capture phase so we run before per-anchor onclick handlers (e.g. the
  // event.stopPropagation() guards on dev-chat / app-view PR links). We
  // only preventDefault — we don't stop propagation — so those guards
  // still fire and the underlying card doesn't react.
  document.addEventListener('click', onClick, true);

  // Exposed for reuse / testing.
  window.UsernodeGithubLinks = {
    isGithubHref: isGithubHref,
    isMobile: isMobile,
    isWebview: isWebview,
    isMobileContext: isMobileContext,
    openExternal: openExternal,
  };
})();
