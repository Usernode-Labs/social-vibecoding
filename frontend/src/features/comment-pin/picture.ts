/**
 * The screenshot a C comment carries (#4289 follow-up): the page as the
 * person sees it when they put the pin down. The pin itself is not drawn in
 * (#4482): it is posted beside the picture as data (./pin-data.ts), so the
 * request's page can show the page clean or with the comment over it.
 *
 * ── No screen-share prompt ─────────────────────────────────────────────
 *
 * The feedback dialog's capture is real screen pixels through the browser's
 * Screen Capture API (../dialogs/screenshot-select.js): a prompt every time,
 * and on Firefox and Safari a window share the page has to find itself in.
 * A comment is meant to be quick, so this one DRAWS the page instead, with
 * SnapDOM (public/usernode-bridge/v1/snapdom.js, pinned and recorded in
 * public/vendor/README.md), which hands the browser its own rendering of a
 * clone of the page. Loaded on the first comment and never otherwise.
 *
 * ── The running app draws itself ──────────────────────────────────────
 *
 * The app is another origin, so the shell cannot draw it. It asks: the
 * bridge every app loads answers `__usernode_snapshot: "render"` with the
 * app's own picture (the __USERNODE_SNAPSHOT_ block of
 * public/usernode-bridge/v1/bridge.js, which answers the platform's origin
 * only), and it is laid into the frame's rectangle. An app that does not
 * answer in time gets a plain panel saying so; the comment still goes.
 *
 * ── The side panel draws itself (#4975) ───────────────────────────────
 *
 * The panel beside the app is the platform itself in a same-origin frame
 * (#side-panel-frame), and drawShell leaves every frame out — so a comment
 * taken with the panel open carried its title bar over an empty body. The
 * panel's document draws itself: `picture` on its embedded runtime
 * (../side-panel/embedded.ts) answers with `drawDocument`'s blob — the same
 * options as drawShell, run in the panel's own document — and takeBase lays
 * it in at the frame's rectangle, beside the app's picture.
 *
 * ── When ───────────────────────────────────────────────────────────────
 *
 * The page is drawn the moment a pin goes down (`takeBase`), so it shows the
 * page as it was, and is ready by the time the words are. In comment mode
 * every pin is drawn on its own, and the mode's layer never is. The layout
 * helpers are pure and exported for tests.
 *
 * A picture used to come out with part of the page missing: the sticky and
 * fixed parts (the header, the rail, the section column, the tab bar)
 * survived, and the in-flow content under them did not (#4773). The cause
 * was the overlays the picture leaves out (PAGE_EXCLUDES, below), drawn
 * through SnapDOM's `hide` mode: it stands a plain block of the element's
 * size in its place, and that block keeps neither `position: fixed` nor
 * `absolute`. The Homeroom menu's dim (`#apps-switcher-overlay`) is always
 * mounted, transparent, `fixed inset-0`, so every picture carried a
 * screen-tall block in the page's flow, and in the bounded shell (the
 * Homeroom app, a computer) it pushed the whole screen out of the body.
 * Reproduced in WebKit with `?un-native-webview=1`, 12 Oct 2026: Home,
 * Settings and Discover all drew header and tab bar only. Those overlays are
 * now cut out (`filter`, `filterMode: 'remove'`): they are out of the
 * flow, so cutting one out moves nothing. The comment layer's host and the
 * frames keep `hide`, which holds their place.
 *
 * `takeBase` still reads the element under the pin before it draws, and
 * when that element's rectangle in the picture is one flat colour while the
 * live element has words, it takes one more picture two animation frames
 * later with the cache off, and uses that whatever it shows. One retake,
 * and only for a pin on something with words: a page that really draws flat
 * never loops, and a pin on the running app's frame or on empty background
 * never asks for one.
 *
 * ── Crop (#4977) ──────────────────────────────────────────────────────
 *
 * A screenshot of the whole screen is often wider than the thing the person
 * is pointing at, so comment mode can crop one: a frame over the picture
 * whose corner and edge handles drag in (never out past the original
 * capture). The crop lives as `Rect` fractions of the full picture, so it
 * survives a resize and a device-pixel scale change. A comment's pin stays
 * a fraction of the FULL picture; every reader maps it through `pinInCrop`
 * into the crop's own fractions, and a pin outside the crop is null — the
 * comment it belongs to goes with the part that was cut away.
 */

export const LIB_SRC = '/usernode-bridge/v1/snapdom.js';
/** The feedback endpoint's cap (src/routes/feedback.js MAX_SCREENSHOT_BYTES). */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const SNAPSHOT_KEY = '__usernode_snapshot';
/** How long the app gets to draw itself, the library's first load included. */
export const APP_PICTURE_TIMEOUT_MS = 8000;
/**
 * The panel gets less than the app: it runs on this same page, and its draw
 * competes with the shell's own for the one main thread.
 */
export const PANEL_PICTURE_TIMEOUT_MS = 3000;
/** The page's own draw, the library's first load included. */
export const SHELL_PICTURE_TIMEOUT_MS = 15000;

/**
 * `p`'s value, or `fallback` when `p` rejects or `ms` passes first — the
 * bound that keeps one slow leg of a picture from holding the mode open.
 */
export function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(fallback); },
    );
  });
}

export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; width: number; height: number }
export interface Size { width: number; height: number }

/** The element under a point, in a few words (the bridge's `describe`). */
export interface ElementInfo { tag: string; id: string; text: string }

export interface AppPicture {
  blob: Blob | null;
  error: string | null;
  at: ElementInfo | null;
  path: string;
}

type Capture = { toCanvas(): Promise<HTMLCanvasElement> };
type Snapdom = (el: Element, options: Record<string, unknown>) => Promise<Capture>;

let library: Promise<Snapdom> | null = null;

/**
 * SnapDOM, loaded once from the hosted copy. Its bundle sets
 * `window.snapdom`; that global is put back as it was, so nothing else on the
 * page sees it appear.
 */
export function loadLibrary(): Promise<Snapdom> {
  if (library) return library;
  const p = new Promise<Snapdom>((resolve, reject) => {
    const w = window as unknown as Record<string, unknown>;
    const had = Object.prototype.hasOwnProperty.call(w, 'snapdom');
    const before = w.snapdom;
    const s = document.createElement('script');
    s.src = LIB_SRC;
    s.async = true;
    const done = () => { s.remove(); };
    s.onload = () => {
      const lib = w.snapdom;
      if (had) w.snapdom = before;
      else delete w.snapdom;
      done();
      if (typeof lib === 'function') resolve(lib as Snapdom);
      else reject(new Error('the drawing library did not load'));
    };
    s.onerror = () => { done(); reject(new Error('the drawing library did not load')); };
    document.head.appendChild(s);
  });
  library = p;
  p.catch(() => { if (library === p) library = null; });
  return p;
}

/**
 * Device pixels per CSS pixel for the picture: the screen's own, up to 2,
 * and never so many that the long side passes 3000 pixels (the upload cap is
 * 4 MB, and a 4K screen at 2x would only be shrunk again).
 */
export function pictureScale(dpr: number, viewport: Size): number {
  const longSide = Math.max(1, viewport.width, viewport.height);
  const wanted = Math.min(2, Math.max(1, Number(dpr) || 1));
  return Math.max(0.5, Math.min(wanted, 3000 / longSide));
}

export function inRect(p: Point, r: Rect | null | undefined): boolean {
  return !!r && p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height;
}

/**
 * Where a box of `size` goes beside the pin: right of it and below by
 * default, flipped left or up when it would leave the viewport, and kept
 * `margin` inside it. The comment box and an open marker's card use it.
 */
export function placeBeside(pin: Point, size: Size, viewport: Size, gap = 14, margin = 8): Point {
  let x = pin.x + gap;
  let y = pin.y + gap;
  if (x + size.width > viewport.width - margin) x = pin.x - gap - size.width;
  if (y + size.height > viewport.height - margin) y = pin.y - gap - size.height;
  x = Math.max(margin, Math.min(x, viewport.width - margin - size.width));
  y = Math.max(margin, Math.min(y, viewport.height - margin - size.height));
  return { x, y };
}

// ── The inset view (the comment-mode rework) ──────────────────────────
//
// Comment mode shows the page as a picture of it instead of over the live
// page, so nothing reads as clickable. These are the pure bits of that
// drawing, exported for tests.

/**
 * Where the page's picture sits on the screen: the whole viewport shrunk
 * until it clears `margin` on every side, keeping the screen's shape,
 * centred. `top` is a band kept clear above it all the way across (the
 * view's header lives there), so the picture is smaller still and never
 * runs under the header.
 */
export function insetFrame(viewport: Size, margin: number, top = 0): { x: number; y: number; scale: number } {
  const w = Math.max(1, viewport.width);
  const h = Math.max(1, viewport.height);
  const scale = Math.min((w - 2 * margin) / w, (h - 2 * margin - top) / h);
  return {
    x: (w - w * scale) / 2,
    y: top + (h - top - h * scale) / 2,
    scale: Math.max(0, scale),
  };
}

/** A point of the page to where it sits on the inset picture. */
export function toScreen(p: Point, frame: { x: number; y: number; scale: number }): Point {
  return { x: p.x * frame.scale + frame.x, y: p.y * frame.scale + frame.y };
}

/** A point on the inset picture back to where it is on the page. */
export function toPage(p: Point, frame: { x: number; y: number; scale: number }): Point {
  const s = frame.scale || 1;
  return { x: (p.x - frame.x) / s, y: (p.y - frame.y) / s };
}

/**
 * A picture drawn to cover a box, as `object-fit: cover` would, slid so the
 * point that matters (`focus`, as fractions of the picture) is as near the
 * box's middle as the picture's edges allow, rather than always showing its
 * top-left corner. Returns the drawn size and its top-left corner in the
 * box; a pin goes at `x + pin.x * width`, `y + pin.y * height`. A phone's
 * picture in a wide preview shows a third of its height at most, so a pin
 * placed as a fraction of the box instead landed on another part of the
 * page entirely.
 */
export function coverCrop(box: Size, picture: Size, focus: Point): Rect {
  const pw = Math.max(1, picture.width);
  const ph = Math.max(1, picture.height);
  const s = Math.max(box.width / pw, box.height / ph);
  const width = pw * s;
  const height = ph * s;
  const fx = Number.isFinite(focus?.x) ? focus.x : 0.5;
  const fy = Number.isFinite(focus?.y) ? focus.y : 0.5;
  return {
    x: clamp(box.width / 2 - fx * width, box.width - width, 0),
    y: clamp(box.height / 2 - fy * height, box.height - height, 0),
    width,
    height,
  };
}

/** What the close-up draws, and where. */
export interface CloseUp {
  /** The drawn picture's size, in the box's pixels. */
  size: Size;
  /** The drawn picture's top-left corner in the box. */
  offset: Point;
  /** The zoom actually drawn, clamped. */
  zoom: number;
  /** The pan actually drawn, clamped to the picture's edges. */
  pan: Point;
}

const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));

/**
 * The close-up's drawn picture. Zoom is 1 to 4 about the pin (1 = the
 * picture's width fits the box), pan moves the view from there; both are
 * clamped so the picture always covers the box, and the returned `pan` is
 * the clamped one, so a caller can keep it as its state.
 */
export function closeUpView(input: {
  /** Where the pin is on the picture, in the picture's own pixels. */
  pin: Point;
  /** The close-up box's size, in screen pixels. */
  box: Size;
  /** The picture's size, in its own pixels. */
  picture: Size;
  zoom: number;
  pan: Point;
}): CloseUp {
  const base = input.box.width / Math.max(1, input.picture.width);
  const zoom = clamp(Number(input.zoom) || 1, 1, 4);
  const size = {
    width: input.picture.width * base * zoom,
    height: input.picture.height * base * zoom,
  };
  const centre = { x: input.box.width / 2, y: input.box.height / 2 };
  const wanted = {
    x: centre.x - input.pin.x * base * zoom + (Number(input.pan?.x) || 0),
    y: centre.y - input.pin.y * base * zoom + (Number(input.pan?.y) || 0),
  };
  const offset = {
    x: size.width <= input.box.width
      ? (input.box.width - size.width) / 2
      : clamp(wanted.x, input.box.width - size.width, 0),
    y: size.height <= input.box.height
      ? (input.box.height - size.height) / 2
      : clamp(wanted.y, input.box.height - size.height, 0),
  };
  return {
    size,
    offset,
    zoom,
    pan: { x: offset.x - wanted.x, y: offset.y - wanted.y },
  };
}

// ── Crop (#4977) ───────────────────────────────────────────────────────

/** A crop frame's handle: two named sides, or one. */
export type CropHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** No crop: the whole picture. */
export const FULL_CROP: Rect = { x: 0, y: 0, width: 1, height: 1 };

/** The dim drawn outside a crop's kept rect. */
export const CROP_SHADE = '0 0 0 9999px rgba(0,0,0,0.45)';

/**
 * A drag on one handle, as fractions of the picture: only the sides the
 * handle names move, nothing passes the picture's edges, and a side never
 * crosses its opposite — the two stop `min` apart, so the frame keeps the
 * smallest size the caller allows (the pins must stay pointable). Inward
 * only: the caller never widens the picture, only this could, and it
 * clamps instead.
 */
export function dragCrop(crop: Rect, handle: CropHandle, delta: Point, min: Size): Rect {
  const c = { ...crop };
  const minW = Math.max(0, min.width);
  const minH = Math.max(0, min.height);
  const east = handle.includes('e');
  const west = handle.includes('w');
  const north = handle.includes('n');
  const south = handle.includes('s');
  if (east) c.width = clamp(c.width + delta.x, minW, 1 - c.x);
  if (west) {
    const right = c.x + c.width;
    c.x = clamp(c.x + delta.x, 0, right - minW);
    c.width = right - c.x;
  }
  if (south) c.height = clamp(c.height + delta.y, minH, 1 - c.y);
  if (north) {
    const bottom = c.y + c.height;
    c.y = clamp(c.y + delta.y, 0, bottom - minH);
    c.height = bottom - c.y;
  }
  return c;
}

/**
 * A pin (a fraction of the full picture) as a fraction of the crop, or null
 * when it falls outside the part kept. A null crop means no crop: the pin
 * comes back unchanged.
 */
export function pinInCrop(pin: Point, crop: Rect | null): Point | null {
  if (!crop) return { ...pin };
  if (!crop.width || !crop.height) return null;
  const x = (pin.x - crop.x) / crop.width;
  const y = (pin.y - crop.y) / crop.height;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
}

/** A crop as pixels on a canvas of `size`, rounded, never smaller than a point. */
export function cropPixels(size: Size, crop: Rect): Rect {
  const x = clamp(Math.round(crop.x * size.width), 0, Math.max(0, size.width - 1));
  const y = clamp(Math.round(crop.y * size.height), 0, Math.max(0, size.height - 1));
  const width = clamp(Math.round(crop.width * size.width), 1, size.width - x);
  const height = clamp(Math.round(crop.height * size.height), 1, size.height - y);
  return { x, y, width, height };
}

/** Whether a crop keeps the whole picture (the frame was reset or never moved). */
export function isFullCrop(crop: Rect | null): boolean {
  if (!crop) return true;
  const eps = 0.001;
  return (
    Math.abs(crop.x) < eps &&
    Math.abs(crop.y) < eps &&
    Math.abs(crop.width - 1) < eps &&
    Math.abs(crop.height - 1) < eps
  );
}

/** A new canvas holding just the crop, drawn from the picture's own pixels. */
export function cropCanvas(canvas: HTMLCanvasElement, crop: Rect): HTMLCanvasElement {
  const part = cropPixels({ width: canvas.width, height: canvas.height }, crop);
  const out = document.createElement('canvas');
  out.width = part.width;
  out.height = part.height;
  out.getContext('2d')?.drawImage(
    canvas,
    part.x, part.y, part.width, part.height,
    0, 0, part.width, part.height,
  );
  return out;
}

/**
 * Ask the running app's frame for its picture. Resolves with what it said,
 * or null when it said nothing in time (an app without the bridge, an old
 * bridge, a frame that is not the app's).
 */
export function requestAppPicture(
  frame: HTMLIFrameElement,
  ask: { scale: number; x?: number; y?: number },
  timeoutMs = APP_PICTURE_TIMEOUT_MS,
): Promise<AppPicture | null> {
  const target = frame.contentWindow;
  let origin: string;
  try { origin = new URL(frame.src).origin; } catch { return Promise.resolve(null); }
  if (!target || !origin || origin === 'null') return Promise.resolve(null);
  const id = `pin-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: AppPicture | null) => {
      window.removeEventListener('message', onMessage);
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    const onMessage = (e: MessageEvent) => {
      if (e.source !== target || e.origin !== origin) return;
      const d = e.data as Record<string, unknown> | null;
      if (!d || d[SNAPSHOT_KEY] !== 'picture' || d.id !== id) return;
      const blob = d.blob instanceof Blob ? d.blob : null;
      finish({
        blob,
        error: blob ? null : String(d.error || 'no picture'),
        at: cleanInfo(d.at),
        path: typeof d.path === 'string' ? d.path.slice(0, 200) : '',
      });
    };
    window.addEventListener('message', onMessage);
    timer = setTimeout(() => finish(null), timeoutMs);
    try {
      target.postMessage({ [SNAPSHOT_KEY]: 'render', id, scale: ask.scale, x: ask.x, y: ask.y }, origin);
    } catch {
      finish(null);
    }
  });
}

function cleanInfo(value: unknown): ElementInfo | null {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== 'object') return null;
  const s = (x: unknown, n: number) => (typeof x === 'string' ? x.slice(0, n) : '');
  const info = { tag: s(v.tag, 40), id: s(v.id, 80), text: s(v.text, 80) };
  return info.tag ? info : null;
}

/**
 * Ask the side panel's document for its picture (#4975). The panel is
 * same-origin, so its runtime is read straight off the frame's window
 * (`window.UsernodeReact.sidePanelEmbed`, mounted in ../side-panel/mount.ts)
 * — no postMessage, unlike the app's. Null when the frame has no runtime yet
 * (it is still booting, or gone), one that says nothing, or one that does not
 * answer in time — the panel's three seconds, not the app's eight, since its
 * draw runs on this same page. A blob is taken when it is a Blob of THIS
 * window or of the frame's: the panel's `toBlob` makes it in the panel
 * window's realm, which the top window's `instanceof Blob` never matched.
 */
export function requestPanelPicture(
  frame: HTMLIFrameElement,
  scale: number,
  timeoutMs = PANEL_PICTURE_TIMEOUT_MS,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: Blob | null) => {
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => finish(null), timeoutMs);
    try {
      const win = frame.contentWindow as unknown as
        { Blob?: unknown; UsernodeReact?: { sidePanelEmbed?: { picture?: (s: number) => Promise<Blob | null> } } } | null;
      const ask = win?.UsernodeReact?.sidePanelEmbed?.picture;
      const said = ask && typeof ask === 'function' ? ask(scale) : null;
      if (said && typeof said.then === 'function') {
        said.then((blob) => {
          const realmBlob = win?.Blob;
          const panelMade = typeof realmBlob === 'function' && blob instanceof (realmBlob as unknown as typeof Blob);
          finish(blob instanceof Blob || panelMade ? blob : null);
        }, () => finish(null));
      } else finish(null);
    } catch {
      finish(null);
    }
  });
}

/** The element under a point of the shell's own page, in a few words. */
export function describeElement(el: Element | null): ElementInfo | null {
  if (!el || el === document.documentElement || el === document.body) return null;
  // innerText, not textContent: it keeps the breaks between blocks, so two
  // lines do not run together into one word.
  let text = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt')
    || (el as HTMLElement).innerText || el.textContent || '';
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > 60) text = `${text.slice(0, 59).trim()}…`;
  return { tag: el.tagName.toLowerCase(), id: el.id || '', text };
}

/** True when every pixel is within `tolerance` a channel of the first one. */
export function flatRegion(data: Uint8ClampedArray, tolerance = 8): boolean {
  if (data.length < 4) return true;
  const r0 = data[0];
  const g0 = data[1];
  const b0 = data[2];
  const a0 = data[3];
  for (let i = 4; i < data.length; i += 4) {
    if (Math.abs(data[i] - r0) > tolerance
      || Math.abs(data[i + 1] - g0) > tolerance
      || Math.abs(data[i + 2] - b0) > tolerance
      || Math.abs(data[i + 3] - a0) > tolerance) return false;
  }
  return true;
}

/**
 * The page's own element under a pin, the one the picture has to show: the
 * first thing at the point that is not the comment's layer (`host`), not
 * inside one of the flow's own overlays (they are hidden out of the
 * picture, so the element under one is what the picture shows), with words
 * on it and big enough to read a region of the picture against. A frame is
 * another document: the pin is on the running app there, whose own picture
 * is laid in, so there is nothing to check. Null whenever there is nothing
 * to check, and no retake is asked for.
 */
export function pinTarget(pin: Point, host: Element): Rect | null {
  if (typeof document.elementsFromPoint !== 'function') return null;
  for (const el of document.elementsFromPoint(pin.x, pin.y)) {
    if (host.contains(el)) continue;
    if (el.tagName === 'IFRAME') return null;
    if (PAGE_EXCLUDES.some((sel) => el.closest(sel))) continue;
    if (el === document.documentElement || el === document.body) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const text = `${el.getAttribute('aria-label') || ''}${el.getAttribute('title') || ''}`
      + ((el as HTMLElement).innerText || el.textContent || '');
    if (!text.trim()) continue;
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }
  return null;
}

/**
 * The overlays the suggest flow itself had on screen a moment before, which
 * a picture of the page leaves out: the form still sliding away when the
 * mode opens (its Comment switch), and the native kit's shells playing their
 * exit — a dialog's on a computer, the Improve panel's. Drawn, such an
 * overlay reads as part of the page the comment is on, and the view keeps
 * the picture until the page next scrolls, so they are hidden rather than
 * waited out. The kit's classes exist only while one of its surfaces is up;
 * #feedback-modal is display:none whenever the form is not mid-exit itself,
 * and a hidden element is skipped outright. The Homeroom menu on a computer
 * (`#apps-switcher-sheet`, over `#apps-switcher-overlay`) is a CSS dropdown
 * and not a kit shell, so it is named by id. `.overlay-scrim` is the dim the
 * shell paints around an open sheet or dialog (lib/overlay-scrim.js), the
 * menu's included: a picture drawn while the menu is open, as the mode's
 * picture now is (comment-pin.tsx `prepareCommentView`), would otherwise
 * come out dimmed. Every one of them is out of the page's flow (fixed, or
 * display:none when not showing), which is why the capture cuts them out
 * rather than holding their place (`drawShell`).
 *
 * The hub's ⋯ dropdown (#dev-plus-menu) is inside the page the picture
 * draws, so a picture taken while it is open carries it; it is out of the
 * flow too, so cutting it out moves nothing.
 */
export const PAGE_EXCLUDES = [
  '#feedback-modal',
  '#apps-switcher-sheet',
  '#apps-switcher-overlay',
  '#dev-plus-menu',
  '.overlay-scrim',
  '.un-modal',
  '.un-sheet',
  '.un-panel',
  '.un-action-sheet',
  '.un-backdrop',
] as const;

/**
 * Whether one of the flow's own overlays (PAGE_EXCLUDES) is still on
 * screen: laid out, visible and not see-through. The menu's dim is always
 * mounted at opacity 0, and a closed menu sheet is `visibility: hidden`, so
 * neither counts once it has gone; the form mid-slide-down and a kit sheet
 * playing its exit do.
 */
export function overlayOnScreen(
  doc: Pick<Document, 'querySelectorAll'> = document,
  styleOf: (el: Element) => Pick<CSSStyleDeclaration, 'visibility' | 'opacity'> = (el) => getComputedStyle(el),
): boolean {
  for (const el of Array.from(doc.querySelectorAll(PAGE_EXCLUDES.join(',')))) {
    if (!el.getClientRects().length) continue;
    const s = styleOf(el);
    if (s.visibility === 'hidden' || Number(s.opacity) < 0.02) continue;
    return true;
  }
  return false;
}

/**
 * Resolves once the overlay the mode was opened from has left the screen,
 * or after `maxMs` whatever is still there (it is cut out of the picture
 * anyway). The first picture waits on it: drawn at once, it held the main
 * thread while the menu sheet or the form slid away, and the picture landed
 * on the form halfway down its slide, cutting it off in a frame (iPhone 17
 * Pro simulator, 12 Oct 2026).
 */
export function overlaysGone(maxMs = 600): Promise<void> {
  return new Promise((resolve) => {
    const until = performance.now() + maxMs;
    const check = () => {
      if (!overlayOnScreen() || performance.now() >= until) { resolve(); return; }
      requestAnimationFrame(check);
    };
    check();
  });
}

// ── Whether the page has changed since a picture of it was drawn ─────
//
// comment-pin.tsx draws the mode's picture ahead, while the Homeroom menu or
// the form is open (`prepareCommentView`), and uses it only if the page has
// not changed since. These decide what counts as a change.

const OVERLAY_SELECTOR = PAGE_EXCLUDES.join(',');
/** The flow's own overlays, and the drawing library's own short-lived nodes (its sandbox, a frame, an image). */
const UNSEEN_SELECTOR = `${OVERLAY_SELECTOR},[data-snapdom-internal]`;

/** Whether a node is somewhere the picture does not show: in an overlay or the library's own nodes, or not laid out at all. */
export function outOfPicture(node: Node | null): boolean {
  const el = node && (node.nodeType === 1 ? node as Element : node.parentElement);
  if (!el) return false;
  if (el.closest?.(UNSEEN_SELECTOR)) return true;
  return typeof el.getClientRects === 'function' && el.isConnected && !el.getClientRects().length;
}

/** A node the picture does not show either way: an overlay, a shell holding one, the library's own, a comment, blank text. */
export function unseenNode(n: Node): boolean {
  if (n.nodeType === 8) return true;
  if (n.nodeType === 3) return !(n.textContent || '').trim();
  if (n.nodeType !== 1) return false;
  const el = n as Element;
  return !!(el.matches?.(UNSEEN_SELECTOR) || el.querySelector?.(OVERLAY_SELECTOR));
}

/**
 * Whether a change of nodes shows in the picture. Not inside an overlay,
 * and not an overlay coming or going: on a phone the native kit lifts the
 * menu sheet out of the page into a sheet of its own as it opens, and puts
 * it back as it closes, which is just before the mode opens on the picture.
 * Text is judged apart (`textsUnchanged`).
 */
export function changesPicture(r: Pick<MutationRecord, 'type' | 'target' | 'addedNodes' | 'removedNodes'>): boolean {
  if (outOfPicture(r.target)) return false;
  if (r.type === 'childList') {
    const nodes = [...Array.from(r.addedNodes), ...Array.from(r.removedNodes)];
    if (nodes.length && nodes.every(unseenNode)) return false;
  }
  return true;
}

/**
 * Whether every text node changed since the drawing started still says what
 * it said first. The drawing library changes some text as it draws and puts
 * it back, in two changes the second of which starts from the temporary
 * text, so a change is judged by the first value against the current one.
 */
export function textsUnchanged(texts: Map<Node, string | null>): boolean {
  for (const [node, first] of texts) {
    if (node.isConnected && node.textContent !== first) return false;
  }
  return true;
}

/** Whether an element is one of the flow's own overlays the picture leaves out. */
export function isPageOverlay(el: Element): boolean {
  if (!el || typeof el.matches !== 'function') return false;
  return PAGE_EXCLUDES.some((sel) => { try { return el.matches(sel); } catch { return false; } });
}

/** What SnapDOM hands a plugin's `afterClone`: its own map between the page's nodes and their copies. */
interface CloneContext { nodeMap?: Map<unknown, unknown> | null }

const isElementNode = (n: unknown): n is HTMLElement => !!n && (n as Node).nodeType === 1;

/**
 * Every scroller in the copy of the page drawn as a plain clipped box, so
 * WebKit paints it on the first picture. Returns how many it changed.
 *
 * Home's Discover cards were missing from the first picture comment mode
 * took after the Homeroom app launched, and present in every later one
 * (iPhone 17 and 17 Pro simulators, production and local, 12 Oct 2026).
 * Both SVGs held the cards. WebKit just did not paint them the first time
 * it rasterized such an SVG in a page: the rail is a scroller
 * (`overflow-x: auto`, `-webkit-overflow-scrolling: touch`), which WebKit
 * draws as a layer of its own, and on that first rasterization the layer
 * came out empty. SnapDOM rasterizes a capture once and keeps the result,
 * so drawing the same capture again stayed empty, even seconds later; a
 * new capture drew it.
 *
 * Drawn with `overflow: hidden` the box clips exactly as before. The copy
 * keeps the scroll offset, and the pictures matched the unchanged capture
 * pixel for pixel (Settings scrolled, Home's own scroller, Messages, the
 * rail scrolled sideways). Only the copy is touched, never the page.
 *
 * `overflow: hidden` was not enough on a phone (27 Oct 2026): #general's
 * transcript was drawn over the channel's own line and up under the header
 * in a C comment's picture, while the page itself was correct. SnapDOM moves
 * a scroller's children into a translated `will-change: transform` wrapper,
 * and WebKit painted that wrapper unclipped. `clip-path: inset(0)` is a
 * geometric clip WebKit applies to every descendant, so the copy cuts off at
 * its box as the screen does. It does not make a containing block, so
 * SnapDOM's re-offset of absolute and fixed descendants is unaffected.
 */
export function flattenScrollers(ctx: CloneContext, styleOf: (el: Element) => CSSStyleDeclaration = (el) => getComputedStyle(el)): number {
  const map = ctx?.nodeMap;
  if (!map || typeof map.forEach !== 'function') return 0;
  let changed = 0;
  map.forEach((a, b) => {
    // Whichever side of the pair is in the page is the original.
    const live = isElementNode(b) && b.isConnected ? b : isElementNode(a) && a.isConnected ? a : null;
    const copy = live === b ? a : b;
    if (!live || !isElementNode(copy) || copy.isConnected || !copy.style) return;
    const s = styleOf(live);
    if (!/(auto|scroll)/.test(`${s.overflowX} ${s.overflowY}`)) return;
    copy.style.setProperty('overflow', 'hidden', 'important');
    copy.style.setProperty('-webkit-overflow-scrolling', 'auto', 'important');
    copy.style.setProperty('clip-path', 'inset(0)', 'important');
    changed++;
  });
  return changed;
}

/** The SnapDOM plugin that applies `flattenScrollers` to every capture of the page. */
export const FLAT_SCROLLERS = { name: 'homeroom-flat-scrollers', afterClone: (ctx: CloneContext) => { flattenScrollers(ctx); } };

/**
 * The page's own size and scroll for a picture. `viewport` is the size
 * comment mode keeps for the page, which the keyboard does not change (iOS
 * collapses `innerHeight` to what is above the keys). Only a document that
 * is the page's scroller (`data-browser-scroller`, a phone browser) has a
 * scroll position of its own: in the bounded shell the document never
 * scrolls, and an offset there is iOS panning a field into view, which the
 * picture should not follow.
 */
export function pageClip(viewport?: Size | null): Rect {
  const paged = document.documentElement.hasAttribute('data-browser-scroller');
  return {
    x: paged ? window.scrollX : 0,
    y: paged ? window.scrollY : 0,
    width: viewport?.width || window.innerWidth,
    height: viewport?.height || window.innerHeight,
  };
}

/**
 * The side panel's frame in this document, when it is actually on screen:
 * found by its id, addressed, laid out and visible. Null otherwise — the
 * panel closed, is only its title bar mid-transition, or was never open —
 * and the picture then goes without it, as it did before #4975.
 */
export function panelFrame(): { frame: HTMLIFrameElement; rect: Rect } | null {
  const frame = document.getElementById('side-panel-frame') as HTMLIFrameElement | null;
  if (!frame || !frame.src) return null;
  const r = frame.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  if (typeof frame.checkVisibility === 'function' && !frame.checkVisibility()) return null;
  return { frame, rect: { x: r.left, y: r.top, width: r.width, height: r.height } };
}

/**
 * The shell's own page as it is on screen, without the comment's own layer,
 * without frames, which are other documents (the app's is laid in from its
 * own picture), and without the flow's own overlays (PAGE_EXCLUDES). The
 * layer and the frames keep their places (`hide`); the overlays are cut out
 * (`filter` with `remove`), because `hide` would stand an in-flow block the
 * size of the screen in each one's place (the header comment, #4773). Its
 * scrollers are drawn as clipped boxes (`flattenScrollers`), or WebKit
 * leaves them out of the first picture. With `fresh` the capture's cache is
 * off: a first picture that lost the content under a pin is retaken on a
 * clean read of the page.
 */
async function drawShell(scale: number, host: Element, fresh = false, viewport?: Size | null): Promise<HTMLCanvasElement> {
  const snapdom = await loadLibrary();
  // `dpr: 1`: SnapDOM multiplies `scale` by the screen's pixel ratio
  // unless told otherwise, and `scale` here already is that ratio.
  const capture = await snapdom(document.body, {
    scale,
    dpr: 1,
    cache: fresh ? 'disabled' : 'soft',
    clip: pageClip(viewport),
    backgroundColor: getComputedStyle(document.body).backgroundColor || '#ffffff',
    exclude: [(el: Element) => el === host, 'iframe'],
    excludeMode: 'hide',
    filter: (el: Element) => !isPageOverlay(el),
    filterMode: 'remove',
    plugins: [FLAT_SCROLLERS],
  });
  return capture.toCanvas();
}

/**
 * A document's own page as a picture (#4975): the side panel's document
 * draws ITSELF with this, answering its runtime's `picture` (embedded.ts) —
 * drawShell cannot reach into the frame, same-origin as it is, and nothing
 * else fills it in. The same options as drawShell, run in the panel's own
 * document (its body, its scrollers, its overlays), but without the comment
 * layer's host to leave out — the panel draws no comment layer — and without
 * anything laid in; a frame shown in a panel page stays a hidden placeholder
 * exactly as in the shell. Null on any failure: the caller draws nothing
 * rather than a wrong claim about the page.
 */
export async function drawDocument(scale: number): Promise<Blob | null> {
  try {
    const snapdom = await loadLibrary();
    const capture = await snapdom(document.body, {
      scale,
      dpr: 1,
      cache: 'soft',
      clip: pageClip(),
      backgroundColor: getComputedStyle(document.body).backgroundColor || '#ffffff',
      exclude: ['iframe'],
      excludeMode: 'hide',
      filter: (el: Element) => !isPageOverlay(el),
      filterMode: 'remove',
      plugins: [FLAT_SCROLLERS],
    });
    const canvas = await capture.toCanvas();
    return await toBlob(canvas, 'image/png');
  } catch {
    return null;
  }
}

export interface Base {
  canvas: HTMLCanvasElement;
  scale: number;
  /** What the app said about the element under the pin, when it was asked. */
  app: AppPicture | null;
}

/**
 * Start drawing the page now: the shell, the running app's own picture when
 * its frame is on screen, and the side panel's own picture when the panel is
 * (#4975) — all asked at once, so the slowest of them bounds the wait once.
 * Every leg is bounded (`within`): the shell by SHELL_PICTURE_TIMEOUT_MS, the
 * app by its own timeout, the panel by the panel's three seconds — a leg that
 * misses its bound draws nothing rather than holding the mode open. Resolves
 * null when the shell itself could not be drawn; the comment then goes
 * without a picture.
 */
export function takeBase(opts: {
  host: Element;
  scale: number;
  frame: HTMLIFrameElement | null;
  frameRect: Rect | null;
  pin: Point;
  /** The page's size as comment mode keeps it (see `pageClip`); the window's when absent. */
  viewport?: Size | null;
}): Promise<Base | null> {
  const { host, scale, frame, frameRect, pin, viewport } = opts;
  const width = Math.max(1, viewport?.width || window.innerWidth);
  const target = pinTarget(pin, host);
  const panel = panelFrame();
  const panelPicture = panel
    ? requestPanelPicture(panel.frame, scale)
    : Promise.resolve<Blob | null>(null);
  const app = frame && frameRect
    ? requestAppPicture(frame, { scale, x: pin.x - frameRect.x, y: pin.y - frameRect.y })
    : Promise.resolve(null);
  const shell = within(drawShell(scale, host, false, viewport), SHELL_PICTURE_TIMEOUT_MS, null);
  return Promise.all([shell, app, panelPicture]).then(async ([canvas, picture, panelBlob]) => {
    if (!canvas) return null;
    // The scale the picture really has, read off it: everything drawn on it
    // (the app, the panel, the pin, the words) is placed in CSS pixels times
    // this.
    const actual = canvas.width / width;
    if (frameRect) await layInApp(canvas, actual, frameRect, picture);
    await layInPanel(canvas, actual, panel?.rect, panelBlob);
    const checked = await missingUnderPin(canvas, actual, target);
    if (checked) {
      // Two frames, so an island caught mid-render has settled, then one
      // clean read of the page. Whatever it shows is used: the comment's pin
      // data still names the element, so a second miss does not loop. The
      // panel's blob, asked once up top, is laid in again as it was.
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      const again = await within(drawShell(scale, host, true, viewport), SHELL_PICTURE_TIMEOUT_MS, null);
      if (again) {
        const retaken = again.width / width;
        if (frameRect) await layInApp(again, retaken, frameRect, picture);
        await layInPanel(again, retaken, panel?.rect, panelBlob);
        return { canvas: again, scale: retaken, app: picture };
      }
    }
    return { canvas, scale: actual, app: picture };
  });
}

/**
 * Whether the region the pin's element covers in the picture is one flat
 * colour while the live element has words on it (#4773): the capture kept
 * the sticky chrome and lost the content. A region that cannot be read
 * (a tainted canvas, a coordinate off the picture) counts as seen.
 */
async function missingUnderPin(canvas: HTMLCanvasElement, scale: number, target: Rect | null): Promise<boolean> {
  if (!target) return false;
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    const sx = Math.max(0, Math.floor(target.x * scale));
    const sy = Math.max(0, Math.floor(target.y * scale));
    const sw = Math.min(canvas.width - sx, Math.max(1, Math.ceil(target.width * scale)));
    const sh = Math.min(canvas.height - sy, Math.max(1, Math.ceil(target.height * scale)));
    if (sw < 1 || sh < 1) return false;
    const data = ctx.getImageData(sx, sy, sw, sh).data;
    return flatRegion(data);
  } catch {
    return false;
  }
}

async function layInApp(canvas: HTMLCanvasElement, scale: number, rect: Rect, picture: AppPicture | null): Promise<void> {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const x = rect.x * scale;
  const y = rect.y * scale;
  const w = rect.width * scale;
  const h = rect.height * scale;
  if (picture?.blob) {
    try {
      const bitmap = await createImageBitmap(picture.blob);
      ctx.drawImage(bitmap, x, y, w, h);
      bitmap.close?.();
      return;
    } catch { /* fall through to the panel */ }
  }
  ctx.fillStyle = '#e4e4e7';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#52525b';
  ctx.font = `${15 * scale}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText("The app's picture wasn't available", x + w / 2, y + h / 2);
}

/**
 * The side panel's own picture into its frame's rectangle, beside the app's.
 * No plate when it did not answer — the frame's rectangle keeps whatever the
 * shell drew there (a hidden frame holds its place with `hide`), which at
 * worst is the empty body the bug described, never a wrong claim about the
 * page. The decode is bounded like the panel's own draw: a blob that will
 * not decode draws nothing either.
 */
async function layInPanel(canvas: HTMLCanvasElement, scale: number, rect: Rect | null, blob: Blob | null): Promise<void> {
  if (!blob || !rect) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  try {
    const bitmap = await within(createImageBitmap(blob), PANEL_PICTURE_TIMEOUT_MS, null);
    if (!bitmap) return;
    ctx.drawImage(bitmap, rect.x * scale, rect.y * scale, rect.width * scale, rect.height * scale);
    bitmap.close?.();
  } catch { /* the shell's own drawing of the frame's place stays */ }
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality));
}

/**
 * Encode under the upload cap: PNG when it fits, else JPEG, else JPEG of a
 * smaller copy, until it does. Null only when even a small copy will not
 * encode.
 */
export async function encodeUnder(canvas: HTMLCanvasElement, maxBytes = MAX_UPLOAD_BYTES): Promise<Blob | null> {
  const png = await toBlob(canvas, 'image/png');
  if (png && png.size <= maxBytes) return png;
  let current = canvas;
  for (let i = 0; i < 5; i++) {
    const jpeg = await toBlob(current, 'image/jpeg', 0.85);
    if (jpeg && jpeg.size <= maxBytes) return jpeg;
    const smaller = document.createElement('canvas');
    smaller.width = Math.max(1, Math.round(current.width * 0.75));
    smaller.height = Math.max(1, Math.round(current.height * 0.75));
    smaller.getContext('2d')?.drawImage(current, 0, 0, smaller.width, smaller.height);
    current = smaller;
  }
  return null;
}

/** A small copy for the box's preview, as a data URL. */
export function thumbnail(canvas: HTMLCanvasElement, width = 120): string {
  const t = document.createElement('canvas');
  t.width = width;
  t.height = Math.max(1, Math.round(canvas.height * (width / canvas.width)));
  t.getContext('2d')?.drawImage(canvas, 0, 0, t.width, t.height);
  return t.toDataURL('image/png');
}
