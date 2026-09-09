/**
 * What the top bar looked like last time, so the cold document does not have
 * to guess.
 *
 * ── The gap this closes ────────────────────────────────────────────────
 *
 * A refresh almost always paints from cache: public/sw.js races every
 * navigation against the cached `/index.html` on a 200ms deadline its own
 * header describes as deliberately shorter than a round trip. That cached
 * document is the PRERENDER, and the prerender is state-free — it is
 * `renderToStaticMarkup(<Shell/>)` in Node, so every island renders from its
 * store's INITIAL value and nothing on disk knows which app or route the
 * viewer was on.
 *
 * For the header that meant two visible lies on every reload:
 *
 *   - the chip said "dApps", which is headerTitleStore's INITIAL, and
 *   - the Improve button was missing, because improveStore's `target` starts
 *     null and the button ships `hidden` until something publishes one.
 *
 * Neither corrected until App.init() had run on DOMContentLoaded AND
 * /api/auth/me had answered AND the route had resolved — a network round trip
 * after a paint that came from cache in milliseconds.
 *
 * ── Why this is applied after hydration and not before ─────────────────
 *
 * The obvious fix — bake the last-known values into the store's INITIAL, or
 * write them from an inline <head> script before React sees the document — is
 * the one thing that must not happen. The prerendered markup and the first
 * client render have to agree byte for byte or React reports a hydration
 * mismatch, that mismatch is a console.error, and a console error on any route
 * fails the platform's proposal checks. So the snapshot is applied in a
 * layout effect AFTER hydration: the document still parses and hydrates
 * showing the prerender, and the correct bar is up in the same frame
 * hydration finishes, instead of one network round trip later.
 *
 * ── It is display-only ─────────────────────────────────────────────────
 *
 * Nothing here grants anything or is trusted for anything. It is the same
 * contract App.SESSION_SNAPSHOT_KEY states for the "this device was signed in"
 * record in public/js/app.js, and it is cleared on the same event: a sign-out
 * drops it, so the next cold paint is the neutral prerender rather than the
 * previous account's app name.
 */

const KEY = 'usernode.shell.v1';

/** A week. Long enough to cover normal use, short enough that a name people
 *  have not seen in months does not resurface as the first thing they read. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface ShellSnapshot {
  /** headerTitleStore's pair — the chip's label and its subtitle. */
  title: string;
  subtitle: string;
  /**
   * improveStore's `target`: 'platform', 'app', or '' for a screen with none.
   * This is the whole of what decides whether the Improve pill is drawn.
   */
  improveTarget: string;
  savedAt: number;
}

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function readShellSnapshot(): ShellSnapshot | null {
  if (!isBrowser()) return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || typeof s !== 'object') return null;
    if (typeof s.savedAt !== 'number' || Date.now() - s.savedAt > MAX_AGE_MS) return null;
    return {
      title: typeof s.title === 'string' ? s.title : '',
      subtitle: typeof s.subtitle === 'string' ? s.subtitle : '',
      improveTarget: typeof s.improveTarget === 'string' ? s.improveTarget : '',
      savedAt: s.savedAt,
    };
  } catch {
    // Private mode, cleared site data, a corrupt entry: the prerender is a
    // correct starting point, just a slower one. Nothing to report.
    return null;
  }
}

/**
 * Merge a patch into the stored snapshot.
 *
 * A patch rather than a whole record because the two writers are independent:
 * App.setHeaderTitle knows the title and nothing about the Improve target,
 * ImproveStatus.setAppOpen the reverse. Writing whole records from either
 * would have each clobber the other's field on every navigation.
 */
export function saveShellSnapshot(patch: Partial<Omit<ShellSnapshot, 'savedAt'>>): void {
  if (!isBrowser()) return;
  try {
    const prev = readShellSnapshot();
    const next: ShellSnapshot = {
      title: patch.title ?? prev?.title ?? '',
      subtitle: patch.subtitle ?? prev?.subtitle ?? '',
      improveTarget: patch.improveTarget ?? prev?.improveTarget ?? '',
      savedAt: Date.now(),
    };
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // A bar that starts neutral is strictly better than a throw on every
    // navigation.
  }
}

export function clearShellSnapshot(): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* nothing to undo */
  }
}
