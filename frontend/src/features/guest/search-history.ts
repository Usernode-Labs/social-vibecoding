const KEY = 'homeroomGuestSearch';
const MAX_QUERY = 1000;

/** History entries are external input; restore only a bounded string. */
export function guestSearchFrom(state: unknown): string {
  if (!state || typeof state !== 'object') return '';
  const query = (state as Record<string, unknown>)[KEY];
  return typeof query === 'string' && query.length <= MAX_QUERY ? query : '';
}

export function withGuestSearch(state: unknown, query: string): Record<string, unknown> {
  return { ...(state && typeof state === 'object' ? state : {}), [KEY]: query.length <= MAX_QUERY ? query : '' };
}
