import config from '../../../locales/config.json';

export const languageNames = Object.freeze(config.languages);
export type Language = keyof typeof config.languages;
export const languages = Object.keys(languageNames) as Language[];

/** Match before fetching: es-MX needs es, never a failed es-MX request. */
export function matchLanguage(value: unknown): Language | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  let tag: string;
  try { tag = Intl.getCanonicalLocales(value.trim().replace(/_/g, '-'))[0]; }
  catch { return null; }
  if (languages.includes(tag as Language)) return tag as Language;
  const parts = tag.split('-');
  const base = parts[0];
  if (base === 'zh') {
    if (parts.includes('Hant')) return 'zh-TW';
    if (parts.includes('Hans')) return 'zh-CN';
    return parts.some(part => ['TW', 'HK', 'MO'].includes(part)) ? 'zh-TW' : 'zh-CN';
  }
  if (base === 'pt') return 'pt-BR';
  return languages.includes(base as Language) ? base as Language : null;
}

/** null is Auto; it remains null when saved rather than becoming a language. */
export function resolveLanguage(preference: unknown, deviceLanguages: readonly string[] = []): Language {
  const explicit = matchLanguage(preference);
  if (explicit) return explicit;
  for (const value of deviceLanguages) {
    const match = matchLanguage(value);
    if (match) return match;
  }
  return 'en';
}

export function languageDirection(language: Language): 'rtl' | 'ltr' {
  return language === 'ar' ? 'rtl' : 'ltr';
}
