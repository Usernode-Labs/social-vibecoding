/**
 * The middle of "You're in" (./index.tsx): the project itself, as its invite
 * showed it, where a phone used to show a tall empty gap between the welcome
 * and "Go to <name>" (first-session run-through, 5 October 2026).
 *
 * The picture is the one the invite page showed (features/auth/invite-card.tsx,
 * services/community-invites.js pictureFor), handed over by whichever way in
 * they came: the link's standing (App._followInvite) or an accepted invite's
 * welcome (collab-invites.js welcomeFor, at member addresses). A sketch is
 * framed from the project's own route, which serves a member, so it does not
 * depend on the link still being live once this join has spent it; the
 * Discover card's image is anyone's; an after-shot comes only through a live
 * link, and one that does not load falls back to the next thing.
 *
 * Without a picture it is the project's tile, name and one line, the invite
 * page's own fallback; without even a line, nothing, and the space stays.
 * The screen puts a spacer after it either way, so "Go to <name>" stays at
 * the foot of the screen.
 */

import { useState } from 'react';

export type JoinPicture = { kind: 'shot' | 'illustration' | 'sketch'; url: string; darkUrl?: string | null };

/** A picture this screen can draw, or null. */
export function joinPicture(picture: unknown): JoinPicture | null {
  if (!picture || typeof picture !== 'object') return null;
  const { kind, url, darkUrl } = picture as Record<string, unknown>;
  if (kind !== 'shot' && kind !== 'illustration' && kind !== 'sketch') return null;
  if (typeof url !== 'string' || !url.startsWith('/')) return null;
  return { kind, url, darkUrl: typeof darkUrl === 'string' && darkUrl.startsWith('/') ? darkUrl : null };
}

/** The sketch's page, from the project's own route, in this screen's look. */
export function sketchSrc(slug: string, dark: boolean): string {
  return `/api/apps/${encodeURIComponent(slug)}/sketch.html?theme=${dark ? 'dark' : 'light'}`;
}

// Takes the space between the welcome and the button (all but a sliver of
// it: the screen's spacer after it grows by 1 to this frame's 999), but no
// taller than a phone's sketch (the invite page draws it 340px high, the made
// screen 380): past that, the spacer takes the rest and the button stays at
// the foot of the screen. At least 200px, which is what a new account's
// welcome, with its "How it works", leaves above the button on a 390x844
// phone.
const FRAME = 'relative mt-6 flex min-h-[200px] max-h-[440px] flex-[999_1_0%] flex-col overflow-hidden rounded-[20px] bg-white shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900';

export function JoinedPicture({ slug, name, picture, description, tile }: {
  slug: string;
  name: string;
  picture: JoinPicture | null;
  description?: string | null;
  /** The project's tile, as the pill above draws it. */
  tile: React.ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  if (picture && picture.kind === 'sketch') {
    // Read once: the page is static, and this screen does not stay up long.
    const dark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
    return (
      <div data-first-session-picture="sketch" className={FRAME}>
        <iframe
          title={`A sketch of ${name}`}
          src={sketchSrc(slug, dark)}
          sandbox=""
          referrerPolicy="no-referrer"
          className="min-h-0 w-full flex-1 border-0"
        />
        <span className="pointer-events-none absolute right-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[12px] font-semibold text-white">Sketch</span>
      </div>
    );
  }
  if (picture && !failed) {
    const img = 'min-h-0 w-full flex-1 object-cover object-top';
    return (
      <div data-first-session-picture={picture.kind} className={FRAME}>
        <img src={picture.url} alt={name} onError={() => setFailed(true)} className={picture.darkUrl ? `${img} dark:hidden` : img} />
        {picture.darkUrl ? <img src={picture.darkUrl} alt={name} className={`${img} hidden dark:block`} /> : null}
      </div>
    );
  }
  if (description) {
    return (
      <div data-first-session-picture="tile" className="mt-6 flex flex-col items-center rounded-[20px] bg-white px-6 py-8 text-center shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900">
        <span className="app-icon-tile flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-[22px] text-5xl" aria-hidden="true">{tile}</span>
        <p className="mt-3 text-[20px] font-bold leading-tight">{name}</p>
        <p className="mt-1.5 text-pretty text-[15px] leading-snug text-zinc-500 dark:text-zinc-400">{description}</p>
      </div>
    );
  }
  return null;
}
