/**
 * N1 (newcomer run four, 13 Oct 2026): the first look on the maker's last
 * tour card, "Here's what Homeroom bot is making" (./tour-steps.ts
 * firstLookStep).
 *
 * The tour used to end by asking them to tap Open app on the hub, which the
 * hub does not show while a first version is on its way, and only Back
 * worked. Now it ends on the picture Homeroom bot drew of the app's main
 * screen from their answers (services/first-version-screens.js: the spec
 * saves it first, and it is drawn about a minute in), read as the App tab
 * reads it (GET /api/apps/:slug `first_version.screens`, an image only the
 * project's members can load). Until it is there the card says "Drawing
 * your screens…", and the picture is swapped in when it arrives: the card
 * asks again every FIRST_LOOK_POLL_MS. Done ends the tour either way.
 *
 * 15 Oct 2026: before its picture is saved, the drawn screen itself
 * (./drawn-look.tsx), in the same box, and the picture in its place once it
 * is in; the card asks again until then.
 */

import { useEffect, useState } from 'react';

import { SpinnerRingIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { DrawnLook, drawnLookUrl, isDrawnLook, ownSrc, useLookSwap } from './drawn-look';
import { madeAppUrl } from './made';

export const FIRST_LOOK_POLL_MS = 5000;

/** The screens a first version's picture may be (services/first-version-screens.js KINDS). */
export const SCREEN_KINDS: readonly string[] = ['first_look', 'real'];

/**
 * The picture to draw from GET /api/apps/:slug's answer: the first look (or,
 * once there are some, the first real screen), as the image's own URL, or
 * null while there is none. `kinds` narrows it: the hub's first look card
 * (../dev-board/workshop/hub-cards.tsx FirstLookCard) asks for the first
 * look alone. A first look that is only drawn so far (`drawn`, 15 Oct 2026)
 * is its drawn screen's document (./drawn-look.tsx isDrawnLook). Pure.
 */
export function firstLookSrc(body: unknown, slug: string, kinds: readonly string[] = SCREEN_KINDS): string | null {
  const app = body && typeof body === 'object' ? (body as { app?: unknown }).app : null;
  const fv = app && typeof app === 'object' ? (app as { first_version?: unknown }).first_version : null;
  const sc = fv && typeof fv === 'object' ? (fv as { screens?: unknown }).screens : null;
  if (!sc || typeof sc !== 'object') return null;
  const { kind, count, v, drawn } = sc as { kind?: unknown; count?: unknown; v?: unknown; drawn?: unknown };
  if (typeof kind !== 'string' || !kinds.includes(kind) || !SCREEN_KINDS.includes(kind)
    || !Number.isInteger(count) || (count as number) < 1 || !slug) return null;
  if (kind === 'first_look' && drawn === true) return drawnLookUrl(slug, v);
  return `/api/apps/${encodeURIComponent(slug)}/first-version/screens/${kind}/0?v=${encodeURIComponent(String(v ?? '0'))}`;
}

// The card's phone, the picture's own shape at the card's height: the
// words until there is a look, then the drawn screen over them.
const TOUR_LOOK_BOX = 'relative flex h-[min(44vh,340px)] aspect-[390/844] flex-col items-center justify-center gap-2 overflow-hidden rounded-[16px] bg-zinc-100 px-3 text-center shadow-[0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900';

/** The card's picture, or "Drawing your screens…" until it is there. */
export function TourFirstLook({ slug, name }: { slug: string; name: string }) {
  const t = useMessages('onboarding');
  const [src, setSrc] = useState<string | null>(null);
  // A picture that would not load is asked for again, as one not there yet.
  const [broken, setBroken] = useState<string | null>(null);
  useEffect(() => {
    // Asked again while there is none, or only its drawn screen.
    if (src && src !== broken && !isDrawnLook(src)) return undefined;
    let live = true;
    const read = () => fetch(madeAppUrl(slug), { credentials: 'same-origin', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        const found = firstLookSrc(body, slug);
        if (live && found && found !== broken) setSrc(found);
      })
      .catch(() => {});
    read();
    const timer = window.setInterval(read, FIRST_LOOK_POLL_MS);
    return () => { live = false; window.clearInterval(timer); };
  }, [slug, src, broken]);
  // The drawn screen stays until its picture is in (useLookSwap).
  const shown = useLookSwap(src && src !== broken ? src : null, ownSrc);
  const [framed, setFramed] = useState<string | null>(null);
  const drawn = !!shown && isDrawnLook(shown);
  const alt = t('onboarding:firstSession.tour.firstLook.alt', { app: name });
  return (
    <div data-first-session-first-look={shown && (!drawn || framed === shown) ? 'ready' : 'drawing'} className="mt-3 flex justify-center">
      {shown && !drawn ? (
        <img
          src={shown}
          alt={alt}
          onError={() => setBroken(shown)}
          className="h-[min(44vh,340px)] w-auto rounded-[16px] bg-zinc-100 object-cover object-top shadow-[0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900"
        />
      ) : (
        <div className={TOUR_LOOK_BOX}>
          {shown && framed === shown ? null : (
            <>
              <SpinnerRingIcon className="h-5 w-5 shrink-0 animate-spin text-zinc-500 motion-reduce:animate-none dark:text-zinc-400" aria-hidden="true" />
              <p role="status" className="text-[13px] leading-[18px] text-zinc-500 dark:text-zinc-400">{t('onboarding:firstSession.tour.firstLook.drawing')}</p>
            </>
          )}
          {shown ? (
            <DrawnLook
              key={shown}
              src={shown}
              label={alt}
              onLoad={() => setFramed(shown)}
              className={`transition-opacity duration-300 ease-out motion-reduce:transition-none ${framed === shown ? 'opacity-100' : 'opacity-0'}`}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
