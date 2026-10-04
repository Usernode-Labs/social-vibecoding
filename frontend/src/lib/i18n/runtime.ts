import { createInstance, type TOptions } from 'i18next';
import { initReactI18next } from 'react-i18next';
import catalogs from './catalogs.generated.json';
import { languageDirection, resolveLanguage, type Language } from './locale';

export const i18n = createInstance();
// Hydrate the English build-time document synchronously. Activation happens
// after hydration, before the route is revealed; never translate hydrated DOM
// behind React's back, and never rebuild a form just to change its labels.
void i18n.use(initReactI18next).init({
  lng: 'en', fallbackLng: 'en', load: 'currentOnly',
  supportedLngs: Object.keys(catalogs.languages),
  ns: catalogs.namespaces, defaultNS: 'core', keySeparator: false,
  resources: { en: catalogs.english }, initAsync: false,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

type Pack = { url: string; hash: string };
const manifest = catalogs.manifest as Record<Language, Record<string, Pack>>;
const requests = new Map<string, Promise<void>>();
const requestedNamespaces = new Set<string>(['core']);
let activeLanguage: Language = 'en';
let preference: string | null = null;
let switchId = 0;
let saveQueue: Promise<void> = Promise.resolve();
const DEVICE_KEY = 'homeroom:language:device';
const ACCOUNT_KEY = 'homeroom:language:account';

function readPreference(key: string): string | null {
  try { return localStorage.getItem(key) || null; } catch { return null; }
}
function savePreference(key: string, value: string | null) {
  try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } catch { /* private mode */ }
}
function deviceLanguages(): readonly string[] {
  return typeof navigator === 'undefined' ? [] : navigator.languages || [navigator.language];
}

async function fetchPack(language: Language, namespace: string): Promise<void> {
  if (i18n.hasResourceBundle(language, namespace)) return;
  const entry = manifest[language]?.[namespace];
  if (!entry) throw new Error('Unknown language pack');
  const key = `${language}:${namespace}`;
  const inFlight = requests.get(key);
  if (inFlight) return inFlight;
  const request = (async () => {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(entry.url, { credentials: 'same-origin', signal: controller.signal, redirect: 'error' });
      if (!response.ok) throw new Error('Language pack unavailable');
      const bytes = await response.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      if (actual !== entry.hash) throw new Error('Language pack version mismatch');
      const messages = JSON.parse(new TextDecoder().decode(bytes));
      if (!messages || Array.isArray(messages) || typeof messages !== 'object'
          || Object.values(messages).some(value => typeof value !== 'string')) throw new Error('Invalid language pack');
      i18n.addResourceBundle(language, namespace, messages, true, true);
    } finally { clearTimeout(deadline); }
  })();
  requests.set(key, request);
  try { await request; } finally { requests.delete(key); }
}

export function getLanguage(): Language { return activeLanguage; }
export function getPreference(): string | null { return preference; }
export function t(key: string, options?: TOptions): string { return String(i18n.t(key, options)); }
/** HTML-building legacy owners must not receive unescaped user parameters. */
export function htmlText(key: string, options?: TOptions): string {
  return t(key, options).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]!));
}

export async function ensureNamespace(namespace: string): Promise<void> {
  if (!catalogs.namespaces.includes(namespace)) throw new Error('Unknown translation namespace');
  requestedNamespaces.add(namespace);
  const language = activeLanguage;
  await fetchPack(language, namespace);
  // A navigation may race a switch. Supply the namespace to the new language
  // too, rather than revealing the English fallback on that route.
  if (language !== activeLanguage) await fetchPack(activeLanguage, namespace);
}

export async function prepareLanguage(value: string | null): Promise<Language> {
  const language = resolveLanguage(value, deviceLanguages());
  let seen = 0;
  while (seen !== requestedNamespaces.size) {
    const namespaces = [...requestedNamespaces];
    seen = namespaces.length;
    await Promise.all(namespaces.map(namespace => fetchPack(language, namespace)));
  }
  return language;
}

async function activate(language: Language, value: string | null): Promise<void> {
  activeLanguage = language;
  preference = value;
  await i18n.changeLanguage(language);
  if (typeof document !== 'undefined') {
    document.documentElement.lang = language;
    document.documentElement.dir = languageDirection(language);
    document.dispatchEvent(new CustomEvent('homeroom:language-changed', { detail: { language, preference: value } }));
  }
}

/** Load first, save next, activate last. A failed save leaves the UI intact. */
export async function changeLanguage(value: string | null, save?: (value: string | null) => Promise<void>): Promise<boolean> {
  const id = ++switchId;
  const language = await prepareLanguage(value);
  if (id !== switchId) return false;
  if (save) {
    // Serialize writes as well as guarding activation: a slow old HTTP save
    // must not overwrite the newest account preference on the server.
    const operation = saveQueue.catch(() => {}).then(async () => {
      if (id === switchId) await save(value);
    });
    saveQueue = operation;
    await operation;
  }
  if (id !== switchId) return false;
  savePreference(save ? ACCOUNT_KEY : DEVICE_KEY, value);
  await activate(language, value);
  return true;
}

export async function useAccountLanguage(user: { locale?: string | null } | null): Promise<void> {
  const value = user ? user.locale || null : readPreference(DEVICE_KEY);
  if (!user) savePreference(ACCOUNT_KEY, null);
  const expectedSwitch = ++switchId;
  try {
    const language = await prepareLanguage(value);
    if (expectedSwitch !== switchId) return;
    await activate(language, value);
    if (user) savePreference(ACCOUNT_KEY, value);
  } catch {
    // English is an explicitly permitted recovery language. Never leave boot
    // hidden or break sign-in because a catalog request failed.
    if (switchId === expectedSwitch) await activate('en', value);
  } finally {
    if (typeof document !== 'undefined' && switchId === expectedSwitch) {
      requestAnimationFrame(() => document.documentElement.removeAttribute('data-language-loading'));
    }
  }
}

if (typeof window !== 'undefined') {
  (window as unknown as { PlatformI18n: unknown }).PlatformI18n = {
    t, htmlText, getLanguage, getPreference, prepareLanguage, changeLanguage, ensureNamespace, useAccountLanguage,
  };
  document.addEventListener('sv:session', event => {
    void useAccountLanguage((event as CustomEvent).detail?.user || null);
  });
}
