/**
 * The Homeroom mark and its menu, for a visitor with no account who has an
 * app open (features/auth/landing.tsx, the bar over the in-page viewer).
 *
 * ── Why a visitor gets the mark now ────────────────────────────────────
 *
 * A member's bar ends in the Homeroom mark (../header/platform-mark.tsx),
 * and its menu is where a running app's "Suggest an improvement", "About",
 * "Go to community" and "Report app" live (../app-context/
 * app-context-sheet.tsx). A visitor's bar had none of it: an app open for
 * them showed its name, Pin, Sign in and Join the waitlist, so the one
 * thing Homeroom is for, changing the app you are using, was nowhere on the
 * screen. The bar now ends in the same mark, and its menu holds the
 * member's rows less what needs an account. Pin left the bar with it (a
 * visitor still pins a project from Discover, ./guest-discover.tsx).
 *
 * ── What each row does for somebody with no account ────────────────────
 *
 *   Suggest an improvement  a pop-up that says what suggesting is and asks
 *                           them to sign up or sign in first
 *                           (VisitorSuggestPrompt); a suggestion is made by
 *                           an account.
 *   About <app>             a second pane of this menu: the app's tile, its
 *                           name, what it says it is and how many are in it,
 *                           from the public directory (GET /api/public/apps).
 *   Go to community         the app's signed-out page (`#app/<slug>/dev/hub`).
 *   Report app              a report is made by an account (POST
 *                           /api/reports answers 401 without one), so the row
 *                           opens the sign-in sheet rather than hiding.
 *   Privacy · Terms         Homeroom's own two pages, in a new tab.
 *
 * ── Two presentations, one body ────────────────────────────────────────
 *
 * From 640px, a popover under the mark, its trailing edge on the mark's,
 * like a member's menu on a computer (../../lib/anchor-popover.ts,
 * ../../lib/popover-dismiss.ts). Under it, a bottom sheet presented by the
 * kit (../../lib/sheet.ts), like a member's on a phone. Nothing here is in
 * the first render: the landing draws the mark only while an app is open,
 * which it never is at hydration.
 */

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FlagIcon,
  InfoCircleIcon,
  UserGroupIcon,
  XIcon,
} from '@/components/ui/icons';
import { cn } from '@/lib/utils';

import { RichMessage, useMessages } from '../../lib/i18n/react';
import { clampPopoverHeight, placeUnderAnchor } from '../../lib/anchor-popover';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { anchorRectOf, useAnchoredDismiss } from '../../lib/popover-dismiss';
import { useSheet } from '../../lib/sheet';
import { GuestIcon } from './guest-discover';
import { type GuestApp, MIN_MEMBERS } from './guest-data';

/** Where the menu becomes a popover under the mark rather than a bottom sheet. */
export const VISITOR_MENU_POPOVER_QUERY = '(min-width: 640px)';

/** The app the menu is about: its slug and name, and its directory row when the landing has it. */
export interface VisitorMenuApp {
  slug: string;
  name: string;
  row?: GuestApp | null;
}

/** What the menu's rows do; the landing owns each of them. */
export interface VisitorMenuActions {
  onSuggest: () => void;
  onCommunity: () => void;
  onReport: () => void;
  /** Homeroom's privacy notice and terms (GET /api/public/waitlist/options); a link is left out until its address is known. */
  privacyHref?: string | null;
  termsHref?: string | null;
}

/** Whether the popover presentation applies now. Read as the menu opens, never during the first render. */
export function menuIsPopover(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(VISITOR_MENU_POPOVER_QUERY).matches;
}

/**
 * The mark, as the member's bar draws it: the artwork and a chevron, no
 * frame. Drawn at the bar's 28px with a 44px box for the finger, like Sign
 * in beside it (`-my-2 min-h-11`, which the bar's margins take back out).
 */
export function VisitorMark({ app, open, onToggle, buttonRef }: {
  app: VisitorMenuApp;
  open: boolean;
  onToggle: () => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
}) {
  const t = useMessages('auth');
  return (
    <button
      ref={buttonRef}
      type="button"
      data-landing-app-menu={app.slug}
      aria-haspopup="dialog"
      aria-expanded={open ? 'true' : 'false'}
      aria-label={t('auth:landing.appMenu.button', { app: app.name })}
      className="un-touch-target -my-2 min-h-11 inline-flex shrink-0 items-center gap-0.5 pe-0.5 text-[color:var(--brand-ink)]"
      onClick={onToggle}
    >
      <img
        src="/brand/homeroom-mark.png"
        alt=""
        aria-hidden="true"
        draggable="false"
        width={26}
        height={26}
        className="platform-mark-tile w-[26px] h-[26px] rounded-[7px] shrink-0"
      />
      <ChevronDownIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
    </button>
  );
}

const ROW = 'flex w-full min-h-[48px] items-center gap-3 px-4 text-start text-[15px] font-medium '
  + 'text-zinc-900 dark:text-zinc-100 hover:bg-zinc-100/70 dark:hover:bg-zinc-800 '
  + 'outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500';
const ROW_LINE = 'shadow-[inset_0_-1px_0_var(--app-sheet-line)]';
const FOOT_LINK = 'inline-flex min-h-[44px] items-center px-1 hover:underline';

function MenuRow({ row, icon, label, last = false, onClick }: {
  /** The row's key, for the declared checks and the shots: `about`, `community`, `report`. */
  row: string;
  icon: ReactNode;
  label: string;
  last?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" data-visitor-menu-row={row} className={cn(ROW, last ? '' : ROW_LINE)} onClick={onClick}>
      <span className="shrink-0 text-zinc-500 dark:text-zinc-400 [&>svg]:h-5 [&>svg]:w-5" aria-hidden="true">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <ChevronRightIcon className="h-4 w-4 shrink-0 text-zinc-400 dark:text-zinc-500" aria-hidden="true" />
    </button>
  );
}

/** The menu pane: Suggest, the three rows, and Homeroom's two pages. */
export function VisitorMenuBody({ app, actions, onAbout, titleId }: {
  app: VisitorMenuApp;
  actions: VisitorMenuActions;
  onAbout: () => void;
  titleId: string;
}) {
  const t = useMessages('auth');
  const { privacyHref, termsHref } = actions;
  return (
    <div data-visitor-menu-pane="menu" className="flex flex-col gap-3">
      <h2 id={titleId} className="px-1 text-[17px] font-bold leading-6 text-zinc-900 dark:text-zinc-100">
        {t('auth:landing.appMenu.title')}
      </h2>
      <button type="button" data-visitor-menu-suggest="" className="one-btn one-btn-1 w-full" onClick={actions.onSuggest}>
        {t('auth:landing.appMenu.suggest')}
      </button>
      <div className="overflow-hidden rounded-2xl bg-zinc-50 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-800/60">
        <MenuRow
          row="about"
          icon={<InfoCircleIcon />}
          label={t('auth:landing.appMenu.about', { app: app.name })}
          onClick={onAbout}
        />
        <MenuRow
          row="community"
          icon={<UserGroupIcon />}
          label={t('auth:landing.appMenu.community')}
          onClick={actions.onCommunity}
        />
        <MenuRow
          row="report"
          icon={<FlagIcon />}
          label={t('auth:landing.appMenu.report')}
          last
          onClick={actions.onReport}
        />
      </div>
      {privacyHref || termsHref ? (
        <p data-visitor-menu-legal="" className="flex items-center gap-1 px-1 -my-2 text-[13px] text-zinc-600 dark:text-zinc-300">
          {privacyHref ? (
            <a href={privacyHref} target="_blank" rel="noopener noreferrer" className={FOOT_LINK}>
              {t('auth:landing.appMenu.privacy')}
            </a>
          ) : null}
          {privacyHref && termsHref ? <span aria-hidden="true">·</span> : null}
          {termsHref ? (
            <a href={termsHref} target="_blank" rel="noopener noreferrer" className={FOOT_LINK}>
              {t('auth:landing.appMenu.terms')}
            </a>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

/**
 * About, the menu's second pane: the app as the public directory has it.
 * The member count only from the floor the project page uses (MIN_MEMBERS),
 * where a small number reads as a project nobody uses.
 */
export function VisitorAboutPane({ app, onBack, titleId }: {
  app: VisitorMenuApp;
  onBack: () => void;
  titleId: string;
}) {
  const t = useMessages('auth');
  const row = app.row || null;
  const members = row && (row.member_count || 0) >= MIN_MEMBERS ? row.member_count || 0 : 0;
  return (
    <div data-visitor-menu-pane="about" className="flex flex-col gap-3">
      <button
        type="button"
        data-visitor-menu-back=""
        aria-label={t('auth:landing.appMenu.back')}
        className="un-touch-target inline-flex h-9 w-9 items-center justify-center self-start rounded-full border border-[color:var(--brand-line)] bg-[color:var(--brand-tint)] text-[color:var(--brand-ink)]"
        onClick={onBack}
      >
        <ChevronLeftIcon className="h-[18px] w-[18px]" aria-hidden="true" />
      </button>
      <div className="flex items-center gap-3 px-1">
        {row ? <GuestIcon app={row} size="md" /> : null}
        <h2 id={titleId} className="min-w-0 flex-1 text-[20px] font-bold leading-[26px] text-zinc-900 dark:text-zinc-100">
          {app.name}
        </h2>
      </div>
      {row?.description ? (
        <p className="px-1 text-[15px] leading-[21px] text-zinc-700 dark:text-zinc-200">{row.description}</p>
      ) : null}
      {members ? (
        <p data-visitor-menu-members="" className="inline-flex items-center gap-1.5 px-1 text-[13px] text-zinc-600 dark:text-zinc-300">
          <UserGroupIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
          <RichMessage
            id="auth:guest.project.audienceMembers"
            values={{ count: members }}
            components={[<b className="font-[650] text-zinc-900 dark:text-zinc-100" />]}
          />
        </p>
      ) : null}
    </div>
  );
}

/** The menu's two panes, with the pane it shows kept here. */
function MenuPanes({ app, actions, titleId }: { app: VisitorMenuApp; actions: VisitorMenuActions; titleId: string }) {
  const [pane, setPane] = useState<'menu' | 'about'>('menu');
  return pane === 'about'
    ? <VisitorAboutPane app={app} titleId={titleId} onBack={() => setPane('menu')} />
    : <VisitorMenuBody app={app} actions={actions} titleId={titleId} onAbout={() => setPane('about')} />;
}

const PANEL = 'rounded-[20px] bg-white p-3 shadow-[inset_0_0_0_1px_var(--app-sheet-line),0_12px_32px_rgba(18,26,14,0.18)] dark:bg-zinc-900';

/** From 640px: a popover hanging off the mark, its trailing edge on the mark's. */
function MenuPopover({ app, actions, anchorRef, onClose }: {
  app: VisitorMenuApp;
  actions: VisitorMenuActions;
  anchorRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState<{ top: number; left: number; maxHeight?: number } | null>(null);
  useIsomorphicLayoutEffect(() => {
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const size = { width: panel.offsetWidth, height: panel.offsetHeight };
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    setPlace({ ...placeUnderAnchor(anchorRectOf(anchor), size, viewport, { flip: false }), maxHeight: clampPopoverHeight(size, viewport) });
  }, [anchorRef]);
  useAnchoredDismiss(true, [anchorRef, panelRef], onClose);
  // A press in the running app closes it too. The app is a frame from another
  // origin, so the document never hears that click; what it does hear is the
  // window losing focus to the frame (as a member's menu does, #4260).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onBlur = () => {
      window.setTimeout(() => {
        if (document.activeElement?.tagName === 'IFRAME') closeRef.current();
      }, 0);
    };
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, []);
  // Focus to the first control as it opens, as a member's menu does.
  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('button, a[href]')?.focus({ preventScroll: true });
  }, []);
  return (
    <div
      ref={panelRef}
      data-visitor-menu=""
      data-visitor-menu-kind="popover"
      role="dialog"
      aria-labelledby="visitor-menu-title"
      className={cn('fixed z-50 w-[320px] overflow-y-auto', PANEL)}
      style={place ? { top: place.top, left: place.left, maxHeight: place.maxHeight } : { top: 0, left: 0, visibility: 'hidden' }}
    >
      <MenuPanes app={app} actions={actions} titleId="visitor-menu-title" />
    </div>
  );
}

/** Under 640px: the bottom sheet a member's menu is on a phone, presented by the kit. */
function MenuSheet({ app, actions, onClose }: {
  app: VisitorMenuApp;
  actions: VisitorMenuActions;
  onClose: () => void;
}) {
  const { panelRef, adopted, scrimProps } = useSheet({ kind: 'sheet', onClose });
  return createPortal(
    <div
      className={adopted ? 'contents' : 'fixed inset-0 z-[70] flex items-end justify-center bg-black/40'}
      {...scrimProps}
    >
      <div
        ref={panelRef}
        data-visitor-menu=""
        data-visitor-menu-kind="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="visitor-menu-title"
        // A constant: the kit writes `platform-sheet-adopted` to this node.
        className="flex w-full max-w-md flex-col rounded-t-[20px] bg-[color:var(--dc-sheet-solid)] px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))]"
      >
        <MenuPanes app={app} actions={actions} titleId="visitor-menu-title" />
      </div>
    </div>,
    document.body,
  );
}

/**
 * The menu, open: a popover from 640px, a sheet under it. Mount it to open
 * it and unmount it to close it; `popover` is decided by the caller as it
 * opens (menuIsPopover), so a resize while it is up does not swap it.
 */
export function VisitorAppMenu({ app, actions, anchorRef, popover, onClose }: {
  app: VisitorMenuApp;
  actions: VisitorMenuActions;
  anchorRef: RefObject<HTMLButtonElement | null>;
  popover: boolean;
  onClose: () => void;
}) {
  if (typeof document === 'undefined') return null;
  return popover
    ? <MenuPopover app={app} actions={actions} anchorRef={anchorRef} onClose={onClose} />
    : <MenuSheet app={app} actions={actions} onClose={onClose} />;
}

/**
 * "Suggest an improvement" for somebody with no account: what suggesting
 * is, in the app's own name, and the two ways in. Sign up opens the sheet
 * that makes an account (the bar's own Sign up, which says "Join the
 * waitlist" while new accounts wait), Sign in the sign-in sheet. Presented
 * by the kit as a modal (../../lib/sheet.ts), which owns the backdrop,
 * Escape, Back and focus.
 */
export function VisitorSuggestPrompt({ appName, game, onSignUp, onSignIn, onClose }: {
  appName: string;
  /** A game is played, anything else used (the project page's Made together says the same). */
  game: boolean;
  onSignUp: () => void;
  onSignIn: () => void;
  onClose: () => void;
}) {
  const t = useMessages('auth');
  const signUp = useRef<HTMLButtonElement | null>(null);
  const { rootRef, panelRef, scrimProps } = useSheet({
    kind: 'modal',
    onClose,
    hugDesignWidth: true,
    initialFocus: () => signUp.current,
  });
  if (typeof document === 'undefined') return null;
  return createPortal(
    // The backdrop is the in-place chrome (`rootRef`): while the kit
    // presents the card it takes `platform-modal-adopted`, which app.css
    // hides, so its class string is a constant.
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="visitor-suggest-title"
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4"
      {...scrimProps}
    >
      <div
        ref={panelRef}
        data-visitor-suggest-prompt=""
        className="flex w-full max-w-[420px] flex-col gap-3 rounded-[24px] bg-white p-6 dark:bg-zinc-900"
      >
        <div className="flex items-start justify-between gap-3">
          <img
            src="/brand/homeroom-mark.png"
            alt=""
            aria-hidden="true"
            draggable="false"
            width={44}
            height={44}
            className="platform-mark-tile h-11 w-11 rounded-[12px]"
          />
          <button
            type="button"
            data-visitor-suggest-close=""
            aria-label={t('core:common.close')}
            className="un-touch-target inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
            onClick={onClose}
          >
            <XIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <h2 id="visitor-suggest-title" className="text-[20px] font-bold leading-[26px] text-zinc-900 dark:text-zinc-100">
          {t('auth:landing.appMenu.prompt.title')}
        </h2>
        <p className="text-[15px] leading-[22px] text-zinc-700 dark:text-zinc-200">
          {game
            ? t('auth:landing.appMenu.prompt.bodyPlay', { app: appName })
            : t('auth:landing.appMenu.prompt.bodyUse', { app: appName })}
        </p>
        {/* Two equal halves. A grid, because the look's button is `flex: none`. */}
        <div className="mt-1 grid grid-cols-2 gap-2.5">
          <button ref={signUp} type="button" data-visitor-suggest-sign-up="" className="one-btn one-btn-1 w-full" onClick={onSignUp}>
            {t('auth:landing.appMenu.prompt.signUp')}
          </button>
          <button type="button" data-visitor-suggest-sign-in="" className="one-btn one-btn-2 w-full" onClick={onSignIn}>
            {t('auth:landing.appMenu.prompt.signIn')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
