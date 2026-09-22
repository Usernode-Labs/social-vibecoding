/**
 * The nine steps of the welcome tour, as data.
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
 * the Improve row is in the mark's menu on Home too, where the target is the
 * platform's own self-hosted row (`Home.publishImproveTarget`, #1367), and
 * pressing it opens the real panel with the real rows in it. So the tour
 * spotlights the row, waits for the viewer to press it themselves, and
 * then walks the rows of the panel they just opened.
 *
 * ── #2718 put a menu in front of that arc ──────────────────────────────
 *
 * The step pointed at `#improve-btn`, a control in the header that was always
 * on screen. That button is retired: Improve is a row of the app's own menu
 * now, behind the Homeroom mark. A row inside a closed sheet has no box, so
 * ./spotlight.ts would find nothing and the step would dim the screen whole.
 *
 * The tour OPENS the sheet for it (`opensSheet`), the same way step 7 shuts
 * the panel — through the controller, never by writing to a React-owned
 * subtree. What it does NOT do is press the row: the arc's whole shape is
 * that the viewer performs each step themselves and the tour watches. So the
 * sheet is presented, the cut-out lands on the row inside it, and
 * `advanceOn: 'improve-open'` still waits for the panel.
 *
 * That is what `interactive`, `advanceOn` and the two surface flags are for:
 *
 *   * `interactive` lets the cut-out pass clicks through to the control it is
 *     drawn around, while the dimmed area keeps blocking them. Exactly ONE
 *     step has it: the Improve step, which the viewer completes by pressing
 *     the real button. The three rows INSIDE the panel are described, not
 *     driven — see "The panel rows are shown, not pressed" below.
 *   * `advanceOn: 'improve-open'` is a step with NO Next. It ends when the
 *     panel opens, which the overlay learns by subscribing to improveStore.
 *     The click is never intercepted; the tour only watches.
 *   * `needsPanel` marks the steps whose target is inside the panel: Give
 *     feedback and New change, two of the three there were, since #2718 made
 *     Workshop a tab. If the panel is not open they cannot be shown, and
 *     ./index.tsx falls back to the Improve step rather than spotlighting
 *     nothing.
 *   * `opensSheet` presents the app's menu on the way IN, because the step's
 *     target is a row of it. It fires once on arrival and never again, so the
 *     row's own handler — which dismisses the sheet before opening the panel
 *     — is not fought by a tour that keeps putting the sheet back.
 *   * `closesPanel` is how the arc leaves the panel, through the
 *     controller's own `Improve.close()`. TWO steps carry it since #2718: the
 *     menu step, which comes straight after the two panel rows, and
 *     Challenges after it. Both spotlight something the panel would cover —
 *     the mark is in the header, the Challenges section is behind the well —
 *     and it shuts the app's menu for the same reason. Never by writing to
 *     either subtree, both of which are React-owned.
 *
 * ── Everything but Improve is shown, not pressed ──────────────────────
 *
 * Feedback, New change and Workshop spent a round `interactive`, on the
 * argument that pressing a control is a thing a viewer may do while the tour
 * is pointing at it. In use it is the other way round: every one of them
 * LEAVES the tour. Feedback presents a kit dialog, New change starts a
 * session, and Workshop navigates off Home — so a viewer four steps into a
 * nine step tour, following a spotlight that reads as an instruction, lands
 * somewhere else with the tour paused behind them. ./index.tsx's pause and
 * fallback rules recover from that, which is not the same as it being a good
 * thing to invite.
 *
 * #2718's two new targets are the same case and arrived carrying the flag
 * anyway: the mark OPENS a menu over the card, and the Workshop tab is a tab
 * — it navigates. Neither was ever reachable from a keyboard mid-step, for
 * the reason below. They lost it with the rest.
 *
 * The keyboard already said as much. The focus move and the Tab handler in
 * ./index.tsx both open up only for a step with `advanceOn`, so no target but
 * Improve's has ever been reachable from a keyboard while its step was up; the
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
  /** Present the app's own menu on the way in, through the controller. */
  opensSheet?: boolean;
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
    // `#improve-btn` until #2718 retired the header pill. The row it became
    // is in the menu behind the mark, which this step opens for itself — see
    // `opensSheet` in the header above.
    id: 'improve',
    title: 'Improve',
    body: 'Inside any app, Improve is where you change it. Press Improve to open it.',
    targets: ['#app-menu-row-improve'],
    interactive: true,
    opensSheet: true,
    advanceOn: 'improve-open',
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
    // #2718 added this step, on the reading that the mark is the control on
    // screen on every route and the rows behind it are then self-evident.
    // That holds, and what it says had to change twice: it called itself
    // 'feedback' and led with "give feedback", both of which were true only
    // while that row lived in this menu. The review put feedback back in the
    // Improve panel — where the step above now points — so this one is about
    // the menu itself and is named for it.
    //
    // It CLOSES the panel on the way in, which the Challenges step used to do
    // one later: the mark is in the header, and a panel drawn over the header
    // would put the cut-out around something the viewer cannot see.
    id: 'app-menu',
    title: "The app's own menu",
    body: 'The mark opens the menu for the app you are in: its Workshop, its discussion, its developer terminal.',
    targets: ['#platform-mark-btn'],
    closesPanel: true,
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
 * The step the Improve arc falls back to.
 *
 * It is THE step on Home in that arc: the one that presents its own surface
 * rather than needing a panel somebody else left open. A viewer who closes
 * the panel, or who comes back from a feedback draft or a new change, lands
 * here, the app's menu opens again, and they are asked to press Improve.
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
