/**
 * The project's thumbnail (#4053): what the app will be, while Homeroom bot
 * makes the real thing. Its icon on its colour, its name, and one line about
 * it, the sketch's tagline (services/app-sketch.js makes it from the
 * description, a few seconds after Make it) or, without one, the project's
 * own description. While its first version is on its way, the build line
 * (./build-line.tsx) is its bottom row, under a hairline.
 *
 *   art     the idea's colour (read off its emoji, lib/community-color.ts,
 *           so it is the colour the project's own page wears later), with
 *           its emoji as the icon it now is;
 *   body    its name and the line, clamped to two lines;
 *   line    where its first version is, when the screen knows.
 *
 * It used to be a featured card under construction: faint diagonal stripes,
 * a "Being made" pill, the points it would do with open dashed rings, and
 * "Step 1 of 7: Set up the project" in its footer. Three of its parts talked
 * about the build and the points read like a plan, so the card read as the
 * build rather than as a thumbnail of the app (Evan, onboarding test on
 * iPhone, 6 October 2026, #4041). Now one row says where it is, and the rest
 * shows what it will be. The row stays inside the card: kept together, the
 * thumbnail and its line move as one piece to every screen that shows the
 * app, and a person finds the line in the same place each time.
 *
 * WHILE IT IS SKETCHED the same frame stands with the name already in place
 * (and the example's emoji, if one was picked), on a neutral ground, and a
 * band of light passes over where the line will land. When the card comes,
 * its colour fades in and its words rise into place. Transform and opacity
 * only, no delay; with reduced motion nothing moves.
 *
 * It is drawn here, from text, by React: nothing the model wrote is markup.
 * The made screen draws it with its line (SketchCard below), the App tab
 * while the first version is on its way (features/app-frame/app-status.tsx),
 * and the invite page (../auth/invite-card.tsx) and "You're in"
 * (./joined-picture.tsx) while the project has no picture of its own. Those
 * two know only that it is on its way, not where, so they draw it without
 * a line. "You're in" for a new account, whose welcome leaves about 200px,
 * draws it `compact`: smaller art.
 *
 * ThumbRow is the small size, for a row: the tile on its colour, the name,
 * and the build line in place of the one line when there is one.
 */

import { type ReactNode, useEffect, useState } from 'react';

import { useResolvedCommunityColor } from '../../lib/community-color';

import { BuildLine, type BuildLineState } from './build-line';
import type { Made } from './make';

export type FeaturedCardData = { emoji: string; tagline: string; points: string[] };

export type SketchState = 'loading' | 'none' | 'pending' | 'ready' | 'failed';

export type Sketch = { state: SketchState; card: FeaturedCardData | null };

/** The card in an answer (GET /api/apps/:slug/sketch, an invite's picture), or null. */
export function sketchCardOf(value: unknown): FeaturedCardData | null {
  const card = value && typeof value === 'object' ? (value as { card?: unknown }).card : null;
  if (!card || typeof card !== 'object') return null;
  const { emoji, tagline, points } = card as { emoji?: unknown; tagline?: unknown; points?: unknown };
  if (typeof emoji !== 'string' || !emoji || typeof tagline !== 'string' || !tagline) return null;
  return {
    emoji: emoji.slice(0, 16),
    tagline: tagline.slice(0, 120),
    points: Array.isArray(points) ? points.filter((p): p is string => typeof p === 'string' && !!p).slice(0, 4) : [],
  };
}

/** Whether the sketch is still on its way: the card stands, being sketched. */
export function sketching(state: SketchState): boolean {
  return state === 'loading' || state === 'pending';
}

/** Mounts hidden and settles on the next frame: a rise into place, no delay. */
function useArrived(): boolean {
  const [arrived, setArrived] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setArrived(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  return arrived;
}

function Glyph({ glyph }: { glyph: string }) {
  const arrived = useArrived();
  return (
    <span className={`transition-[opacity,transform] duration-300 ease-out motion-reduce:transition-none ${arrived ? 'scale-100 opacity-100' : 'scale-75 opacity-0'}`}>
      {glyph}
    </span>
  );
}

function Tagline({ text }: { text: string }) {
  const arrived = useArrived();
  return (
    <p
      data-featured-card-words=""
      className={`line-clamp-2 text-[15px] leading-5 text-zinc-500 transition-[opacity,transform] duration-300 ease-out motion-reduce:transition-none dark:text-zinc-400 ${arrived ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0'}`}
    >
      {text}
    </p>
  );
}

/** Where the line will land, while the card is sketched. */
function Placeholder() {
  return (
    <div aria-hidden="true" className="flex h-10 flex-col justify-center gap-2">
      <div className="h-3 w-11/12 rounded-full bg-zinc-200 dark:bg-zinc-800" />
      <div className="h-3 w-2/3 rounded-full bg-zinc-200 dark:bg-zinc-800" />
    </div>
  );
}

/** What the tile shows: the emoji, else the name's first letter once nothing more is coming. */
function glyphOf(name: string, emoji: string | null, sketched: boolean): string | null {
  if (emoji) return emoji;
  return sketched ? null : (name.trim().slice(0, 1).toUpperCase() || null);
}

/**
 * The thumbnail. Art 132px (88px `compact`), the name and its line, and the
 * build line as the bottom row when `line` is given. `sketching` is the card
 * still being sketched (by default, while there is no `card`); `description`
 * stands in for the sketch's tagline when there is none.
 */
export function FeaturedCard({ name, colorKey, emoji, card, description = null, sketching: sketched = !card, line = null, titleId, heading = false, compact = false }: {
  name: string;
  /** Picks a colour when there is no emoji to read one from (the project's slug). */
  colorKey: string;
  /** The icon: the card's, or one already known while it is sketched. */
  emoji: string | null;
  card: FeaturedCardData | null;
  /** The project's own description, said when there is no sketch. */
  description?: string | null;
  sketching?: boolean;
  /** Where its first version is (./build-line.tsx), or none. */
  line?: BuildLineState | null;
  titleId?: string;
  /** The name as the screen's heading (the made screen's dialog is labelled by it). */
  heading?: boolean;
  /** Smaller art, for a screen with little room. */
  compact?: boolean;
}) {
  const color = useResolvedCommunityColor(sketched ? null : { iconEmoji: emoji, key: colorKey });
  const glyph = glyphOf(name, emoji, sketched);
  const tagline = (card && card.tagline) || (description || '').trim();
  const Title = heading ? 'h1' : 'p';
  return (
    <div
      data-featured-card={sketched ? 'sketching' : 'ready'}
      className="relative overflow-hidden rounded-[20px] bg-white text-left text-zinc-900 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900 dark:text-zinc-100"
    >
      <div className={`relative flex items-center justify-center overflow-hidden bg-zinc-200 dark:bg-zinc-800 ${compact ? 'h-[88px]' : 'h-[132px]'}`}>
        <div
          aria-hidden="true"
          className={`absolute inset-0 transition-opacity duration-500 ease-out motion-reduce:transition-none ${color ? 'opacity-100' : 'opacity-0'}`}
          style={color ? { backgroundColor: color } : undefined}
        />
        <span
          aria-hidden="true"
          className={`app-icon-tile relative flex items-center justify-center leading-none shadow-[0_6px_18px_rgba(0,0,0,0.16)] ${compact ? 'h-14 w-14 rounded-2xl text-[32px]' : 'h-[76px] w-[76px] rounded-[22px] text-[44px]'}`}
        >
          {glyph ? <Glyph key={glyph} glyph={glyph} /> : null}
        </span>
      </div>
      <div className="flex flex-col gap-1 px-4 pb-4 pt-3.5">
        <Title id={titleId} className="truncate text-[17px] font-bold leading-[22px]">{name}</Title>
        {sketched ? <Placeholder /> : tagline ? <Tagline key={tagline} text={tagline} /> : null}
      </div>
      {line ? (
        <div data-featured-card-line="" className="px-4 py-3 shadow-[inset_0_1px_0_var(--app-sheet-line)]">
          <BuildLine state={line} />
        </div>
      ) : null}
      {sketched ? (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden motion-reduce:hidden">
          <div className="h-full w-2/5 bg-gradient-to-r from-transparent via-white/60 to-transparent motion-safe:animate-card-sweep dark:via-white/[0.06]" />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The thumbnail drawn small, for a row: a 56px tile on the project's colour
 * with its icon, its name, and under it the build line when there is one,
 * else its one line.
 */
export function ThumbRow({ name, colorKey, emoji, tagline = null, line = null }: {
  name: string;
  colorKey: string;
  emoji: string | null;
  tagline?: string | null;
  line?: BuildLineState | null;
}): ReactNode {
  const color = useResolvedCommunityColor({ iconEmoji: emoji, key: colorKey });
  const glyph = glyphOf(name, emoji, false);
  return (
    <div data-thumb-row="" className="flex min-w-0 items-center gap-3 text-left text-zinc-900 dark:text-zinc-100">
      <span
        aria-hidden="true"
        className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-zinc-200 dark:bg-zinc-800"
        style={color ? { backgroundColor: color } : undefined}
      >
        <span className="app-icon-tile flex h-10 w-10 items-center justify-center rounded-xl text-2xl leading-none shadow-[0_3px_8px_rgba(0,0,0,0.14)]">
          {glyph}
        </span>
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-[15px] font-[650] leading-5">{name}</span>
        {line ? (
          <BuildLine state={line} />
        ) : tagline ? (
          <span className="line-clamp-2 text-[13px] leading-[18px] text-zinc-500 dark:text-zinc-400">{tagline}</span>
        ) : null}
      </span>
    </div>
  );
}

// Stop asking after this long: a card is made in seconds, and in at most
// fifteen without the model (services/app-sketch.js MODEL_WAIT_MS).
const SKETCH_POLL_MS = 2000;
const SKETCH_GIVE_UP_MS = 90 * 1000;

/**
 * GET /api/apps/:slug/sketch until the card is here, failed, or there is
 * none. No slug: none, asked of nobody (a screenshot state's made-up project).
 */
export function useSketch(slug: string | null): Sketch {
  const [sketch, setSketch] = useState<Sketch>(() => (slug ? { state: 'loading', card: null } : { state: 'none', card: null }));
  useEffect(() => {
    if (!slug) { setSketch({ state: 'none', card: null }); return undefined; }
    let live = true;
    let timer = 0;
    const started = Date.now();
    const read = async () => {
      // No such project to this reader (the App tab's screenshot state has
      // none): nothing to wait for, rather than ninety seconds of asking.
      const data = await fetch(`/api/apps/${encodeURIComponent(slug)}/sketch`, { credentials: 'same-origin', cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : r.status === 404 ? { status: 'none' } : null))
        .catch(() => null);
      if (!live) return;
      const status = data?.status;
      const card = sketchCardOf(data);
      if (status === 'ready' && card) { setSketch({ state: 'ready', card }); return; }
      if (status === 'ready' || status === 'failed' || status === 'none') { setSketch({ state: status === 'ready' ? 'none' : status, card: null }); return; }
      // A read that failed is asked again; the card stays sketching meanwhile.
      if (status === 'pending') setSketch((s) => (s.state === 'pending' ? s : { state: 'pending', card: null }));
      if (Date.now() - started > SKETCH_GIVE_UP_MS) { setSketch({ state: 'failed', card: null }); return; }
      timer = window.setTimeout(() => { void read(); }, SKETCH_POLL_MS);
    };
    void read();
    return () => { live = false; window.clearTimeout(timer); };
  }, [slug]);
  return sketch;
}

/**
 * The made screen's card (./made.tsx): the thumbnail, being sketched and
 * then the idea, with the build line at its foot and the line about what
 * happens next below it.
 */
export function SketchCard({ made, sketch, line, note }: {
  made: Made;
  sketch: Sketch;
  /** Where its first version is (./build-line.tsx), or none for a project Homeroom bot does not build. */
  line: BuildLineState | null;
  /** buildNote: what happens next, under the card. */
  note: string;
}) {
  const card = sketch.card;
  const sketched = !card && sketching(sketch.state);
  return (
    <div data-first-session-sketch={card ? 'ready' : sketch.state} className="mt-4">
      {sketched ? <p role="status" className="sr-only">{`Sketching ${made.name} from your description…`}</p> : null}
      <FeaturedCard
        name={made.name}
        colorKey={made.slug}
        emoji={card?.emoji || made.emoji || null}
        card={card}
        description={made.description}
        sketching={sketched}
        line={line}
        titleId="first-session-made-title"
        heading
      />
      <p className="px-1 pt-2.5 text-[13px] leading-snug text-zinc-500 dark:text-zinc-400">{note}</p>
    </div>
  );
}
