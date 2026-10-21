/**
 * The timing half of a press on the tab bar (#3259), apart from the DOM and
 * from ./tab-bar.tsx so it can be driven with fake frames and timers, and so
 * the bar keeps no timer of its own (the rail peek's grace timer is
 * ./rail-peek.ts's, and tests/desktop-chrome-transitions.test.js holds the
 * bar to that).
 */

/**
 * How long a press waits for the router to light the tab it slid to before
 * the bar goes back to the router's tab. Every tab's route swaps in the
 * press, except resuming an app's Workshop, which holds the reveal for up to
 * App._TAB_REVEAL_WAIT_MS (250ms) while the app's record lands; this is
 * comfortably past that. A Communities press is the route that can go
 * unanswered, when neither the remembered view nor the phone's list reveals
 * a screen; `schedulePress`'s fallback then opens the All communities page
 * and the press waits one more PRESS_SETTLE_MS for it.
 */
export const PRESS_SETTLE_MS = 1500;

/** The press waiting for its route: the tab it slid to, and how to call it off. */
export interface PendingPress {
  key: string;
  cancel: () => void;
}

/**
 * The timing half of a press, apart from the DOM so it can be driven with
 * fake frames and timers. Records the press in `holder` (replacing, and
 * calling off, any press still waiting), runs `go` as soon as the frame that
 * lights the pressed tab has been produced, and, if nothing has answered the
 * press by PRESS_SETTLE_MS after that, clears it and calls `settle`. Whoever
 * sees the router answer (useTabMarker's tab-change run) answers it by
 * cancelling and clearing it.
 *
 * A LAST RESORT FOR COMMUNITIES (#5730). Some presses can be answered by
 * nothing: a Communities press from Me or Discover resumes the remembered
 * view (or opens the phone's drawer list), and either road can end without
 * revealing a screen. The bar had already slid the pill to Communities and
 * would then put it back, which reads as the press being refused. So a
 * caller may hand in `fallback`: when the settle timer fires and the press
 * is still unanswered, the fallback runs once and the timer is re-armed for
 * the same PRESS_SETTLE_MS. Whatever the fallback opens answers the press
 * through the tab-change run, so the pill never moves back; if it reveals
 * nothing either, `settle` still runs after the second wait.
 *
 * ONE FRAME, THEN THE SCREEN (polish board #2, 19 Oct 2026). #3259 made the
 * press wait for the pill's slide to be RUNNING (its `Animation.ready`,
 * capped at 120ms) and a frame more, so the slide was on the compositor
 * before the swap's long frames began. Recorded in the iPhone app, that wait
 * was the lag people saw: the tab lit at once and the old screen stayed up
 * for 120 to 205ms, longer than the slide it protected was worth. Now the
 * press waits only for its own frame (the lit tab, the pill's first pose) to
 * be painted, and the swap runs in the task after it. What #3259 saw came
 * from a navigation run INSIDE a frame, after the slide's start time was
 * fixed and before it was composited; run between frames, the swap comes
 * before WebKit starts the slide, so the slide starts after it, from its
 * beginning: a little late, never from its middle, and never holding the
 * screen.
 */
export function schedulePress(
  holder: { current: PendingPress | null },
  key: string,
  go: () => void,
  settle: () => void,
  raf: ((cb: () => void) => number) | undefined
    = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : undefined,
  caf: ((id: number) => void) | undefined
    = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : undefined,
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (id: unknown) => void }
    = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) },
  fallback?: () => void,
): PendingPress {
  holder.current?.cancel();
  let cancelFrame = () => {};
  let wait: unknown = null;
  let timer: unknown = null;
  let went = false;
  let fellBack = false;
  const entry: PendingPress = {
    key,
    cancel: () => {
      went = true;
      cancelFrame();
      if (wait !== null) timers.clear(wait);
      if (timer !== null) timers.clear(timer);
      wait = null;
      timer = null;
    },
  };
  holder.current = entry;
  // Nothing has answered the press by the time this fires: the fallback gets
  // its one turn, then the bar goes back if even that did not light the tab.
  // A fallback that navigates has not lit it yet (the router answers on its
  // next render), which is why the wait is re-armed rather than settling.
  const unanswered = () => {
    timer = null;
    if (holder.current !== entry) return;
    if (fallback && !fellBack) {
      fellBack = true;
      fallback();
      if (holder.current !== entry) return;
      timer = timers.set(unanswered, PRESS_SETTLE_MS);
      return;
    }
    holder.current = null;
    settle();
  };
  const navigate = () => {
    if (went || holder.current !== entry) return;
    went = true;
    if (wait !== null) timers.clear(wait);
    wait = null;
    go();
    // The router lit `key` inside go(), or will from its popstate, and the
    // tab-change run answered the press; this only acts if nothing ever does.
    if (holder.current !== entry) return;
    timer = timers.set(unanswered, PRESS_SETTLE_MS);
  };
  // The press's frame (the lit tab) is produced in the rAF's rendering
  // update; a task posted from it runs once that frame is out.
  const afterPaint = () => {
    if (went || holder.current !== entry) return;
    cancelFrame = () => {};
    wait = timers.set(() => { wait = null; navigate(); }, 0);
  };
  if (!raf) navigate();
  else {
    const id = raf(afterPaint);
    cancelFrame = () => { if (caf) caf(id); };
  }
  return entry;
}
