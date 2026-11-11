/**
 * PINNED COMMUNITIES' TILE PIECES, kept for the guest Home.
 *
 * This file drew Home's second section, Pinned communities (One Home, #6361),
 * under Pinned apps: a grid of ringed community tiles that opened each hub,
 * then All communities, Needs you and New community. The two sections are
 * ONE Pinned grid now (`#app-list`, ./home.js `Home.onHome`): a community
 * pinned on Home puts its app's tile beside the apps you pinned, a tap on any
 * tile asks whether you meant the app or its community (./pin-chooser.tsx),
 * and Needs you and All communities end that grid (./app-grid.tsx
 * TrailingTile). Its New community tile went with it: the grid's own New
 * project tile opens the same dialog.
 *
 * What is left are the pieces the signed-out Home still draws its device's
 * pins with (features/guest/guest-discover.tsx): the ringed face, in the
 * community's colour (lib/community-color.ts) so it never reads as an app,
 * and the corner discs of its edit mode.
 */
import { useCommunityColor } from '../../lib/community-color';
import { AppIconContent, appIconKind } from '../apps/app-card-view';

const FACE = 'app-icon-tile w-14 h-14 shrink-0 rounded-[16px] overflow-hidden flex items-center justify-center font-bold text-2xl';
const RING = 'rounded-[21px] p-[3px] shadow-[inset_0_0_0_2px_var(--ring)]';
// The corner discs an edit mode draws (app-grid.tsx .app-card-remove): a dark
// − to unpin; a white + in the accent ink to pin (Discover's add pill's
// treatment), never a primary button's fill on a 24px badge.
export const CORNER_UNPIN = 'bg-zinc-700 text-white dark:bg-zinc-500';
export const CORNER_PIN = 'bg-white text-violet-700 dark:bg-zinc-800 dark:text-violet-400';
/** No MinusIcon in the kit's set: the glyph is the minus itself, as app-grid.tsx draws it. */
export function MinusGlyph() {
  return <span aria-hidden="true" className="text-[15px] leading-none font-semibold">&minus;</span>;
}

export function CommunityTileFace({ slug, name, iconUrl, iconEmoji, iconColor }: {
  slug: string; name: string; iconUrl?: string | null; iconEmoji?: string | null; iconColor?: string | null;
}) {
  const ring = useCommunityColor({ color: iconColor || null, iconUrl: iconUrl || null, iconEmoji: iconEmoji || null, key: slug });
  const app = { slug, name, icon_url: iconUrl || null, icon_emoji: iconEmoji || null };
  return (
    <span className={RING} style={{ ['--ring' as string]: ring }}>
      <span className={FACE} data-icon={appIconKind(app as any)} aria-hidden="true">
        <AppIconContent app={app as any} />
      </span>
    </span>
  );
}
