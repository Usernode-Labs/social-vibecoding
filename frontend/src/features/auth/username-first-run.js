// First-run "Choose your username" gate (#2563).
//
// An account created by email sign-in used to be given its own email
// address as a username — the handle every other member sees on its
// messages, its profile address and the leaderboard. This module is the
// ask that replaces that: on arrival at the signed-in shell, an account
// the SERVER says has never chosen gets one field and cannot go further
// until it holds a real handle.
//
// The field starts EMPTY (#3575). It used to arrive holding a suggestion
// derived from the address, fetched from GET /api/me/username/suggestion;
// one press of Continue accepted it, which made the "choice" a username
// generated from the email — what the request asked us not to do. The route
// is gone, the person types their own, and the line under the field says
// who will see it: "Your username will be public to other users on
// Homeroom." (USERNAME_PUBLIC_NOTE in ./shared.ts; this classic module has
// no imports, so it spells the same words and a test holds them together).
//
// Who still meets this gate: the sign-up paths ask before the session
// exists (the set-password step, the register form), so it is the backstop
// for an account flagged some other way — the #2563 backfill of
// email-as-username accounts that already had a password, or an
// admin-created account given a password by hand.
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
// ── A provisional handle, asked for at the first public place ──────────
//
// An invite's phone sign-up gives a name, not a username, and gets a
// PROVISIONAL handle made from that name for the private group that invited
// it (`App.user.usernameProvisional`, users.username_provisional_since).
// Nothing public may show it, so the first time the person goes somewhere
// public (a public app or community: App.navigateToApp, or a join the server
// refuses with username_required) `askForPublic()` asks for a username: the
// same field, the same POST, but a sheet they may close ("Not now"), since
// staying in their private group needs nothing. It resolves to whether they
// now hold a chosen handle.
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
  // this one value opts back in, writing nothing.
  const SHOT = 'choose-username';

  // The sentence beside the field (#3575), as a message id read when the
  // sheet is built. The same words as USERNAME_PUBLIC_NOTE in ./shared.ts.
  const PUBLIC_NOTE = 'onboarding:username.publicNote';

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

    // Before somewhere public, for a provisional handle: true when the
    // account holds a username it chose (now, or already), false when the
    // person closed the ask. Never asks twice at once.
    askForPublic() {
      const user = window.App && window.App.user;
      if (!user || user.usernameProvisional !== true) return Promise.resolve(true);
      if (UsernameFirstRun._publicAsk) return UsernameFirstRun._publicAsk;
      UsernameFirstRun._publicAsk = new Promise((resolve) => {
        const presented = UsernameFirstRun._present({
          forPublic: true,
          onResult: (chosen) => {
            UsernameFirstRun._publicAsk = null;
            resolve(chosen);
          },
        });
        // No kit to ask with: let the server's refusal stand.
        if (presented === false) {
          UsernameFirstRun._publicAsk = null;
          resolve(false);
        }
      });
      return UsernameFirstRun._publicAsk;
    },

    // A write somewhere public (joining a public community, following its
    // invite) that the server may refuse with username_required: run it,
    // and on that refusal ask (askForPublic) and run it once more. Returns
    // the last Response, so a "Not now" leaves the caller its refusal.
    async publicRetry(attempt) {
      const res = await attempt();
      if (res.status !== 409) return res;
      const body = await res.clone().json().catch(() => ({}));
      if (body.code !== 'username_required') return res;
      // The server's word: this account's handle is provisional.
      if (window.App && window.App.user) window.App.user.usernameProvisional = true;
      if (!(await UsernameFirstRun.askForPublic())) return res;
      return attempt();
    },

    // Every skip is silent — a console.error on any route fails proposal
    // checks — and leaves the flag set, so the next load asks again.
    async maybePrompt() {
      if (UsernameFirstRun._presented || UsernameFirstRun._answered) return;

      const shot = UsernameFirstRun._shot();
      if (shot === SHOT) {
        UsernameFirstRun._present({ demo: true });
        return;
      }
      try {
        const params = new URLSearchParams(location.search);
        if (params.get('shot') || params.get('demo')) {
          UsernameFirstRun._resolve();
          return;
        }
      } catch (_) { /* ignore */ }
      // The side panel's document (`?panel=1`, beside a running app) is the
      // platform a second time over: the TOP window asks, once, and a second
      // copy of the gate would stack its sheet inside the panel.
      if (document.documentElement?.classList?.contains('in-side-panel')) {
        UsernameFirstRun._resolve();
        return;
      }

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

      // The flag alone is enough to know the gate applies, so the overlay
      // goes up in this tick, with no round trip in front of it — which is
      // what keeps Home from being shown behind an ask that has not arrived.
      UsernameFirstRun._present({});
    },

    _present(opts) {
      if (UsernameFirstRun._presented) return false;
      UsernameFirstRun._presented = true;
      const forPublic = !!(opts && opts.forPublic);
      let reported = false;
      const report = (chosen) => {
        if (reported || !forPublic) return;
        reported = true;
        opts.onResult?.(chosen);
      };
      // A step of the newcomer's path (#3369); never the screenshot state.
      if (!(opts && opts.demo)) window.UITelemetry?.navigate?.('username_sheet');

      const el = (tag, cls, text) => {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text != null) node.textContent = text;
        return node;
      };

      const panel = el('div', 'px-4 pb-5');
      panel.setAttribute('data-choose-username', '');
      panel.appendChild(el('div', 'text-lg font-bold py-3',
        forPublic ? PlatformI18n.t('onboarding:username.titleForPublic') : PlatformI18n.t('onboarding:username.title')));
      // The same vocabulary the profile sheet uses for this field
      // (features/profile/profile-edit-sheet.tsx): "your @handle is your
      // sign-in name and your public page address". No promise about
      // changing it later, because POST /api/me/username asks for the
      // current password and an account that arrived by email code may not
      // have one yet. Who sees it is said once, beside the field (#3575),
      // so this line no longer says it a second time.
      panel.appendChild(el('p',
        'text-sm text-zinc-600 dark:text-zinc-400 mb-3',
        forPublic
          ? PlatformI18n.t('onboarding:username.introForPublic')
          : PlatformI18n.t('onboarding:username.intro')));

      const label = el('label',
        'block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1',
        PlatformI18n.t('onboarding:username.fieldLabel'));
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
      input.placeholder = PlatformI18n.t('onboarding:username.placeholder');
      input.setAttribute('aria-describedby', 'choose-username-public');
      panel.appendChild(input);

      // #3575: next to the field, who will see what goes in it. Its own
      // line, above the error line, so a refusal never displaces it.
      const note = el('p', 'text-sm text-zinc-500 dark:text-zinc-400 mt-1', PlatformI18n.t(PUBLIC_NOTE));
      note.id = 'choose-username-public';
      note.setAttribute('data-choose-username-public', '');
      panel.appendChild(note);

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
        PlatformI18n.t('onboarding:username.submit'));
      save.setAttribute('data-choose-username-save', '');
      panel.appendChild(save);

      // NO Close, NO Cancel and no third button: the step cannot be
      // skipped, and an exit that recorded nothing would put the person
      // back in front of other members under a handle they never picked.
      // Before a public place it can (`forPublic`): "Not now" keeps them
      // where they are, in their private group, under the handle it knows.
      let notNow = null;
      if (forPublic) {
        notNow = el('button',
          'w-full rounded-lg px-4 py-2 mt-2 text-sm font-medium text-zinc-600 dark:text-zinc-300',
          PlatformI18n.t('onboarding:username.notNow'));
        notNow.type = 'button';
        notNow.setAttribute('data-choose-username-not-now', '');
        panel.appendChild(notNow);
      }

      let sheet = null;
      let closing = false;
      const dismiss = () => {
        closing = true;
        if (!forPublic) UsernameFirstRun._answered = true;
        if (sheet && sheet.dismiss) sheet.dismiss();
        UsernameFirstRun._presented = false;
        if (!forPublic) UsernameFirstRun._resolve();
        window.App?._renotifyNavigation?.();
      };

      const submit = async () => {
        const username = input.value.trim();
        if (!username) { setError(PlatformI18n.t('onboarding:username.error.empty')); return; }
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
            if (body.alreadyChosen) { dismiss(); report(true); return; }
            setError(body.error || PlatformI18n.t('onboarding:username.error.notSaved'));
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
            window.App.user.usernameProvisional = false;
            try { window.App.saveSessionSnapshot?.(window.App.user); } catch (_) {}
            try { window.App.resyncCurrentView?.(); } catch (_) {}
          }
          dismiss();
          report(true);
          if (window.PlatformUI) PlatformUI.toast(PlatformI18n.t('onboarding:username.chosenToast', { username: body.username }));
        } catch (err) {
          console.warn('[username-first-run] choose failed:', err);
          setError(PlatformI18n.t('onboarding:username.error.network'));
          save.disabled = false;
          input.disabled = false;
        }
      };

      save.addEventListener('click', submit);
      if (notNow) notNow.addEventListener('click', () => { dismiss(); report(false); });
      input.addEventListener('input', () => setError(''));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
      });

      // Closed from outside (a backdrop tap or Escape, the public ask
      // only): the same as "Not now".
      const onDismiss = () => {
        if (closing) return;
        UsernameFirstRun._presented = false;
        report(false);
      };
      if (window.PlatformUI && typeof PlatformUI.modal === 'function') {
        sheet = PlatformUI.modal({ contentEl: panel, dismissible: forPublic, onDismiss });
      }
      if (!sheet && window.PlatformUI && typeof PlatformUI.sheet === 'function') {
        // The kit's modal is unavailable (an old native shell). A sheet is
        // still an overlay the person answers; it is dismissible, and the
        // flag survives a dismissal, so the next load asks again.
        sheet = PlatformUI.sheet({ contentEl: panel, onDismiss });
      }
      if (!sheet) {
        // No kit at all — the local container serves none of the hosted
        // assets (see the platform rules). Nothing to present, and the
        // account keeps its flag for a load that has one.
        UsernameFirstRun._presented = false;
        if (!forPublic) UsernameFirstRun._resolve();
        return false;
      }
      UsernameFirstRun._sheet = sheet;
      try { input.focus(); } catch (_) {}
      return true;
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
