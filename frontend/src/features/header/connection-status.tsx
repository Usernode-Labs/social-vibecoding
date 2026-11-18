/**
 * `#connection-status`: the header's word on the connection, where native
 * apps put it (the native-offline proposal, 18 Nov 2026).
 *
 * Telegram and WhatsApp say "Waiting for network…" or "Connecting…" in the
 * title bar; Threema hangs a thin stripe under it. Homeroom used to lay a
 * full-width amber strip across the top of every screen ("Reconnecting to
 * Homeroom. Showing saved content"), and screens repeated it in their own
 * notes, three at once on Messages. This replaces all of them: a small
 * neutral pill hanging from the header's lower edge, over the top of the
 * screen, saying
 *
 *   - "Connecting…" while Homeroom does not answer,
 *   - "No internet" when the phone itself has none,
 *   - "Updating Homeroom..." for a planned restart,
 *
 * and, beside it, how old the screen is when it was drawn from what the phone
 * saved ("Updated 12:41", lib/freshness.ts). It is never red: being offline
 * is a condition, not an error. lib/offline.ts holds it up for a while once
 * shown, so a patchy link does not make it flicker.
 *
 * ── Hydration ──────────────────────────────────────────────────────────
 *
 * The prerender ships it hidden with the "Connecting…" words, and the first
 * client render must match that exactly even when a `?shot=offline` link
 * pinned the offline state before hydration. So it shows nothing of the
 * state until it has mounted, and `hidden` is applied through a ref
 * (lib/legacy-dom.ts), never through a re-rendered className.
 */

import { useEffect, useRef, useState } from 'react';

import { connectionStatusStore } from '../../lib/offline';
import { freshnessStore, savedAtLabel, showsAge } from '../../lib/freshness';
import { useMessages } from '../../lib/i18n/react';
import { useHiddenClass } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';

/** How often a shown age is looked at again, so "Updated" appears once the copy is old enough. */
const AGE_TICK_MS = 30_000;

export function ConnectionStatus() {
  const t = useMessages();
  const ref = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const { status } = useStoreState(connectionStatusStore);
  const { savedAt } = useStoreState(freshnessStore);
  const shown = mounted && status !== 'online';

  useEffect(() => { setMounted(true); }, []);
  useEffect(() => {
    if (!shown) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => clearInterval(timer);
  }, [shown, savedAt]);
  useHiddenClass(ref, !shown);

  const words = !mounted || status === 'connecting' || status === 'online'
    ? t('core:status.connecting')
    : status === 'no-internet' ? t('core:status.noInternet') : t('core:banner.restart.text');
  const age = shown && status !== 'updating' && savedAt !== null && showsAge(savedAt, now)
    ? t('core:status.updatedAt', { time: savedAtLabel(savedAt, now) })
    : null;

  return (
    <div
      ref={ref}
      id="connection-status"
      role="status"
      aria-live="polite"
      data-status={mounted ? status : 'online'}
      className="connection-status hidden pointer-events-none absolute left-1/2 top-full z-20 mt-1.5 -translate-x-1/2
                 inline-flex max-w-[calc(100vw-2rem)] items-center gap-1.5 whitespace-nowrap rounded-full
                 bg-zinc-800/90 px-3 py-1 text-xs font-medium text-white shadow-sm
                 dark:bg-zinc-100/90 dark:text-zinc-900"
    >
      <span className="connection-status-dot h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-70" aria-hidden="true" />
      <span className="connection-status-words truncate">{words}</span>
      {age ? <span className="connection-status-age shrink-0 opacity-70">{age}</span> : null}
    </div>
  );
}
