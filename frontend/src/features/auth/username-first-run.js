// First-run "Choose your username" gate (#2563).
//
// An account created by email sign-in used to be given its own email
// address as a username — the handle every other member sees on its
// messages, its profile address and the leaderboard. This module is the
// ask that replaces that: on arrival at the signed-in shell, an account
// the SERVER says has never chosen gets one field, prefilled with a
// suggestion derived from the address, and cannot go further until it
// holds a real handle.
//
// ── What decides whether to ask ────────────────────────────────────────
//
// `App.user.needsUsernameChoice`, a boolean on /api/auth/me
// (src/routes/auth.js). NOT a look at the stored username: "does this
// string look like an email address" is a guess, it is wrong for a member
// called `ada.lovelace`, and it would have to be re-implemented in the
// mobile app to agree with this one. The flag is written where the account
// is created and cleared by POST /api/me/username/choose.
//
// It needs no fetch of its own, which is the reason this gate can go up in
// the same tick as the authed boot rather than a round trip later: the
// boot has already read /api/auth/me by the time `sv:authed` fires.
//
// ── Blocking, and the one exit ─────────────────────────────────────────
//
// A non-dismissible kit modal — no backdrop tap, no Escape, no Close —
// exactly the shape ../settings/terms-first-run.js presents on native, and
// for a stronger reason: a dismissed terms prompt returns on the next page
// load, whereas a handle nobody chose is on every message the person sends
// in the meantime. Submitting a name the server accepts is the only way
// out, and the step is unskippable by construction, not by a guard: the
// overlay owns the document until the POST succeeds.
//
// ── Ordering against the terms gate ────────────────────────────────────
//
// This one goes FIRST and terms-first-run waits on `settled()`. Two
// overlays presented in the same tick would stack, and of the two this is
// the one with no way to defer: terms can ask again on the next load (web)
// or the next foreground (native), while an unchosen handle is being shown
// to other people right now. `settled()` resolves immediately when this
// gate does not apply, so the terms ask is not delayed for the accounts
// that never see this screen.
//
// Classic IIFE like ../settings/terms-first-run.js, imported from
// ../../main.tsx so it rides the shell bundle rather than the prerender —
// no new public/js/** script, so SHELL_ASSETS, the script-order test and
// the markup baseline are untouched.
(function () {
  'use strict';

  // The prerender pass imports the entry with no DOM to speak to.
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  // The one screenshot state for this step. Every OTHER `?shot=` and
  // `?demo=` route has to stay deterministic — a blocking overlay lifted
  // over an unrelated check would fail it — so the gate skips them all and
  // this one value opts back in with a fixture suggestion and no fetch.
  const SHOT = 'choose-username';

  const UsernameFirstRun = {
    _presented: false,
    _answered: false,
    _settle: null,
    _settled: null,

    // Does this document have a username step to show at all? Read by
    // ../settings/terms-first-run.js, which sequences behind this gate only
    // when there is one — `settled()` alone would tell it nothing until
    // after the fact, and the ghost-click delay it pays afterwards is not
    // worth spending on the accounts that never see this screen.
    applies() {
      if (UsernameFirstRun._presented) return true;
      if (UsernameFirstRun._answered) return false;
      return !!(window.App && window.App.user
        && window.App.user.needsUsernameChoice === true);
    },

    // Resolves when this document's gate is done with: answered, skipped,
    // or never applicable. ../settings/terms-first-run.js awaits it before
    // presenting, so the two never stack.
    settled() {
      if (!UsernameFirstRun._settled) {
        UsernameFirstRun._settled = new Promise((resolve) => {
          UsernameFirstRun._settle = resolve;
        });
      }
      return UsernameFirstRun._settled;
    },

    _resolve() {
      UsernameFirstRun.settled();
      if (UsernameFirstRun._settle) {
        const done = UsernameFirstRun._settle;
        UsernameFirstRun._settle = null;
        done();
      }
    },

    _shot() {
      try {
        return new URLSearchParams(location.search).get('shot');
      } catch (_) {
        return null;
      }
    },

    // Every skip is silent — a console.error on any route fails proposal
    // checks — and leaves the flag set, so the next load asks again.
    async maybePrompt() {
      if (UsernameFirstRun._presented || UsernameFirstRun._answered) return;

      const shot = UsernameFirstRun._shot();
      if (shot === SHOT) {
        UsernameFirstRun._present({ suggestion: 'ada_lovelace', demo: true });
        return;
      }
      try {
        const params = new URLSearchParams(location.search);
        if (params.get('shot') || params.get('demo')) {
          UsernameFirstRun._resolve();
          return;
        }
      } catch (_) { /* ignore */ }

      // A snapshot-derived offline boot is display-only and unverified: the
      // session-authed endpoints below cannot answer, and the snapshot's
      // copy of the flag is not the server's word.
      if (window.App && window.App._sessionFromSnapshot) {
        UsernameFirstRun._resolve();
        return;
      }
      if (!window.App || !window.App.user) {
        UsernameFirstRun._resolve();
        return;
      }
      if (window.App.user.needsUsernameChoice !== true) {
        UsernameFirstRun._answered = true;
        UsernameFirstRun._resolve();
        return;
      }

      // Present FIRST and fill the field when the suggestion lands. The
      // flag alone is enough to know the gate applies, and putting the
      // overlay up before a round trip is what keeps Home from being shown
      // behind an ask that has not arrived yet.
      UsernameFirstRun._present({ suggestion: null });
      let suggestion = null;
      try {
        const res = await fetch('/api/me/username/suggestion', {
          credentials: 'same-origin',
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok) suggestion = body.suggestion || null;
      } catch (err) {
        // No suggestion is a perfectly usable state: the field is empty and
        // the person types their own. console.warn at most.
        console.warn('[username-first-run] suggestion skipped:', err);
      }
      UsernameFirstRun._fill(suggestion);
    },

    // Prefill the field once the suggestion arrives, unless the person has
    // already started typing — their keystrokes outrank a late fetch.
    //
    // The mirror onto `data-username-suggested` is not decoration: the
    // declared check in dapp.json asserts the field arrives FILLED, and an
    // attribute selector reads the attribute, which a `.value` property
    // write never touches.
    _fill(suggestion) {
      const input = UsernameFirstRun._input;
      if (!input || !suggestion || input.value) return;
      input.value = suggestion;
      input.setAttribute('data-username-suggested', suggestion);
      try { input.setSelectionRange(suggestion.length, suggestion.length); } catch (_) {}
    },

    _present(opts) {
      if (UsernameFirstRun._presented) return;
      UsernameFirstRun._presented = true;

      const el = (tag, cls, text) => {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text != null) node.textContent = text;
        return node;
      };

      const panel = el('div', 'px-4 pb-5');
      panel.setAttribute('data-choose-username', '');
      panel.appendChild(el('div', 'text-lg font-bold py-3', 'Choose your username'));
      // The same vocabulary the profile sheet uses for this field
      // (features/profile/profile-edit-sheet.tsx): "your @handle is your
      // sign-in name and your public page address". No promise about
      // changing it later, because POST /api/me/username asks for the
      // current password and an account that arrived by email code may not
      // have one yet.
      panel.appendChild(el('p',
        'text-sm text-zinc-600 dark:text-zinc-400 mb-3',
        'This is your @handle: your sign-in name, your public page ' +
        'address, and what other members see on everything you post. ' +
        'Letters, numbers and underscores, 3 to 32 characters.'));

      const label = el('label',
        'block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1',
        'Username');
      label.htmlFor = 'choose-username-input';
      panel.appendChild(label);

      const input = el('input',
        'w-full rounded-lg border border-zinc-300 dark:border-zinc-700 ' +
        'bg-white dark:bg-zinc-900 px-3 py-2 text-sm text-zinc-900 ' +
        'dark:text-zinc-100');
      input.id = 'choose-username-input';
      input.type = 'text';
      input.autocomplete = 'username';
      input.maxLength = 32;
      input.spellcheck = false;
      input.setAttribute('autocapitalize', 'none');
      input.placeholder = 'yourname';
      UsernameFirstRun._input = input;
      panel.appendChild(input);

      // The inline error line. Pinned under the field because every rule
      // the server enforces (charset, length, reserved names, availability)
      // is answered as a sentence a person can act on — this renders it
      // rather than reducing it to "invalid".
      const status = el('p', 'text-sm mt-2 min-h-5 text-red-600 dark:text-red-400');
      status.setAttribute('data-choose-username-error', '');
      panel.appendChild(status);
      const setError = (message) => { status.textContent = message || ''; };

      const save = el('button',
        'w-full rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 mt-2 ' +
        'text-sm font-medium text-white disabled:opacity-60',
        'Continue');
      save.setAttribute('data-choose-username-save', '');
      panel.appendChild(save);

      // NO Close, NO Cancel and no third button: the step cannot be
      // skipped, and an exit that recorded nothing would put the person
      // back in front of other members under a handle they never picked.

      let sheet = null;
      const dismiss = () => {
        UsernameFirstRun._answered = true;
        if (sheet && sheet.dismiss) sheet.dismiss();
        UsernameFirstRun._presented = false;
        UsernameFirstRun._resolve();
      };

      const submit = async () => {
        const username = input.value.trim();
        if (!username) { setError('Enter a username.'); return; }
        if (opts && opts.demo) {
          // The screenshot state writes nothing. Same stance as app.js's
          // ?shot=terms-consent, which presents the sheet with a fixture
          // payload and never posts a consent.
          setError('');
          return;
        }
        save.disabled = true;
        input.disabled = true;
        setError('');
        try {
          const res = await fetch('/api/me/username/choose', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ username }),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) {
            // Somebody already got through on another tab — the gate is
            // done, so close rather than pinning an error nobody can fix.
            if (body.alreadyChosen) { dismiss(); return; }
            setError(body.error || 'Could not save that username.');
            save.disabled = false;
            input.disabled = false;
            return;
          }

          // The handle is on the drawer row, the identity card and every
          // link this tab is about to build, so App.user has to move with
          // it — the same reason settings.js's changeUsername writes it
          // back rather than waiting for the next /api/auth/me.
          if (window.App && window.App.user) {
            window.App.user.username = body.username;
            window.App.user.needsUsernameChoice = false;
            try { window.App.saveSessionSnapshot?.(window.App.user); } catch (_) {}
            try { window.App.resyncCurrentView?.(); } catch (_) {}
          }
          dismiss();
          if (window.PlatformUI) PlatformUI.toast(`You are @${body.username}.`);
        } catch (err) {
          console.warn('[username-first-run] choose failed:', err);
          setError('Network error. Try again.');
          save.disabled = false;
          input.disabled = false;
        }
      };

      save.addEventListener('click', submit);
      input.addEventListener('input', () => setError(''));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
      });

      if (window.PlatformUI && typeof PlatformUI.modal === 'function') {
        sheet = PlatformUI.modal({ contentEl: panel, dismissible: false });
      }
      if (!sheet && window.PlatformUI && typeof PlatformUI.sheet === 'function') {
        // The kit's modal is unavailable (an old native shell). A sheet is
        // still an overlay the person answers; it is dismissible, and the
        // flag survives a dismissal, so the next load asks again.
        sheet = PlatformUI.sheet({ contentEl: panel });
      }
      if (!sheet) {
        // No kit at all — the local container serves none of the hosted
        // assets (see the platform rules). Nothing to present, and the
        // account keeps its flag for a load that has one.
        UsernameFirstRun._presented = false;
        UsernameFirstRun._resolve();
        return;
      }
      UsernameFirstRun._sheet = sheet;
      UsernameFirstRun._fill(opts && opts.suggestion);
      try { input.focus(); } catch (_) {}
    },

    init() {
      // `sv:authed` fires at most once per document and only for released
      // accounts (public/js/app.js gates the waiting room before it), so an
      // unreleased waitlist account is asked at release, not before.
      if (window.App && window.App.user) UsernameFirstRun.maybePrompt();
      else {
        document.addEventListener('sv:authed',
          () => UsernameFirstRun.maybePrompt(), { once: true });
      }
    },
  };

  window.UsernameFirstRun = UsernameFirstRun;
  UsernameFirstRun.init();
})();
