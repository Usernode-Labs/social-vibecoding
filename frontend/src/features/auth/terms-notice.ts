/**
 * The sign-on screens' passive terms notice (#3801).
 *
 * One short legal foot line on the password sign-in, email-code and
 * activation-code registration screens — "By signing in you agree to the
 * Terms and conditions" — in place of the first-run popup: completing a
 * sign-in on those screens IS the consent, and the gate
 * (features/settings/terms-first-run.js) records it silently through the
 * sheet's own endpoint. This module holds the sentence's words, its two
 * class strings, and the hook that resolves the published terms' web
 * address; both screens render the same line from it, so the words and
 * the look cannot drift apart.
 *
 * Its own module rather than ./shared.ts: shared.ts is executed in test
 * VMs whose import allowlists are closed (tests/session-mint-stale-
 * recovery.test.js, tests/native-session-handoff.test.js), and this hook
 * needs react.
 */

import { useEffect, useState } from 'react';

/**
 * The notice's exact words, one copy for both sign-on screens so the
 * sentence cannot drift between them. The trailing period is spelled at
 * the call site (after the link expression), per the screens' existing
 * string-expression idiom.
 */
export const TERMS_NOTICE_LEAD = 'By signing in you agree to the ';
export const TERMS_NOTICE_LINK_TEXT = 'Terms and conditions';

/**
 * The notice's two class strings, one spelling for both screens: the
 * sentence's muted 14px body at the `mt-2.5` seam (the one the pill-link
 * wraps use), and the link in the same violet underline as the login
 * screen's "Settings → Change password" anchor. Complete literals —
 * Tailwind's extractor is a regex over source text.
 */
export const TERMS_NOTICE = 'mt-2.5 text-sm text-zinc-500 dark:text-zinc-400';
export const TERMS_NOTICE_LINK =
  'text-violet-700 hover:text-violet-400 underline dark:text-violet-400';

/** GET /api/public/terms/current as the route answers it (src/routes/public-api.js). */
interface PublicTermsCurrent {
  success?: boolean;
  data?: { terms_link?: unknown };
}

/**
 * The published terms' web address for this document. `undefined` until the
 * one fetch has landed; null afterwards means "no link to give" (nothing
 * published, no link on the version, or the read failed) and the notice
 * renders as plain text.
 */
let termsNoticeLink: string | null | undefined;

/**
 * The notice line's link, or null for plain text.
 *
 * Fetched ONCE per document from the public read-only GET — a signed-out
 * visitor cannot call the session-authed /challenges-api/terms/current
 * twin, and both sign-on screens share the module-level cache so a trip
 * from #login to #signup costs nothing further. The fetch is in an effect,
 * never in initial render (the island rule): the first render draws the
 * plain-text sentence, and a resolved link re-renders it with the anchor.
 * A 404, a missing/null link, or any failure all resolve to null.
 */
export function useTermsNoticeLink(): string | null {
  const [link, setLink] = useState<string | null>(null);
  useEffect(() => {
    if (termsNoticeLink !== undefined) {
      setLink(termsNoticeLink);
      return;
    }
    let live = true;
    void (async () => {
      let resolved: string | null = null;
      try {
        const res = await fetch('/api/public/terms/current');
        const body: PublicTermsCurrent | null = res.ok
          ? await res.json().catch(() => null)
          : null;
        const value = body?.data?.terms_link;
        resolved = typeof value === 'string' && value ? value : null;
      } catch {
        resolved = null;
      }
      termsNoticeLink = resolved;
      if (live) setLink(resolved);
    })();
    return () => { live = false; };
  }, []);
  return link;
}
