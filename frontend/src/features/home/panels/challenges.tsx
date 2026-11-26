/**
 * The Challenges block: what the viewer can do next.
 *
 * ── Named by what it holds (the Semi design, 2026-10-16) ───────────────
 *
 * HomePanels.challengesView decides, and the section heading says it:
 *
 *   First challenges — every First challenge while any is unfinished, in the
 *                      admin's order, the done ones in place as the card's
 *                      one-line finished shape (#4563).
 *   Next challenges  — once those are done: up to three open challenges,
 *                      in the Challenges tab's order (polish N11: not by
 *                      progress, which reshuffled them on screen).
 *   Challenges       — over ONE LINE when nothing is open: "All done for
 *                      this week" when this week's are all done, otherwise
 *                      "No challenges right now".
 *
 * The heading and its "See all" are ./sections.tsx's (they sit in the static
 * section heading, filled in once the view arrives); this file draws what is
 * under them.
 *
 * What the block used to carry and does not any more: the season progress
 * line and bar (`.home-panel-season`), the points total, "N of M done", the
 * group headers (This week, Always open, Season challenges, and the Done
 * header `home-challenge-done-head`), the clocks on them and on the cards,
 * and the "Open challenges" link. The Challenges tab, one tap away behind
 * "See all", has the whole list.
 *
 * THE ONE THING THAT CAME BACK (request #7210) is a fold, not that footer:
 * when Home holds more open challenges than the folded row draws, a "Show all
 * N challenges" button under the cards grows the row in place until every
 * open one is on screen, and "Show less" folds it back. The open or folded
 * choice is the store's (`challengesExpanded`), not the server's.
 *
 * ── A ROW OF CARDS (One Home, #6361; a column until then), and the card
 *    is the Challenges tab's ─────────────────────────────────────────
 *
 * The cards sit straight on the page ground, in one row under the section
 * heading that scrolls sideways, with no plate around them (`PanelShell
 * plate="none"`): the cards are surfaces of their own. The heading ends on
 * `pb-1.5` and the body opens on `pt-2`, a 14px step, and the cards sit
 * `gap-2.5` (10px) apart, the step of the featured apps rail. Nothing is
 * inset: the cards start where the heading's label starts.
 *
 * THE CARD IS SHARED. It is `ChallengeCard` from
 * features/leaderboard/challenge-card.tsx, the same component the
 * Leaderboard screen's Challenges tab draws, so a challenge reads the same
 * state, words and reward on both surfaces. Home hands it no deadline. Only
 * the root class `home-challenge-card` and `data-challenge-id` are this
 * block's, because the declared checks and the tests select on them.
 *
 * ── The one line ──────────────────────────────────────────────────────
 *
 * With nothing open the block STAYS, for everyone, and says why in one card:
 * a block that silently vanished would leave the viewer unable to tell
 * "nothing to do" from "this broke". It is a statement, not a control: "See
 * all" beside the heading is the way to the tab when there is one. It keeps
 * `home-panel-rows home-panel-row` and the article's `data-rows="0"`, which
 * the declared checks select the empty state by.
 *
 * ── Loading and failure ───────────────────────────────────────────────
 *
 * Until the first paint (both the panels' read and the apps') the section
 * holds its heading's box with no words and three card skeletons, at the
 * height this device last drew it (./sections.tsx, ../../../lib/first-paint-reserve.ts). A failed
 * read keeps no copy, so the section is hidden (HomePanels.ensureLoaded is
 * silent on failure); there is no error state to draw.
 */

import { useEffect, useRef, useState } from 'react';

import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, ChevronUpIcon } from '@/components/ui/icons';

import { resolveIllustration } from '../../../lib/challenge-illustrations';
import { useMessages } from '../../../lib/i18n/react';
import { useLiveSkin, isKitHome } from '../../../lib/skin';
import { ChallengeCard } from '../../leaderboard/challenge-card';
import { setChallengesExpanded, type ChallengeRowView, type ChallengesView } from '../panels-store';
import { WIP_CARD } from '../wip-kit';
import { PanelShell, panels } from './ui';

/** A challenge's picture as a column's banner: its illustration on its tone, else its kind's icon. */
function WipChallengeArt({ row }: { row: ChallengeRowView }) {
  const art = resolveIllustration(row.illustration, row.illustrationTone);
  if (art) {
    return (
      <span className={`wip-poster-art ${art.toneClass}`} aria-hidden="true">
        <img src={art.src} alt="" width={64} height={64} draggable={false} />
      </span>
    );
  }
  return <span className="wip-poster-art" aria-hidden="true">{row.icon || ''}</span>;
}

/**
 * The standard look and Standard (WIP) (lib/skin.ts isKitHome): the
 * challenges as posters in the look's own kit (../wip-kit.tsx, app.css
 * "STANDARD (WIP)"), each a card of its own: the kit's card, in the "goal"
 * colours (`data-tone`, which re-points the tokens its insides read). The
 * row around them draws no card. Each is as wide as one of the look's
 * columns, a card gap from the next, so the cards' edges fall on the lines
 * of the cards above, and the row scrolls sideways for the rest. A poster is
 * the challenge's picture at its side on the picture's own tone, then its
 * goal, where the viewer stands and what it is worth on one line, and a
 * meter: empty before it is started, the accent as far as it has come, green
 * when it is done. The whole card is the one thing to press: it has no arrow
 * of its own, and its progress is the meter, not a pill.
 */
function WipChallengePosters({ view, shown, expanded, hasMore }: {
  view: ChallengesView; shown: ChallengeRowView[]; expanded: boolean; hasMore: boolean;
}) {
  const t = useMessages('home');
  const rail = useRef<HTMLDivElement | null>(null);
  // Which way there is more of the row: an arrow is drawn at that end only.
  const [more, setMore] = useState({ back: false, on: false });
  useEffect(() => {
    const el = rail.current;
    if (!el) return undefined;
    const sync = () => {
      // The row's start is its left in a left-to-right language and its
      // right in a right-to-left one, where scrollLeft counts down from zero.
      const at = Math.abs(el.scrollLeft);
      const end = el.scrollWidth - el.clientWidth;
      setMore((was) => {
        const next = { back: at > 2, on: at < end - 2 };
        return was.back === next.back && was.on === next.on ? was : next;
      });
    };
    sync();
    el.addEventListener('scroll', sync, { passive: true });
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(sync) : null;
    ro?.observe(el);
    return () => { el.removeEventListener('scroll', sync); ro?.disconnect(); };
  }, [shown.length, expanded]);
  // One screen of the row at a time, toward its end or back to its start.
  const page = (dir: 1 | -1) => {
    const el = rail.current;
    if (!el) return;
    const rtl = getComputedStyle(el).direction === 'rtl';
    el.scrollBy({ left: dir * (rtl ? -1 : 1) * el.clientWidth, behavior: 'smooth' });
  };
  return (
    <div className="wip-posters-box" data-wip-challenges="">
      {/* `data-expanded` only while it is: the folded markup is pinned by
          tests/home-needs-you-card.test.js. Expanded, app.css wraps the row
          into as many columns as the look draws, instead of scrolling it. */}
      <div ref={rail} className="wip-posters" {...(expanded ? { 'data-expanded': '' } : null)}>
        {shown.map((row) => {
          const pct = row.state === 'done' ? 100
            : row.fill != null ? Math.round(Math.max(0, Math.min(row.fill, 1)) * 100)
            : row.state === 'progress' ? 8 : 0;
          return (
            <button
              key={row.id}
              type="button"
              className={`${WIP_CARD} wip-poster`}
              data-tone="goal"
              data-challenge-id={row.id}
              data-state={row.state}
              onClick={() => panels()?.goToChallenge?.(row.eventId, row.id)}
            >
              {/* The picture leads, at the side; beside it the goal, where
                  the viewer stands and what it is worth, and the meter. */}
              <WipChallengeArt row={row} />
              <span className="wip-item-text">
                <b className="wip-item-title">{row.goal}</b>
                <span className="wip-poster-facts">
                  <span className="wip-item-meta">{row.stateLabel}</span>
                  {row.earned || row.reward ? (
                    <span className={row.earned ? 'wip-poster-worth wip-poster-worth-ok' : 'wip-poster-worth'}>{row.earned || row.reward}</span>
                  ) : null}
                </span>
                <span className="wip-meter" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
              </span>
            </button>
          );
        })}
      </div>
      {more.back ? (
        <button type="button" className="wip-rail-arrow wip-rail-arrow-back" aria-label={t('home:challenges.scrollBack')} onClick={() => page(-1)}>
          <ChevronLeftIcon className="wip-rail-arrow-glyph" strokeWidth="2.4" aria-hidden="true" />
        </button>
      ) : null}
      {more.on ? (
        <button type="button" className="wip-rail-arrow wip-rail-arrow-on" aria-label={t('home:challenges.scrollOn')} onClick={() => page(1)}>
          <ChevronRightIcon className="wip-rail-arrow-glyph" strokeWidth="2.4" aria-hidden="true" />
        </button>
      ) : null}
      {/* The rest of them, in place: the look's own fold pill, as Pinned
          projects' "Show all" uses. Only when there is more than the three
          the folded row draws: the row is what tells, not what is drawn
          (`shown` is the three while folded, so it never says so itself). */}
      {hasMore ? (
        <div className="home-challenges-more wip-posters-more">
          <button
            type="button"
            className="wip-fold-pill"
            aria-expanded={expanded}
            onClick={() => setChallengesExpanded(!expanded)}
          >
            {expanded
              ? t('home:challenges.showLess')
              : t('home:challenges.showAll', {
                count: view.total != null ? view.total : view.rows.length + (view.more || []).length,
              })}
            {expanded
              ? <ChevronUpIcon className="wip-head-chevron-glyph" strokeWidth="2.4" aria-hidden="true" />
              : <ChevronDownIcon className="wip-head-chevron-glyph" strokeWidth="2.4" aria-hidden="true" />}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function ChallengesPanel({ view, expanded = false }: { view: ChallengesView; expanded?: boolean }) {
  const t = useMessages('home');
  const wip = isKitHome(useLiveSkin());
  const more = view.more || [];
  // Folded, the three cards the block draws; unfolded, every open one.
  const shown = expanded ? [...view.rows, ...more] : view.rows;
  if (view.note) {
    return (
      <PanelShell panelKey={view.key} plate="none" stamps={{ rows: 0 }}>
        <div className="home-panel-body pt-2">
          {/* Rows are 15 over 13 (AGENTS.md): the title at 15px/650, the
              sentence at 13px muted. White on the page ground like the
              challenge cards, so the line sits where a card would, with the
              20px corners of a card this short. `.home-panel-row` gives it
              its fixed 56px height (app.css) and its nowrap, so the two
              lines are centred in it rather than padded. */}
          <div className="home-panel-rows home-panel-row home-challenges-note flex flex-col justify-center gap-0.5 rounded-[1.25rem] bg-white px-4 dark:bg-zinc-900">
            <p className="truncate text-[15px] font-[650] leading-5 text-zinc-900 dark:text-zinc-100">
              {view.note.title}
            </p>
            <p className="truncate text-[13px] leading-[1.125rem] text-zinc-500 dark:text-zinc-400">
              {view.note.text}
            </p>
          </div>
        </div>
      </PanelShell>
    );
  }

  if (wip) {
    return (
      <PanelShell panelKey={view.key} plate="none" stamps={{ rows: shown.length }}>
        <WipChallengePosters view={view} shown={shown} expanded={expanded} hasMore={more.length > 0} />
      </PanelShell>
    );
  }

  return (
    <PanelShell panelKey={view.key} plate="none" stamps={{ rows: shown.length }}>
      {/* ONE HOME (#6361): ONE ROW THAT SCROLLS SIDEWAYS, under Pinned
          communities. The cards are the same; each is a fixed width so the
          next one peeks in from the edge and says the row goes on. The row
          runs to the screen's edges on a phone (`-mx-3 px-3`, the section's
          own gutter given back) and snaps a card to the gutter.

          UNFOLDED (request #7210), it is a wrapping grid at the columns the
          cards above use, so every open challenge is visible without
          swiping: no sideways scroll, no snap, and the cards share the
          column lines instead of their own fixed width. */}
      <div className="home-panel-body pt-2">
        <div className={expanded
          ? 'home-panel-rows grid grid-cols-1 gap-2.5 pb-1 sm:grid-cols-2 lg:grid-cols-3'
          : 'home-panel-rows -mx-3 flex snap-x snap-mandatory scroll-px-3 gap-2.5 overflow-x-auto px-3 pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'}
        >
          {/* Each card is the row's own child, as the declared checks
              select it (`.home-panel-rows > .home-challenge-card`). */}
          {shown.map((row) => (
            <ChallengeCard
              key={row.id}
              view={row}
              className={expanded
                ? 'home-challenge-card min-w-0'
                : 'home-challenge-card w-[min(19rem,82vw)] shrink-0 snap-start'}
              data-challenge-id={row.id}
              onClick={() => panels()?.goToChallenge?.(row.eventId, row.id)}
            />
          ))}
        </div>
        {/* The rest of them, in place. It is the apps grid's "Show all N
            apps" line, under the cards instead of a grid. */}
        {more.length ? (
          <div className="home-challenges-more flex items-center justify-end pt-2">
            <button
              type="button"
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-violet-700 dark:text-violet-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              aria-expanded={expanded}
              onClick={() => setChallengesExpanded(!expanded)}
            >
              {expanded
                ? t('home:challenges.showLess')
                : t('home:challenges.showAll', {
                  count: view.total != null ? view.total : view.rows.length + (view.more || []).length,
                })}
            </button>
          </div>
        ) : null}
      </div>
    </PanelShell>
  );
}
