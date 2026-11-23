/**
 * A COMMENT PINNED ON A LIVE DRAFT'S PREVIEW (20 Nov 2026, live-draft review J).
 *
 * The preview header's Comment turns on the platform's comment mode
 * (../comment-pin/), which takes a picture of the whole screen and files a
 * request on the app. For a change up for a vote that is right. For a live
 * draft, which Homeroom bot is changing with its author in a private thread,
 * it is not: the comment belongs to that thread. So while the preview is a
 * live draft's, Comment works the way a design's pane does
 * (../messages/design-pane.tsx): only the app's frame becomes clickable (a
 * layer over it, inside the preview; the rest of the screen stays as it is),
 * a click drops a pin with a box for the words, and Send posts them in the
 * draft's thread as the person's message, carrying the pin
 * (metadata.previewPin: the point as fractions of the frame, the route the
 * app was on, the frame's size, and the element under it), which the bot's
 * next turn reads (services/live-drafts.js pinLine).
 *
 * The app's frame is another origin, so the element and the route come from
 * the bridge every app already loads, which answers the platform's own
 * snapshot request with the element under a point and the page's path
 * (../comment-pin/picture.ts requestAppPicture). No script is added to any
 * app. An app that does not answer in time is commented on without them.
 *
 * Nothing renders until Comment is pressed, so the first render adds nothing
 * to the overlay's prerendered markup.
 */

import { useEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from 'react';

import { useMessages } from '../../lib/i18n/react';
import { requestAppPicture } from '../comment-pin/picture';
import * as api from '../messages/api';
import { loadReplyThread } from '../messages/store';
import type { LiveDraft } from '../messages/live-draft-bar';
import { stagingRefs } from './staging-store.js';

/** How long the app's bridge is given to say what is under the pin. */
export const ELEMENT_TIMEOUT_MS = 4000;

// Whether the pin layer is on: one switch, the header's Comment and this
// layer both read it.
let on = false;
const listeners = new Set<() => void>();
function set(next: boolean) {
  if (next === on) return;
  on = next;
  listeners.forEach((fn) => fn());
}
export function togglePreviewPins(): void { set(!on); }
export function stopPreviewPins(): void { set(false); }
export function usePreviewPins(): boolean {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    () => on,
    () => false,
  );
}

/** Pure: a press's point inside the layer, as fractions of it, or null outside it. */
export function pinPoint(press: { x: number; y: number }, box: { left: number; top: number; width: number; height: number }): { x: number; y: number } | null {
  if (!(box.width > 0) || !(box.height > 0)) return null;
  const x = (press.x - box.left) / box.width;
  const y = (press.y - box.top) / box.height;
  if (!(x >= 0 && x <= 1) || !(y >= 0 && y <= 1)) return null;
  return { x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000 };
}

/** Pure: the route a bridge's path names, or undefined (never the query: the platform's token rides there). */
export function pinRoute(path: string | null | undefined): string | undefined {
  const p = String(path || '');
  return p.startsWith('/') && !p.startsWith('//') ? p.slice(0, 300) : undefined;
}

interface Pin {
  x: number;
  y: number;
  route?: string;
  viewport?: { width: number; height: number };
  element?: { tag: string; id: string; text: string };
  /** The bridge has not answered yet. */
  asking: boolean;
}

function key(): string {
  return `preview-pin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function PreviewPinLayer({ draft }: { draft: LiveDraft | null }): ReactNode {
  const t = useMessages('messages');
  const active = usePreviewPins();
  const layer = useRef<HTMLDivElement>(null);
  const [pin, setPin] = useState<Pin | null>(null);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(0);

  // Off, or another draft: no pin left half-written.
  useEffect(() => { if (!active) { setPin(null); setNote(''); setError(null); } }, [active]);
  useEffect(() => () => stopPreviewPins(), [draft?.id]);
  // Escape puts the pin away, then the mode.
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (pin) { setPin(null); setNote(''); } else stopPreviewPins();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [active, pin]);

  if (!active || !draft) return null;

  const drop = (event: MouseEvent<HTMLDivElement>) => {
    if (pin) return;
    const box = layer.current?.getBoundingClientRect();
    if (!box) return;
    const at = pinPoint({ x: event.clientX, y: event.clientY }, box);
    if (!at) return;
    const viewport = { width: Math.round(box.width), height: Math.round(box.height) };
    setPin({ ...at, viewport, asking: true });
    setError(null);
    const mine = ++asked.current;
    const frame = stagingRefs.iframe;
    const told = frame
      ? requestAppPicture(frame, { scale: 0.25, x: at.x * viewport.width, y: at.y * viewport.height }, ELEMENT_TIMEOUT_MS)
      : Promise.resolve(null);
    void told.then((said) => {
      if (mine !== asked.current) return;
      setPin((had) => (had ? {
        ...had,
        asking: false,
        ...(pinRoute(said?.path) ? { route: pinRoute(said?.path) } : {}),
        ...(said?.at ? { element: said.at } : {}),
      } : had));
    });
  };

  const send = async () => {
    const conversationId = Number(draft.conversationId) || 0;
    if (!pin || !note.trim() || sending || !conversationId) return;
    setSending(true);
    setError(null);
    try {
      await api.sendMessage(conversationId, {
        content: note.trim(),
        threadRootId: draft.rootId,
        idempotencyKey: key(),
        previewPin: {
          draftId: draft.id, x: pin.x, y: pin.y,
          ...(pin.route ? { route: pin.route } : {}),
          ...(pin.viewport ? { viewport: pin.viewport } : {}),
          ...(pin.element ? { element: pin.element } : {}),
        },
        showing: { liveDraftId: draft.id },
      });
      setPin(null);
      setNote('');
      stopPreviewPins();
      void loadReplyThread(conversationId, draft.rootId, true);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('messages:previewPin.failed'));
    } finally {
      setSending(false);
    }
  };

  const what = pin?.element?.text || pin?.element?.tag || '';
  // The box beside the pin: under it in the top half, over it in the bottom.
  const below = !pin || pin.y < 0.6;
  return (
    <div
      ref={layer}
      className="staging-pin-layer"
      data-preview-pins=""
      onClick={drop}
      role="application"
      aria-label={t('messages:previewPin.layer')}
    >
      {!pin ? <span className="staging-pin-hint" role="status">{t('messages:previewPin.hint')}</span> : null}
      {pin ? (
        <>
          <span className="staging-pin" style={{ left: `${pin.x * 100}%`, top: `${pin.y * 100}%` }} aria-hidden="true">1</span>
          <form
            className="staging-pin-box"
            data-below={below ? '' : undefined}
            style={{ left: `clamp(8px, calc(${pin.x * 100}% - 140px), calc(100% - 288px))`, top: `${pin.y * 100}%` }}
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => { event.preventDefault(); void send(); }}
            data-preview-pin-box=""
          >
            {pin.asking ? <span className="staging-pin-on">{t('messages:previewPin.looking')}</span>
              : what ? <span className="staging-pin-on">{t('messages:previewPin.on', { what })}</span> : null}
            <textarea
              value={note}
              maxLength={2000}
              placeholder={t('messages:previewPin.placeholder')}
              onChange={(event) => setNote(event.target.value)}
              autoFocus
            />
            {error ? <span className="staging-pin-error" role="alert">{error}</span> : null}
            <span className="staging-pin-acts">
              <button type="button" className="staging-draft-quiet" onClick={() => { setPin(null); setNote(''); }}>
                {t('messages:previewPin.cancel')}
              </button>
              <button type="submit" className="staging-draft-act" disabled={!note.trim() || sending}>
                {t('messages:previewPin.send')}
              </button>
            </span>
          </form>
        </>
      ) : null}
    </div>
  );
}
