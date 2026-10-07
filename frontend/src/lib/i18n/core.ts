import { createInstance, type TOptions } from 'i18next';
import { sha256 } from '@noble/hashes/sha2.js';
import { resolveLanguage, type Catalogs } from './locale';

/**
 * The language runtime, built from one set of catalogs.
 *
 * ./runtime.ts makes the shell's single instance from the build's catalogs;
 * tests make their own from fixture catalogs, which is how a language other
 * than English is exercised while only English ships.
 *
 * English is bundled and is always the fallback: a message a pack does not
 * carry (missing, out of date or malformed at build time) renders in English
 * on its own, and so does everything when a pack cannot be loaded.
 */

/** The notice shown once when the language was picked automatically. */
export type LanguageNotice = { language: string; name: string };
type Save = (value: string | null) => Promise<void>;

// A choice made on this device while signed out ("Switch to English").
const DEVICE_KEY = 'homeroom:language:device';
// Set once the automatic-language notice has been shown on this device.
const NOTICE_KEY = 'homeroom:language:auto-notice';
const PACK_TIMEOUT_MS = 8000;
const RETRY_AFTER_MS = 10000;

function readStored(key: string): string | null {
  try { return localStorage.getItem(key) || null; } catch { return null; }
}
function writeStored(key: string, value: string | null) {
  try {
    if (value) localStorage.setItem(key, value); else localStorage.removeItem(key);
  } catch { /* private mode: the choice lasts for this page */ }
}
function deviceLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language].filter(Boolean);
}

export function createLanguageRuntime(catalogs: Catalogs) {
  const shipped = Object.keys(catalogs.languages);
  const i18n = createInstance();
  // Hydrate the English build-time document synchronously. A language is
  // activated after hydration; hydrated DOM is never translated behind
  // React's back, and a form is never rebuilt just to change its labels.
  void i18n.init({
    lng: 'en', fallbackLng: 'en', load: 'currentOnly',
    supportedLngs: shipped,
    ns: catalogs.namespaces, defaultNS: 'core', keySeparator: false,
    resources: { en: catalogs.english }, initAsync: false,
    interpolation: { escapeValue: false },
    react: { useSuspense: false, bindI18n: 'languageChanged loaded', bindI18nStore: 'added' },
  });

  const requests = new Map<string, Promise<void>>();
  const requestedNamespaces = new Set<string>(['core']);
  const scheduled = new Set<string>();
  const retryAfter = new Map<string, number>();
  const noticeListeners = new Set<() => void>();
  let activeLanguage = 'en';
  let preference: string | null = null;
  let signedIn = false;
  let notice: LanguageNotice | null = null;
  let switchId = 0;
  let saveQueue: Promise<void> = Promise.resolve();

  function languageName(language: string): string {
    if (catalogs.languages[language]) return catalogs.languages[language];
    try {
      return new Intl.DisplayNames([language], { type: 'language' }).of(language) || language;
    } catch { return language; }
  }

  async function fetchPack(language: string, namespace: string): Promise<void> {
    if (language === 'en' || i18n.hasResourceBundle(language, namespace)) return;
    const entry = catalogs.manifest[language]?.[namespace];
    if (!entry) throw new Error('Unknown language pack');
    const key = `${language}:${namespace}`;
    const inFlight = requests.get(key);
    if (inFlight) return inFlight;
    const request = (async () => {
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), PACK_TIMEOUT_MS);
      try {
        const response = await fetch(entry.url, {
          credentials: 'same-origin', signal: controller.signal, redirect: 'error',
        });
        if (!response.ok) throw new Error('Language pack unavailable');
        const bytes = await response.arrayBuffer();
        // HTTP previews and self-hosted installations do not expose
        // SubtleCrypto. The exact bytes are still verified there; integrity
        // is never skipped.
        const subtle = globalThis.crypto?.subtle;
        const digest = subtle
          ? await subtle.digest('SHA-256', bytes)
          : sha256(new Uint8Array(bytes));
        const actual = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
        if (actual !== entry.hash) throw new Error('Language pack does not match this build');
        const messages = JSON.parse(new TextDecoder().decode(bytes));
        if (!messages || Array.isArray(messages) || typeof messages !== 'object'
            || Object.values(messages).some((value) => typeof value !== 'string')) {
          throw new Error('Invalid language pack');
        }
        i18n.addResourceBundle(language, namespace, messages, true, true, { silent: language !== activeLanguage });
      } finally { clearTimeout(deadline); }
    })();
    requests.set(key, request);
    try { await request; } finally { requests.delete(key); }
  }

  async function ensureNamespace(namespace: string): Promise<void> {
    if (!catalogs.namespaces.includes(namespace)) throw new Error('Unknown message namespace');
    requestedNamespaces.add(namespace);
    const language = activeLanguage;
    await fetchPack(language, namespace);
    // A navigation may race a switch. Supply the namespace to the new
    // language too, rather than leaving that screen in English.
    if (language !== activeLanguage) await fetchPack(activeLanguage, namespace);
  }

  /** Called by every reader, so a screen's pack is fetched when it first renders. */
  function registerNamespace(namespace: string): void {
    if (!catalogs.namespaces.includes(namespace)) return;
    requestedNamespaces.add(namespace);
    if (activeLanguage === 'en' || typeof document === 'undefined'
        || i18n.hasResourceBundle(activeLanguage, namespace) || scheduled.has(namespace)) return;
    const key = `${activeLanguage}:${namespace}`;
    if ((retryAfter.get(key) || 0) > Date.now()) return;
    scheduled.add(namespace);
    queueMicrotask(() => {
      void ensureNamespace(namespace)
        .catch(() => { retryAfter.set(key, Date.now() + RETRY_AFTER_MS); })
        .finally(() => scheduled.delete(namespace));
    });
  }

  function t(key: string, options?: TOptions): string {
    registerNamespace(key.includes(':') ? key.split(':')[0] : 'core');
    return String(i18n.t(key, options));
  }

  /** HTML-building legacy owners must not receive unescaped user parameters. */
  function htmlText(key: string, options?: TOptions): string {
    return t(key, options).replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[character]!));
  }

  async function prepareLanguage(value: string | null): Promise<{ language: string; auto: boolean }> {
    const resolved = resolveLanguage(value, deviceLanguages(), shipped);
    let seen = 0;
    // A screen may register a namespace while these load.
    while (seen !== requestedNamespaces.size) {
      const namespaces = [...requestedNamespaces];
      seen = namespaces.length;
      await Promise.all(namespaces.map((namespace) => fetchPack(resolved.language, namespace)));
    }
    return resolved;
  }

  function setNotice(next: LanguageNotice | null) {
    if (notice === next) return;
    notice = next;
    for (const listener of noticeListeners) listener();
  }

  async function activate(language: string, value: string | null, auto: boolean): Promise<void> {
    const changed = activeLanguage !== language;
    activeLanguage = language;
    preference = value;
    await i18n.changeLanguage(language);
    if (typeof document !== 'undefined') {
      if (document.documentElement.lang !== language) document.documentElement.lang = language;
      if (changed) {
        document.dispatchEvent(new CustomEvent('homeroom:language-changed', { detail: { language, preference: value } }));
      }
    }
    // Once per device, the first time the language was picked for the person
    // rather than by them. Shown, it is spent, whatever they do with it.
    if (auto && language !== 'en') {
      if (!readStored(NOTICE_KEY)) {
        writeStored(NOTICE_KEY, language);
        setNotice({ language, name: languageName(language) });
      }
    } else {
      setNotice(null);
    }
  }

  /**
   * Load first, save next, activate last. A failed load or save rejects and
   * leaves the screen as it was. Resolves false when a newer change replaced
   * this one.
   */
  async function changeLanguage(value: string | null, save?: Save): Promise<boolean> {
    const id = ++switchId;
    const { language, auto } = await prepareLanguage(value);
    if (id !== switchId) return false;
    if (save) {
      // Serialize writes as well as guarding activation: a slow old save
      // must not overwrite the newest account preference on the server.
      const operation = saveQueue.catch(() => {}).then(async () => {
        if (id === switchId) await save(value);
      });
      saveQueue = operation;
      await operation;
    }
    if (id !== switchId) return false;
    // An account choice replaces one made on this device while signed out.
    writeStored(DEVICE_KEY, save ? null : value);
    await activate(language, value, auto);
    return true;
  }

  /** The session resolved: `user` signed in, or null for the sign-in screens. */
  async function applySessionLanguage(user: { locale?: string | null } | null): Promise<void> {
    signedIn = !!user;
    const value = user?.locale || readStored(DEVICE_KEY);
    const id = ++switchId;
    try {
      const { language, auto } = await prepareLanguage(value);
      if (id === switchId) await activate(language, value, auto);
    } catch {
      // English is always available. A pack that cannot be loaded never
      // leaves sign-in or the shell without text.
      if (id === switchId) await activate('en', value, false);
    }
  }

  return {
    i18n,
    t,
    htmlText,
    languageName,
    registerNamespace,
    ensureNamespace,
    changeLanguage,
    applySessionLanguage,
    getLanguage: () => activeLanguage,
    getPreference: () => preference,
    isSignedIn: () => signedIn,
    getNotice: () => notice,
    subscribeNotice(listener: () => void) {
      noticeListeners.add(listener);
      return () => { noticeListeners.delete(listener); };
    },
    dismissNotice: () => setNotice(null),
  };
}

export type LanguageRuntime = ReturnType<typeof createLanguageRuntime>;
