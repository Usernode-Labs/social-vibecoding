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
 * comfortably past that. Nothing on the phone refuses a tab today, so this
 * is a floor under a future route that might, not a path anything takes.
 */
export const PRESS_SETTLE_MS = 1500;

/** The press waiting for its route: the tab it slid to, and how to call it off. */
export interface PendingPress {
  key: string;
  cancel: () => void;
}

/** How long a press waits for its slide to be running before it navigates anyway. */
export const SLIDE_START_WAIT_MS = 120;

/**
 * The timing half of a press, apart from the DOM so it can be driven with
 * fake frames and timers. Records the press in `holder` (replacing, and
 * calling off, any press still waiting), runs `go` once the slide is RUNNING
 * and a frame has been produced after that, and, if nothing has answered the
 * press by PRESS_SETTLE_MS after that, clears it and calls `settle`. Whoever
 * sees the router answer (useTabMarker's tab-change run) answers it by
 * cancelling and clearing it.
 *
 * WHY IT WAITS FOR THE SLIDE, NOT FOR A FRAME COUNT (#3259). Measured in the
 * app in the iOS simulator: the slide is written in the press's task, but
 * WebKit had not started it until the SECOND frame after, the very frame
 * two rAFs out, where the navigation then began the screen swap. The slide's
 * first composited frame sat behind the swap's long frame and showed 50 to
 * 95% of the way across. `started` answers the slide's `ready`: the
 * moment its start time is fixed, which is when the compositor has it. The
 * swap goes a frame after that, capped at SLIDE_START_WAIT_MS so a slide that
 * never starts cannot hold the navigation up.
 */
export function schedulePress(
  holder: { current: PendingPress | null },
  key: string,
  go: () => void,
  settle: () => void,
  started: () => PromiseLike<unknown> | null | undefined = () => null,
  raf: ((cb: () => void) => number) | undefined
    = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : undefined,
  caf: ((id: number) => void) | undefined
    = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : undefined,
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (id: unknown) => void }
    = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) },
): PendingPress {
  holder.current?.cancel();
  let cancelFrame = () => {};
  let wait: unknown = null;
  let timer: unknown = null;
  let went = false;
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
  const navigate = () => {
    if (went || holder.current !== entry) return;
    went = true;
    if (wait !== null) timers.clear(wait);
    wait = null;
    go();
    // The router lit `key` inside go(), or will from its popstate, and the
    // tab-change run answered the press; this only acts if nothing ever does.
    if (holder.current !== entry) return;
    timer = timers.set(() => {
      timer = null;
      if (holder.current !== entry) return;
      holder.current = null;
      settle();
    }, PRESS_SETTLE_MS);
  };
  // A frame after the slide is running (or after the cap).
  const soon = () => {
    if (went || holder.current !== entry) return;
    cancelFrame();
    if (!raf) { navigate(); return; }
    const id = raf(navigate);
    cancelFrame = () => { if (caf) caf(id); };
  };
  // The first frame, so the press's own commit (where the slide is made)
  // has happened before anyone asks whether it has started.
  const first = () => {
    const ready = started();
    if (!ready) { soon(); return; }
    wait = timers.set(() => { wait = null; soon(); }, SLIDE_START_WAIT_MS);
    ready.then(soon, soon);
  };
  if (!raf) first();
  else {
    const id = raf(first);
    cancelFrame = () => { if (caf) caf(id); };
  }
  return entry;
}
