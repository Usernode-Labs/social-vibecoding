/**
 * Saves the signed-in person's language preference (POST /api/me/locale) and
 * keeps everything that reads it in step: the shell's cached user, any open
 * app frame (#757: usernode.getUserLocale and `usernode:locale-changed`), and
 * the Settings screen when it is loaded.
 *
 * Shared by Settings' picker and the automatic-language notice, so both save
 * the same way. Rejects with a message fit to show beside the control.
 */

type ShellApp = { user?: { locale?: string | null } | null };
type ShellAppView = { notifyLocaleChanged?: (locale: string | null) => void };
type ShellSettings = { state?: { locale?: string | null }; _renderLanguageSection?: () => void };

// app.js declares both with `const`, so neither is a property of `window`.
declare const App: ShellApp | undefined;
declare const AppView: ShellAppView | undefined;

export async function saveAccountLocale(value: string | null): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch('/api/me/locale', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ locale: value || null }),
    });
  } catch (err) {
    throw new Error(`Network error: ${(err as Error).message}`);
  }
  const body = await response.json().catch(() => ({})) as { locale?: string | null; error?: string };
  if (!response.ok) throw new Error(body.error || 'Failed to save.');
  const saved = body.locale || null;
  if (typeof App !== 'undefined' && App?.user) App.user.locale = saved;
  if (typeof AppView !== 'undefined') {
    try { AppView?.notifyLocaleChanged?.(saved); } catch { /* a frame that is gone */ }
  }
  const settings = (window as unknown as { Settings?: ShellSettings }).Settings;
  if (settings?.state) settings.state.locale = saved;
  settings?._renderLanguageSection?.();
  return saved;
}
