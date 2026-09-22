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
 * ── The artwork is a raster, deliberately ─────────────────────────────
 *
 * @/components/ui/wordmark.tsx inlines the LOGOTYPE as paths because
 * `fill="currentColor"` lets one drawing take the ink of wherever it sits.
 * The mark is the opposite case: it is a two-colour lockup — a cream figure
 * on the brand's near-black tile — and a brand tile does not re-colour per
 * theme any more than an app's own icon does. So it is a file, next to the
 * landing's illustration, precached by the service worker because it is drawn
 * on every route. public/brand/README.md carries its provenance.
 */

import { ChevronDownIcon } from '@/components/ui/icons';

import { useStoreState } from '../../lib/use-store-state';
import { appContextStore } from '../app-context/app-context-store.js';

export function PlatformMark() {
  // The trigger reports its surface's state, read from the store rather than
  // written onto the node: the sheet has two other ways to close (backdrop,
  // Escape) and a trigger that only hears about the ones routed through
  // itself goes stale on both. Same convention as #improve-btn.
  const { open } = useStoreState(appContextStore);

  return (
    <button
      id="platform-mark-btn"
      type="button"
      className="shrink-0 inline-flex items-center gap-0.5 h-7 pr-0.5 un-touch-target
                 text-[color:var(--brand-ink)]"
      aria-haspopup="dialog"
      aria-expanded={open ? 'true' : 'false'}
      aria-label="Homeroom menu"
      onClick={() => (window as unknown as {
        AppContext?: { toggle?: () => void };
      }).AppContext?.toggle?.()}
    >
      {/*
          `alt=""` and aria-hidden: the button's aria-label above is the only
          producer of this control's accessible name, exactly as the chevron
          below. A named image here would be read twice.

          NO `loading="lazy"`. It is in the first screenful on every route,
          and a lazy header logo is a hole at the top of a cold paint.

          The rounded corner is the artwork's own — the file is a squircle
          tile with its own radius — so `rounded-[7px]` here only clips the
          box, it does not invent a shape. The hairline is what keeps a
          near-black tile from disappearing into the dark bar behind it, and
          it is the same inset hairline .app-icon-tile draws for the same
          reason one screen down.
      */}
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
