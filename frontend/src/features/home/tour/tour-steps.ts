/**
 * The eight steps of the welcome tour, as data.
 *
 * Kept as a plain table with no React in it so the order, the wording, the
 * anchoring and the interaction rules can be asserted without rendering
 * anything (tests/home-tour.test.js). The overlay in ./index.tsx is the only
 * reader.
 *
 * ── Every step points at a REAL control ────────────────────────────────
 *
 * Nothing here is a drawing of the product. The Improve steps used to be the
 * hard case, because Improve, Feedback, New change and Workshop all read as
 * things that live inside an app while the tour stays on Home. They are not:
 * on Home the target is the platform's own self-hosted row
 * (`Home.publishImproveTarget`, #1367), so the real controls are there to be
 * pressed and the tour spotlights them where they are.
 *
 * ── #2718 put a menu in front of that arc, then folded it in ───────────
 *
 * The step pointed at `#improve-btn`, a header pill that is retired. It became
 * a ROW of the app's own menu, opening a panel that held two buttons, a list
 * of sessions and a build notice. Its review retired that panel too: the
 * Workshop had taken the sessions, which left a drawer you opened in order to
 * press one of two buttons. Both buttons and the notice are in the menu now
 * (../../app-context/app-context-sheet.tsx), so the step that taught "press
 * Improve, a panel opens" and the step that taught "the mark opens the menu"
 * were teaching one press. They are one step.
 *
 * That is what `interactive`, `advanceOn` and the two flags below are for:
 *
 *   * `interactive` lets the cut-out pass clicks through to the control it is
 *     drawn around, while the dimmed area keeps blocking them. Exactly ONE
 *     step has it: the menu step, which the viewer completes by pressing the
 *     real mark. Everything else is described, not driven — see "shown, not
 *     pressed" below.
 *   * `advanceOn: 'menu-open'` is a step with NO Next. It ends when the menu
 *     opens, which the overlay learns by subscribing to appContextStore. The
 *     press is never intercepted; the tour only watches.
 *   * `needsPanel` marks the steps whose target is inside that menu: Give
 *     feedback and New change. If it is not open they cannot be shown, and
 *     ./index.tsx falls back to the menu step rather than spotlighting
 *     nothing. The name is the one every reader of this file already knows;
 *     what it names is the surface, and the surface moved.
 *   * `closesPanel` shuts the menu through the controller's own
 *     `Improve.close()` — which forwards to AppContext now — before pointing
 *     at something the menu would cover. Never by writing to either subtree,
 *     both of which are React-owned.
 *
 * ── Everything but the menu press is shown, not pressed ────────────────
 *
 * Feedback, New change and Workshop spent a round `interactive`, on the
 * argument that pressing a control is a thing a viewer may do while the tour
 * is pointing at it. In use it is the other way round: every one of them
 * LEAVES the tour. Feedback presents a kit dialog, New change starts a
 * session, and Workshop navigates off Home — so a viewer four steps into an
 * eight step tour, following a spotlight that reads as an instruction, lands
 * somewhere else with the tour paused behind them. ./index.tsx's pause and
 * fallback rules recover from that, which is not the same as it being a good
 * thing to invite.
 *
 * The keyboard already said as much. The focus move and the Tab handler in
 * ./index.tsx both open up only for a step with `advanceOn`, so no target but
 * the menu's has ever been reachable from a keyboard while its step was up;
 * the cut-out passing a POINTER through was the odd one out. Both halves
 * agree now: the spotlight describes the control, Next moves on, and it is
 * pressable again the moment the tour is done with it.
 *
 * ── `targets`: a LIST, first visible one wins ──────────────────────────
 *
 * A step points at an element that may or may not be on screen, so each one
 * names candidates in preference order and ./spotlight.ts takes the first
 * that is in the document, unhidden and has a box. A step whose list resolves
 * to nothing still runs: the screen dims whole and the card centres, which is
 * what step 1 wants anyway.
 */

export interface TourStep {
  /** Stable id, used for keys and for the tests that pin the order. */
  id: string;
  /** The card's heading. */
  title: string;
  /** The card's body copy. One short paragraph, plain language. */
  body: string;
  /** Candidate selectors for the spotlight, in preference order. */
  targets: readonly string[];
  /** The cut-out passes clicks through to the control it is drawn around. */
  interactive?: boolean;
  /** No Next: the step ends when the Improve panel opens. */
  advanceOn?: 'menu-open';
  /** The target is inside the Improve panel, so the panel has to be open. */
  needsPanel?: boolean;
  /** Shut the Improve panel and the app's menu on the way in. */
  closesPanel?: boolean;
}

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to Homeroom',
    body: 'Every app here is built by the people using it, and changes ship when the group votes them in.',
    targets: [],
  },
  {
    id: 'create',
    title: 'Create a new app',
    body: 'Create a new app here. Describe it and an AI builds the first version.',
    targets: ['#home-create-section'],
  },
  {
    // ONE STEP, WHERE THERE WERE TWO (#2718 review). The arc was "press the
    // Improve row, the panel opens, here are its rows" and separately "the
    // mark opens the app's menu". The panel is retired and its two actions
    // are rows of that menu, so both steps were teaching the same press.
    //
    // It still does not press it: the whole shape of this arc is that the
    // viewer performs each step themselves and the tour watches, so
    // `advanceOn: 'menu-open'` waits for the menu and there is no Next to
    // skip it with.
    id: 'app-menu',
    title: "The app's own menu",
    body: 'The mark opens the menu for the app you are in. Press it.',
    targets: ['#platform-mark-btn'],
    interactive: true,
    advanceOn: 'menu-open',
  },
  {
    // BACK FROM THE MERGE, and correct again. #2718 deleted this step because
    // it moved "Give feedback" out of the panel and into the mark's menu;
    // its review moved the control back to a button in this very well, so
    // the step it deleted is the step the product wants. Taking main's copy
    // verbatim rather than rewriting it: nothing about what it teaches
    // changed while it was away.
    id: 'feedback',
    title: 'Give feedback',
    body: "Feedback sends the app's group a note about what should change.",
    targets: ['#improve-row-feedback'],
    needsPanel: true,
  },
  {
    id: 'new-change',
    title: 'New change',
    body: 'New change starts a working session on the app: describe it, try the preview, then put it to a vote.',
    targets: ['#improve-row-new-session'],
    needsPanel: true,
  },
  {
    // `#app-context-row-workshop` until #2718, which is an id nothing has
    // rendered for some time — the step fell through to no target and drew
    // its card with no cut-out. Workshop is a TAB now, and the tab is on
    // screen on every platform route, so the target resolves everywhere.
    id: 'workshop',
    title: 'Workshop',
    body: 'Workshop shows what is in progress across your apps, and what needs you.',
    targets: ['#platform-tab-workshop'],
    // THE STEP THAT LEAVES THE MENU, and it is this one now rather than
    // Challenges: the two steps before it point at rows INSIDE the menu, and
    // the tab this one points at is behind it. Challenges keeps the flag too,
    // for the arc that never opened the menu at all.
    closesPanel: true,
  },
  {
    id: 'challenges',
    title: 'Challenges',
    body: 'Complete challenges to finish onboarding and earn your first points.',
    targets: ['#home-challenges-section'],
    closesPanel: true,
  },
  {
    // `#app-switcher-btn` until #2718, which retired the chip. Settings is a
    // row of the Profile screen the Me tab lands on, so the tab is where this
    // step points — the control that gets you there, rather than the sheet
    // that used to list it.
    id: 'settings',
    title: 'Replay this any time',
    body: 'You can replay this tour any time from Settings, under Me.',
    targets: ['#platform-tab-me'],
  },
];

export const TOUR_LENGTH = TOUR_STEPS.length;

/**
 * The step the menu arc falls back to.
 *
 * It is THE step on Home in that arc: the one whose target is on screen
 * whatever else is or is not open. A viewer who closes the menu, or who comes
 * back from a feedback draft or a new change, lands here and is asked to
 * press the mark again.
 *
 * Derived rather than written down, so the table stays the one source of the
 * order: it is the step with `advanceOn`.
 */
export const IMPROVE_STEP_INDEX = TOUR_STEPS.findIndex(
  (step) => step.advanceOn === 'menu-open',
);

/** Clamp an index onto the table, so no caller can walk off either end. */
export function clampIndex(index: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(TOUR_LENGTH - 1, Math.trunc(index)));
}

/**
 * The step a tour in progress comes back at after the page reloads.
 *
 * Nothing saved, nothing to resume: the top. A panel step cannot resume as
 * itself, because a fresh document has no Improve panel open, so it lands on
 * the Improve step, which is the rule ./index.tsx already applies to a viewer
 * who shut the panel. Every other step resumes where it was.
 */
export function resumeIndex(saved: number | null): number {
  if (saved == null) return 0;
  const index = clampIndex(saved);
  return TOUR_STEPS[index].needsPanel ? IMPROVE_STEP_INDEX : index;
}

export function stepAt(index: number): TourStep {
  return TOUR_STEPS[clampIndex(index)];
}

export function isLastStep(index: number): boolean {
  return clampIndex(index) === TOUR_LENGTH - 1;
}

/** False on a step the viewer advances by acting rather than by pressing Next. */
export function hasNext(index: number): boolean {
  return stepAt(index).advanceOn === undefined;
}

/** The counter the card prints, e.g. "3 of 8". */
export function stepCounter(index: number): string {
  return `${clampIndex(index) + 1} of ${TOUR_LENGTH}`;
}
