/**
 * A CHANNEL'S WAY BACK TO ITS HUB (#3407). A channel is a level inside its
 * community's hub (the hub's Channel card is its door), so its pane leads
 * with the same round chevron the hub's own pages (Needs you, the Workshop)
 * lead with. The header's arrow names the same place (store.ts channelHub);
 * this is the one in the page, where the reader already is.
 *
 * It is a door that says where it goes, so it lands on the hub itself, not
 * the tab that project page was last left on: AppView._landOnHub first, then
 * the hub's address (App._hubHref's spelling, the one Discover's rows follow).
 *
 * #general is the Homeroom community's channel, whose hub is the platform
 * project's. That slug is not known on a cold load: PlatformTarget.slug()
 * reads it off reads that may still be in flight (/api/version,
 * /api/platform/about), and neither publishes an event when it lands. So
 * the click reads it again when pressed (`backToPlatformHub`), and the
 * header's label waits on the lookup itself (`watchPlatformSlug`). Before
 * anything knows it, the way back is Communities.
 */

import { useEffect, useState } from 'react';

type PlatformTargetLike = {
  slug?: () => string | null;
  resolve?: () => Promise<unknown> | unknown;
};

function platformTarget(): PlatformTargetLike | undefined {
  return typeof window !== 'undefined'
    ? (window as unknown as { PlatformTarget?: PlatformTargetLike }).PlatformTarget
    : undefined;
}

/** The platform project's slug, if anything has said it yet. */
export function platformSlug(): string | null {
  try { return platformTarget()?.slug?.() || null; } catch { return null; }
}

/** Open `slug`'s hub, or Communities when there is no slug. */
export function openChannelHub(slug: string | null): void {
  const win = window as unknown as { AppView?: { _landOnHub?: (slug: string) => void } };
  if (slug) win.AppView?._landOnHub?.(slug);
  window.location.hash = slug ? `#app/${encodeURIComponent(slug)}/workshop` : '#communities';
}

/** #general's way back: the platform's hub, its slug read at press time. */
export function backToPlatformHub(): void {
  openChannelHub(platformSlug());
}

/**
 * Call `onSlug` with the platform's slug once the lookup that finds it has
 * settled (PlatformTarget.resolve, which is shared and asked once at a time).
 * Returns a cancel. A slug already known is handed over at once.
 */
export function watchPlatformSlug(onSlug: (slug: string | null) => void): () => void {
  let live = true;
  const now = platformSlug();
  if (now) {
    onSlug(now);
    return () => { live = false; };
  }
  let pending: Promise<unknown>;
  try { pending = Promise.resolve(platformTarget()?.resolve?.()); }
  catch { pending = Promise.resolve(); }
  pending.catch(() => null).then(() => { if (live) onSlug(platformSlug()); });
  return () => { live = false; };
}

/** The platform's slug for a header that needs it (`enabled`), kept current. */
export function usePlatformSlug(enabled: boolean): string | null {
  // Already known on a warm load; a header drawn only once a conversation
  // has loaded is never part of the shell's prerendered markup.
  const [slug, setSlug] = useState<string | null>(() => (enabled ? platformSlug() : null));
  useEffect(() => {
    if (!enabled) return undefined;
    return watchPlatformSlug(setSlug);
  }, [enabled]);
  return enabled ? slug : null;
}
