/**
 * A pinned screenshot's comment, drawn over the clean picture (#4482).
 *
 * A C comment used to bake its blue pin and its words into the screenshot's
 * pixels, so nobody could see the picture underneath. The comment now
 * stores the pin and the words as data beside the clean bytes (the upload
 * is ../comment-pin/picture.ts's base), and this module draws them back on
 * the request's page: the pin where it was placed, the words in a white
 * rounded bubble beside it, and a small pill in the picture's corner that
 * hides them; pressing it again shows them.
 *
 * ── How it sits ───────────────────────────────────────────────────────
 *
 * The request's words are sanitised markdown mounted as innerHTML, so the
 * overlay cannot ride the markup. The layer is a React SIBLING inside the
 * positioned container instead (`RequestWords`' ask block, `position:
 * relative`), absolutely positioned over the `<img>`'s rendered box,
 * measured off the mounted element. Nothing is written into the innerHTML
 * subtree, so the React-ownership rule holds.
 *
 * The layer takes no taps, so a tap on the picture still reaches the
 * `dc-inline-img-link` link and opens the full-screen viewer, which shows
 * the clean image. The pin, the bubble and the pill capture taps; none of
 * them navigates.
 *
 * The pin lands by FRACTION of the image (pin_x / naturalWidth), so any
 * size the picture is displayed at puts it where it was. The bubble sits
 * beside the pin by the same `placeBeside` rule the comment box and the
 * handover's baked bubble use (../comment-pin/picture.ts), with the image's
 * displayed box as its viewport, and shows the stored words in full, wrapped
 * freely — the baked bubble's six-line ellipsis need not be reproduced.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';

import { placeBeside } from '../../comment-pin/picture';

/** A screenshot id in the words' HTML: the 32-hex id of an /issue-images/ link. */
const SHOT_ID_RE = /\/issue-images\/([a-f0-9]{32})/g;

/** The bubble the C box's baked copy draws (../comment-pin/picture.ts BUBBLE.width). */
const BUBBLE_WIDTH = 280;
/** Settle time after the words' fold finishes (request-head.tsx FOLD_MS). */
const SETTLE_MS = 260;

export interface ShotPin {
  id: string;
  /** The pin in the image's own pixels, as stored. */
  pinX: number;
  pinY: number;
  /** The comment's words, as the bubble shows them; null when there were none. */
  comment: string | null;
}

/** A screenshot's stored pin; null when the row has none (or the fetch fails). */
export async function fetchShotPin(id: string): Promise<ShotPin | null> {
  try {
    const res = await window.fetch(`/issue-images/${id}/pin`);
    if (!res.ok) return null;
    const data = await res.json() as Record<string, unknown>;
    if (typeof data.pinX !== 'number' || typeof data.pinY !== 'number') return null;
    return {
      id,
      pinX: data.pinX,
      pinY: data.pinY,
      comment: typeof data.comment === 'string' ? data.comment : null,
    };
  } catch {
    return null;
  }
}

/** The screenshot ids a body's own HTML names, in order, deduped. */
export function shotIdsIn(html: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const re = new RegExp(SHOT_ID_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(html || ''))) !== null) {
    if (!seen.has(m[1])) { seen.add(m[1]); found.push(m[1]); }
  }
  return found;
}

/**
 * The pins a request's words name, fetched in an effect. Only ids that
 * appear in the body's own HTML are looked up, so remote (GitHub-hosted)
 * images are never asked about. A screenshot without pin data — everything
 * filed before #4482, and the dialog's uploads — answers 404 and the
 * picture draws bare, exactly as it always has.
 */
export function useShotComments(html: string): {
  pins: Map<string, ShotPin>;
  hidden: Set<string>;
  toggle: (id: string) => void;
} {
  const ids = useMemo(() => shotIdsIn(html), [html]);
  const [pins, setPins] = useState<Map<string, ShotPin>>(new Map());
  useEffect(() => {
    let live = true;
    Promise.all(ids.map(fetchShotPin)).then((list) => {
      if (!live) return;
      const next = new Map<string, ShotPin>();
      for (const pin of list) if (pin) next.set(pin.id, pin);
      setPins(next);
    });
    return () => { live = false; };
  }, [ids.join(',')]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const toggle = useCallback((id: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  return { pins, hidden, toggle };
}

/** Where the overlay layer sits: the image's box, in the container's coordinates. */
export interface ShotBox { left: number; top: number; width: number; height: number }

/**
 * The overlay itself, drawn from a measured box. `shown` and `onToggle`
 * come from the hook, so the state survives the words' re-renders. When
 * the box is not yet measured (or the image is inside the folded words)
 * nothing is drawn.
 */
export function ShotCommentOverlay({ pin, box, natural, shown, onToggle }: {
  pin: ShotPin;
  box: ShotBox | null;
  /** The image's own pixel size, off the loaded `<img>`. */
  natural: { w: number; h: number } | null;
  shown: boolean;
  onToggle: () => void;
}): ReactNode {
  // The bubble's height, measured once it is drawn; estimated until then
  // (~13px type wrapping at ~40 characters a line) so placeBeside can clamp.
  const words = pin.comment || '';
  const estimated = 24 + Math.min(8, Math.max(1, Math.ceil(words.length / 40 || 1))) * 19;
  const [bubbleH, setBubbleH] = useState(estimated);
  const bubbleRef = useCallback((el: HTMLDivElement | null) => {
    if (el && Math.abs(el.offsetHeight - bubbleH) > 1) setBubbleH(el.offsetHeight);
  }, [bubbleH]);

  if (!box || !natural || natural.w < 1 || natural.h < 1 || box.width < 1 || box.height < 1) return null;

  // The pin by fraction of the image, so any display size lands right.
  // Positions are in the container's coordinates, where this layer lives:
  // the image's own box starts at (box.left, box.top) inside it.
  const fx = pin.pinX / natural.w;
  const fy = pin.pinY / natural.h;
  const px = box.left + fx * box.width;
  const py = box.top + fy * box.height;

  // The bubble beside the pin, clamped inside the image's displayed box,
  // then shifted by where that box sits in the container.
  const width = Math.min(BUBBLE_WIDTH, Math.max(120, box.width - 16));
  const size = { width, height: bubbleH };
  const local = placeBeside({ x: fx * box.width, y: fy * box.height }, size, { width: box.width, height: box.height });
  const at = { x: box.left + local.x, y: box.top + local.y };

  return (
    <div className="absolute inset-0" data-shot-comment-overlay="" data-shot-comment-id={pin.id} style={{ pointerEvents: 'none' }}>
      {shown ? (
        <>
          <span
            aria-hidden="true"
            data-shot-comment-pin=""
            className="absolute block h-[22px] w-[22px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-white bg-violet-600 shadow-[0_1px_6px_rgba(0,0,0,0.35)]"
            style={{ left: px, top: py, pointerEvents: 'auto' }}
          />
          {words ? (
            <div
              ref={bubbleRef}
              data-shot-comment-bubble=""
              className="absolute rounded-2xl bg-white p-3 text-[13px] leading-snug text-zinc-900 shadow-[0_8px_30px_rgba(0,0,0,0.18)] ring-1 ring-black/10 [overflow-wrap:anywhere] dark:bg-zinc-900 dark:text-zinc-100 dark:ring-white/10"
              style={{ left: at.x, top: at.y, width, whiteSpace: 'pre-wrap', pointerEvents: 'auto' }}
            >
              {words}
            </div>
          ) : null}
        </>
      ) : null}
      <button
        type="button"
        data-shot-comment-toggle=""
        aria-pressed={shown}
        className="absolute right-2 top-2 rounded-full border border-black/10 bg-white/95 px-2.5 py-1 text-xs font-medium text-zinc-600 shadow-sm hover:text-zinc-900 dark:border-white/10 dark:bg-zinc-900/90 dark:text-zinc-300 dark:hover:text-white"
        style={{ pointerEvents: 'auto' }}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggle(); }}
      >
        {shown ? 'Hide comment' : 'Show comment'}
      </button>
    </div>
  );
}

/** One pinned screenshot: its `<img>` found in the container, measured, overlaid. */
function PinnedShot({ pin, containerRef, open, shown, onToggle }: {
  pin: ShotPin;
  containerRef: RefObject<HTMLElement | null>;
  /** The words' fold state: the overlay lives only in the unfolded words. */
  open: boolean;
  shown: boolean;
  onToggle: () => void;
}): ReactNode {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [box, setBox] = useState<ShotBox | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);

  // The image is in the innerHTML subtree, so it is found, not rendered.
  useEffect(() => {
    setImg(containerRef.current?.querySelector<HTMLImageElement>(`img[src*="/issue-images/${pin.id}"]`) ?? null);
  }, [pin.id, containerRef]);

  const rerun = useCallback(() => {
    const host = containerRef.current;
    if (!img || !host || !img.isConnected) { setBox(null); return; }
    const ib = img.getBoundingClientRect();
    const hb = host.getBoundingClientRect();
    if (ib.width < 1 || ib.height < 1) { setBox(null); return; }
    setBox({ left: ib.left - hb.left, top: ib.top - hb.top, width: ib.width, height: ib.height });
    setNatural({ w: img.naturalWidth, h: img.naturalHeight });
  }, [img, containerRef]);

  useEffect(() => {
    if (!img || !open) { setBox(null); return; }
    rerun();
    const on = () => rerun();
    img.addEventListener('load', on);
    window.addEventListener('resize', on);
    // The fold's last frames and the thread's own layout settle.
    const t = window.setTimeout(on, SETTLE_MS);
    return () => {
      img.removeEventListener('load', on);
      window.removeEventListener('resize', on);
      window.clearTimeout(t);
    };
  }, [img, open, rerun]);

  return <ShotCommentOverlay pin={pin} box={box} natural={natural} shown={shown} onToggle={onToggle} />;
}

/**
 * Every pinned screenshot's overlay, hung inside the words' positioned
 * container. Only when the words are unfolded: folded, the screenshot is
 * below the clamp and out of sight, exactly as the baked bubble was.
 */
export function ShotComments({ comments, containerRef, open }: {
  comments: ReturnType<typeof useShotComments>;
  containerRef: RefObject<HTMLElement | null>;
  open: boolean;
}): ReactNode {
  return (
    <>
      {[...comments.pins.values()].map((pin) => (
        <PinnedShot
          key={pin.id}
          pin={pin}
          containerRef={containerRef}
          open={open}
          shown={!comments.hidden.has(pin.id)}
          onToggle={() => comments.toggle(pin.id)}
        />
      ))}
    </>
  );
}
