// First-run terms-consent gate (issues #1297, #1328).
//
// New accounts used to reach the full shell without ever seeing the
// published Terms and conditions: the only entry points were the profile
// screen's token-gated notice and a Settings row that renders inside the
// native app only, so `user_terms_consents` stayed null forever for anyone
// who didn't stumble into them. This module makes the ask proactive: on
// arrival at the signed-in shell it checks the session-authed
// `/challenges-api/terms/current` twin (src/routes/topochain/mobile.js) and,
// when the current published version has never been answered
// (`consent.status === null`), presents Settings.showTermsSheet in its
// first-run mode — Accept posts 'accepted', Decline posts 'refused'.
//
// Presentation differs by host (#1328):
//   - Web: a dismissible sheet, once per document. The backend gate only
//     withholds token allocation (getTermsGate in
//     src/routes/topochain/mobile.js), and a quiet dismissal records
//     nothing, so the prompt simply returns on the next page load.
//   - Native app: a BLOCKING modal — no backdrop tap, no Escape, no Close;
//     Accept and Decline are the only exits (a recorded refusal still
//     enters, tokens paused). The mobile WebView keeps one document alive
//     across background/foreground for days, so "next page load" used to
//     mean "next app restart". Instead the ask is SEQUENCED after the
//     "Set up your device" sheet in the SAME launch
//     (NativeChrome.firstRunSheetSettled) and RE-EVALUATED on throttled
//     foreground/online transitions until the current version is answered.
//
// Classic IIFE like ../settings/settings.js, imported from ./mount.ts so it
// ships in the shell bundle — no new public/js/** script, so SHELL_ASSETS,
// the script-order test and the markup baseline are untouched. The boot
// pattern is notifications.js's: init now if the authed boot already
// happened, else wait for the once-per-document `sv:authed`.
(function () {
  'use strict';

  // The prerender pass imports this module with no DOM to speak to.
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const TermsFirstRun = {
    // Never two checks at once, never a second overlay over an open one,
    // and nothing further once this document has an answer on record.
    _inFlight: false,
    _presented: false,
    _answered: false,
    _lastCheckAt: 0,

    // Native foreground/online re-checks fire at most this often — the
    // same "don't spam on every alt-tab" stance as App._foregroundResync.
    RECHECK_MIN_MS: 5 * 60 * 1000,
    // Presenting straight under the device-setup sheet's dismissing
    // gesture would land the modal under the very tap that dismissed it —
    // the same window the kit's ghost-click guard defends (GHOST_CLICK_MS,
    // and native-chrome's _FIRST_RUN_MIN_SEEN_MS reasoning).
    SETTLE_DELAY_MS: 450,

    _isNative() {
      return !!(window.usernode && window.usernode.isNative === true);
    },

    // Every skip below is silent (console.warn at most — a console.error
    // on any route fails proposal checks) and leaves consent null, so a
    // later healthy check simply tries again.
    async maybePrompt() {
      if (TermsFirstRun._inFlight || TermsFirstRun._presented ||
          TermsFirstRun._answered) return;

      // Screenshot-state and demo routes must stay deterministic — the
      // deliberate ways to shoot this UI are app.js's ?shot=terms-consent
      // and ?shot=terms-consent-blocking.
      try {
        const params = new URLSearchParams(location.search);
        if (params.get('shot') || params.get('demo')) return;
      } catch (_) { /* ignore */ }

      // A snapshot-derived offline boot can't reach the session-authed
      // endpoint; the fetch below would only burn a failed request.
      if (window.App && window.App._sessionFromSnapshot) return;
      // The foreground re-check path can arrive before the authed boot.
      if (!window.App || !window.App.user) return;

      TermsFirstRun._inFlight = true;
      try {
        await TermsFirstRun._check();
      } catch (err) {
        console.warn('[terms-first-run] terms check skipped:', err);
      } finally {
        TermsFirstRun._inFlight = false;
      }
    },

    async _check() {
      const native = TermsFirstRun._isNative();

      // Sequenced, not skipped (#1328): a fresh install used to defer the
      // terms ask to the NEXT launch whenever the "Set up your device"
      // sheet won this one — which on mobile meant "after an app restart",
      // days later or never. Wait the sheet run out, then its dismissal,
      // then a ghost-click window, and ask in the SAME session.
      if (native && window.NativeChrome) {
        try {
          if (typeof NativeChrome.maybeShowFirstRunPermissions === 'function') {
            await NativeChrome.maybeShowFirstRunPermissions();
          }
          if (typeof NativeChrome.firstRunSheetPresented === 'function' &&
              NativeChrome.firstRunSheetPresented() &&
              typeof NativeChrome.firstRunSheetSettled === 'function') {
            await NativeChrome.firstRunSheetSettled();
            await new Promise((resolve) =>
              setTimeout(resolve, TermsFirstRun.SETTLE_DELAY_MS));
          }
        } catch (_) { /* a broken bridge must not block the gate */ }
      }

      TermsFirstRun._lastCheckAt = Date.now();
      let payload = null;
      try {
        const res = await fetch('/challenges-api/terms/current', {
          credentials: 'same-origin',
        });
        // 404 = no published terms version — nothing to ask about. Not an
        // answer: a native re-check notices a later publish, restart-free.
        if (res.status === 404) return;
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.success || !body.data) return;
        payload = body.data;
      } catch (err) {
        // No longer a dead end until restart: on native the next
        // foreground/online tick retries.
        console.warn('[terms-first-run] terms check skipped:', err);
        return;
      }

      // Only a never-answered current version prompts: 'accepted' AND
      // 'refused' both count as an answer, which is exactly what keeps a
      // recorded decline from nagging — and publishing a new version
      // naturally re-prompts everyone once (no consent row yet).
      if (!payload.consent || payload.consent.status !== null) {
        TermsFirstRun._answered = true;
        return;
      }

      if (!window.Settings ||
          typeof window.Settings.showTermsSheet !== 'function') {
        return;
      }
      // Pass the payload through so the sheet doesn't fetch a second time.
      // Native gets the blocking modal; web keeps the dismissible sheet.
      TermsFirstRun._presented = true;
      window.Settings.showTermsSheet(null, {
        firstRun: true,
        blocking: native,
        payload,
        onAnswered: () => { TermsFirstRun._answered = true; },
        onClosed: () => { TermsFirstRun._presented = false; },
      });
    },

    // Warm-entry re-evaluation (#1328), native only: the WebView document
    // persists across background/foreground for days, so an unanswered (or
    // unreachable) boot check must not wait for an app restart — and a
    // terms version published mid-install prompts on the next foreground.
    // Throttled; every maybePrompt guard still applies on top.
    _recheck() {
      if (!TermsFirstRun._isNative()) return;
      if (document.visibilityState === 'hidden') return;
      if (Date.now() - TermsFirstRun._lastCheckAt <
          TermsFirstRun.RECHECK_MIN_MS) return;
      TermsFirstRun.maybePrompt();
    },

    init() {
      // `sv:authed` fires at most once per document, only for released
      // users (public/js/app.js gates the waiting room before it), so
      // unreleased waitlist accounts are not prompted until release.
      if (window.App && window.App.user) TermsFirstRun.maybePrompt();
      else {
        document.addEventListener('sv:authed',
          () => TermsFirstRun.maybePrompt(), { once: true });
      }
      // Same event pair native-chrome's session recovery listens on;
      // _recheck gates itself to the native app.
      document.addEventListener('visibilitychange',
        () => TermsFirstRun._recheck());
      window.addEventListener('online', () => TermsFirstRun._recheck());
    },
  };

  window.TermsFirstRun = TermsFirstRun;
  TermsFirstRun.init();
})();
