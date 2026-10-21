/**
 * A TOPIC'S FIGURES, between its line and its room.
 *
 * A topic whose dapp.json entry names figures (services/topic-figures.js)
 * shows them here, to everyone who can read the channel: a label over the
 * card saying what window they cover, and the card, one cell per figure.
 * A split figure shows Homeroom over the other projects, each with its own
 * number, and the target once under them:
 *
 *   LAST 7 DAYS
 *   ┌────────────────────────┬─────────────────┬────────────────┐
 *   │ Merge → live         ⓘ │ Deploys that… ⓘ │ App opens th… ⓘ│
 *   │ Homeroom      ⚠ 19 min │ 4%              │ 99.2%          │
 *   │ Other projects   3 min │ 3 of 74 project │ 1,204 of 1,213 │
 *   │ median · target 15 min │ merges · target │ opens · target │
 *   └────────────────────────┴─────────────────┴────────────────┘
 *
 * The Homeroom bot's figures are a grid instead: a row each for Answers
 * and Builds, a column each for Quality, Cost and Speed. A group with more
 * than one figure in a column runs on into rows under its first.
 *
 * The server words every figure (its label, value, line and what it means)
 * and does the rounding that protects people, so this draws what it is
 * sent. Colour only for a figure off its target (the attention ink, with a
 * warning glyph); one on target stays grey. Each figure's ⓘ opens what it
 * means, on hover or focus, and on a tap where there is no hover. The
 * explanation is drawn on the page body, so the card's rounded edge does
 * not cut it off.
 *
 * Nothing renders until the figures arrive: the channel reads the same
 * without them, and a topic with none draws nothing at all.
 */

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { SectionHeader } from '@/components/ui/grouped-list';
import { InfoCircleIcon, WarningTriangleIcon } from '@/components/ui/icons';

import { useMessages } from '../../../lib/i18n/react';
import { getLanguage } from '../../../lib/i18n/runtime';
import type { PlaceChannel } from './community-card';

export type FigureState = 'ok' | 'warn' | 'calm' | 'empty' | 'missing' | 'error';

/** One side of a split figure: Homeroom, or the other projects. */
export interface FigureSide {
  key: string;
  name: string;
  state: FigureState;
  value: string;
  /** A rate's count ("3 of 140 runs"), or nothing. */
  detail: string;
}

export interface TopicFigure {
  id: string;
  label: string;
  /** What the figure means, in plain words: the ⓘ's text. */
  tip: string;
  group: string | null;
  column: string | null;
  state: FigureState;
  value: string;
  sub: string;
  /** #5683: still waiting for enough people (the server's `few`). */
  few?: boolean;
  /** A split figure's sides, Homeroom first; drawn in place of `value`. */
  sides?: FigureSide[];
}

export interface TopicFiguresPayload {
  topic: string;
  figures: TopicFigure[];
  layout?: 'tiles' | 'grid';
  groups?: Array<{ key: string; name: string; about: string }>;
  columns?: Array<{ key: string; name: string }>;
  days?: number;
  note?: string | null;
  demo?: boolean;
  /** #5683: how many people a figure waits for before it reports. */
  peopleMin?: number;
}

function demoAsked(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('demo') === '1';
  } catch {
    return false;
  }
}

/** Where a topic's figures are read from. Pure. */
export function figuresUrl(slug: string, key: string, demo = false): string {
  const path = `/api/apps/${encodeURIComponent(slug)}/topics/${encodeURIComponent(key)}/figures`;
  return demo ? `${path}?demo=1` : path;
}

/** Whether a topic shows figures at all, from its record. Pure. */
export function topicHasFigures(topic: Pick<PlaceChannel, 'state'> & { figures?: string[] | null }): boolean {
  return topic.state === 'live' && Array.isArray(topic.figures) && topic.figures.length > 0;
}

const TIP_WIDTH = 280;
const TIP_MARGIN = 8;

/**
 * The ⓘ and what it says, placed under the button on the page body while it
 * is open. One piece for a figure's cell and for the folded line (#5683).
 */
function InfoTip({ id, tip, label, open, onOpen, onClose }: {
  id: string;
  tip: string;
  /** The ⓘ's accessible name. */
  label: string;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}): ReactNode {
  const tipId = useId();
  const infoRef = useRef<HTMLButtonElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number; width: number } | null>(null);

  // Place the explanation under the ⓘ, inside the window.
  useEffect(() => {
    if (!open) { setPlace(null); return undefined; }
    const measure = () => {
      const el = infoRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const width = Math.min(TIP_WIDTH, window.innerWidth - TIP_MARGIN * 2);
      const left = Math.max(TIP_MARGIN, Math.min(rect.left - 16, window.innerWidth - width - TIP_MARGIN));
      setPlace({ top: rect.bottom + 8, left, width });
    };
    measure();
    // It follows nothing: a scroll or a resize closes it.
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
    };
  }, [open, onClose]);

  return (
    <>
      <button
        ref={infoRef}
        type="button"
        className="dev-ws-fig-info"
        aria-label={label}
        aria-describedby={tipId}
        onFocus={onOpen}
        onBlur={onClose}
        // A tap focuses it too: it opens, and a tap anywhere else closes it.
        onClick={(e) => { e.preventDefault(); onOpen(); }}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      >
        <InfoCircleIcon aria-hidden="true" />
      </button>
      {/* Always in the document, so the ⓘ's description is there to read;
          drawn on the body while open. */}
      {open && place && typeof document !== 'undefined'
        ? createPortal(
          <span
            id={tipId}
            role="tooltip"
            className="dev-ws-fig-tip"
            data-topic-figure-tip={id}
            style={{ top: place.top, left: place.left, width: place.width }}
          >
            {tip}
          </span>,
          document.body,
        )
        : <span id={tipId} hidden>{tip}</span>}
    </>
  );
}

/** One figure's cell, with its ⓘ and what it means. */
function FigureCell({ figure, open, onOpen, onClose, label }: {
  figure: TopicFigure;
  open: boolean;
  onOpen: (id: string) => void;
  onClose: (id: string) => void;
  /** The ⓘ's accessible name. */
  label: string;
}): ReactNode {
  const quiet = (state: FigureState) => state === 'missing' || state === 'empty' || state === 'error';
  const muted = quiet(figure.state);
  const sides = Array.isArray(figure.sides) && figure.sides.length ? figure.sides : null;
  // The ⓘ keeps to the label's last word, so it never wraps onto a line alone.
  const cut = figure.label.lastIndexOf(' ');
  const head = cut > 0 ? figure.label.slice(0, cut + 1) : '';
  const tail = cut > 0 ? figure.label.slice(cut + 1) : figure.label;
  return (
    <div
      className="dev-ws-fig"
      data-topic-figure={figure.id}
      data-fig-state={figure.state}
      data-fig-column={figure.column || undefined}
      onMouseEnter={() => onOpen(figure.id)}
      onMouseLeave={() => onClose(figure.id)}
    >
      <span className="dev-ws-fig-label">
        {head}
        <span className="dev-ws-fig-label-end">
          {tail}
          <InfoTip
            id={figure.id}
            tip={figure.tip}
            label={label}
            open={open}
            onOpen={() => onOpen(figure.id)}
            onClose={() => onClose(figure.id)}
          />
        </span>
      </span>
      {sides ? (
        <span className="dev-ws-fig-sides">
          {sides.map((side) => (
            <span key={side.key} className="dev-ws-fig-side" data-fig-side={side.key} data-fig-state={side.state}>
              <span className="dev-ws-fig-side-name">{side.name}</span>
              <span
                className={quiet(side.state)
                  ? 'dev-ws-fig-side-value dev-ws-fig-side-value-muted'
                  : (side.state === 'warn' ? 'dev-ws-fig-side-value dev-ws-fig-side-value-warn' : 'dev-ws-fig-side-value')}
              >
                {side.state === 'warn' ? <WarningTriangleIcon className="dev-ws-fig-warn" aria-hidden="true" /> : null}
                {side.value}
              </span>
              {side.detail ? <span className="dev-ws-fig-side-detail">{side.detail}</span> : null}
            </span>
          ))}
        </span>
      ) : (
        <span className={muted ? 'dev-ws-fig-value dev-ws-fig-value-muted' : 'dev-ws-fig-value'}>{figure.value}</span>
      )}
      {figure.sub ? (
        // A split figure marks the side that is off target; its line is the target alone.
        <span className={figure.state === 'warn' && !sides ? 'dev-ws-fig-sub dev-ws-fig-sub-warn' : 'dev-ws-fig-sub'}>
          {figure.state === 'warn' && !sides ? <WarningTriangleIcon className="dev-ws-fig-warn" aria-hidden="true" /> : null}
          {figure.sub}
        </span>
      ) : null}
    </div>
  );
}

/**
 * #5683: the figures a folded strip would keep. While most of a topic's
 * figures are still waiting for enough people, the tiles say "Not enough
 * data" in the largest type on the page; the strip then folds into one
 * quiet line that names the figures that DO have data. Pure. Null when the
 * tiles stay as they are.
 */
export function foldFigures(data: TopicFiguresPayload): { shown: TopicFigure[]; waiting: TopicFigure[] } | null {
  if (data.layout === 'grid' || !data.figures.length) return null;
  const waiting = data.figures.filter((f) => f.few);
  const shown = data.figures.filter((f) => !f.few);
  return waiting.length > shown.length ? { shown, waiting } : null;
}

/**
 * #5683: the quiet line a mostly-waiting strip folds into, under "Last 30
 * days": the figures that have data, then when the others appear. The ⓘ at
 * its end carries the rounding note the paragraph under the tiles held.
 */
function FoldedFigures({ data, folded, openId, onOpen, onClose }: {
  data: TopicFiguresPayload;
  folded: { shown: TopicFigure[]; waiting: TopicFigure[] };
  openId: string | null;
  onOpen: (id: string) => void;
  onClose: (id: string) => void;
}): ReactNode {
  const t = useMessages('project');
  const min = Number(data.peopleMin) || 10;
  const items = folded.shown.map((figure) => t('project:places.topicFigures.foldedItem', {
    label: figure.label, figure: figure.value, sub: figure.sub,
  }));
  let joined = items.join(', ');
  try {
    joined = new Intl.ListFormat(getLanguage(), { style: 'long', type: 'conjunction' }).format(items);
  } catch { /* the plain join stands */ }
  const sentence = folded.shown.length
    ? t('project:places.topicFigures.folded', { figures: joined, count: folded.waiting.length, min })
    : t('project:places.topicFigures.foldedNone', { count: folded.waiting.length, min });
  return (
    <p className="dev-ws-figs-folded" data-topic-figures-layout="folded">
      {sentence}
      {data.note ? (
        <>
          {' '}
          <InfoTip
            id="folded"
            tip={data.note}
            label={t('project:places.topicFigures.foldedInfo')}
            open={openId === 'folded'}
            onOpen={() => onOpen('folded')}
            onClose={() => onClose('folded')}
          />
        </>
      ) : null}
    </p>
  );
}

/**
 * The strip itself, from a payload as GET /api/apps/:slug/topics/:key/figures
 * answers it: the section header, the card, and the lines under it. Pure
 * apart from which explanation is open.
 */
export function TopicFiguresView({ handle, data }: {
  handle: string;
  data: TopicFiguresPayload;
}): ReactNode {
  const t = useMessages('project');
  const [openId, setOpenId] = useState<string | null>(null);
  const onOpen = useCallback((id: string) => setOpenId(id), []);
  const onClose = useCallback((id: string) => setOpenId((cur) => (cur === id ? null : cur)), []);

  if (!data.figures.length) return null;
  const days = Number(data.days) || 7;
  const folded = foldFigures(data);
  const cell = (figure: TopicFigure) => (
    <FigureCell
      key={figure.id}
      figure={figure}
      open={openId === figure.id}
      onOpen={onOpen}
      onClose={onClose}
      label={t('project:places.topicFigures.whatItMeans', { label: figure.label })}
    />
  );

  let card: ReactNode;
  if (data.layout === 'grid' && data.groups?.length && data.columns?.length) {
    const columns = data.columns;
    card = (
      <div className="dev-ws-figs-card dev-ws-figs-grid" data-topic-figures-layout="grid">
        <div className="dev-ws-figs-corner" aria-hidden="true" />
        {columns.map((c) => <div key={c.key} className="dev-ws-figs-colhead">{c.name}</div>)}
        {data.groups.flatMap((g) => {
          // A column with more than one of the group's figures runs on into
          // a row under the first, in the order the topic names them.
          const inColumn = columns.map((c) => data.figures.filter((f) => f.group === g.key && f.column === c.key));
          const rows = Math.max(1, ...inColumn.map((list) => list.length));
          return Array.from({ length: rows }, (_, i) => (
            <div key={`${g.key}-${i}`} className="dev-ws-figs-row" data-fig-group={g.key}>
              {i === 0 ? (
                <div className="dev-ws-figs-rowhead">
                  <span className="dev-ws-figs-rowname">{g.name}</span>
                  <span className="dev-ws-figs-rowabout">{g.about}</span>
                </div>
              ) : <div className="dev-ws-figs-rowhead dev-ws-figs-rowhead-more" aria-hidden="true" />}
              {columns.map((c, at) => {
                const figure = inColumn[at][i];
                return figure ? cell(figure) : <div key={c.key} className="dev-ws-fig" aria-hidden="true" />;
              })}
            </div>
          ));
        })}
      </div>
    );
  } else {
    card = (
      <div className="dev-ws-figs-card dev-ws-figs-tiles" data-topic-figures-layout="tiles" data-fig-count={data.figures.length}>
        {data.figures.map(cell)}
      </div>
    );
  }

  return (
    <section className="dev-ws-figs" data-topic-figures={handle} aria-label={t('project:places.topicFigures.label')}>
      <div className="dev-ws-figs-head">
        <SectionHeader className="p-0">{t('project:places.topicFigures.window', { count: days })}</SectionHeader>
      </div>
      {folded ? (
        <FoldedFigures data={data} folded={folded} openId={openId} onOpen={onOpen} onClose={onClose} />
      ) : (
        <>
          {card}
          {data.note ? <p className="dev-ws-figs-note">{data.note}</p> : null}
        </>
      )}
      {data.demo ? <p className="dev-ws-figs-note" data-topic-figures-demo="">{t('project:places.topicFigures.demo')}</p> : null}
    </section>
  );
}

export function TopicFigures({ slug, topic }: {
  slug: string;
  topic: PlaceChannel & { figures?: string[] | null };
}): ReactNode {
  const [data, setData] = useState<TopicFiguresPayload | null>(null);
  const shows = topicHasFigures(topic);
  const key = topic.key || '';
  const figureList = (topic.figures || []).join(',');

  // Another topic starts over: no strip until its own figures arrive.
  useEffect(() => {
    setData(null);
  }, [slug, key]);

  useEffect(() => {
    if (!slug || !key || !shows) return undefined;
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    fetch(figuresUrl(slug, key, demoAsked()), ctl ? { signal: ctl.signal } : undefined)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (body && Array.isArray(body.figures)) setData(body as TopicFiguresPayload);
      })
      .catch(() => { /* no strip: the channel reads the same without it */ });
    return () => { ctl?.abort(); };
  }, [slug, key, shows, figureList]);

  if (!shows || !data) return null;
  return <TopicFiguresView handle={topic.handle} data={data} />;
}
