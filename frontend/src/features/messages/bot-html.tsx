/**
 * A HOMEROOM BOT ANSWER, LAID OUT (task 2020, from the owner's task-assistant
 * v1). For a reply longer than two short lines the bot also writes the same
 * answer as a small HTML fragment (src/services/homeroom-bot-html.js): short
 * headings, lists, steps, a table, option cards, a timeline, a small inline
 * SVG diagram. The chat draws it here, in place of the words. The words stay
 * the message: the inbox, the bell, Copy, search and Translate read them, and
 * they are what is drawn whenever the fragment cannot be.
 *
 * ── Cleaned, then framed ──────────────────────────────────────────────
 *
 * The fragment is the model's, so it is held three ways:
 *
 *   1. Cleaned with the vendored DOMPurify (`cleanReplyHtml`): no script,
 *      handler, form, control, frame, object, media, link, meta or base, no
 *      SVG animation; a link keeps only an http(s) address or one of this
 *      site's paths, and opens as a link in the chat's words does. Anything
 *      that would load from an address (an image, an @import, a url() in a
 *      style, an SVG reference) is taken out too, so the policy below never
 *      has to refuse it: a refusal is a console error on the chat's page.
 *   2. Drawn in a frame with scripts OFF (`REPLY_SANDBOX`: no allow-scripts,
 *      no forms, no top navigation) whose content security policy loads
 *      nothing (`replyCsp`): no image, font, stylesheet or request from
 *      anywhere but this site's own font and data: URLs. A style in it can
 *      only paint inside the frame's box, so it cannot lay anything over
 *      the chat.
 *   3. Coloured by the chat's own tokens (`REPLY_TOKENS`), read off the
 *      bubble when the frame is drawn and again when the theme changes, so
 *      the fragment is in the chat's light and dark and its font.
 *
 * The frame is same-origin (allow-same-origin) only so this side can measure
 * it and read what was tapped. Nothing runs in it to make use of that.
 *
 * ── The row keeps its gestures ────────────────────────────────────────
 *
 * The frame takes no pointer events. A press on it is the row's, so a long
 * press still opens the message's sheet and a drag still scrolls the chat; a
 * tap is looked up in the frame (`elementFromPoint`) and a link there is
 * opened by a link of the chat's own, so the shell's handlers (the app's
 * system-browser road, NavLink) treat it as they treat a link in the words.
 * A summary toggles its details. A link reached with the keyboard or a screen
 * reader is activated inside the frame, and that click is forwarded the same
 * way.
 *
 * ── Size ──────────────────────────────────────────────────────────────
 *
 * Until the frame has been measured the words are drawn, so the bubble is
 * never empty; the frame waits behind them, laid out at the bubble's width.
 * Its measured height is kept for the visit (`HEIGHTS`), so a row drawn again
 * opens at its size.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';

import { useMessages } from '../../lib/i18n/react';
import type { ConversationMessage } from './types';

/** The colour names the fragment is written with (homeroom-bot-mayor.js REPLY_HTML_DESCRIPTION), each set from a token of the chat's, with a light fallback. */
export const REPLY_TOKENS: ReadonlyArray<readonly [name: string, token: string, fallback: string]> = Object.freeze([
  ['--ink', '--text-primary', '#0a0a0a'],
  ['--ink-2', '--text-secondary', '#3a3a3c'],
  ['--muted', '--text-muted', '#68686c'],
  ['--line', '--messages-hair', '#e3e3e6'],
  ['--surface', '--messages-surface', '#ffffff'],
  ['--surface-2', '--messages-surface-2', '#f5f5f7'],
  ['--accent', '--accent', '#0a6ee0'],
  ['--accent-tint', '--accent-tint', 'rgba(10, 110, 224, 0.08)'],
  ['--green', '--state-ok', '#15803d'],
  ['--red', '--state-blocked', '#dc2626'],
  ['--orange', '--state-admin', '#b45309'],
] as const);

/** Scripts off: same-origin only so the chat can measure the frame and read a tap; popups so a link can open. */
export const REPLY_SANDBOX = 'allow-same-origin allow-popups allow-popups-to-escape-sandbox';

/** The content security policy the fragment is drawn under: nothing loads but this site's font and data: URLs. */
export function replyCsp(origin: string): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    'img-src data:',
    `font-src data: ${origin}`,
    "script-src 'none'",
    "connect-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

// What DOMPurify keeps: HTML and SVG, a <style> block, less everything that
// would load, submit, play, animate or look tappable without being a link.
const FORBID_TAGS = Object.freeze([
  'form', 'input', 'button', 'select', 'option', 'optgroup', 'textarea', 'datalist', 'output', 'progress', 'meter',
  'iframe', 'frame', 'frameset', 'object', 'embed', 'portal', 'link', 'meta', 'base',
  'video', 'audio', 'source', 'track', 'picture', 'canvas', 'dialog', 'template', 'slot', 'noscript', 'script',
  'animate', 'animateMotion', 'animateTransform', 'set', 'discard',
]);
export const REPLY_PURIFY = Object.freeze({
  USE_PROFILES: { html: true, svg: true, svgFilters: true },
  ADD_TAGS: ['style'],
  FORBID_TAGS,
  // A leading <style> block is kept (DOMPurify drops one before any body content otherwise).
  FORCE_BODY: true,
  RETURN_DOM_FRAGMENT: true,
});

/** Pure: an address a link in the fragment may keep: http(s), or a path on this site. The same rule as a link in the words (dev-chat.js). */
export function linkable(href: string | null | undefined): boolean {
  const value = String(href || '').trim();
  return /^https?:\/\//i.test(value) || /^\/[^/]/.test(value);
}

type Purify = { sanitize(html: string, config: Record<string, unknown>): unknown };

// An address the frame would be refused (anything but data:) is taken out
// before it is drawn: the policy blocks it anyway, but a blocked load is a
// console error on the chat's page, and the platform's checks fail on one.
const OUTSIDE_URL_RE = /url\(\s*(['"]?)(?!data:)[^)]*?\1\s*\)/gi;
const IMPORT_RE = /@import\b[^;]*;?/gi;
/** Pure: a stylesheet or style attribute with nothing in it that would load from an address. */
export function withoutOutsideUrls(css: string): string {
  return String(css || '').replace(IMPORT_RE, '').replace(OUTSIDE_URL_RE, 'none');
}
const isData = (value: string | null) => /^\s*data:/i.test(value || '');

/**
 * The fragment, cleaned (see the head of this file), as markup; null when
 * there is no cleaner on the page or nothing is left to draw, and the words
 * are drawn instead.
 */
export function cleanReplyHtml(html: string): string | null {
  if (typeof window === 'undefined' || typeof document === 'undefined' || typeof html !== 'string' || !html.trim()) return null;
  const purify = (window as unknown as { DOMPurify?: Purify }).DOMPurify;
  if (!purify || typeof purify.sanitize !== 'function') return null;
  let out: unknown;
  try {
    out = purify.sanitize(html, { ...REPLY_PURIFY });
  } catch {
    return null;
  }
  if (!out || typeof (out as DocumentFragment).querySelectorAll !== 'function') return null;
  const fragment = out as DocumentFragment;
  // Nothing that loads from an address (see OUTSIDE_URL_RE).
  for (const el of Array.from(fragment.querySelectorAll('style'))) el.textContent = withoutOutsideUrls(el.textContent || '');
  for (const el of Array.from(fragment.querySelectorAll('[style]'))) el.setAttribute('style', withoutOutsideUrls(el.getAttribute('style') || ''));
  for (const el of Array.from(fragment.querySelectorAll('img'))) {
    el.removeAttribute('srcset');
    if (!isData(el.getAttribute('src'))) el.remove();
  }
  for (const el of Array.from(fragment.querySelectorAll('image, feImage'))) {
    if (!isData(el.getAttribute('href') || el.getAttribute('xlink:href'))) el.remove();
  }
  for (const el of Array.from(fragment.querySelectorAll('use'))) {
    for (const name of ['href', 'xlink:href']) {
      const ref = el.getAttribute(name);
      if (ref && !ref.trim().startsWith('#')) el.removeAttribute(name);
    }
  }
  for (const a of Array.from(fragment.querySelectorAll('a'))) {
    const href = a.getAttribute('href') || a.getAttribute('xlink:href');
    a.removeAttribute('xlink:href');
    if (linkable(href)) {
      a.setAttribute('href', String(href).trim());
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    } else {
      a.removeAttribute('href');
      a.removeAttribute('target');
    }
  }
  const box = document.createElement('div');
  box.appendChild(fragment);
  const markup = box.innerHTML.trim();
  const shows = !!box.textContent?.trim() || !!box.querySelector('svg, img, table, hr');
  return markup && shows ? markup : null;
}

/** How the chat looks where the fragment is drawn: its colour tokens, light or dark, and its font. */
export interface ReplyLook {
  vars: Record<string, string>;
  dark: boolean;
  font: string;
  size: string;
}

/** The look read off `el` (the bubble's own box), so the frame matches the bubble it is in. */
export function lookOf(el: Element): ReplyLook {
  const style = getComputedStyle(el);
  const vars: Record<string, string> = {};
  for (const [name, token, fallback] of REPLY_TOKENS) vars[name] = style.getPropertyValue(token).trim() || fallback;
  return {
    vars,
    dark: document.documentElement.classList.contains('dark'),
    font: style.fontFamily || 'ui-sans-serif, system-ui, sans-serif',
    size: style.fontSize || '17px',
  };
}

// A value read from the page's own stylesheet, kept to what a declaration may hold.
const cssValue = (value: string) => String(value).replace(/[<>{};]/g, '');

// The fragment's own small stylesheet: the chat's rhythm, before the fragment's styles.
const BASE_CSS = [
  'html,body{margin:0;padding:0;background:transparent}',
  // break-word, not anywhere: a table's columns still size to their words.
  '.reply{display:flow-root;overflow-x:auto;overflow-wrap:break-word}',
  '.reply>:first-child,.reply>style:first-child+*{margin-top:0}.reply>:last-child{margin-bottom:0}',
  'p{margin:0 0 .6em}',
  'h1,h2,h3,h4,h5,h6{margin:.9em 0 .35em;font-size:1em;font-weight:650;line-height:1.3}',
  // A numbered list's markers sit in its indent: room for "10." and on.
  'ul,ol{margin:0 0 .6em;padding-inline-start:1.3em}ol{padding-inline-start:2em}li{margin:.15em 0}',
  // A link whose address was taken out is words, and looks it.
  'a[href]{color:var(--accent);text-decoration:underline;text-underline-offset:2px}a:not([href]){color:inherit;text-decoration:none}',
  'table{border-collapse:collapse;width:100%;margin:0 0 .6em;font-size:.875em}',
  'th,td{text-align:start;vertical-align:top;padding:6px 8px;border-bottom:1px solid var(--line)}',
  'th{color:var(--muted);font-size:.8em;font-weight:700;letter-spacing:.06em;text-transform:uppercase}',
  'img,svg{max-width:100%;height:auto}',
  'code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}',
  'hr{border:0;border-top:1px solid var(--line);margin:.8em 0}',
  'summary{cursor:pointer}',
].join('');

/** Pure: the document the cleaned fragment is drawn in. `origin` is this site's. */
export function replyFrameDoc(clean: string, look: ReplyLook, origin: string): string {
  const vars = Object.entries(look.vars).map(([name, value]) => `${name}:${cssValue(value)}`).join(';');
  const font = cssValue(look.font);
  // The brand skin's Geist is this site's own file; the frame does not inherit the page's @font-face.
  const face = /\bgeist\b/i.test(font)
    ? `@font-face{font-family:'Geist';src:url('${cssValue(origin)}/fonts/geist/Geist-Variable.woff2') format('woff2');font-weight:100 900;font-style:normal;font-display:swap}`
    : '';
  const csp = replyCsp(origin).replace(/"/g, '&quot;');
  return '<!doctype html><html><head><meta charset="utf-8">'
    + `<meta http-equiv="Content-Security-Policy" content="${csp}">`
    + `<style>${face}:root{${vars};color-scheme:${look.dark ? 'dark' : 'light'}}`
    + `body{color:var(--ink);font-family:${font};font-size:${cssValue(look.size)};line-height:1.4}`
    + `${BASE_CSS}</style></head><body><div class="reply" dir="auto">${clean}</div></body></html>`;
}

/** The laid-out copy of a Homeroom bot chat answer, when it has one to draw. */
export function botReplyHtml(message: ConversationMessage): string | null {
  const meta = message.sender.bot ? message.metadata?.homeroomBot : null;
  return meta?.kind === 'chat' && typeof meta.html === 'string' && meta.html.trim() ? meta.html : null;
}

// How the page looks right now, as a key: a change of theme, skin, text size
// or contrast draws the frame again with the new tokens.
const LOOK_ATTRS = ['class', 'data-skin', 'data-text-size', 'data-contrast', 'data-app-tone'];
function lookKey(): string {
  if (typeof document === 'undefined') return '';
  const root = document.documentElement;
  return LOOK_ATTRS.map((name) => root.getAttribute(name) || '').join('|');
}
function useLookKey(): string {
  const [key, setKey] = useState(lookKey);
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return undefined;
    const observer = new MutationObserver(() => setKey(lookKey()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: LOOK_ATTRS });
    return () => observer.disconnect();
  }, []);
  return key;
}

// A fragment's measured height, for this visit, so a row drawn again opens at its size.
const HEIGHTS = new Map<string, number>();
// Taller than this, it scrolls inside its frame.
export const MAX_REPLY_HEIGHT = 2400;

/** Opens `href` as a link in the chat's words would: a real anchor of the chat's own, clicked. */
function openAsLink(host: HTMLElement, href: string, like: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; button?: number }): void {
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.hidden = true;
  host.appendChild(a);
  try {
    a.dispatchEvent(new window.MouseEvent('click', {
      bubbles: true, cancelable: true, view: window,
      metaKey: !!like.metaKey, ctrlKey: !!like.ctrlKey, shiftKey: !!like.shiftKey, altKey: !!like.altKey, button: like.button || 0,
    }));
  } finally {
    a.remove();
  }
}

/** The link or summary a tap at (x, y) on the page lands on inside `frame`, if any. */
function tappedIn(frame: HTMLIFrameElement, x: number, y: number): Element | null {
  const doc = frame.contentDocument;
  if (!doc) return null;
  const box = frame.getBoundingClientRect();
  const hit = doc.elementFromPoint(x - box.left, y - box.top);
  return hit?.closest?.('a[href], summary') || null;
}

/**
 * The answer laid out. `fallback` is the words as the chat draws them: shown
 * until the frame is measured, and in its place when the fragment cannot be
 * cleaned (no DOMPurify on the page, or nothing left to draw).
 */
export function BotHtmlReply({ html, fallback, className = '', onSized }: {
  html: string;
  fallback: ReactNode;
  className?: string;
  /** Told each height the frame is drawn at, so a box around it (a thread's fold) can measure again. */
  onSized?: (height: number) => void;
}) {
  const t = useMessages('messages');
  const clean = useMemo(() => cleanReplyHtml(html), [html]);
  const host = useRef<HTMLDivElement | null>(null);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const look = useLookKey();
  const [doc, setDoc] = useState<string | null>(null);
  const [height, setHeight] = useState<number>(() => HEIGHTS.get(html) || 0);

  // Before the first paint, so the frame is drawn with the bubble's own tokens.
  useLayoutEffect(() => {
    if (!clean || !host.current) return;
    setDoc(replyFrameDoc(clean, lookOf(host.current), window.location.origin));
  }, [clean, look]);

  // Measured once it has loaded, again when its font arrives and when the bubble's width changes.
  useEffect(() => {
    const el = frame.current;
    const box = host.current;
    if (!doc || !el || !box) return undefined;
    let live = true;
    const timers: number[] = [];
    const measure = () => {
      if (!live) return;
      const reply = el.contentDocument?.querySelector('.reply');
      if (!reply) return;
      const h = Math.min(MAX_REPLY_HEIGHT, Math.max(16, Math.ceil(reply.getBoundingClientRect().height)));
      HEIGHTS.set(html, h);
      setHeight((was) => (was === h ? was : h));
    };
    // A link reached with the keyboard or a screen reader is activated in the frame.
    const onFrameClick = (event: Event) => {
      const target = event.target as Element | null;
      const a = target?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a) return;
      event.preventDefault();
      openAsLink(box, a.getAttribute('href') || '', event as unknown as globalThis.MouseEvent);
    };
    let wired: Document | null = null;
    const onLoad = () => {
      measure();
      const inner = el.contentDocument;
      if (inner && inner !== wired) {
        wired?.removeEventListener('click', onFrameClick);
        inner.addEventListener('click', onFrameClick);
        wired = inner;
        inner.fonts?.ready?.then(measure).catch(() => {});
      }
      timers.push(window.setTimeout(measure, 300));
    };
    el.addEventListener('load', onLoad);
    if (el.contentDocument?.readyState === 'complete' && el.contentDocument.querySelector('.reply')) onLoad();
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measure());
    resize?.observe(box);
    return () => {
      live = false;
      el.removeEventListener('load', onLoad);
      wired?.removeEventListener('click', onFrameClick);
      resize?.disconnect();
      for (const id of timers) window.clearTimeout(id);
    };
  }, [doc, html]);

  // A box around it measures again once the frame has its size.
  useEffect(() => {
    if (height > 0) onSized?.(height);
  }, [height, onSized]);

  if (!clean) return <>{fallback}</>;

  // A tap on the answer: a link in it opens, a summary toggles. Anything else is the row's.
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const el = frame.current;
    if (!el || !height || !host.current) return;
    const hit = tappedIn(el, event.clientX, event.clientY);
    if (!hit) return;
    event.preventDefault();
    if (hit.matches('summary')) {
      const details = hit.parentElement;
      if (details && details.tagName.toLowerCase() === 'details') {
        details.toggleAttribute('open');
        window.setTimeout(() => {
          const reply = el.contentDocument?.querySelector('.reply');
          if (!reply) return;
          const h = Math.min(MAX_REPLY_HEIGHT, Math.max(16, Math.ceil(reply.getBoundingClientRect().height)));
          HEIGHTS.set(html, h);
          setHeight(h);
        }, 0);
      }
      return;
    }
    openAsLink(host.current, hit.getAttribute('href') || '', event);
  };
  // A pointer over a link shows it is one.
  const onMove = (event: MouseEvent<HTMLDivElement>) => {
    const el = frame.current;
    if (!el || !host.current || !height) return;
    host.current.style.cursor = tappedIn(el, event.clientX, event.clientY) ? 'pointer' : '';
  };

  const measured = height > 0;
  // The frame's element and its document name the same scheme, or a browser
  // paints the frame opaque instead of letting the bubble show through.
  const scheme = typeof document !== 'undefined' && document.documentElement.classList.contains('dark') ? 'dark' : 'light';
  return (
    <div ref={host} className={className ? `messages-bot-html relative ${className}` : 'messages-bot-html relative'} data-bot-html={measured ? 'drawn' : 'waiting'} onClick={onClick} onMouseMove={onMove}>
      {/* The words, until the frame has its size: never an empty bubble. */}
      {measured ? null : fallback}
      {doc ? (
        <iframe
          ref={frame}
          title={t('messages:row.botHtml.frameTitle')}
          sandbox={REPLY_SANDBOX}
          referrerPolicy="no-referrer"
          srcDoc={doc}
          className={measured ? 'block w-full border-0 bg-transparent' : 'pointer-events-none absolute inset-x-0 top-0 block w-full border-0 bg-transparent opacity-0'}
          style={{ height: measured ? height : 1, pointerEvents: 'none', colorScheme: scheme }}
          aria-hidden={measured ? undefined : true}
          tabIndex={measured ? undefined : -1}
        />
      ) : null}
    </div>
  );
}
