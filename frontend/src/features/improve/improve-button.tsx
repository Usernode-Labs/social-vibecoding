/**
 * #improve-btn — the header control that opens the Improve panel.
 *
 * It replaced three things at once: the App/Dev segmented switch, the feedback
 * bubble and the work cog. The switch is the one worth explaining, because this
 * button inherits its lifecycle exactly. That control was shown by
 * `App.ImproveStatus.setAppOpen()` and hidden everywhere else; this one is shown
 * whenever ../improve/improve-store.js carries a TARGET.
 *
 * TWO publishers put one there. `setAppOpen()` does it for an open app, and
 * `Home.publishImproveTarget()` does it for the platform's own self-hosted row
 * while home is on screen (#1367) — "improve Social Vibecoding itself".
 *
 * That second one shipped once before and was reverted (#1363), which is worth
 * knowing before touching it: the first version re-targeted only on the RETURN paths,
 * so a cold boot at `/` never published anything and the button read as a
 * stale leftover of the app just closed. It publishes from `Home.render()`
 * now — the call every path funnels through — so the button is either there on
 * every home visit or on none.
 *
 * ── Why a labelled pill and not an icon ────────────────────────────────
 *
 * "improve" has no conventional glyph the way a bell or a hamburger does, so
 * it is a word. It was a plain violet text action for as long as it was
 * CONTEXTUAL — quiet on purpose, one of several things that could occupy the
 * slot. Now that it is the standing action on every screen, the board draws
 * it as the bar's one FILLED control, and a bare word beside two glyphs
 * reads as a caption rather than as the primary thing to do. Sized to the
 * header's 28px content row either way.
 *
 * ── What the button says while the panel is SHUT ───────────────────────
 *
 * One thing: `#feedback-queue-dot` (bottom-left, amber) came with the retired
 * feedback button, kept its id and its writer, and belongs here because this
 * button is the only way to reach the feedback dialog — an unsent draft with
 * no visible cue is the failure it exists to prevent.
 *
 * #1412 parked the green session count, the version dot and a
 * spinner-while-working glyph here; the Streamlined Concept re-homed all of
 * that onto the hamburger's badge cluster — see <MenuIndicators/> in
 * ../header/platform-header.tsx (the working cue is the green badge's
 * pulse there) — because this slot slims to a plain word and the board keeps
 * the hamburger as THE indicator cluster.
 *
 * ── The slot is NOT contextual any more ────────────────────────────────
 *
 * For a while this control swapped shape by route: the word on an app's
 * default screens, an EYE on the Dev screens, and an eye/pencil PAIR on a
 * session that had a staging preview. Improve turned out to be the action
 * people reach for most, and a control that both moves and disappears is a
 * bad one to make load-bearing — it was absent exactly on a session with no
 * preview yet, which is where describing a change is most likely. It renders
 * on every screen carrying a target now. The doing<->seeing loop it used to
 * displace lives in the session strip
 * (../dev-chat/session-header.tsx), beside the name of the change it acts
 * on.
 *
 * The dot's visibility rides the visibility store; nothing here may be
 * written by id from a classic module: this button is React-owned end to
 * end, and a pre-hydration `classList` write is a mismatch React patches
 * straight back out.
 */

import { useRef } from 'react';

import { ArrowPathIcon, LightBulbIcon, SpinnerArcIcon } from '@/components/ui/icons';

import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import { useStoreState } from '../../lib/use-store-state';
import { improveStore } from './improve-store.js';
import { Improve } from './improve-controller.js';

/**
 * `h-7` matches the header's 28px content-row ceiling — the same constraint
 * the App/Dev switch was pinned to, and for the same reason: this is the only
 * thing that appears in the header when an app opens, so its height IS the
 * header's height there.
 */
// A FILLED accent pill, per the Streamlined Concept board's session bar
// (nodes 380:9672 and 380:9324 — the CHAT UI and APP PREVIEW frames).
//
// ── Read this before "restoring" the plain text action ─────────────────
//
// `git log -S "Improve is NOT a button"` finds a93c77f1, "Owner review round
// 2: drawer regrouped, Improve as plain text", which moved this run off
// exactly this fill and left a comment saying the owner had called it twice.
// That looks like this pill is a regression. It is not, and the reason is a
// date: THE BOARD IS NEWER THAN THAT REVIEW, confirmed by the owner — it is
// where the current toolbar concept comes from (Improve beside the bell and
// messages glyphs, with the title tab's dropdown opening the Apps sheet), and
// it draws Improve filled.
//
// The review is not wrong either, for the bar it was written about. At
// a93c77f1 the header's right group was the hamburger and this control, full
// stop — no bell, no chat bubble — and "the header stays quiet and the word
// carries it" is right for that bar. That bar no longer exists: the hamburger
// is retired, two glyphs stand where it was, and Improve became the standing
// action on every screen rather than a contextual one. A bare word among
// glyphs reads as their caption; the board's answer is the one filled control
// in the bar.
//
// `violet-600` is #ffc93a — the shell's accent is a YELLOW, not a violet (see
// tailwind.config.js: the scale name is an identity, not a hue), which is
// exactly the fill the board draws. (That line said "the blue the board
// draws", which contradicted its own first clause: blue is what `azure`
// carries, and it is the one colour this pill is not.)
//
// h-7 and no vertical padding are the header's 28px content-row ceiling,
// pinned by tests/header-height-parity.test.js — a filled pill keeps it by
// taking its height from `h-7` and its shape from `rounded-full`.
// No trailing margin. `mr-2.5` sat here from when this button had siblings to
// its right; as the LAST control in the bar it was 10px of dead space between
// Improve and the header's own px-4 edge, so the accent pill never actually
// reached the right margin the rest of the shell aligns to. The bell↔Improve
// gap is the right group's `gap-1` now — spacing belongs to the layout, not to
// the last child's margin (#1443).
//
// `gap-1.5` arrived with the leading glyph below and is the one thing that
// change did not bring with it: <ImproveGlyph/> renders an `w-4` SVG as a flex
// item immediately before the word, and with no gap the two touch. 6px is the
// same figure the header's own right group uses between its glyphs (`gap-1`
// there is between whole controls; inside one control the label wants a little
// more). It is spacing, so it does not disturb h-7, which still owns the
// height.
const IMPROVE_BTN_CLASS =
  'relative inline-flex items-center gap-1.5 h-7 px-3 rounded-full '
  + 'bg-violet-600 hover:bg-violet-500 text-black text-sm font-semibold '
  + 'un-touch-target';

/**
 * Amber while a build is on its way, blue once it is here to switch to.
 *
 * FOUR states, not two. `stale` was one bit — "the platform rolled past this
 * tab" — and it split into the build's actual lifecycle: `deploying` and
 * `downloading` are both in-flight, `ready` and `failed` are both "there is
 * something to reload onto". The panel's own <UpdateStatus/> reads the same
 * four (../improve/improve-panel.tsx) and this dot is its cue in the header,
 * so the two must agree on the state names.
 *
 * The COLOURS are the ones a yellow accent leaves available. The arrived-at
 * state was spelled `bg-violet-400`, which was the accent on a violet palette
 * and is a pale yellow here — the one hue this shell reserves for the filled
 * action, and this pill IS that action, so a yellow dot on it says nothing.
 * `azure-400` is the blue that carried the same meaning before the split.
 * Both are 8px discs carrying no ink, so they are SURFACES — APCA is a text
 * metric and says nothing useful about them; they sit at the step that reads
 * as a dot.
 */
const VERSION_DOT: Record<string, string> = {
  deploying: 'bg-amber-500',
  downloading: 'bg-amber-500',
  ready: 'bg-azure-400',
  failed: 'bg-azure-400',
};

// The glyph on the button's leading edge, and the reason the button has one.
//
// "Improve" alone said what the control was FOR and nothing about whether
// anything was happening. The three states it can be in are all things the
// viewer wants at a glance, from a control that is on screen everywhere:
//
//   lightbulb — nothing in flight; the button is an invitation
//   spinner   — this app or the platform is building or downloading a build
//   refresh   — a new build is here, and the panel offers the reload
//
// `w-4 h-4` inside the 28px content row, so the header height contract
// (tests/header-height-parity.test.js) is untouched — no taller than the text
// beside it. `animate-spin` is the caller's, per the note on SpinnerArcIcon.
//
// THE GLYPHS NEED THE ICON SET TO CARRY THEM, and the two arrived by different
// routes — worth separating, because an earlier version of this note said both
// were un-retired and only half of that is true.
//
// `LightBulbIcon` IS an un-retire: it was dropped from @/components/ui/icons.tsx
// when the set moved to lucide, on the then-true grounds that nothing imported
// it, and the module header lists it among the eight retired that way with the
// slug to take it back from (`lightbulb`). This surface wants it back, so the
// header's retired list shrinks by one and the export returns transcribed.
//
// `ArrowPathIcon` is NOT. It never existed on this branch — platform main's
// #1474 introduced it after our base — so there is no retired entry to find and
// no `refresh-cw` in any retired-slug list. It is a NEW export whose NAME is
// inherited from Heroicons while its DRAWING is lucide's `refresh-cw`, which is
// the one place in this merge where pixels move: four subpaths at stroke 2 in
// place of one thin arc at 1.5.
//
// Either way the rule is the same — transcribed against lucide's file of that
// name, never redrawn, like every other glyph in that module.
const BUSY_STATES = ['deploying', 'downloading'];
const READY_STATES = ['ready', 'failed'];

function ImproveGlyph({ versionState, appDeploying }: {
  versionState: string;
  appDeploying: boolean;
}) {
  const cls = 'w-4 h-4 shrink-0';
  if (appDeploying || BUSY_STATES.includes(versionState)) {
    return <span id="improve-btn-glyph" data-state="busy" className="contents">
      <SpinnerArcIcon className={`${cls} animate-spin`} aria-hidden="true" />
    </span>;
  }
  if (READY_STATES.includes(versionState)) {
    return <span id="improve-btn-glyph" data-state="ready" className="contents">
      <ArrowPathIcon className={cls} aria-hidden="true" />
    </span>;
  }
  return <span id="improve-btn-glyph" data-state="idle" className="contents">
    <LightBulbIcon className={cls} aria-hidden="true" />
  </span>;
}

// Byte-identical to the bell's own badge run APART FROM THE FILL, which is the
// point: the two are twins at different corners of different controls, and
// tests/header-status-pane.test.js diffs their class lists with the colour
// token dropped and requires equality.
//
// TWO THINGS MOVED HERE AND BOTH ARE PAIRED WITH #notifications-badge in
// ../header/platform-header.tsx — that badge must carry the same geometry or
// the equality check above fails:
//
//   * `1.1rem` -> `1.125rem`. 17.6px was a spelling nobody chose; 18px is what
//     this same role measures at `.messages-unread` (public/css/app.css) and
//     in @/components/ui/feed.tsx.
//   * `emerald-500` -> `meadow-700`. `emerald` is not one of the seven
//     overridden ramps, so this badge was rendering an untuned STOCK green
//     beside the kit's own — read the hex, not the key. The STEP moves too,
//     because no ink rescues a -500 fill: white on stock emerald-500 measured
//     Lc -54.2 and white on meadow-500 is -60.0, both under the 75 body
//     minimum. -700 carries white at -87.8, and it is the
//     `bg-meadow-700 … text-white` recipe the discovery tiles' "added" badge
//     takes in the SAME change (../home/panels/discover.tsx and
//     ../home/home.js) — one green fill under white ink, not two. Move all
//     three together.
//
// AND THE THING THAT WAS NOT SETTLED, NOW SETTLED. This comment shipped a
// draft claiming the bell was `bg-red-600` and left the choice open on that
// basis; the bell has never been -600. It was `bg-red-500` when this run
// started and ../header/platform-header.tsx moved it to `bg-red-700` in the
// SAME run, for the same reason and with the same measurement — so the pair
// is level (-85.2 bell, -87.8 here) and meadow-700 is right as it stands.
// The history is left standing rather than deleted because a number read out
// of a comment instead of out of the tree is what went wrong twice here:
// MEASURE THE BELL BEFORE MOVING THIS, and move all three twins together.
const AI_BADGE_CLS =
  'absolute -top-1 -right-1 min-w-[1.125rem] h-[1.125rem] px-1 rounded-full '
  + 'bg-meadow-700 text-white text-xs font-bold flex items-center justify-center';

/**
 * What changed while you were not looking — three corners of one control.
 *
 * #1412 built these for the Improve button and the Streamlined header then
 * parked them on the hamburger, because that was the control whose drawer
 * held the sessions. It does not any more: this panel is the sessions
 * surface, so the cue that says "go and look" belongs on the control that
 * opens it. Everything #1412 built is kept whole — the writers publish
 * through improveStore (Improve.setSessionBadge / setVersionState, never a
 * classList write by id), the count carries `data-session-done` for the
 * declared checks, the dot knows the blue "there is a build to switch to"
 * state, and a running turn shows as a pulse on the green badge, which also
 * appears dot-sized and empty when a turn runs with nothing unread yet.
 *
 * Three corners, one rule: the outbox dot is bottom-left, the session count
 * top-right, the version dot bottom-right — so a deploy rolling out during an
 * unread finish cannot hide underneath the count.
 *
 * At rest everything is `hidden` with the exact class runs the prerender
 * ships, so hydration matches.
 */
function ImproveIndicators() {
  const { working, sessionUnread, sessionDone, versionState } = useStoreState(improveStore);
  const showAi = working || sessionUnread > 0;
  return (
    <>
      <span
        id="notifications-badge-ai"
        data-session-done={String(sessionDone)}
        className={showAi
          ? `${AI_BADGE_CLS}${working ? ' animate-pulse' : ''}`
          : `hidden ${AI_BADGE_CLS}`}
      >
        {sessionUnread > 0 ? (sessionUnread > 99 ? '99+' : String(sessionUnread)) : ''}
      </span>
      {/* Renamed with the move. It was #header-menu-deploy-dot, from when the
          version rows lived in that drawer's footer — a `header-menu-*` id on
          the Improve button would be a lie that outlives everyone who
          remembers it. */}
      <span
        id="improve-version-dot"
        className={VERSION_DOT[versionState]
          ? `absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full ${VERSION_DOT[versionState]}`
          : 'hidden absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full bg-amber-500'}
        aria-hidden="true"
      >
      </span>
    </>
  );
}

export function ImproveButton() {
  const { target, open, versionState, deploying } = useStoreState(improveStore);
  // "this app" is wrong on home, where the target is the platform itself
  // (#1367). The visible label stays the single word "Improve" at both — what
  // is being improved is named in the panel's own header.
  const label = target === 'platform' ? 'Improve the platform' : 'Improve this app';

  // #1054's outbox dot, moved off the retired feedback button. It ships hidden
  // and its writer publishes through the visibility store rather than toggling
  // the class by id, because a pre-hydration classList write is a mismatch
  // React patches back to the constant className.
  const dotRef = useRef<HTMLSpanElement>(null);
  useVisibilityHiddenClass(dotRef, 'feedback-queue-dot', false);

  // The button materially changes the header's right-group width, which is one
  // of the two inputs to the title's centered-vs-flow decision. The group's
  // ResizeObserver catches it a frame later on its own; this is the explicit
  // hook `App.ImproveStatus.setAppOpen()` used to call for the App/Dev switch,
  // so the title does not visibly jump.
  useIsomorphicLayoutEffect(() => {
    (window as unknown as { HeaderLayout?: { refresh?: () => void } })
      .HeaderLayout?.refresh?.();
    // `target` is the only input left: the control no longer swaps shape by
    // route, so the right group's width moves only when the word itself
    // appears or clears.
  }, [target]);


  // Improve renders on EVERY screen that has a target, Dev included.
  //
  // It used to be the contextual slot: a violet pill in the app's default
  // state, an EYE on the Dev screens, and on a session with a preview an
  // eye/pencil PAIR. That made the one control people reach for most a thing
  // that moved and sometimes vanished — and it vanished on exactly the
  // screens (a session with no preview yet) where wanting to describe a
  // change is most likely. So the slot stops being contextual: Improve is
  // always the header's right-hand action, next to the Messages and
  // Notifications glyphs, and the doing<->seeing loop it used to displace
  // moved down to the session strip, where the change it acts on is named
  // (see ../dev-chat/session-header.tsx).
  const pill = !!target;

  return (
    <button
      id="improve-btn"
      type="button"
      className={pill ? IMPROVE_BTN_CLASS : `hidden ${IMPROVE_BTN_CLASS}`}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={open ? 'true' : 'false'}
      onClick={() => Improve.toggle()}
    >
      <ImproveGlyph versionState={versionState} appDeploying={deploying} />
      Improve
      {/* Bottom-LEFT, where it landed when #1412's green count took the
          top-right corner. All three indicators are on this control again
          now, one per corner, so nothing needs to move. */}
      <span
        ref={dotRef}
        id="feedback-queue-dot"
        className="hidden absolute -bottom-0.5 -left-0.5 w-2 h-2 rounded-full bg-amber-400"
      />
      <ImproveIndicators />
    </button>
  );
}
