// First-run terms-consent prompt (issue #1297).
//
// New web accounts used to reach the full shell without ever seeing the
// published Terms and conditions: the only entry points were the profile
// screen's token-gated notice and a Settings row that renders inside the
// native app only, so `user_terms_consents` stayed null forever for anyone
// who didn't stumble into them. This module makes the ask proactive: on
// first arrival at the signed-in shell it checks the session-authed
// `/challenges-api/terms/current` twin (src/routes/topochain/mobile.js) and,
// when the current published version has never been answered
// (`consent.status === null`), presents Settings.showTermsSheet in its
// first-run mode — Accept posts 'accepted', Decline posts 'refused', and a
// quiet dismissal records nothing so the prompt returns next page load.
//
// Deliberately dismissible, not blocking: the backend gate only withholds
// token allocation (getTermsGate in src/routes/topochain/mobile.js), so a
// hard wall here would invent a stricter policy than the platform enforces.
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
    _ran: false,

    // One attempt per document. Every skip below is silent (console.warn at
    // most — a console.error on any route fails proposal checks) and leaves
    // consent null, so the next healthy boot simply tries again.
    async maybePrompt() {
      if (TermsFirstRun._ran) return;
      TermsFirstRun._ran = true;

      // Screenshot-state and demo routes must stay deterministic — the
      // deliberate way to shoot this sheet is app.js's ?shot=terms-consent.
      try {
        const params = new URLSearchParams(location.search);
        if (params.get('shot') || params.get('demo')) return;
      } catch (_) { /* ignore */ }

      // A snapshot-derived offline boot can't reach the session-authed
      // endpoint; the fetch below would only burn a failed request.
      if (window.App && window.App._sessionFromSnapshot) return;

      // One first-run overlay per launch: inside the native app, let the
      // "Set up your device" sheet win the launch that presents it — the
      // consent stays null, so this prompt arrives on the next launch.
      if (window.usernode && window.usernode.isNative === true &&
          window.NativeChrome) {
        try {
          if (typeof NativeChrome.maybeShowFirstRunPermissions === 'function') {
            await NativeChrome.maybeShowFirstRunPermissions();
          }
          if (typeof NativeChrome.firstRunSheetPresented === 'function' &&
              NativeChrome.firstRunSheetPresented()) {
            return;
          }
        } catch (_) { /* a broken bridge must not block the prompt */ }
      }

      let payload = null;
      try {
        const res = await fetch('/challenges-api/terms/current', {
          credentials: 'same-origin',
        });
        // 404 = no published terms version — nothing to ask about.
        if (res.status === 404) return;
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.success || !body.data) return;
        payload = body.data;
      } catch (err) {
        console.warn('[terms-first-run] terms check skipped:', err);
        return;
      }

      // Only a never-answered current version prompts: 'accepted' AND
      // 'refused' both count as an answer, which is exactly what keeps a
      // recorded decline from nagging — and publishing a new version
      // naturally re-prompts everyone once (no consent row yet).
      if (!payload.consent || payload.consent.status !== null) return;

      if (!window.Settings ||
          typeof window.Settings.showTermsSheet !== 'function') {
        return;
      }
      // Pass the payload through so the sheet doesn't fetch a second time.
      window.Settings.showTermsSheet(null, { firstRun: true, payload });
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
    },
  };

  window.TermsFirstRun = TermsFirstRun;
  TermsFirstRun.init();
})();
