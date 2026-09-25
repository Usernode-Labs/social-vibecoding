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
 *   * `advanceOn: 'menu-open'` is a step that ends when the menu opens, which
 *     the overlay learns by subscribing to appContextStore. The press is
 *     never intercepted; the tour only watches. Its Next does not skip the
 *     step: it opens the menu through the controller's own `open()`, the
 *     same thing the mark does, and the watcher advances the tour from
 *     there — so a viewer who reads "press it" as "press Next" still lands
 *     on step 4 with the menu up.
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
  /** The step ends when the menu opens; its Next opens the menu. */
  advanceOn?: 'menu-open';
  /** The target is inside the Improve panel, so the panel has to be open. */
  needsPanel?: boolean;
  /** Shut the Improve panel and the app's menu on the way in. */
  closesPanel?: boolean;
  /**
   * Next and Back step over it when none of its targets is on screen. For
   * the Getting started card, which only an account that came through the
   * join screen has: a replay from Settings, a year later, has no card to
   * point at, and a step describing one that is not there is worse than no
   * step.
   */
  optional?: boolean;
}

/*
 * ── Communities, stage 5: the tour a new account gets after joining ─────
 *
 * It runs after "What communities do you want to join?"
 * (../../auth/communities-first-run.js), so it can talk about the Home that
 * screen just filled: the shortcuts to what they joined, the menu inside
 * every app, where their communities are listed, where to find more, and
 * the three first steps on top of Home. Create is no longer a step of its
 * own (the Your apps step names the tile that ends the grid), and neither
 * are Challenges, whose onboarding the Getting started card now does.
 */
export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to Homeroom',
    body: 'Every community here builds its own app. Changes ship when the community votes them in.',
    targets: [],
  },
  {
    // The launcher grid, which the join screen has just put the person's
    // communities on. `#home-apps-section` is the fallback for a tour that
    // starts before the grid has painted.
    id: 'apps',
    title: 'Your apps',
    body: 'Shortcuts to the apps you use. A small mark says where each one lives: people for a group, a lock for one that is just yours. The last tile starts a new project.',
    targets: ['#app-list', '#home-apps-section'],
  },
  {
    // ONE STEP, WHERE THERE WERE TWO (#2718 review). The arc was "press the
    // Improve row, the panel opens, here are its rows" and separately "the
    // mark opens the app's menu". The panel is retired and its two actions
    // are rows of that menu, so both steps were teaching the same press.
    //
    // The step still ends on the menu opening, whoever opens it: the
    // viewer's press on the mark, or Next, which opens the menu the same
    // way rather than skipping past it — step 4 points INSIDE the menu, so
    // a Next that only moved the counter would land on nothing.
    id: 'app-menu',
    title: 'The Homeroom menu',
    body: 'Inside any app, this mark opens its menu. Tap it, or tap Next to open it.',
    targets: ['#platform-mark-btn'],
    interactive: true,
    advanceOn: 'menu-open',
  },
  {
    // Give feedback and New change, as ONE step now: they sit side by side
    // in the menu's action well (`#improve-quick-actions`,
    // ../../improve/actions.tsx), so one cut-out draws around both and one
    // sentence says what each is for.
    id: 'menu-actions',
    title: 'Give feedback, or change it',
    body: 'Feedback sends the community a note about what should change. New change starts one yourself: describe it, try the preview, then put it to a vote.',
    targets: ['#improve-quick-actions', '#improve-row-feedback'],
    needsPanel: true,
  },
  {
    // THE STEP THAT LEAVES THE MENU: the step before it points inside the
    // menu, and the tab this one points at is behind it.
    id: 'workshop',
    title: 'Your communities',
    body: 'Workshop lists every community and group you are in, and your own projects, with what needs you in each.',
    targets: ['#platform-tab-workshop'],
    closesPanel: true,
  },
  {
    // The tab, where the directory is. Home's Discover section is the
    // fallback. Keeps `closesPanel` for the arc that never opened the menu.
    id: 'discover',
    title: 'Discover',
    body: 'Find more communities to join. Joining one puts it on Home.',
    targets: ['#platform-tab-discover', '#home-discover-section'],
    closesPanel: true,
  },
  {
    id: 'getting-started',
    title: 'Getting started',
    body: 'Three first steps to take part. They tick off as you go, and you can close the card when you are done.',
    targets: ['#home-getting-started'],
    optional: true,
  },
  {
    // `#app-switcher-btn` until #2718, which retired the chip. Settings is a
    // row of the Profile screen the Me tab lands on, so the tab is where this
    // step points — the control that gets you there, rather than the sheet
    // that used to list it. The copy said "under Me" until #2760 named that
    // tab after the signed-in user, so it names the place instead of a label
    // the tab no longer shows.
    id: 'settings',
    title: 'Replay this any time',
    body: 'You can replay this tour any time from Settings, on your profile.',
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
 * The step Next (`dir` 1) or Back (`dir` -1) lands on from `at`: the
 * neighbour, stepping over an `optional` step whose target `present` says is
 * not on screen. With nowhere to go, it stays where it is.
 */
export function stepFrom(at: number, dir: 1 | -1, present: (step: TourStep) => boolean): number {
  for (let i = clampIndex(at) + dir; i >= 0 && i < TOUR_LENGTH; i += dir) {
    if (!TOUR_STEPS[i].optional || present(TOUR_STEPS[i])) return i;
  }
  return clampIndex(at);
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

/** True on the step whose Next opens the menu instead of moving the counter. */
export function nextOpensMenu(index: number): boolean {
  return stepAt(index).advanceOn === 'menu-open';
}

/** The counter the card prints, e.g. "3 of 8". */
export function stepCounter(index: number): string {
  return `${clampIndex(index) + 1} of ${TOUR_LENGTH}`;
}
