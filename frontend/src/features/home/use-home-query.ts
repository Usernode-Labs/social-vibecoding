/**
 * The search on Home, for the sections React draws (One Home, #6361).
 *
 * The field itself is #home-search-input, wired by Home._wireSearch
 * (./home.js), which filters the apps grid. Pinned communities and
 * Communities to join read the same words from the field's own `input`
 * events, so one search covers apps and communities without a second owner
 * of the field.
 */
import { useEffect, useState } from 'react';

export function useHomeQuery(): string {
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const read = (event: Event) => {
      const el = event.target as HTMLInputElement | null;
      if (el && el.id === 'home-search-input') setQuery(String(el.value || ''));
    };
    const clear = (event: Event) => {
      const el = event.target as HTMLElement | null;
      if (el && el.id === 'home-search-clear') setQuery('');
    };
    document.addEventListener('input', read);
    document.addEventListener('click', clear);
    const now = document.getElementById('home-search-input') as HTMLInputElement | null;
    if (now && now.value) setQuery(now.value);
    return () => {
      document.removeEventListener('input', read);
      document.removeEventListener('click', clear);
    };
  }, []);
  return query.trim();
}

/** Does a community's name or slug match the search? */
export function matchesQuery(query: string, ...fields: Array<string | null | undefined>): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return fields.some((f) => typeof f === 'string' && f.toLowerCase().includes(q));
}
