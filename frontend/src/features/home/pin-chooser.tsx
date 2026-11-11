/**
 * THE ONE PINNED GRID'S CHOOSER: what a tap on a tile asks.
 *
 * Home had two pinned sections, Pinned apps (a tile opened the app) and
 * Pinned communities (a tile opened the community's hub). They are one grid
 * now (`#app-list`, ./home.js `Home.onHome`), and a community and its app are
 * one tile, so a tap asks which of the two you meant: Open app, or Go to
 * community, with the votes it waits on you for beside it.
 *
 * It is drawn and placed like the dev board's vote picker
 * (features/dev-board/card/dev-card.tsx), the other control on the platform
 * that answers a tap with a small choice:
 *
 *   pointer  an anchored popover under the tile, placed by
 *            lib/anchor-popover.ts (right edges aligned, flipped above when
 *            there is no room below) and taken down by lib/popover-dismiss.ts
 *            (a click outside, Escape, a resize, a scroll that moved the
 *            tile). Focus goes to Open app, so Enter opens it.
 *   touch    the kit's bottom sheet (`PlatformUI.sheet`), whose content is a
 *            portal this component fills; the kit's action sheet where no
 *            sheet can be had.
 *
 * Its state is a small store rather than the grid's: a tile opens it, and the
 * one `<PinChooser/>` beside `#app-list` (./app-grid.tsx) draws it. Closed,
 * it renders nothing, so the prerendered document is unchanged.
 *
 * A hold or right-click on a tile is still its full menu (home.js
 * openCardMenu), and a tile being arranged in edit mode opens nothing.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { PlayIcon, UserGroupIcon } from '@/components/ui/icons';
import { GroupedList, ListRow } from '@/components/ui/grouped-list';

import { clampPopoverHeight, placeUnderAnchor, type AnchorRect } from '../../lib/anchor-popover';
import { useMessages } from '../../lib/i18n/react';
import { t as message } from '../../lib/i18n/runtime';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { createStore } from '../../lib/plain-store.js';
import { anchorRectOf, useAnchoredDismiss } from '../../lib/popover-dismiss';
import { useStoreState } from '../../lib/use-store-state';

/** What the chooser is about: one tile's project. */
export interface PinChoice {
  slug: string;
  name: string;
  /** The votes its community waits on you for; 0 says nothing. */
  votes: number;
}

interface ChooserState {
  choice: PinChoice | null;
  /** 'popover' under a pointer, 'sheet' on touch; null while closed. */
  mode: 'popover' | 'sheet' | null;
  rect: AnchorRect | null;
  anchor: HTMLElement | null;
  /** The kit sheet's content element, the portal's target. */
  sheetEl: HTMLElement | null;
}

const CLOSED: ChooserState = { choice: null, mode: null, rect: null, anchor: null, sheetEl: null };

export const pinChooserStore = createStore<ChooserState>(CLOSED);

/** The open kit sheet, so closing the chooser takes it down too. */
let sheetHandle: { dismiss: () => void } | null = null;

export function closePinChooser(): void {
  const handle = sheetHandle;
  sheetHandle = null;
  pinChooserStore.set(CLOSED);
  // Its onDismiss lands here again, with nothing left to close.
  if (handle) handle.dismiss();
}

function win(): any {
  return typeof window !== 'undefined' ? (window as any) : null;
}

/** Open the app, as a tap on a Pinned apps tile always did. */
export function openPinnedApp(slug: string): void {
  closePinChooser();
  win()?.App?.navigateToApp?.(slug);
}

/** Open the community's hub, as a tap on a Pinned communities tile did (the door rule). */
export function openPinnedCommunity(slug: string): void {
  closePinChooser();
  win()?.Home?.openHub?.(slug);
}

/**
 * Ask about `choice`, from the tile `anchor`. A second tap on the tile whose
 * chooser is up closes it, as the vote button's does.
 */
export function openPinChooser(choice: PinChoice, anchor: HTMLElement): void {
  const current = pinChooserStore.get();
  if (current.choice && current.choice.slug === choice.slug) {
    closePinChooser();
    return;
  }
  closePinChooser();
  const kit = win()?.PlatformUI;
  if (kit && typeof kit.isTouch === 'function' && kit.isTouch()) {
    if (typeof kit.sheet === 'function' && typeof document !== 'undefined') {
      const panel = document.createElement('div');
      panel.className = 'home-pin-chooser-sheet-host';
      let handle: { dismiss: () => void } | null = null;
      handle = kit.sheet({
        contentEl: panel,
        onDismiss: () => {
          if (sheetHandle === handle) sheetHandle = null;
          if (pinChooserStore.get().sheetEl === panel) pinChooserStore.set(CLOSED);
        },
      });
      if (handle && typeof handle.dismiss === 'function') {
        sheetHandle = handle;
        pinChooserStore.set({ choice, mode: 'sheet', rect: null, anchor, sheetEl: panel });
        return;
      }
    }
    if (typeof kit.actionSheet === 'function') {
      kit.actionSheet({
        actions: [
          { label: message('home:chooser.openApp'), handler: () => openPinnedApp(choice.slug) },
          {
            label: choice.votes > 0
              ? message('home:chooser.communityVotes', { count: choice.votes })
              : message('home:chooser.community'),
            handler: () => openPinnedCommunity(choice.slug),
          },
        ],
      });
      return;
    }
  }
  pinChooserStore.set({ choice, mode: 'popover', rect: anchorRectOf(anchor), anchor, sheetEl: null });
}

// The popover's frame and rows: `.dev-vote-pop`'s box (16px corners, the page
// colour, one border, the same shadow) and the vote picker's grey label over
// two 44px rows. The blue disc marks the action the tap most often means.
const POP = 'fixed z-[2000] box-border flex w-[264px] flex-col gap-0.5 rounded-[16px] border '
  + 'border-[color:var(--border)] bg-[color:var(--bg-primary)] px-2 pb-2 pt-2.5 '
  + 'shadow-[0_12px_32px_rgba(0,0,0,0.28)]';
const POP_LABEL = 'truncate px-2 pb-1 text-[11.5px] font-medium text-[color:var(--text-muted)]';
const POP_ROW = 'flex min-h-11 w-full items-center gap-3 rounded-xl px-2 text-start text-[15px] font-semibold '
  + 'text-zinc-900 hover:bg-zinc-100 focus-visible:bg-zinc-100 focus-visible:outline-none '
  + 'dark:text-zinc-100 dark:hover:bg-zinc-800 dark:focus-visible:bg-zinc-800';
const DISC = 'flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px]';
const DISC_APP = `${DISC} bg-violet-600 text-white`;
const DISC_COMMUNITY = `${DISC} bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200`;
const VOTES = 'shrink-0 text-[13px] font-semibold text-[color:var(--accent)]';

function Glyphs() {
  return {
    app: <PlayIcon className="h-3.5 w-3.5" strokeWidth="2.2" aria-hidden="true" />,
    community: <UserGroupIcon className="h-[17px] w-[17px]" aria-hidden="true" />,
  };
}

function PopoverPanel({ choice }: { choice: PinChoice }) {
  const t = useMessages('home');
  const tc = useMessages('communities');
  const g = Glyphs();
  return (
    <>
      <p className={POP_LABEL}>{choice.name}</p>
      <button type="button" className={POP_ROW} data-pin-choice="app" onClick={() => openPinnedApp(choice.slug)}>
        <span className={DISC_APP}>{g.app}</span>
        <span className="min-w-0 flex-1 truncate">{t('home:chooser.openApp')}</span>
      </button>
      <button type="button" className={POP_ROW} data-pin-choice="community" onClick={() => openPinnedCommunity(choice.slug)}>
        <span className={DISC_COMMUNITY}>{g.community}</span>
        <span className="min-w-0 flex-1 truncate">{t('home:chooser.community')}</span>
        {choice.votes > 0 ? <span className={VOTES}>{tc('communities:row.toVote', { count: choice.votes })}</span> : null}
      </button>
    </>
  );
}

function SheetPanel({ choice }: { choice: PinChoice }) {
  const t = useMessages('home');
  const tc = useMessages('communities');
  const g = Glyphs();
  return (
    <div className="flex flex-col gap-3 px-4 pb-5 pt-1" data-pin-chooser-sheet={choice.slug}>
      <h2 className="truncate px-1 text-[17px] font-[650] text-zinc-900 dark:text-zinc-100">{choice.name}</h2>
      <GroupedList>
        <ListRow
          as="button"
          data-pin-choice="app"
          chevron={false}
          leading={<span className={DISC_APP}>{g.app}</span>}
          title={t('home:chooser.openApp')}
          onClick={() => openPinnedApp(choice.slug)}
        />
        <ListRow
          as="button"
          data-pin-choice="community"
          leading={<span className={DISC_COMMUNITY}>{g.community}</span>}
          title={t('home:chooser.community')}
          trailing={choice.votes > 0 ? <span className={VOTES}>{tc('communities:row.toVote', { count: choice.votes })}</span> : null}
          onClick={() => openPinnedCommunity(choice.slug)}
        />
      </GroupedList>
      <button
        type="button"
        className="min-h-12 w-full rounded-2xl bg-zinc-100 text-[16px] font-semibold text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
        onClick={closePinChooser}
      >
        {t('core:common.cancel')}
      </button>
    </div>
  );
}

/** Drawn once, beside `#app-list`. Nothing while closed. */
export function PinChooser() {
  const t = useMessages('home');
  const state = useStoreState(pinChooserStore);
  const popRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  anchorRef.current = state.anchor;
  const [measuredH, setMeasuredH] = useState<number | null>(null);
  const open = state.mode === 'popover' && !!state.choice && !!state.rect;
  const slug = state.choice?.slug || '';

  // The anchor first: popover-dismiss measures it to tell a scroll that moved
  // the tile from one that did not.
  useAnchoredDismiss(open, [anchorRef, popRef], closePinChooser);

  // Placed again with its real height before the first paint, as the vote
  // picker is (#3595). scrollHeight, so a capped panel measures stably.
  useIsomorphicLayoutEffect(() => {
    if (!open) { if (measuredH !== null) setMeasuredH(null); return; }
    const h = popRef.current?.scrollHeight;
    if (h && h !== measuredH) setMeasuredH(h);
  }, [open, slug, measuredH]);

  // The tap most often means the app: focus starts there, so Enter opens it.
  useEffect(() => {
    if (!state.choice) return;
    const root = state.mode === 'sheet' ? state.sheetEl : popRef.current;
    root?.querySelector<HTMLElement>('[data-pin-choice="app"]')?.focus({ preventScroll: true });
  }, [state.mode, slug, state.sheetEl]);

  // The chooser belongs to a tile of Home's: leaving Home takes it down.
  useEffect(() => {
    if (!state.choice || typeof window === 'undefined') return undefined;
    const shut = () => closePinChooser();
    window.addEventListener('hashchange', shut);
    return () => window.removeEventListener('hashchange', shut);
  }, [slug]);

  if (!state.choice) return null;
  if (state.mode === 'sheet' && state.sheetEl) {
    return createPortal(<SheetPanel choice={state.choice} />, state.sheetEl);
  }
  if (!open || typeof document === 'undefined' || !state.rect) return null;
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const height = measuredH ?? 136;
  const pos = placeUnderAnchor(state.rect, { width: 264, height }, viewport);
  const maxH = clampPopoverHeight({ height }, viewport);
  return createPortal(
    <div
      ref={popRef}
      id="home-pin-chooser"
      className={POP}
      role="dialog"
      aria-label={t('home:chooser.label', { name: state.choice.name })}
      data-pin-chooser={state.choice.slug}
      style={{ top: `${pos.top}px`, left: `${pos.left}px`, maxHeight: maxH ? `${maxH}px` : undefined, overflowY: maxH ? 'auto' : undefined }}
      onClick={(ev) => ev.stopPropagation()}
    >
      <PopoverPanel choice={state.choice} />
    </div>,
    document.body,
  );
}
