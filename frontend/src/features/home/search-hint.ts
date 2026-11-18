/**
 * The shortcut the search field's placeholder names, by the device.
 *
 * The field is focused by Ctrl+K, or Command+K on a Mac (./search-shortcut.ts).
 * A phone or a tablet has no such key to press, so its placeholder names
 * none. Which device this is cannot be known in the prerender, so the first
 * render names none and the hint arrives after mount: a placeholder that
 * gains a few words is quieter than one that swaps them.
 */
import { useEffect, useState } from 'react';

import { useMessages } from '../../lib/i18n/react';

export type SearchHint = 'none' | 'ctrl' | 'cmd';

/** What to name, from what the browser says of itself. */
export function searchHintFor(env: {
  /** The primary pointer is a finger (a phone, a tablet). */
  coarse: boolean;
  /** `navigator.userAgentData.platform`, else `navigator.platform`. */
  platform: string;
}): SearchHint {
  if (env.coarse) return 'none';
  return /mac/i.test(env.platform) ? 'cmd' : 'ctrl';
}

function detect(): SearchHint {
  try {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    return searchHintFor({
      coarse: !!window.matchMedia?.('(pointer: coarse)').matches,
      platform: nav.userAgentData?.platform || nav.platform || '',
    });
  } catch {
    return 'none';
  }
}

/** The hint for this device: 'none' on the first render, the device's own after mount. */
export function useSearchHint(): SearchHint {
  const [hint, setHint] = useState<SearchHint>('none');
  useEffect(() => { setHint(detect()); }, []);
  return hint;
}

/** Home's search placeholder, with this device's shortcut when it has one. */
export function useHomeSearchPlaceholder(): string {
  const t = useMessages('home');
  const hint = useSearchHint();
  // Whole literals, so the catalog inventory can see each id asked for.
  if (hint === 'cmd') return t('home:search.placeholderCmd');
  if (hint === 'ctrl') return t('home:search.placeholderCtrl');
  return t('home:search.placeholder');
}
