/**
 * The boot's way back: a shell that opens blank asks for a fresh copy once.
 *
 * ── Why this exists ───────────────────────────────────────────────────
 *
 * ./boot-guard.ts keeps one startup step from taking the whole shell down, and
 * `../head.html` records what went wrong so a reader can see it. Neither of
 * them can help a page that is ALREADY blank: every navigation goes through
 * the service worker, `public/sw.js` hands hosted builds to the release
 * cache's `navigate`, and that races the network against the CACHED shell
 * document on a 200ms deadline. Pulling to reload, or opening the app again
 * from the home screen, is an ordinary navigation, so a phone answers it with
 * the same cached document and the same cached build assets. Only killing the
 * app (a new process, with the worker's caches re-read) made the content
 * return.
 *
 * So on a failed boot there is exactly one move that can work: ask the server
 * for the document itself and skip the saved copy. That is what this does,
 * once per visit, a few seconds after the page starts and shortly after it
 * comes back to the foreground.
 *
 * ── What "came up" means ──────────────────────────────────────────────
 *
 * Structure, never pixels. The head's snapshot says the same things: React
 * adopted the document, `app.js` defined `App`, a screen root is shown, and
 * that root holds something. An earlier check that judged by pixels accused
 * pages that were fine (see the boot-floor suite's note on the retired
 * panel); a skeleton, an icon or a frame counts as content, so a slow but
 * healthy load is never mistaken for a blank one.
 *
 * ── Why it cannot loop ────────────────────────────────────────────────
 *
 * Two independent guards. The sessionStorage marker records the attempt, and
 * the `fresh-shell` parameter on the load being checked marks that copy as
 * the fresh one. A device that refuses the storage write makes no attempt at
 * all. A failed fresh copy therefore stays on screen exactly as it does
 * today, and force-closing remains the way out.
 *
 * `console.warn` only, never `console.error`: a console error on any route
 * fails the platform's proposal checks, and a recovery is a diagnostic, not
 * a failure of the page it is running on. The record lands in
 * `window.__unBoot.errors`, the same list the head's watchdog prints.
 */

import { isEmbeddedPanel } from './side-panel-mode';

/** The one marker that says this visit has already asked for a fresh copy. */
export const RECOVERY_STORAGE_KEY = 'sv:boot-recovery';

/** The address parameter that asks the worker and the page to skip the cache. */
export const FRESH_SHELL_PARAM = 'fresh-shell';

/** A screen root that is shown is the shell's own evidence that it drew. */
const SCREEN_SELECTOR = '[id$="-screen"], #app-view';

/**
 * What counts as content inside a shown screen. Skeletons are deliberate
 * content: a screen waiting on its first read is not a blank screen.
 */
const CONTENT_SELECTOR =
  'img, svg, iframe, canvas, video, input, textarea, [role="progressbar"], .skeleton, [data-skeleton]';

const START_DELAY_MS = 4000;
const RETURN_DELAY_MS = 2000;

export interface ShellVerdict {
  ok: boolean;
  /** Why it did not come up, when it did not. */
  reason?: string;
}

interface BootStepRecord {
  step?: string;
  at?: number;
}

interface BootErrorRecord {
  step: string;
  message: string;
  stack?: string;
}

interface BootElement {
  id?: string;
  hidden?: boolean;
  classList?: { contains?: (name: string) => boolean };
  innerText?: string;
  querySelector?: (selector: string) => unknown;
}

interface BootDocument {
  readyState?: string;
  visibilityState?: string;
  body?: object | null;
  documentElement?: BootElement | null;
  querySelectorAll?: (selector: string) => ArrayLike<BootElement>;
  addEventListener?: (type: string, listener: (event?: unknown) => void) => void;
}

interface BootWindow {
  __unBoot?: { errors?: BootErrorRecord[]; steps?: BootStepRecord[] };
  App?: unknown;
  top?: unknown;
  navigator?: { onLine?: boolean };
  sessionStorage?: {
    getItem?: (key: string) => string | null;
    setItem?: (key: string, value: string) => void;
  };
  location?: { href?: string; replace?: (url: string) => void };
  history?: { replaceState?: (data: unknown, title: string, url?: string) => void };
  document?: BootDocument;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  addEventListener?: (type: string, listener: (event?: unknown) => void) => void;
}

function warn(message: string, detail?: unknown): void {
  try {
    console.warn(`[boot-recovery] ${message}`, detail === undefined ? '' : detail);
  } catch { /* a console that throws is not worth a second throw */ }
}

/** The document this window owns; the global one where the window has none. */
function resolveDocument(win: BootWindow | undefined): BootDocument | null {
  if (win && win.document) return win.document;
  try {
    return typeof document !== 'undefined' ? (document as unknown as BootDocument) : null;
  } catch {
    return null;
  }
}

function hasOwnKey(value: object | null | undefined, prefix: string): boolean {
  if (!value) return false;
  try {
    return Object.keys(value).some((key) => key.indexOf(prefix) === 0);
  } catch {
    return false;
  }
}

function isShown(element: BootElement): boolean {
  if (!element) return false;
  if (element.hidden) return false;
  try {
    return !(element.classList && element.classList.contains && element.classList.contains('hidden'));
  } catch {
    return true;
  }
}

function isEmptyScreen(element: BootElement): boolean {
  let text = '';
  try {
    text = typeof element.innerText === 'string' ? element.innerText.trim() : '';
  } catch {
    text = '';
  }
  if (text) return false;
  try {
    return !(element.querySelector && element.querySelector(CONTENT_SELECTOR));
  } catch {
    return true;
  }
}

/**
 * Whether the shell actually came up on this document, judging by structure.
 * Pure: it reads the document and the boot record and returns a verdict.
 */
export function shellCameUp(
  doc: BootDocument | null | undefined,
  win: BootWindow | undefined,
): ShellVerdict {
  const steps = win && win.__unBoot && Array.isArray(win.__unBoot.steps) ? win.__unBoot.steps : [];
  const hydrated = steps.some((entry) => !!entry && entry.step === 'hydrate');
  // The same test as the head snapshot's "react" line.
  const adopted = hasOwnKey(doc && doc.body, '__reactContainer');
  if (!hydrated || !adopted) return { ok: false, reason: 'not-hydrated' };

  if (!win || !win.App) return { ok: false, reason: 'no-app' };

  let shown: BootElement[] = [];
  try {
    const found = doc && doc.querySelectorAll ? doc.querySelectorAll(SCREEN_SELECTOR) : [];
    for (let i = 0; i < found.length; i += 1) {
      if (isShown(found[i])) shown.push(found[i]);
    }
  } catch {
    shown = [];
  }
  if (!shown.length) return { ok: false, reason: 'no-screen' };

  if (shown.every(isEmptyScreen)) return { ok: false, reason: 'empty-screen' };

  return { ok: true };
}

function sessionStorageOf(win: BootWindow | undefined): BootWindow['sessionStorage'] | null {
  try {
    return win && win.sessionStorage ? win.sessionStorage : null;
  } catch {
    return null;
  }
}

/**
 * Whether this visit has already asked for a fresh copy. Storage the page
 * cannot read is treated the same as a marker: without it an attempt could
 * not be remembered, and an unremembered attempt could loop.
 */
function recoveryAlreadyTried(win: BootWindow | undefined): boolean {
  const storage = sessionStorageOf(win);
  if (!storage || typeof storage.getItem !== 'function') return true;
  try {
    const value = storage.getItem(RECOVERY_STORAGE_KEY);
    return value !== null && value !== undefined && value !== '';
  } catch {
    return true;
  }
}

/** Add one line to the head watchdog's list, which is where it is printed. */
function record(win: BootWindow | undefined, message: string): void {
  if (!win) return;
  try {
    if (!win.__unBoot) win.__unBoot = { errors: [], steps: [] };
    const store = win.__unBoot;
    if (!Array.isArray(store.errors)) store.errors = [];
    store.errors.push({ step: 'recovery', message });
  } catch { /* the record is a nicety; the recovery itself still happens */ }
}

/**
 * Drop `fresh-shell` from the address bar before DOMContentLoaded, so
 * `App.init`'s router never sees it and a link copied afterwards looks like
 * every other one. Returns whether this load carried it.
 */
function removeFreshShellParam(win: BootWindow | undefined): boolean {
  try {
    const location = win && win.location;
    if (!location || typeof location.href !== 'string') return false;
    const url = new URL(location.href);
    if (!url.searchParams.has(FRESH_SHELL_PARAM)) return false;
    url.searchParams.delete(FRESH_SHELL_PARAM);
    const next = url.pathname + url.search + url.hash;
    try {
      if (win.history && typeof win.history.replaceState === 'function') {
        win.history.replaceState(null, '', next);
      }
    } catch {
      /* the address bar keeps the parameter; the storage marker still holds */
    }
    return true;
  } catch (err) {
    warn('could not read the address', err);
    return false;
  }
}

/** Say in the boot record what a load that carries the marker came after. */
function recordFreshLoad(win: BootWindow | undefined): void {
  let reason = 'unknown';
  try {
    const storage = sessionStorageOf(win);
    const raw = storage && typeof storage.getItem === 'function'
      ? storage.getItem(RECOVERY_STORAGE_KEY)
      : null;
    if (raw) {
      const parsed = JSON.parse(raw) as { reason?: unknown } | null;
      if (parsed && typeof parsed.reason === 'string' && parsed.reason) reason = parsed.reason;
    }
  } catch {
    /* the marker was unreadable; the reason in the record stays "unknown" */
  }
  record(win, `fresh copy loaded after: ${reason}`);
}

/**
 * Ask for a copy the service worker does not answer from its cache. The
 * attempt is remembered first; if the page cannot remember it, there is no
 * attempt at all, so this can never become a reload loop.
 */
function recover(win: BootWindow | undefined, reason: string): void {
  const storage = sessionStorageOf(win);
  const marker = JSON.stringify({ at: Date.now(), reason });
  let remembered = false;
  try {
    if (!storage || typeof storage.setItem !== 'function' || typeof storage.getItem !== 'function') {
      throw new Error('no sessionStorage');
    }
    storage.setItem(RECOVERY_STORAGE_KEY, marker);
    remembered = storage.getItem(RECOVERY_STORAGE_KEY) === marker;
  } catch (err) {
    warn('could not remember the attempt; not reloading', err);
    remembered = false;
  }

  if (!remembered) {
    record(win, `shell did not come up (${reason}); could not remember the attempt, so not reloading`);
    return;
  }

  record(win, `shell did not come up (${reason}); loading a fresh copy`);
  warn(`shell did not come up (${reason}); loading a fresh copy`);

  try {
    const location = win && win.location;
    if (!location || typeof location.replace !== 'function') return;
    const url = new URL(String(location.href || ''));
    url.searchParams.set(FRESH_SHELL_PARAM, String(Date.now()));
    location.replace(url.toString());
  } catch (err) {
    warn('could not load a fresh copy', err);
  }
}

/**
 * Watch this visit for a blank shell: once a few seconds after start-up, and
 * again shortly after each return to the foreground. A healthy page passes
 * every check and nothing else changes.
 */
export function installBootRecovery(
  win: BootWindow | undefined =
    typeof window !== 'undefined' ? (window as unknown as BootWindow) : undefined,
): void {
  if (!win) return;

  let timer: unknown = null;
  let hadFreshShell = false;

  try {
    const doc = resolveDocument(win);
    if (!doc) return;

    hadFreshShell = removeFreshShellParam(win);
    if (hadFreshShell) recordFreshLoad(win);

    const check = (): void => {
      try {
        // A check while the page is not shown cannot judge what it draws.
        if (doc.visibilityState === 'hidden') return;
        if (hadFreshShell) return;
        if (win.top !== win) return;
        if (isEmbeddedPanel()) return;
        if (win.navigator && win.navigator.onLine === false) return;
        if (recoveryAlreadyTried(win)) return;

        const verdict = shellCameUp(doc, win);
        if (verdict.ok) return;
        recover(win, verdict.reason || 'unknown');
      } catch (err) {
        warn('check failed', err);
      }
    };

    const schedule = (delay: number): void => {
      try {
        // Repeated load/visibility events collapse into the timer already
        // waiting; one check is enough to decide.
        if (timer !== null) return;
        const set = win.setTimeout;
        if (typeof set !== 'function') return;
        timer = set.call(win, () => {
          timer = null;
          check();
        }, delay);
      } catch (err) {
        warn('could not schedule a check', err);
      }
    };

    if (doc.readyState === 'complete') {
      schedule(START_DELAY_MS);
    } else if (typeof win.addEventListener === 'function') {
      win.addEventListener('load', () => schedule(START_DELAY_MS));
    }

    if (typeof doc.addEventListener === 'function') {
      doc.addEventListener('visibilitychange', () => {
        try {
          if (doc.visibilityState === 'visible') schedule(RETURN_DELAY_MS);
        } catch (err) {
          warn('could not read the document state', err);
        }
      });
    }

    if (typeof win.addEventListener === 'function') {
      win.addEventListener('pageshow', (event) => {
        try {
          const persisted = !!(event && (event as { persisted?: boolean }).persisted);
          if (persisted) schedule(RETURN_DELAY_MS);
        } catch (err) {
          warn('could not read the page event', err);
        }
      });
    }
  } catch (err) {
    warn('could not install', err);
  }
}
