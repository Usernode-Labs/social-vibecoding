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
 * ── A session HAS a chip, and its subtitle is the lifecycle ────────────
 *
 * It did not until now. #1431 left the <h1> empty on a dev session and put
 * the lifecycle pill in the bar's left seat on its own, so the top of a new
 * change read as one grey word — "Draft" — and nothing on the screen said
 * which app was being changed. The change's own name is in the strip below,
 * but the APP's name was available nowhere.
 *
 * So the session route gets the same chip as everywhere else, and the pill
 * moved into it as the subtitle. That is the arrangement this file already
 * describes two sections up — the chip keeps naming the app, the subtitle
 * says which part of it you are in — with the lifecycle as the part. It also
 * means the answer to "which app is this" is the same control on every route,
 * rather than a control that disappears on the one screen where the question
 * is least obvious.
 *
 * The pill rides in whole rather than as plain text: it carries the tone
 * colour, the check glyph, the in-vote tally and the mid-turn spinner, and a
 * flattened `life.label` would have dropped all four.
 *
 * ── The chip draws the LOGOTYPE when it names the platform ─────────────
 *
 * On Home the chip says "Homeroom" — the product's own name, and the one name
 * on this bar the product has a drawing for. So it draws the logotype there
 * and an app's NAME everywhere else: the same sentence the control has always
 * spoken, in the right alphabet for each half of it.
 *
 * The switch is on the TITLE STRING rather than on a route, a slug or a flag,
 * because the string is the only fact this component has at FIRST render. The
 * comment at `showsWordmark` below carries the full argument — why every
 * richer signal arrives too late, and what reaching for one would cost.
 *
 * The mark takes `currentColor`, so it inherits `--brand-ink` exactly as the
 * word did: ONE drawing across light, dark and both app tones, which app.css
 * re-tokenises on #platform-header for all four combinations. There is no
 * `dark:` variant on it and there must not be one — a hand-written pair would
 * be right in two of those four and wrong in the other two, and a `dark:` twin
 * being present is exactly what stops the theme-ink guard noticing.
 *
 * It is 20px tall: `h-5`, plus the logotype's own 3.875:1 width written out as
 * a complete literal, because Tailwind's extractor is a regex over source text
 * and a computed class name is a class name that never compiles. `text-xl` is
 * the same 20px and is banned BY NAME in the header's ceiling test
 * (tests/header-height-parity.test.js), which is the other reason to size the
 * graphic as a box rather than as type. The explicit width earns its keep in
 * ./use-header-layout.ts, which measures this heading with a Range to decide
 * whether the title can centre on desktop: a replaced child with a resolved
 * width is one fewer browser dependency in that measurement. The CHIP is
 * still `h-7` — nothing about the 28px row moved.
 */

import type { RefObject } from 'react';

import { ChevronDownIcon } from '@/components/ui/icons';
import { Wordmark } from '@/components/ui/wordmark';

import { useStoreState } from '../../lib/use-store-state';
import { headerTitleStore } from './header-title-store.js';
import { improveStore } from '../improve/improve-store.js';
import { appContextStore } from '../app-context/app-context-store.js';
import { sessionHeaderStore } from '../dev-chat/session-header-store';
import { MergeStatusPill } from '../dev-chat/session-header';

// The one string that means "the chip is naming the platform, not an app".
// It is header-title-store.js's INITIAL, which is why the prerendered document
// and the first client render agree about it without this component learning
// anything from anywhere.
const PLATFORM_NAME = 'Homeroom';

export function AppSwitcherChip({ titleRef }: { titleRef: RefObject<HTMLHeadingElement | null> }) {
  const { text, subtitle } = useStoreState(headerTitleStore);
  const { tab, subTab } = useStoreState(improveStore);
  // The trigger reports its surface's state, which is #improve-btn's own
  // convention for the other panel in this bar. Read from the store rather
  // than written onto the node by the controller: the sheet has two other
  // ways to close (backdrop, Escape) and a trigger that only hears about the
  // ones routed through itself goes stale on both.
  const { open } = useStoreState(appContextStore);
  const { life } = useStoreState(sessionHeaderStore);
  const onSession = tab === 'dev' && subTab === 'sessions';
  // On a session the subtitle is the lifecycle pill; everywhere else it is the
  // plain word the title store published (Board, Activity).
  const sessionPill = onSession && life ? <MergeStatusPill life={life} /> : null;
  const showSubtitle = onSession ? !!sessionPill : !!subtitle;
  // The accessible name says the lifecycle in words either way — the pill's
  // tone and glyph are decoration, and `life.label` is the text under them.
  const spokenSubtitle = onSession ? (life?.label || '') : subtitle;
  // Draw the logotype instead of the word when the chip is naming the
  // platform. The test is on `text` because that is the ONLY fact available at
  // first render: improveStore.target — the obvious "am I on the platform"
  // signal — is `null` in the store's INITIAL and is published by
  // Home.publishImproveTarget() only after Home loads, so gating on it would
  // prerender the WORD and swap it for the graphic after hydration. Not a
  // mismatch, but a visible flicker on every cold load, and on the
  // service-worker-cached document that window is seconds, not frames.
  //
  // `&& !showSubtitle` is deliberate, and the reason is a coincidence worth
  // naming: the self-hosted platform app is ITSELF named "Homeroom", so
  // `text === PLATFORM_NAME` is true inside that app too — on its Dev screen,
  // whose subtitle is "Workshop", and on a session, whose subtitle is the
  // lifecycle pill. Both share the `items-baseline` line below, and an SVG has
  // no text baseline: a replaced element's baseline is its bottom margin edge,
  // so the subtitle would sit against the mark's bottom rather than on its
  // optical baseline. So the guard covers the SUBTITLED coincidences, and that
  // is the whole of what it covers.
  //
  // The UNSUBTITLED one it does not cover, and the honest reading is that the
  // mark draws on a third kind of screen: an app literally NAMED "Homeroom"
  // publishes a BARE title, and the string test cannot tell that name from the
  // platform's. Every bare set is such a screen — public/js/app.js's app-open
  // (`App.setHeaderTitle(AppView.appData.name)`), the App tab and a session
  // deep link (public/js/app-view.js `renderAppTab` and its
  // `subTab === 'sessions'` branch, where a session with no lifecycle pill yet
  // has no subtitle either), and Browse's detail page (../apps/browse.js,
  // `app?.name || Browse._slug`). The self-hosted row is one of those apps, at
  // #app/usernode-2d5619; so is any child app somebody names that. NO BOARD
  // COVERS THOSE SCREENS — the design board for the logotype is the HOME
  // header only.
  //
  // It ships that way on a judgement rather than by oversight: on those
  // screens the mark IS that app's name, drawn in the one alphabet the product
  // has for the word, so the chip is still naming where you are. Unreviewed,
  // not wrong. And the condition that would narrow it is the worse defect: no
  // route, slug or flag is available at FIRST render — the paragraph above is
  // why — so gating on one would prerender the WORD and swap it for the
  // graphic after hydration, flickering on every cold load of every route to
  // correct a screen where the drawing already says the right name. Widening
  // or narrowing this is a design decision, not a code one — bring a board.
  const showsWordmark = text === PLATFORM_NAME && !showSubtitle;

  return (
    <h1
      ref={titleRef}
      id="header-title"
      className={"flex-1 min-w-0 text-base font-semibold pointer-events-none truncate\n               text-left"}
    >
      <button
        id="app-switcher-btn"
        type="button"
        className={'pointer-events-auto inline-flex items-center gap-1 max-w-full h-7 '
          + 'pl-3.5 pr-2.5 rounded-full align-middle un-touch-target font-bold '
          + 'border border-[color:var(--brand-line)] bg-[color:var(--brand-tint)] '
          + 'text-[color:var(--brand-ink)]'}
        aria-haspopup="dialog"
        aria-expanded={open ? 'true' : 'false'}
        aria-label={spokenSubtitle ? `${text}, ${spokenSubtitle}: open the menu` : `${text}: open the menu`}
        onClick={() => (window as unknown as {
          AppContext?: { toggle?: () => void };
        }).AppContext?.toggle?.()}
      >
        <span className="min-w-0 flex items-baseline gap-1.5">
          <span
            id="app-switcher-name"
            className="min-w-0 truncate"
          >
            {/* No `title` on the mark, and `aria-hidden` on it, exactly as the
                caret below: the button's `aria-label` above is the ONLY
                producer of this control's accessible name, and it interpolates
                `text` whatever this span happens to draw. So the gate
                sentence — "the accessible name stays Homeroom" — is satisfied
                by that template UNCHANGED, and has been all along: because
                aria-label on a button overrides its contents, the literal name
                here has always been the longer "Homeroom: open the menu". Do
                NOT add a role="img", a nested title element or an sr-only span
                to make the word appear a second time — it would be read
                twice, and the enclosing h1 already takes its own name from
                this button's label by name-from-content traversal. */}
            {showsWordmark
              ? <Wordmark className="h-5 w-[77.5px]" aria-hidden="true" />
              : text}
          </span>
          {showSubtitle ? (
            <span
              id="app-switcher-subtitle"
              className="shrink-0 text-[0.6875rem] leading-none font-medium
                         text-zinc-500 dark:text-zinc-400"
            >
              {/* `#header-status-pill` keeps its id here: it is still the
                  lifecycle pill's seat, it is still inside #platform-header,
                  and the declared check that looks for it by that path does
                  not care which descendant holds it. */}
              {onSession
                ? <span id="header-status-pill" className="min-w-0 truncate">{sessionPill}</span>
                : subtitle}
            </span>
          ) : null}
        </span>
        <ChevronDownIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
      </button>
    </h1>
  );
}
