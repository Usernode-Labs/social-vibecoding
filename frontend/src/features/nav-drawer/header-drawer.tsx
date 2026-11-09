/**
 * THE HEADER, ON A PHONE'S COMMUNITY, MESSAGES AND HOMEROOM BOT (Evan's
 * design, 18 Oct 2026; 3 Nov 2026: "simplify on mobile").
 *
 * While one of them applies, the platform header draws three things of its
 * own in place of the places button and the community switcher:
 *
 *   DrawerBack     the left group's button. On a community's Hub it is the
 *                  GRID (the All communities glyph), which opens every
 *                  community you are in; on any other place of it the ARROW
 *                  up to the Hub (a page under a place, to that place). In
 *                  Messages and on the bot tab it is the arrow back to the
 *                  list, arriving from the right as the conversation slides
 *                  in. A button, not an href'd #back-btn: an arrow with an
 *                  address is what turns on WebKit's own history swipe
 *                  (../header/native-back-navigation.ts).
 *   DrawerTitles   in the h1: the community over its place ("Workshop",
 *                  "#general"), the community alone on its Hub; in Messages
 *                  "Messages" or the conversation over who it is with; on
 *                  the bot tab "Homeroom bot" or "Main Chat" over its line.
 *   DrawerUntint   the bar as it is off a community, laid over the
 *                  community's colour. A community's page rests at the full
 *                  colour; its ink is the bar's white (`--nav-k`, app.css).
 *
 * Every one of them is drawn from its drawer's live depth (./drawer-math.ts
 * headerFrame): Messages' and the bot tab's move with their strips, a tap
 * animating them and a pan setting them from the finger; a community's
 * rests on its page (./drawer-store.ts). React renders the words; the
 * frames never re-render.
 */

import { useEffect, useRef, type ReactNode } from 'react';

import { ChevronLeftIcon } from '@/components/ui/icons';
import { Wordmark } from '@/components/ui/wordmark';

import { useMessages } from '../../lib/i18n/react';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { openPlace } from '../dev-board/workshop/place-store';
import { litPlace, placeHandle, placeName, type PlaceKey } from '../dev-board/workshop/places';
import { improveStore } from '../improve/improve-store.js';
import { botBack, botDepth, botDrawerStore } from './bot-drawer';
import { headerFrame, titleSlot, type HeaderFrame } from './drawer-math';
import { communitiesDepth, drawerStore, reducedMotion, type DepthChannel } from './drawer-store';
import { messagesBack, messagesDepth, messagesDrawerStore } from './messages-drawer';
import { dirSign } from '../../lib/i18n/direction';

type Mode = 'communities' | 'messages' | 'bot' | null;

/** Which drawer the header is drawn for: a community's, Messages', the bot tab's, or none. */
export function useDrawerMode(): Mode {
  const { on } = useStoreState(drawerStore);
  const { on: messages } = useStoreState(messagesDrawerStore);
  const { on: bot } = useStoreState(botDrawerStore);
  return on ? 'communities' : messages ? 'messages' : bot ? 'bot' : null;
}

/** A drawer with no colour and two levels, list and conversation: Messages and the bot tab. */
function twoLevel(mode: Mode): boolean {
  return mode === 'messages' || mode === 'bot';
}

function channelOf(mode: Mode): DepthChannel {
  return mode === 'messages' ? messagesDepth : mode === 'bot' ? botDepth : communitiesDepth;
}

/** Draw `apply` from the drawer's live depth now, and on every change, while mounted. */
function useHeaderFrame(
  mode: Mode,
  apply: (frame: HeaderFrame) => void,
  slot: () => number = () => 0,
  redraw?: { current: () => void },
): void {
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const slotRef = useRef(slot);
  slotRef.current = slot;
  useIsomorphicLayoutEffect(() => {
    if (!mode) return undefined;
    const channel = channelOf(mode);
    const drawAt = (f: number) => applyRef.current(headerFrame(f, slotRef.current(), reducedMotion(), twoLevel(mode)));
    if (redraw) redraw.current = () => drawAt(channel.live());
    drawAt(channel.live());
    return channel.on(drawAt);
  }, [mode]);
}

/** A box's start edge as a figure that grows in reading direction, for the slot's distance. */
function inlineStart(el: Element): number {
  const box = el.getBoundingClientRect();
  return dirSign() === -1 ? -box.right : box.left;
}

/** `x` is in reading direction: headerFrame's sums are the same in Arabic, drawn the other way. */
function translate(x: number, y = 0): string {
  return x || y ? `translate3d(${x * dirSign()}px, ${y}px, 0)` : '';
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

/**
 * Up from a community's place: a page under a place (All items, the bot's
 * slots, the plan) to that place, any other place to the Hub. An ordinary
 * navigation, as a press on the Hub's row for it is.
 */
export function upFromPlace(slug: string | null, place: string): void {
  if (!slug) return;
  const key = place as PlaceKey;
  const lit = litPlace(key);
  openPlace(slug, lit !== key ? lit : 'status');
}

/**
 * ONE HOME (#6361): the Hub's way back is Home, where your communities are
 * now. It was a grid of every community (#communities), which Home's Pinned
 * communities and its All communities tile replace.
 */
export function toHome(): void {
  const app = (window as unknown as { App?: { navigateHome?: (opts?: unknown) => void } }).App;
  if (app?.navigateHome) app.navigateHome();
  else window.location.hash = '#home';
}

export function DrawerBack(): ReactNode {
  const t = useMessages('core');
  const mode = useDrawerMode();
  const { shown } = useStoreState(drawerStore);
  const { subTab } = useStoreState(improveStore) as { subTab: string | null };
  if (mode === 'messages') return <BackDisc mode={mode} label={t('core:header.drawer.toMessages')} onBack={messagesBack} />;
  if (mode === 'bot') return <BackDisc mode={mode} label={t('core:header.drawer.toBot')} onBack={botBack} />;
  if (mode !== 'communities') return null;
  // A request's or a change's page has ONE back: the chip above its sheet,
  // which names the place it returns to (../dev-board/topic/topic-back.tsx,
  // where the header draws no arrow). This arrow beside it made two, to two
  // places (audit N05, 1 Nov 2026).
  if (subTab === 'topic') return null;
  if (shown.place === 'status') {
    return <BackDisc mode={mode} label={t('core:header.drawer.toHome')} onBack={toHome} />;
  }
  const up = litPlace(shown.place as PlaceKey);
  const label = up !== shown.place && up !== 'status'
    ? t('core:header.drawer.toPlace', { place: placeName(up) })
    : t('core:header.drawer.toHub', { community: shown.name });
  return <BackDisc mode={mode} label={label} onBack={() => upFromPlace(shown.slug, shown.place)} />;
}

function BackDisc({ mode, label, onBack }: { mode: Mode; label: string; onBack: () => void }): ReactNode {
  const ref = useRef<HTMLButtonElement>(null);
  useHeaderFrame(mode, (frame) => {
    const el = ref.current;
    if (!el) return;
    el.style.opacity = String(frame.back.opacity);
    el.style.transform = translate(frame.back.x);
    el.style.pointerEvents = frame.back.live ? '' : 'none';
    el.tabIndex = frame.back.live ? 0 : -1;
    el.setAttribute('aria-hidden', frame.back.live ? 'false' : 'true');
  });
  return (
    <button
      ref={ref}
      type="button"
      className={BACK_CLASS}
      data-nav-drawer-back=""
      aria-label={label}
      title={label}
      onClick={() => onBack()}
    >
      <ChevronLeftIcon className="w-5 h-5" aria-hidden="true" />
    </button>
  );
}

export function DrawerTitles(): ReactNode {
  const t = useMessages('core');
  const mode = useDrawerMode();
  const { shown } = useStoreState(drawerStore);
  const conversation = useStoreState(messagesDrawerStore);
  const bot = useStoreState(botDrawerStore);
  const messages = mode === 'messages';
  const onBot = mode === 'bot';
  const two = messages ? conversation : onBot ? bot : null;
  // A community's Hub names the community alone, beside the arrow home:
  // its title sits as a name alone does (headerFrame at 1), with no line.
  const hub = mode === 'communities' && shown.place === 'status';
  // Where it rests, for a screen reader: the title on show, and the small
  // line only where it says something.
  const outerShown = two ? two.level === 0 : false;
  const subShown = two ? two.level === 1 && !!two.sub : !hub;
  const box = useRef<HTMLSpanElement>(null);
  const outer = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const sub = useRef<HTMLElement>(null);
  // How far the bar's left edge is from where the name sits: the arrow and
  // its gap. A list's title ("Messages") sits there, with no arrow beside it.
  // Measured when it mounts and when the window changes, never per frame.
  const slot = useRef(44);
  const redraw = useRef(() => {});
  const hubRef = useRef(hub);
  hubRef.current = hub;
  useIsomorphicLayoutEffect(() => {
    const measure = () => {
      const el = box.current;
      const left = el?.closest('#platform-header')?.querySelector('.platform-header-left');
      if (!el || !left) return;
      const at = titleSlot(
        { laidOut: el.getClientRects().length > 0, left: inlineStart(el) },
        { laidOut: left.getClientRects().length > 0, left: inlineStart(left) },
      );
      if (at !== null && at !== slot.current) {
        slot.current = at;
        redraw.current();
      }
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  useHeaderFrame(mode, (frame) => {
    const a = outer.current;
    const b = inner.current;
    const s = sub.current;
    if (!a || !b || !s) return;
    const words = hubRef.current ? headerFrame(1, slot.current, reducedMotion()).inner : frame.inner;
    a.style.opacity = String(frame.outer.opacity);
    a.style.transform = translate(frame.outer.x, frame.outer.y);
    b.style.opacity = String(words.opacity);
    b.style.transform = translate(words.x, words.y);
    s.style.opacity = String(words.subOpacity);
    s.style.transform = translate(words.subX, words.subY);
  }, () => slot.current, redraw);
  // From the Hub to a place and back the page's line comes and goes.
  useEffect(() => { redraw.current(); }, [hub]);
  const outerName = messages ? t('core:header.drawer.messages') : onBot ? t('core:tabs.ai') : t('core:header.communities');
  return (
    <span ref={box} className="nav-drawer-titles" data-nav-drawer-titles="">
      <span ref={outer} className="nav-drawer-title" aria-hidden={!outerShown || undefined}>
        <b className="nav-drawer-title-name">{outerName}</b>
      </span>
      <span ref={inner} className="nav-drawer-title" aria-hidden={outerShown || undefined}>
        <b className="nav-drawer-title-name">
          {two ? two.title : shown.selfHosted ? (
            <>
              <Wordmark className="nav-drawer-title-mark" aria-hidden="true" />
              <span className="sr-only">{shown.name}</span>
            </>
          ) : shown.name}
        </b>
        <small ref={sub} className="nav-drawer-title-page" aria-hidden={!subShown || undefined}>
          {two ? two.sub : hub ? '' : pageLabel(shown.place)}
        </small>
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
  useHeaderFrame('communities', (frame) => {
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
