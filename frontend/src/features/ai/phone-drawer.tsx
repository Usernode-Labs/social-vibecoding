/**
 * THE BOT TAB ON A PHONE, AS A DRAWER (30 Oct 2026, Evan: "the same as
 * Messages and Communities"; ../nav-drawer/messages-drawer.ts is the model).
 *
 * Under 768px the list is the drawer's first level, the whole screen, and
 * the column, Main Chat or one thread of it, is the second, the whole screen
 * to its right. Main Chat's row, a private thread's row and the Ask bar
 * slide the strip in; the header's arrow (Main Chat) or the thread's own
 * (1 Nov 2026: a thread is alone in the column, under its own head) and a
 * swipe right slide it back. A pan follows the finger and, let go past a
 * quarter of the way, lands on the next level, as the Messages drawer's
 * does: the same slide (SLIDE_MS, SLIDE_EASE) and the same landing rule
 * (landingIn). The drawer holds only Main and its threads: a request, a
 * change or a decision opens on its own page, as it does from Messages
 * (Evan, 30 Oct).
 *
 * The level not in view is inert as well as hidden, so a keyboard or a
 * screen reader never lands in the one off screen.
 *
 * From 768px nothing here is drawn: the list is its own column, beside the
 * column Main Chat docks in (1 Nov 2026: from 768px, not 1024px). The list
 * is never folded into the platform's sidebar (Evan, 30 Oct).
 *
 * NO PEEK, EVER (Evan, 3 Nov 2026: "simplify on mobile"). The list is the
 * whole screen and the column waits off its right edge (FULL_AT); a row, the
 * Ask bar or a pan brings it in, and its back arrow slides the list back. It
 * was full screen only until a thread had been opened on the device (1 Nov),
 * then an 85% drawer with Main peeking; the phone's other lists, Messages and
 * your communities, lost their peek in the same change.
 */
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';

import { EmbeddedConversation } from '../messages';
import { isPan, landingIn, SLIDE_EASE, SLIDE_MS } from '../nav-drawer/drawer-math';
import { botDepth } from '../nav-drawer/bot-drawer';
import { reducedMotion } from '../nav-drawer/drawer-store';
import { dirSign } from '../../lib/i18n/direction';

const PHONE_QUERY = '(max-width: 767.98px)';

/** Whether this is a phone's width. False on the first render, as the prerender is. */
export function usePhone(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(PHONE_QUERY);
    const apply = () => setPhone(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  return phone;
}

/**
 * The second level: Main Chat, or a thread of it alone (`threadUp`), whose
 * own head has the arrow back to the list. Main Chat draws no bar of its
 * own (3 Nov 2026): the platform's header names it and holds its arrow
 * (../nav-drawer/bot-drawer.ts), as it does a Messages conversation.
 */
export function MainPane({ botId, active, at, onBack }: {
  botId: number | null;
  active: boolean;
  at: { threadRootId: number | null; focusMessageId: number | null } | null;
  onBack: () => void;
}): ReactNode {
  return botId ? <EmbeddedConversation conversationId={botId} active={active} at={at} mainChat onBack={onBack} /> : null;
}

// ── The list is the whole screen ──

/** Where the strip rests: the column a whole screen to the right of the list. */
export const FULL_AT: readonly [number, number] = [0, 1];

/** The strip: the list, then Main a whole screen to its right; level 0 the list, 1 Main. */
export function AiDrawer({ level, onLevel, list, pane }: {
  level: 0 | 1;
  onLevel: (next: 0 | 1) => void;
  list: ReactNode;
  pane: ReactNode;
}): ReactNode {
  const root = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<number | null>(null);
  const pan = useRef<{ x: number; y: number; from: 0 | 1; panning: boolean; id: number } | null>(null);
  const swallow = useRef(false);
  const at = FULL_AT;
  // The header's words and arrow move with the strip (../nav-drawer/bot-drawer.ts):
  // a tap slides them, a finger sets them, and a pan let go of slides them to
  // where it lands, the same level or the other.
  useEffect(() => { botDepth.cut(level); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { botDepth.slide(level); }, [level]);
  useEffect(() => {
    const el = root.current;
    if (!el) return undefined;
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => setWidth(el.clientWidth));
    ro?.observe(el);
    setWidth(el.clientWidth);
    return () => ro?.disconnect();
  }, []);
  const offset = drag ?? at[level];
  const still = drag != null || reducedMotion();

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    pan.current = { x: e.clientX, y: e.clientY, from: level, panning: false, id: e.pointerId };
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = pan.current;
    if (!p || !width) return;
    // In reading direction, so "toward the other level" and the offset below
    // are the same sums in Arabic, where the strip runs the other way.
    const dx = (e.clientX - p.x) * dirSign();
    const dy = e.clientY - p.y;
    if (!p.panning) {
      if (!isPan(dx, dy)) return;
      // Only toward the other level: inline-start from the list (left in
      // English), inline-end from Main.
      if ((p.from === 0 && dx > 0) || (p.from === 1 && dx < 0)) { pan.current = null; return; }
      p.panning = true;
      try { root.current?.setPointerCapture(p.id); } catch { /* released already */ }
      // A mouse dragging the strip would otherwise select the text under it.
      try { window.getSelection()?.removeAllRanges(); } catch { /* nothing selected */ }
    }
    const next = Math.max(0, Math.min(at[1], at[p.from] - dx / width));
    setDrag(next);
    botDepth.set(next);
  };
  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = pan.current;
    pan.current = null;
    if (!p?.panning) return;
    const now = drag ?? at[p.from];
    swallow.current = true;
    setDrag(null);
    const lands = landingIn(at, p.from, now, (e.clientX - p.x) * dirSign()) as 0 | 1;
    botDepth.slide(lands);
    onLevel(lands);
  };
  const cancel = () => { pan.current = null; setDrag(null); botDepth.slide(level); };

  return (
    <div
      ref={root}
      className="ai-drawer"
      data-level={level}
      data-panning={drag != null ? '' : undefined}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={cancel}
      onClickCapture={(e) => { if (swallow.current) { swallow.current = false; e.preventDefault(); e.stopPropagation(); } }}
    >
      <div
        className="ai-drawer-strip"
        style={{
          transform: `translateX(${-offset * width * dirSign()}px)`,
          transition: still ? 'none' : `transform ${SLIDE_MS}ms ${SLIDE_EASE}`,
        }}
      >
        <div className="ai-drawer-list" inert={level === 1} aria-hidden={level === 1 ? true : undefined}>{list}</div>
        <section className="ai-drawer-thread">
          <div className="ai-drawer-pane" inert={level === 0} aria-hidden={level === 0 ? true : undefined}>{pane}</div>
        </section>
      </div>
    </div>
  );
}
