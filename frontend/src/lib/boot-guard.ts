/**
 * The boot's floor: no single startup step may take the whole shell down.
 *
 * ── Why this exists ───────────────────────────────────────────────────
 *
 * ./island-boundary.tsx was written because "the whole tree is one throw away
 * from disappearing". It closed that hole INSIDE the tree. Above the root
 * there was nothing at all: `../main.tsx` runs registerServiceWorker(),
 * initOffline() and applyShellSnapshot() around
 * `flushSync(hydrateRoot(document.body, <Shell />))`, and a throw in any of
 * them aborts the entry module BEFORE hydration ever starts. React then never
 * adopts the document, `window.Offline` is never installed, every island
 * stays the empty markup the prerender shipped, and the screen the boot
 * reveals is blank.
 *
 * That is not hypothetical: it is exactly how the iOS native app's blank
 * screen worked (#1670). `registerServiceWorker()` guarded on
 * `'serviceWorker' in navigator` and then dereferenced
 * `navigator.serviceWorker`, which WebKit hands back as `undefined` wherever
 * the worker is unavailable to the page. One TypeError in a precache nicety,
 * and the entire application was gone.
 *
 * Fixing that one dereference fixed that one instance. This fixes the CLASS:
 * every pre-hydration step is now wrapped, so a throw costs its own step and
 * nothing else. A shell that boots with no service worker and no offline
 * engine is a shell missing two conveniences. A shell that does not boot is a
 * white screen with no way to report itself.
 *
 * ── Why it records instead of logging ─────────────────────────────────
 *
 * AGENTS.md: a `console.error` on any route fails the platform's proposal
 * checks, so a guard that logged would turn every degraded boot into a merge
 * blocker on every route — and the whole point here is to keep going. The
 * record lands in `window.__unBoot.errors`, which is the same store the head's
 * boot watchdog fills from its own `error` / `unhandledrejection` listeners,
 * so one list holds everything that went wrong on this load whether it came
 * from a classic script, this bundle, or a rejected promise. The watchdog
 * PRINTS that list when the boot produced nothing, which is where a reader
 * with no inspector attached finally gets to see it.
 *
 * `console.warn` is deliberate and allowed: it says the step failed without
 * failing a check, and it is what makes a degraded boot visible in a console
 * that IS attached.
 */

export interface BootError {
  /** The step that threw, as `bootStep` was called with. */
  step: string;
  message: string;
  stack?: string;
}

interface BootWatchState {
  errors: BootError[];
}

/**
 * The shared store, created by the head's watchdog script long before this
 * bundle evaluates. Created here too, because the SSG prerender runs this
 * module graph in Node and tests load it with no head at all.
 */
function store(): BootWatchState | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { __unBoot?: BootWatchState };
  if (!w.__unBoot) w.__unBoot = { errors: [] };
  if (!Array.isArray(w.__unBoot.errors)) w.__unBoot.errors = [];
  return w.__unBoot;
}

/** Every boot step that has failed on this load, oldest first. */
export function bootErrors(): BootError[] {
  return store()?.errors ?? [];
}

/**
 * Run one startup step. A throw is recorded and swallowed; the boot carries
 * on to the next step, and above all to hydration.
 *
 * Returns whether the step succeeded, for a caller that has a fallback.
 */
export function bootStep(step: string, fn: () => void): boolean {
  try {
    fn();
    return true;
  } catch (err) {
    const error = err as { message?: string; stack?: string } | null;
    const entry: BootError = {
      step,
      message: (error && error.message) || String(err),
      stack: (error && error.stack) || undefined,
    };
    try {
      store()?.errors.push(entry);
    } catch { /* no window, or a frozen store: the warn below still reports */ }
    // warn, never error — see the header.
    try {
      console.warn(`[boot] step "${step}" failed; continuing without it:`, err);
    } catch { /* a console that throws is not worth a second throw */ }
    return false;
  }
}

if (typeof window !== 'undefined') {
  const w = window as unknown as { UsernodeReact?: Record<string, unknown> };
  w.UsernodeReact = w.UsernodeReact || {};
  w.UsernodeReact.bootErrors = bootErrors;
}
