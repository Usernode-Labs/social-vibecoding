/**
 * #improve-btn — the header control that opens the Improve panel.
 *
 * It replaced three things at once: the App/Dev segmented switch, the feedback
 * bubble and the work cog. The switch is the one worth explaining, because this
 * button inherits its lifecycle exactly. That control was shown by
 * `App.DrawerStatus.setAppOpen()` and hidden everywhere else; this one is shown
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
 * ── Why a labelled pill and not a fifth icon ───────────────────────────
 *
 * Everything else in the right group is a 28px glyph, and a sixth would have
 * been unreadable — "improve" has no conventional glyph the way a bell or a
 * hamburger does. It also has to carry the weight the segmented switch carried:
 * that control was the one thing in the header that changed what the screen
 * WAS, and its replacement should not read as another notification affordance.
 * So it is a pill with a word in it, sized to the header's 28px content row.
 *
 * ── What the button says while the panel is SHUT ───────────────────────
 *
 * Four things, in three corners, and each is here because the thing it is
 * about is behind this button rather than anywhere else:
 *
 *   - THE GLYPH is a spinner instead of a lightbulb while a dev session is
 *     mid-turn. It is the ambient "something is running" cue, and it costs no
 *     space at all.
 *   - `#notifications-badge-ai` (top-right, green) is the unread
 *     session-related count. It sat on the hamburger, next to the bell's red
 *     unread badge — but sessions are not notifications, and the drawer is not
 *     where you go to look at one. Green vs red on ONE control was also the
 *     thing that made it "two different reasons to open me"; the two reasons
 *     are two controls now.
 *   - `#improve-version-dot` (top-left) is the platform version cue: amber
 *     while a deploy is in flight, violet once the platform has rolled past
 *     the SHA this tab loaded against. It was `#header-menu-deploy-dot` on the
 *     hamburger, from when the version rows lived in that drawer's footer.
 *     They live in THIS panel's footer now, so the dot followed them.
 *   - `#feedback-queue-dot` (bottom-left, amber) came with the retired
 *     feedback button, kept its id and its writer, and belongs here because
 *     this button is the only way to reach the feedback dialog — an unsent
 *     draft with no visible cue is the failure it exists to prevent. It moved
 *     off the top-right corner when the green count arrived there.
 *
 * Three corners on one 28px pill is a lot, and it is bounded by how rarely
 * they coincide: the queue dot only appears offline, the version dot only
 * during a deploy or after a roll, the count only with unread session news.
 *
 * All four render from ./improve-store.js. None may be written by id from a
 * classic module: this button is React-owned end to end, and a pre-hydration
 * `classList` write is a mismatch React patches straight back out.
 */

import { useRef } from 'react';

import { LightBulbIcon, SpinnerArcIcon } from '@/components/ui/icons';

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
const IMPROVE_BTN_CLASS =
  'relative inline-flex items-center gap-1.5 h-7 px-2.5 mr-2.5 rounded-lg '
  + 'bg-violet-600 hover:bg-violet-500 text-white text-xs font-medium '
  + 'transition-colors un-touch-target';

/** Amber while a deploy runs, violet once the platform has rolled past us. */
const VERSION_DOT: Record<string, string> = {
  deploying: 'bg-amber-500',
  stale: 'bg-violet-400',
};

export function ImproveButton() {
  const {
    target, open, working, sessionUnread, sessionDone, versionState,
  } = useStoreState(improveStore);
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
  // hook `App.DrawerStatus.setAppOpen()` used to call for the App/Dev switch,
  // so the title does not visibly jump.
  useIsomorphicLayoutEffect(() => {
    (window as unknown as { HeaderLayout?: { refresh?: () => void } })
      .HeaderLayout?.refresh?.();
  }, [target]);

  return (
    <button
      id="improve-btn"
      type="button"
      className={target ? IMPROVE_BTN_CLASS : `hidden ${IMPROVE_BTN_CLASS}`}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={open ? 'true' : 'false'}
      onClick={() => Improve.toggle()}
    >
      {working
        ? <SpinnerArcIcon className="w-4 h-4 animate-spin" aria-hidden="true" />
        : <LightBulbIcon className="w-4 h-4" aria-hidden="true" />}
      Improve
      {/* Bottom-LEFT since the green count took the top-right corner. */}
      <span
        ref={dotRef}
        id="feedback-queue-dot"
        className="hidden absolute -bottom-0.5 -left-0.5 w-2 h-2 rounded-full bg-amber-400"
      />
      {/* PRESENT-BUT-HIDDEN at rest, not absent, and both of these are the
          same decision. The prerender has to emit the shape the document
          always carried — an island whose first render differs from the
          prerendered markup is a hydration mismatch, and a console error on
          any route fails proposal checks — and two declared checks resolve
          these ids on a route where neither is lit. `hidden` is how every
          other indicator in the header says "nothing to report". */}
      <span
        id="improve-version-dot"
        className={VERSION_DOT[versionState]
          ? `absolute -top-0.5 -left-0.5 w-2 h-2 rounded-full ${VERSION_DOT[versionState]}`
          : 'hidden absolute -top-0.5 -left-0.5 w-2 h-2 rounded-full bg-amber-500'}
        aria-hidden="true"
      />
      {/* The green session count. `data-session-done` rides along on the same
          node it always did — a declared check selects on it to prove the
          badge is up for a real reason rather than merely present. Same
          corner, size and pill geometry as the hamburger's red unread badge,
          so the two still read as one badge convention across two controls. */}
      <span
        id="notifications-badge-ai"
        data-session-done={String(sessionDone)}
        className={sessionUnread > 0
          ? 'absolute -top-1 -right-1 min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-emerald-500 text-white text-[0.65rem] font-bold flex items-center justify-center'
          : 'hidden absolute -top-1 -right-1 min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-emerald-500 text-white text-[0.65rem] font-bold flex items-center justify-center'}
      >
        {sessionUnread > 0 ? (sessionUnread > 99 ? '99+' : String(sessionUnread)) : ''}
      </span>
    </button>
  );
}
