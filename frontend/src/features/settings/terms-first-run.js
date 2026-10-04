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
// Order against the other first-run gate (#2563): the "Choose your
// username" step goes first and this one waits on
// ../auth/username-first-run.js's `settled()`. Both present from the same
// authed boot, and a handle nobody chose is already visible to other
// members, while a terms ask that waits simply returns on the next load.
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

  // ── Passive acceptance at sign-in (#3801) ───────────────────────────
  //
  // The sign-on screens (features/auth/login.tsx, register.tsx) carry a
  // passive notice line — "By signing in you agree to the Terms and
  // conditions" — and completing a sign-in there IS the consent: no
  // sheet, no extra tap. AuthScreens.finishLogin is the single
  // completion path for every credential exchange on those screens
  // (password form, OTP verify and set-password, wallet verify and
  // wallet reset, activation-code register), so wrapping it marks the
  // tab at the moment the session opens. sessionStorage survives
  // finishLogin's `return_to` navigation (a full navigation in the same
  // tab), so a sign-in that lands on another document still counts.
  //
  // The marker is ONE-SHOT and read-and-removed in the same tick: a
  // re-prompt weeks later in the same tab — a new published version, or
  // an old account that never answered — finds no marker and presents
  // the sheet as before. Storage failures are swallowed: the sheet path
  // remains, which is today's behaviour.
  const SIGNED_IN_HERE_KEY = 'usernode.terms.signed-in-here';

  function markSignedInHere() {
    try { sessionStorage.setItem(SIGNED_IN_HERE_KEY, '1'); } catch (_) {}
  }

  function consumeSignedInHere() {
    try {
      if (sessionStorage.getItem(SIGNED_IN_HERE_KEY) !== '1') return false;
      sessionStorage.removeItem(SIGNED_IN_HERE_KEY);
      return true;
    } catch (_) {
      return false;
    }
  }

  // Wraps the router's finishLogin once. The React screens patch their
  // per-screen hooks onto window.AuthScreens, but finishLogin is NOT one
  // of them (features/auth/shared.ts's useAuthScreensPatch list), so the
  // wrap survives hydration — and the screens' own finishLogin() calls
  // reach it by name at call time, wrapping included. If the router has
  // not loaded yet, maybePrompt retries.
  function ensureFinishLoginMarker() {
    const screens = window.AuthScreens;
    if (!screens || typeof screens.finishLogin !== 'function') return;
    if (screens.finishLogin._termsSignedInMarker) return;
    const original = screens.finishLogin;
    const wrapped = function () {
      markSignedInHere();
      return original.apply(this, arguments);
    };
    wrapped._termsSignedInMarker = true;
    screens.finishLogin = wrapped;
  }

  const TermsFirstRun = {
    // Never two checks at once, never a second overlay over an open one,
    // and nothing further once this document has an answer on record.
    _inFlight: false,
    _presented: false,
    _answered: false,
    _lastCheckAt: 0,
    _settle: null,
    _settled: null,

    // Native foreground/online re-checks fire at most this often — the
    // same "don't spam on every alt-tab" stance as App._foregroundResync.
    RECHECK_MIN_MS: 5 * 60 * 1000,
    // Presenting straight under the device-setup sheet's dismissing
    // gesture would land the modal under the very tap that dismissed it —
    // the same window the kit's ghost-click guard defends (GHOST_CLICK_MS,
    // and native-chrome's _FIRST_RUN_MIN_SEEN_MS reasoning).
    SETTLE_DELAY_MS: 450,

    // Resolves once this document's terms gate is done with: answered,
    // skipped, unreachable or never applicable. The shape is
    // ../auth/username-first-run.js's `settled()`, which THIS module already
    // awaits, so a caller that awaits this one has waited on both gates.
    //
    // The reader is ../home/tour (#2255): the welcome tour must not present
    // over the terms sheet, and by the time it can be presented there is
    // nothing else on the page saying "wait".
    settled() {
      if (!TermsFirstRun._settled) {
        TermsFirstRun._settled = new Promise((resolve) => {
          TermsFirstRun._settle = resolve;
        });
      }
      return TermsFirstRun._settled;
    },

    _resolve() {
      TermsFirstRun.settled();
      if (TermsFirstRun._settle) {
        const done = TermsFirstRun._settle;
        TermsFirstRun._settle = null;
        done();
      }
    },

    _isNative() {
      return !!(window.usernode && window.usernode.isNative === true);
    },

    // Every skip below is silent (console.warn at most — a console.error
    // on any route fails proposal checks) and leaves consent null, so a
    // later healthy check simply tries again.
    async maybePrompt() {
      // The wrap retry: the router was not there at module time.
      ensureFinishLoginMarker();
      if (TermsFirstRun._inFlight || TermsFirstRun._presented ||
          TermsFirstRun._answered) return;

      // Screenshot-state and demo routes must stay deterministic — the
      // deliberate ways to shoot this UI are app.js's ?shot=terms-consent
      // and ?shot=terms-consent-blocking.
      try {
        const params = new URLSearchParams(location.search);
        if (params.get('shot') || params.get('demo')) {
          TermsFirstRun._resolve();
          return;
        }
      } catch (_) { /* ignore */ }
      // The side panel's document (`?panel=1`, beside a running app): the
      // TOP window presents the terms, once.
      if (document.documentElement?.classList?.contains('in-side-panel')) {
        TermsFirstRun._resolve();
        return;
      }

      // A snapshot-derived offline boot can't reach the session-authed
      // endpoint; the fetch below would only burn a failed request.
      if (window.App && window.App._sessionFromSnapshot) {
        TermsFirstRun._resolve();
        return;
      }
      // The foreground re-check path can arrive before the authed boot.
      if (!window.App || !window.App.user) return;

      TermsFirstRun._inFlight = true;
      try {
        await TermsFirstRun._check();
      } catch (err) {
        console.warn('[terms-first-run] terms check skipped:', err);
        TermsFirstRun._resolve();
      } finally {
        TermsFirstRun._inFlight = false;
      }
    },

    async _check() {
      const native = TermsFirstRun._isNative();

      // Sequenced behind the first-run username gate (#2563), on every
      // host. Both are presented from the authed boot, so without this they
      // would stack in the same tick — and of the two, the username step is
      // the one that cannot be deferred: terms asks again on the next load
      // (web) or the next foreground (native), while a handle nobody chose
      // is on every message the person sends in the meantime.
      //
      // Guarded on `applies()` rather than simply awaiting `settled()`,
      // because the SETTLE_DELAY_MS below is a ghost-click window and not a
      // free 450ms to spend on the overwhelming majority of accounts that
      // never see that screen at all.
      if (window.UsernameFirstRun &&
          typeof UsernameFirstRun.applies === 'function' &&
          UsernameFirstRun.applies()) {
        try {
          await UsernameFirstRun.settled();
          await new Promise((resolve) =>
            setTimeout(resolve, TermsFirstRun.SETTLE_DELAY_MS));
        } catch (_) { /* a broken gate must not block the terms ask */ }
      }

      // Sequenced, not skipped (#1328): a fresh install used to defer the
      // terms ask to the NEXT launch whenever the "Set up your device"
      // sheet won this one — which on mobile meant "after an app restart",
      // days later or never. Wait the sheet run out, then its dismissal,
      // then a ghost-click window, and ask in the SAME session. That sheet
      // is Android's alone now: on iOS the run presents nothing (#12, D10;
      // the notification ask moved to the create dialog), so the terms ask
      // follows at once.
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
        if (res.status === 404) {
          TermsFirstRun._resolve();
          return;
        }
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.success || !body.data) {
          TermsFirstRun._resolve();
          return;
        }
        payload = body.data;
      } catch (err) {
        // No longer a dead end until restart: on native the next
        // foreground/online tick retries.
        console.warn('[terms-first-run] terms check skipped:', err);
        TermsFirstRun._resolve();
        return;
      }

      // Only a never-answered current version prompts: 'accepted' AND
      // 'refused' both count as an answer, which is exactly what keeps a
      // recorded decline from nagging — and publishing a new version
      // naturally re-prompts everyone once (no consent row yet).
      if (!payload.consent || payload.consent.status !== null) {
        TermsFirstRun._answered = true;
        TermsFirstRun._resolve();
        return;
      }

      // ── Passive acceptance (#3801) ─────────────────────────────────
      // A sign-in completed on the sign-on screens marked this tab: the
      // person has agreed by signing in, so record 'accepted' through the
      // same endpoint and shape the sheet's Accept posts — silently, no
      // sheet, no toast. Read-and-remove is one-shot: spent here whether
      // the POST lands or not, so a later check in this tab presents the
      // sheet instead of silently re-agreeing. On failure consent stays
      // null and the gate settles; the next boot's check (restored
      // session, no marker) presents the sheet as today, so the ask is
      // never lost.
      if (consumeSignedInHere()) {
        try {
          const res = await fetch('/challenges-api/terms/consent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({
              terms_version_id: payload.id,
              status: 'accepted',
            }),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok || !body.success) {
            throw new Error(body.error || `HTTP ${res.status}`);
          }
          TermsFirstRun._answered = true;
        } catch (err) {
          console.warn('[terms-first-run] passive terms accept skipped:', err);
        }
        TermsFirstRun._resolve();
        return;
      }

      if (!window.Settings ||
          typeof window.Settings.showTermsSheet !== 'function') {
        TermsFirstRun._resolve();
        return;
      }
      // Pass the payload through so the sheet doesn't fetch a second time.
      // Native gets the blocking modal; web keeps the dismissible sheet.
      TermsFirstRun._presented = true;
      // A step of the person's path (#3369).
      window.UITelemetry?.navigate?.('terms_sheet');
      window.Settings.showTermsSheet(null, {
        firstRun: true,
        blocking: native,
        payload,
        onAnswered: () => {
          TermsFirstRun._answered = true;
          TermsFirstRun._resolve();
        },
        onClosed: () => {
          TermsFirstRun._presented = false;
          TermsFirstRun._resolve();
          window.App?._renotifyNavigation?.();
        },
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
      // Mark sign-ins completed on the sign-on screens (#3801), now if the
      // router is already there, else maybePrompt retries the wrap.
      ensureFinishLoginMarker();
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
