/** What the build hands the runtime (scripts/language-packs.js). */
export type Catalogs = {
  /** Shipped languages and their own names, from frontend/locales/config.json. */
  languages: Record<string, string>;
  namespaces: string[];
  /** The bundled English messages, per namespace. */
  english: Record<string, Record<string, string>>;
  /** Where each other language's pack is, and the SHA-256 of its bytes. */
  manifest: Record<string, Record<string, { url: string; hash: string }>>;
};

/** Match before fetching: es-MX needs es, never a failed es-MX request. */
export function matchLanguage(value: unknown, shipped: readonly string[]): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  let tag: string;
  try { tag = Intl.getCanonicalLocales(value.trim().replace(/_/g, '-'))[0]; } catch { return null; }
  if (shipped.includes(tag)) return tag;
  const [base, ...rest] = tag.split('-');
  if (base === 'zh') {
    // The script decides, then the region: zh-Hant-HK and zh-TW both read
    // Traditional. A reader of one script is not handed the other.
    const traditional = rest.includes('Hant')
      || (!rest.includes('Hans') && rest.some((part) => ['TW', 'HK', 'MO'].includes(part)));
    const wanted = traditional ? 'zh-TW' : 'zh-CN';
    return shipped.includes(wanted) ? wanted : null;
  }
  if (shipped.includes(base)) return base;
  // pt-PT reads pt-BR when that is the Portuguese that ships.
  return shipped.find((language) => language.split('-')[0] === base) ?? null;
}

/**
 * The language to show. A saved preference wins when it is shipped; otherwise
 * the device's languages are tried in order, then English. `auto` says the
 * person did not choose the result themselves.
 */
export function resolveLanguage(
  preference: unknown,
  deviceLanguages: readonly string[],
  shipped: readonly string[],
): { language: string; auto: boolean } {
  const explicit = matchLanguage(preference, shipped);
  if (explicit) return { language: explicit, auto: false };
  for (const value of deviceLanguages) {
    const match = matchLanguage(value, shipped);
    if (match) return { language: match, auto: true };
  }
  return { language: 'en', auto: true };
}
