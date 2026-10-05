import { createInstance, type TOptions } from 'i18next';
import catalogs from './catalogs.generated.json';
import { languageDirection, resolveLanguage, type Language } from './locale';

// Same plain store used by visibility-store.ts; keeping the reader independent
// of React also lets the public authorization pages use this runtime.
function getVisibilityStore(): { visible: Record<string, boolean>; listeners: Set<() => void> } {
  const host = globalThis as unknown as { __usernodeVisibility?: { visible: Record<string, boolean>; listeners: Set<() => void> } };
  return host.__usernodeVisibility ||= { visible: Object.create(null), listeners: new Set() };
}

export const i18n = createInstance();
// Hydrate the English build-time document synchronously. Activation happens
// after hydration, before the route is revealed; never translate hydrated DOM
// behind React's back, and never rebuild a form just to change its labels.
void i18n.init({
  lng: 'en', fallbackLng: 'en', load: 'currentOnly',
  supportedLngs: Object.keys(catalogs.languages),
  ns: catalogs.namespaces, defaultNS: 'core', keySeparator: false,
  resources: { en: catalogs.english }, initAsync: false,
  interpolation: { escapeValue: false },
  react: { useSuspense: false, bindI18n: 'languageChanged loaded', bindI18nStore: 'added' },
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
      i18n.addResourceBundle(language, namespace, messages, true, true, { silent: language !== activeLanguage });
    } finally { clearTimeout(deadline); }
  })();
  requests.set(key, request);
  try { await request; } finally { requests.delete(key); }
}

export function getLanguage(): Language { return activeLanguage; }
export function getPreference(): string | null { return preference; }
/** Keep the familiar compact English stamp; other languages use CLDR grammar. */
export function relativeTime(value: number, unit: 'minute' | 'hour' | 'day'): string {
  if (activeLanguage === 'en') return `${Math.abs(value)}${{ minute: 'm', hour: 'h', day: 'd' }[unit]} ago`;
  return new Intl.RelativeTimeFormat(activeLanguage, { style: 'short', numeric: 'always' }).format(value, unit);
}
const scheduledNamespaces = new Set<string>();
const retryAfter = new Map<string, number>();
export function registerNamespace(namespace: string): void {
  if (!catalogs.namespaces.includes(namespace)) return;
  requestedNamespaces.add(namespace);
  if (typeof document === 'undefined' || i18n.hasResourceBundle(activeLanguage, namespace)
      || scheduledNamespaces.has(namespace)) return;
  const key = `${activeLanguage}:${namespace}`;
  if ((retryAfter.get(key) || 0) > Date.now()) return;
  scheduledNamespaces.add(namespace);
  queueMicrotask(() => {
    void ensureNamespace(namespace).catch(() => {
      retryAfter.set(key, Date.now() + 10000);
      document.dispatchEvent(new CustomEvent('homeroom:language-pack-unavailable', { detail: { namespace } }));
    }).finally(() => scheduledNamespaces.delete(namespace));
  });
}
export function t(key: string, options?: TOptions): string {
  registerNamespace(key.includes(':') ? key.split(':')[0] : 'core');
  return String(i18n.t(key, options));
}
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
  const changed = activeLanguage !== language;
  activeLanguage = language;
  preference = value;
  await i18n.changeLanguage(language);
  if (typeof document !== 'undefined') {
    try {
      document.cookie = `homeroom_language=${encodeURIComponent(language)}; Path=/; Max-Age=31536000; SameSite=Lax${typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : ''}`;
    } catch { /* Language switching still works when cookies are unavailable. */ }
    document.documentElement.lang = language;
    document.documentElement.dir = languageDirection(language);
    if (changed) document.dispatchEvent(new CustomEvent('homeroom:language-changed', { detail: { language, preference: value } }));
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
  savePreference(save ? ACCOUNT_KEY : DEVICE_KEY, save ? value || 'auto' : value);
  await activate(language, value);
  return true;
}

export async function useAccountLanguage(user: { locale?: string | null } | null): Promise<void> {
  requestedNamespaces.add(user ? 'account' : 'auth');
  requestedNamespaces.add('apps');
  requestVisibleNamespaces();
  const value = user ? user.locale || null : readPreference(DEVICE_KEY);
  if (!user) savePreference(ACCOUNT_KEY, null);
  const expectedSwitch = ++switchId;
  try {
    const language = await prepareLanguage(value);
    if (expectedSwitch !== switchId) return;
    await activate(language, value);
    if (user) savePreference(ACCOUNT_KEY, value || 'auto');
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

function requestVisibleNamespaces(): void {
  const mapping: Record<string, string> = {
    'app-view': 'workshop', 'settings-screen': 'settings', 'messages-screen': 'community',
    'global-chat-screen': 'community', 'agent-session-screen': 'workshop',
    'workshop-screen': 'workshop', 'dev-screen': 'workshop',
    'profile-proposals-screen': 'workshop', 'profile-screen': 'account',
    'home-screen': 'apps', 'browse-screen': 'apps', 'leaderboard-screen': 'apps',
  };
  for (const [screen, visible] of Object.entries(getVisibilityStore().visible)) {
    if (!visible) continue;
    const namespace = screen.startsWith('auth-') ? 'auth' : mapping[screen];
    if (namespace) {
      requestedNamespaces.add(namespace);
      // English recovery is available offline. A later visit retries a failed
      // pack; no unsuccessful request is stored as a completed load.
      void ensureNamespace(namespace).catch(() => {});
    }
  }
}

(globalThis as unknown as { PlatformI18n: unknown }).PlatformI18n = {
  t, htmlText, getLanguage, getPreference, relativeTime, prepareLanguage, changeLanguage, ensureNamespace, useAccountLanguage,
};

if (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('sv:session', event => {
    void useAccountLanguage((event as CustomEvent).detail?.user || null);
  });
  getVisibilityStore().listeners.add(requestVisibleNamespaces);
}
