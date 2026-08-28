/**
 * #app-switcher-btn — the one control that names where you are (#1443).
 *
 * The header carries four things now, and only one of them opens a list:
 *
 *     [ Cool App ⌄ ] ........................... [ bell ] [ Improve ]
 *
 * ── The rule this control exists to keep ───────────────────────────────
 *
 * ONE CONTROL NAMES WHERE YOU ARE, AND ITS MENU LISTS EVERYWHERE YOU CAN
 * GO. A destination with its own page belongs in that menu; nothing else
 * does. Every other header slot the shell has grown over the years —
 * a hamburger, a home glyph, a messages bubble, an app-mode switch — was
 * some version of answering that same question a second time, in a second
 * place, with a second glyph. They are gone; this is the answer.
 *
 * ── What changed from #1431 ────────────────────────────────────────────
 *
 * #1431 built almost all of this: the store, the publish seam, the chevron,
 * the sheet behind it. It gated the control on `target && slug`, so the tab
 * appeared only inside an app and Home, Discover, Messages and Settings kept
 * an inert <h1>. That gate is the whole difference. A control that is
 * sometimes a control is worse than either — you cannot learn "the name at
 * the top is how you get around" from a thing that is a label four screens
 * out of five. So the chip is unconditional, and the menu behind it grew the
 * platform destinations to match.
 *
 * ── What is deliberately unchanged ─────────────────────────────────────
 *
 * The <h1> and its className are byte-identical to what #1431 shipped, and
 * the className stays a CONSTANT prop: ./use-header-layout.ts toggles
 * `.is-centered` on this node via classList, and a re-rendered class
 * attribute would drop it. `pointer-events-none` stays on the h1 and
 * `pointer-events-auto` on the chip inside it, so only the content-sized
 * chip takes taps and never the overlap. The 28px content-row floor
 * (tests/header-height-parity.test.js) is why the chip is `h-7`.
 *
 * ── It reads as a control, because it is one ───────────────────────────
 *
 * The chip carries the same 28px tinted surface as #back-btn and the bell:
 * `bg-zinc-50 / dark:bg-zinc-800`, rounded full. Sitting on the page ground
 * as bare text, it looked like the heading it replaced — which is the one
 * thing it must not look like, since the whole design rests on people finding
 * it tappable. Same tint as the glyph discs, so the bar reads as one set of
 * controls with the accent pill as the only filled thing.
 *
 * zinc-50 rather than zinc-100 for a reason worth knowing: the config
 * overrides the ramp and `zinc-100` is #eaeaea, which is EXACTLY the light
 * page ground. Giving the chip that value made a surface you could not see —
 * and it turned out the bell and #back-btn had been invisible in light mode
 * for the same reason. All three moved together.
 *
 * It carried the viewer's avatar for one round and does not any more: the
 * chip names the APP you are in, and a picture of you inside it was answering
 * a different question. Profile is a row of the menu behind it.
 *
 * ── The subtitle rides BESIDE the name, not under it ───────────────────
 *
 * A destination INSIDE an app (the Board, Activity) publishes a subtitle
 * rather than overwriting the title: the chip keeps naming the app and the
 * subtitle says which part of it. Before this, tapping through to a board
 * replaced "Notes" with "Board", so the one control that exists to say where
 * you are stopped saying the largest part of it — and the app's name was then
 * available nowhere on the screen.
 *
 * It shipped STACKED — name over subtitle, two lines squeezed into the 28px
 * content row at 14px + 2px + 10px, with `leading-none` on each line because
 * anything inherited spilled the pill. That fit, and it read as a two-line
 * label on a control that is one line everywhere else: the chip changed SHAPE
 * on the two screens that have a subtitle, and 10px stacked under 14px is
 * below the size at which either line is comfortably readable.
 *
 * So the two sit on ONE line, `items-baseline`, with the subtitle trailing the
 * name as a subscript — smaller and muted, sharing the name's baseline. That
 * buys back the whole 28px for a single line, which is why the name keeps the
 * h1's `text-base` whether or not there is a subtitle (it used to drop to
 * `text-sm` to make room) and why the subtitle can go up to 11px from 10px.
 * The chip is now the same shape on every screen, subtitled or not.
 *
 * The NAME is what truncates: it is `min-w-0 truncate` and the subtitle is
 * `shrink-0`, so a long app name shortens rather than evicting the word that
 * says which part of it you are looking at.
 *
 * ── A session has no chip ──────────────────────────────────────────────
 *
 * On a dev session the bar is ← + status on the left and the doing/seeing
 * pair on the right; the change's own name is in the strip below. The <h1>
 * still renders — it is what use-header-layout measures — but it stays empty
 * there, which is #1431's behaviour kept as-is.
 */

import type { RefObject } from 'react';

import { ChevronDownIcon } from '@/components/ui/icons';

import { useStoreState } from '../../lib/use-store-state';
import { headerTitleStore } from './header-title-store.js';
import { improveStore } from '../improve/improve-store.js';
import { appContextStore } from '../app-context/app-context-store.js';

export function AppSwitcherChip({ titleRef }: { titleRef: RefObject<HTMLHeadingElement | null> }) {
  const { text, subtitle } = useStoreState(headerTitleStore);
  const { tab, subTab } = useStoreState(improveStore);
  // The trigger reports its surface's state, which is #improve-btn's own
  // convention for the other panel in this bar. Read from the store rather
  // than written onto the node by the controller: the sheet has two other
  // ways to close (backdrop, Escape) and a trigger that only hears about the
  // ones routed through itself goes stale on both.
  const { open } = useStoreState(appContextStore);
  const onSession = tab === 'dev' && subTab === 'sessions';

  return (
    <h1
      ref={titleRef}
      id="header-title"
      className={"flex-1 min-w-0 text-base font-semibold pointer-events-none truncate\n               text-left"}
    >
      {onSession ? null : (
        <button
          id="app-switcher-btn"
          type="button"
          className={'pointer-events-auto inline-flex items-center gap-1 max-w-full h-7 '
            + 'pl-3.5 pr-2.5 rounded-full align-middle un-touch-target '
            + 'bg-zinc-50 text-zinc-900 hover:bg-white '
            + 'dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700'}
          aria-haspopup="dialog"
          aria-expanded={open ? 'true' : 'false'}
          aria-label={subtitle ? `${text}, ${subtitle}: open the menu` : `${text}: open the menu`}
          onClick={() => (window as unknown as {
            AppContext?: { toggle?: () => void };
          }).AppContext?.toggle?.()}
        >
          <span className="min-w-0 flex items-baseline gap-1.5">
            <span
              id="app-switcher-name"
              className="min-w-0 truncate"
            >
              {text}
            </span>
            {subtitle ? (
              <span
                id="app-switcher-subtitle"
                className="shrink-0 text-[0.6875rem] leading-none font-medium
                           text-zinc-500 dark:text-zinc-400"
              >
                {subtitle}
              </span>
            ) : null}
          </span>
          <ChevronDownIcon className="w-4 h-4 shrink-0 text-zinc-500 dark:text-zinc-400" aria-hidden="true" />
        </button>
      )}
    </h1>
  );
}
