/**
 * Comment mode (#4289 and its follow-ups). Experimental, behind Settings,
 * Experimental's switch: C turns it on (../improve/suggest-shortcut.ts
 * decides when C counts), and so does "Suggest an improvement" when comment
 * mode is the way this device suggested last, or its form's Comment switch.
 *
 * ── What it looks like ────────────────────────────────────────────────
 *
 * A layer over the whole page with a comment cursor, and a bar at the foot:
 * "Comment mode", what to do next, how many are posted, the Detailed /
 * Comment switch, and Done. A click anywhere puts a pin there with a box
 * beside it; Enter posts the box as its own request and the pin stays, a
 * numbered marker the person can open again, so they can go on to the next
 * thing. A click elsewhere while a box is open moves its pin (the words
 * stay). Esc closes what is on top: an open marker, the box, then the mode.
 * The page under the layer still scrolls with the wheel, and the pins move
 * with what they were put on.
 *
 * ── The box ───────────────────────────────────────────────────────────
 *
 * The words; the title it will be posted with, suggested from the words as
 * they are typed (the dialog's own POST /api/feedback/title, with its rules:
 * a pause, a dozen characters, a few asks per box) and changed with a click;
 * the page's screenshot, removable, and up to two more images (the
 * paperclip, a paste or a drop: the server's three in all); Kudos, the
 * dialog's bounty (#964); and where it goes. Its expand button hands it all
 * to the detailed form instead.
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
 * Drawn the moment the pin goes down (./picture.ts), previewed in the box
 * with the pin over it, and posted CLEAN: the pin is sent beside it as data
 * (#4482, ./pin-data.ts), and the request's page draws it over the picture
 * where it can be hidden. Each comment's picture is its own: the other
 * markers are this layer's, and the layer is never in a picture.
 *
 * Mounted on demand through the shell's portal registry
 * (lib/legacy-portals.tsx) into a host appended to <body>; nothing of it is
 * in the prerendered shell.
 */

import {
  createElement, useCallback, useEffect, useLayoutEffect, useRef, useState,
  type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode, type WheelEvent,
} from 'react';

import { Button } from '@/components/ui/button';
import {
  ArrowsPointingOutIcon, ChatIcon, DescriptionIcon, DraftEditIcon, PaperclipIcon, PlusIcon, SparklesIcon, XIcon,
} from '@/components/ui/icons';

import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
import { setSuggestMode } from '../improve/suggest-settings';
import { platformSlug } from '../messages/channel-hub';
import {
  describeElement, encodeUnder, inRect, pictureScale, placeBeside, takeBase, thumbnail,
  type Base, type ElementInfo, type Point, type Rect,
} from './picture';
import { MAX_PICTURES, handOver, numberFromUrl, postComment, whereLine, type CommentPost, type Target } from './post';

export const HOST_ID = 'comment-pin-host';
const BOX_WIDTH = 328;
/** Room kept clear at the foot for the bar. */
const BAR_SPACE = 76;

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
  /** The form's draft, which the first box takes. */
  carry?: CommentCarry | null;
}

interface Picture {
  /** Drawn, null when it could not be, undefined while drawing. */
  base: Base | null | undefined;
  promise: Promise<Base | null>;
  thumb: string;
  /** Where the pin is on it, as fractions of its width and height. */
  pin: Point;
}

interface Image { blob: Blob; url: string; name: string }

type TitleState = 'none' | 'auto' | 'mine';

interface Draft {
  key: number;
  n: number;
  anchor: Anchor;
  inApp: boolean;
  /** The route the page was on, for the where line. */
  screen: string;
  picture: Picture;
  keepShot: boolean;
  text: string;
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
  n: number;
  anchor: Anchor;
  title: string;
  words: string;
  place: string;
  href: string | null;
  pictures: number;
  kudos: boolean;
}

interface Session {
  host: HTMLElement;
  app: AppTarget | null;
  carry: CommentCarry | null;
}

/** The title a post carries: the person's, or a suggestion named from these very words (#732). */
function titleToSend(d: Draft): string {
  if (d.titleState === 'mine') return d.title.trim();
  if (d.titleState === 'auto' && d.titleFor === d.text.trim()) return d.title.trim();
  return '';
}

function CommentMode({ session, onClose }: { session: Session; onClose: () => void }): ReactNode {
  const { host, app } = session;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [posted, setPosted] = useState<Posted[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [confirmExit, setConfirmExit] = useState(false);
  const [carry, setCarry] = useState<CommentCarry | null>(session.carry);
  const [titleLoading, setTitleLoading] = useState(false);
  const [hover, setHover] = useState<Rect | null>(null);
  const [, setTick] = useState(0);
  const [budget, setBudget] = useState<Budget>(kudosBudget);
  const [boxAt, setBoxAt] = useState<Point>({ x: -9999, y: -9999 });
  const [cardAt, setCardAt] = useState<Point>({ x: -9999, y: -9999 });
  const boxRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const keys = useRef(0);
  const hoverFrame = useRef(0);

  const update = useCallback((key: number, patch: Partial<Draft> | ((d: Draft) => Partial<Draft>)) => {
    setDraft((d) => (d && d.key === key ? { ...d, ...(typeof patch === 'function' ? patch(d) : patch) } : d));
  }, []);

  // The bar has the keyboard from the start, so Esc and C reach the shell
  // even when the app's frame had it.
  useEffect(() => { barRef.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => { void refreshKudosBudget().then(() => setBudget(kudosBudget())); }, []);

  // The pins move with the page: any scroll, or a new window size, redraws.
  useEffect(() => {
    let frame = 0;
    const redraw = () => {
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

  // Images the person added are object URLs until the mode closes.
  const urls = useRef(new Set<string>());
  useEffect(() => () => { urls.current.forEach((u) => URL.revokeObjectURL(u)); }, []);

  /** Start drawing the page with the pin at `p`; the box shows it when it lands. */
  const drawPicture = useCallback((key: number, p: Point): Picture => {
    const shown = visibleAppFrame();
    const promise = takeBase({
      host,
      scale: pictureScale(window.devicePixelRatio, { width: window.innerWidth, height: window.innerHeight }),
      frame: shown?.frame ?? null,
      frameRect: shown?.rect ?? null,
      pin: p,
    });
    const picture: Picture = {
      base: undefined,
      promise,
      thumb: '',
      pin: { x: p.x / Math.max(1, window.innerWidth), y: p.y / Math.max(1, window.innerHeight) },
    };
    promise.then((b) => {
      let thumb = '';
      if (b) {
        try { thumb = thumbnail(b.canvas, 160); } catch { /* no preview, still attached */ }
      }
      setDraft((d) => (d && d.key === key && d.picture.promise === promise
        ? { ...d, picture: { ...d.picture, base: b, thumb } } : d));
    }, () => {
      setDraft((d) => (d && d.key === key && d.picture.promise === promise
        ? { ...d, picture: { ...d.picture, base: null } } : d));
    });
    return picture;
  }, [host]);

  /** A press on the page: a pin there, or the open box's pin moved there. */
  const place = useCallback((at: Point) => {
    if (open != null) { setOpen(null); return; }
    const p = clampToViewport(at);
    const anchor = anchorAt(p, host);
    const inApp = inRect(p, visibleAppFrame()?.rect);
    const screen = (location.hash || '#home').split('?')[0].slice(0, 120);
    setConfirmExit(false);
    if (draft && !draft.sending) {
      update(draft.key, { anchor, inApp, screen, picture: drawPicture(draft.key, p), error: '' });
      textRef.current?.focus();
      return;
    }
    if (draft) return;
    const key = ++keys.current;
    const c = carry;
    setCarry(null);
    const images: Image[] = (c?.images || []).filter((b) => IMAGE_TYPES.includes(b.type)).slice(0, MAX_PICTURES - 1)
      .map((blob, i) => {
        const url = URL.createObjectURL(blob);
        urls.current.add(url);
        return { blob, url, name: `Image ${i + 1}` };
      });
    setDraft({
      key,
      n: posted.length + 1,
      anchor,
      inApp,
      screen,
      picture: drawPicture(key, p),
      keepShot: true,
      text: c?.text || '',
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
    });
  }, [open, host, draft, carry, posted.length, update, drawPicture]);

  // The words go to the box's field as it opens.
  const draftKey = draft?.key;
  useEffect(() => {
    const t = textRef.current;
    if (!t) return;
    t.focus();
    t.setSelectionRange(t.value.length, t.value.length);
  }, [draftKey]);

  // #556: the title, suggested from the words after a pause.
  const words = draft ? draft.text.trim() : '';
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
          update(key, (d) => (d.titleState === 'mine' || d.text.trim() !== words
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

  const pictureCount = (d: Draft) => (d.keepShot && d.picture.base !== null ? 1 : 0) + d.images.length;

  const addImages = useCallback((files: File[]) => {
    if (!draft) return;
    const key = draft.key;
    const room = MAX_PICTURES - pictureCount(draft);
    const usable = files.filter((f) => IMAGE_TYPES.includes(f.type));
    if (usable.length < files.length) update(key, { error: 'Only PNG and JPEG images can be attached.' });
    if (room <= 0) {
      update(key, { error: `A comment can carry ${MAX_PICTURES} images.` });
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

  /** The comment as a post: the picture encoded clean, the pin beside it. */
  const postFor = useCallback(async (d: Draft): Promise<CommentPost> => {
    const base = d.picture.base === undefined ? await d.picture.promise.catch(() => null) : d.picture.base;
    let at: ElementInfo | null;
    if (d.inApp) at = base?.app?.at ?? null;
    else at = d.anchor.el && d.anchor.el.isConnected ? describeElement(d.anchor.el) : null;
    const screen = d.inApp ? (base?.app?.path || '') : d.screen;
    let picture: Blob | null = null;
    if (d.keepShot && base) {
      try { picture = await encodeUnder(base.canvas); } catch { picture = null; }
    }
    const target: Target = app ? (d.chosen ?? (d.inApp ? 'app' : 'platform')) : 'platform';
    return {
      text: d.text.trim(),
      target,
      appSlug: app?.slug ?? null,
      picture,
      pin: picture ? d.picture.pin : null,
      images: d.images.map((i) => i.blob),
      title: titleToSend(d),
      bounty: d.kudos && budget.remaining !== 0,
      where: whereLine({ inApp: d.inApp, screen, at }),
    };
  }, [app, budget.remaining]);

  const send = useCallback(async () => {
    const d = draft;
    if (!d || d.sending || !d.text.trim()) return;
    update(d.key, { sending: true, error: '', editingTitle: false });
    const post = await postFor(d);
    const outcome = await postComment(post);
    if (outcome.ok) {
      const name = post.target === 'app' && app ? app.name : 'Homeroom';
      const number = numberFromUrl(outcome.url);
      const slug = post.target === 'app' ? app?.slug : platformSlug();
      setPosted((list) => [...list, {
        key: d.key,
        n: d.n,
        anchor: d.anchor,
        title: outcome.title || post.title || '',
        words: post.text,
        place: number ? `#${number} · Posted to ${name}` : `Posted to ${name}`,
        href: number && slug ? `#app/${encodeURIComponent(slug)}/dev/issues/${number}` : null,
        pictures: (post.picture ? 1 : 0) + (post.images?.length || 0),
        kudos: !!outcome.bounty?.placed,
      }]);
      setDraft(null);
      barRef.current?.focus({ preventScroll: true });
      let line = outcome.botWillBuild ? `Posted to ${name}. Homeroom bot is building it.` : `Posted to ${name}. Thanks!`;
      if (outcome.bounty) {
        line += outcome.bounty.placed
          ? ' You put a kudos on it.'
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

  /** The detailed form instead, with whatever the open box holds. */
  const toDetailed = useCallback(async () => {
    setSuggestMode('form');
    const d = draft;
    const post = d && (d.text.trim() || d.images.length) ? await postFor(d) : null;
    onClose();
    if (post) {
      handOver(post);
      return;
    }
    (window as unknown as { App?: { openFeedbackModal?: (opts: unknown) => void } }).App?.openFeedbackModal?.({ mode: 'form' });
  }, [draft, postFor, onClose]);

  const discard = useCallback(() => {
    setDraft(null);
    setConfirmExit(false);
    barRef.current?.focus({ preventScroll: true });
  }, []);

  /** Done: leave, unless that would drop words nobody has posted (the box's, or the form's still waiting for a click). */
  const requestExit = useCallback(() => {
    const unposted = draft ? !draft.sending && !!draft.text.trim() : !!carry?.text?.trim();
    if (unposted) {
      setConfirmExit(true);
      return;
    }
    onClose();
  }, [draft, carry, onClose]);

  const escape = useCallback(() => {
    if (open != null) { setOpen(null); return; }
    if (confirmExit) { setConfirmExit(false); return; }
    if (draft) { if (!draft.sending) discard(); return; }
    onClose();
  }, [open, confirmExit, draft, discard, onClose]);

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

  // The box and an open marker's card sit beside their pins, clear of the bar.
  const viewport = () => ({ width: window.innerWidth, height: Math.max(200, window.innerHeight - BAR_SPACE) });
  const draftPoint = draft ? (anchorPoint(draft.anchor) ?? draft.anchor.at) : null;
  const openPin = open != null ? posted.find((p) => p.key === open) || null : null;
  const openPoint = openPin ? anchorPoint(openPin.anchor) : null;
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box && draftPoint) {
      const size = { width: box.offsetWidth || BOX_WIDTH, height: box.offsetHeight || 200 };
      const at = placeBeside({ x: draftPoint.x + 10, y: draftPoint.y - 30 }, size, viewport(), 14);
      if (at.x !== boxAt.x || at.y !== boxAt.y) setBoxAt(at);
    }
    const card = cardRef.current;
    if (card && openPoint) {
      const size = { width: card.offsetWidth || 300, height: card.offsetHeight || 140 };
      const at = placeBeside({ x: openPoint.x + 10, y: openPoint.y - 30 }, size, viewport(), 14);
      if (at.x !== cardAt.x || at.y !== cardAt.y) setCardAt(at);
    }
  });

  const onLayerMove = (e: { clientX: number; clientY: number }) => {
    const p = { x: e.clientX, y: e.clientY };
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
    const s = scrollerAt({ x: e.clientX, y: e.clientY }, host);
    if (!s) return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
    s.scrollBy({ left: e.deltaX * unit, top: e.deltaY * unit });
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
    ? 'Enter posts it. Esc discards it.'
    : carry ? 'Click where your words belong' : postedCount ? 'Click to leave another' : 'Click anything to comment on it';

  const target: Target | null = draft ? (app ? (draft.chosen ?? (draft.inApp ? 'app' : 'platform')) : 'platform') : null;
  const count = draft ? pictureCount(draft) : 0;
  const kudosOut = budget.remaining === 0;
  const shotLine = !draft ? '' : !draft.keepShot
    ? 'No screenshot.'
    : draft.picture.base === undefined
      ? 'Taking a screenshot…'
      : draft.picture.base === null
        ? "Couldn't take a screenshot. Your words still go."
        : count >= MAX_PICTURES ? `${count} of ${MAX_PICTURES} images` : 'Screenshot of this page, with your pin';

  return (
    <div className="fixed inset-0" style={{ zIndex: 2147483000 }}>
      {/* The layer: a press anywhere is a comment. Its mousedown is
          prevented, so the box's field keeps the keyboard through it
          (tests/keyboard-dismiss.test.js). */}
      <div
        id="comment-pin"
        aria-hidden="true"
        data-keep-keyboard=""
        className="absolute inset-0"
        style={{ cursor: CURSOR }}
        onMouseDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          place({ x: e.clientX, y: e.clientY });
        }}
        onMouseMove={onLayerMove}
        onMouseLeave={() => setHover(null)}
        onWheel={onWheel}
      />
      <div className="pointer-events-none absolute inset-0 shadow-[inset_0_0_0_3px_#0a6ee0]" aria-hidden="true" />
      {hover ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute rounded-lg border-[1.5px] border-dashed border-violet-600 bg-violet-600/5"
          style={{ left: hover.x - 3, top: hover.y - 3, width: hover.width + 6, height: hover.height + 6 }}
        />
      ) : null}

      {posted.map((p) => {
        const at = anchorPoint(p.anchor);
        if (!at) return null;
        return (
          <button
            key={p.key}
            type="button"
            data-comment-pin-posted={p.n}
            aria-label={`Comment ${p.n}, ${p.place}`}
            aria-expanded={open === p.key}
            onClick={() => setOpen((o) => (o === p.key ? null : p.key))}
            className={`absolute grid h-[30px] w-[30px] place-items-center ${PIN_SHAPE} bg-violet-600 text-[13px] font-extrabold text-white shadow-[0_0_0_2.5px_#fff,0_3px_10px_rgba(0,0,0,0.28)] hover:bg-violet-500`}
            style={{ left: at.x, top: at.y - 30 }}
          >
            {p.n}
          </button>
        );
      })}

      {draft && draftPoint ? (
        <span
          aria-hidden="true"
          data-comment-pin-dot=""
          className={`absolute grid h-[30px] w-[30px] place-items-center ${PIN_SHAPE} bg-white text-[13px] font-extrabold text-violet-600 shadow-[0_0_0_2.5px_#0a6ee0,0_3px_10px_rgba(0,0,0,0.2)] dark:bg-zinc-900`}
          style={{ left: draftPoint.x, top: draftPoint.y - 30 }}
        >
          {draft.n}
        </span>
      ) : null}

      {draft && target ? (
        <div
          ref={boxRef}
          id="comment-pin-box"
          role="dialog"
          aria-label="Your comment"
          className={`absolute flex w-[328px] max-w-[calc(100vw-24px)] flex-col gap-2 rounded-2xl bg-white p-3 shadow-[0_8px_30px_rgba(0,0,0,0.18)] ring-1 ring-black/10 dark:bg-zinc-900 dark:ring-white/10`}
          style={{ left: boxAt.x, top: boxAt.y }}
          onDragOver={(e) => { if (Array.from(e.dataTransfer?.types || []).includes('Files')) e.preventDefault(); }}
          onDrop={onDrop}
        >
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
              title="Open in the detailed form"
              aria-label="Open in the detailed form"
              disabled={draft.sending}
              onClick={() => { void toDetailed(); }}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-white"
            >
              <ArrowsPointingOutIcon className="h-4 w-4" />
            </button>
            <button
              type="button"
              title="Discard (Esc)"
              aria-label="Discard this comment"
              disabled={draft.sending}
              onClick={discard}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-white"
            >
              <XIcon className="h-4 w-4" />
            </button>
          </div>
          <textarea
            ref={textRef}
            id="comment-pin-text"
            aria-label="Your comment"
            rows={3}
            value={draft.text}
            readOnly={draft.sending}
            onChange={(e) => update(draft.key, { text: e.target.value })}
            onKeyDown={onBoxKeyDown}
            onPaste={onPaste}
            placeholder="What should change here?"
            className="block max-h-[180px] min-h-[62px] w-full resize-none bg-transparent text-[15px] leading-snug text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100 dark:placeholder:text-zinc-500"
          />
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
            {draft.keepShot && draft.picture.base !== null ? (
              <span className="relative block h-[42px] w-[64px] shrink-0">
                {draft.picture.thumb ? (
                  <img src={draft.picture.thumb} alt="" className="h-[42px] w-[64px] rounded-lg object-cover object-left-top ring-1 ring-black/10 dark:ring-white/10" />
                ) : (
                  <span className="block h-[42px] w-[64px] animate-pulse rounded-lg bg-zinc-100 motion-reduce:animate-none dark:bg-zinc-800" />
                )}
                {/* The pin over the preview: data beside the picture, as it is posted. */}
                <span
                  aria-hidden="true"
                  className={`absolute h-[10px] w-[10px] -translate-y-full ${PIN_SHAPE} bg-violet-600 shadow-[0_0_0_1.5px_#fff]`}
                  style={{ left: `${draft.picture.pin.x * 100}%`, top: `${draft.picture.pin.y * 100}%` }}
                />
                {draft.picture.base ? (
                  <button
                    type="button"
                    aria-label="Remove the screenshot"
                    title="Remove"
                    disabled={draft.sending}
                    onClick={() => update(draft.key, { keepShot: false })}
                    className="absolute -right-2 -top-2 grid h-5 w-5 place-items-center rounded-full bg-zinc-900 text-white ring-2 ring-white dark:bg-zinc-100 dark:text-zinc-900 dark:ring-zinc-900"
                  >
                    <XIcon className="h-3 w-3" />
                  </button>
                ) : null}
              </span>
            ) : null}
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
            {count < MAX_PICTURES ? (
              <button
                type="button"
                aria-label="Attach an image"
                title="Attach an image, or paste one"
                disabled={draft.sending}
                onClick={() => fileRef.current?.click()}
                className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-lg text-zinc-500 ring-[1.5px] ring-inset ring-zinc-300 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:ring-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-white"
              >
                <PlusIcon className="h-4 w-4" />
              </button>
            ) : null}
            <span id="comment-pin-shot" className="min-w-[90px] flex-1 text-xs leading-tight text-zinc-500 dark:text-zinc-400">
              {shotLine}
              {!draft.keepShot ? (
                <>
                  {' '}
                  <button
                    type="button"
                    disabled={draft.sending || count >= MAX_PICTURES}
                    onClick={() => update(draft.key, { keepShot: true })}
                    className="font-semibold text-violet-700 hover:underline disabled:opacity-50 dark:text-violet-300"
                  >
                    Add it back
                  </button>
                </>
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
          {draft.kudos || kudosOut ? (
            <p className="text-xs leading-snug text-zinc-500 dark:text-zinc-400">
              {kudosOut
                ? (budget.limit != null ? `You've used all ${budget.limit} kudos this week.` : "You've used all your kudos this week.")
                : budget.remaining != null && budget.limit != null
                  ? `Thanks whoever solves it. Costs 1 kudos. ${budget.remaining} of ${budget.limit} left this week.`
                  : 'Thanks whoever solves it. Costs 1 kudos.'}
            </p>
          ) : null}
          {draft.error ? (
            <p id="comment-pin-error" role="alert" className="text-[13px] text-red-700 dark:text-red-400">{draft.error}</p>
          ) : null}
          <div className="flex items-center gap-1 border-t border-black/5 pt-2 dark:border-white/10">
            <button
              type="button"
              title="Attach images, or paste one"
              aria-label="Attach images"
              disabled={draft.sending || count >= MAX_PICTURES}
              onClick={() => fileRef.current?.click()}
              className="grid h-8 w-8 place-items-center rounded-full text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-40 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-white"
            >
              <PaperclipIcon className="h-4 w-4" />
            </button>
            <button
              type="button"
              id="comment-pin-kudos"
              aria-pressed={draft.kudos}
              title="Put a kudos on this to thank whoever solves it"
              disabled={draft.sending || kudosOut}
              onClick={() => update(draft.key, (d) => ({ kudos: !d.kudos }))}
              className={draft.kudos
                ? 'inline-flex h-8 items-center gap-1.5 rounded-full bg-violet-600/10 px-2.5 text-[13px] font-semibold text-violet-700 ring-1 ring-inset ring-violet-600/30 dark:text-violet-300'
                : 'inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[13px] font-semibold text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-40 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-white'}
            >
              <span aria-hidden="true">{'\u{1F44F}'}</span>
              Kudos
            </button>
            <span className="min-w-0 flex-1" />
            <span className="mr-1 hidden whitespace-nowrap text-xs text-zinc-400 sm:inline dark:text-zinc-500">Enter to post</span>
            <Button
              type="button"
              id="comment-pin-send"
              variant="pillAccent"
              size="sm"
              ink="solid"
              disabledStyle="block"
              disabled={draft.sending || !draft.text.trim()}
              onClick={() => { void send(); }}
            >
              {draft.sending ? 'Posting…' : 'Post'}
            </Button>
          </div>
        </div>
      ) : null}

      {openPin && openPoint ? (
        <div
          ref={cardRef}
          role="dialog"
          aria-label={`Comment ${openPin.n}`}
          className="absolute flex w-[300px] max-w-[calc(100vw-24px)] flex-col gap-1.5 rounded-2xl bg-white p-3 shadow-[0_8px_30px_rgba(0,0,0,0.18)] ring-1 ring-black/10 dark:bg-zinc-900 dark:ring-white/10"
          style={{ left: cardAt.x, top: cardAt.y }}
        >
          <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            <span className={`grid h-[22px] w-[22px] shrink-0 place-items-center ${PIN_SHAPE} bg-violet-600 text-[11px] font-extrabold text-white`} aria-hidden="true">{openPin.n}</span>
            <span className="min-w-0 flex-1 truncate">{openPin.place}</span>
            <button
              type="button"
              aria-label="Close"
              onClick={() => setOpen(null)}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <XIcon className="h-3.5 w-3.5" />
            </button>
          </div>
          {openPin.title ? <p className="text-[15px] font-[650] leading-snug text-zinc-900 dark:text-white">{openPin.title}</p> : null}
          <p className="line-clamp-3 whitespace-pre-wrap text-[13px] text-zinc-600 dark:text-zinc-300">{openPin.words}</p>
          <div className="mt-1 flex items-center gap-2 border-t border-black/5 pt-2 text-xs text-zinc-500 dark:border-white/10 dark:text-zinc-400">
            <span className="min-w-0 flex-1 truncate">
              {[openPin.pictures ? (openPin.pictures === 1 ? '1 image' : `${openPin.pictures} images`) : '', openPin.kudos ? 'a kudos on it' : '']
                .filter(Boolean).join(' · ')}
            </span>
            {openPin.href ? (
              <a
                href={openPin.href}
                onClick={() => onClose()}
                className="shrink-0 rounded-full bg-violet-600 px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-violet-500"
              >
                Open request
              </a>
            ) : null}
          </div>
        </div>
      ) : null}

      <div
        ref={barRef}
        tabIndex={-1}
        role="toolbar"
        aria-label="Comment mode"
        className="absolute bottom-4 left-1/2 flex max-w-[calc(100vw-24px)] -translate-x-1/2 items-center gap-2.5 whitespace-nowrap rounded-full bg-white py-1.5 pl-3.5 pr-1.5 shadow-[0_8px_30px_rgba(0,0,0,0.22)] outline-none ring-1 ring-black/10 dark:bg-zinc-900 dark:ring-white/10"
      >
        {confirmExit ? (
          <>
            <span className="min-w-0 truncate text-[13px] font-semibold text-zinc-900 dark:text-white">Discard the comment you haven't posted?</span>
            <button
              type="button"
              onClick={() => { setConfirmExit(false); textRef.current?.focus(); }}
              className="h-[34px] shrink-0 rounded-full px-3 text-sm font-semibold text-zinc-900 hover:bg-zinc-100 dark:text-white dark:hover:bg-zinc-800"
            >
              Keep writing
            </button>
            <button
              type="button"
              onClick={onClose}
              className="h-[34px] shrink-0 rounded-full bg-zinc-900 px-4 text-sm font-semibold text-white dark:bg-white dark:text-zinc-900"
            >
              Discard
            </button>
          </>
        ) : (
          <>
            <span className="inline-flex shrink-0 items-center gap-1.5 text-sm font-bold text-violet-700 dark:text-violet-300">
              <ChatIcon className="h-[18px] w-[18px]" />
              Comment mode
            </span>
            <span className="hidden min-w-0 truncate text-[13px] text-zinc-500 md:inline dark:text-zinc-400">{hint}</span>
            {postedCount ? (
              <span className="hidden shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-bold tabular-nums text-zinc-600 md:inline dark:bg-zinc-800 dark:text-zinc-300">
                {`${postedCount} posted`}
              </span>
            ) : null}
            <span className="inline-flex shrink-0 gap-0.5 rounded-full bg-zinc-100 p-[3px] dark:bg-zinc-800" role="radiogroup" aria-label="How to suggest it">
              <button
                type="button"
                role="radio"
                aria-checked="false"
                title="The detailed form"
                onClick={() => { void toDetailed(); }}
                className="inline-flex h-7 items-center gap-1.5 rounded-full pl-2 pr-2.5 text-[13px] font-semibold text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
              >
                <DescriptionIcon className="h-4 w-4" />
                Detailed
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
              className="inline-flex h-[34px] shrink-0 items-center gap-2 rounded-full bg-zinc-900 pl-4 pr-3 text-sm font-semibold text-white dark:bg-white dark:text-zinc-900"
            >
              Done
              <kbd className="rounded-[5px] px-1 font-mono text-[11px] font-semibold opacity-70 ring-1 ring-inset ring-current">Esc</kbd>
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

/**
 * Turn comment mode on. A second call while it is on does nothing. It is
 * now the way this device suggests, so "Suggest an improvement" opens it
 * next time (../improve/suggest-settings.ts).
 */
export function openCommentMode(opts: OpenOptions = {}): void {
  if (openHost || typeof document === 'undefined') return;
  const host = document.createElement('div');
  host.id = HOST_ID;
  document.body.appendChild(host);
  openHost = host;
  setSuggestMode('comment');
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
