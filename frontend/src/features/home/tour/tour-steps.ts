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
 * Nothing here is a drawing of the product. The four Improve steps used to be the
 * hard case, because Improve, Feedback, New change and Workshop all read as
 * things that live inside an app while the tour stays on Home. They are not:
 * `#improve-btn` is in the platform header on Home, where the target is the
 * platform's own self-hosted row (`Home.publishImproveTarget`, #1367), and
 * pressing it opens the real panel with the real rows in it. So the tour
 * spotlights the button, waits for the viewer to press it themselves, and
 * then walks the rows of the panel they just opened.
 *
 * That is what `interactive` and `advanceOn` are for:
 *
 *   * `interactive` lets the cut-out pass clicks through to the control it is
 *     drawn around, while the dimmed area keeps blocking them. Exactly ONE
 *     step has it: the Improve step, which the viewer completes by pressing
 *     the real button. The three rows INSIDE the panel are described, not
 *     driven — see "The panel rows are shown, not pressed" below.
 *   * `advanceOn: 'improve-open'` is a step with NO Next. It ends when the
 *     panel opens, which the overlay learns by subscribing to improveStore.
 *     The click is never intercepted; the tour only watches.
 *   * `needsPanel` marks the three steps whose target is inside the panel.
 *     If it is not open, they cannot be shown, and ./index.tsx falls back to
 *     the Improve step rather than spotlighting nothing.
 *   * `closesPanel` is how the arc ends: step 7 shuts the panel through the
 *     controller's own `Improve.close()` before pointing at Challenges.
 *     Never by writing to the panel's DOM, which is React-owned.
 *
 * ── The panel rows are shown, not pressed ─────────────────────────
 *
 * Feedback, New change and Workshop spent a round `interactive`, on the
 * argument that pressing a row is a thing a viewer may do while the tour is
 * pointing at it. In use it is the other way round: every one of those three
 * LEAVES the tour. Feedback presents a kit dialog, New change starts a
 * session, and Workshop navigates off Home — so a viewer four steps into an
 * eight step tour, following a spotlight that reads as an instruction, lands
 * somewhere else with the tour paused behind them. ./index.tsx's pause and
 * fallback rules recover from that, which is not the same as it being a good
 * thing to invite.
 *
 * The keyboard already said as much. The focus move and the Tab handler in
 * ./index.tsx both open up only for a step with `advanceOn`, so these three
 * rows have never been reachable from a keyboard while their step was up; the
 * cut-out passing a POINTER through was the odd one out. Both halves agree
 * now: the spotlight describes the row, Next moves on, and the row is
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
  advanceOn?: 'improve-open';
  /** The target is inside the Improve panel, so the panel has to be open. */
  needsPanel?: boolean;
  /** Shut the Improve panel on the way in, through the controller. */
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
    id: 'improve',
    title: 'Improve',
    body: 'Inside any app, Improve is where you change it. Press Improve to open it.',
    targets: ['#improve-btn'],
    interactive: true,
    advanceOn: 'improve-open',
  },
  {
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
    id: 'workshop',
    title: 'Workshop',
    body: 'Workshop shows everything in progress on the app and what needs you.',
    targets: ['#app-context-row-workshop'],
    needsPanel: true,
  },
  {
    id: 'challenges',
    title: 'Challenges',
    body: 'Complete challenges to finish onboarding and earn your first points.',
    targets: ['#home-challenges-section'],
    closesPanel: true,
  },
  {
    id: 'settings',
    title: 'Replay this any time',
    body: 'You can replay this tour any time from Settings.',
    targets: ['#app-switcher-btn'],
  },
];

export const TOUR_LENGTH = TOUR_STEPS.length;

/**
 * The step the Improve arc falls back to.
 *
 * It is THE step on Home in that arc: the one whose target is the header
 * button rather than a row of a panel that may no longer be open. A viewer
 * who closes the panel, or who comes back from a feedback draft or a new
 * change, lands here and is asked to press Improve again.
 */
export const IMPROVE_STEP_INDEX = TOUR_STEPS.findIndex(
  (step) => step.advanceOn === 'improve-open',
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
