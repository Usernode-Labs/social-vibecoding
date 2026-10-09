/**
 * The screenshot a C comment carries (#4289 follow-up): the page as the
 * person sees it, with the pin and the comment drawn where they put them.
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
 * ── Two halves ─────────────────────────────────────────────────────────
 *
 * The page is drawn the moment the comment opens (`takeBase`), so it shows
 * the page as it was, and is ready by the time the words are. What is SENT
 * (#4482) is that clean base, with the pin's spot saved beside it as
 * fractions of the picture (`pinFraction`) — the request view draws the
 * pin and the bubble over it. `finishPicture`, which paints them into a
 * copy, is now only for the handover to "Suggest an improvement": that
 * dialog has no way to save a pin, so its picture keeps the comment.
 * The layout helpers are pure and exported for tests.
 */

export const LIB_SRC = '/usernode-bridge/v1/snapdom.js';
/** The feedback endpoint's cap (src/routes/feedback.js MAX_SCREENSHOT_BYTES). */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const SNAPSHOT_KEY = '__usernode_snapshot';
/** How long the app gets to draw itself, the library's first load included. */
export const APP_PICTURE_TIMEOUT_MS = 8000;
/** The pin's fill: the shell's accent, violet-600 as tailwind.config.js remaps it. */
export const PIN_FILL = '#0a6ee0';
/**
 * How many characters of the comment go with the screenshot (#4482): the
 * bubble shows at most six lines, and the cap keeps the upload URL well
 * under Node's 16 KB header limit even for multi-byte text.
 */
export const PIN_COMMENT_MAX = 500;

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
 * `margin` inside it. The comment box on screen and the bubble drawn into
 * the picture use the same rule, so the picture shows what was on screen.
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

/**
 * The comment, broken into lines no wider than `maxWidth` as `measure`
 * reports widths, at most `maxLines`; the last one ends in an ellipsis when
 * the words run past it. A word longer than a line is broken mid-word.
 */
export function wrapLines(text: string, maxWidth: number, measure: (s: string) => number, maxLines = 6): string[] {
  const out: string[] = [];
  let truncated = false;
  const push = (line: string) => {
    if (out.length < maxLines) out.push(line);
    else truncated = true;
  };
  for (const para of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    let line = '';
    for (const raw of para.split(/\s+/).filter(Boolean)) {
      if (truncated) break;
      let word = raw;
      // A word wider than a line is broken into pieces that fit.
      while (measure(word) > maxWidth && word.length > 1) {
        let cut = word.length - 1;
        while (cut > 1 && measure(word.slice(0, cut)) > maxWidth) cut--;
        if (line) { push(line); line = ''; }
        push(word.slice(0, cut));
        word = word.slice(cut);
      }
      const next = line ? `${line} ${word}` : word;
      if (measure(next) <= maxWidth) {
        line = next;
      } else {
        push(line);
        line = word;
      }
    }
    push(line);
    if (truncated) break;
  }
  if (truncated && out.length) {
    let last = out[out.length - 1];
    while (last && measure(`${last}\u2026`) > maxWidth) last = last.slice(0, -1);
    out[out.length - 1] = `${last.trimEnd()}\u2026`;
  }
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
 * Where the pin sits as a fraction of the picture (#4482): how far across
 * and down it was, 0..1 both ways, clamped. The base canvas is `scale`
 * device pixels to the CSS pixel, and the pin is in CSS pixels, so it is
 * the CSS position times the scale over the canvas's own side. Stored like
 * this, a JPEG fallback or a smaller encode never moves the pin.
 */
export function pinFraction(
  base: { canvas: { width: number; height: number }; scale: number },
  pin: Point,
): Point {
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  return {
    x: clamp((pin.x * base.scale) / Math.max(1, base.canvas.width)),
    y: clamp((pin.y * base.scale) / Math.max(1, base.canvas.height)),
  };
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

/** The bubble drawn into the picture: the comment box's width and type. */
export const BUBBLE = { width: 280, padding: 10, font: 14, line: 19, radius: 12, maxLines: 6 };

/**
 * A copy of the page with the pin and the words drawn on it, where they
 * were on screen.
 */
export function finishPicture(base: Base, pin: Point, comment: string): HTMLCanvasElement {
  const { canvas: src, scale } = base;
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height;
  const ctx = out.getContext('2d');
  if (!ctx) return src;
  ctx.drawImage(src, 0, 0);
  const viewport = { width: src.width / scale, height: src.height / scale };

  ctx.save();
  ctx.scale(scale, scale);
  const font = `${BUBBLE.font}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.font = font;
  const inner = BUBBLE.width - BUBBLE.padding * 2;
  const lines = wrapLines(comment, inner, (s) => ctx.measureText(s).width, BUBBLE.maxLines);
  const size = { width: BUBBLE.width, height: BUBBLE.padding * 2 + Math.max(1, lines.length) * BUBBLE.line };
  const at = placeBeside(pin, size, viewport);

  // The bubble: white card, hairline, soft shadow.
  ctx.shadowColor = 'rgba(0,0,0,0.18)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 3;
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, at.x, at.y, size.width, size.height, BUBBLE.radius);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = 'rgba(0,0,0,0.12)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = '#18181b';
  ctx.textBaseline = 'top';
  lines.forEach((line, i) => {
    ctx.fillText(line, at.x + BUBBLE.padding, at.y + BUBBLE.padding + i * BUBBLE.line + 2);
  });

  // The pin: an accent dot in a white ring.
  ctx.shadowColor = 'rgba(0,0,0,0.3)';
  ctx.shadowBlur = 6;
  ctx.beginPath();
  ctx.arc(pin.x, pin.y, 11, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.beginPath();
  ctx.arc(pin.x, pin.y, 8, 0, Math.PI * 2);
  ctx.fillStyle = PIN_FILL;
  ctx.fill();
  ctx.restore();
  return out;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
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
