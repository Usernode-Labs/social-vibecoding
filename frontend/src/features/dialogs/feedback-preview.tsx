/**
 * An attached picture or clip, full size, before the request is posted
 * (#5687).
 *
 * The screenshot row in "Suggest an improvement" shows a thumbnail you
 * cannot check: a 56px square is enough to recognise a file, not to see
 * whether the annotation you meant to mark is in it. A tap on the thumbnail
 * now opens the file here, over the form, and the form is still behind it
 * with everything typed.
 *
 * It copies the frame of the chat's image viewer
 * (features/image-viewer/image-viewer.tsx): the same dark backdrop, the same
 * ✕ clear of the notch, Back claimed through lib/back-stack.ts. It is a
 * separate, smaller component for three reasons that viewer cannot carry:
 *
 *   - Download would offer a file that is already on the device;
 *   - a clip opens with the device's own controls instead of as a picture;
 *   - an image handed over from comment mode keeps its pins (#4482), drawn
 *     here at full size in the same places as on the thumbnail.
 *
 * It is portalled to <body> and rendered BESIDE the dialog root, never
 * inside it (feedback.tsx): React bubbles a portal's events through the
 * component tree, and a click on the dark around the picture would otherwise
 * reach the dialog's own backdrop handler and close the form too. Escape is
 * handed over by the shell's own guard in frontend/src/head.html, which is
 * registered before the native kit's listener and stops the press there:
 * the kit would otherwise dismiss the feedback dialog behind the preview.
 * Closing the preview never closes the form.
 *
 * It exists only after a tap (its state starts at null), so the prerendered
 * shell never has it and there is nothing to hydrate.
 */

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { XIcon } from '@/components/ui/icons';
import { pushDismissible } from '../../lib/back-stack';
import { useMessages } from '../../lib/i18n/react';

export interface FeedbackPreviewItem {
  kind: 'image' | 'video';
  src: string;
  /** The thumbnail's own alt, so the viewer is announced like it was. */
  alt?: string;
  /** Comment mode's pins (#4482): { x, y, n, note } as fractions of the picture. */
  pins?: Array<{ x: number; y: number }> | null;
}

export function FeedbackPreview({ item, onClose }: {
  item: FeedbackPreviewItem;
  onClose: () => void;
}) {
  const t = useMessages('dialogs');
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    // Back closes the preview, not the page under it (lib/back-stack.ts).
    let backed = false;
    const release = pushDismissible(() => {
      backed = true;
      onCloseRef.current();
      return true;
    });
    // The head's guard (head.html) takes Escape ahead of the kit's listener
    // and hands it here, so only the picture closes.
    const onEscape = () => onCloseRef.current();
    window.addEventListener('feedback-preview:escape', onEscape);
    // The thumbnail had focus when it was tapped; it gets it back when the
    // preview closes.
    const before = document.activeElement as HTMLElement | null;
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener('feedback-preview:escape', onEscape);
      if (!backed) release();
      before?.focus?.({ preventScroll: true });
    };
  }, []);

  if (typeof document === 'undefined') return null;
  const label = item.kind === 'video'
    ? t('dialogs:feedback.video.previewLabel')
    : (item.alt || t('dialogs:feedback.screenshot.previewAlt', { number: 1 }));
  // Above the native kit's modal shell (native.css: backdrop 9990, card
  // 9992) and its feedback pill (9995): the form's own card is lifted into
  // that shell, so the chat viewer's 2200 would paint under it.
  return createPortal(
    <div
      className="fixed inset-0 z-[9996] flex items-center justify-center bg-black/90"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      data-feedback-preview=""
      // A tap on the dark around the file closes it; one on the file or a
      // control does not. stopPropagation keeps the dialog's backdrop rule
      // out of it even where a portal's path would carry it there.
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        event.stopPropagation();
        onCloseRef.current();
      }}
    >
      {item.kind === 'video' ? (
        <video
          src={item.src}
          controls
          playsInline
          className="max-w-full max-h-full"
          data-feedback-preview-video=""
        />
      ) : (
        <span className="relative inline-block">
          <img
            src={item.src}
            alt={item.alt || ''}
            className="block max-w-[100vw] max-h-[100dvh] object-contain select-none"
            draggable={false}
            data-feedback-preview-image=""
          />
          {(item.pins || []).map((pin, i) => (
            <span
              // Pins have no id of their own and never move; the position is
              // the whole of them.
              key={`${pin.x}:${pin.y}:${i}`}
              aria-hidden="true"
              className="absolute h-4 w-4 -translate-y-full rounded-[50%_50%_50%_0] bg-violet-600 shadow-[0_0_0_1.5px_#fff]"
              style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%` }}
            />
          ))}
        </span>
      )}
      <div className="absolute inset-x-0 top-0 flex items-center justify-end gap-3 px-3 pt-[calc(env(safe-area-inset-top)+12px)]">
        <button
          ref={closeRef}
          type="button"
          className="inline-flex items-center justify-center w-11 h-11 rounded-full bg-white/15 text-white"
          aria-label={t('core:common.close')}
          data-feedback-preview-close=""
          onClick={() => onCloseRef.current()}
        >
          <XIcon className="w-6 h-6" aria-hidden="true" />
        </button>
      </div>
    </div>,
    document.body,
  );
}
