/**
 * #apps-switcher-sheet — the menu behind the header's Homeroom mark (#1443, #2784).
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
 * ── The app's own views: a row, not a control (#2761) ──────────────────
 *
 * App / Board / Activity sat here for one round of #1443, moved out to the
 * Improve panel, and came back as an App | Workshop segmented control when
 * that panel retired (#2718 review). The owner's call in #2761 was that it
 * should not be a toggle at all: the Workshop is one more place this menu
 * goes, so it is a "Go to workshop" row in the list like the others, and
 * nothing replaces the App segment — the parked app on the bar (#2762) is
 * how you get back to a running app.
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
 * bottom sheet below `sm`, and at `sm`+ for a mouse a POPOVER anchored under
 * the Homeroom mark that opened it, undimmed, like the dev board's vote
 * popover (#2784). That last one was a right-edge rail like the notifications
 * sheet, then a dropdown centred under the header's title chip — stranded in
 * the middle of the screen once the trigger moved to the mark. Those rails
 * are lists with no natural end; this is a menu, and a menu belongs under its
 * trigger. Nothing in here changes with the presentation — the markup is one
 * panel and the CSS decides where it is. The one measurement, the mark's
 * rect, lives in ./index.tsx beside the Escape binding, and reaches the CSS as
 * two custom properties the desktop rule reads.
 *
 * ── Same MATERIAL as the two rails, different SHAPE ────────────────────
 *
 * It wears `.dc-lift dc-lift-panel`, which is the frosted fill, the hairline
 * colour and bounded lift shadows the Improve and notifications rails wear.
 * Below `sm` OverlayScrim paints the surrounding dim through a rounded
 * cutout, keeping the glass over an undimmed page; at `sm`+ the popover casts
 * no dim at all (lib/overlay-scrim.js skips it), the way the kit's own
 * desktop menus do.
 *
 * Blurred text behind a menu can read as a smudge rather than as depth, and
 * the popover sits over content rather than page margin. If that ever needs
 * fixing it is this surface's fill alpha, not the mechanism.
 * That is the whole of what it takes from them, and it is deliberate that it
 * is not more: `.dc-lift` rounds a DOCKED sheet — 1.75rem on the corners that
 * meet the page, square on the ones that run off the display — and at `sm`+
 * this thing docks to nothing. It hangs off the mark, so all four of its
 * corners are real and it keeps the kit's own 12px menu radius
 * (`--un-radius-card`) and the `--brand-line` hairline. Below `sm` it IS floor-docked, and there it takes the pane's
 * 1.75rem top corners like the other two.
 *
 * What this replaced was `bg-white dark:bg-zinc-900` with a zinc hairline and
 * `shadow-2xl` — a heavier, greyer drop than the lift's, and the last of the
 * pre-lift panel look in the shell's floating surfaces.
 *
 * First render is the prerender: closed, no apps, no app-scoped rows.
 */

import { OverlayScrim } from '../../lib/overlay-scrim-view';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';

import {
  BoardIcon,
  ChatIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  InfoCircleIcon,
  PlusWideIcon,
  SparklesIcon,
  TerminalIcon,
  XIcon,
} from '@/components/ui/icons';

import { AboutPane } from './about-pane';
import { useStoreState } from '../../lib/use-store-state';
import { ImproveQuickActions, UpdateStatus } from '../improve/actions';
import { improveStore } from '../improve/improve-store.js';
import { appContextStore } from './app-context-store.js';
import { AppContext } from './app-context-controller.js';
import { recordAppUse } from './app-recency';
import { continueRows } from './continue-model';
import { AgentActivityMark, AgentWorkingIcon } from '../agent-session/activity-mark';
import { ACTIVITY_LABEL } from '../agent-session/activity';
import { loadAgentSessions, useAgentSessionState } from '../agent-session/store';
import { setFilter as setMessagesFilter } from '../messages/store';

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
function RowBody({ icon, label, lead, trailing }: {
  icon: ReactNode;
  label: string;
  // A mark drawn just before the label: an agent session's state (#3013).
  lead?: ReactNode;
  trailing?: ReactNode;
}): ReactNode {
  return (
    <>
      <span className="shrink-0 [&>svg]:h-5 [&>svg]:w-5 text-zinc-500 dark:text-zinc-400" aria-hidden="true">
        {icon}
      </span>
      {lead}
      <span className="flex-1 min-w-0 truncate font-medium">{label}</span>
      {trailing}
      <ChevronRightIcon className="w-4 h-4 shrink-0 text-zinc-300 dark:text-zinc-600" aria-hidden="true" />
    </>
  );
}

function MenuRow({
  id, href, icon, label, lead, trailing, onClick, elRef, shipsHidden, dataContextRow,
}: {
  id: string;
  // Names the destination for selectors that key on it rather than on the id.
  dataContextRow?: string;
  href: string;
  icon: ReactNode;
  label: string;
  lead?: ReactNode;
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
      data-context-row={dataContextRow}
      href={href}
      className={shipsHidden ? `hidden ${ROW}` : ROW}
      onClick={(e) => {
        if (onClick) { onClick(e); return; }
        AppContext.dismissForNav();
      }}
    >
      <RowBody icon={icon} label={label} lead={lead} trailing={trailing} />
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
    slug, name, showTerminal, target, restricted,
  } = useStoreState(improveStore);
  const { sessions: agentSessions } = useAgentSessionState();
  // Votes this viewer owes on the app in context — the badge on the
  // "Go to workshop" row. See the fetch below.
  const [owed, setOwed] = useState<number | null>(null);

  // HOMEROOM FOR A VIEWER WHO IS NOT SERVED ITS ROW (SELF_APP_PUBLIC_VOTING
  // off, not an admin): the platform's workshop and discussion answer them
  // 404, so the two rows that go there are hidden rather than left leading
  // nowhere — feedback on the platform and About Homeroom are theirs as much
  // as anyone's (./platform-target.js, Home._restrictedPlatformTarget).
  //
  // THROUGH A REF, NOT A RENDERED CLASS. Both rows are in the prerendered
  // menu and hydrate from it, and the store that says `restricted` is written
  // by the route's publish after hydration — so the class string stays the
  // constant the prerender shipped and `hidden` is toggled in a layout
  // effect, the seam lib/legacy-dom's useHiddenClass is. Written out rather
  // than calling it because the rows unmount under About and mount again on
  // the way back: `view` has to re-run the effect, or a row that came back
  // would come back without its `hidden`.
  const workshopRowRef = useRef<HTMLAnchorElement | null>(null);
  const discussionRowRef = useRef<HTMLAnchorElement | null>(null);
  useIsomorphicLayoutEffect(() => {
    for (const el of [workshopRowRef.current, discussionRowRef.current]) {
      if (el && el.classList.contains('hidden') !== !!restricted) {
        el.classList.toggle('hidden', !!restricted);
      }
    }
  }, [restricted, view]);
  // AFTER MOUNT ONLY, for the one new piece of store-derived TEXT below (the
  // platform discussion's label): the hydrating render must print what the
  // prerender printed whatever the store says by then, or it is React #418
  // on every route. The class toggle above is an effect for the same reason.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // "About Notes", not "About this app". The name is what the viewer is
  // looking at and it is already on the bar above; "this app" is what you
  // write when you do not have it. It falls back to the slug and then to a
  // bare "this app", because the menu opens on Home too — where the context
  // is the platform's own self-hosted row and the name may not have landed.
  const appLabel = name || slug || 'this app';

  const close = useCallback(() => AppContext.close(), []);

  /*
      CONTINUE (#2779 follow-up): up to three of your agent sessions on this
      app, below its own rows, so going back to one is a tap from anywhere,
      each with the lists' mark (a spinner while it works, a green dot once
      it finished unseen); then "See all sessions", Messages' Agents list.
      The rules are ./continue-model.ts's.

      AFTER MOUNT and after the list loads, never in the prerender: the rows
      are the viewer's own data, and the hydrating render has to print what
      the prerender printed. The conversations are read on open, for any
      signed-in viewer, the flag or not — Messages' rule: turning agent
      sessions off never hides a conversation that already exists.
  */
  useEffect(() => {
    if (open && window.App?.user) void loadAgentSessions();
  }, [open]);
  const continuing = mounted && view !== 'about'
    ? continueRows(slug || null, agentSessions || [])
    : [];


  // Every way into an app funnels through improveStore.slug, so recording
  // recency here counts a home tile, an /app/<slug> deep link and a
  // notification tap as uses too.
  //
  // THE ONE READER OF THAT HISTORY WAS THE APPS RAIL — the horizontal strip
  // of recent apps that headed this menu, not the App|Workshop strip below,
  // which is a different control that arrived later. The rail is retired (see
  // the note in the markup). The write stays because the history is a
  // fact about this device rather than a fact about this sheet —
  // ../nav/parked-store.js's header already points at it as the thing that
  // knows which apps this device opens, and it is three lines and a
  // localStorage key either way.
  useEffect(() => {
    if (slug) recordAppUse(slug);
  }, [slug]);

  /*
      WHAT THE WORKSHOP ROW OWES YOU, as a trailing figure (#2718).

      BELOW THE RECENCY EFFECT, not between the app-strip loader and it.
      tests/app-switcher-dropdown.test.js reads that loader as a SOURCE SLICE
      bounded by the two comments around it, and asserts things about the
      whole slice — among them that it does not gate on anything but `open`.
      An effect wedged in between joins the slice and fails assertions written
      about a different effect. The order of these three is otherwise free.

      The design study drew "2 to vote" on this row, and it is the one thing
      on this menu that reports rather than navigates — which is exactly what
      the header of this file warns is the decay signal. It earns the
      exception the same way the row itself does: it is not a second inbox,
      it is a PROPERTY OF THE DESTINATION, the way a folder says how many
      files are in it. A row that sends you to a queue and will not say
      whether the queue is empty makes you go and look.

      `/api/workshop/counts` is the Workshop tab's own endpoint and it already
      answers per app, so this is the same number that screen shows on the
      same app's row — one source, two readers. `needs` is votes owed:
      promoted proposals and governance issues somebody else opened that this
      viewer has not voted on.

      Loaded on OPEN, and never during render: the prerender ships no figure
      and a fetch here would be a hydration mismatch. The row that shows it
      renders unconditionally for that same reason; what is conditional is
      the BADGE, which is fine because a number arriving later changes a
      subtree React already owns rather than the child count it hydrated. Failure is silence — a menu row that works is worth more than
      a count, so a refused or offline request leaves `owed` null and the row
      renders exactly as it did before this existed.
  */
  useEffect(() => {
    if (!open || !slug) { setOwed(null); return; }
    let live = true;
    (async () => {
      try {
        const demo = new URLSearchParams(location.search).get('demo') === '1' ? '?demo=1' : '';
        const res = await fetch(`/api/workshop/counts${demo}`);
        if (!res.ok) return;
        const data = await res.json();
        const n = data?.counts?.[slug]?.needs;
        if (live && typeof n === 'number' && n > 0) setOwed(n);
      } catch {
        // Offline is a state, not a failure: no figure, the row still works.
      }
    })();
    return () => { live = false; };
  }, [open, slug]);


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
            /*
                IT SAID "Apps" while a strip of every app sat under it. With
                the strip gone this row names what the sheet is about, which
                is the app in context — so the label that was duplicated
                inside the list below (`<div className={SECTION}>`) is this
                one now, and the list opens on its first row.
            */
            <span className={'flex-1 min-w-0 block truncate ' + SECTION_TYPE}>
              {appLabel}
            </span>
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
        {/* THE APPS STRIP IS GONE (#2718 review).

            A horizontal rail of every app you have, with "Create New" beside
            the label above it, sat here — #1431's answer to a vertical list
            that clipped Home and Settings off the fold on a 39-app account.
            The clipping argument was sound and is now moot: this menu holds
            one app's options, so its length no longer depends on how many
            apps you have.

            What the strip was FOR does not survive the split either. #1443's
            rule was "one control names where you are and its menu lists
            everywhere you can go", and switching apps was the biggest thing
            on that list. Since #2718 the platform's places are a permanent
            bar and this menu is the mini-app's own — so a rail of OTHER apps
            at the top of it is an invitation to leave the thing you opened,
            which is the same objection that kept it out of the About pane.
            Switching apps is Home's job, one tab away.

            Gone with it: the `/api/apps` fetch this sheet ran on every open,
            ./app-recency's read during render, and #apps-switcher-create —
            whose dialog is still reached from Home's own Create tile and from
            App.showCreateModal(). */}
        {/* ── WHAT THE DRAWER USED TO HOLD ───────────────────────────
            The Improve panel is retired (#2718 review); what it held moved up
            into this menu. In its order: what is happening to the build, and
            the two things you can do about it. */}
        {/* THE MENU PANE'S, NOT ABOUT'S. About is facts about the app — what
            it is, who builds it, where to take it — and the design draws it
            as a page of its own with no actions over it; the two buttons and
            the build notice pushed it a row further down a sheet that has to
            scroll as it is. Back on the menu pane they are where they were.
            `view` is 'menu' in the prerender, so the hydrating render is the
            same markup. */}
        {view === 'about' ? null : <UpdateStatus />}
        {view === 'about' ? null : <ImproveQuickActions />}
        {/* THE App | Workshop STRIP IS RETIRED (#2761). It sat here as a
            segmented control, and a toggle was the wrong shape for it: this
            menu is a list of places, and the strip's one real job was
            getting you to the Workshop. That is the "Go to workshop" row at
            the top of the list below now, carrying the vote-count badge the
            strip's Workshop segment carried. Nothing replaces the App
            segment — the parked app on the bar (#2762) is the way back to a
            running app. See the note on that row for why it is rendered
            unconditionally. */}

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
          {/*
              GIVE FEEDBACK IS NOT A ROW HERE ANY MORE (#2718 review). It led
              this list, on the reading that it is the thing somebody who is
              not a developer of this app wants while every other row assumes
              you are. That reading was about the READER and it cost the
              action its shape: a filled button that says what it DOES became
              the first of eight rows in a menu, which is where you go to
              navigate. It is a button again, in the Improve panel's own well
              beside "New change" (../improve/improve-panel.tsx), which is
              where it was before this issue moved it.

              `#improve-row-feedback` goes back with it, because that id is
              what the outbox dot's writer selects and two elements cannot
              both claim it.
          */}
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

              AN APP'S ROW, NEVER THE PLATFORM'S (#2718 review). The pill
              appeared wherever there was a target, and on the platform screens
              that target is Homeroom's own self-hosted row (#1367), so the
              menu offered "Improve the platform" from Home. That is the split
              this issue made, read backwards: this menu is the MINI-APP's,
              and Homeroom-as-an-app is reached by opening it like any other,
              where its own menu says the same thing about it.

              A BUTTON, not an anchor, for the About row's reason: there is no
              address to open in a new tab, because what it opens is a panel.
              It dismisses this sheet FIRST and waits — the kit cannot present
              a surface while it is still tearing one down, the same ordering
              the terminal row below uses.
          */}
          {/*
              OPEN IN WORKSHOP and GO TO APP DISCUSSION are the two rows the
              study predicted: a mini-app's deeper options LINK OUT to the
              host's own sections, filtered to the app you are in. Telegram
              sends you to the bot's chat as a row of Chats; Steam to that
              game's community hub; Slack and Teams to the channel's files.
              These are the same move — the Workshop tab and the Messages
              tab, arriving scoped rather than at the top of a list.
          */}
          {/*
              GO TO WORKSHOP replaced the App | Workshop strip (#2761): the
              owner asked for a plain row, not a toggle. It is rendered
              UNCONDITIONALLY for the reason the strip was — a `slug ? … :
              null` here changes the child count between the prerender and
              the hydrating render, because public/js/app.js publishes the
              target before this bundle hydrates, and that is React #418.
              With no slug the href falls back to '#', as the strip's did.

              `data-context-row="workshop"` is the key the strip's segment
              carried, kept so the row still names its destination.

              THE BADGE IS THE ONE THING CONDITIONAL, and only in a subtree
              React already owns: `owed` is null in the prerender and arrives
              from the fetch above after the sheet opens.
          */}
          <MenuRow
            id="app-menu-row-workshop"
            dataContextRow="workshop"
            elRef={workshopRowRef}
            href={slug ? `#app/${encodeURIComponent(slug)}/workshop` : '#'}
            icon={<BoardIcon />}
            label="Go to workshop"
            trailing={owed ? (
              <span
                id="app-menu-workshop-owed"
                title={`${owed} to vote`}
                aria-label={`${owed} to vote`}
                className="shrink-0 rounded-full bg-violet-600 px-1.5 text-[0.6875rem] font-semibold leading-5 text-white"
              >
                {owed}
              </span>
            ) : null}
          />
          {/*
              #2763: the TWO-PANE route. `#app/<slug>/dev/chat` was the old
              full-screen discussion; `#messages/app/<slug>` opens the same
              thread in the Messages screen's right pane with the
              conversation list still on the left at desktop widths (the
              router's `parts[1] === 'app'` branch in public/js/app.js calls
              App.navigateToMessages(null, slug)). It is what the inbox's own
              rows link to, so the menu and the inbox now agree.
          */}
          {/* On a platform tab the discussion is the PLATFORM's, and the row
              says so — the design's "Go to platform discussion". Decided
              after mount (`mounted` above): the prerender and the hydrating
              render both print the app wording, and the platform's arrives
              one commit later. */}
          <MenuRow
            id="app-menu-row-discussion"
            elRef={discussionRowRef}
            href={slug ? `#messages/app/${encodeURIComponent(slug)}` : '#messages'}
            icon={<ChatIcon />}
            label={mounted && target === 'platform' ? 'Go to platform discussion' : 'Go to app discussion'}
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
          {/*
              CONTINUE (#2779 follow-up), BELOW the app's own rows: Go to
              workshop, the discussion and About are this app's section, and
              your agent sessions on it follow under their own heading. See
              the comment on `continuing` above.
          */}
          {continuing.length ? (
            <div id="app-menu-continue" data-app-menu-continue={continuing.length}>
              <div className={SECTION}>Continue</div>
              {continuing.map((row, index) => (
                <MenuRow
                  key={row.key}
                  id={`app-menu-continue-${index}`}
                  dataContextRow="continue-agent"
                  href={row.href}
                  // Working, the spinner takes the icon's place (#3028); the
                  // icon slot is aria-hidden, so "Working" rides in the lead
                  // as words. Finished, the dot leads the name (#3013).
                  icon={row.activity === 'working' ? <AgentWorkingIcon /> : <SparklesIcon />}
                  label={row.title}
                  lead={row.activity === 'working'
                    ? <span className="sr-only">{ACTIVITY_LABEL.working}</span>
                    : <AgentActivityMark activity={row.activity} />}
                  trailing={(
                    <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">{row.detail}</span>
                  )}
                />
              ))}
              <MenuRow
                id="app-menu-continue-all"
                href="#messages"
                icon={<ChatIcon />}
                label="See all sessions"
                onClick={() => {
                  setMessagesFilter('agents');
                  AppContext.dismissForNav();
                }}
              />
            </div>
          ) : null}
          </>
          )}
        </nav>
      </div>
      <OverlayScrim panelId="apps-switcher-sheet" backdropId="apps-switcher-overlay" />
    </>
  );
}
