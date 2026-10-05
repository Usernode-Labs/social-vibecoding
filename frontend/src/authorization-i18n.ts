// These two public consent pages own their static DOM; they do not mount the
// React shell, load app data, or change the connector/CLI authorization flow.
import { ensureNamespace, i18n, t, useAccountLanguage } from './lib/i18n/runtime';

function renderMessages() {
  for (const element of document.querySelectorAll<HTMLElement>('[data-message]')) {
    element.textContent = t(element.dataset.message!);
  }
}

const ready = (async () => {
  // Account locale is authoritative when signed in. An unavailable session
  // read leaves authentication to the existing authorization page controller.
  let user = null;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch('/api/auth/me', { credentials: 'same-origin', signal: controller.signal });
    if (response.ok) {
      const data = await response.json();
      user = data.user || null;
    }
  } catch { /* retain the device language */ }
  finally { clearTimeout(deadline); }
  await ensureNamespace('authorization');
  await useAccountLanguage(user);
  renderMessages();
})();

(globalThis as unknown as { PlatformI18n: { ready: Promise<void> } }).PlatformI18n.ready = ready;
i18n.on('languageChanged', renderMessages);
