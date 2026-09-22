/**
 * #apps-switcher-sheet — the menu behind the header chip (#1443).
 *
 * ── The rule ───────────────────────────────────────────────────────────
 *
 * ONE CONTROL NAMES WHERE YOU ARE, AND ITS MENU LISTS EVERYWHERE YOU CAN
 * GO. Everything in here has its own page. Nothing that isn't a destination
 * belongs in this sheet at all — an inbox's CONTENTS are not a destination,
 * which is why the notifications list is a sheet of its own and only the
 * Messages ROW is here. A row that is neither is the signal this menu is
 * decaying back into the hamburger it replaced.
 *
 * ── Wallet and Validator are the rule bent on purpose (#2382) ──────────
 *
 * On the native app the menu also lists Wallet and Validator, under Profile.
 * Neither has a page of its own: Wallet opens the kit sheet Profile's
 * #account-row-wallet opens, and Validator lands on Settings › Homeroom app,
 * where block production is asked for. They were kept OUT of this menu once,
 * on exactly the rule above (see ../profile/account-panel.tsx), and that left
 * the two things a phone member most often comes back for two screens deep —
 * behind Profile, or behind Settings › Advanced. An admin asked for them here
 * (#2382), and the cost is bounded: two rows, native only, each going to one
 * place. Profile and Settings keep theirs; these are extra ways in, not moves.
 * A third row that reports rather than navigates is still the decay signal.
 *
 * ── What #1431 built and what #1443 changed ────────────────────────────
 *
 * #1431 made this the Apps sheet: a title row with "Create New", a strip of
 * the viewer's apps, and a `Home | Explore` footer, presented as a kit bottom
 * sheet on touch by ./app-context-controller.js. All of that is kept — the
 * lifecycle, the strip, the create action.
 *
 * What changed is that it now carries the platform's destinations too, so it
 * is reachable from every screen rather than only from inside an app. The two
 * footer buttons became the first two rows of that list, and `canOpen`'s
 * `!!slug` gate went with the chip's — a menu you can only open inside an app
 * is not a way to get to an app.
 *
 * ── The app's own views ARE here, and so is the exception they make ────
 *
 * App / Board / Activity sat here for one round of #1443, moved out to the
 * Improve panel on the argument that this menu answers WHICH APP and those
 * three answer WHICH PART OF IT, and are back — in BOTH places, which is what
 * neither round tried. The second question is a fair one to ask from the
 * control that names where you are, and the strip is one module
 * (../improve/view-tabs.tsx) rendered twice rather than two implementations
 * of one decision.
 *
 * The strip is the one thing in this sheet drawn as a CONTROL rather than as a
 * row, deliberately: a segmented control is visibly a different kind of object
 * from the destinations, which keeps "everything in the list has its own page"
 * true of the list while the app's own views sit above it.
 *
 * The app's general chat spent one round here as a fourth row, because
 * Activity had taken its name and it was otherwise reachable only from a
 * notification. It is not here now: it belongs to the board, which carries it
 * as a card on the kanban and as an activity row in the Feed (see
 * ../dev-board/discussion-store.ts). A menu that lists the app's chat beside
 * Home and Settings is answering the WHICH-PART-OF-THIS-APP question in the
 * one place that exists to answer WHICH APP.
 *
 * ── Why the strip is horizontal, and why that is the scroll fix ────────
 *
 * The first cut of this menu (on the superseded #1436 branch) made the apps a
 * VERTICAL list, and with the 39 apps on a real account that list ran to
 * ~1800px inside an 844px panel: Home, Discover, Messages, Profile and
 * Settings were pushed past the fold and CLIPPED, with no scroller anywhere
 * to reach them. That is what "the menu is missing home and profile" was.
 *
 * #1431's horizontal strip makes the bug structurally impossible instead of
 * fixing it: 39 apps occupy exactly the vertical space that 2 do, so the
 * destinations below can never be pushed anywhere. The strip scrolls
 * sideways; the DESTINATIONS get the vertical scroller, so on a short
 * viewport they give way rather than clip. Nothing here is ever unreachable,
 * at any app count and any height.
 *
 * ── Where it comes from, per surface ───────────────────────────────────
 *
 * Three presentations, one always-mounted element, all of them in app.css
 * (the `#apps-switcher-sheet` block): a kit bottom sheet on touch, a CSS
 * bottom sheet below `sm`, and at `sm`+ for a mouse a DROPDOWN hanging under
 * the chip that opened it. That last one was a right-edge rail like the
 * Improve panel and the notifications sheet, and it is the one thing about
 * this surface that is not like them: those two are lists with no natural
 * end, this is a menu, and a menu that answers from the far edge of a wide
 * display leaves its trigger a foot away. Nothing in here changes with the
 * presentation — the markup is one panel and the CSS decides where it is,
 * which is why the desktop change is a media query and not a branch.
 *
 * ── Same MATERIAL as the two rails, different SHAPE ────────────────────
 *
 * It wears `.dc-lift dc-lift-panel`, which is the frosted fill, the hairline
 * colour and bounded lift shadows the Improve and notifications rails wear.
 * OverlayScrim paints the surrounding dim through a rounded cutout, keeping
 * the glass over an undimmed page.
 *
 * This is the pane the dim treats least kindly, and it is worth knowing why:
 * the rails dock to a screen edge, where what shows through the frost is page
 * margin, while this one hangs in the middle of the content, where it is body
 * text. Blurred text behind a menu reads as a smudge rather than as depth. If
 * that ever needs fixing it is this surface's fill alpha, not the mechanism.
 * That is the whole of what it takes from them, and it is deliberate that it
 * is not more: `.dc-lift` rounds a DOCKED sheet — 1.75rem on the corners that
 * meet the page, square on the ones that run off the display — and at `sm`+
 * this thing docks to nothing. It hangs off the chip, so all four of its
 * corners are real and it keeps the kit's own 12px menu radius
 * (`--un-radius-card`) and the `--brand-line` hairline that ties it to the
 * chip's ring. Below `sm` it IS floor-docked, and there it takes the pane's
 * 1.75rem top corners like the other two.
 *
 * What this replaced was `bg-white dark:bg-zinc-900` with a zinc hairline and
 * `shadow-2xl` — a heavier, greyer drop than the lift's, and the last of the
 * pre-lift panel look in the shell's floating surfaces.
 *
 * First render is the prerender: closed, no apps, no app-scoped rows.
 */

import { OverlayScrim } from '../../lib/overlay-scrim-view';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import {
  BoardIcon,
  ChatBubbleTailIcon,
  ChatIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  InfoCircleIcon,
  PlusWideIcon,
  TerminalIcon,
  XIcon,
} from '@/components/ui/icons';

import { AboutPane } from './about-pane';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { NO_APPS_YET } from '../apps/no-apps-yet';
import { useStoreState } from '../../lib/use-store-state';
import { ImproveGlyph } from '../improve/improve-glyph';
import { improveStore } from '../improve/improve-store.js';
import { appContextStore } from './app-context-store.js';
import { AppContext } from './app-context-controller.js';
import { recordAppUse, sortByRecency } from './app-recency';

type SwitcherApp = {
  slug: string; name?: string; icon_url?: string | null; icon_emoji?: string | null;
};

const ROW = 'flex items-center gap-3 px-5 min-h-[44px] text-sm '
  + 'text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 '
  + 'transition-colors';

/**
 * A section label's TYPE, without the row it sits in.
 *
 * Split out because the Apps label cannot use SECTION: it shares its row with
 * Create New and the close button, so the row owns the padding and the label
 * owns only how it reads. Two constants rather than one string repeated, so
 * "the same as the other section labels" stays true by construction — it was
 * a `text-lg font-semibold` title until #1443's menu grew more labels
 * underneath it, and a heading above a list of labels reads as a different
 * kind of thing from the labels themselves.
 */
const SECTION_TYPE = 'text-[0.7rem] font-semibold uppercase tracking-wide '
  + 'text-zinc-400 dark:text-zinc-500';

/** A section label that owns its whole row. */
const SECTION = 'px-5 pt-4 pb-1 ' + SECTION_TYPE;

/**
 * One destination. An ANCHOR, always — whether clean-path or fragment-routed,
 * cmd/ctrl click, middle-click and "open in new tab" all have to work, the same
 * reason #back-btn is an <a>. `dismissForNav` closes the sheet on a plain
 * activation; a modified click never reaches it because the browser handles
 * it natively.
 */
/**
 * A row's INSIDES — the glyph, the label, anything trailing, the chevron.
 *
 * Split out because this menu has three row shapes and they have to read as
 * one kind of thing: two of them are <button>s (About, which is a second pane
 * of this sheet rather than an address, and Improve, which opens a panel) and
 * the rest are <a>s. One fragment is what keeps "the buttons look like the
 * links" true by construction rather than by three copies staying in step.
 */
function RowBody({ icon, label, trailing }: {
  icon: ReactNode;
  label: string;
  trailing?: ReactNode;
}): ReactNode {
  return (
    <>
      <span className="shrink-0 [&>svg]:h-5 [&>svg]:w-5 text-zinc-500 dark:text-zinc-400" aria-hidden="true">
        {icon}
      </span>
      <span className="flex-1 min-w-0 truncate font-medium">{label}</span>
      {trailing}
      <ChevronRightIcon className="w-4 h-4 shrink-0 text-zinc-300 dark:text-zinc-600" aria-hidden="true" />
    </>
  );
}

function MenuRow({
  id, href, icon, label, trailing, onClick, elRef, shipsHidden,
}: {
  id: string;
  href: string;
  icon: ReactNode;
  label: string;
  trailing?: ReactNode;
  onClick?: (e: React.MouseEvent) => void;
  elRef?: React.Ref<HTMLAnchorElement>;
  // Ships `hidden` in the FIRST render, for a row a classic module reveals.
  // The className stays a constant either way — which is what keeps the
  // outside `hidden` toggle a sanctioned seam rather than a second owner.
  shipsHidden?: boolean;
}): ReactNode {
  return (
    <a
      ref={elRef}
      id={id}
      href={href}
      className={shipsHidden ? `hidden ${ROW}` : ROW}
      onClick={(e) => {
        if (onClick) { onClick(e); return; }
        AppContext.dismissForNav();
      }}
    >
      <RowBody icon={icon} label={label} trailing={trailing} />
    </a>
  );
}

/**
 * One app in the rail.
 *
 * THE APP'S OWN ARTWORK, never its initial if it has any. ../apps/app-card-view's
 * AppIconContent is the three-way `icon_url → icon_emoji → letter` walk Home
 * and the browse list already share; a letter is the LAST resort.
 *
 * `.app-icon-tile` + `data-icon` draw the box, and this call site adds no
 * background or text colour of its own — app.css says tile call sites must not
 * repaint the one tile face.
 */
function AppTile({ app, current }: { app: SwitcherApp; current: boolean }) {
  const label = app.name || app.slug;
  return (
    <a
      href={`/app/${encodeURIComponent(app.slug)}`}
      data-switcher-app={app.slug}
      aria-current={current ? 'page' : undefined}
      className="shrink-0 w-16 flex flex-col items-center gap-1.5"
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey
            || event.shiftKey || event.altKey) return;
        event.preventDefault();
        void AppContext.dismissForNav();
        if (!current) window.App?.navigateToApp?.(app.slug, 'app');
      }}
    >
      {/* The ring sits OUTSIDE the tile's own hairline, offset in the sheet's
          ground, so a selected tile reads as one edge rather than two. */}
      <span
        data-icon={appIconKind(app)}
        className={'app-icon-tile w-14 h-14 rounded-2xl overflow-hidden flex items-center justify-center text-xl font-bold'
          + (current
            ? ' ring-2 ring-violet-500 ring-offset-2 ring-offset-white dark:ring-offset-zinc-900'
            : '')}
      >
        <AppIconContent app={app} />
      </span>
      {/* Colour only, never weight — navigation.md forbids a weight change
          between nav item states. */}
      <span
        className={'w-full text-center text-[0.8125rem] truncate '
          + (current
            ? 'text-violet-600 dark:text-violet-400'
            : 'text-zinc-900 dark:text-zinc-100')}
      >
        {label}
      </span>
    </a>
  );
}

export function AppsSwitcherSheet(): ReactNode {
  const { open, adopted, view } = useStoreState(appContextStore);
  // Everything this sheet says about the app comes from ONE store, published
  // by the classic writers that already owned those facts. #2718 adds the
  // three the rows need — the name to label them with, the terminal's gate,
  // and what About prints — and adds no fetch: the Improve panel was reading
  // exactly these for the rows that moved here.
  const {
    slug, name, showTerminal, target, versionState, deploying, appUpdateReady,
  } = useStoreState(improveStore);
  const [apps, setApps] = useState<SwitcherApp[] | null>(null);

  // "About Notes", not "About this app". The name is what the viewer is
  // looking at and it is already on the bar above; "this app" is what you
  // write when you do not have it. It falls back to the slug and then to a
  // bare "this app", because the menu opens on Home too — where the context
  // is the platform's own self-hosted row and the name may not have landed.
  const appLabel = name || slug || 'this app';

  const close = useCallback(() => AppContext.close(), []);

  // The viewer's apps, in the home grid's own "Your apps" order — the one
  // answer to "which apps are mine" the platform already has. Revalidated on
  // EVERY open: create/import reloads Home and Discover's add/remove action
  // updates Home's app cache, but this island keeps its own state for the
  // lifetime of the shell. Treating the first response as permanent left that
  // copy stale until a page reload.
  // Keep the previous rows while this fetch runs, so reopening never flashes an
  // empty strip. Nothing loads during the first render: the prerender ships an
  // empty strip and a fetch there would be a hydration mismatch.
  useEffect(() => {
    if (!open) return;
    let live = true;
    (async () => {
      try {
        const demo = new URLSearchParams(location.search).get('demo') === '1' ? '?demo=1' : '';
        const res = await fetch(`/api/apps${demo}`);
        if (!res.ok) return;
        const data = await res.json();
        const home = (window as any).Home;
        const mine = home?.partitionApps
          ? home.partitionApps(data.apps || []).yours
          : (data.apps || []);
        if (live) setApps(mine);
      } catch {
        // Offline is a state, not a failure: no strip, the rows still work.
      }
    })();
    return () => { live = false; };
  }, [open]);

  // Every way into an app funnels through improveStore.slug, so recording
  // recency here rather than in AppTile's click handler counts a home tile, an
  // /app/<slug> deep link and a notification tap as uses too — not just the
  // two entries that happen to go through this menu.
  useEffect(() => {
    if (slug) recordAppUse(slug);
  }, [slug]);

  // Most-recently-used first, which on a horizontal strip is left-to-right.
  // Safe to read storage during render here and nowhere else in this island:
  // `apps` is null until the sheet's first open, so this only ever runs on a
  // client render, never in the prerender that would mismatch on hydration.
  const rows = useMemo(() => sortByRecency(apps || []), [apps]);

  return (
    <>
      {/* The overlay is the WEB presentation's dim. Adopted into a kit sheet
          the kit's own backdrop owns it — see lib/sheet-controller.js. */}
      <div
        id="apps-switcher-overlay"
        aria-hidden="true"
        {...(open && !adopted ? { 'data-open': '' } : {})}
        className="fixed inset-0 z-40"
        onClick={close}
      >
      </div>
      <div
        id="apps-switcher-sheet"
        role="dialog"
        aria-label="Menu"
        aria-hidden={open ? undefined : 'true'}
        {...(open ? { 'data-open': '' } : {})}
        className="fixed z-50 flex flex-col dc-lift dc-lift-panel app-context-transition"
      >
        {/* The Apps label's row. `pt-4 pb-1` is SECTION's own padding, applied
            here because the row holds two controls beside the label — so the
            spacing is the same as every other label in this menu even though
            the class string cannot be. */}
        <div className="flex items-center gap-3 px-5 pt-4 pb-1 shrink-0">
          {/*
              THE BACK ARROW IS THE ABOUT PANE'S, and it replaces the label
              rather than sitting beside it: About is one level inside this
              sheet, so the row that names the level has to be the row that
              leaves it. On the menu it is the "Apps" label it has always
              been.
          */}
          {view === 'about' ? (
            <button
              id="app-about-back"
              type="button"
              className={'flex-1 min-w-0 flex items-center gap-1.5 text-left un-touch-target '
                + SECTION_TYPE}
              onClick={() => AppContext.showMenu()}
            >
              <ChevronLeftIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate">{appLabel}</span>
            </button>
          ) : (
            <span className={'flex-1 min-w-0 block ' + SECTION_TYPE}>
              Apps
            </span>
          )}
          {view === 'about' ? null : (
          <button
            id="apps-switcher-create"
            type="button"
            className="inline-flex items-center gap-1 text-sm font-medium text-violet-600 dark:text-violet-400 hover:underline un-touch-target"
            // `Home.openCreateApp` never existed — the optional call swallowed
            // it, so this button closed the sheet and did nothing else. The
            // create dialog is reached through App.showCreateModal(), which
            // forwards to the `create` entry of the UsernodeReact.dialogs
            // bridge (../dialogs/create-app.tsx).
            //
            // The await is load-bearing on touch: dismissForNav() resolves
            // when the kit sheet has actually torn down (up to
            // DISMISS_SAFETY_MS in lib/sheet-controller.js), and presenting a
            // modal into a kit that is still dismissing a sheet loses the
            // modal. Same ordering AppTile uses for navigation.
            //
            // At-limit viewers still open the dialog: its quota row explains
            // the state and its submit button is disabled. Keeping a toast
            // gate here would make this entry disagree with the home Create
            // button and hide the exact usage the viewer came to inspect.
            onClick={() => {
              const win = window as any;
              void AppContext.dismissForNav().then(() => {
                win.App?.showCreateModal?.();
              });
            }}
          >
            <PlusWideIcon className="w-3.5 h-3.5 shrink-0" strokeWidth="2.5" aria-hidden="true" />
            Create New
          </button>
          )}
          <button
            id="apps-switcher-close"
            type="button"
            className="text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 un-touch-target"
            aria-label="Close"
            onClick={close}
          >
            <XIcon className="w-5 h-5" />
          </button>
        </div>
        {/* The apps, as a horizontal strip — vertically BOUNDED, which is what
            keeps every row below reachable at any app count. See the header.

            THE PADDING IS NOT SYMMETRIC AND IT LOOKS IT. Equal air above and
            below the tiles takes 16px above and none below, for two reasons
            that pull the same way:

            4px OF THE TOP PADDING PAINTS NOTHING. `overflow-x-auto` makes this
            a scroll container on BOTH axes (overflow-y computes to `auto`), so
            anything drawn above the content box is clipped — and the current
            app's tile carries `ring-2 ring-offset-2`, which paints 4px outside
            its border box. That 4px is clearance, not gap: with `pt-1`, which
            is exactly the outset and was all this used to carry, the ring was
            saved from being sliced flat and the tiles sat hard against the
            label. `pt-4` is that same clearance plus 12px that the eye reads.

            AND THE LABEL BELOW BRINGS ITS OWN. Whatever follows the strip
            opens with SECTION's `pt-4`, so 16px under the tiles is already
            there — `pb-5` on top of it made the gap below more than three
            times the gap above. It reads as balanced at `pb-0`. */}
        {/* THE STRIP IS THE MENU'S. About is one level inside this sheet and
            is about ONE app, so a row of every other app at the top of it
            would be an invitation to leave the thing you opened. */}
        <div
          id="apps-switcher-list"
          className={'shrink-0 flex gap-4 px-5 pt-4 pb-0 overflow-x-auto overscroll-contain platform-no-scrollbar'
            + (view === 'about' ? ' hidden' : '')}
        >
          {rows.map((app) => (
            <AppTile key={app.slug} app={app} current={app.slug === slug} />
          ))}
          {apps && rows.length === 0 ? (
            <span className="py-4 text-sm text-zinc-500 dark:text-zinc-400">
              {NO_APPS_YET}
            </span>
          ) : null}
        </div>
        {/* THE APP'S THREE VIEWS ARE NOT HERE ANY MORE.

            An "In this app" caption over an App | Board | Activity strip sat
            between the app list and the platform rows. It answered a
            different question from the one this menu is for: this menu picks
            WHICH APP, and the strip picked which part of the app you are
            already in — so opening it to switch apps meant reading past a
            control about the app you were leaving.

            The strip is not gone, it is single-homed. The Improve panel
            renders it (`#improve-views`, ../improve/view-tabs.tsx), which is
            where the rest of "what can I do to this app" lives, and the
            header's own back arrow is the fast path out of a Board or an
            Activity feed now — see ../header/platform-header.tsx. Two copies
            of one control was the thing view-tabs.tsx's own header called
            "two owners of one decision"; this leaves one. */}
        {/* THE ONLY VERTICAL SCROLLER. Everything above is `shrink-0`. */}
        <nav
          id="switcher-nav"
          className="flex-1 min-h-0 overflow-y-auto pb-2 platform-safe-sheet"
        >
          {view === 'about' ? <AboutPane label={appLabel} /> : (
          <>
          {/*
              ── THE APP'S OPTIONS, and nothing else ────────────────────

              This list used to hold the PLATFORM's destinations — Home,
              Workshop, Discover, Challenges, Messages, Profile, Wallet,
              Validator, Settings, Admin — on #1443's rule that one control
              names where you are and its menu lists everywhere you can go.
              #2718 split that rule in two, the way every mini-app host it was
              modelled on already had: the host's sections live on a permanent
              bar (features/nav/) and the menu under a mini-app holds the
              MINI-APP's options. Five of those rows are tabs now; the other
              five are rows of the Profile screen the Me tab lands on
              (../profile/account-panel.tsx), which is where a destination
              about your account belongs.

              What is left is flat and short, which is the shape the study
              found everywhere — WeChat, Telegram, Alipay, Chrome's Custom
              Tabs, Safari's view controller, Discord, Slack, Teams. Nobody
              nests a mini-app's menu.
          */}
          <div className={SECTION}>{appLabel}</div>
          {/*
              GIVE FEEDBACK FIRST, because it is the row somebody who is not a
              developer of this app will want, and every other row on this list
              assumes you are. It keeps `#improve-row-feedback`: that id is
              what the outbox dot's writer selects, and moving the row must not
              move the dot's target.
          */}
          <MenuRow
            id="improve-row-feedback"
            href={slug ? `#app/${encodeURIComponent(slug)}/dev` : '#'}
            icon={<ChatBubbleTailIcon />}
            label="Give feedback"
            onClick={(e) => {
              if ((window as any).NavLink?.isNativeClick?.(e)) return;
              e.preventDefault();
              void AppContext.dismissForNav().then(() => {
                (window as any).Improve?.giveFeedback?.();
              });
            }}
          />
          {/*
              IMPROVE — the header pill, as a row (#2718).

              `#improve-btn` was a filled violet pill standing between the bell
              and the mark, and retiring it is what lands the app bar on the
              two controls the design draws: close · tile + name · bell · mark.
              Everything it did is here. Its GLYPH is this row's leading icon,
              id and `data-state` intact (../improve/improve-glyph.tsx), and
              its two corner dots are on the mark itself
              (../header/platform-mark.tsx) — the part of it that had to stay
              visible at rest.

              THE LABEL IS THE PILL'S OWN aria-label, not the word it printed.
              "Improve" alone was legible on a control that only ever appeared
              beside an app's name; in a list of rows it has to say what it
              improves, and on Home that is the platform's own self-hosted row
              rather than an app (#1367, Home.publishImproveTarget).

              RENDERED ALWAYS, `hidden` when there is no target — the pill's
              exact lifecycle, and the reason is the prerender: a row that only
              exists sometimes is a row whose id is not in the shell's declared
              inventory, and `#improve-btn-glyph` inside it is what a declared
              check selects on to prove a landed build offers its reload.

              A BUTTON, not an anchor, for the About row's reason: there is no
              address to open in a new tab, because what it opens is a panel.
              It dismisses this sheet FIRST and waits — the kit cannot present
              a surface while it is still tearing one down, the same ordering
              the terminal row below uses.
          */}
          <button
            id="app-menu-row-improve"
            type="button"
            className={target ? `${ROW} w-full text-left` : `hidden ${ROW} w-full text-left`}
            onClick={() => {
              void AppContext.dismissForNav().then(() => {
                (window as any).Improve?.open?.();
              });
            }}
          >
            <RowBody
              icon={(
                <ImproveGlyph
                  versionState={versionState}
                  appDeploying={deploying}
                  appUpdateReady={appUpdateReady}
                />
              )}
              label={target === 'platform' ? 'Improve the platform' : `Improve ${appLabel}`}
            />
          </button>
          {/*
              OPEN IN WORKSHOP and GO TO APP DISCUSSION are the two rows the
              study predicted: a mini-app's deeper options LINK OUT to the
              host's own sections, filtered to the app you are in. Telegram
              sends you to the bot's chat as a row of Chats; Steam to that
              game's community hub; Slack and Teams to the channel's files.
              These are the same move — the Workshop tab and the Messages
              tab, arriving scoped rather than at the top of a list.
          */}
          <MenuRow
            id="app-menu-row-workshop"
            href={slug ? `#app/${encodeURIComponent(slug)}/dev` : '#workshop'}
            icon={<BoardIcon />}
            label="Open in Workshop"
          />
          <MenuRow
            id="app-menu-row-discussion"
            href={slug ? `#app/${encodeURIComponent(slug)}/dev/chat` : '#messages'}
            icon={<ChatIcon />}
            label="Go to app discussion"
          />
          {/*
              The terminal is the one Improve row that stays TOP LEVEL rather
              than moving into About: it is something you do, not a fact about
              the app, and an app whose build is failing is exactly when you
              want it one tap away. Same id, same gate (`showTerminal`, which
              DevConsole publishes), same method.
          */}
          {showTerminal ? (
            <MenuRow
              id="improve-row-terminal"
              href="#"
              icon={<TerminalIcon />}
              label="Developer terminal"
              onClick={(e) => {
                e.preventDefault();
                void AppContext.dismissForNav().then(() => {
                  (window as any).Improve?.openTerminal?.();
                });
              }}
            />
          ) : null}
          {/*
              ABOUT is the second PANE of this sheet, not a second sheet: the
              kit cannot present one while it is still dismissing another, and
              "about" is where the menu goes rather than something that opens
              over it. The row is a button and not an anchor for the same
              reason — there is no address to open in a new tab, because the
              pane is this sheet in another state.
          */}
          <button
            id="app-menu-row-about"
            type="button"
            // `w-full` because a <button> shrinks to its content where the
            // <a> rows above are block-level flex items that fill the sheet.
            // Without it the label's `flex-1` has nothing to push against and
            // the chevron sits against the words instead of at the edge —
            // which reads as a different KIND of row, on the one row where
            // that would be a lie.
            className={`${ROW} w-full text-left`}
            onClick={() => AppContext.showAbout()}
          >
            <RowBody icon={<InfoCircleIcon />} label={`About ${appLabel}`} />
          </button>
          </>
          )}
        </nav>
      </div>
      <OverlayScrim panelId="apps-switcher-sheet" backdropId="apps-switcher-overlay" />
    </>
  );
}
