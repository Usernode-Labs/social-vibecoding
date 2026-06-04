// #30 — Settings modal (BYOK: bring your own Anthropic API key).
//
// The gear button in the header opens this modal. Users can paste an
// `sk-ant-...` key; the server verifies it with a cheap 1-token call
// and only then encrypts + stores it. Once saved, a small emerald dot
// appears on the gear icon so the user can tell at a glance that their
// key is active — and so can any other user viewing over their
// shoulder (no secrets leak, just the indicator).
(function () {
  'use strict';

  const Settings = {
    modal: null,
    state: { hasApiKey: false, keyLast4: null, usernodePubkey: null, walletLinkEnabled: false },
    _walletPollTimer: null,
    _walletExpiresAt: null,
    _walletCountdownTimer: null,

    init() {
      this.modal = document.getElementById('settings-modal');
      document.getElementById('settings-btn').addEventListener('click', () => this.open());
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
        this._renderIndicator();
      } catch {}
    },

    _renderIndicator() {
      const dot = document.getElementById('settings-byok-dot');
      if (dot) dot.classList.toggle('hidden', !this.state.hasApiKey);
      // Let dev-chat swap its budget indicator for the BYOK badge
      // without having to observe us directly.
      if (window.DevChat && typeof DevChat.renderBudget === 'function') {
        try { DevChat.renderBudget(); } catch {}
      }
    },

    open() {
      this._renderBody();
      this._renderWalletSection();
      this._renderDevConsoleSection();
      this._renderAdminSection();
      this._clearStatus();
      this.modal.classList.remove('hidden');
      // Intentionally do NOT auto-focus the API key field here. On mobile,
      // focusing an input on open immediately pops the on-screen keyboard,
      // which is jarring when the user just wanted to view settings. Let the
      // keyboard appear only when the user taps a field that needs it.
    },

    _renderDevConsoleSection() {
      const toggle = document.getElementById('dev-console-always-show');
      if (!toggle) return;
      const mode = window.DevConsole ? DevConsole.getMode() : 'errors-only';
      toggle.checked = mode === 'always';
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
        setTimeout(() => this.close(), 900);
      } catch (err) {
        this._setStatus(`Network error: ${err.message}`, 'error');
      } finally {
        saveBtn.disabled = false;
        removeBtn.disabled = false;
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
      window.location.href = '/login.html';
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
        this._setStatus('Removed.', 'ok');
        setTimeout(() => this.close(), 700);
      } catch (err) {
        this._setStatus(`Network error: ${err.message}`, 'error');
      } finally {
        removeBtn.disabled = false;
      }
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
