/**
 * THE MESSAGES SCREEN AS A DRAWER, ON A PHONE (Evan's design, 18 Oct 2026;
 * ../nav-drawer/messages-drawer.ts says what it is and when it applies).
 *
 * The screen's own two panes become the drawer's levels, moved by transform
 * on a phone only: the list (`.messages-list-pane`), the whole screen, and
 * the conversation (`.messages-thread-pane`), which slides in over it. NO
 * PEEK (Evan, 3 Nov 2026: "simplify on mobile"): the list used to narrow to
 * 85% once a conversation had been opened, with that conversation peeking in
 * at its right; it stays the whole screen now, as a community's Hub and the
 * Homeroom bot's list do. In a conversation the pan follows a finger: a
 * swipe right from anywhere that is not sideways UI, or from the left edge
 * (EDGE_PX) except in Safari on an iPhone, where that edge is the browser's
 * own Back (../nav-drawer/sideways.ts). Let go past a quarter of the way and
 * it opens the list, through `open()` as the arrow does: the levels are
 * addresses, and the panes slide on from wherever the finger left them.
 *
 * An agent chat and an agent session are the second level too, named in the
 * header by the screen (`agentWords`).
 *
 * Nothing changes at 768px and up, nor on a phone for a dev session, a
 * channel or a reply thread: the drawer does not hold those routes, and the
 * panes keep the classes and the layout they had.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';

import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { pageTakesEdge } from '../dev-board/workshop/places-tray';
import {
  afterSlideStarts, depthIn, EDGE_PX, isPan, landingIn, MESSAGES_AT, PAN_SLOP_PX, SLIDE_EASE, SLIDE_MS,
} from '../nav-drawer/drawer-math';
import { reducedMotion } from '../nav-drawer/drawer-store';
import {
  messagesDepth, messagesDrawerApplies, publishMessagesDrawer, registerMessagesBack,
} from '../nav-drawer/messages-drawer';
import { startsOnSideways, swipeBackMayStart } from '../nav-drawer/sideways';
import { open as openConversation } from './store';
import type { ConversationDetail } from './types';
import { stripWidth } from '../../lib/side-strip';
import { dirSign } from '../../lib/i18n/direction';

const PHONE_QUERY = '(max-width: 767.98px)';

/** What the drawer needs to know from the screen's snapshot. */
export interface DrawerRoute {
  open: boolean;
  conversationId: number | null;
  appSlug: string | null;
  agent: unknown;
  threadRootId: number | null;
  embedded?: boolean;
}

function usePhone(): boolean {
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

export interface MessagesDrawer {
  on: boolean;
  level: 0 | 1;
  /** The pan's handlers, for the layout. */
  handlers: {
    onClickCapture: (e: { preventDefault: () => void; stopPropagation: () => void }) => void;
  } | null;
}

export function useMessagesDrawer(
  layoutRef: RefObject<HTMLDivElement | null>,
  route: DrawerRoute,
  active: ConversationDetail | null,
  names: (conversation: ConversationDetail) => { title: string; sub: string },
  /** The header's words for the open agent chat or agent session, if one is open. */
  agentWords: { title: string; sub: string } | null = null,
): MessagesDrawer {
  const phone = usePhone();
  const on = messagesDrawerApplies({
    phone,
    open: route.open,
    conversationId: route.conversationId,
    appSlug: route.appSlug,
    agent: route.agent,
    threadRootId: route.threadRootId,
    embedded: route.embedded,
    activeKind: active && active.id === route.conversationId ? active.kind : null,
    bot: !!(active && active.id === route.conversationId && active.homeroomBot),
  });
  const level: 0 | 1 = route.conversationId || route.agent ? 1 : 0;
  const agentOpen = on && level === 1 && !!route.agent;
  // The conversation on show, which the header names.
  const showing = on && level === 1 && !!active && active.id === route.conversationId && active.kind !== 'channel'
    ? active : null;
  const words = agentOpen ? (agentWords || { title: '', sub: '' }) : showing ? names(showing) : { title: '', sub: '' };
  useIsomorphicLayoutEffect(() => {
    publishMessagesDrawer({ on, level, title: words.title, sub: words.sub });
  }, [on, level, words.title, words.sub]);
  useEffect(() => () => publishMessagesDrawer({ on: false, level: 0, title: '', sub: '' }), []);
  useEffect(() => (on ? registerMessagesBack(() => openConversation(null)) : undefined), [on]);

  // ── Putting the panes somewhere ──
  // Their transform only. The conversation's pane is also the kit's keyboard
  // column (`platform-kb-column`), and the kit owns that node's inline
  // `transition` (it sets it to none so its own ride is the only motion), so
  // a slide is an animation of the transform, never a transition.
  const panes = () => {
    const layout = layoutRef.current;
    return {
      layout,
      list: layout?.querySelector<HTMLElement>(':scope > .messages-list-pane') || null,
      thread: layout?.querySelector<HTMLElement>(':scope > .messages-thread-pane') || null,
    };
  };
  // Where the panes were last put: a pan leaves them part of the way, and the
  // pane the route swaps in (the list's empty pane is not drawn) starts from
  // there.
  const lastOffset = useRef<number>(MESSAGES_AT[level]);
  // The slide each pane is on: its node, the animation, and where it runs
  // from and to. By PANE, not by node: a release starts the slide before the
  // route that lands it swaps the conversation's pane (`landAt`), and the new
  // node carries on the slide the old one was on.
  type Slide = { el: HTMLElement; anim: Animation; start: string; end: string; t0: number };
  const slides = useRef(new Map<'list' | 'thread', Slide>());
  const at = (pane: 'list' | 'thread', offset: number, w: number) =>
    `translate3d(${(pane === 'list' ? -offset : MESSAGES_AT[1] - offset) * w * dirSign()}px, 0, 0)`;
  const run = (pane: 'list' | 'thread', el: HTMLElement, start: string, end: string, t0: number, elapsed = 0) => {
    const anim = el.animate([{ transform: start }, { transform: end }], { duration: SLIDE_MS, easing: SLIDE_EASE });
    if (elapsed > 0) anim.currentTime = Math.min(SLIDE_MS, elapsed);
    const slide: Slide = { el, anim, start, end, t0 };
    slides.current.set(pane, slide);
    const done = () => { if (slides.current.get(pane) === slide) slides.current.delete(pane); };
    anim.onfinish = done;
    anim.oncancel = done;
  };
  const put = (offset: number, animate: boolean) => {
    const { layout, list, thread } = panes();
    const w = Math.max(1, (layout?.clientWidth || 1) - stripWidth());
    const from = lastOffset.current;
    lastOffset.current = offset;
    for (const [pane, el] of [['list', list], ['thread', thread]] as const) {
      if (!el) continue;
      const running = slides.current.get(pane);
      const end = at(pane, offset, w);
      if (animate && running && running.end === end) {
        // Already on its way there: the route confirming a release's slide.
        if (running.el === el) continue;
        // A node the route swapped in mid-slide joins the slide where it is.
        const elapsed = typeof running.anim.currentTime === 'number'
          ? running.anim.currentTime : performance.now() - running.t0;
        running.anim.cancel();
        el.style.transform = end;
        if (!reducedMotion() && typeof el.animate === 'function') run(pane, el, running.start, end, running.t0, elapsed);
        continue;
      }
      // From where it is on screen: mid-slide, where the slide has it.
      const own = running && running.el === el ? running : null;
      const shown = own ? getComputedStyle(el).transform : 'none';
      const start = own && shown !== 'none' ? shown : at(pane, from, w);
      running?.anim.cancel();
      el.style.transform = end;
      if (!animate || reducedMotion() || typeof el.animate !== 'function' || start === end) continue;
      run(pane, el, start, end, performance.now());
    }
  };
  const clear = () => {
    for (const slide of [...slides.current.values()]) slide.anim.cancel();
    const { list, thread } = panes();
    for (const el of [list, thread]) {
      if (el) el.style.transform = '';
    }
  };
  // A release's level, from the moment it set the panes sliding until the
  // route lands on it (`landAt`).
  const landing = useRef<null | 0 | 1>(null);
  // Where the route says, sliding there from where it was; at once the
  // first time.
  const placed = useRef<null | 0 | 1>(null);
  useIsomorphicLayoutEffect(() => {
    if (!on) {
      placed.current = null;
      clear();
      messagesDepth.cut(0);
      return;
    }
    const first = placed.current === null;
    if (!first && landing.current === level) {
      // The release started this slide already, and the header's with it.
      landing.current = null;
      put(MESSAGES_AT[level], true);
      placed.current = level;
      return;
    }
    landing.current = null;
    put(MESSAGES_AT[level], !first);
    if (first) messagesDepth.cut(level);
    else messagesDepth.slide(level);
    placed.current = level;
  }, [on, level]);
  // Again whenever the layout's width changes. Not only a window's resize:
  // a route that lands straight on a conversation or an agent (a link, a
  // reload, `#agent/new`) is placed before the screen is shown, at no width,
  // and the list stayed in view behind the pane.
  useEffect(() => {
    if (!on) return undefined;
    let width = layoutRef.current?.clientWidth || 0;
    const again = () => {
      const now = layoutRef.current?.clientWidth || 0;
      if (now === width) return;
      width = now;
      if (!fingerOn.current) put(MESSAGES_AT[placed.current ?? level], false);
    };
    window.addEventListener('resize', again);
    const layout = layoutRef.current;
    const watch = layout && typeof ResizeObserver === 'function' ? new ResizeObserver(again) : null;
    if (layout) watch?.observe(layout);
    return () => {
      window.removeEventListener('resize', again);
      watch?.disconnect();
    };
  }, [on, level]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Letting go: the level a pan lands on, and its address ──
  // Short of a quarter, back where it was; past it, the other address, and
  // the slide runs on from where the finger left the panes as it lands.
  //
  // THE SLIDE FIRST, THE ROUTE AFTER (polish board #16, 19 Oct 2026). The
  // address used to change on release and the slide to start from the
  // route's render: on an iPhone the panes stood still for 85ms under the
  // lifted finger, and 163ms under a 6x CPU throttle in Chrome, then jumped
  // on. Now the panes and the header start sliding in the release's own
  // task, and the address changes once the slide is running
  // (afterSlideStarts), in a task of its own so its render runs between
  // frames rather than inside one; the route's placement then finds them
  // already on their way (`put`, `landing`).
  const landAt = (from: 0 | 1, offset: number, dx: number) => {
    const to = landingIn(MESSAGES_AT, from, offset, dx) as 0 | 1;
    put(MESSAGES_AT[to], true);
    messagesDepth.slide(to);
    if (to === from) return;
    landing.current = to;
    afterSlideStarts(() => { window.setTimeout(() => openConversation(null), 0); });
  };

  const swallow = useRef(false);
  const fingerOn = useRef(false);

  // ── A finger ──
  // From touch events, which keep coming while the browser scrolls the
  // conversation under the same finger, so a swipe a little off level still
  // pans. In a conversation a swipe right goes back, from anywhere but
  // sideways UI or from the left edge where that is the page's
  // (../nav-drawer/sideways.ts). The list has nothing beside it to pan to.
  const landRef = useRef(landAt);
  landRef.current = landAt;
  const putRef = useRef(put);
  putRef.current = put;
  useEffect(() => {
    if (!on || level === 0) return undefined;
    const from = level;
    const takesEdge = pageTakesEdge();
    let p: null | { x0: number; y0: number; w: number; on: boolean; dx: number } = null;
    const offsetOf = (dx: number, w: number) => Math.max(0, Math.min(MESSAGES_AT[1], MESSAGES_AT[from] - dx / w));
    const move = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!p || !touch) return;
      // In reading direction, as the Communities drawer's pan reads it: `dx > 0`
      // is the swipe back, whichever way the screen runs.
      const dx = (touch.clientX - p.x0) * dirSign();
      const dy = touch.clientY - p.y0;
      if (!p.on) {
        if (isPan(dx, dy) && dx > 0) {
          // Its moves may not be cancelable, and the pan follows them all the
          // same: WebKit and Chromium decide at touchstart whether a touch's
          // moves wait for the page, and in the iPhone app they were
          // uncancelable over plain messages; standing down on them left the
          // swipe dead there.
          p.on = true;
          fingerOn.current = true;
        } else if (Math.abs(dy) > PAN_SLOP_PX || (from === 1 && dx < -PAN_SLOP_PX)) { stop(); return; } else return;
      }
      if (e.cancelable) e.preventDefault();
      p.dx = dx;
      const offset = offsetOf(dx, p.w);
      putRef.current(offset, false);
      messagesDepth.set(depthIn(MESSAGES_AT, offset));
    };
    const stop = () => {
      p = null;
      document.removeEventListener('touchmove', move);
    };
    const down = (e: TouchEvent) => {
      stop();
      const touch = e.touches[0];
      if (e.touches.length !== 1 || !touch) return;
      const target = e.target as Element | null;
      const layout = layoutRef.current;
      if (!target || !layout || !layout.contains(target)) return;
      const rtl = dirSign() === -1;
      const pastEdge = rtl ? touch.clientX < window.innerWidth - EDGE_PX : touch.clientX > EDGE_PX;
      const sideways = pastEdge && startsOnSideways(target, layout, window);
      if (!swipeBackMayStart({ x: touch.clientX, takesEdge, sideways, rtl, width: window.innerWidth })) return;
      p = { x0: touch.clientX, y0: touch.clientY, w: Math.max(1, (layout.clientWidth || 1) - stripWidth()), on: false, dx: 0 };
      document.addEventListener('touchmove', move, { passive: false });
    };
    const up = () => {
      const was = p;
      stop();
      fingerOn.current = false;
      if (!was || !was.on) return;
      // A row the finger started on is not pressed by the pan.
      swallow.current = true;
      window.setTimeout(() => { swallow.current = false; }, 0);
      landRef.current(from, offsetOf(was.dx, was.w), was.dx);
    };
    document.addEventListener('touchstart', down, { passive: true });
    document.addEventListener('touchend', up, { passive: true });
    document.addEventListener('touchcancel', up, { passive: true });
    return () => {
      stop();
      document.removeEventListener('touchstart', down);
      document.removeEventListener('touchend', up);
      document.removeEventListener('touchcancel', up);
    };
  }, [on, level]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    on,
    level,
    handlers: on ? {
      onClickCapture: (e) => {
        if (!swallow.current) return;
        swallow.current = false;
        e.preventDefault();
        e.stopPropagation();
      },
    } : null,
  };
}
