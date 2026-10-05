/**
 * An image from a chat, full screen and inside the app (#3286).
 *
 * A picture in a message used to be a link to its file with
 * `target="_blank"`. In a browser that is a new tab, and the tab's own ✕ is
 * the way back. In the installed app there is no tab: the file opens in the
 * app's only window, full screen, with no chrome around it, and nothing on
 * the page to get out with ("if you open an image on mobile from a channel /
 * chat, no way to get out").
 *
 * So a plain tap on the thumbnail opens this instead, over the page, and
 * every way a person tries to leave it works:
 *
 *   - the ✕ in the corner, clear of the notch;
 *   - a tap anywhere around the image;
 *   - a swipe down on it, the way a phone's photo viewer lets go;
 *   - the device's Back, which claims a history record through
 *     lib/back-stack.ts rather than leaving the page under it;
 *   - Escape, on a keyboard.
 *
 * The thumbnail is still the file's link, so a modified click (a new tab on
 * purpose, from a desktop) does what it always did, and Download saves it.
 *
 * Portalled to <body>, as the message sheet is
 * (features/message-actions/action-sheet.tsx): a chat's transcript sits under
 * transformed and clipped ancestors, and a fixed layer inside them would be
 * sized to them rather than to the screen. It exists only after a tap, so the
 * prerendered document never has it.
 *
 * A request's screenshots open here too (#3908), through
 * `useInlineImageViewer` below: their markup is a sanitised string rather
 * than a thumbnail React draws, so the surface around it delegates the tap.
 */

import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { XIcon } from '@/components/ui/icons';
import { pushDismissible } from '../../lib/back-stack';

/** How far a swipe down has to travel before letting go closes the viewer. */
export const SWIPE_CLOSE_PX = 90;

/**
 * A click the viewer takes over: the primary button with no modifier. A
 * modified click keeps the link's own meaning (a new tab, a download).
 */
export function isPlainClick(event: Pick<MouseEvent, 'button' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'defaultPrevented'>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
    && !event.defaultPrevented;
}

/**
 * The thumbnail's click handler: a plain click opens the viewer in place of
 * following the link.
 */
export function openInViewer(event: ReactMouseEvent<HTMLAnchorElement>, open: () => void): void {
  if (!isPlainClick(event)) return;
  event.preventDefault();
  open();
}

/*
 * ── A request's screenshots (#3908) ───────────────────────────────────
 *
 * An issue's body and its GitHub comments are markdown the module renders
 * (`DevChat.renderMarkdown` with `images: true`), and every picture in them
 * comes out as `<a class="dc-inline-img-link" href=… target="_blank">` around
 * its `<img>`: the file's own link, which is what a chat thumbnail was before
 * #3286, and which lost the page the same way ("screenshots from issues open
 * full screen, not in a viewer, so you lose the page"). That markup is a
 * string sanitised where it is built, so it cannot carry a handler and its
 * data-* attributes are stripped. The element the surface draws around it
 * takes the tap instead: one delegated click handler that finds the
 * picture's link under it and opens the picture here.
 *
 * `data-image-viewer-scope` on that element is the marker. nav-link.js's
 * external-link router (#1312) leaves a scope's picture links alone instead
 * of handing a screenshot hosted elsewhere (a GitHub upload) to the system
 * browser before this handler runs, and a declared check selects on it.
 *
 * Only the renderer's own picture link is taken: an image the author linked
 * somewhere on purpose (`[![…](img)](url)`) is drawn without that class and
 * keeps its destination. The link stays the file, so a modified click still
 * opens it in a new tab.
 */

/** The picture link `DevChat.renderMarkdown` wraps an inline image in. */
export const INLINE_IMAGE_LINK = 'a.dc-inline-img-link';

export interface InlineImage {
  src: string;
  alt: string;
}

/**
 * The picture a click inside `scope` landed on, or null when it landed on
 * anything else. The link must be in the scope's own DOM: React bubbles a
 * portal's clicks through the component tree, and a sheet portalled to
 * <body> by a child is not this surface's to take.
 */
export function inlineImageAt(target: EventTarget | null, scope: Element | null): InlineImage | null {
  const el = target as Element | null;
  if (!el || typeof el.closest !== 'function' || !scope) return null;
  const link = el.closest(INLINE_IMAGE_LINK);
  if (!link || !scope.contains(link)) return null;
  const img = link.querySelector('img');
  // The link is the full-size file; the sanitiser drops an href it does not
  // allow, and the picture's own src is the same file.
  const src = link.getAttribute('href') || (img && img.getAttribute('src')) || '';
  if (!src) return null;
  return { src, alt: (img && img.getAttribute('alt')) || '' };
}

/**
 * The delegated half: spread `scope` on the element around the rendered
 * markdown and render `viewer` anywhere in the same component (it portals).
 * One picture at a time: the viewer has no gallery.
 */
export function useInlineImageViewer(): {
  scope: { onClick: (event: ReactMouseEvent<HTMLElement>) => void; 'data-image-viewer-scope': '' };
  viewer: ReactNode;
} {
  const [shown, setShown] = useState<InlineImage | null>(null);
  const onClick = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (!isPlainClick(event)) return;
    const image = inlineImageAt(event.target, event.currentTarget);
    if (!image) return;
    event.preventDefault();
    setShown(image);
  }, []);
  const close = useCallback(() => setShown(null), []);
  return {
    scope: { onClick, 'data-image-viewer-scope': '' },
    viewer: shown ? <ImageViewer src={shown.src} alt={shown.alt} onClose={close} /> : null,
  };
}

/**
 * Whether `src` is on another site. `download` is ignored there and the
 * browser follows the link instead, which would replace the page under the
 * viewer; such a file opens in a new tab (or, in the installed app, through
 * nav-link.js to the system browser) rather than being saved.
 */
export function isRemoteFile(src: string): boolean {
  if (typeof window === 'undefined' || !window.location) return false;
  try {
    return new URL(src, window.location.href).origin !== window.location.origin;
  } catch {
    return false;
  }
}

export function ImageViewer({ src, alt, onClose }: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // How far the image has been dragged down, while a swipe is under way.
  const [drag, setDrag] = useState(0);
  const start = useRef<{ id: number; y: number } | null>(null);

  useEffect(() => {
    // Back closes it (lib/back-stack.ts). Closed any other way, the claim is
    // handed back so the next press reaches the page underneath; closed BY
    // back, the record is already spent.
    let backed = false;
    const release = pushDismissible(() => {
      backed = true;
      onCloseRef.current();
      return true;
    });
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onCloseRef.current(); };
    document.addEventListener('keydown', onKey);
    const before = document.activeElement as HTMLElement | null;
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener('keydown', onKey);
      if (!backed) release();
      before?.focus?.({ preventScroll: true });
    };
  }, []);

  if (typeof document === 'undefined') return null;
  const name = alt || 'Image';
  // A request's screenshot can live on another site (a GitHub upload); see
  // `isRemoteFile`.
  const remote = isRemoteFile(src);
  return createPortal(
    <div
      className="fixed inset-0 z-[2200] flex items-center justify-center bg-black/90"
      role="dialog"
      aria-modal="true"
      aria-label={name}
      data-image-viewer=""
      // A tap on the dark around the picture closes it; one on the picture,
      // the bar or a control does not.
      onClick={(event) => { if (event.target === event.currentTarget) onCloseRef.current(); }}
    >
      <img
        src={src}
        alt={name}
        className="max-w-full max-h-full object-contain select-none touch-none"
        draggable={false}
        data-image-viewer-image=""
        style={drag ? { transform: `translateY(${drag}px)`, opacity: Math.max(0.4, 1 - drag / 400) } : undefined}
        onPointerDown={(event) => {
          if (event.pointerType === 'mouse') return;
          start.current = { id: event.pointerId, y: event.clientY };
        }}
        onPointerMove={(event) => {
          if (!start.current || start.current.id !== event.pointerId) return;
          setDrag(Math.max(0, event.clientY - start.current.y));
        }}
        onPointerUp={(event) => {
          if (!start.current || start.current.id !== event.pointerId) return;
          const travelled = Math.max(0, event.clientY - start.current.y);
          start.current = null;
          if (travelled >= SWIPE_CLOSE_PX) onCloseRef.current();
          else setDrag(0);
        }}
        onPointerCancel={() => { start.current = null; setDrag(0); }}
      />
      <div className="absolute inset-x-0 top-0 flex items-center justify-between gap-3 px-3 pt-[calc(env(safe-area-inset-top)+12px)]">
        <a
          href={src}
          download={alt || true}
          {...(remote ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          className="inline-flex items-center h-10 px-4 rounded-full bg-white/15 text-white text-sm font-semibold"
          data-image-viewer-download=""
        >
          {remote ? 'Open original' : 'Download'}
        </a>
        <button
          ref={closeRef}
          type="button"
          className="inline-flex items-center justify-center w-11 h-11 rounded-full bg-white/15 text-white"
          aria-label="Close"
          data-image-viewer-close=""
          onClick={() => onCloseRef.current()}
        >
          <XIcon className="w-6 h-6" aria-hidden="true" />
        </button>
      </div>
    </div>,
    document.body,
  );
}
