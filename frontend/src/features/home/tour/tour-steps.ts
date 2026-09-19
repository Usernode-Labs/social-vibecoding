/**
 * The eight steps of the welcome tour, as data.
 *
 * Kept as a plain table with no React in it so the order, the wording and the
 * anchoring can be asserted without rendering anything
 * (tests/home-tour.test.js). The overlay in ./index.tsx is the only reader.
 *
 * ── `targets`: a LIST, first visible one wins ──────────────────────────
 *
 * A step points at an element that may or may not be on screen, so each one
 * names candidates in preference order and ./spotlight.ts takes the first
 * that is in the document, unhidden and has a box. A step whose list resolves
 * to nothing still runs: the screen dims whole and the card centres, which is
 * what step 1 wants anyway.
 *
 * ── Why steps 3 to 6 are not on Home ───────────────────────────────────
 *
 * Improve, Feedback, New change and Workshop all live INSIDE an app, and the
 * tour must not navigate the viewer away from Home to show them. Two things
 * cover that:
 *
 *   * `#improve-btn` IS on Home. It is shown whenever ../improve's store
 *     carries a target, and `Home.publishImproveTarget()` publishes the
 *     platform's own row for as long as Home is on screen (#1367) -- so on a
 *     normal home visit there is a real Improve control in the header to
 *     point at, and the copy says so. It ships `hidden` until that publish
 *     lands, which is why the fallbacks below exist rather than being
 *     theoretical: a cold paint, or a viewer whose store has no target, gets
 *     the apps grid (or the Discover lane when Your apps is empty).
 *   * `mock` draws a small still life of the Improve panel inside the card
 *     with the named control picked out, so the three things behind the
 *     button are shown rather than only described.
 */

export type TourMock = 'improve' | 'feedback' | 'new-change' | 'workshop';

export interface TourStep {
  /** Stable id, used for keys and for the tests that pin the order. */
  id: string;
  /** The card's heading. */
  title: string;
  /** The card's body copy. One short paragraph, plain language. */
  body: string;
  /** Candidate selectors for the spotlight, in preference order. */
  targets: readonly string[];
  /** Which control of the inline Improve still life to pick out, if any. */
  mock?: TourMock;
}

/**
 * The Improve control and the apps grid, in the order ./spotlight.ts should
 * try them. `#home-apps-section` is the viewer's own grid; `#home-discover-section`
 * is the lane that takes its place when Your apps is empty, and the grid
 * section is still in the document then, so the Discover fallback is reached
 * through ./spotlight.ts's emptiness check rather than by absence.
 */
const IMPROVE_TARGETS = ['#improve-btn', '#home-apps-section', '#home-discover-section'] as const;

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
    body: 'Inside any app, Improve is where you change it.',
    targets: IMPROVE_TARGETS,
    mock: 'improve',
  },
  {
    id: 'feedback',
    title: 'Feedback',
    body: "Feedback sends the app's group a note about what should change.",
    targets: IMPROVE_TARGETS,
    mock: 'feedback',
  },
  {
    id: 'new-change',
    title: 'New change',
    body: 'New change starts a working session on the app: describe it, try the preview, then put it to a vote.',
    targets: IMPROVE_TARGETS,
    mock: 'new-change',
  },
  {
    id: 'workshop',
    title: 'Workshop',
    body: 'Workshop shows everything in progress on the app and what needs you.',
    targets: IMPROVE_TARGETS,
    mock: 'workshop',
  },
  {
    id: 'challenges',
    title: 'Challenges',
    body: 'Complete challenges to finish onboarding and earn your first points.',
    targets: ['#home-challenges-section'],
  },
  {
    id: 'settings',
    title: 'Replay this any time',
    body: 'You can replay this tour any time from Settings.',
    targets: ['#app-switcher-btn'],
  },
];

export const TOUR_LENGTH = TOUR_STEPS.length;

/** Clamp an index onto the table, so no caller can walk off either end. */
export function clampIndex(index: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(TOUR_LENGTH - 1, Math.trunc(index)));
}

export function stepAt(index: number): TourStep {
  return TOUR_STEPS[clampIndex(index)];
}

export function isLastStep(index: number): boolean {
  return clampIndex(index) === TOUR_LENGTH - 1;
}

/** The counter the card prints, e.g. "3 of 8". */
export function stepCounter(index: number): string {
  return `${clampIndex(index) + 1} of ${TOUR_LENGTH}`;
}
