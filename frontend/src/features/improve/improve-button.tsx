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
 * ../header/platform-header.tsx (the working cue is the emerald badge's
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
// BRAND YELLOW, not the accent blue — deliberately, and this is the one place
// in the authed chrome that carries it. The brand's CTA grammar (see the
// `cta` variant in @/components/ui/button.tsx) puts yellow on the single
// action that advances the build-discuss-decide loop, and in the product that
// action IS this button: Improve is how anyone proposes a change. Scarcity is
// the mechanism — every other control in the header stays quiet, so the one
// yellow pill reads as "this is where you act". Black ink at 17.7:1; the
// hairline matches the ink; the 1px offset shadow is the header-scale cut of
// the CTA's 2px (a 28px row smears at 2px).
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
const IMPROVE_BTN_CLASS =
  'relative inline-flex items-center h-7 px-3 rounded-full '
  + 'bg-[#ffee6f] hover:bg-[#ffe95c] border border-zinc-950 '
  + 'shadow-[1px_1px_0_0_#0c0b09] dark:border-black/60 dark:shadow-none '
  + 'text-zinc-950 text-sm font-semibold '
  + 'un-touch-target';

/**
 * Amber while a deploy runs, the progress violet once the platform has rolled
 * past us. Both sat fine on the old blue fill; on the yellow one amber-500
 * vanished into its own family, so `deploying` moved to the semantic
 * attention ink (#955b03 — the state that MEANS "heads-up", and the hue that
 * amber left for) and `stale` to the progress violet's light-theme ink.
 * Complete literals, not var(): the extractor cannot compile a var() into a
 * utility, and these two are the only consumers.
 */
const VERSION_DOT: Record<string, string> = {
  deploying: 'bg-[#955b03]',
  stale: 'bg-[#725aae]',
};

// Byte-identical to the bell's own badge run, which is the point: the two are
// twins at different corners of different controls, and a contrast/geometry
// test diffs them as such.
const AI_BADGE_CLS =
  'absolute -top-1 -right-1 min-w-[1.1rem] h-[1.1rem] px-1 rounded-full '
  + 'bg-emerald-500 text-white text-[0.65rem] font-bold flex items-center justify-center';

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
 * declared checks, the dot knows the violet "platform rolled past this tab"
 * state, and a running turn shows as a pulse on the emerald badge, which also
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
  const { target, open } = useStoreState(improveStore);
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
      Improve
      {/* Bottom-LEFT, where it landed when #1412's green count took the
          top-right corner. All three indicators are on this control again
          now, one per corner, so nothing needs to move.
          Attention ink, not amber-400: half of this dot overlaps the fill,
          and amber on the yellow pill disappears into its own family. */}
      <span
        ref={dotRef}
        id="feedback-queue-dot"
        className="hidden absolute -bottom-0.5 -left-0.5 w-2 h-2 rounded-full bg-[#955b03]"
      />
      <ImproveIndicators />
    </button>
  );
}
