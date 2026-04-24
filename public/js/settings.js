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
    state: { hasApiKey: false, keyLast4: null },

    init() {
      this.modal = document.getElementById('settings-modal');
      document.getElementById('settings-btn').addEventListener('click', () => this.open());
      document.getElementById('settings-cancel').addEventListener('click', () => this.close());
      document.getElementById('settings-save').addEventListener('click', () => this.save());
      document.getElementById('settings-remove').addEventListener('click', () => this.remove());

      this.modal.addEventListener('click', (e) => {
        if (e.target === this.modal) this.close();
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
      this._clearStatus();
      this.modal.classList.remove('hidden');
      // Only focus the input when there's nothing yet — when we're
      // showing an existing key, the "Save" button is the more
      // interesting target (user is probably here to remove/replace).
      if (!this.state.hasApiKey) {
        setTimeout(() => document.getElementById('settings-api-key').focus(), 0);
      }
    },

    close() {
      this.modal.classList.add('hidden');
      document.getElementById('settings-api-key').value = '';
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
  };

  window.Settings = Settings;
  document.addEventListener('DOMContentLoaded', () => Settings.init());
})();
