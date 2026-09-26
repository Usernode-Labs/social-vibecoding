/**
 * #platform-mark-btn — the Homeroom mark, and the menu behind it.
 *
 * ── What it replaces, and why the chip could not keep the job ──────────
 *
 * #1443's charter put one control at the top-left of every screen: the
 * app's name with a chevron, whose menu listed everywhere you could go.
 * "ONE CONTROL NAMES WHERE YOU ARE, AND ITS MENU LISTS EVERYWHERE YOU CAN
 * GO." That was right about the menu and wrong about the chip, for a reason
 * the hosts this shell is modelled on all agree on: the menu under a
 * mini-app holds the MINI-APP's options, and the host's own sections live on
 * a permanent bar. WeChat, Telegram, Discord, Slack and Teams all draw both.
 *
 * The shell had no bar, so both lists were in the chip's menu. Now it has
 * one (features/nav/), and the split can land: the tab bar carries the
 * platform's places, and this control carries the app's options.
 *
 * Which means the TRIGGER had to move too. The chip named the app and opened
 * a menu about the platform, which read as one sentence while the menu held
 * both lists and reads as a non sequitur once it holds only the app's. So the
 * name goes back to being a name (../header/header-title.tsx) and the menu
 * gets its own button.
 *
 * ── Why the mark, rather than the three dots every host uses ───────────
 *
 * A "…" is what WeChat, Telegram, Alipay, Chrome's Custom Tabs and Safari's
 * view controller all draw, and it is the honest default: it says "more,
 * here" and nothing else. Two things argued for the mark instead, and both
 * are about this product rather than about the pattern:
 *
 *   - THE GAME PLATFORMS USE THEIR LOGO for the same button — Roblox's, and
 *     the Steam button on a Deck — and they are the hosts whose mini-apps are
 *     made BY the people using them, which is this product exactly. The logo
 *     says whose menu it is, and inside somebody else's app that is the
 *     question the button is answering.
 *   - IT IS THE ONE PLACE THE PLATFORM SIGNS THE SCREEN. In an app, the
 *     header is otherwise entirely that app's: its tile, its name, its close
 *     button. A "…" there belongs to the app; the mark does not.
 *
 * ── Why it is NOT framed, when the bell beside it is ───────────────────
 *
 * Two identical containers side by side read as a segmented control — one
 * control with two halves — and these are two controls with nothing to do
 * with each other: one tells you something happened, the other opens a menu.
 * One container around both reads as one control, which is worse. So they
 * differ in KIND: the bell is a glyph in a tinted disc, the mark is artwork
 * with a chevron and no frame at all. That is the arrangement that reads as
 * "two buttons" without either of them having to shout.
 *
 * ── The artwork is inline source now, not a raster ─────────────────────
 *
 * This used to be `<img src="/brand/homeroom-mark.png">`, a two-colour
 * lockup baked to pixels because "a brand tile does not re-colour per theme
 * any more than an app's own icon does." The TILE is still true of that: it
 * is drawn here as a plain `bg-black` square, unrelated to either theme. The
 * ink stopped being true of it the day the mark's own colour became the
 * platform accent (`violet-600` / `--accent`, `#0a6ee0`) rather than a fixed
 * brand cream — a raster and a Tailwind config are two sources of truth for
 * the same colour, and they will drift the next time the accent moves.
 * `LogoMark` (@/components/ui/logo-mark.tsx) is `fill="currentColor"`, same
 * convention as `Wordmark` above it, so `text-violet-600` here is the only
 * place the colour is spelled. `public/brand/homeroom-mark.png` itself is
 * unchanged and still committed — ../app-context/about-pane.tsx and
 * ../profile/profile-view.tsx still draw it — only the header's own use is
 * retired. public/brand/README.md carries the provenance.
 */

import { useRef } from 'react';

import { LogoMark } from '@/components/ui/logo-mark';
import { ChevronDownIcon, SpinnerRingIcon } from '@/components/ui/icons';

import { useStoreState } from '../../lib/use-store-state';
import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import { appContextStore } from '../app-context/app-context-store.js';
import { improveStore } from '../improve/improve-store.js';

/**
 * ── The two dots, and why the mark carries them ────────────────────────
 *
 * They were the corners of `#improve-btn`, the header pill #2718 retired.
 * Both are LIVE FACTS about work behind a control, and both had to land on
 * something that is on screen on every route — a cue inside a menu is not a
 * cue. The mark is that control, and it is also the one whose menu now holds
 * both destinations: "Give feedback" for the outbox and the Improve row for
 * the running turn.
 *
 * Ids, colours, corners and writers are all unchanged, and the rule that
 * separated the two corners still holds: the outbox dot is bottom-left and
 * the working dot is top-right, so an unsent draft and a running turn cannot
 * hide under each other.
 *
 * They sit on the TILE, not on the button, because the button is artwork plus
 * a chevron and a dot pinned to its outer corner would hang off the chevron —
 * which reads as a badge on the disclosure rather than on the mark. The tile
 * is the thing the dot is about.
 *
 * TWO CORNERS IS THE WHOLE BUDGET. The build state — deploying, or a build
 * downloaded and ready to reload — is the obvious candidate for a third, and
 * it is deliberately not here: see ../improve/improve-glyph.tsx for what it
 * costs and why the menu row's glyph is where it is paid. A 26px tile with
 * three coloured dots on it is a status readout, not a mark.
 */
/*
 * The working cue is a small blue spinner on a neutral disc, a badge on the
 * tile's corner like the bell's (#2779 follow-up; it was an 8px emerald
 * pulse). A spinner says "running right now" without a legend, which the
 * green dot needed a tooltip for (#3015). Still top-right, still no count,
 * still hidden at rest. The disc is the header's own bg-zinc-200 /
 * dark:bg-zinc-900 (platform-header.tsx), so it separates the arc from the
 * tile on any tint an app gives the bar.
 */
const WORKING_DOT_CLS =
  'absolute -top-1.5 -right-1.5 flex items-center justify-center w-[15px] h-[15px] rounded-full '
  + 'bg-zinc-200 text-violet-600 dark:bg-zinc-900 dark:text-violet-400';
const WORKING_TITLE = 'One of your changes is building';

export function PlatformMark() {
  // The trigger reports its surface's state, read from the store rather than
  // written onto the node: the sheet has two other ways to close (backdrop,
  // Escape) and a trigger that only hears about the ones routed through
  // itself goes stale on both. Same convention the retired #improve-btn used.
  const { open } = useStoreState(appContextStore);
  // A dev session the viewer can see is mid-turn. It ships `hidden` with
  // exactly the class run the prerender emits, rendered rather than absent so
  // hydration matches and the id stays in the shell's declared inventory.
  const { working } = useStoreState(improveStore);

  // #1054's outbox dot. Its writer publishes through the visibility store
  // rather than toggling the class by id, because a pre-hydration `classList`
  // write is a mismatch React patches straight back to the constant
  // className — the same seam it ran on inside the retired pill.
  const dotRef = useRef<HTMLSpanElement>(null);
  useVisibilityHiddenClass(dotRef, 'feedback-queue-dot', false);

  return (
    <button
      id="platform-mark-btn"
      type="button"
      /*
          `h-7` is the header's 28px content-row ceiling, and this control is
          what has to hold it: with #improve-btn retired (#2718) the mark is
          the tallest thing in the bar when an app opens, so its height IS the
          in-app header height. That is the #909 invariant, which
          tests/header-height-parity.test.js re-asserts — no vertical padding,
          the class owns the height, and the 26px tile fits inside it with a
          pixel of air either side.
      */
      className="shrink-0 inline-flex items-center gap-0.5 h-7 pr-0.5 un-touch-target
                 text-[color:var(--brand-ink)]"
      aria-haspopup="dialog"
      aria-expanded={open ? 'true' : 'false'}
      aria-label="Homeroom menu"
      /* What the spinner means, on hover (#3015). The menu this opens says
         it too, for a touch screen (../improve/actions.tsx UpdateStatus). */
      title={working ? WORKING_TITLE : undefined}
      onClick={() => (window as unknown as {
        AppContext?: { toggle?: () => void };
      }).AppContext?.toggle?.()}
    >
      {/*
          `aria-hidden` on the mark itself: the button's aria-label above is
          the only producer of this control's accessible name, exactly as the
          chevron below. A named glyph here would be read twice.

          The rounded corner is drawn, not clipped from a file — `bg-black
          rounded-[7px]` is the whole tile now. The hairline is what keeps a
          near-black tile from disappearing into the dark bar behind it, and
          it is the same inset hairline .app-icon-tile draws for the same
          reason one screen down.
      */}
      <span className="relative shrink-0 inline-flex">
        <span
          className="platform-mark-tile w-[26px] h-[26px] rounded-[7px] shrink-0
                      inline-flex items-center justify-center bg-black"
        >
          <LogoMark aria-hidden="true" className="w-[18px] h-auto text-violet-600" />
        </span>
        {/* Bottom-LEFT: an unsent feedback draft, waiting for a connection. */}
        <span
          ref={dotRef}
          id="feedback-queue-dot"
          className="hidden absolute -bottom-0.5 -left-0.5 w-2 h-2 rounded-full bg-amber-400"
        />
        {/* Top-RIGHT: one of your changes is building right now. A live fact, true only
            while it is true, so it needs no dismissal and carries no count —
            the count that used to be here went to the bell in #1610, where
            the list that clears it lives. */}
        <span
          id="improve-working-dot"
          className={working ? WORKING_DOT_CLS : `hidden ${WORKING_DOT_CLS}`}
          aria-hidden="true"
        >
          <SpinnerRingIcon className="w-3 h-3 animate-spin motion-reduce:animate-none" />
        </span>
      </span>
      <ChevronDownIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
    </button>
  );
}
