/**
 * The side panel's WIDTH (#2886) — the divider between a running app and the
 * panel beside it can be dragged, and the width it is left at is this
 * device's from then on.
 *
 * ── One knob, the one the layout already has ─────────────────────────
 *
 * public/css/app.css sizes both halves off `--side-panel-w`: the panel is that
 * wide, and `html[data-side-panel] #app-view` takes it as a right margin. So a
 * chosen width is that property, written inline on <html> — which is not
 * React-owned (main.tsx hydrates <body>), the same reason mount.ts writes
 * `data-side-panel` there directly. With nothing chosen the property is
 * absent and the stylesheet's `clamp(360px, 36vw, 560px)` answers, exactly as
 * before this existed.
 *
 * ── Neither half can be dragged unusably small ────────────────────────
 *
 * The panel keeps MIN_PANEL_W: its document takes its phone layout, and below
 * a phone's width that layout stops fitting. The app keeps MIN_APP_W — the
 * figure app.css already floors `#app-view` at while the panel is up — so the
 * widest the panel can go is the window, less whatever sits left of the app
 * (the rail), less that. The bound is re-read on every use, so a window that
 * narrows gives a remembered width back instead of letting it squeeze the app.
 *
 * ── Beside the Homeroom bot page, the list's floor and the Duo's column ─
 *
 * Main is the same column there, and its neighbour is the bot's list, not an
 * app: the list keeps what app.css gives it (`--ai-list-min`: the inbox's own
 * `--list-pane-w` with something open beside it, 280px below 1024px), read
 * from the stylesheet so the two cannot disagree. The drag stopped at the
 * app's 480px while the stylesheet allowed 360.
 *
 * ── Two widths, two keys (3 Nov 2026) ─────────────────────────────────
 *
 * Main Chat's edge and the side panel's look alike and are dragged the same
 * way, but they are not the same width: a panel narrowed beside an app used
 * to narrow Main too, because both read one key. Main has its own key now
 * (`AI_MAIN_WIDTH_KEY`) and its own property (`--ai-main-chosen-w`), and the
 * panel beside an app keeps `--side-panel-w`. A width remembered before this
 * is still the panel's; Main starts from its default.
 *
 * iPhone Duo held sideways has an 84px column of system chrome on the right
 * (`--platform-strip-w`, side-strip.ts), and Main runs under it (app.css,
 * THE PINNED COLUMNS RUN UNDER IT). The width chosen is what is left of the
 * column: measured from the panel's left edge to the column, not as the
 * panel's box, which counted the column, so the first 84px of a drag moved
 * nothing.
 *
 * ── With a preview open, two edges and three columns (#6359) ──────────
 *
 * A design's or a plan's preview stands beside the thread (features/ai,
 * list | thread | preview at 1500px and up, thread | preview in halves
 * below). Both edges are handles then, each setting the width of the column
 * after it while the list takes what is left: the thread's under
 * `AI_PREVIEW_COLUMN_WIDTH_KEY` (`--ai-col-chosen-w`), not Main's, since the
 * thread is a narrower column there, and the preview's under
 * `AI_PREVIEW_WIDTH_KEY` (`--ai-preview-chosen-w`). The thread does not reach
 * the window's edge, so its width is measured to where the preview begins
 * (`endAt`), and each edge's bound reserves the floors of the columns beside
 * it (`neighbourMin`, the list's and the other column's), the stylesheet
 * keeping the same floors.
 *
 * ── Per device, and never trusted blindly ─────────────────────────────
 *
 * localStorage, one number. Every read and write is wrapped: storage can be
 * absent, full, or throw on access (a private window, blocked site data), and
 * any of those is simply "the default width". A stored value is clamped to
 * the current window before it is applied; it is never rewritten by a clamp,
 * so a window that grows back gets the chosen width back too.
 */

/** localStorage key for the side panel's chosen width, in CSS pixels. */
export const WIDTH_KEY = 'usernode_side_panel_w_v1';

/**
 * Main Chat's own width on the Homeroom bot page, kept apart from the side
 * panel's: the two are dragged in different places. The property it drives is
 * `--ai-main-chosen-w`, which only app.css's `--ai-main-w` reads.
 */
export const AI_MAIN_WIDTH_KEY = 'usernode_ai_main_w_v1';

/** The thread's width beside a design's or a plan's preview (#6359). */
export const AI_PREVIEW_COLUMN_WIDTH_KEY = 'usernode_ai_preview_col_w_v1';

/** The preview's own width beside the thread (#6359). */
export const AI_PREVIEW_WIDTH_KEY = 'usernode_ai_preview_w_v1';

/** The CSS property each key drives on <html>. */
const WIDTH_PROPERTY: Record<string, string> = {
  [WIDTH_KEY]: '--side-panel-w',
  [AI_MAIN_WIDTH_KEY]: '--ai-main-chosen-w',
  [AI_PREVIEW_COLUMN_WIDTH_KEY]: '--ai-col-chosen-w',
  [AI_PREVIEW_WIDTH_KEY]: '--ai-preview-chosen-w',
};

function propertyFor(key: string): string {
  return WIDTH_PROPERTY[key] ?? WIDTH_PROPERTY[WIDTH_KEY];
}

/** The narrowest the panel may be dragged. */
export const MIN_PANEL_W = 320;

/** The narrowest the app beside it may be left (app.css's `min-width: 480px`). */
export const MIN_APP_W = 480;

/** One arrow-key press; Shift moves four times as far. */
export const KEY_STEP = 16;

export interface WidthBounds {
  min: number;
  max: number;
}

/** What `bounds` reads, so it can be driven without a browser. */
export interface LayoutProbe {
  innerWidth: number;
  /** Where the app view begins from the window's inline-start edge (the rail's width). */
  appLeft: number;
  /** The Duo's column on the panel's side, which the panel runs under but does not count. */
  rightInset?: number;
  /** The narrowest the neighbour may be left: the app's, or the bot's list's
   *  (with a preview open, the floors of every other column together). */
  neighbourMin?: number;
  /** The narrowest this column may be dragged, when not MIN_PANEL_W. */
  selfMin?: number;
  /** Where the column's room ends, from the window's inline-start edge, when
   *  another column follows it (the thread before a preview); the window's
   *  far edge otherwise. */
  endAt?: number;
}

/** The far end of the room the panel's width is measured to, on the panel's side. */
function roomRight(probe: LayoutProbe): number {
  return probe.innerWidth - Math.max(0, probe.rightInset || 0);
}

/** The range the panel's width may take in this window. */
export function bounds(probe: LayoutProbe): WidthBounds {
  const room = Math.floor(roomRight(probe) - Math.max(0, probe.appLeft) - (probe.neighbourMin ?? MIN_APP_W));
  const min = probe.selfMin ?? MIN_PANEL_W;
  return { min, max: Math.max(min, room) };
}

/** The panel's width as chosen: its inner edge to the end of the room. */
export function shownWidth(panelLeft: number, probe: LayoutProbe): number {
  return Math.round((probe.endAt ?? roomRight(probe)) - panelLeft);
}

/**
 * A box's start edge from the window's inline-start edge. Everything in this
 * file reads in these figures, so its sums hold in Arabic, where the panel is
 * pinned to the left and the rail to the right.
 */
export function inlineStartOf(box: { left: number; right: number }, win: Window = window): number {
  return win.document?.documentElement?.dir === 'rtl' ? win.innerWidth - box.right : box.left;
}

/** `width`, held inside `b` and rounded to a whole pixel. */
export function clampWidth(width: number, b: WidthBounds): number {
  return Math.round(Math.min(b.max, Math.max(b.min, width)));
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** The width this device chose for `key`, or null for the default. */
export function readStoredWidth(store: StorageLike | null = storage(), key: string = WIDTH_KEY): number | null {
  try {
    const raw = store ? store.getItem(key) : null;
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function writeStoredWidth(width: number, store: StorageLike | null = storage(), key: string = WIDTH_KEY): void {
  try {
    if (store) store.setItem(key, String(Math.round(width)));
  } catch {
    /* a width that does not survive a reload is the default next time */
  }
}

export function clearStoredWidth(store: StorageLike | null = storage(), key: string = WIDTH_KEY): void {
  try {
    if (store) store.removeItem(key);
  } catch {
    /* nothing stored, or nowhere to store it: the default either way */
  }
}

/**
 * Apply `width` to the layout, or null to hand it back to the stylesheet.
 * Only `key`'s own property is written — `--side-panel-w` beside an app,
 * `--ai-main-chosen-w` for the bot page's Main — so a drag on one edge never
 * moves the other. Each is set only while a width is chosen: Main takes the
 * room its list does not need when nothing is chosen (app.css
 * `--ai-main-auto`), and a property that is always there could not say
 * whether it was a choice.
 */
export function applyWidth(
  width: number | null,
  root: HTMLElement = document.documentElement,
  key: string = WIDTH_KEY,
): void {
  const property = propertyFor(key);
  if (width == null) root.style.removeProperty(property);
  else root.style.setProperty(property, `${Math.round(width)}px`);
}

/** Is the Homeroom bot page the one on screen? Main Chat's column is drawn
 *  only there, and that is the width its edge sets. */
export function aiPageUp(doc: Document = document): boolean {
  try {
    const ai = doc.getElementById('ai-screen');
    return !!ai && !ai.classList.contains('hidden');
  } catch {
    return false;
  }
}

/**
 * The live layout's probe. Beside the AI tab's page (no app on screen, so
 * #app-view has no box) what is left of the panel's neighbour is the rail,
 * docked: a folded or peeking one takes no width.
 */
export function probeLayout(win: Window = window): LayoutProbe {
  let appLeft = 0;
  try {
    const rtl = win.document.documentElement?.dir === 'rtl';
    const app = win.document.getElementById('app-view');
    const box = app ? app.getBoundingClientRect() : null;
    if (box && box.width > 0) appLeft = inlineStartOf(box, win);
    else {
      const rail = win.document.getElementById('platform-tabs');
      if (rail && !rail.classList.contains('platform-tabs-peek')) appLeft = Math.max(0, rtl ? win.innerWidth - rail.getBoundingClientRect().left : rail.getBoundingClientRect().right);
    }
  } catch {
    appLeft = 0;
  }
  let rightInset = 0;
  let neighbourMin = MIN_APP_W;
  try {
    const doc = win.document;
    const style = doc.body ? win.getComputedStyle(doc.body) : null;
    const px = (name: string): number => {
      const raw = style ? style.getPropertyValue(name).trim() : '';
      const n = parseFloat(raw);
      if (!Number.isFinite(n) || n <= 0) return 0;
      // A floor can be written in rem: `--ai-list-min` resolves from the
      // shared `--list-pane-w` (22rem, #6495), and getComputedStyle hands
      // back the substituted token stream, not pixels. Read it against the
      // root's own type size; a px value parses as it always has.
      if (/^-?(?:\d+\.?\d*|\.\d+)rem$/.test(raw)) {
        const root = parseFloat(win.getComputedStyle(doc.documentElement).fontSize);
        return n * (Number.isFinite(root) && root > 0 ? root : 16);
      }
      return n;
    };
    const panelSide = doc.documentElement.dir === 'rtl' ? 'left' : 'right';
    if (doc.documentElement.getAttribute('data-side-strip') === panelSide) rightInset = px('--platform-strip-w');
    if (aiPageUp(doc)) neighbourMin = px('--ai-list-min') || MIN_APP_W;
  } catch {
    rightInset = 0;
    neighbourMin = MIN_APP_W;
  }
  return { innerWidth: win.innerWidth, appLeft, rightInset, neighbourMin };
}
