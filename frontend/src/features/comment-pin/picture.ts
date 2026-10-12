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
 * ── When ───────────────────────────────────────────────────────────────
 *
 * The page is drawn the moment a pin goes down (`takeBase`), so it shows the
 * page as it was, and is ready by the time the words are. In comment mode
 * every pin is drawn on its own, and the mode's layer never is. The layout
 * helpers are pure and exported for tests.
 *
 * A picture can also come out with part of the page missing: the sticky and
 * fixed parts (the header, the rail, the section column, the place bar)
 * survive, and the in-flow content under them does not (#4773). SnapDOM
 * lifts the sticky parts out of the page on their own path; against the
 * built shell the loss did not reproduce, scrolled or not, so the cause is
 * read as timing, a reused capture cache or a draw taken while an island was
 * re-rendering. `takeBase` therefore reads the element under the pin before
 * it draws, and when that element's rectangle in the picture is one flat
 * colour while the live element has words, it takes one more picture two
 * animation frames later with the cache off, and uses that whatever it
 * shows. One retake, and only for a pin on something with words: a page
 * that really draws flat never loops, and a pin on the running app's frame
 * or on empty background never asks for one.
 */

export const LIB_SRC = '/usernode-bridge/v1/snapdom.js';
/** The feedback endpoint's cap (src/routes/feedback.js MAX_SCREENSHOT_BYTES). */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const SNAPSHOT_KEY = '__usernode_snapshot';
/** How long the app gets to draw itself, the library's first load included. */
export const APP_PICTURE_TIMEOUT_MS = 8000;

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
 * and not a kit shell, so it is named by id; a menu that is already closed
 * with the hide mode on costs nothing.
 */
export const PAGE_EXCLUDES = [
  '#feedback-modal',
  '#apps-switcher-sheet',
  '#apps-switcher-overlay',
  '.un-modal',
  '.un-sheet',
  '.un-panel',
  '.un-action-sheet',
  '.un-backdrop',
] as const;

/**
 * The shell's own page as it is on screen, without the comment's own layer,
 * without frames, which are other documents (the app's is laid in from its
 * own picture), and without the flow's own overlays (PAGE_EXCLUDES). With
 * `fresh` the capture's cache is off: a first picture that lost the content
 * under a pin is retaken on a clean read of the page (the header comment).
 */
async function drawShell(scale: number, host: Element, fresh = false): Promise<HTMLCanvasElement> {
  const snapdom = await loadLibrary();
  // `dpr: 1`: SnapDOM multiplies `scale` by the screen's pixel ratio
  // unless told otherwise, and `scale` here already is that ratio.
  const capture = await snapdom(document.body, {
    scale,
    dpr: 1,
    cache: fresh ? 'disabled' : 'soft',
    clip: { x: window.scrollX, y: window.scrollY, width: window.innerWidth, height: window.innerHeight },
    backgroundColor: getComputedStyle(document.body).backgroundColor || '#ffffff',
    exclude: [(el: Element) => el === host, 'iframe', ...PAGE_EXCLUDES],
    excludeMode: 'hide',
  });
  return capture.toCanvas();
}

export interface Base {
  canvas: HTMLCanvasElement;
  scale: number;
  /** What the app said about the element under the pin, when it was asked. */
  app: AppPicture | null;
}

/**
 * Start drawing the page now: the shell, and the running app's own picture
 * when its frame is on screen. Resolves null when the shell itself could not
 * be drawn; the comment then goes without a picture.
 */
export function takeBase(opts: {
  host: Element;
  scale: number;
  frame: HTMLIFrameElement | null;
  frameRect: Rect | null;
  pin: Point;
}): Promise<Base | null> {
  const { host, scale, frame, frameRect, pin } = opts;
  const target = pinTarget(pin, host);
  const app = frame && frameRect
    ? requestAppPicture(frame, { scale, x: pin.x - frameRect.x, y: pin.y - frameRect.y })
    : Promise.resolve(null);
  const shell = drawShell(scale, host).catch(() => null);
  return Promise.all([shell, app]).then(async ([canvas, picture]) => {
    if (!canvas) return null;
    // The scale the picture really has, read off it: everything drawn on it
    // (the app, the pin, the words) is placed in CSS pixels times this.
    const actual = canvas.width / Math.max(1, window.innerWidth);
    if (frameRect) await layInApp(canvas, actual, frameRect, picture);
    const checked = await missingUnderPin(canvas, actual, target);
    if (checked) {
      // Two frames, so an island caught mid-render has settled, then one
      // clean read of the page. Whatever it shows is used: the comment's pin
      // data still names the element, so a second miss does not loop.
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      const again = await drawShell(scale, host, true).catch(() => null);
      if (again) {
        const retaken = again.width / Math.max(1, window.innerWidth);
        if (frameRect) await layInApp(again, retaken, frameRect, picture);
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
