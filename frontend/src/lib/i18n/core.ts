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
/** A choice that has been saved and is owed to the screen. */
type Commit = { id: number; language: string; value: string | null; auto: boolean };

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
  // How a choice reaches the screen, and what keeps the two from parting:
  //   switchId   the newest attempt. An older one that has not saved yet
  //              gives way to it.
  //   committed  the newest choice that WAS saved and is not on screen yet.
  //   inFlight   attempts that have not finished. While one is, it may still
  //              replace `committed`; once none is, settle() shows it.
  //   shownId    the attempt whose choice is on screen.
  //   epoch      moves on when the person does (sign-out, another account), so
  //              a choice still being saved for the last one is not shown here.
  let switchId = 0;
  let committed: Commit | null = null;
  let inFlight = 0;
  let shownId = 0;
  let epoch = 0;
  let account: string | null = null;
  let saveQueue: Promise<unknown> = Promise.resolve();

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
    const requested = requests.get(key);
    if (requested) return requested;
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
        const showing = language === activeLanguage;
        i18n.addResourceBundle(language, namespace, messages, true, true, { silent: !showing });
        // React readers hear the store. A legacy reader repaints on this
        // event, and its first read of this namespace was English: tell it the
        // text for the language on screen is here. A pack loaded ahead of a
        // switch is announced by the switch itself (activate), once.
        if (showing) announce(namespace);
      } finally { clearTimeout(deadline); }
    })();
    requests.set(key, request);
    try { await request; } finally { requests.delete(key); }
  }

  /** What legacy modules repaint on: the language switched, or its text arrived. */
  function announce(namespace?: string): void {
    if (typeof document === 'undefined') return;
    document.dispatchEvent(new CustomEvent('homeroom:language-changed', {
      detail: { language: activeLanguage, preference, ...(namespace ? { namespace } : {}) },
    }));
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
    if (typeof document !== 'undefined' && document.documentElement.lang !== language) {
      document.documentElement.lang = language;
    }
    if (changed) announce();
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
   * The screen follows the last choice that was saved. An attempt that ends,
   * whether it saved, lost or failed, calls this: while a newer attempt is
   * still on its way that one decides, and once none is, whatever was saved
   * last goes on screen. So a newer choice that fails after an older one was
   * saved cannot leave the screen showing something the account does not hold.
   */
  async function settle(): Promise<void> {
    inFlight -= 1;
    if (inFlight > 0 || !committed) return;
    const next = committed;
    committed = null;
    shownId = next.id;
    await activate(next.language, next.value, next.auto);
  }

  /**
   * Load first, save next, activate last. A failed load or save rejects, and
   * the screen is left as it was or, if an earlier choice had been saved
   * meanwhile, on that one. Resolves true when this choice is what the screen
   * shows; false when a newer attempt took over.
   */
  async function changeLanguage(value: string | null, save?: Save): Promise<boolean> {
    const id = ++switchId;
    const startedIn = epoch;
    inFlight += 1;
    try {
      const { language, auto } = await prepareLanguage(value);
      if (id !== switchId) return false;
      if (save) {
        // Writes are serialized, so a slow old save can never overwrite the
        // newest account preference, and one that is no longer the newest
        // when its turn comes is not sent at all.
        const operation = saveQueue.catch(() => {}).then(async () => {
          if (id !== switchId) return false;
          await save(value);
          return true;
        });
        saveQueue = operation;
        if (!(await operation)) return false;
      }
      // Saved for someone who has since signed out or changed account.
      if (startedIn !== epoch) return false;
      // An account choice replaces one made on this device while signed out.
      writeStored(DEVICE_KEY, save ? null : value);
      committed = { id, language, value, auto };
    } finally {
      await settle();
    }
    return shownId === id;
  }

  /** The session resolved: `user` signed in, or null for the sign-in screens. */
  async function applySessionLanguage(user: { id?: string | number; locale?: string | null } | null): Promise<void> {
    const next = user ? String(user.id ?? '') : null;
    if (next !== account) {
      account = next;
      epoch += 1;
      committed = null;
    }
    signedIn = !!user;
    const value = user?.locale || readStored(DEVICE_KEY);
    const id = ++switchId;
    inFlight += 1;
    try {
      let resolved: { language: string; auto: boolean };
      try {
        resolved = await prepareLanguage(value);
      } catch {
        // English is always available. A pack that cannot be loaded never
        // leaves sign-in or the shell without text.
        resolved = { language: 'en', auto: false };
      }
      if (id === switchId) {
        shownId = id;
        await activate(resolved.language, value, resolved.auto);
      }
    } finally {
      // A choice saved while this was loading is newer than what it read.
      await settle();
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
