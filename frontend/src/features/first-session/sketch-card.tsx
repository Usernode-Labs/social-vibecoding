/**
 * The first session's sketch: a featured card of the idea, the way an app
 * store features an app, while Homeroom bot makes the real thing
 * (services/app-sketch.js makes it from the description, a few seconds after
 * Make it).
 *
 *   art     the idea's colour (read off its emoji, lib/community-color.ts,
 *           so it is the colour the project's own page wears later), under
 *           faint construction stripes while it is being made, with its
 *           emoji as the icon it now is, and a pill saying where it is:
 *           "Sketching the idea", "Being made", "Ready to try";
 *   body    its name, a one-line tagline, and the points that fit four
 *           lines (fitPoints), each with an open dashed ring: not built yet;
 *   footer  on the made screen, Homeroom bot's step.
 *
 * 5 October 2026, on Evan's phone: the sketch was a framed mock of the app's
 * main screen that scrolled inside the made screen, under grey bars and
 * "Sketching <name> from your description…" for about twenty seconds. It
 * read as the app itself rather than as something being made. The card is a
 * fixed size and never scrolls: every region has its own height, the tagline
 * is clamped to two lines, and only the points that fit are drawn.
 *
 * WHILE IT IS SKETCHED the same frame stands with the name already in place
 * (and the example's emoji, if one was picked), on a neutral ground, and a
 * band of light passes over the lines where the tagline and points will land.
 * When the card comes, its colour fades in and its words rise into place.
 * Transform and opacity only, no delay; with reduced motion nothing moves.
 *
 * It is drawn here, from text, by React: nothing the model wrote is markup.
 * The invite page (../auth/invite-card.tsx) and "You're in"
 * (./joined-picture.tsx) draw the same card while the project has no picture
 * of its own: "Being made" while its first version is on its way, and with
 * no pill (`plain`) when they cannot say. "You're in" for a new account,
 * whose welcome is the shorter of the two, draws it `compact`: the art and
 * the tagline, no points.
 */

import { type ReactNode, useEffect, useState } from 'react';

import { useResolvedCommunityColor } from '../../lib/community-color';

import type { Made } from './make';

export type FeaturedCardData = { emoji: string; tagline: string; points: string[] };

export type SketchState = 'loading' | 'none' | 'pending' | 'ready' | 'failed';

export type Sketch = { state: SketchState; card: FeaturedCardData | null };

/** Where the project is, as the card's pill says it; `plain` says nothing. */
export type CardStage = 'sketching' | 'making' | 'ready' | 'idea' | 'plain';

/** The pill's words for each stage ('' for none). */
export function pillLabel(stage: CardStage): string {
  if (stage === 'sketching') return 'Sketching the idea';
  if (stage === 'ready') return 'Ready to try';
  if (stage === 'idea') return 'Not built yet';
  if (stage === 'plain') return '';
  return 'Being made';
}

/** Under construction: the stripes and the pill's pulse. */
function underway(stage: CardStage): boolean {
  return stage === 'sketching' || stage === 'making' || stage === 'idea';
}

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

/** Whether the made screen draws the card: on its way, or here. */
export function showsCard(state: SketchState): boolean {
  return state === 'loading' || state === 'pending' || state === 'ready';
}

// The points get four lines of the card. A point longer than LINE_CHARS is
// counted as two (it wraps at 390px; each is clamped to two), so the list
// never runs past its box. The first point is always drawn.
export const POINT_LINES = 4;
const LINE_CHARS = 36;

/** The points, in order, that fit the card's four lines. */
export function fitPoints(points: readonly string[], lines: number = POINT_LINES): string[] {
  const out: string[] = [];
  let used = 0;
  for (const point of points) {
    const need = point.length > LINE_CHARS ? 2 : 1;
    if (out.length && used + need > lines) break;
    out.push(point);
    used += need;
  }
  return out;
}

// Faint diagonal stripes: the card is under construction while it is made.
const STRIPES = 'repeating-linear-gradient(135deg, rgba(255,255,255,0.08) 0 12px, rgba(255,255,255,0) 12px 24px)';

/** Mounts hidden and settles on the next frame: a rise into place, no delay. */
function useArrived(): boolean {
  const [arrived, setArrived] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setArrived(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  return arrived;
}

function Glyph({ emoji }: { emoji: string }) {
  const arrived = useArrived();
  return (
    <span className={`transition-[opacity,transform] duration-300 ease-out motion-reduce:transition-none ${arrived ? 'scale-100 opacity-100' : 'scale-75 opacity-0'}`}>
      {emoji}
    </span>
  );
}

function Words({ card, color, compact = false }: { card: FeaturedCardData; color: string | null; compact?: boolean }) {
  const arrived = useArrived();
  return (
    <div data-featured-card-words="" className={`transition-[opacity,transform] duration-300 ease-out motion-reduce:transition-none ${arrived ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0'}`}>
      <p className="mt-1 line-clamp-2 h-10 text-[15px] leading-5 text-zinc-500 dark:text-zinc-400">{card.tagline}</p>
      {compact ? null : (
        <ul className="mt-3 flex flex-col gap-1">
          {fitPoints(card.points).map((point) => (
            <li key={point} className="flex items-start gap-2.5 text-[15px] leading-5">
              <span
                aria-hidden="true"
                className="mt-0.5 h-4 w-4 shrink-0 rounded-full border-[1.5px] border-dashed border-zinc-300 dark:border-zinc-600"
                style={color ? { borderColor: color } : undefined}
              />
              <span className="line-clamp-2 min-w-0">{point}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Where the tagline and the points will land, while the card is sketched. */
function Placeholder() {
  return (
    <div aria-hidden="true">
      <div className="mt-1 flex h-10 flex-col justify-center gap-2">
        <div className="h-3 w-11/12 rounded-full bg-zinc-200 dark:bg-zinc-800" />
        <div className="h-3 w-2/3 rounded-full bg-zinc-200 dark:bg-zinc-800" />
      </div>
      <div className="mt-3 flex flex-col gap-1">
        {['w-3/5', 'w-1/2', 'w-2/3'].map((width) => (
          <div key={width} className="flex h-5 items-center gap-2.5">
            <span className="h-4 w-4 shrink-0 rounded-full border-[1.5px] border-dashed border-zinc-300 dark:border-zinc-600" />
            <span className={`h-3 ${width} rounded-full bg-zinc-200 dark:bg-zinc-800`} />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The card itself, a fixed 394px tall with a footer (352px without): art
 * 148 (the icon sits below the pill), words 204, footer 42. Compact, 172px:
 * art 88, then the name and the tagline (84). `card` null is the card being
 * sketched.
 */
export function FeaturedCard({ name, colorKey, emoji, card, stage, titleId, heading = false, footer = null, compact = false }: {
  name: string;
  /** Picks a colour when there is no emoji to read one from (the project's slug). */
  colorKey: string;
  /** The icon: the card's, or one already known while it is sketched. */
  emoji: string | null;
  card: FeaturedCardData | null;
  stage: CardStage;
  titleId?: string;
  /** The name as the screen's heading (the made screen's dialog is labelled by it). */
  heading?: boolean;
  footer?: ReactNode;
  /** The art and the tagline only, for a screen with little room. */
  compact?: boolean;
}) {
  const color = useResolvedCommunityColor(card && emoji ? { iconEmoji: emoji, key: colorKey } : null);
  const sketching = !card;
  const Title = heading ? 'h1' : 'p';
  return (
    <div
      data-featured-card={sketching ? 'sketching' : 'ready'}
      className="relative overflow-hidden rounded-[20px] bg-white text-left text-zinc-900 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900 dark:text-zinc-100"
    >
      <div className={`relative flex items-center justify-center overflow-hidden bg-zinc-200 dark:bg-zinc-800 ${compact ? 'h-[88px] pt-4' : 'h-[148px] pt-6'}`}>
        <div
          aria-hidden="true"
          className={`absolute inset-0 transition-opacity duration-500 ease-out motion-reduce:transition-none ${color ? 'opacity-100' : 'opacity-0'}`}
          style={color ? { backgroundColor: color } : undefined}
        />
        {underway(stage) ? <div aria-hidden="true" className="absolute inset-0" style={{ backgroundImage: STRIPES }} /> : null}
        <span
          aria-hidden="true"
          className={`app-icon-tile relative flex items-center justify-center leading-none shadow-[0_6px_18px_rgba(0,0,0,0.18)] ${compact ? 'h-14 w-14 rounded-2xl text-[32px]' : 'h-[76px] w-[76px] rounded-[22px] text-[44px]'}`}
        >
          {emoji ? <Glyph key={emoji} emoji={emoji} /> : null}
        </span>
        {stage === 'plain' ? null : (
          <span data-featured-card-stage={stage} className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-black/45 px-2.5 py-1 text-[12px] font-semibold leading-4 text-white">
            {underway(stage) ? <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-white motion-safe:animate-pulse" /> : null}
            {pillLabel(stage)}
          </span>
        )}
      </div>
      <div className={`px-4 pt-3.5 ${compact ? 'h-[84px]' : 'h-[204px]'}`}>
        <Title id={titleId} className="truncate text-[20px] font-bold leading-6">{name}</Title>
        {card ? <Words card={card} color={color} compact={compact} /> : <Placeholder />}
      </div>
      {footer ? (
        <div className="flex h-[42px] items-center gap-1.5 px-4 text-[13px] text-zinc-500 shadow-[inset_0_1px_0_var(--app-sheet-line)] dark:text-zinc-400">
          {footer}
        </div>
      ) : null}
      {sketching ? (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden motion-reduce:hidden">
          <div className="h-full w-2/5 bg-gradient-to-r from-transparent via-white/60 to-transparent motion-safe:animate-card-sweep dark:via-white/[0.06]" />
        </div>
      ) : null}
    </div>
  );
}

// Stop asking after this long: a card is made in seconds, and in at most
// fifteen without the model (services/app-sketch.js MODEL_WAIT_MS).
const SKETCH_POLL_MS = 2000;
const SKETCH_GIVE_UP_MS = 90 * 1000;

/** GET /api/apps/:slug/sketch until the card is here, failed, or there is none. */
export function useSketch(slug: string): Sketch {
  const [sketch, setSketch] = useState<Sketch>({ state: 'loading', card: null });
  useEffect(() => {
    let live = true;
    let timer = 0;
    const started = Date.now();
    const read = async () => {
      const data = await fetch(`/api/apps/${encodeURIComponent(slug)}/sketch`, { credentials: 'same-origin', cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
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
 * The made screen's card (./made.tsx): sketching, then the idea, with
 * Homeroom bot's step under it and the line about what happens next below.
 */
export function SketchCard({ made, sketch, line, note, busy, botBuilds, built }: {
  made: Made;
  sketch: Sketch;
  /** buildLine: "Step 2 of 7: Read the description". */
  line: string;
  /** buildNote: what happens next, under the card. */
  note: string;
  busy: boolean;
  botBuilds: boolean;
  /** Version one is ready to try. */
  built: boolean;
}) {
  const card = sketch.card;
  const stage: CardStage = !card ? 'sketching' : built ? 'ready' : botBuilds ? 'making' : 'idea';
  return (
    <div data-first-session-sketch={card ? 'ready' : sketch.state} className="mt-4">
      {card ? null : <p role="status" className="sr-only">{`Sketching ${made.name} from your description…`}</p>}
      <FeaturedCard
        name={made.name}
        colorKey={made.slug}
        emoji={card?.emoji || made.emoji || null}
        card={card}
        stage={stage}
        titleId="first-session-made-title"
        heading
        footer={(
          <>
            {busy ? <span className="status-dot creating shrink-0" aria-hidden="true" /> : null}
            <span className="truncate" data-first-session-build="">{line}</span>
          </>
        )}
      />
      <p className="px-1 pt-2.5 text-[13px] leading-snug text-zinc-500 dark:text-zinc-400">{note}</p>
    </div>
  );
}
