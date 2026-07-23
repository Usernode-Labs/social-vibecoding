// #30 — Settings modal (BYOK: bring your own Anthropic API key).
//
// The Settings row in the header drawer opens this modal (wired in
// app.js HeaderMenu.init). Users can paste an `sk-ant-...` key; the
// server verifies it with a cheap 1-token call and only then encrypts
// + stores it. Once saved, a small emerald dot appears on the drawer's
// Settings row so the user can tell at a glance that their key is
// active — and so can any other user viewing over their shoulder
// (no secrets leak, just the indicator).
(function () {
  'use strict';

  const Settings = {
    modal: null,
    state: { hasApiKey: false, keyLast4: null, usernodePubkey: null, walletLinkEnabled: false, aiProgressEstimate: false, mayorModel: '' },
    _walletPollTimer: null,
    _alertsTestTimer: null,
    _walletExpiresAt: null,
    _walletCountdownTimer: null,

    init() {
      this.modal = document.getElementById('settings-modal');
      // The open entry point is the drawer's Settings row, wired in
      // app.js HeaderMenu.init → Settings.open().
      document.getElementById('settings-close').addEventListener('click', () => this.close());
      document.getElementById('settings-save').addEventListener('click', () => this.save());
      document.getElementById('settings-remove').addEventListener('click', () => this.remove());

      const linkBtn = document.getElementById('wallet-link-btn');
      if (linkBtn) linkBtn.addEventListener('click', () => this._startWalletLink());
      const unlinkBtn = document.getElementById('wallet-unlink-btn');
      if (unlinkBtn) unlinkBtn.addEventListener('click', () => this._unlinkWallet());
      const cancelLink = document.getElementById('wallet-link-cancel');
      if (cancelLink) cancelLink.addEventListener('click', () => this._cancelWalletLink());

      const logoutBtn = document.getElementById('settings-logout');
      if (logoutBtn) logoutBtn.addEventListener('click', () => this.logout());

      // Change password (issue #282) → POST /api/me/password.
      const cpSave = document.getElementById('cp-save');
      if (cpSave) cpSave.addEventListener('click', () => this.changePassword());

      // Wallet-signed change-password → POST /api/me/wallet-change-password.
      // Only reachable when the wallet-mode link is shown (native + linked).
      const cpWalletSave = document.getElementById('cp-wallet-save');
      if (cpWalletSave) cpWalletSave.addEventListener('click', () => this.changePasswordWithWallet());
      const useWallet = document.getElementById('cp-use-wallet');
      if (useWallet) useWallet.addEventListener('click', (e) => { e.preventDefault(); this._setChangePasswordMode('wallet'); });
      const usePassword = document.getElementById('cp-use-password');
      if (usePassword) usePassword.addEventListener('click', (e) => { e.preventDefault(); this._setChangePasswordMode('password'); });

      // Dev console "always show" toggle. State lives in DevConsole +
      // localStorage; we just mirror it here. Wire change immediately
      // so the icon appears/disappears without needing to close the
      // modal.
      const devConsoleToggle = document.getElementById('dev-console-always-show');
      if (devConsoleToggle) {
        devConsoleToggle.addEventListener('change', (e) => {
          if (!window.DevConsole) return;
          DevConsole.setMode(e.target.checked
            ? DevConsole.MODE_ALWAYS
            : DevConsole.MODE_ERRORS_ONLY);
        });
      }

      // Experimental "AI progress estimate" toggle. Server-side per-user
      // flag (default OFF) — fire the POST on change so it takes effect
      // on the next coding run without closing the modal; revert the
      // checkbox if the save fails.
      const estimateToggle = document.getElementById('ai-progress-estimate');
      if (estimateToggle) {
        estimateToggle.addEventListener('change', (e) => this._saveAiProgressEstimate(e.target.checked));
      }

      // Per-user Mayor-model preference dropdown.
      const mayorModelSelect = document.getElementById('mayor-model-select');
      if (mayorModelSelect) {
        mayorModelSelect.addEventListener('change', (e) => this._saveMayorModel(e.target.value));
      }

      // #138 "Dev-chat sound & alerts" toggle. Client-only preference
      // (localStorage, default ON) owned by DevAlerts — we just mirror its
      // checked state and flip the stored flag. Turning it ON is a user
      // gesture, so unlock audio + request notification permission then.
      const alertsToggle = document.getElementById('devchat-alerts-toggle');
      if (alertsToggle) {
        alertsToggle.checked = window.DevAlerts ? DevAlerts.enabled() : true;
        alertsToggle.addEventListener('change', (e) => {
          if (!window.DevAlerts) return;
          DevAlerts.setEnabled(e.target.checked);
          if (e.target.checked) {
            DevAlerts._unlockAudio();
            DevAlerts.requestNotifyPermission();
          }
        });
      }

      // #138 "Send a test alert" — exercises the user's own setup. Fires a
      // demo completion after a short delay so they can stay (hear the
      // chime) or switch away (see the background notification).
      const alertsTest = document.getElementById('devchat-alerts-test');
      if (alertsTest) {
        alertsTest.addEventListener('click', () => {
          if (!window.DevAlerts) return;
          const status = document.getElementById('devchat-alerts-test-status');
          const ms = DevAlerts.testAlert();
          if (!status) return;
          // Visible countdown that ticks down each second (the previous
          // version set the text once and it looked frozen). Guard against
          // rapid re-clicks by clearing any in-flight countdown first; the
          // same id is cleared on close().
          this._clearAlertsTestCountdown();
          status.classList.remove('hidden');
          let remaining = Math.ceil(ms / 1000);
          const render = () => {
            status.textContent = `Alert in ${remaining}s — stay here for the chime, or switch away / background the app for a notification.`;
          };
          render();
          this._alertsTestTimer = setInterval(() => {
            remaining -= 1;
            if (remaining > 0) {
              render();
              return;
            }
            this._clearAlertsTestCountdown();
            status.textContent = 'Sent — you should hear a chime now (or get a notification if you switched away).';
          }, 1000);
        });
      }

      // "View as non-admin" admin tool. Mirror state to localStorage
      // and reload — the simplest way to flush every admin-gated
      // render path (home buttons, app-secrets editor, etc.) without
      // having to re-derive each one. See app.js for where the flag
      // is read and applied to App.user.isAdmin.
      const viewAsToggle = document.getElementById('view-as-non-admin');
      if (viewAsToggle) {
        viewAsToggle.addEventListener('change', (e) => {
          if (e.target.checked) {
            localStorage.setItem('viewAsNonAdmin', '1');
          } else {
            localStorage.removeItem('viewAsNonAdmin');
          }
          window.location.reload();
        });
      }
      // The persistent header banner has its own "Switch back" link
      // for admins who notice they're in preview mode mid-session.
      const bannerOff = document.getElementById('view-as-non-admin-disable');
      if (bannerOff) {
        bannerOff.addEventListener('click', () => {
          localStorage.removeItem('viewAsNonAdmin');
          window.location.reload();
        });
      }

      // Close on backdrop click. The dim area is now split between the
      // outer scroll container (`this.modal`) and a flex wrapper that
      // centers the panel and grows to `min-h-full`; either can be the
      // event target depending on where the user clicked, so accept
      // both. (Same `data-modal-backdrop` attribute is used on every
      // modal in the app — see comment in index.html on the settings
      // modal for the rationale.)
      this.modal.addEventListener('click', (e) => {
        // Ignore the trailing ghost click from the tap that opened the modal
        // (see AppView.revealModal) so it can't close it instantly.
        if (window.AppView && AppView.modalDismissGuarded && AppView.modalDismissGuarded(this.modal)) return;
        if (e.target === this.modal || e.target.dataset.modalBackdrop !== undefined) this.close();
      });

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !this.modal.classList.contains('hidden')) this.close();
      });

      this.refresh();
    },

    async refresh() {
      try {
        const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
        if (!r.ok) return;
        const j = await r.json();
        this.state.hasApiKey = !!j.user?.hasApiKey;
        this.state.keyLast4 = j.user?.keyLast4 || null;
        this.state.usernodePubkey = j.user?.usernodePubkey || null;
        this.state.walletLinkEnabled = !!j.user?.walletLinkEnabled;
        this.state.aiProgressEstimate = !!j.user?.aiProgressEstimate;
        this.state.mayorModel = j.user?.mayorModel || '';
        this._renderIndicator();
      } catch {}
    },

    _renderIndicator() {
      const dot = document.getElementById('drawer-byok-dot');
      if (dot) dot.classList.toggle('hidden', !this.state.hasApiKey);
      // Let dev-chat swap its budget indicator for the BYOK badge
      // without having to observe us directly.
      if (window.DevChat && typeof DevChat.renderBudget === 'function') {
        try { DevChat.renderBudget(); } catch {}
      }
    },

    open(opts = {}) {
      this._renderBody();
      this._refreshSpend();
      this._renderLlmGrants();
      this._renderAgentFilesSection();
      this._renderWalletSection();
      this._renderChangePasswordSection();
      this._renderDevConsoleSection();
      this._renderExperimentalSection();
      this._renderAdminSection();
      this._clearStatus();
      // Reveal via the shared gesture-safe path (see AppView.revealModal) so
      // the opening tap from the drawer row can't ghost-click the backdrop
      // closed. Falls back to a plain reveal if AppView isn't loaded.
      if (window.AppView && AppView.revealModal) AppView.revealModal(this.modal);
      else this.modal.classList.remove('hidden');
      // Intentionally do NOT auto-focus the API key field here. On mobile,
      // focusing an input on open immediately pops the on-screen keyboard,
      // which is jarring when the user just wanted to view settings. Let the
      // keyboard appear only when the user taps a field that needs it.
      // #463: the credits-exhausted banner deep-links here — scroll the
      // API-key section into view (still no focus, per the above).
      if (opts.focusApiKey) {
        const keyInput = document.getElementById('settings-api-key');
        if (keyInput && typeof keyInput.scrollIntoView === 'function') {
          keyInput.scrollIntoView({ block: 'center' });
        }
      }
      // #729 step 10: the Mayor-model nudge banner deep-links here — scroll
      // the model picker into view (no auto-focus, same rationale as above).
      if (opts.focusMayorModel) {
        const select = document.getElementById('mayor-model-select');
        if (select && typeof select.scrollIntoView === 'function') {
          select.scrollIntoView({ block: 'center' });
        }
      }
    },

    _renderDevConsoleSection() {
      const toggle = document.getElementById('dev-console-always-show');
      if (!toggle) return;
      const mode = window.DevConsole ? DevConsole.getMode() : 'errors-only';
      toggle.checked = mode === 'always';
    },

    _renderExperimentalSection() {
      const toggle = document.getElementById('ai-progress-estimate');
      if (toggle) toggle.checked = !!this.state.aiProgressEstimate;
      const status = document.getElementById('ai-progress-estimate-status');
      if (status) { status.classList.add('hidden'); status.textContent = ''; }
      this._renderMayorModelSection();
    },

    // Model list comes from the same GET /api/models the build/scout
    // dropdowns use, so this can never offer a model the server would reject.
    async _renderMayorModelSection() {
      const select = document.getElementById('mayor-model-select');
      if (!select) return;
      try {
        const r = await fetch('/api/models');
        const data = await r.json();
        const list = Array.isArray(data.models) ? data.models : [];
        const fallback = 'claude-sonnet-5';
        const current = list.some((m) => m.id === this.state.mayorModel) ? this.state.mayorModel : fallback;
        select.innerHTML = list.map((m) => `<option value="${m.id}">${m.label || m.id}</option>`).join('');
        select.value = current;
      } catch {}
    },

    async _saveMayorModel(model) {
      const status = document.getElementById('mayor-model-status');
      const select = document.getElementById('mayor-model-select');
      const fail = (msg) => {
        if (select) select.value = this.state.mayorModel || 'claude-sonnet-5';
        if (status) {
          status.textContent = msg;
          status.classList.remove('hidden', 'text-emerald-500', 'text-zinc-500');
          status.classList.add('text-red-500');
        }
      };
      try {
        const r = await fetch('/api/me/mayor-model', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ model }),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          return fail(j.error || 'Failed to save.');
        }
        this.state.mayorModel = model;
        if (status) { status.classList.add('hidden'); status.textContent = ''; }
      } catch (err) {
        fail(`Network error: ${err.message}`);
      }
    },

    async _saveAiProgressEstimate(enabled) {
      const toggle = document.getElementById('ai-progress-estimate');
      const status = document.getElementById('ai-progress-estimate-status');
      const fail = (msg) => {
        if (toggle) toggle.checked = !!this.state.aiProgressEstimate;
        if (status) {
          status.textContent = msg;
          status.classList.remove('hidden', 'text-emerald-500', 'text-zinc-500');
          status.classList.add('text-red-500');
        }
      };
      try {
        const r = await fetch('/api/me/ai-progress-estimate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ enabled: !!enabled }),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          return fail(j.error || 'Failed to save.');
        }
        this.state.aiProgressEstimate = !!enabled;
        if (status) { status.classList.add('hidden'); status.textContent = ''; }
      } catch (err) {
        fail(`Network error: ${err.message}`);
      }
    },

    // Show the admin-preview section only when the server reports the
    // user as a *real* admin. App._realIsAdmin is the un-masked value
    // captured in app.js before the localStorage override gets
    // applied; reading App.user.isAdmin here would be wrong because
    // it reflects the masked state, which would hide the toggle
    // forever once flipped on.
    //
    // Fallback: if `_realIsAdmin` is undefined (e.g. a stale-cached
    // app.js from before that flag was added), fall back to the live
    // `App.user.isAdmin`. Safe because a stale app.js can't have
    // applied the mask either, so the live value still reflects the
    // server truth. `??` (not `||`) so an explicit `false` from a
    // current-cache app.js wins over the fallback.
    _renderAdminSection() {
      const section = document.getElementById('settings-admin-section');
      const toggle = document.getElementById('view-as-non-admin');
      if (!section || !toggle) return;
      // Read the bare `App` identifier rather than `window.App` —
      // app.js declares `App` with `const`, which does NOT write to
      // `window` in non-module browser scripts, so `window.App` is
      // undefined. Using the bare identifier matches the rest of the
      // codebase (dev-chat.js etc.). Fallback to `App.user.isAdmin`
      // covers a stale-cached app.js from before `_realIsAdmin` was
      // introduced; safe because a stale app.js can't have applied
      // the mask either, so the live value still reflects the server
      // truth. `??` (not `||`) so an explicit `false` from a current
      // app.js wins over the fallback.
      const realAdmin = (typeof App !== 'undefined' ? App._realIsAdmin : undefined)
        ?? (typeof App !== 'undefined' && !!App.user?.isAdmin);
      if (!realAdmin) {
        section.classList.add('hidden');
        return;
      }
      section.classList.remove('hidden');
      toggle.checked = localStorage.getItem('viewAsNonAdmin') === '1';
    },

    close() {
      this.modal.classList.add('hidden');
      document.getElementById('settings-api-key').value = '';
      this._stopWalletPolling();
      this._clearAlertsTestCountdown();
    },

    // Clear the "Send a test alert" countdown interval (#138). Idempotent —
    // safe to call when none is running (rapid re-clicks, modal close).
    _clearAlertsTestCountdown() {
      if (this._alertsTestTimer) {
        clearInterval(this._alertsTestTimer);
        this._alertsTestTimer = null;
      }
    },

    _renderBody() {
      const display = document.getElementById('settings-key-display');
      const last4 = document.getElementById('settings-key-last4');
      const removeBtn = document.getElementById('settings-remove');
      const saveBtn = document.getElementById('settings-save');
      const input = document.getElementById('settings-api-key');

      if (this.state.hasApiKey) {
        display.classList.remove('hidden');
        last4.textContent = this.state.keyLast4 || '••••';
        removeBtn.classList.remove('hidden');
        input.placeholder = 'Paste a new key to replace';
        saveBtn.textContent = 'Replace';
      } else {
        display.classList.add('hidden');
        removeBtn.classList.add('hidden');
        input.placeholder = 'sk-ant-...';
        saveBtn.textContent = 'Save';
      }
    },

    // #119 — "Today's spend" breakdown in the API-key section. Fetched
    // fresh on every modal open; the block stays hidden while loading,
    // on fetch failure, or when no key is saved, so it never shows
    // stale or irrelevant figures.
    async _refreshSpend() {
      const block = document.getElementById('settings-spend');
      if (!block) return;
      block.classList.add('hidden');
      if (!this.state.hasApiKey) return;
      try {
        const r = await fetch('/api/budget', { credentials: 'same-origin' });
        if (!r.ok) return;
        const b = await r.json();
        document.getElementById('settings-spend-byok').textContent =
          '$' + ((b.byokSpentCents || 0) / 100).toFixed(2);
        document.getElementById('settings-spend-platform').textContent =
          '$' + ((b.spentCents || 0) / 100).toFixed(2) + ' of $' + ((b.limitCents || 0) / 100).toFixed(2);
        block.classList.remove('hidden');
      } catch {}
    },

    _setStatus(text, kind) {
      const el = document.getElementById('settings-status');
      el.textContent = text;
      el.classList.remove('hidden', 'text-red-500', 'text-emerald-500', 'text-zinc-500');
      const cls = kind === 'error' ? 'text-red-500'
                : kind === 'ok' ? 'text-emerald-500'
                : 'text-zinc-500';
      el.classList.add(cls);
    },

    _clearStatus() {
      const el = document.getElementById('settings-status');
      el.classList.add('hidden');
      el.textContent = '';
    },

    async save() {
      const input = document.getElementById('settings-api-key');
      const saveBtn = document.getElementById('settings-save');
      const removeBtn = document.getElementById('settings-remove');
      const key = input.value.trim();
      if (!key) {
        // When replacing but the user hit Save with an empty input,
        // that's almost certainly a misclick — treat as a no-op rather
        // than clearing the existing key.
        this._setStatus('Paste an API key first.', 'error');
        return;
      }

      this._setStatus('Verifying with Anthropic…', 'info');
      saveBtn.disabled = true;
      removeBtn.disabled = true;

      try {
        const r = await fetch('/api/me/api-key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ key }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          this._setStatus(j.error || 'Failed to save key.', 'error');
          return;
        }
        this.state.hasApiKey = true;
        this.state.keyLast4 = j.keyLast4 || key.slice(-4);
        this._renderIndicator();
        this._setStatus('Saved. Your chats now bill to your Anthropic account.', 'ok');
        input.value = '';
        this._renderBody();
        this._refreshSpend();
        setTimeout(() => this.close(), 900);
      } catch (err) {
        this._setStatus(`Network error: ${err.message}`, 'error');
      } finally {
        saveBtn.disabled = false;
        removeBtn.disabled = false;
      }
    },

    // ── Change password (issue #282) ─────────────────────────────
    _setCpStatus(text, kind) {
      const el = document.getElementById('cp-status');
      if (!el) return;
      el.textContent = text;
      el.classList.remove('hidden', 'text-red-500', 'text-emerald-500', 'text-zinc-500');
      const cls = kind === 'error' ? 'text-red-500' : kind === 'ok' ? 'text-emerald-500' : 'text-zinc-500';
      el.classList.add(cls);
    },

    // Decide whether the wallet option is even offered, then default to
    // the password form. The "Use your wallet instead" link only appears
    // in the Usernode native app (signMessage available) AND when the
    // logged-in account has a linked wallet to prove control of.
    _renderChangePasswordSection() {
      const section = document.getElementById('change-password-section');
      if (!section) return;
      const isNative = !!(window.usernode && window.usernode.isNative);
      this._walletChangeAvailable = isNative && !!this.state.usernodePubkey;
      // Clear any stale field values / status on each open.
      ['cp-current', 'cp-new', 'cp-confirm'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      const status = document.getElementById('cp-status');
      if (status) { status.classList.add('hidden'); status.textContent = ''; }
      this._setChangePasswordMode('password');
    },

    _setChangePasswordMode(mode) {
      // In password mode (or when wallet isn't available) show the
      // current-password field + the normal submit, and offer the
      // "use your wallet" link only if it's available. In wallet mode hide
      // the current-password field, swap the submit, and offer the way back.
      const wallet = mode === 'wallet' && this._walletChangeAvailable;
      const show = (id, on) => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('hidden', !on);
      };
      show('cp-current-row', !wallet);
      show('cp-save', !wallet);
      show('cp-wallet-save', wallet);
      // Offer the "switch to wallet" link only in password mode and only
      // when wallet change is available; offer the way back in wallet mode.
      show('cp-wallet-mode', !wallet && this._walletChangeAvailable);
      show('cp-password-mode', wallet);
    },

    async changePasswordWithWallet() {
      const newEl = document.getElementById('cp-new');
      const confirmEl = document.getElementById('cp-confirm');
      const btn = document.getElementById('cp-wallet-save');
      const newPassword = newEl.value;
      const confirm = confirmEl.value;

      if (newPassword.length < 8) { this._setCpStatus('New password must be at least 8 characters.', 'error'); return; }
      if (newPassword !== confirm) { this._setCpStatus('New passwords do not match.', 'error'); return; }
      if (!(window.usernode && window.usernode.isNative) || typeof window.signMessage !== 'function') {
        this._setCpStatus('Wallet signing is only available in the Usernode app.', 'error');
        return;
      }

      btn.disabled = true;
      this._setCpStatus('Verifying identity…', 'info');
      try {
        const pubkey = this.state.usernodePubkey || (window.getNodeAddress ? await window.getNodeAddress() : null);
        if (!pubkey) { this._setCpStatus('Could not read your wallet address.', 'error'); return; }

        // Fresh single-use challenge from the shared wallet-check endpoint.
        const checkRes = await fetch('/api/auth/wallet-check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ pubkey }),
        });
        const checkData = await checkRes.json().catch(() => ({}));
        const challenge = checkData.challenge;
        if (!challenge) { this._setCpStatus('Could not get a challenge from the server.', 'error'); return; }

        const sig = await window.signMessage(challenge);
        const r = await fetch('/api/me/wallet-change-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ publicKey: sig.publicKey, challenge, signature: sig.signature, newPassword }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { this._setCpStatus(j.error || 'Failed to change password.', 'error'); return; }
        newEl.value = '';
        confirmEl.value = '';
        this._setCpStatus('Password changed.', 'ok');
      } catch (err) {
        if (err && err.message && err.message.includes('denied')) {
          this._setCpStatus('Signature request was denied.', 'error');
        } else {
          this._setCpStatus(`Wallet change failed: ${err.message || err}`, 'error');
        }
      } finally {
        btn.disabled = false;
      }
    },

    async changePassword() {
      const currentEl = document.getElementById('cp-current');
      const newEl = document.getElementById('cp-new');
      const confirmEl = document.getElementById('cp-confirm');
      const btn = document.getElementById('cp-save');
      const currentPassword = currentEl.value;
      const newPassword = newEl.value;
      const confirm = confirmEl.value;

      if (!currentPassword) { this._setCpStatus('Enter your current password.', 'error'); return; }
      if (newPassword.length < 8) { this._setCpStatus('New password must be at least 8 characters.', 'error'); return; }
      if (newPassword !== confirm) { this._setCpStatus('New passwords do not match.', 'error'); return; }

      btn.disabled = true;
      this._setCpStatus('Saving…', 'info');
      try {
        const r = await fetch('/api/me/password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ currentPassword, newPassword }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { this._setCpStatus(j.error || 'Failed to change password.', 'error'); return; }
        currentEl.value = '';
        newEl.value = '';
        confirmEl.value = '';
        this._setCpStatus('Password changed.', 'ok');
      } catch (err) {
        this._setCpStatus(`Network error: ${err.message}`, 'error');
      } finally {
        btn.disabled = false;
      }
    },

    async logout() {
      const btn = document.getElementById('settings-logout');
      if (btn) btn.disabled = true;
      try {
        await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
      } catch (_) {
        // Server-side session deletion is best-effort; the auth middleware
        // will still treat the user as logged out once the cookie is
        // cleared (server clears it on the response) or expires.
      }
      // Offline mode (#487): the service worker caches GET /api/* responses
      // per-URL, not per-user — wipe them so the next account on this
      // device can't see this user's cached feed. Belt-and-braces: the SW
      // also clears the API cache when it sees the logout POST above.
      try { await this._clearSwApiCache(); } catch (_) {}
      window.location.href = '/login.html';
    },

    // Ask the active service worker to drop its API cache; resolves on ack
    // or after a short timeout so logout never hangs on a wedged worker.
    _clearSwApiCache() {
      const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (!sw) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(resolve, 1000);
        try {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => { clearTimeout(timer); resolve(); };
          sw.postMessage({ type: 'clear-api-cache' }, [channel.port2]);
        } catch (_) {
          clearTimeout(timer);
          resolve();
        }
      });
    },

    async remove() {
      if (!confirm('Remove your API key? Future chats will fall back to the shared daily budget.')) return;
      const removeBtn = document.getElementById('settings-remove');
      removeBtn.disabled = true;
      try {
        const r = await fetch('/api/me/api-key', { method: 'DELETE', credentials: 'same-origin' });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          this._setStatus(j.error || 'Failed to remove key.', 'error');
          return;
        }
        this.state.hasApiKey = false;
        this.state.keyLast4 = null;
        this._renderIndicator();
        this._renderBody();
        this._refreshSpend();
        this._setStatus('Removed.', 'ok');
        setTimeout(() => this.close(), 700);
      } catch (err) {
        this._setStatus(`Network error: ${err.message}`, 'error');
      } finally {
        removeBtn.disabled = false;
      }
    },

    // ── App AI permissions (issue #34) ───────────────────────────
    //
    // Fetched fresh on every modal open. Each active grant renders as
    // a row: app name, $spent / $cap today, a cap editor, the BYOK
    // spillover toggle (only when a key is on file), and Revoke.
    // Revoked grants show a muted badge — re-approving happens via the
    // app's own consent dialog, not from here. In staging previews the
    // page's ?demo=1 is passed through so the (always-empty,
    // staging:private) grant tables still produce a reviewable list.

    async _renderLlmGrants() {
      const list = document.getElementById('llm-grants-list');
      if (!list) return;
      list.innerHTML = '<p class="text-xs text-zinc-500">Loading…</p>';
      const demo = new URLSearchParams(window.location.search).get('demo') === '1';
      let grants = [];
      try {
        const r = await fetch('/api/me/llm-grants' + (demo ? '?demo=1' : ''), { credentials: 'same-origin' });
        if (!r.ok) throw new Error('fetch failed');
        const j = await r.json();
        grants = j.grants || [];
      } catch {
        list.innerHTML = '<p class="text-xs text-red-500">Failed to load app permissions.</p>';
        return;
      }
      if (!grants.length) {
        list.innerHTML = '<p class="text-xs text-zinc-500 dark:text-zinc-500">No apps have asked to use AI yet.</p>';
        return;
      }
      list.innerHTML = '';
      for (const g of grants) list.appendChild(this._llmGrantRow(g));
    },

    _llmGrantRow(g) {
      const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      }[c]));
      const row = document.createElement('div');
      row.className = 'rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-xs';
      const revoked = g.status !== 'active';
      const spent = ((g.spentTodayCents || 0) + (g.byokSpentTodayCents || 0)) / 100;
      const cap = (g.dailyCapCents || 0) / 100;

      if (revoked) {
        row.innerHTML = `
          <div class="flex items-center justify-between gap-2">
            <span class="font-medium text-zinc-500 dark:text-zinc-500 truncate">${esc(g.appName)}</span>
            <span class="shrink-0 rounded px-1.5 py-0.5 bg-zinc-200 dark:bg-zinc-700 text-zinc-500 dark:text-zinc-400">Revoked</span>
          </div>`;
        return row;
      }

      row.innerHTML = `
        <div class="flex items-center justify-between gap-2">
          <span class="font-medium text-zinc-700 dark:text-zinc-300 truncate">${esc(g.appName)}</span>
          <span class="font-mono text-zinc-600 dark:text-zinc-400 shrink-0">$${spent.toFixed(2)} / $${cap.toFixed(2)} today</span>
        </div>
        <div class="flex items-center justify-between gap-2 mt-2 flex-wrap">
          <label class="flex items-center gap-1 text-zinc-600 dark:text-zinc-400">
            Cap $<input data-role="cap" type="number" min="0.01" step="0.01" value="${cap.toFixed(2)}"
              class="w-20 rounded bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-1.5 py-0.5 font-mono text-zinc-900 dark:text-zinc-100" />
          </label>
          ${this.state.hasApiKey || g.allowByok ? `
          <label class="flex items-center gap-1 cursor-pointer select-none text-zinc-600 dark:text-zinc-400">
            <input data-role="byok" type="checkbox" class="accent-violet-500 w-3.5 h-3.5" ${g.allowByok ? 'checked' : ''} />
            Use my own key past the daily budget
          </label>` : ''}
          <button data-role="revoke"
            class="rounded border border-red-400 dark:border-red-700 px-2 py-0.5 font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 transition-colors">Revoke</button>
        </div>`;

      const status = (text, kind) => this._setLlmGrantsStatus(text, kind);
      const isDemo = g.appId < 0;

      const capInput = row.querySelector('[data-role="cap"]');
      capInput.addEventListener('change', async () => {
        if (isDemo) { status('Demo data — changes are not saved.', 'info'); return; }
        const cents = Math.round(parseFloat(capInput.value) * 100);
        if (!Number.isFinite(cents) || cents <= 0) {
          status('Enter a valid cap (at least $0.01).', 'error');
          return;
        }
        try {
          const r = await fetch(`/api/me/llm-grants/${g.appId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ dailyCapCents: cents }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) { status(j.error || 'Failed to update cap.', 'error'); return; }
          status('Cap updated.', 'ok');
          this._renderLlmGrants();
        } catch (err) {
          status('Network error: ' + err.message, 'error');
        }
      });

      const byokInput = row.querySelector('[data-role="byok"]');
      if (byokInput) {
        byokInput.addEventListener('change', async () => {
          if (isDemo) { status('Demo data — changes are not saved.', 'info'); return; }
          try {
            const r = await fetch(`/api/me/llm-grants/${g.appId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ allowByok: byokInput.checked }),
            });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) {
              byokInput.checked = !byokInput.checked;
              status(j.error || 'Failed to update.', 'error');
              return;
            }
            status(byokInput.checked
              ? 'This app may spill over onto your own key (still capped).'
              : 'Spillover disabled.', 'ok');
          } catch (err) {
            byokInput.checked = !byokInput.checked;
            status('Network error: ' + err.message, 'error');
          }
        });
      }

      row.querySelector('[data-role="revoke"]').addEventListener('click', async () => {
        const ok = window.ConfirmModal
          ? await ConfirmModal.show({
              title: `Revoke AI access for "${g.appName}"?`,
              message: 'Its next AI call will fail immediately. The app can ask for access again later.',
              confirmLabel: 'Revoke',
              danger: true,
            })
          : confirm(`Revoke AI access for "${g.appName}"?`);
        if (!ok) return;
        if (isDemo) { status('Demo data — changes are not saved.', 'info'); return; }
        try {
          const r = await fetch(`/api/me/llm-grants/${g.appId}`, {
            method: 'DELETE', credentials: 'same-origin',
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) { status(j.error || 'Failed to revoke.', 'error'); return; }
          status('Revoked.', 'ok');
          this._renderLlmGrants();
        } catch (err) {
          status('Network error: ' + err.message, 'error');
        }
      });

      return row;
    },

    _setLlmGrantsStatus(text, kind) {
      const el = document.getElementById('llm-grants-status');
      if (!el) return;
      el.textContent = text;
      el.classList.remove('hidden', 'text-red-500', 'text-emerald-500', 'text-zinc-500');
      const cls = kind === 'error' ? 'text-red-500' : kind === 'ok' ? 'text-emerald-500' : 'text-zinc-500';
      el.classList.add(cls);
      if (kind === 'ok') setTimeout(() => el.classList.add('hidden'), 3000);
    },

    // ── Agent instructions & skills (#460) ───────────────────────
    // Per-user global files the coding agent loads on every build/scout
    // run this user dispatches. List/upload/delete against
    // /api/me/agent-files; in staging the (staging:private, always empty)
    // table is stood in for by ?demo=1 fabricated rows, passed through
    // from the page URL exactly like the AI-permissions section above.

    _renderAgentFilesSection() {
      this._wireAgentFiles();
      this._hideAgentFilesForm();
      this._loadAgentFiles();
    },

    _agentFilesDemo() {
      return new URLSearchParams(window.location.search).get('demo') === '1';
    },

    // One-time event wiring (the section markup is static in index.html;
    // open() re-runs this, so guard against double-binding).
    _wireAgentFiles() {
      if (this._agentFilesWired) return;
      this._agentFilesWired = true;

      const input = document.getElementById('agent-files-input');
      document.querySelectorAll('[data-agent-files-upload]').forEach((btn) => {
        btn.addEventListener('click', () => {
          this._pendingAgentKind = btn.dataset.agentFilesUpload;
          input.value = '';
          input.click();
        });
      });

      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        if (!file) return;
        if (file.size > 48 * 1024) {
          this._setAgentFilesStatus(`"${file.name}" is too large — the limit is 48 KB per file.`, 'error');
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          this._pendingAgentFile = {
            kind: this._pendingAgentKind,
            content: String(reader.result || ''),
          };
          this._showAgentFilesForm(file.name);
        };
        reader.onerror = () => this._setAgentFilesStatus('Could not read that file.', 'error');
        reader.readAsText(file);
      });

      document.getElementById('agent-files-cancel').addEventListener('click', () => {
        this._hideAgentFilesForm();
      });
      document.getElementById('agent-files-save').addEventListener('click', () => {
        this._saveAgentFile();
      });
    },

    // Client-side twin of the server's normalizeName — purely a
    // convenience prefill; the server re-normalizes and is authoritative.
    _slugifyAgentFileName(raw) {
      return String(raw || '')
        .trim()
        .replace(/\.(md|txt)$/i, '')
        .toLowerCase()
        .replace(/[\s_.]+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
    },

    _showAgentFilesForm(filename) {
      const form = document.getElementById('agent-files-form');
      const title = document.getElementById('agent-files-form-title');
      const nameInput = document.getElementById('agent-files-name');
      const descWrap = document.getElementById('agent-files-desc-wrap');
      const descInput = document.getElementById('agent-files-desc');
      const kind = this._pendingAgentFile?.kind || 'instruction';
      title.textContent = kind === 'skill'
        ? `New skill from "${filename}"`
        : `New instruction file from "${filename}"`;
      nameInput.value = this._slugifyAgentFileName(filename);
      descWrap.classList.toggle('hidden', kind !== 'skill');
      descInput.value = '';
      form.classList.remove('hidden');
      this._setAgentFilesStatus('', 'clear');
    },

    _hideAgentFilesForm() {
      this._pendingAgentFile = null;
      const form = document.getElementById('agent-files-form');
      if (form) form.classList.add('hidden');
    },

    async _saveAgentFile() {
      const pending = this._pendingAgentFile;
      if (!pending) return;
      if (this._agentFilesDemo()) {
        this._setAgentFilesStatus('Demo data — changes are not saved.', 'info');
        this._hideAgentFilesForm();
        return;
      }
      const name = document.getElementById('agent-files-name').value.trim();
      if (!name) {
        this._setAgentFilesStatus('Give the file a name.', 'error');
        return;
      }
      const description = document.getElementById('agent-files-desc').value.trim();
      try {
        const r = await fetch('/api/me/agent-files', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ kind: pending.kind, name, description, content: pending.content }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          this._setAgentFilesStatus(j.error || 'Failed to save the file.', 'error');
          return;
        }
        this._hideAgentFilesForm();
        this._setAgentFilesStatus(`Saved "${j.file?.name || name}" — it applies from your next run.`, 'ok');
        this._loadAgentFiles();
      } catch (err) {
        this._setAgentFilesStatus('Network error: ' + err.message, 'error');
      }
    },

    async _loadAgentFiles() {
      const instrList = document.getElementById('agent-files-instructions-list');
      const skillList = document.getElementById('agent-files-skills-list');
      if (!instrList || !skillList) return;
      instrList.innerHTML = '<p class="text-xs text-zinc-500">Loading…</p>';
      skillList.innerHTML = '';
      const demo = this._agentFilesDemo();
      let files = [];
      try {
        const r = await fetch('/api/me/agent-files' + (demo ? '?demo=1' : ''), { credentials: 'same-origin' });
        if (!r.ok) throw new Error('fetch failed');
        const j = await r.json();
        files = j.files || [];
      } catch {
        instrList.innerHTML = '<p class="text-xs text-red-500">Failed to load your agent files.</p>';
        return;
      }
      const byKind = (kind) => files.filter((f) => f.kind === kind);
      const renderList = (el, list, emptyText) => {
        el.innerHTML = '';
        if (!list.length) {
          el.innerHTML = `<p class="text-xs text-zinc-500 dark:text-zinc-500">${emptyText}</p>`;
          return;
        }
        for (const f of list) el.appendChild(this._agentFileRow(f, demo));
      };
      renderList(instrList, byKind('instruction'),
        'No instruction files yet — upload a markdown file to guide the coding agent on every build you start.');
      renderList(skillList, byKind('skill'),
        'No skills yet — upload a skill file the agent can use while building for you.');
    },

    _agentFileRow(f, demo) {
      const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      }[c]));
      const row = document.createElement('div');
      row.className = 'rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-xs';
      const kb = Math.max(1, Math.round((f.size_bytes || 0) / 1024));
      row.innerHTML = `
        <div class="flex items-center justify-between gap-2">
          <span class="font-mono font-medium text-zinc-700 dark:text-zinc-300 truncate">${esc(f.name)}</span>
          <span class="shrink-0 flex items-center gap-2">
            <span class="text-zinc-500 dark:text-zinc-500">${kb} KB</span>
            <button data-role="view" class="text-violet-500 hover:text-violet-400 font-medium">View</button>
            <button data-role="delete" class="text-red-600 dark:text-red-400 hover:text-red-500 font-medium">Delete</button>
          </span>
        </div>
        ${f.description ? `<div class="text-zinc-500 dark:text-zinc-500 mt-1 truncate">${esc(f.description)}</div>` : ''}
        <pre data-role="content" class="hidden mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-2 py-1.5 font-mono text-[11px] text-zinc-700 dark:text-zinc-300"></pre>`;

      const viewBtn = row.querySelector('[data-role="view"]');
      const pre = row.querySelector('[data-role="content"]');
      viewBtn.addEventListener('click', async () => {
        if (!pre.classList.contains('hidden')) {
          pre.classList.add('hidden');
          viewBtn.textContent = 'View';
          return;
        }
        if (!pre.textContent) {
          pre.textContent = 'Loading…';
          pre.classList.remove('hidden');
          try {
            const qs = `kind=${encodeURIComponent(f.kind)}&name=${encodeURIComponent(f.name)}` + (demo ? '&demo=1' : '');
            const r = await fetch(`/api/me/agent-files/content?${qs}`, { credentials: 'same-origin' });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(j.error || 'fetch failed');
            pre.textContent = j.file?.content || '(empty)';
          } catch (err) {
            pre.textContent = 'Failed to load: ' + err.message;
          }
        } else {
          pre.classList.remove('hidden');
        }
        viewBtn.textContent = 'Hide';
      });

      row.querySelector('[data-role="delete"]').addEventListener('click', async () => {
        const ok = window.ConfirmModal
          ? await ConfirmModal.show({
              title: `Delete "${f.name}"?`,
              message: 'The coding agent stops using it from your next run. This cannot be undone.',
              confirmLabel: 'Delete',
              danger: true,
            })
          : confirm(`Delete "${f.name}"?`);
        if (!ok) return;
        if (demo) { this._setAgentFilesStatus('Demo data — changes are not saved.', 'info'); return; }
        try {
          const r = await fetch('/api/me/agent-files', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ kind: f.kind, name: f.name }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) { this._setAgentFilesStatus(j.error || 'Failed to delete.', 'error'); return; }
          this._setAgentFilesStatus(`Deleted "${f.name}".`, 'ok');
          this._loadAgentFiles();
        } catch (err) {
          this._setAgentFilesStatus('Network error: ' + err.message, 'error');
        }
      });

      return row;
    },

    _setAgentFilesStatus(text, kind) {
      const el = document.getElementById('agent-files-status');
      if (!el) return;
      if (kind === 'clear' || !text) {
        el.classList.add('hidden');
        el.textContent = '';
        return;
      }
      el.textContent = text;
      el.classList.remove('hidden', 'text-red-500', 'text-emerald-500', 'text-zinc-500');
      const cls = kind === 'error' ? 'text-red-500' : kind === 'ok' ? 'text-emerald-500' : 'text-zinc-500';
      el.classList.add(cls);
      if (kind === 'ok') setTimeout(() => el.classList.add('hidden'), 3000);
    },

    // ── Wallet linking ───────────────────────────────────────────

    _renderWalletSection() {
      const section = document.getElementById('wallet-section');
      if (!section) return;
      if (!this.state.walletLinkEnabled) { section.classList.add('hidden'); return; }
      section.classList.remove('hidden');

      const unlinked = document.getElementById('wallet-unlinked');
      const linking = document.getElementById('wallet-linking');
      const linked = document.getElementById('wallet-linked');
      unlinked.classList.add('hidden');
      linking.classList.add('hidden');
      linked.classList.add('hidden');

      if (this.state.usernodePubkey) {
        linked.classList.remove('hidden');
        const display = document.getElementById('wallet-pubkey-display');
        const pk = this.state.usernodePubkey;
        display.textContent = pk.length > 20 ? pk.slice(0, 10) + '…' + pk.slice(-6) : pk;
        display.title = pk;
      } else if (this._walletPollTimer) {
        linking.classList.remove('hidden');
      } else {
        unlinked.classList.remove('hidden');
      }
    },

    async _startWalletLink() {
      const btn = document.getElementById('wallet-link-btn');
      btn.disabled = true;
      try {
        const r = await fetch('/api/me/wallet-link', {
          method: 'POST', credentials: 'same-origin',
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          this._setWalletStatus(j.error || 'Failed to start linking.', 'error');
          btn.disabled = false;
          return;
        }
        const qrPayload = JSON.stringify(j.qr);
        this._walletExpiresAt = new Date(j.expiresAt).getTime();

        const container = document.getElementById('wallet-qr-canvas');
        container.innerHTML = '';
        if (window.QRCode) {
          new QRCode(container, {
            text: qrPayload,
            width: 180,
            height: 180,
            colorDark: '#1a1a30',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.L,
          });
        }

        this._startWalletPolling();
        this._startWalletCountdown();
        this._renderWalletSection();
      } catch (err) {
        this._setWalletStatus('Network error: ' + err.message, 'error');
        btn.disabled = false;
      }
    },

    _startWalletPolling() {
      this._stopWalletPolling();
      const check = async () => {
        try {
          const r = await fetch('/api/me/wallet-link/status', { credentials: 'same-origin' });
          const j = await r.json();
          if (j.linked) {
            this.state.usernodePubkey = j.pubkey;
            this._stopWalletPolling();
            this._renderWalletSection();
            this._setWalletStatus('Wallet linked!', 'ok');
          }
        } catch {}
      };
      check();
      this._walletPollTimer = setInterval(check, 2000);
    },

    _stopWalletPolling() {
      if (this._walletPollTimer) { clearInterval(this._walletPollTimer); this._walletPollTimer = null; }
      if (this._walletCountdownTimer) { clearInterval(this._walletCountdownTimer); this._walletCountdownTimer = null; }
      this._walletExpiresAt = null;
    },

    _startWalletCountdown() {
      if (this._walletCountdownTimer) clearInterval(this._walletCountdownTimer);
      const label = document.getElementById('wallet-link-timer');
      const tick = () => {
        if (!this._walletExpiresAt) { label.textContent = ''; return; }
        const remaining = Math.max(0, this._walletExpiresAt - Date.now());
        if (remaining <= 0) {
          this._cancelWalletLink();
          this._setWalletStatus('QR code expired. Try again.', 'error');
          return;
        }
        const m = Math.floor(remaining / 60000);
        const s = Math.floor((remaining % 60000) / 1000);
        label.textContent = 'Expires in ' + m + ':' + String(s).padStart(2, '0');
      };
      tick();
      this._walletCountdownTimer = setInterval(tick, 1000);
    },

    _cancelWalletLink() {
      this._stopWalletPolling();
      const btn = document.getElementById('wallet-link-btn');
      if (btn) btn.disabled = false;
      this._renderWalletSection();
    },

    async _unlinkWallet() {
      if (!confirm('Unlink your Usernode wallet?')) return;
      try {
        const r = await fetch('/api/me/wallet-link', { method: 'DELETE', credentials: 'same-origin' });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          this._setWalletStatus(j.error || 'Failed to unlink.', 'error');
          return;
        }
        this.state.usernodePubkey = null;
        this._renderWalletSection();
        this._setWalletStatus('Wallet unlinked.', 'ok');
      } catch (err) {
        this._setWalletStatus('Network error: ' + err.message, 'error');
      }
    },

    _setWalletStatus(text, kind) {
      const el = document.getElementById('wallet-status');
      if (!el) return;
      el.textContent = text;
      el.classList.remove('hidden', 'text-red-500', 'text-emerald-500', 'text-zinc-500');
      const cls = kind === 'error' ? 'text-red-500' : kind === 'ok' ? 'text-emerald-500' : 'text-zinc-500';
      el.classList.add(cls);
      if (kind === 'ok') setTimeout(() => el.classList.add('hidden'), 3000);
    },
  };

  window.Settings = Settings;
  document.addEventListener('DOMContentLoaded', () => Settings.init());
})();
