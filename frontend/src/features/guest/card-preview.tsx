/**
 * A project card's animated preview: a short, silent loop of the real app
 * that plays over the card's picture (the featured-illustration record's
 * `preview`, public directory `preview_url`).
 *
 * WHEN it plays is ../../lib/card-previews.ts: on a device that hovers, after
 * a moment of pointing at the card (or keyboard focus on it), looping until
 * the pointer or focus leaves; one at a time; never under reduced motion,
 * Data Saver or with "Play previews" off. A phone never plays it: it shows
 * the picture, so nothing starts on its own and no full screen player opens.
 *
 * A caller may also offer a play button (`playClassName`): the project hub's
 * picture beside its hero draws one, so a touch screen, which never hovers,
 * can play the loop too. Pressing it claims the same preview the hover path
 * claims, and pressing again (pause) releases it; a press stays playing when
 * the pointer moves away, until it is pressed again or another preview starts.
 * Without `playClassName` the layer is exactly as it was, and no button is
 * drawn, which is every other card on the page.
 *
 * HOW it stays quiet:
 *  - The first render is an empty, inert layer: no <video> in the prerender
 *    or in a card at rest, so nothing hydrates differently and nothing is
 *    fetched. The video mounts only on intent, `preload="none"`, muted and
 *    inline, and its own play() fetches it.
 *  - It sits over the picture at opacity 0 and fades in on `playing`, so a
 *    slow network shows the picture, never a black box. Stopping unmounts it,
 *    which resets it: the next play starts from the first frame, which is
 *    the picture.
 *  - A loop that fails (a missing file, a codec the browser lacks) leaves the
 *    picture showing, says nothing on the console, and is not asked for again
 *    on this page.
 */

import { useEffect, useId, useRef, useState } from 'react';

import { PauseIcon, PlayIcon } from '@/components/ui/icons';
import { cn } from '@/lib/utils';

import {
  HOVER_DELAY_MS, activePreview, canHover, claimPreview, markPreviewFailed, onActivePreview, onPreviewsPref,
  previewFailed, previewsAllowed, releasePreview,
} from '../../lib/card-previews';
import { useMessages } from '../../lib/i18n/react';

export function CardPreview({ src, playClassName }: { src: string; playClassName?: string }) {
  const layer = useRef<HTMLSpanElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  // A press keeps the loop playing when the pointer moves away.
  const pressed = useRef(false);
  // The hover delay's timer, so a press can cancel a start it would undo.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();
  // Only the hub's picture, which is given a button class, needs the hub's
  // words; every other card keeps the catalogs it already loaded.
  const t = useMessages(playClassName ? 'project' : 'core');
  // Mounted: this card's preview is the one playing. Shown: it has started.
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);
  // Offered: the play button may be shown. False on the first render, so the
  // prerender and hydration match; read once the card is on the page.
  const [offered, setOffered] = useState(false);

  // Which card plays is decided in one place for the whole page.
  useEffect(() => onActivePreview(() => {
    const mine = activePreview() === id;
    setMounted(mine);
    if (!mine) {
      setShown(false);
      pressed.current = false;
    }
  }), [id]);

  // A setting turned off mid-play stops it.
  useEffect(() => onPreviewsPref(() => { if (!previewsAllowed()) releasePreview(id); }), [id]);

  // The button is shown wherever a preview may play at all; it goes away
  // when the person turns previews off, under reduced motion or Data Saver.
  useEffect(() => {
    if (!playClassName) return undefined;
    const read = () => setOffered(previewsAllowed() && !previewFailed(src));
    read();
    return onPreviewsPref(read);
  }, [src, playClassName]);

  useEffect(() => {
    const el = layer.current;
    const card = el?.closest('article') || el?.parentElement || null;
    if (!el || !card) return undefined;
    // A phone, or any device without a hover: the picture only. Nothing is
    // followed, claimed or fetched, so no clip starts by itself.
    if (!canHover()) return undefined;
    const start = () => {
      if (!previewsAllowed() || previewFailed(src)) return;
      claimPreview(id);
    };
    const intend = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => { timer.current = null; start(); }, HOVER_DELAY_MS);
    };
    const stop = () => {
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      // A loop started with the button keeps playing until it is paused.
      if (pressed.current) return;
      releasePreview(id);
    };
    const focus = (e: FocusEvent) => {
      // Moving to the button is not the card being pointed at: pressing it
      // starts the loop, focusing it does not.
      if ((e.target as Element | null)?.closest?.('[data-card-preview-play]')) return;
      intend();
    };
    const blur = (e: FocusEvent) => { if (!card.contains(e.relatedTarget as Node | null)) stop(); };
    card.addEventListener('pointerenter', intend);
    card.addEventListener('pointerleave', stop);
    card.addEventListener('focusin', focus);
    card.addEventListener('focusout', blur);
    return () => {
      card.removeEventListener('pointerenter', intend);
      card.removeEventListener('pointerleave', stop);
      card.removeEventListener('focusin', focus);
      card.removeEventListener('focusout', blur);
      // Leaving the page releases the loop even if it was started by a press.
      pressed.current = false;
      stop();
    };
  }, [id, src]);

  // Mounted: play it. The promise is answered either way, so a play the
  // browser refuses or a stop mid-load is never an uncaught error.
  useEffect(() => {
    const v = video.current;
    if (!mounted || !v) return;
    v.muted = true;
    try {
      const played = v.play();
      if (played && typeof played.catch === 'function') played.catch(() => releasePreview(id));
    } catch { releasePreview(id); }
  }, [mounted, id]);

  const layerEl = (
    <span ref={layer} data-card-preview="" aria-hidden="true" className="pointer-events-none absolute inset-0">
      {mounted ? (
        <video
          ref={video}
          src={src}
          muted
          playsInline
          preload="none"
          loop
          tabIndex={-1}
          disablePictureInPicture
          data-card-preview-video=""
          className={cn(
            'absolute inset-0 h-full w-full object-cover transition-opacity duration-200 ease-out motion-reduce:transition-none',
            shown ? 'opacity-100' : 'opacity-0',
          )}
          onPlaying={() => setShown(true)}
          onEnded={() => releasePreview(id)}
          onError={() => { markPreviewFailed(src); setOffered(false); releasePreview(id); }}
        />
      ) : null}
    </span>
  );

  if (!playClassName) return layerEl;

  return (
    <>
      {layerEl}
      {offered ? (
        <button
          type="button"
          data-card-preview-play=""
          aria-pressed={mounted}
          aria-label={mounted ? t('project:hub.preview.pause') : t('project:hub.preview.play')}
          className={playClassName}
          onClick={() => {
            if (activePreview() === id) {
              pressed.current = false;
              // A hover delay still running would start it again at once.
              if (timer.current) { clearTimeout(timer.current); timer.current = null; }
              releasePreview(id);
              return;
            }
            pressed.current = true;
            claimPreview(id);
          }}
        >
          {mounted
            ? <PauseIcon aria-hidden="true" />
            : <PlayIcon aria-hidden="true" />}
        </button>
      ) : null}
    </>
  );
}
