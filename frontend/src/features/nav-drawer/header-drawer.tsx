/**
 * THE HEADER, ON A PHONE'S COMMUNITY AND MESSAGES (Evan's design, 18 Oct
 * 2026; 3 Nov 2026: "simplify on mobile"; 14 Nov 2026: the Homeroom bot
 * tab's two-level header went with Main Chat, and the tab keeps the plain
 * header that names it, a thread drawing its own head under it).
 *
 * While one of them applies, the platform header draws three things of its
 * own in place of the places button and the community switcher:
 *
 *   DrawerBack     the left group's button. On a community's Hub it is the
 *                  GRID (the All communities glyph), which opens every
 *                  community you are in; on any other place of it the ARROW
 *                  up to the Hub (a page under a place, to that place). In
 *                  Messages it is the arrow back to the list, arriving from
 *                  the right as the conversation slides in. A button, not an href'd #back-btn: an arrow with an
 *                  address is what turns on WebKit's own history swipe
 *                  (../header/native-back-navigation.ts).
 *   DrawerTitles   in the h1: the community over its place ("Hub",
 *                  "Workshop", "#general"); in Messages
 *                  "Messages" or the conversation over who it is with.
 *   DrawerUntint   the bar as it is off a community, laid over the
 *                  community's colour. A community's page rests at the full
 *                  colour; its ink is the bar's white (`--nav-k`, app.css).
 *
 * Every one of them is drawn from its drawer's live depth (./drawer-math.ts
 * headerFrame): Messages' moves with its strip, a tap animating it and a
 * pan setting it from the finger; a community's
 * rests on its page (./drawer-store.ts). React renders the words; the
 * frames never re-render.
 */

import { useRef, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { ChevronLeftIcon } from '@/components/ui/icons';
import { Wordmark } from '@/components/ui/wordmark';

import { useMessages } from '../../lib/i18n/react';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { topicBack } from '../dev-board/topic/topic-page';
import { useTopicBackName } from '../dev-board/topic/topic-back';
import { openPlace } from '../dev-board/workshop/place-store';
import { litPlace, placeName, placeTitleHandle, type PlaceKey } from '../dev-board/workshop/places';
import { improveStore } from '../improve/improve-store.js';
import { headerFrame, titleSlot, type HeaderFrame } from './drawer-math';
import { communitiesDepth, drawerStore, reducedMotion, type DepthChannel } from './drawer-store';
import { messagesBack, messagesDepth, messagesDrawerStore } from './messages-drawer';
import { dirSign } from '../../lib/i18n/direction';

type Mode = 'communities' | 'messages' | null;

/** Which drawer the header is drawn for: a community's, Messages', or none. */
export function useDrawerMode(): Mode {
  const { on } = useStoreState(drawerStore);
  const { on: messages } = useStoreState(messagesDrawerStore);
  return on ? 'communities' : messages ? 'messages' : null;
}

/** A drawer with no colour and two levels, list and conversation: Messages. */
function twoLevel(mode: Mode): boolean {
  return mode === 'messages';
}

function channelOf(mode: Mode): DepthChannel {
  return mode === 'messages' ? messagesDepth : communitiesDepth;
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
  const handle = placeTitleHandle(place);
  return handle ? `#${handle}` : placeName(place as PlaceKey);
}

// The bar's back disc (platform-header.tsx BACK_BTN_CLASS): the Button
// primitive's `brandTint` with the header's ink, at the disc's 28px.
const BACK_CLASS = 'nav-drawer-back inline-flex items-center justify-center w-7 h-7 un-touch-target';

/**
 * Up from a community's place: a page under a place (All items, the bot's
 * slots, the plan) to that place, any other place to the Hub. An ordinary
 * navigation, as a press on the Hub's row for it is.
 */
export function upFromPlace(slug: string | null, place: string): void {
  if (!slug) return;
  const key = place as PlaceKey;
  const lit = litPlace(key);
  // #7045: up, not across: a step Back when the parent is the entry below, so Back from it does not return here.
  openPlace(slug, lit !== key ? lit : 'status', { up: true });
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
  const topicName = useTopicBackName();
  // One look: the drawer can be the Homeroom bot tab's, whose arrow names its own list.
  const { back } = useStoreState(messagesDrawerStore);
  if (mode === 'messages') return <BackDisc mode={mode} label={back || t('core:header.drawer.toMessages')} onBack={messagesBack} />;
  if (mode !== 'communities') return null;
  // A request's or a change's page has ONE back, to the place its chip names
  // (../dev-board/topic/topic-back.tsx; two arrows to two places was audit
  // N05, 1 Nov 2026). ONE LOOK (25 Nov 2026): on a phone that back is the
  // bar's white disc, as on every other page of the community, and the chip
  // in the title card is put away (app.css, ONE LOOK · A PROJECT'S HUB AND
  // ITS REQUESTS). The disc presses the chip, so where it goes, and whether
  // it steps Back or follows the link, stay the chip's one answer.
  if (subTab === 'topic') return topicName ? <BackDisc mode={mode} label={topicName} onBack={topicBack} /> : null;
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
    <Button
      ref={ref}
      type="button"
      variant="brandTint"
      size="none"
      ink="brand"
      className={BACK_CLASS}
      data-nav-drawer-back=""
      aria-label={label}
      title={label}
      onClick={() => onBack()}
    >
      <ChevronLeftIcon className="w-5 h-5" aria-hidden="true" />
    </Button>
  );
}

export function DrawerTitles(): ReactNode {
  const t = useMessages('core');
  const mode = useDrawerMode();
  const { shown } = useStoreState(drawerStore);
  const conversation = useStoreState(messagesDrawerStore);
  const messages = mode === 'messages';
  const two = messages ? conversation : null;
  // ONE LOOK (25 Nov 2026): a community's Hub says its place under the
  // name, "Hub", as every other place does ("Workshop", "#general"). It
  // named the community alone, as a name alone is drawn (headerFrame at 1),
  // with no line, until then.
  // Where it rests, for a screen reader: the title on show, and the small
  // line only where it says something.
  const outerShown = two ? two.level === 0 : false;
  const subShown = two ? two.level === 1 && !!two.sub : true;
  const box = useRef<HTMLSpanElement>(null);
  const outer = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const sub = useRef<HTMLElement>(null);
  // How far the bar's left edge is from where the name sits: the arrow and
  // its gap. A list's title ("Messages") sits there, with no arrow beside it.
  // Measured when the bar's layout changes, never per frame.
  //
  // PHONE REVIEW #4 (23 Nov 2026): it was measured once, when the titles
  // mounted, and on a window resize. They mount on whichever screen first
  // draws the drawer's header and stay mounted from one tab to the next, so
  // the slot was the first screen's: a request's page, which draws no arrow
  // (its group is out of the bar), read 0 and left "Messages" 44px to the
  // right of its place; a community's page read the wrong distance and slid
  // it 78px left, off the screen. It is measured again whenever the drawer
  // changes (mode, level, Hub or not) and whenever the bar's left group or
  // the titles change size, and it never steps past the bar's padding.
  const slot = useRef(44);
  const redraw = useRef(() => {});
  const measure = useRef(() => {});
  measure.current = () => {
    const el = box.current;
    const bar = el?.closest('#platform-header');
    const left = bar?.querySelector('.platform-header-left');
    if (!el || !bar || !left) return;
    const style = getComputedStyle(bar);
    const pad = parseFloat(dirSign() === -1 ? style.paddingRight : style.paddingLeft) || 0;
    const at = titleSlot(
      { laidOut: el.getClientRects().length > 0, left: inlineStart(el) },
      { laidOut: left.getClientRects().length > 0, left: inlineStart(left) },
      inlineStart(bar) + pad,
    );
    if (at !== null && at !== slot.current) {
      slot.current = at;
      redraw.current();
    }
  };
  useIsomorphicLayoutEffect(() => {
    const run = () => measure.current();
    run();
    window.addEventListener('resize', run);
    const left = box.current?.closest('#platform-header')?.querySelector('.platform-header-left');
    const watch = typeof ResizeObserver === 'function' ? new ResizeObserver(run) : null;
    if (watch && box.current) watch.observe(box.current);
    if (watch && left) watch.observe(left);
    return () => {
      window.removeEventListener('resize', run);
      watch?.disconnect();
    };
  }, []);
  // The drawer it is drawn for, and where it rests, move the boxes: measure
  // again in the same frame, before the paint.
  useIsomorphicLayoutEffect(() => { measure.current(); }, [mode, two?.level]);
  useHeaderFrame(mode, (frame) => {
    const a = outer.current;
    const b = inner.current;
    const s = sub.current;
    if (!a || !b || !s) return;
    const words = frame.inner;
    a.style.opacity = String(frame.outer.opacity);
    a.style.transform = translate(frame.outer.x, frame.outer.y);
    b.style.opacity = String(words.opacity);
    b.style.transform = translate(words.x, words.y);
    s.style.opacity = String(words.subOpacity);
    s.style.transform = translate(words.subX, words.subY);
  }, () => slot.current, redraw);
  const outerName = messages ? conversation.list || t('core:header.drawer.messages') : t('core:header.communities');
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
          {two ? two.sub : pageLabel(shown.place)}
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

