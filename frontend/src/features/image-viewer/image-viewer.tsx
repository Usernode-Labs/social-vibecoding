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
 */

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
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
          className="inline-flex items-center h-10 px-4 rounded-full bg-white/15 text-white text-sm font-semibold"
          data-image-viewer-download=""
        >
          Download
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
