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
 * The dot's visibility rides the visibility store; nothing here may be
 * written by id from a classic module: this button is React-owned end to
 * end, and a pre-hydration `classList` write is a mismatch React patches
 * straight back out.
 */

import { useRef } from 'react';

import { EyeIcon } from '@/components/ui/icons';

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
  'relative inline-flex items-center h-7 px-3 mr-2.5 rounded-lg '
  + 'bg-violet-600 hover:bg-violet-500 text-white text-xs font-medium '
  + 'transition-colors un-touch-target';

export function ImproveButton() {
  const { target, open, tab } = useStoreState(improveStore);
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
    // `tab` is a dependency because the pill ↔ eye swap below changes the
    // right group's width just as materially as the pill appearing does.
  }, [target, tab]);

  // Streamlined Concept: the Improve pill belongs to the app's DEFAULT (use)
  // state only. On the Dev screens — Activity, Board, a session — the slot
  // renders the EYE instead: "view and use the app", the way back that every
  // Figma dev screen carries top-right. Client-only states both (the
  // prerender has no target), so the swap can be a real conditional render.
  const eye = !!target && tab === 'dev';

  if (eye) {
    return (
      <button
        id="app-eye-btn"
        type="button"
        className={'w-7 h-7 mr-2.5 flex items-center justify-center un-touch-target '
          + 'text-zinc-400 hover:text-zinc-200'}
        aria-label="Use the app"
        title="View and use the app"
        onClick={() => Improve.openApp()}
      >
        <EyeIcon className="w-5 h-5" aria-hidden="true" />
      </button>
    );
  }

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
      Improve
      {/* Bottom-LEFT, where it landed when #1412's green count took the
          top-right corner; the count re-homed to the hamburger since, but
          moving this back would churn the geometry for nothing. */}
      <span
        ref={dotRef}
        id="feedback-queue-dot"
        className="hidden absolute -bottom-0.5 -left-0.5 w-2 h-2 rounded-full bg-amber-400"
      />
    </button>
  );
}
