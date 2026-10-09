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
 * centred.
 */
export function insetFrame(viewport: Size, margin: number): { x: number; y: number; scale: number } {
  const w = Math.max(1, viewport.width);
  const h = Math.max(1, viewport.height);
  const scale = Math.min((w - 2 * margin) / w, (h - 2 * margin) / h);
  return { x: (w - w * scale) / 2, y: (h - h * scale) / 2, scale: Math.max(0, scale) };
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

/**
 * The shell's own page as it is on screen, without the comment's own layer
 * and without frames, which are other documents (the app's is laid in from
 * its own picture).
 */
async function drawShell(scale: number, host: Element): Promise<HTMLCanvasElement> {
  const snapdom = await loadLibrary();
  // `dpr: 1`: SnapDOM multiplies `scale` by the screen's pixel ratio
  // unless told otherwise, and `scale` here already is that ratio.
  const capture = await snapdom(document.body, {
    scale,
    dpr: 1,
    clip: { x: window.scrollX, y: window.scrollY, width: window.innerWidth, height: window.innerHeight },
    backgroundColor: getComputedStyle(document.body).backgroundColor || '#ffffff',
    exclude: [(el: Element) => el === host, 'iframe'],
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
    return { canvas, scale: actual, app: picture };
  });
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
