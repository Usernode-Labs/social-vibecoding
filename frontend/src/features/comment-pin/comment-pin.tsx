/**
 * The C comment (#4289 follow-up): a pin where the pointer is, a small box
 * beside it, and Enter posts a request with a screenshot of the page that
 * shows the pin. Experimental, behind Settings, Experimental's switch
 * (../improve/suggest-shortcut.ts decides when C opens it).
 *
 * ── What it looks like ────────────────────────────────────────────────
 *
 * A layer over the whole page, so a click anywhere moves the pin there (the
 * words stay). The box sits beside the pin by the same rule the picture's
 * bubble uses (`placeBeside`), so the screenshot shows what was on screen.
 * Enter posts, Shift+Enter is a new line, Esc cancels.
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
 * Drawn the moment the box opens (./picture.ts), previewed in the box, and
 * removable: requests are public, and the person decides whether the
 * picture goes with the words. What goes up (#4482) is the CLEAN base; the
 * pin and the words travel beside it as data, and the request's page draws
 * them on top. The baked copy (`finishPicture`) is only the offline
 * handover's picture, whose dialog cannot carry pin data.
 *
 * Mounted on demand through the shell's portal registry
 * (lib/legacy-portals.tsx) into a host appended to <body>; nothing of it is
 * in the prerendered shell.
 */

import { createElement, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';

import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
import {
  describeElement, encodeUnder, finishPicture, inRect, pictureScale, placeBeside, takeBase, thumbnail,
  type Base, type ElementInfo, type Point, type Rect,
} from './picture';
import { handOver, postComment, whereLine, type CommentPin, type CommentPost, type Target } from './post';

export const HOST_ID = 'comment-pin-host';
const BOX_WIDTH = 300;

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

/** The element of the shell's own page under a point, looking through this layer. */
function shellElementAt(p: Point, host: HTMLElement): ElementInfo | null {
  const before = host.style.pointerEvents;
  host.style.pointerEvents = 'none';
  try {
    const el = document.elementFromPoint(p.x, p.y);
    return el && el.tagName === 'IFRAME' ? null : describeElement(el);
  } finally {
    host.style.pointerEvents = before;
  }
}

interface Session {
  host: HTMLElement;
  start: Point;
  app: AppTarget | null;
  frameRect: Rect | null;
  base: Promise<Base | null>;
  screen: string;
}

function clampToViewport(p: Point): Point {
  return {
    x: Math.max(0, Math.min(window.innerWidth - 1, p.x)),
    y: Math.max(0, Math.min(window.innerHeight - 1, p.y)),
  };
}

function CommentPin({ session, onClose }: { session: Session; onClose: () => void }): ReactNode {
  const [pin, setPin] = useState<Point>(session.start);
  const pinInApp = inRect(pin, session.frameRect);
  const defaultTarget: Target = pinInApp && session.app ? 'app' : 'platform';
  const [chosen, setChosen] = useState<Target | null>(null);
  const target: Target = session.app ? (chosen ?? defaultTarget) : 'platform';
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [base, setBase] = useState<Base | null | undefined>(undefined);
  const [thumb, setThumb] = useState('');
  const [keepShot, setKeepShot] = useState(true);
  const [boxAt, setBoxAt] = useState<Point>({ x: -9999, y: -9999 });
  const boxRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let live = true;
    session.base.then((b) => {
      if (!live) return;
      setBase(b);
      if (b) {
        try { setThumb(thumbnail(b.canvas)); } catch { /* no preview, still attached */ }
      }
    }, () => { if (live) setBase(null); });
    return () => { live = false; };
  }, [session]);

  useEffect(() => { textRef.current?.focus(); }, []);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const size = { width: box.offsetWidth || BOX_WIDTH, height: box.offsetHeight || 160 };
    setBoxAt(placeBeside(pin, size, { width: window.innerWidth, height: window.innerHeight }));
  }, [pin, error, thumb, base, session.app]);

  const send = useCallback(async () => {
    const words = text.trim();
    if (!words || sending) return;
    setSending(true);
    setError('');
    // The element under the pin: the app's own answer while the pin is
    // where it was asked about; the shell's page, read through this layer.
    let at: ElementInfo | null = null;
    if (pinInApp) {
      const asked = session.start;
      const same = Math.abs(asked.x - pin.x) < 2 && Math.abs(asked.y - pin.y) < 2;
      at = same ? base?.app?.at ?? null : null;
    } else {
      at = shellElementAt(pin, session.host);
    }
    const screen = pinInApp ? (base?.app?.path || '') : session.screen;
    // #4482: the upload is the CLEAN base; the pin and the words travel
    // beside it as data. The baked copy is kept only for the offline
    // handover, whose dialog cannot carry pin data.
    let picture: Blob | null = null;
    let pinData: CommentPin | null = null;
    if (keepShot && base) {
      try { picture = await encodeUnder(base.canvas); } catch { picture = null; }
      if (picture) {
        pinData = { x: Math.round(pin.x * base.scale), y: Math.round(pin.y * base.scale), comment: words };
      }
    }
    const post: CommentPost = {
      text: words,
      target,
      appSlug: session.app?.slug ?? null,
      picture,
      where: whereLine({ inApp: pinInApp, screen, at }),
      pin: pinData,
    };
    const outcome = await postComment(post);
    if (outcome.ok) {
      onClose();
      const name = target === 'app' && session.app ? session.app.name : 'Homeroom';
      const line = outcome.botWillBuild
        ? `Posted to ${name}. Homeroom bot is building it.`
        : `Posted to ${name}. Thanks!`;
      (window as unknown as { PlatformUI?: { toast?: (m: string) => void } }).PlatformUI?.toast?.(line);
      return;
    }
    if (outcome.handover) {
      onClose();
      handOver(post);
      return;
    }
    setSending(false);
    setError(outcome.error);
  }, [text, sending, pinInApp, pin, base, keepShot, target, session, onClose]);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (!sending) onClose();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.target === textRef.current) {
      e.preventDefault();
      void send();
    }
  };

  const shotLine = !keepShot
    ? 'No screenshot.'
    : base === undefined
      ? 'Taking a screenshot…'
      : base
        ? 'Screenshot of this page'
        : "Couldn't take a screenshot. Your words still go.";

  return (
    <div
      id="comment-pin"
      role="dialog"
      aria-modal="true"
      aria-label="Comment on this page"
      // A press here moves the pin and keeps the comment's own field
      // focused (its mousedown is prevented), so a tap keeps the keyboard
      // too (tests/keyboard-dismiss.test.js).
      data-keep-keyboard=""
      className="fixed inset-0 cursor-crosshair"
      style={{ zIndex: 2147483000 }}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => {
        if (sending || e.button !== 0) return;
        if (boxRef.current && boxRef.current.contains(e.target as Node)) return;
        e.preventDefault();
        setPin(clampToViewport({ x: e.clientX, y: e.clientY }));
        textRef.current?.focus();
      }}
    >
      <span
        aria-hidden="true"
        data-comment-pin-dot=""
        className="absolute block h-[22px] w-[22px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-white bg-violet-600 shadow-[0_1px_6px_rgba(0,0,0,0.35)]"
        style={{ left: pin.x, top: pin.y }}
      />
      <div
        ref={boxRef}
        id="comment-pin-box"
        className="absolute w-[300px] cursor-auto rounded-2xl bg-white p-3 shadow-[0_8px_30px_rgba(0,0,0,0.18)] ring-1 ring-black/10 dark:bg-zinc-900 dark:ring-white/10"
        style={{ left: boxAt.x, top: boxAt.y }}
      >
        <textarea
          ref={textRef}
          id="comment-pin-text"
          aria-label="Your comment"
          rows={3}
          value={text}
          readOnly={sending}
          onChange={(e) => setText(e.target.value)}
          placeholder="What should change here?"
          className="block w-full resize-none bg-transparent text-[15px] leading-snug text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100 dark:placeholder:text-zinc-500"
        />
        <div className="mt-2 flex items-center gap-2 text-[13px] text-zinc-500 dark:text-zinc-400">
          {thumb && keepShot ? (
            <img src={thumb} alt="" className="h-9 w-14 shrink-0 rounded-md object-cover ring-1 ring-black/10 dark:ring-white/10" />
          ) : null}
          <span id="comment-pin-shot" className="min-w-0 flex-1 leading-tight">{shotLine}</span>
          {base ? (
            <button
              type="button"
              className="shrink-0 text-[13px] font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white"
              onClick={() => setKeepShot((k) => !k)}
              disabled={sending}
            >
              {keepShot ? 'Remove' : 'Add back'}
            </button>
          ) : null}
        </div>
        {session.app ? (
          <div className="mt-2 flex items-center gap-1.5 text-[13px]" role="radiogroup" aria-label="Where it goes">
            <span className="mr-0.5 text-zinc-500 dark:text-zinc-400">To</span>
            {([['app', session.app.name], ['platform', 'Homeroom']] as Array<[Target, string]>).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={target === value}
                id={`comment-pin-to-${value}`}
                disabled={sending}
                onClick={() => setChosen(value)}
                className={target === value
                  ? 'max-w-[130px] truncate rounded-full bg-zinc-200 px-2.5 py-1 font-medium text-zinc-900 dark:bg-zinc-700 dark:text-white'
                  : 'max-w-[130px] truncate rounded-full px-2.5 py-1 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800'}
              >
                {label}
              </button>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-[13px] text-zinc-500 dark:text-zinc-400">To Homeroom</p>
        )}
        {error ? (
          <p id="comment-pin-error" role="alert" className="mt-2 text-[13px] text-red-700 dark:text-red-400">{error}</p>
        ) : null}
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-xs text-zinc-500 dark:text-zinc-400">Enter to post. Esc to cancel.</span>
          <Button
            type="button"
            id="comment-pin-send"
            variant="pillAccent"
            size="sm"
            ink="solid"
            disabledStyle="block"
            disabled={sending || !text.trim()}
            onClick={() => { void send(); }}
          >
            {sending ? 'Posting…' : 'Post'}
          </Button>
        </div>
      </div>
    </div>
  );
}

let open: HTMLElement | null = null;

export function commentPinOpen(): boolean {
  return !!open;
}

/**
 * Open the comment with its pin at `point` (the viewport position of the
 * pointer, or the middle of the screen when nobody has moved it). Starts
 * drawing the page at once. A second call while one is open does nothing.
 */
export function openCommentPin(point: Point | null): void {
  if (open || typeof document === 'undefined') return;
  const host = document.createElement('div');
  host.id = HOST_ID;
  document.body.appendChild(host);
  open = host;

  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const start = clampToViewport(point ?? { x: viewport.width / 2, y: viewport.height / 2 });
  const app = appTarget();
  const shown = visibleAppFrame();
  const scale = pictureScale(window.devicePixelRatio, viewport);
  const base = takeBase({
    host,
    scale,
    frame: shown?.frame ?? null,
    frameRect: shown?.rect ?? null,
    pin: start,
  });
  base.catch(() => { /* the box says so */ });

  const session: Session = {
    host,
    start,
    app,
    frameRect: shown?.rect ?? null,
    base,
    screen: (location.hash || '#home').split('?')[0].slice(0, 120),
  };
  const close = () => {
    if (open !== host) return;
    unmountLegacyPortal(host);
    host.remove();
    open = null;
  };
  mountLegacyPortal(host, createElement(CommentPin, { session, onClose: close }));
}
