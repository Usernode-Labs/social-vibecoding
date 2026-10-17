/**
 * THE HEADER, MOVING WITH THE PHONE'S DRAWER (Evan's design, 18 Oct 2026).
 *
 * While the drawer applies (./drawer-store.ts `on`: a phone, a community's
 * page), the platform header draws three things of its own in place of the
 * places button and the community switcher:
 *
 *   DrawerBack     the back arrow, in the left group: up one level. None on
 *                  level 0, the outermost. A button, not an href'd #back-btn:
 *                  an arrow with an address is what turns on WebKit's own
 *                  history swipe (../header/native-back-navigation.ts), which
 *                  would fight the drawer's pan.
 *   DrawerTitles   in the h1: "Communities" on level 0, the community's name
 *                  on its places, and its name over the page's ("Workshop",
 *                  "#general") on a page.
 *   DrawerUntint   the bar as it is off a community, laid over the
 *                  community's colour and faded out with depth, so the colour
 *                  blends in from level 0 to level 1 and the bar at rest on a
 *                  page is exactly the tinted bar it was. Its ink follows the
 *                  same value (`--nav-k`, app.css), from the bar's own to white.
 *
 * Every one of them is drawn from the live depth (./drawer-math.ts
 * headerFrame): a tap animates it over the slide and a pan sets it from the
 * finger, and each writes only its own nodes' transform, opacity and
 * `--nav-k`. React renders the words; the frames never re-render.
 */

import { useRef, type ReactNode } from 'react';

import { ChevronLeftIcon } from '@/components/ui/icons';
import { Wordmark } from '@/components/ui/wordmark';

import { useMessages } from '../../lib/i18n/react';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { placeHandle, placeName, type PlaceKey } from '../dev-board/workshop/places';
import { headerFrame, type HeaderFrame } from './drawer-math';
import { back, drawerStore, liveDepth, onDepth, reducedMotion } from './drawer-store';

/** Draw `apply` from the live depth now, and on every change, while mounted. */
function useHeaderFrame(
  apply: (frame: HeaderFrame) => void,
  slot: () => number = () => 0,
  redraw?: { current: () => void },
): void {
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const slotRef = useRef(slot);
  slotRef.current = slot;
  useIsomorphicLayoutEffect(() => {
    const drawAt = (f: number) => applyRef.current(headerFrame(f, slotRef.current(), reducedMotion()));
    if (redraw) redraw.current = () => drawAt(liveDepth());
    drawAt(liveDepth());
    return onDepth(drawAt);
  }, []);
}

function translate(x: number, y = 0): string {
  return x || y ? `translate3d(${x}px, ${y}px, 0)` : '';
}

/** A place's words in the header: a channel by its #handle. */
export function pageLabel(place: string): string {
  const handle = placeHandle(place);
  return handle ? `#${handle}` : placeName(place as PlaceKey);
}

// The bar's back disc (platform-header.tsx BACK_BTN_CLASS), as complete literals.
const BACK_CLASS = 'nav-drawer-back inline-flex items-center justify-center w-7 h-7 rounded-full'
  + ' border border-[color:var(--brand-line)] bg-[color:var(--brand-tint)]'
  + ' text-[color:var(--brand-ink)] un-touch-target';

export function DrawerBack(): ReactNode {
  const t = useMessages('core');
  const { on, level, shown } = useStoreState(drawerStore);
  if (!on) return null;
  return <BackDisc label={level === 2 ? t('core:header.drawer.toPlaces', { community: shown.name }) : t('core:header.drawer.toCommunities')} />;
}

function BackDisc({ label }: { label: string }): ReactNode {
  const ref = useRef<HTMLButtonElement>(null);
  useHeaderFrame((frame) => {
    const el = ref.current;
    if (!el) return;
    el.style.opacity = String(frame.back.opacity);
    el.style.transform = translate(frame.back.x);
    el.style.pointerEvents = frame.back.live ? '' : 'none';
    el.tabIndex = frame.back.live ? 0 : -1;
    el.setAttribute('aria-hidden', frame.back.live ? 'false' : 'true');
  });
  return (
    <button ref={ref} type="button" className={BACK_CLASS} data-nav-drawer-back="" aria-label={label} onClick={() => back()}>
      <ChevronLeftIcon className="w-5 h-5" aria-hidden="true" />
    </button>
  );
}

export function DrawerTitles(): ReactNode {
  const t = useMessages('core');
  const { level, shown } = useStoreState(drawerStore);
  const box = useRef<HTMLSpanElement>(null);
  const outer = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const sub = useRef<HTMLElement>(null);
  // How far the bar's left edge is from where the name sits: the arrow and
  // its gap. "Communities" sits there, with no arrow beside it.
  // Measured when it mounts and when the window changes, never per frame.
  const slot = useRef(44);
  const redraw = useRef(() => {});
  useIsomorphicLayoutEffect(() => {
    const measure = () => {
      const el = box.current;
      const left = el?.closest('#platform-header')?.querySelector('.platform-header-left');
      if (!el || !left) return;
      const at = el.getBoundingClientRect().left - left.getBoundingClientRect().left;
      if (at > 0 && at !== slot.current) {
        slot.current = at;
        redraw.current();
      }
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  useHeaderFrame((frame) => {
    const a = outer.current;
    const b = inner.current;
    const s = sub.current;
    if (!a || !b || !s) return;
    a.style.opacity = String(frame.outer.opacity);
    a.style.transform = translate(frame.outer.x, frame.outer.y);
    b.style.opacity = String(frame.inner.opacity);
    b.style.transform = translate(frame.inner.x, frame.inner.y);
    s.style.opacity = String(frame.inner.subOpacity);
    s.style.transform = translate(frame.inner.subX, frame.inner.subY);
  }, () => slot.current, redraw);
  return (
    <span ref={box} className="nav-drawer-titles" data-nav-drawer-titles="">
      <span ref={outer} className="nav-drawer-title" aria-hidden={level !== 0 || undefined}>
        <b className="nav-drawer-title-name">{t('core:header.communities')}</b>
      </span>
      <span ref={inner} className="nav-drawer-title" aria-hidden={level === 0 || undefined}>
        <b className="nav-drawer-title-name">
          {shown.selfHosted ? (
            <>
              <Wordmark className="nav-drawer-title-mark" aria-hidden="true" />
              <span className="sr-only">{shown.name}</span>
            </>
          ) : shown.name}
        </b>
        <small ref={sub} className="nav-drawer-title-page" aria-hidden={level !== 2 || undefined}>{pageLabel(shown.place)}</small>
      </span>
    </span>
  );
}

export function DrawerUntint(): ReactNode {
  const { on } = useStoreState(drawerStore);
  return on ? <Untint /> : null;
}

function Untint(): ReactNode {
  const ref = useRef<HTMLSpanElement>(null);
  useHeaderFrame((frame) => {
    const el = ref.current;
    if (!el) return;
    el.style.opacity = String(1 - frame.tint);
    el.parentElement?.style.setProperty('--nav-k', String(frame.tint));
  });
  useIsomorphicLayoutEffect(() => {
    const header = ref.current?.parentElement || null;
    return () => { header?.style.removeProperty('--nav-k'); };
  }, []);
  return <span ref={ref} className="nav-drawer-untint" aria-hidden="true" />;
}
