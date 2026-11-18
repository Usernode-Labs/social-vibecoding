/**
 * The picture on a thread's card: a change's before and after, drawn with
 * the Needs you page's slider (review-flow/compare.tsx). One picture with a
 * seam you drag between the two sides, the small switch that flips it, each
 * side's name printed on it, and press-and-hold to magnify. Nothing is
 * outlined or tinted: the two sides are told apart by dragging between them.
 *
 * Under it are the run's screens as tiles and the words for what changed on
 * the one showing. Expand opens the full viewer (AppView.shotsHtml) in the detail
 * column beside the thread.
 */

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { useMessages } from '../../../lib/i18n/react';
import { t as translate } from '../../../lib/i18n/runtime';
// #6825: a tile is a strip thumbnail, so it loads the small copy only.
import { shotThumb } from '../../../lib/shot-img';
import { ExpandIcon } from '@/components/ui/icons';
import { CompareSlider } from '../../review-flow/compare';
import { focusBox, placeBox, type Placement, type ReviewScreen } from '../../review-flow/model';
import type { ChangeThreadView } from './model';

/** The tallest the picture gets, in px. */
export const PICTURE_MAX = 560;

/**
 * Pure: how tall the picture is for a screen in a card `width` wide, and
 * where the screen sits in it. The changed area is framed, as on the Needs
 * you page, never drawn larger than life; a small change keeps some of the
 * screen round it, and a tall one is fitted to the room.
 */
export function pictureFrame(screen: ReviewScreen, width: number): { height: number; place: Placement } {
  const focus = focusBox(screen, ['before', 'after'], 24);
  const whole = Math.max(screen.before.height, screen.after.height);
  const scale = Math.min(1, width / focus.w);
  const most = Math.min(PICTURE_MAX, Math.max(240, width * 1.1));
  const least = Math.min(300, width * 0.62);
  const height = Math.max(1, Math.round(Math.min(whole * scale, most, Math.max(focus.h * scale, least))));
  return { height, place: placeBox(screen, focus, { w: width, h: height }, 1) };
}

export function ThreadPicture({ s, captions = null }: {
  s: NonNullable<ChangeThreadView['shots']>;
  /** Each side's name, where it is not the slider's own (a change already live, or closed). */
  captions?: { before: string; after: string } | null;
}): ReactNode {
  const t = useMessages('project');
  const screens = s.screens || [];
  const [picked, setPicked] = useState(0);
  const at = Math.min(picked, screens.length - 1);
  const screen = screens[at];
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const read = () => setWidth(Math.round(el.clientWidth));
    read();
    if (typeof ResizeObserver !== 'function') return undefined;
    const watch = new ResizeObserver(read);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  if (!screen) return null;
  const frame = width > 0 ? pictureFrame(screen, width) : null;
  const said = (s.changes || []).filter((c) => (screen.changes || []).includes(c.n));
  const legend = said.length ? said : (s.changes || []).slice(0, 1);
  // Expand opens the full viewer in the detail column beside the thread, as
  // the small pair on a request's page does (#6230).
  const expand = s.changeId && s.html ? () => {
    (window as any).UsernodeReact?.detail?.open({ kind: 'shots', ref: { changeId: s.changeId }, version: null, payload: { html: s.html } });
  } : null;
  return (
    <section className="dev-change-shots dev-thread-picture" data-change-shots="verified" data-thread-picture="" data-thread-compare={at}>
      <div ref={box} className="dev-thread-compare" style={frame ? { height: frame.height } : undefined}>
        {frame ? (
          <CompareSlider
            key={at}
            screen={screen}
            ground="var(--messages-surface-2)"
            width={width}
            height={frame.height}
            marks
            place={frame.place}
            captions={captions}
          />
        ) : null}
        {expand ? (
          <button
            type="button"
            className="dev-thread-compare-expand"
            data-thread-compare-expand=""
            onClick={expand}
            title={translate('changes:shots.viewer.expand')}
            aria-label={translate('changes:shots.viewer.expand')}
          >
            <ExpandIcon width={16} height={16} />
          </button>
        ) : null}
      </div>
      {screens.length > 1 || legend.length ? (
        <div className="dev-thread-tiles" data-thread-tiles={screens.length > 1 ? screens.length : 0}>
          {screens.length > 1 ? screens.map((one, i) => (
            <button
              key={`${one.viewport}:${one.after.url}`}
              type="button"
              className="dev-thread-tile"
              aria-pressed={i === at}
              aria-label={t('project:topic.card.shots.tile', { index: i + 1, total: screens.length })}
              onClick={() => setPicked(i)}
            >
              <img src={shotThumb(one.after) || one.after.url} alt="" loading="lazy" decoding="async" />
            </button>
          )) : null}
          <div className="dev-thread-tiles-cap">
            {screens.length > 1 ? <p className="dev-thread-tiles-count">{t('project:topic.card.shots.screenOf', { index: at + 1, total: screens.length })}</p> : null}
            {legend.length ? (
              <ul className="dev-thread-tiles-said">
                {legend.map((c) => <li key={c.n}>{c.text}</li>)}
              </ul>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
