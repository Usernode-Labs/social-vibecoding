import catalogs from './catalogs.generated.json';
import { saveAccountLocale } from './account';
import { createLanguageRuntime } from './core';

/**
 * The shell's language runtime: ./core.ts built from this build's catalogs
 * (frontend/locales, through scripts/language-packs.js). Imported once by
 * main.tsx; frontend/locales/README.md says how to use it.
 */
const runtime = createLanguageRuntime(catalogs);

export const {
  i18n, t, htmlText, languageName, registerNamespace, ensureNamespace,
  changeLanguage, applySessionLanguage, getLanguage, getPreference,
  getNotice, subscribeNotice, dismissNotice,
} = runtime;

/** The languages Settings offers, in config order, with their own names. */
export const shippedLanguages: readonly { tag: string; name: string }[] = Object.freeze(
  Object.entries(catalogs.languages).map(([tag, name]) => ({ tag, name })),
);

/** The notice's way back: English, saved where this person's choice lives. */
export function switchToEnglish(): Promise<boolean> {
  return changeLanguage('en', runtime.isSignedIn()
    ? async (value) => { await saveAccountLocale(value); }
    : undefined);
}

// The legacy modules' adapter. Translate at render time, never at module
// initialization, and repaint on `homeroom:language-changed`.
(globalThis as unknown as { PlatformI18n: unknown }).PlatformI18n = {
  t, htmlText, languageName, getLanguage, getPreference, changeLanguage,
  applySessionLanguage, saveAccountLocale,
};

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  // Signed in. app.js reports the signed-out case itself (enterAnonymous).
  document.addEventListener('sv:session', (event) => {
    void applySessionLanguage((event as CustomEvent).detail?.user || null);
  });
}
