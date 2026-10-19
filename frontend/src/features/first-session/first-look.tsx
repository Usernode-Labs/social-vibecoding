/**
 * N1 (newcomer run four, 13 Oct 2026): the first look at a project's first
 * version, the picture Homeroom bot drew of the app's main screen from the
 * maker's answers (services/first-version-screens.js: the spec saves it
 * first, and it is drawn about a minute in), read as the App tab reads it
 * (GET /api/apps/:slug `first_version.screens`, an image only the project's
 * members can load). The made screen's first look card (./made.tsx
 * FirstLookCard) and the hub's (../dev-board/workshop/hub-cards.tsx) draw
 * it, and ask again every FIRST_LOOK_POLL_MS until it is there.
 *
 * It used to end the maker's tour too, as its last card; the tour that card
 * ended is gone (./tour-steps.ts, 15 Oct 2026).
 *
 * 15 Oct 2026: before its picture is saved, the drawn screen itself
 * (./drawn-look.tsx), in the same box, and the picture in its place once it
 * is in.
 */

import { drawnLookUrl } from './drawn-look';

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
