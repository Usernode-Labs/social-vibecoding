/**
 * Comment mode (#4289 and its follow-ups). Experimental, behind Settings,
 * Experimental's switch: C turns it on (../improve/suggest-shortcut.ts
 * decides when C counts), and so does "Suggest an improvement" when comment
 * mode is the way this device suggested last, or its form's Comment switch.
 *
 * ── What it looks like ────────────────────────────────────────────────
 *
 * A layer over the whole page with a comment cursor, and a bar: "Comment
 * mode", what to do next, how many are posted, the Form / Comment switch,
 * and Done. A click anywhere puts a pin there with a box beside it; Enter
 * posts the box as its own request and the pin stays, a marker the person
 * can open again, so they can go on to the next thing. "Add a comment" in
 * the box makes the next click the same request's next comment instead:
 * one request, its comments numbered, each with its own pin. A click
 * elsewhere moves the open comment's pin (the words stay). Esc closes what
 * is on top: an open marker, the wait for the next pin, the request (asking
 * first when it has words), then the mode. The page under the layer still
 * scrolls, with the wheel or a finger, and the pins move with what they
 * were put on; a tap is a comment, as a click is.
 *
 * Over the inset picture the bar is that view's header: the picture leaves
 * a band for it at the top and it sits there, the picture's own width, so
 * nothing floats over the page. When the picture could not be taken, the
 * bar sits at the foot each time comment mode opens, until the person drags
 * its handle somewhere else (only for this visit). The first time comment
 * mode opens on a device, a short note says how it works, and that the Form
 * switch goes back to the form.
 *
 * ── The box ───────────────────────────────────────────────────────────
 *
 * The comments' words; the title the request will be posted with,
 * suggested from all of them as they are typed (the dialog's own POST
 * /api/feedback/title, with its rules: a pause, a dozen characters, a few
 * asks per request) and changed with a click; the page's screenshots,
 * removable, and the person's own images (the paperclip, a paste or a drop:
 * the server's three in all); Kudos for whoever solves it, the dialog's
 * bounty (#964); and where it goes. Its expand button hands it all to the
 * form instead.
 *
 * ── Where it goes ─────────────────────────────────────────────────────
 *
 * By default where the pin is: on the running app's frame, that app; on
 * Homeroom's own screens, Homeroom. The box shows both when the app can
 * take a request (the dialog's own rule: an open app with a GitHub repo
 * that is not the platform itself), so the person can switch.
 *
 * ── The screenshot ────────────────────────────────────────────────────
 *
 * Drawn the moment a pin goes down (./picture.ts), previewed in the box with
 * the pins over it, and posted CLEAN: the pins are sent beside it as data
 * (#4482, ./pin-data.ts), and the request's page draws them over the
 * picture where they can be hidden. A comment pinned on the same view as an
 * earlier one (nothing scrolled since) shares its picture; another view is
 * another picture, while there is room. The markers are this layer's, and
 * the layer is never in a picture.
 *
 * Mounted on demand through the shell's portal registry
 * (lib/legacy-portals.tsx) into a host appended to <body>; nothing of it is
 * in the prerendered shell.
 */

import {
  createElement, useCallback, useEffect, useLayoutEffect, useRef, useState,
  type ClipboardEvent, type DragEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode,
  type WheelEvent,
} from 'react';

import { Button } from '@/components/ui/button';
import {
  ArrowsPointingOutIcon, ChatIcon, DescriptionIcon, DraftEditIcon, ArrowsMoveIcon, PaperclipIcon, PlusIcon,
  SparklesIcon, XIcon,
} from '@/components/ui/icons';

import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
import { PHONE_QUERY } from '../../lib/keyboard-open';
import { useKeyboardSurface } from '../../lib/keyboard-surface';
import { PLANE_FILL } from '@/components/ui/grouped-list';
import { platformSlug } from '../messages/channel-hub';
import {
  closeUpView, describeElement, encodeUnder, inRect, insetFrame, pictureScale, placeBeside,
  takeBase, thumbnail, toPage, toScreen,
  type Base, type ElementInfo, type Point, type Rect,
} from './picture';
import { CloseUp } from './close-up';
import {
  MAX_COMMENTS, MAX_PICTURES, handOver, numberFromUrl, numberedWords, postComment, whereLines,
  type CommentPost, type CommentShot, type Spot, type Target,
} from './post';

export const HOST_ID = 'comment-pin-host';
const BOX_WIDTH = 360;
/** Room kept clear at the foot for the bar. */
const BAR_SPACE = 76;
/** How far the inset picture keeps from the screen's edges. */
const INSET_MARGIN = 24;
const INSET_MARGIN_PHONE = 12;
/** The band kept clear above the picture for the mode's header (the bar). */
const HEADER_BAND = 60;
/** Whether this screen is a phone: the same narrow-touch test the shell's
 *  keyboard handling uses. A narrow desktop window keeps the desktop flow. */
function isPhone(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try { return !!window.matchMedia(PHONE_QUERY).matches; } catch { return false; }
}

/** The page shown as a picture of itself while the mode is up (#4554). */
interface ViewShot {
  url: string;
  /** The view it shows: the value `view.current` had when it was drawn. */
  view: number;
  state: 'drawing' | 'ready' | 'failed';
}

/** The dialog's title rules (feedback-controller.js #556, #732, #4194). */
const TITLE_DEBOUNCE_MS = 900;
const TITLE_MIN = 12;
const TITLE_MAX_PER_BOX = 8;
const TITLE_SOURCE_MAX = 2000;

/** The images the server takes (validateScreenshotUpload). */
const IMAGE_TYPES = ['image/png', 'image/jpeg'];

/** The comment cursor: the pin's own shape with a plus, its point at the tip. */
const CURSOR = 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'30\' height=\'30\' viewBox=\'0 0 30 30\'%3E%3Cpath d=\'M3 27V15a12 12 0 1 1 12 12z\' fill=\'%230a6ee0\' stroke=\'white\' stroke-width=\'2\'/%3E%3Cpath d=\'M15 10.5v9M10.5 15h9\' stroke=\'white\' stroke-width=\'2.2\' stroke-linecap=\'round\'/%3E%3C/svg%3E") 3 27, crosshair';

/** A pin's shape: round, but for the corner that sits on the point. */
const PIN_SHAPE = 'rounded-[50%_50%_50%_0]';

interface AppTarget { slug: string; name: string }

/**
 * The running app, when a request can go to it: the feedback dialog's rule
 * (../dialogs/feedback-controller.js, `canTargetApp`), read the same way.
 */
function appTarget(): AppTarget | null {
  const w = window as unknown as {
    App?: { currentApp?: string | null; currentTab?: string };
    AppView?: { appData?: { repo_url?: string; self_hosted?: boolean; name?: string } | null };
  };
  const slug = w.App?.currentApp;
  const data = w.AppView?.appData;
  if (!slug || !data) return null;
  if (w.App?.currentTab !== 'app' && w.App?.currentTab !== 'dev') return null;
  if (!/github\.com\/[^/]+\/[^/]+/.test(data.repo_url || '') || data.self_hosted) return null;
  return { slug, name: data.name || slug };
}

/** The running app's frame, when it is on screen. */
function visibleAppFrame(): { frame: HTMLIFrameElement; rect: Rect } | null {
  const frame = document.getElementById('app-iframe') as HTMLIFrameElement | null;
  if (!frame || !frame.src) return null;
  const r = frame.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  if (typeof frame.checkVisibility === 'function' && !frame.checkVisibility()) return null;
  return { frame, rect: { x: r.left, y: r.top, width: r.width, height: r.height } };
}

/** The page's own element under a point, looking through this layer. */
function underPoint(p: Point, host: HTMLElement): Element | null {
  const all = typeof document.elementsFromPoint === 'function' ? document.elementsFromPoint(p.x, p.y) : [];
  for (const el of all) {
    if (!host.contains(el)) return el === document.documentElement || el === document.body ? null : el;
  }
  return null;
}

/**
 * Where a pin is kept: on the element it was put on, at the same offset, so
 * it moves with that element when the page scrolls. `at` is where it was.
 */
interface Anchor { el: Element | null; dx: number; dy: number; at: Point }

function anchorAt(p: Point, host: HTMLElement): Anchor {
  const el = underPoint(p, host);
  if (!el) return { el: null, dx: 0, dy: 0, at: p };
  const r = el.getBoundingClientRect();
  return { el, dx: p.x - r.left, dy: p.y - r.top, at: p };
}

/** Where an anchored pin is now; null when it is off screen or its element has gone. */
function anchorPoint(a: Anchor): Point | null {
  if (!a.el) return a.at;
  if (!a.el.isConnected) return null;
  const r = a.el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  const p = { x: r.left + a.dx, y: r.top + a.dy };
  if (p.x < 0 || p.y < 0 || p.x > window.innerWidth || p.y > window.innerHeight) return null;
  return p;
}

/** What the wheel scrolls under a point: the nearest scroller, else the page. */
function scrollerAt(p: Point, host: HTMLElement): Element | null {
  for (let el = underPoint(p, host); el && el !== document.body; el = el.parentElement) {
    if (el.tagName === 'IFRAME') return null;
    const s = getComputedStyle(el);
    const scrolls = /(auto|scroll|overlay)/.test(`${s.overflowY} ${s.overflowX}`);
    if (scrolls && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)) return el;
  }
  return document.scrollingElement;
}

function clampToViewport(p: Point): Point {
  return {
    x: Math.max(0, Math.min(window.innerWidth - 1, p.x)),
    y: Math.max(0, Math.min(window.innerHeight - 1, p.y)),
  };
}

function toast(line: string): void {
  (window as unknown as { PlatformUI?: { toast?: (m: string) => void } }).PlatformUI?.toast?.(line);
}

interface Budget { remaining: number | null; limit: number | null }

/** The weekly kudos the header's meter already holds (Kudos.Budget). */
function kudosBudget(): Budget {
  const state = (window as unknown as { Kudos?: { Budget?: { state?: { remaining?: number; limit?: number } | null } } })
    .Kudos?.Budget?.state;
  return {
    remaining: typeof state?.remaining === 'number' ? state.remaining : null,
    limit: typeof state?.limit === 'number' ? state.limit : null,
  };
}

function refreshKudosBudget(): Promise<unknown> {
  try {
    const k = (window as unknown as { Kudos?: { Budget?: { refresh?: () => unknown } } }).Kudos;
    return Promise.resolve(k?.Budget?.refresh?.()).catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
}

/** What the form hands over when the person switches to comment mode. */
export interface CommentCarry {
  text?: string;
  title?: string;
  images?: Blob[];
  bounty?: boolean;
  target?: Target | null;
}

export interface OpenOptions {
  /** How it was opened: the key, "Suggest an improvement", or the form's switch. */
  via?: 'key' | 'suggest' | 'switch';
  /** The form's draft, which the first comment takes. */
  carry?: CommentCarry | null;
}

interface Picture {
  key: number;
  /** Drawn, null when it could not be, undefined while drawing. */
  base: Base | null | undefined;
  promise: Promise<Base | null>;
  thumb: string;
  /** The view it shows: how many times the page had scrolled, and its route, when it was drawn. */
  view: number;
  screen: string;
  /** The comment whose point the running app was asked about (its `at`), if that is still where it is. */
  askedFor: number | null;
}

interface Comment {
  key: number;
  anchor: Anchor;
  inApp: boolean;
  /** The route the page was on, for the where line. */
  screen: string;
  /** The picture its pin is on, when it has one. */
  picture: number | null;
  /** Where its pin is on that picture, as fractions of its width and height. */
  pin: Point;
  text: string;
}

interface Image { blob: Blob; url: string; name: string }

type TitleState = 'none' | 'auto' | 'mine';

/** A request being written: one comment, or several, each with its own pin. */
interface Draft {
  key: number;
  comments: Comment[];
  /** The comment being written; null while the next one waits for its click. */
  active: number | null;
  pictures: Picture[];
  keepShot: boolean;
  title: string;
  titleState: TitleState;
  /** The words the suggested title was named from. */
  titleFor: string;
  titleAsks: number;
  editingTitle: boolean;
  images: Image[];
  kudos: boolean;
  chosen: Target | null;
  sending: boolean;
  error: string;
}

interface Posted {
  key: number;
  title: string;
  words: string;
  place: string;
  href: string | null;
  pictures: number;
  comments: number;
  kudos: boolean;
}

/** A posted comment's marker: its request, its number there when it has several. */
interface PostedPin { key: number; request: number; n: number | null; anchor: Anchor }

interface Session {
  host: HTMLElement;
  app: AppTarget | null;
  carry: CommentCarry | null;
}

const liveComments = (d: Draft) => d.comments.filter((c) => c.text.trim());
const draftWords = (d: Draft) => liveComments(d).map((c) => c.text.trim()).join('\n');
const hasWords = (d: Draft | null) => !!d && d.comments.some((c) => c.text.trim());
const activeComment = (d: Draft | null) => (d && d.active != null ? d.comments.find((c) => c.key === d.active) || null : null);
/** The pictures the request's comments are on, in order; none once the screenshot is removed. */
const usedPictures = (d: Draft) => (d.keepShot
  ? d.pictures.filter((p) => p.base !== null && d.comments.some((c) => c.picture === p.key)) : []);
const pictureCount = (d: Draft) => usedPictures(d).length + d.images.length;
const prune = (pictures: Picture[], comments: Comment[]) => pictures.filter((p) => comments.some((c) => c.picture === p.key));
const routeOf = () => (location.hash || '#home').split('?')[0].slice(0, 120);

/** The title a post carries: the person's, or a suggestion named from these very words (#732). */
function titleToSend(d: Draft): string {
  if (d.titleState === 'mine') return d.title.trim();
  if (d.titleState === 'auto' && d.titleFor === draftWords(d)) return d.title.trim();
  return '';
}

/** Whether comment mode's how-it-works note was shown on this device (#4541). */
const INTRO_KEY = 'usernode:comment-intro-seen';

function introSeen(): boolean {
  try {
    return window.localStorage.getItem(INTRO_KEY) != null;
  } catch {
    return false;
  }
}

function markIntroSeen(): void {
  try {
    window.localStorage.setItem(INTRO_KEY, '1');
  } catch { /* private mode: the note shows again next time */ }
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

function CommentMode({ session, onClose }: { session: Session; onClose: () => void }): ReactNode {
  const { host, app } = session;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [posted, setPosted] = useState<Posted[]>([]);
  const [postedPins, setPostedPins] = useState<PostedPin[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<'exit' | 'discard' | null>(null);
  const [carry, setCarry] = useState<CommentCarry | null>(session.carry);
  const [titleLoading, setTitleLoading] = useState(false);
  const [hover, setHover] = useState<Rect | null>(null);
  const [tick, setTick] = useState(0);
  const [viewShot, setViewShot] = useState<ViewShot | null>(null);
  const [budget, setBudget] = useState<Budget>(kudosBudget);
  const [boxAt, setBoxAt] = useState<Point>({ x: -9999, y: -9999 });
  const [cardAt, setCardAt] = useState<Point>({ x: -9999, y: -9999 });
  const [barAt, setBarAt] = useState<Point | null>(null);
  const [barSize, setBarSize] = useState({ width: 0, height: 0 });
  const boxRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const keys = useRef(0);
  const hoverFrame = useRef(0);
  const view = useRef(0);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const touch = useRef<{ id: number; start: Point; last: Point; moved: boolean; scroller: Element | null } | null>(null);
  const viewShotKeys = useRef(0);
  const viewShotUrl = useRef<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [intro, setIntro] = useState(() => !introSeen());
  // The phone's sheet rides the keyboard: its fields reveal inside it, and
  // it moves with the keys the way the shell's own bottom sheets do.
  useKeyboardSurface(boxRef, { ride: true });

  const update = useCallback((key: number, patch: Partial<Draft> | ((d: Draft) => Partial<Draft>)) => {
    setDraft((d) => (d && d.key === key ? { ...d, ...(typeof patch === 'function' ? patch(d) : patch) } : d));
  }, []);

  // The bar has the keyboard from the start, so Esc and C reach the shell
  // even when the app's frame had it.
  useEffect(() => { barRef.current?.focus({ preventScroll: true }); }, []);
  // The note counts as seen as soon as it appears (#4541).
  useEffect(() => { if (intro) markIntroSeen(); }, []);
  useEffect(() => { void refreshKudosBudget().then(() => setBudget(kudosBudget())); }, []);

  // The pins move with the page: any scroll, or a new window size, redraws,
  // and is a new view (a picture of the old one no longer shows it).
  useEffect(() => {
    let frame = 0;
    const redraw = () => {
      view.current += 1;
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; setTick((t) => t + 1); });
    };
    document.addEventListener('scroll', redraw, true);
    window.addEventListener('resize', redraw);
    return () => {
      document.removeEventListener('scroll', redraw, true);
      window.removeEventListener('resize', redraw);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  // ── The view picture ────────────────────────────────────────────────
  //
  // The page as a picture, shown inset so nothing reads as clickable. Taken
  // when the mode opens, and 250ms after the last scroll or resize (the
  // redraw above bumps `view` and re-renders for the pins; this redraws the
  // picture). Until a retake lands the last one shows faded and taps wait.
  // When the picture cannot be taken, the mode renders as it always did,
  // over the live page, so a comment can always be left.
  const takeViewShot = useCallback(() => {
    const shown = visibleAppFrame();
    const key = ++viewShotKeys.current;
    const at = view.current;
    setViewShot((s) => ({ url: s?.url || '', view: at, state: 'drawing' }));
    takeBase({
      host,
      scale: pictureScale(window.devicePixelRatio, { width: window.innerWidth, height: window.innerHeight }),
      frame: shown?.frame ?? null,
      frameRect: shown?.rect ?? null,
      pin: { x: window.innerWidth / 2, y: window.innerHeight / 2 },
    }).then((b) => {
      const fail = () => setViewShot((s) => ({ url: s?.url || '', view: at, state: 'failed' }));
      if (key !== viewShotKeys.current) return;
      if (!b) { fail(); return; }
      b.canvas.toBlob((blob) => {
        if (key !== viewShotKeys.current) return;
        if (!blob) { fail(); return; }
        const url = URL.createObjectURL(blob);
        if (viewShotUrl.current) URL.revokeObjectURL(viewShotUrl.current);
        viewShotUrl.current = url;
        setViewShot({ url, view: at, state: 'ready' });
      }, 'image/png');
    }, () => {
      if (key === viewShotKeys.current) {
        setViewShot((s) => ({ url: s?.url || '', view: at, state: 'failed' }));
      }
    });
  }, [host]);

  useEffect(() => {
    if (tick === 0) {
      takeViewShot();
      return undefined;
    }
    const timer = setTimeout(takeViewShot, 250);
    return () => clearTimeout(timer);
  }, [tick, takeViewShot]);

  useEffect(() => () => {
    if (viewShotUrl.current) URL.revokeObjectURL(viewShotUrl.current);
  }, []);

  // Whether the page is shown as the inset picture, and where it sits. The
  // picture leaves a band at the top for the mode's header, so the bar is
  // part of the view instead of floating over the page. A failed picture
  // keeps the mode over the live page, untransformed, bar at the foot.
  const phone = isPhone();
  const inset = viewShot && viewShot.state !== 'failed'
    ? insetFrame({ width: window.innerWidth, height: window.innerHeight }, phone ? INSET_MARGIN_PHONE : INSET_MARGIN, HEADER_BAND)
    : null;

  // Images the person added are object URLs until the mode closes.
  const urls = useRef(new Set<string>());
  useEffect(() => () => { urls.current.forEach((u) => URL.revokeObjectURL(u)); }, []);

  /** Start drawing the page with a pin at `p`; the box shows it when it lands. */
  const drawPicture = useCallback((draftKey: number, p: Point, askedFor: number): Picture => {
    const shown = visibleAppFrame();
    const key = ++keys.current;
    const promise = takeBase({
      host,
      scale: pictureScale(window.devicePixelRatio, { width: window.innerWidth, height: window.innerHeight }),
      frame: shown?.frame ?? null,
      frameRect: shown?.rect ?? null,
      pin: p,
    });
    const land = (base: Base | null, thumb: string) => setDraft((d) => (d && d.key === draftKey
      ? { ...d, pictures: d.pictures.map((pic) => (pic.key === key && pic.promise === promise ? { ...pic, base, thumb } : pic)) }
      : d));
    promise.then((b) => {
      let thumb = '';
      if (b) {
        try { thumb = thumbnail(b.canvas, 160); } catch { /* no preview, still attached */ }
      }
      land(b, thumb);
    }, () => land(null, ''));
    return { key, base: undefined, promise, thumb: '', view: view.current, screen: routeOf(), askedFor };
  }, [host]);

  /**
   * The picture a pin at `p` goes on: one already drawn of this same view
   * (nothing has scrolled or moved since), else a new one while there is
   * room for it beside the others and the person's own images.
   */
  const pictureFor = useCallback((d: Draft, p: Point, commentKey: number): { pictures: Picture[]; picture: number | null } => {
    const same = d.pictures.find((pic) => pic.view === view.current && pic.screen === routeOf() && pic.base !== null);
    if (same) return { pictures: d.pictures, picture: same.key };
    const others = d.comments.filter((c) => c.key !== commentKey);
    const inUse = d.pictures.filter((pic) => others.some((c) => c.picture === pic.key)).length;
    if (inUse + d.images.length >= MAX_PICTURES) return { pictures: d.pictures, picture: null };
    const pic = drawPicture(d.key, p, commentKey);
    return { pictures: [...d.pictures, pic], picture: pic.key };
  }, [drawPicture]);

  /**
   * A press on the page: the open comment's pin moved there, the request's
   * next comment there (after "Add a comment"), or a new request there.
   */
  const place = useCallback((at: Point) => {
    if (open != null) { setOpen(null); return; }
    // Over the inset picture the press is on the picture, not the page: back
    // to page coordinates, and nothing where the picture is not.
    let where = at;
    if (inset) {
      if (viewShot?.state === 'drawing') return;
      const page = toPage(at, inset);
      if (page.x < -1 || page.y < -1 || page.x > window.innerWidth || page.y > window.innerHeight) return;
      where = page;
    }
    const p = clampToViewport(where);
    const anchor = anchorAt(p, host);
    const inApp = inRect(p, visibleAppFrame()?.rect);
    const screen = routeOf();
    const pin = { x: p.x / Math.max(1, window.innerWidth), y: p.y / Math.max(1, window.innerHeight) };
    setConfirm(null);
    setIntro(false);
    if (draft) {
      if (draft.sending) return;
      const current = activeComment(draft);
      if (current) {
        // A click elsewhere moves the open comment's pin; its words stay.
        const got = pictureFor(draft, p, current.key);
        const comments = draft.comments.map((c) => (c.key === current.key
          ? { ...c, anchor, inApp, screen, picture: got.picture, pin } : c));
        const pictures = prune(got.pictures, comments).map((pic) => (pic.key === got.picture && pic.askedFor === current.key && pic.key === current.picture
          ? { ...pic, askedFor: null } : pic));
        setDraft({ ...draft, comments, pictures, error: '' });
        textRef.current?.focus();
        return;
      }
      if (draft.comments.length >= MAX_COMMENTS) return;
      const key = ++keys.current;
      const got = pictureFor(draft, p, key);
      setDraft({
        ...draft,
        pictures: got.pictures,
        comments: [...draft.comments, { key, anchor, inApp, screen, picture: got.picture, pin, text: '' }],
        active: key,
        error: '',
      });
      return;
    }
    const c = carry;
    setCarry(null);
    const images: Image[] = (c?.images || []).filter((b) => IMAGE_TYPES.includes(b.type)).slice(0, MAX_PICTURES - 1)
      .map((blob, i) => {
        const url = URL.createObjectURL(blob);
        urls.current.add(url);
        return { blob, url, name: `Image ${i + 1}` };
      });
    const empty: Draft = {
      key: ++keys.current,
      comments: [],
      active: null,
      pictures: [],
      keepShot: true,
      title: c?.title || '',
      titleState: c?.title ? 'mine' : 'none',
      titleFor: '',
      titleAsks: 0,
      editingTitle: false,
      images,
      kudos: !!c?.bounty,
      chosen: c?.target ?? null,
      sending: false,
      error: '',
    };
    const key = ++keys.current;
    const got = pictureFor(empty, p, key);
    setDraft({
      ...empty,
      pictures: got.pictures,
      comments: [{ key, anchor, inApp, screen, picture: got.picture, pin, text: c?.text || '' }],
      active: key,
    });
  }, [open, host, draft, carry, pictureFor, inset, viewShot]);

  // The open comment's words have the keyboard whenever a comment opens.
  const draftKey = draft?.key;
  const activeKey = draft?.active ?? null;
  useEffect(() => {
    const t = textRef.current;
    if (!t) return;
    t.focus();
    t.setSelectionRange(t.value.length, t.value.length);
  }, [draftKey, activeKey]);

  // #556: the title, suggested from all the request's words after a pause.
  const words = draft ? draftWords(draft) : '';
  const titleMine = draft?.titleState === 'mine';
  const editingTitle = !!draft?.editingTitle;
  useEffect(() => {
    if (!draft || titleMine || editingTitle) return undefined;
    const key = draft.key;
    if (words.length < TITLE_MIN) {
      if (draft.title) update(key, { title: '', titleState: 'none', titleFor: '' });
      return undefined;
    }
    if (words === draft.titleFor || draft.titleAsks >= TITLE_MAX_PER_BOX) return undefined;
    let live = true;
    const timer = setTimeout(async () => {
      update(key, (d) => ({ titleAsks: d.titleAsks + 1 }));
      setTitleLoading(true);
      try {
        const res = await window.fetch('/api/feedback/title', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description: words.slice(0, TITLE_SOURCE_MAX) }),
        });
        const data = (res.ok ? await res.json() : {}) as { title?: unknown };
        if (!live) return;
        const title = typeof data.title === 'string' ? data.title.trim() : '';
        if (title) {
          update(key, (d) => (d.titleState === 'mine' || draftWords(d) !== words
            ? {} : { title, titleState: 'auto', titleFor: words }));
        }
      } catch { /* silent: the server names it when it is posted */ }
      finally {
        if (live) setTitleLoading(false);
      }
    }, TITLE_DEBOUNCE_MS);
    return () => { live = false; clearTimeout(timer); setTitleLoading(false); };
    // `draft` is read for its key and counters; a new keystroke is `words`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, words, titleMine, editingTitle]);

  const addImages = useCallback((files: File[]) => {
    if (!draft) return;
    const key = draft.key;
    const room = MAX_PICTURES - pictureCount(draft);
    const usable = files.filter((f) => IMAGE_TYPES.includes(f.type));
    if (usable.length < files.length) update(key, { error: 'Only PNG and JPEG images can be attached.' });
    if (room <= 0) {
      update(key, { error: `A request can carry ${MAX_PICTURES} images.` });
      return;
    }
    const added = usable.slice(0, room).map((f) => {
      const url = URL.createObjectURL(f);
      urls.current.add(url);
      return { blob: f as Blob, url, name: f.name || 'Pasted image' };
    });
    if (added.length) update(key, (d) => ({ images: [...d.images, ...added], ...(usable.length === files.length ? { error: '' } : {}) }));
  }, [draft, update]);

  const removeImage = (key: number, url: string) => {
    URL.revokeObjectURL(url);
    urls.current.delete(url);
    update(key, (d) => ({ images: d.images.filter((i) => i.url !== url) }));
  };

  /** The request as a post: its words (numbered when there are several), each picture clean with its pins beside it. */
  const postFor = useCallback(async (d: Draft): Promise<CommentPost> => {
    const live = liveComments(d);
    const many = live.length > 1;
    const bases = new Map<number, Base | null>();
    for (const pic of d.pictures) {
      bases.set(pic.key, pic.base === undefined ? await pic.promise.catch(() => null) : pic.base);
    }
    const spots: Spot[] = live.map((c) => {
      const pic = c.picture != null ? d.pictures.find((x) => x.key === c.picture) : null;
      const base = pic ? bases.get(pic.key) ?? null : null;
      let at: ElementInfo | null;
      if (c.inApp) at = pic && pic.askedFor === c.key ? base?.app?.at ?? null : null;
      else at = c.anchor.el && c.anchor.el.isConnected ? describeElement(c.anchor.el) : null;
      return { inApp: c.inApp, screen: c.inApp ? (base?.app?.path || '') : c.screen, at };
    });
    const shots: CommentShot[] = [];
    if (d.keepShot) {
      for (const pic of d.pictures) {
        const base = bases.get(pic.key);
        const pins = live.map((c, i) => ({ c, i })).filter(({ c }) => c.picture === pic.key)
          .map(({ c, i }) => ({ x: c.pin.x, y: c.pin.y, n: many ? i + 1 : null, note: c.text.trim() }));
        if (!base || !pins.length) continue;
        try {
          const blob = await encodeUnder(base.canvas);
          if (blob) shots.push({ blob, pins });
        } catch { /* that picture stays behind; the words go */ }
      }
    }
    const first = live[0] || d.comments[0];
    const target: Target = app ? (d.chosen ?? (first?.inApp ? 'app' : 'platform')) : 'platform';
    return {
      text: numberedWords(live.map((c) => c.text)),
      target,
      appSlug: app?.slug ?? null,
      shots,
      images: d.images.map((i) => i.blob),
      title: titleToSend(d),
      bounty: d.kudos && budget.remaining !== 0,
      where: live.length ? whereLines(spots) : '',
    };
  }, [app, budget.remaining]);

  const send = useCallback(async () => {
    const d = draft;
    if (!d || d.sending || !liveComments(d).length) return;
    update(d.key, { sending: true, error: '', editingTitle: false });
    const post = await postFor(d);
    const outcome = await postComment(post);
    if (outcome.ok) {
      const live = liveComments(d);
      const many = live.length > 1;
      const name = post.target === 'app' && app ? app.name : 'Homeroom';
      const number = numberFromUrl(outcome.url);
      const slug = post.target === 'app' ? app?.slug : platformSlug();
      setPosted((list) => [...list, {
        key: d.key,
        title: outcome.title || post.title || '',
        words: post.text,
        place: number ? `#${number} · Posted to ${name}` : `Posted to ${name}`,
        href: number && slug ? `#app/${encodeURIComponent(slug)}/dev/issues/${number}` : null,
        pictures: (post.shots?.length || 0) + (post.images?.length || 0),
        comments: live.length,
        kudos: !!outcome.bounty?.placed,
      }]);
      setPostedPins((list) => [...list, ...live.map((c, i) => ({ key: c.key, request: d.key, n: many ? i + 1 : null, anchor: c.anchor }))]);
      setDraft(null);
      barRef.current?.focus({ preventScroll: true });
      const what = many ? `Posted ${live.length} comments to ${name}` : `Posted to ${name}`;
      let line = outcome.botWillBuild ? `${what}. Homeroom bot is building it.` : `${what}. Thanks!`;
      if (outcome.bounty) {
        line += outcome.bounty.placed
          ? ' Your kudos goes to whoever solves it.'
          : ` The kudos wasn't added: ${outcome.bounty.error || 'it could not be placed'}.`;
        void refreshKudosBudget().then(() => setBudget(kudosBudget()));
      }
      toast(line);
      return;
    }
    if (outcome.handover) {
      onClose();
      handOver(post);
      return;
    }
    update(d.key, { sending: false, error: outcome.error });
  }, [draft, update, postFor, app, onClose]);

  /** The form instead, with whatever the request holds. */
  const toForm = useCallback(async () => {
    const d = draft;
    const post = d && (hasWords(d) || d.images.length) ? await postFor(d) : null;
    onClose();
    if (post) {
      handOver(post);
      return;
    }
    (window as unknown as { App?: { openFeedbackModal?: (opts: unknown) => void } }).App?.openFeedbackModal?.({ mode: 'form' });
  }, [draft, postFor, onClose]);

  const discard = useCallback(() => {
    setDraft(null);
    setConfirm(null);
    barRef.current?.focus({ preventScroll: true });
  }, []);

  /** The box's ✕, and Esc: straight away when nothing is written, else asked on the bar. */
  const requestDiscard = useCallback(() => {
    if (hasWords(draft)) setConfirm('discard');
    else discard();
  }, [draft, discard]);

  /** Done: leave, unless that would drop words nobody has posted (the request's, or the form's still waiting for a click). */
  const requestExit = useCallback(() => {
    const unposted = draft ? !draft.sending && hasWords(draft) : !!carry?.text?.trim();
    if (unposted) {
      setConfirm('exit');
      return;
    }
    onClose();
  }, [draft, carry, onClose]);

  /** "Add a comment": the request's next comment goes where the next click is. */
  const addComment = useCallback(() => {
    const cur = activeComment(draft);
    if (!draft || draft.sending || !cur || !cur.text.trim() || draft.comments.length >= MAX_COMMENTS) return;
    update(draft.key, { active: null });
    barRef.current?.focus({ preventScroll: true });
  }, [draft, update]);

  const openComment = useCallback((key: number) => {
    if (!draft || draft.sending) return;
    update(draft.key, { active: key });
  }, [draft, update]);

  const removeComment = useCallback((key: number) => {
    if (!draft || draft.sending || draft.comments.length < 2) return;
    const comments = draft.comments.filter((c) => c.key !== key);
    setDraft({
      ...draft,
      comments,
      pictures: prune(draft.pictures, comments),
      active: draft.active === key || draft.active == null ? comments[comments.length - 1].key : draft.active,
    });
  }, [draft]);

  const escape = useCallback(() => {
    if (open != null) { setOpen(null); return; }
    if (confirm) { setConfirm(null); return; }
    if (draft && draft.active == null && draft.comments.length) { openComment(draft.comments[draft.comments.length - 1].key); return; }
    if (draft) { if (!draft.sending) requestDiscard(); return; }
    onClose();
  }, [open, confirm, draft, openComment, requestDiscard, onClose]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      escape();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [escape]);

  // C again, from ../improve/suggest-shortcut.ts, asks to leave.
  useEffect(() => {
    controller = { exit: requestExit };
    return () => { controller = null; };
  }, [requestExit]);

  // ── The bar ─────────────────────────────────────────────────────────
  //
  // Over the inset picture the bar is that view's header: it sits in the
  // band the picture leaves at the top, the picture's own width, and does
  // not float, so there is no handle to drag it by. Over the live page (a
  // picture that could not be taken) it is as it always was: at the foot,
  // centred, each time comment mode opens, until the person drags its
  // handle; then where they put it, for this visit only (a double-click on
  // the handle puts it back). It never moves out of the way on its own:
  // what is under it is reached by dragging the handle, which wears the
  // four-arrow move glyph and cursor.
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const width = bar.offsetWidth;
    const height = bar.offsetHeight;
    if (width !== barSize.width || height !== barSize.height) setBarSize({ width, height });
  });
  const onGripDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    setIntro(false);
    const r = barRef.current?.getBoundingClientRect();
    if (!r) return;
    drag.current = { dx: e.clientX - (r.left + r.width / 2), dy: e.clientY - (r.top + r.height / 2) };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onGripMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    setBarAt({ x: clamp01((e.clientX - d.dx) / Math.max(1, window.innerWidth)), y: clamp01((e.clientY - d.dy) / Math.max(1, window.innerHeight)) });
  };
  const onGripUp = () => {
    if (!drag.current) return;
    drag.current = null;
  };
  // Where a dragged bar was let go, on the live page.
  const barPlace = barAt && !inset
    ? {
      left: Math.round(Math.max(8, Math.min(window.innerWidth - barSize.width - 8, barAt.x * window.innerWidth - barSize.width / 2))),
      top: Math.round(Math.max(8, Math.min(window.innerHeight - barSize.height - 8, barAt.y * window.innerHeight - barSize.height / 2))),
    }
    : null;

  // The box and an open marker's card sit beside their pins: clear of the
  // header at the top over the picture, clear of the bar at the foot over
  // the live page.
  const viewport = () => ({ width: window.innerWidth, height: Math.max(200, window.innerHeight - (inset || barAt ? 0 : BAR_SPACE)) });
  const boxComment = draft ? activeComment(draft) || draft.comments[draft.comments.length - 1] || null : null;
  // Where the box and card go, in screen coordinates: the anchor reads the
  // live element in page coordinates, so it follows scrolls, and the inset
  // picture scales it back up.
  const boxPointPage = boxComment ? (anchorPoint(boxComment.anchor) ?? boxComment.anchor.at) : null;
  const boxPoint = boxPointPage ? (inset ? toScreen(boxPointPage, inset) : boxPointPage) : null;
  const openPin = open != null ? postedPins.find((p) => p.key === open) || null : null;
  const openRequest = openPin ? posted.find((r) => r.key === openPin.request) || null : null;
  const openPointPage = openPin ? anchorPoint(openPin.anchor) : null;
  const openPoint = openPointPage ? (inset ? toScreen(openPointPage, inset) : openPointPage) : null;
  // The close-up at the top of the phone's sheet: the area of the view
  // picture around the open comment's pin. When the page has moved on since
  // the comment was pinned (its picture is of another view than the one now
  // shown), the comment's own thumbnail stands in, as it is.
  const activePicture = draft && boxComment && boxComment.picture != null
    ? draft.pictures.find((pic) => pic.key === boxComment.picture) || null
    : null;
  const viewDiffers = !!viewShot && !!activePicture && activePicture.base !== undefined
    && activePicture.view !== viewShot.view;
  // Beside the marker where there is room for it; on a narrow screen, under
  // the point (or over the marker), never on top of the pin it belongs to.
  const besidePin = (p: Point, size: { width: number; height: number }): Point => {
    const vp = viewport();
    const fits = p.x + 24 + size.width <= vp.width - 8 || p.x - 24 - size.width >= 8;
    let at: Point;
    if (fits) {
      at = placeBeside({ x: p.x + 10, y: p.y - 30 }, size, vp, 14);
    } else {
      const x = Math.max(8, Math.min(vp.width - 8 - size.width, p.x - size.width / 2));
      const below = p.y + 10;
      const y = below + size.height <= vp.height - 8 ? below : Math.max(8, p.y - 40 - size.height);
      at = { x, y };
    }
    // The header owns the top of the view: the box and a card never slide under it.
    return inset ? { x: at.x, y: Math.max(at.y, HEADER_BAND + 8) } : at;
  };
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box && boxPoint) {
      const at = besidePin(boxPoint, { width: box.offsetWidth || BOX_WIDTH, height: box.offsetHeight || 200 });
      if (at.x !== boxAt.x || at.y !== boxAt.y) setBoxAt(at);
    }
    const card = cardRef.current;
    if (card && openPoint) {
      const at = besidePin(openPoint, { width: card.offsetWidth || 300, height: card.offsetHeight || 140 });
      if (at.x !== cardAt.x || at.y !== cardAt.y) setCardAt(at);
    }
  });

  const onLayerMove = (e: { clientX: number; clientY: number }) => {
    const p = inset ? toPage({ x: e.clientX, y: e.clientY }, inset) : { x: e.clientX, y: e.clientY };
    if (hoverFrame.current) cancelAnimationFrame(hoverFrame.current);
    hoverFrame.current = requestAnimationFrame(() => {
      hoverFrame.current = 0;
      const el = underPoint(p, host);
      if (!el || el.tagName === 'IFRAME') { setHover(null); return; }
      const r = el.getBoundingClientRect();
      // Something the size of the page says nothing about where you are.
      if (r.width * r.height > window.innerWidth * window.innerHeight * 0.4) { setHover(null); return; }
      setHover({ x: r.left, y: r.top, width: r.width, height: r.height });
    });
  };
  useEffect(() => () => { if (hoverFrame.current) cancelAnimationFrame(hoverFrame.current); }, []);

  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    const at = inset ? toPage({ x: e.clientX, y: e.clientY }, inset) : { x: e.clientX, y: e.clientY };
    const s = scrollerAt(at, host);
    if (!s) return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
    s.scrollBy({ left: e.deltaX * unit, top: e.deltaY * unit });
  };

  // A finger: a tap is a comment, a drag scrolls what is under it.
  const onLayerPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse') return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY };
    const at = inset ? toPage(start, inset) : start;
    touch.current = { id: e.pointerId, start, last: start, moved: false, scroller: scrollerAt(at, host) };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onLayerPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const t = touch.current;
    if (!t || e.pointerId !== t.id) return;
    const p = { x: e.clientX, y: e.clientY };
    if (!t.moved && Math.hypot(p.x - t.start.x, p.y - t.start.y) > 8) t.moved = true;
    if (t.moved && t.scroller) t.scroller.scrollBy(t.last.x - p.x, t.last.y - p.y);
    t.last = p;
  };
  const onLayerPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const t = touch.current;
    if (!t || e.pointerId !== t.id) return;
    touch.current = null;
    if (!t.moved) place({ x: e.clientX, y: e.clientY });
  };

  const onBoxKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files || []).filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    addImages(files);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    const files = Array.from(e.dataTransfer?.files || []);
    if (!files.length) return;
    e.preventDefault();
    addImages(files);
  };

  const postedCount = posted.length;
  const hint = draft
    ? (viewShot?.state === 'drawing' ? 'Taking a screenshot…'
      : draft.active == null ? 'Click where the next comment goes' : 'Enter posts it. Esc discards it.')
    : carry ? 'Click where your words belong' : postedCount ? 'Click to leave another' : 'Tap anywhere to suggest an improvement';

  const first = draft ? draft.comments[0] : null;
  const target: Target | null = draft ? (app ? (draft.chosen ?? (first?.inApp ? 'app' : 'platform')) : 'platform') : null;
  const count = draft ? pictureCount(draft) : 0;
  const live = draft ? liveComments(draft).length : 0;
  const numbered = !!draft && (draft.comments.length > 1 || draft.active == null);
  const drawing = !!draft && draft.keepShot && draft.pictures.some((p) => p.base === undefined);
  const kudosOut = budget.remaining === 0;
  const kudosLeft = budget.remaining != null && budget.limit != null
    ? `Costs 1 kudos. ${budget.remaining} of ${budget.limit} left this week.` : 'Costs 1 kudos.';
  const shotLine = !draft ? '' : !draft.keepShot
    ? 'No screenshot.'
    : drawing
      ? 'Taking a screenshot…'
      : !usedPictures(draft).length && !draft.images.length
        ? "No screenshot. Your words still go."
        : count >= MAX_PICTURES ? `${count} of ${MAX_PICTURES} images`
          : numbered ? 'Screenshot of this page, with your pins' : 'Screenshot of this page, with your pin';
  const quietTool = 'inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[13px] font-semibold text-zinc-600 ring-1 ring-inset ring-zinc-300 hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-40 dark:text-zinc-300 dark:ring-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-white';
  // The wait-for-the-next-pin row, as the box shows it and, on a phone, as
  // the whole collapsed sheet while the wait is on.
  const nextPinRow = draft && draft.active == null ? (
    <div className="flex items-center gap-2 rounded-[10px] bg-violet-600/10 px-2 py-1.5 ring-1 ring-inset ring-violet-600/30">
      <span aria-hidden="true" className={`grid h-[22px] w-[22px] shrink-0 place-items-center ${PIN_SHAPE} bg-white text-[11px] font-extrabold text-violet-600 ring-2 ring-inset ring-violet-600 dark:bg-zinc-900`}>{draft.comments.length + 1}</span>
      <span className="min-w-0 flex-1 text-[13px] font-semibold text-violet-700 dark:text-violet-300">Click on the page where it goes</span>
      <button
        type="button"
        onClick={() => openComment(draft.comments[draft.comments.length - 1].key)}
        className="shrink-0 rounded-md px-1.5 py-0.5 text-[13px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
      >
        Cancel
      </button>
    </div>
  ) : null;

  return (
    <div className="fixed inset-0" style={{ zIndex: 2147483000 }}>
      {/* The layer: a press anywhere is a comment. Its mousedown is
          prevented, so the box's field keeps the keyboard through it
          (tests/keyboard-dismiss.test.js); a finger taps or scrolls. */}
      <div
        id="comment-pin"
        aria-hidden="true"
        data-keep-keyboard=""
        className="absolute inset-0"
        style={{ cursor: CURSOR, touchAction: 'none' }}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          place({ x: e.clientX, y: e.clientY });
        }}
        onPointerDown={onLayerPointerDown}
        onPointerMove={onLayerPointerMove}
        onPointerUp={onLayerPointerUp}
        onPointerCancel={() => { touch.current = null; }}
        onMouseMove={onLayerMove}
        onMouseLeave={() => setHover(null)}
        onWheel={onWheel}
      />
      {/* The page as the person sees it. Over the inset picture: a grey
          ground, the picture drawn at the inset frame with the cards'
          rounded corners, one hairline and a lift, and the chip that names
          it. Clearly a picture, not the live page, so the blue edge goes.
          When the picture could not be taken, the mode renders as it always
          did, over the live page with the blue edge (#4554). */}
      {inset && viewShot ? (
        <>
          <div className="pointer-events-none absolute inset-0 bg-zinc-300 dark:bg-zinc-800" aria-hidden="true" />
          {viewShot.url ? (
            <img
              src={viewShot.url}
              alt=""
              aria-hidden="true"
              draggable={false}
              className={`pointer-events-none absolute rounded-2xl bg-white ring-1 ring-black/10 shadow-[0_8px_30px_rgba(0,0,0,0.18)] dark:bg-zinc-900 dark:ring-white/10 ${viewShot.state === 'drawing' ? 'opacity-60' : ''}`}
              style={{ left: inset.x, top: inset.y, width: window.innerWidth * inset.scale, height: window.innerHeight * inset.scale }}
            />
          ) : null}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute rounded-full bg-zinc-900/80 px-2.5 py-[3px] text-xs font-semibold text-white"
            style={{ left: inset.x + 10, top: inset.y + 10 }}
          >
            Screenshot
          </span>
        </>
      ) : (
        <div className="pointer-events-none absolute inset-0 shadow-[inset_0_0_0_3px_#0a6ee0]" aria-hidden="true" />
      )}
      {hover ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute rounded-lg border-[1.5px] border-dashed border-violet-600 bg-violet-600/5"
          style={(() => {
            const v = inset ? toScreen(hover, inset) : hover;
            return { left: v.x - 3, top: v.y - 3, width: hover.width * (inset?.scale ?? 1) + 6, height: hover.height * (inset?.scale ?? 1) + 6 };
          })()}
        />
      ) : null}

      {postedPins.map((p) => {
        const at = anchorPoint(p.anchor);
        const request = posted.find((r) => r.key === p.request);
        if (!at || !request) return null;
        const s = inset ? toScreen(at, inset) : at;
        return (
          <button
            key={p.key}
            type="button"
            data-comment-pin-posted={p.n ?? ''}
            aria-label={p.n ? `Comment ${p.n}, ${request.place}` : `Comment, ${request.place}`}
            aria-expanded={open === p.key}
            onClick={() => setOpen((o) => (o === p.key ? null : p.key))}
            className={`absolute grid h-[30px] w-[30px] place-items-center ${PIN_SHAPE} bg-violet-600 text-[13px] font-extrabold text-white shadow-[0_0_0_2.5px_#fff,0_3px_10px_rgba(0,0,0,0.28)] hover:bg-violet-500`}
            style={{ left: s.x, top: s.y - 30 }}
          >
            {p.n ?? <ChatIcon className="h-4 w-4" />}
          </button>
        );
      })}

      {draft ? draft.comments.map((c, i) => {
        const at = anchorPoint(c.anchor) ?? (c.key === draft.active ? c.anchor.at : null);
        if (!at) return null;
        const s = inset ? toScreen(at, inset) : at;
        const on = c.key === draft.active;
        return (
          <button
            key={c.key}
            type="button"
            data-comment-pin-dot=""
            aria-label={`Comment ${i + 1}, not posted yet`}
            disabled={draft.sending}
            onClick={() => openComment(c.key)}
            className={on
              ? `absolute grid h-[30px] w-[30px] place-items-center ${PIN_SHAPE} bg-white text-[13px] font-extrabold text-violet-600 shadow-[0_0_0_2.5px_#0a6ee0,0_3px_10px_rgba(0,0,0,0.2)] dark:bg-zinc-900`
              : `absolute grid h-[30px] w-[30px] place-items-center ${PIN_SHAPE} bg-white/90 text-[13px] font-extrabold text-violet-600/80 shadow-[0_0_0_2px_rgba(10,110,224,0.55),0_2px_6px_rgba(0,0,0,0.15)] dark:bg-zinc-900/90`}
            style={{ left: s.x, top: s.y - 30 }}
          >
            {numbered ? i + 1 : ''}
          </button>
        );
      }) : null}

      {draft && target ? (
        <div
          ref={boxRef}
          id="comment-pin-box"
          role="dialog"
          aria-label="Your request"
          className={phone
            ? /* On a phone the box is a bottom sheet: it slides up from the
                 foot of the screen, clear of the keyboard, instead of a card
                 beside the pin (which the sheet would cover anyway). */
              `comment-sheet-in platform-kb-sheet absolute inset-x-0 bottom-0 flex max-h-[85%] flex-col gap-2 overflow-y-auto overscroll-contain rounded-t-[20px] ${PLANE_FILL} p-3 shadow-[inset_0_0_0_1px_var(--app-sheet-line)]`
            : 'absolute flex w-[360px] max-w-[calc(100vw-24px)] flex-col gap-2 rounded-2xl bg-white p-3 shadow-[0_8px_30px_rgba(0,0,0,0.18)] ring-1 ring-black/10 dark:bg-zinc-900 dark:ring-white/10'}
          style={phone ? undefined : { left: boxAt.x, top: boxAt.y }}
          onDragOver={(e) => { if (Array.from(e.dataTransfer?.types || []).includes('Files')) e.preventDefault(); }}
          onDrop={onDrop}
        >
          {phone ? <div aria-hidden="true" className="comment-sheet-grabber" /> : null}
          {phone && draft.active == null ? (
            /* Waiting for the next pin: the sheet holds just that, so most
               of the page stays in sight to tap. */
            nextPinRow
          ) : (
            <>
              {phone ? (
                <CloseUp
                  view={viewShot?.url || ''}
                  pin={boxComment?.pin ?? { x: 0.5, y: 0.5 }}
                  own={viewDiffers ? activePicture?.thumb || null : null}
                />
              ) : null}
              <div className="flex min-h-[30px] items-center gap-1.5">
            {app ? (
              <div className="flex min-w-0 items-center gap-1 text-[13px]" role="radiogroup" aria-label="Where it goes">
                <span className="text-zinc-500 dark:text-zinc-400">To</span>
                {([['app', app.name], ['platform', 'Homeroom']] as Array<[Target, string]>).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={target === value}
                    id={`comment-pin-to-${value}`}
                    disabled={draft.sending}
                    onClick={() => update(draft.key, { chosen: value })}
                    className={target === value
                      ? 'max-w-[120px] truncate rounded-full bg-zinc-200 px-2.5 py-1 font-medium text-zinc-900 dark:bg-zinc-700 dark:text-white'
                      : 'max-w-[120px] truncate rounded-full px-2.5 py-1 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800'}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : (
              <span className="text-[13px] text-zinc-500 dark:text-zinc-400">To Homeroom</span>
            )}
            <span className="min-w-0 flex-1" />
            <button
              type="button"
              title="Open in the form"
              aria-label="Open in the form"
              disabled={draft.sending}
              onClick={() => { void toForm(); }}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-white"
            >
              <ArrowsPointingOutIcon className="h-4 w-4" />
            </button>
            <button
              type="button"
              title="Discard (Esc)"
              aria-label="Discard this request"
              disabled={draft.sending}
              onClick={requestDiscard}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-white"
            >
              <XIcon className="h-4 w-4" />
            </button>
          </div>
          <div className="flex flex-col gap-1.5" id="comment-pin-comments">
            {draft.comments.map((c, i) => (c.key === draft.active ? (
              <div key={c.key} className="flex items-start gap-2">
                {numbered ? (
                  <span aria-hidden="true" className={`mt-0.5 grid h-[22px] w-[22px] shrink-0 place-items-center ${PIN_SHAPE} bg-white text-[11px] font-extrabold text-violet-600 ring-2 ring-inset ring-violet-600 dark:bg-zinc-900`}>{i + 1}</span>
                ) : null}
                <textarea
                  ref={textRef}
                  id="comment-pin-text"
                  aria-label={numbered ? `Comment ${i + 1}` : 'Your comment'}
                  rows={numbered ? 2 : 3}
                  value={c.text}
                  readOnly={draft.sending}
                  onChange={(e) => {
                    const value = e.target.value;
                    update(draft.key, (d) => ({ comments: d.comments.map((x) => (x.key === c.key ? { ...x, text: value } : x)) }));
                  }}
                  onKeyDown={onBoxKeyDown}
                  onPaste={onPaste}
                  placeholder={i ? 'And what should change here?' : 'What should change here?'}
                  className={`block max-h-[160px] w-full min-w-0 flex-1 resize-none bg-transparent text-[15px] leading-snug text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100 dark:placeholder:text-zinc-500 ${numbered ? 'min-h-[44px]' : 'min-h-[62px]'}`}
                />
              </div>
            ) : (
              <div key={c.key} className="flex items-center gap-2">
                <span aria-hidden="true" className={`grid h-[22px] w-[22px] shrink-0 place-items-center ${PIN_SHAPE} bg-zinc-100 text-[11px] font-extrabold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400`}>{i + 1}</span>
                <button
                  type="button"
                  title="Change this comment"
                  disabled={draft.sending}
                  onClick={() => openComment(c.key)}
                  className="min-w-0 flex-1 truncate rounded-lg px-1.5 py-0.5 text-left text-sm text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-white"
                >
                  {c.text.trim() || 'Nothing written yet'}
                </button>
                <button
                  type="button"
                  aria-label={`Remove comment ${i + 1}`}
                  title="Remove"
                  disabled={draft.sending}
                  onClick={() => removeComment(c.key)}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-white"
                >
                  <XIcon className="h-3.5 w-3.5" />
                </button>
              </div>
            )))}
            {nextPinRow}
          </div>
          <div id="comment-pin-title" className="flex min-h-[32px] items-center gap-2 rounded-[10px] bg-zinc-100 py-1 pl-2.5 pr-1 text-[13px] dark:bg-zinc-800">
            <span className="shrink-0 font-semibold text-zinc-500 dark:text-zinc-400">Title</span>
            {draft.editingTitle ? (
              <input
                aria-label="Title"
                autoFocus
                maxLength={200}
                defaultValue={draft.title}
                placeholder="Name this request"
                className="min-w-0 flex-1 rounded-md bg-white px-1.5 py-1 font-semibold text-zinc-900 outline-none ring-[1.5px] ring-violet-600 dark:bg-zinc-900 dark:text-white"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
                  if (e.key === 'Escape') { e.preventDefault(); update(draft.key, { editingTitle: false }); textRef.current?.focus(); }
                }}
                onBlur={(e) => {
                  const value = e.currentTarget.value.trim();
                  // Cleared, the suggestion comes back (the dialog's rule).
                  update(draft.key, value
                    ? { editingTitle: false, title: value, titleState: 'mine' }
                    : { editingTitle: false, title: '', titleState: 'none', titleFor: '', titleAsks: 0 });
                }}
              />
            ) : titleLoading && !draft.title ? (
              <span className="min-w-0 flex-1 animate-pulse font-semibold text-zinc-400 motion-reduce:animate-none dark:text-zinc-500">Writing a title…</span>
            ) : draft.title ? (
              <>
                <button
                  type="button"
                  title="Change the title"
                  disabled={draft.sending}
                  onClick={() => update(draft.key, { editingTitle: true })}
                  className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-left font-semibold text-zinc-900 hover:bg-zinc-200 dark:text-white dark:hover:bg-zinc-700"
                >
                  <span className="truncate">{draft.title}</span>
                  <DraftEditIcon className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                </button>
                {draft.titleState === 'auto' ? (
                  <span className="inline-flex shrink-0 items-center gap-1 pr-1 text-xs text-zinc-500 dark:text-zinc-400">
                    <SparklesIcon className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400" />
                    {titleLoading ? 'Updating…' : 'Suggested'}
                  </span>
                ) : null}
              </>
            ) : (
              <button
                type="button"
                disabled={draft.sending}
                onClick={() => update(draft.key, { editingTitle: true })}
                className="min-w-0 flex-1 truncate rounded-md px-1 py-1 text-left text-zinc-400 hover:bg-zinc-200 dark:text-zinc-500 dark:hover:bg-zinc-700"
              >
                {words.length >= TITLE_MIN ? 'Named from your words when posted' : 'Suggested as you type'}
              </button>
            )}
          </div>
          <div className="flex min-h-[44px] flex-wrap items-center gap-2.5">
            {usedPictures(draft).map((pic) => (
              <span key={pic.key} className="relative block h-[42px] w-[64px] shrink-0">
                {pic.thumb ? (
                  <img src={pic.thumb} alt="" className="h-[42px] w-[64px] rounded-lg object-cover object-left-top ring-1 ring-black/10 dark:ring-white/10" />
                ) : (
                  <span className="block h-[42px] w-[64px] animate-pulse rounded-lg bg-zinc-100 motion-reduce:animate-none dark:bg-zinc-800" />
                )}
                {/* The pins over the preview: data beside the picture, as they are posted. */}
                {draft.comments.filter((c) => c.picture === pic.key).map((c) => (
                  <span
                    key={c.key}
                    aria-hidden="true"
                    className={`absolute h-[10px] w-[10px] -translate-y-full ${PIN_SHAPE} bg-violet-600 shadow-[0_0_0_1.5px_#fff]`}
                    style={{ left: `${c.pin.x * 100}%`, top: `${c.pin.y * 100}%` }}
                  />
                ))}
                {pic.base ? (
                  <button
                    type="button"
                    aria-label="Remove the screenshots"
                    title="Remove"
                    disabled={draft.sending}
                    onClick={() => update(draft.key, { keepShot: false })}
                    className="absolute -right-2 -top-2 grid h-5 w-5 place-items-center rounded-full bg-zinc-900 text-white ring-2 ring-white dark:bg-zinc-100 dark:text-zinc-900 dark:ring-zinc-900"
                  >
                    <XIcon className="h-3 w-3" />
                  </button>
                ) : null}
              </span>
            ))}
            {draft.images.map((img) => (
              <span key={img.url} className="relative block h-[42px] w-[64px] shrink-0">
                <img src={img.url} alt={img.name} className="h-[42px] w-[64px] rounded-lg object-cover ring-1 ring-black/10 dark:ring-white/10" />
                <button
                  type="button"
                  aria-label={`Remove ${img.name}`}
                  title="Remove"
                  disabled={draft.sending}
                  onClick={() => removeImage(draft.key, img.url)}
                  className="absolute -right-2 -top-2 grid h-5 w-5 place-items-center rounded-full bg-zinc-900 text-white ring-2 ring-white dark:bg-zinc-100 dark:text-zinc-900 dark:ring-zinc-900"
                >
                  <XIcon className="h-3 w-3" />
                </button>
              </span>
            ))}
            <span id="comment-pin-shot" className="min-w-[90px] flex-1 text-xs leading-tight text-zinc-500 dark:text-zinc-400">
              {shotLine}
              {!draft.keepShot ? (
                <button
                  type="button"
                  disabled={draft.sending || draft.images.length >= MAX_PICTURES}
                  onClick={() => update(draft.key, { keepShot: true })}
                  className="ml-1 font-semibold text-violet-700 hover:underline disabled:opacity-50 dark:text-violet-300"
                >
                  Add it back
                </button>
              ) : null}
            </span>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg"
              multiple
              className="hidden"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => { addImages(Array.from(e.target.files || [])); e.target.value = ''; }}
            />
          </div>
          {/* Kudos (#964): one line, a switch. What it costs is said on hover
              and to a screen reader; the line itself says what it is for. */}
          <button
            type="button"
            id="comment-pin-kudos"
            role="switch"
            aria-checked={draft.kudos}
            aria-describedby="comment-pin-kudos-cost"
            title={kudosOut ? undefined : kudosLeft}
            disabled={draft.sending || kudosOut}
            onClick={() => update(draft.key, (d) => ({ kudos: !d.kudos }))}
            className={draft.kudos
              ? 'flex h-9 w-full items-center gap-2 rounded-[10px] bg-violet-600/10 px-2.5 text-left ring-1 ring-inset ring-violet-600/30'
              : 'flex h-9 w-full items-center gap-2 rounded-[10px] bg-zinc-100 px-2.5 text-left hover:bg-zinc-200 disabled:opacity-60 dark:bg-zinc-800 dark:hover:bg-zinc-700'}
          >
            <span aria-hidden="true" className="text-base leading-none">{'\u{1F44F}'}</span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-zinc-900 dark:text-white">Kudos for whoever solves it</span>
            <span id="comment-pin-kudos-cost" className="shrink-0 text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
              {kudosOut ? 'None left this week' : budget.remaining != null ? `${budget.remaining} left` : ''}
              <span className="sr-only">{kudosOut ? '' : `. ${kudosLeft}`}</span>
            </span>
            <span
              aria-hidden="true"
              className={draft.kudos
                ? 'relative h-5 w-[34px] shrink-0 rounded-full bg-violet-600'
                : 'relative h-5 w-[34px] shrink-0 rounded-full bg-zinc-300 dark:bg-zinc-600'}
            >
              <span className={draft.kudos
                ? 'absolute left-[17px] top-[3px] h-3.5 w-3.5 rounded-full bg-white shadow'
                : 'absolute left-[3px] top-[3px] h-3.5 w-3.5 rounded-full bg-white shadow'}
              />
            </span>
          </button>
          {draft.error ? (
            <p id="comment-pin-error" role="alert" className="text-[13px] text-red-700 dark:text-red-400">{draft.error}</p>
          ) : null}
          <div className="flex items-center gap-1.5 border-t border-black/5 pt-2 dark:border-white/10">
            <button
              type="button"
              title="Attach images, or paste one"
              aria-label="Attach images"
              disabled={draft.sending || count >= MAX_PICTURES}
              onClick={() => fileRef.current?.click()}
              className={`${quietTool} w-8 justify-center px-0`}
            >
              <PaperclipIcon className="h-4 w-4" />
            </button>
            {draft.comments.length < MAX_COMMENTS ? (
              <button
                type="button"
                title="Add another comment to this same request: click where it goes next"
                disabled={draft.sending || draft.active == null || !activeComment(draft)?.text.trim()}
                onClick={addComment}
                className={quietTool}
              >
                <PlusIcon className="h-4 w-4" />
                Add a comment
              </button>
            ) : null}
            <span className="min-w-0 flex-1" />
            <Button
              type="button"
              id="comment-pin-send"
              variant="pillAccent"
              size="sm"
              ink="solid"
              disabledStyle="block"
              className="whitespace-nowrap"
              disabled={draft.sending || !live}
              onClick={() => { void send(); }}
            >
              {draft.sending ? 'Posting…' : live > 1 ? `Post ${live} comments` : 'Post'}
            </Button>
          </div>
            </>
          )}
        </div>
      ) : null}

      {openPin && openRequest && openPoint ? (
        <div
          ref={cardRef}
          role="dialog"
          aria-label={openRequest.place}
          className="absolute flex w-[300px] max-w-[calc(100vw-24px)] flex-col gap-1.5 rounded-2xl bg-white p-3 shadow-[0_8px_30px_rgba(0,0,0,0.18)] ring-1 ring-black/10 dark:bg-zinc-900 dark:ring-white/10"
          style={{ left: cardAt.x, top: cardAt.y }}
        >
          <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            <span className={`grid h-[22px] w-[22px] shrink-0 place-items-center ${PIN_SHAPE} bg-violet-600 text-[11px] font-extrabold text-white`} aria-hidden="true">{openPin.n ?? ''}</span>
            <span className="min-w-0 flex-1 truncate">{openRequest.place}</span>
            <button
              type="button"
              aria-label="Close"
              onClick={() => setOpen(null)}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <XIcon className="h-3.5 w-3.5" />
            </button>
          </div>
          {openRequest.title ? <p className="text-[15px] font-[650] leading-snug text-zinc-900 dark:text-white">{openRequest.title}</p> : null}
          <p className="line-clamp-3 whitespace-pre-wrap text-[13px] text-zinc-600 dark:text-zinc-300">{openRequest.words}</p>
          <div className="mt-1 flex items-center gap-2 border-t border-black/5 pt-2 text-xs text-zinc-500 dark:border-white/10 dark:text-zinc-400">
            <span className="min-w-0 flex-1 truncate">
              {[
                openRequest.comments > 1 ? `${openRequest.comments} comments` : '',
                openRequest.pictures ? (openRequest.pictures === 1 ? '1 image' : `${openRequest.pictures} images`) : '',
                openRequest.kudos ? 'kudos for whoever solves it' : '',
              ].filter(Boolean).join(' · ')}
            </span>
            {openRequest.href ? (
              <a
                href={openRequest.href}
                onClick={() => onClose()}
                className="shrink-0 rounded-full bg-violet-600 px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-violet-500"
              >
                Open request
              </a>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* The first-use note (#4541): how comment mode works, shown once per
          device, above the bar's starting place. It takes no focus, and
          closes on "Got it", the first pin, or a drag of the bar. */}
      {intro && !confirm ? (
        <div
          role="dialog"
          aria-label="How comment mode works"
          className={[
            'absolute left-1/2 flex w-[340px] max-w-[calc(100vw-24px)] -translate-x-1/2 flex-col gap-2 rounded-2xl bg-white p-3 shadow-[0_8px_30px_rgba(0,0,0,0.18)] ring-1 ring-black/10 dark:bg-zinc-900 dark:ring-white/10',
            inset ? 'top-[68px]' : 'bottom-[76px]',
          ].join(' ')}
        >
          <p className="text-[15px] font-[650] leading-snug text-zinc-900 dark:text-white">How comment mode works</p>
          <ul className="flex flex-col gap-1 text-[13px] text-zinc-600 dark:text-zinc-300">
            <li>Tap anything on the page to leave a comment right there, then press Post.</li>
            {!inset ? <li>Drag the handle on the left to move the bar.</li> : null}
            <li>Prefer the form? Tap Form to switch back at any time.</li>
          </ul>
          <div className="flex justify-end">
            <Button variant="pillAccent" size="sm" ink="solid" onClick={() => setIntro(false)}>Got it</Button>
          </div>
        </div>
      ) : null}

      {/* Over the picture the bar is the view's header: same width as the
          picture, in the band above it, nothing floating over the page and
          no handle to drag it by. Over the live page it is the floating bar
          it always was. */}
      <div
        ref={barRef}
        tabIndex={-1}
        role="toolbar"
        aria-label="Comment mode"
        className={[
          'absolute flex max-w-[calc(100vw-24px)] items-center gap-2 whitespace-nowrap rounded-full bg-white py-1.5 pl-1.5 pr-1.5 outline-none ring-1 ring-black/10 dark:bg-zinc-900 dark:ring-white/10 sm:gap-2.5',
          inset
            ? 'rounded-2xl shadow-[0_8px_30px_rgba(0,0,0,0.18)]'
            : 'shadow-[0_8px_30px_rgba(0,0,0,0.22)]',
          !inset && !barPlace ? 'bottom-4 left-1/2 -translate-x-1/2' : '',
        ].filter(Boolean).join(' ')}
        style={inset
          ? {
            left: inset.x,
            top: Math.max(6, Math.round((HEADER_BAND - barSize.height) / 2)),
            width: window.innerWidth * inset.scale,
          }
          : barPlace ? { left: barPlace.left, top: barPlace.top } : undefined}
      >
        {!inset ? (
          <button
            type="button"
            aria-label="Move the bar: drag it anywhere, double-click to put it back"
            title="Drag to move the bar anywhere. Double-click to put it back at the bottom."
            onPointerDown={onGripDown}
            onPointerMove={onGripMove}
            onPointerUp={onGripUp}
            onPointerCancel={onGripUp}
            onDoubleClick={() => { setBarAt(null); }}
            className="grid h-8 w-6 shrink-0 cursor-move touch-none place-items-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
          >
            <ArrowsMoveIcon className="h-4 w-4" />
          </button>
        ) : null}
        {confirm ? (
          <>
            <span className="min-w-0 truncate text-[13px] font-semibold text-zinc-900 dark:text-white">
              {confirm === 'discard' ? 'Discard this request? Nothing in it is posted yet.' : "Discard the comments you haven't posted?"}
            </span>
            {inset ? <span className="min-w-0 flex-1" /> : null}
            <button
              type="button"
              onClick={() => { setConfirm(null); textRef.current?.focus(); }}
              className="h-[34px] shrink-0 rounded-full px-3 text-sm font-semibold text-zinc-900 hover:bg-zinc-100 dark:text-white dark:hover:bg-zinc-800"
            >
              Keep writing
            </button>
            <button
              type="button"
              onClick={() => { if (confirm === 'discard') discard(); else onClose(); }}
              className="h-[34px] shrink-0 rounded-full bg-zinc-900 px-4 text-sm font-semibold text-white dark:bg-white dark:text-zinc-900"
            >
              Discard
            </button>
          </>
        ) : (
          <>
            <span className="inline-flex shrink-0 items-center gap-1.5 text-sm font-bold text-violet-700 dark:text-violet-300">
              <ChatIcon className="h-[18px] w-[18px]" />
            </span>
            <span className="hidden min-w-0 truncate text-sm font-bold text-violet-700 sm:inline dark:text-violet-300">{hint}</span>
            {postedCount ? (
              <span className="hidden shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-bold tabular-nums text-zinc-600 md:inline dark:bg-zinc-800 dark:text-zinc-300">
                {`${postedCount} posted`}
              </span>
            ) : null}
            {inset ? <span className="min-w-0 flex-1" /> : null}
            <span className="inline-flex shrink-0 gap-0.5 rounded-full bg-zinc-100 p-[3px] dark:bg-zinc-800" role="radiogroup" aria-label="How to suggest it">
              <button
                type="button"
                role="radio"
                aria-checked="false"
                title="Suggest it with the form"
                onClick={() => { void toForm(); }}
                className="inline-flex h-7 items-center gap-1.5 rounded-full pl-2 pr-2.5 text-[13px] font-semibold text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
              >
                <DescriptionIcon className="h-4 w-4" />
                Form
              </button>
              <button
                type="button"
                role="radio"
                aria-checked="true"
                title="Comment on the page"
                className="inline-flex h-7 items-center gap-1.5 rounded-full bg-white pl-2 pr-2.5 text-[13px] font-semibold text-zinc-900 shadow-sm ring-1 ring-black/5 dark:bg-zinc-700 dark:text-white"
              >
                <ChatIcon className="h-4 w-4" />
                Comment
              </button>
            </span>
            <button
              type="button"
              onClick={requestExit}
              className="inline-flex h-[34px] shrink-0 items-center gap-2 rounded-full bg-zinc-900 px-4 text-sm font-semibold text-white dark:bg-white dark:text-zinc-900 sm:pr-3"
            >
              Done
              <kbd className="hidden rounded-[5px] px-1 font-mono text-[11px] font-semibold opacity-70 ring-1 ring-inset ring-current sm:inline">Esc</kbd>
            </button>
          </>
        )}
      </div>
    </div>
  );
}

let openHost: HTMLElement | null = null;
let controller: { exit: () => void } | null = null;

export function commentModeOpen(): boolean {
  return !!openHost;
}

/** Leave comment mode at once, whatever the box holds. */
export function closeCommentMode(): void {
  const host = openHost;
  if (!host) return;
  unmountLegacyPortal(host);
  host.remove();
  openHost = null;
  controller = null;
}

/** Turn comment mode on. A second call while it is on does nothing. */
export function openCommentMode(opts: OpenOptions = {}): void {
  if (openHost || typeof document === 'undefined') return;
  const host = document.createElement('div');
  host.id = HOST_ID;
  document.body.appendChild(host);
  openHost = host;
  const session: Session = { host, app: appTarget(), carry: opts.carry ?? null };
  const close = () => { if (openHost === host) closeCommentMode(); };
  mountLegacyPortal(host, createElement(CommentMode, { session, onClose: close }));
}

/** C: on when it is off; when it is on, Done (which asks first about unposted words). */
export function toggleCommentMode(opts: OpenOptions = {}): void {
  if (openHost) {
    if (controller) controller.exit();
    else closeCommentMode();
    return;
  }
  openCommentMode(opts);
}
