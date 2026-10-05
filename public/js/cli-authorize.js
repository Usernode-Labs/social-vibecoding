'use strict';

(() => {
  const STORAGE_KEY = 'social-vibecoding-cli-user-code';
  const entry = document.getElementById('entry');
  const entryMessage = document.getElementById('entry-message');
  const confirmation = document.getElementById('confirmation');
  const result = document.getElementById('result');
  const message = document.getElementById('message');
  const tryAgain = document.getElementById('try-again');
  const approve = document.getElementById('approve');
  const reject = document.getElementById('reject');
  let canonicalCode = null;
  let expiryTimer = null;

  // The CLI puts the short display code in the fragment. Fragments are not
  // sent in the HTTP request, and we remove it from browser history before
  // doing any network work. sessionStorage carries the code across a
  // same-tab login redirect without making it durable.
  function consumeLaunchCode() {
    const fragment = window.location.hash;
    if (!fragment) return null;
    window.history.replaceState(null, '', '/cli/authorize');
    const params = new URLSearchParams(fragment.slice(1));
    const codes = params.getAll('code');
    const onlyCode = [...params.keys()].every((key) => key === 'code');
    if (!onlyCode || codes.length !== 1 || codes[0].length > 32) return null;
    return codes[0];
  }

  const launched = consumeLaunchCode();
  const restored = sessionStorage.getItem(STORAGE_KEY);
  const initialCode = launched || restored;
  if (launched) sessionStorage.setItem(STORAGE_KEY, launched);

  function clearTemporaryCode() {
    sessionStorage.removeItem(STORAGE_KEY);
    canonicalCode = null;
    if (expiryTimer) clearTimeout(expiryTimer);
  }

  function showResult(text, retry) {
    entry.hidden = true;
    confirmation.hidden = true;
    result.hidden = false;
    message.textContent = text;
    tryAgain.hidden = !retry;
    if (retry) {
      tryAgain.textContent = canonicalCode || sessionStorage.getItem(STORAGE_KEY)
        ? globalThis.PlatformI18n.t("core:try_again_d8b8392e")
        : globalThis.PlatformI18n.t("core:start_a_new_request_f80d20dc");
    }
  }

  function invalidOrExpired() {
    clearTemporaryCode();
    showResult(globalThis.PlatformI18n.t("core:that_code_is_invalid_or_expired_4576daf0"), true);
  }

  async function lookup(code) {
    await globalThis.PlatformI18n.ready;
    entryMessage.textContent = globalThis.PlatformI18n.t("core:checking_the_authorization_request_3cb34e96");
    const response = await fetch(
      `/api/cli/device/approval?user_code=${encodeURIComponent(code)}`,
      { headers: { Accept: 'application/json' }, cache: 'no-store' }
    );
    if (response.status === 401) {
      sessionStorage.setItem(STORAGE_KEY, code);
      window.location.replace('/?return_to=%2Fcli%2Fauthorize#login');
      return;
    }
    if (response.status === 404) return invalidOrExpired();
    if (!response.ok) return showResult(globalThis.PlatformI18n.t("core:authorization_is_temporarily_unavailable_44f141d0"), true);
    const data = await response.json();
    canonicalCode = data.user_code;
    sessionStorage.setItem(STORAGE_KEY, canonicalCode);
    document.getElementById('confirm-code').textContent = data.user_code;
    document.getElementById('confirm-client').textContent = data.client_name;
    document.getElementById('confirm-scopes').textContent = data.scopes.join(', ');
    document.getElementById('confirm-expiry').textContent =
      new Date(data.expires_at).toLocaleString(globalThis.PlatformI18n.getLanguage());
    entry.hidden = true;
    result.hidden = true;
    confirmation.hidden = false;
    const delay = Math.max(0, new Date(data.expires_at).getTime() - Date.now());
    expiryTimer = setTimeout(invalidOrExpired, delay);
  }

  async function decide(decision) {
    approve.disabled = true;
    reject.disabled = true;
    try {
      const response = await fetch('/api/cli/device/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_code: canonicalCode, decision }),
      });
      if (response.status === 401) {
        sessionStorage.setItem(STORAGE_KEY, canonicalCode);
        window.location.replace('/?return_to=%2Fcli%2Fauthorize#login');
        return;
      }
      if (response.status === 404) return invalidOrExpired();
      if (response.status === 204) {
        clearTemporaryCode();
        showResult(
          decision === 'approve'
            ? globalThis.PlatformI18n.t("core:access_authorized_you_can_return_to_the_cli_015f4a41")
            : globalThis.PlatformI18n.t("core:authorization_cancelled_8ce509ef"),
          false
        );
      } else if (response.status === 409) {
        clearTemporaryCode();
        showResult(globalThis.PlatformI18n.t("core:this_request_already_has_the_opposite_decision_34ca5e3f"), false);
      } else {
        showResult(globalThis.PlatformI18n.t("core:authorization_is_temporarily_unavailable_44f141d0"), true);
      }
    } catch {
      showResult(globalThis.PlatformI18n.t("core:authorization_is_temporarily_unavailable_44f141d0"), true);
    } finally {
      approve.disabled = false;
      reject.disabled = false;
    }
  }

  approve.addEventListener('click', () => decide('approve'));
  reject.addEventListener('click', () => decide('reject'));
  tryAgain.addEventListener('click', () => {
    const pendingCode = canonicalCode || sessionStorage.getItem(STORAGE_KEY);
    result.hidden = true;
    confirmation.hidden = true;
    entry.hidden = false;
    if (pendingCode) {
      lookup(pendingCode).catch(() => {
        showResult(globalThis.PlatformI18n.t("core:authorization_is_temporarily_unavailable_44f141d0"), true);
      });
    } else {
      entryMessage.textContent =
        globalThis.PlatformI18n.t("core:start_a_new_authorization_request_from_the_homer_e76df2a5");
    }
  });

  if (initialCode) {
    lookup(initialCode).catch(() => {
      showResult(globalThis.PlatformI18n.t("core:authorization_is_temporarily_unavailable_44f141d0"), true);
    });
  }
})();
