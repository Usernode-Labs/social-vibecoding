/**
 * Challenges and Standings in the one frame, version 2 (the tour's s53 to
 * s55): the first tour's layout holding today's two panes.
 *
 * Both wear one head: the title, the sentence saying where your place comes
 * from, and the two tabs. Challenges is the points and "10 of 11 done" over
 * one bar, then the challenges under today's headings as rows, with Your
 * standing in the side column (the rank, its two sentences, the points not
 * counted yet, the token allocation). Standings is the line to the
 * challenges with the non-podium chip, your own line lit, and the table of
 * rank, name and points as rows, with the event's card in the side column.
 *
 * Presentational: the panes' own views (../challenges-pane.tsx,
 * ../topochain-standings.tsx, ../event-bar.tsx) with another face. A
 * challenge's own page is still the pane's.
 */
import { Fragment } from 'react';
import type * as React from 'react';
import { Btn, Card, Cols, Frame, Head, Lead, Meta, Note, PageBody, Pill, Row, Sec, Tabs, k } from '@/components/ui/kit';
import { RichMessage, useMessages } from '../../../lib/i18n/react';
import { useFrameFlag } from '../../frame/frame-flag';

/** A challenge as the pane's card has it: `goal` is its name ("Use apps for 10 minutes"), `label` its kind ("Weekly"). */
interface CardLike {
  key: string; idx: number; done: boolean; label: string; goal: string; reward: string | null;
  stateLabel: string; earned: string | null;
}

export type FrameToken =
  | { gated: true; onReview: () => void }
  | { gated: false; amount: string; revealed: boolean; onReveal: () => void };

/** Your standing, as the standard card says it (../your-standing.tsx). */
export interface FrameStanding {
  /** "#16", or null before the standings have you. */
  rank: string | null;
  /** "of 149 ranked", when the server said how many are ranked. */
  of: string | null;
  /** "1,000 pts earned, not in the standings yet". */
  pending: string | null;
  token: FrameToken | null;
}

type Tab = { key: string; label: string };

export function ChallengesFrame({ up = true, tabs, onTab, state = 'cards', error, progress, onFirst, groups, notice, locked, onOpen, standing }: {
  /** This is the tab on show: not while Standings, or a challenge's own page, is up over it. */
  up?: boolean;
  tabs: Tab[];
  onTab: (key: string) => void;
  /** What the grid has: its cards, or one of the states before or instead of them. */
  state?: 'cards' | 'loading' | 'error' | 'empty';
  error?: string | null;
  /** "15,128 pts · 10 of 11 done", over one bar. */
  progress?: { done: number; total: number; points: string | null } | null;
  /** The way back to the first challenges, while an earlier event's are on show. */
  onFirst?: (() => void) | null;
  groups: Array<{ key: string; heading: string | null; cards: CardLike[] }>;
  notice?: string | null;
  /** What Getting started still hides: its two lines, as the standard placeholder says them. */
  locked?: { title: string; hint: string } | null;
  onOpen: (idx: number) => void;
  standing: FrameStanding | null;
}) {
  useFrameFlag('challenges-frame', up);
  const t = useMessages('leaderboard');
  const counts = progress ? { done: progress.done, count: progress.total } : null;
  return (
    <PageBody
      data-challenges-frame=""
      title={t('leaderboard:tabs.challenges')}
      purpose={t('leaderboard:standing.pointsNote')}
      tabs={<Tabs tabs={tabs} current="challenges" onPick={(key) => onTab(key)} />}
      sideFirst
      side={standing ? (
        <Sec label={t('leaderboard:standing.label')} data-frame-standing="">
          <Card text>
            {standing.rank ? (
              <div className={k('sub22')}>{standing.rank}{standing.of ? <> <span className={k('sub15', 'mut')}>{standing.of}</span></> : null}</div>
            ) : <div className={k('sub17')}>{t('leaderboard:standing.yourStanding')}</div>}
            {standing.pending ? <div className={k('sub15')}>{standing.pending}</div> : null}
            <div className={k('txt')}>{t('leaderboard:standing.pointsNote')}</div>
            <div className={k('txt')}>{t('leaderboard:standing.updateNote')}</div>
          </Card>
          {standing.token ? (
            <Card>
              {standing.token.gated ? (
                <Row
                  wrap
                  lead={<Lead icon="lock" />}
                  title={t('leaderboard:standing.token.withheld')}
                  line={t('leaderboard:standing.token.review')}
                  right={<Btn kind="quiet" small onClick={standing.token.onReview}>{t('leaderboard:standing.token.reviewTerms')}</Btn>}
                />
              ) : (
                <Row
                  wrap
                  lead={<Lead icon="star" />}
                  title={t('leaderboard:standing.token.label')}
                  line={t('leaderboard:standing.token.note')}
                  right={standing.token.revealed ? <Meta>{standing.token.amount}</Meta> : <Btn kind="quiet" small onClick={standing.token.onReveal}>{t('leaderboard:standing.token.reveal')}</Btn>}
                />
              )}
            </Card>
          ) : null}
        </Sec>
      ) : undefined}
    >
      {progress && counts && progress.total > 0 ? (
        <Card pad className="progress">
          <div className={k('sub15', 'mut')}>
            {progress.points == null ? t('leaderboard:progress.plainLabel', counts) : (
              <RichMessage id="leaderboard:progress.summary" values={{ ...counts, points: progress.points }} components={[<b />]} />
            )}
          </div>
          {/* A meter, as the standard bar is (../season-progress.tsx): how many are done, of how many. */}
          <div className={k('prog', progress.done >= progress.total && 'done')} role="meter" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done} aria-label={t('leaderboard:progress.plainLabel', counts)}>
            <i style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
          </div>
        </Card>
      ) : null}
      {onFirst ? <div><button type="button" className={k('link')} onClick={onFirst}>{t('leaderboard:challenges.toFirst')}</button></div> : null}
      {state === 'loading' ? <Card pad>{t('leaderboard:challenges.loading')}</Card> : null}
      {state === 'error' ? <div role="alert"><Note tone="bad" icon="alert">{error}</Note></div> : null}
      {state === 'empty' ? <Card><Row title={t('leaderboard:challenges.empty')} line={t('leaderboard:challenges.emptyHint')} /></Card> : null}
      {groups.filter((group) => group.cards.length).map((group) => (
        <Sec key={group.key} label={group.heading || undefined}>
          <Card>
            {group.cards.map((card) => (card.done ? (
              <Row key={card.key} sm lead={<Lead icon="check" tone="ok" />} title={card.goal || card.label} right={<Meta tone="ok">{card.earned || card.reward}</Meta>} onClick={() => onOpen(card.idx)} />
            ) : (
              <Row key={card.key} wrap lead={<Lead icon="trophy" tone="acc" />} title={card.goal || card.label} line={card.stateLabel || undefined} right={<Pill>{card.reward}</Pill>} go onClick={() => onOpen(card.idx)} sm={false} />
            )))}
          </Card>
        </Sec>
      ))}
      {locked ? <Card><Row wrap lead={<Lead icon="lock" dash />} title={locked.title} line={locked.hint} /></Card> : null}
      {notice && !locked ? <div role="status"><Note>{notice}</Note></div> : null}
    </PageBody>
  );
}

/**
 * Standings under a look: the same head and tabs as Challenges. The event
 * picker, which is the screen's own (../event-bar.tsx), sits under it, and
 * the columns (<StandingsFrameCols/>) under that (app.css orders the three).
 */
export function StandingsFrameHead({ up = true, tabs, onTab }: {
  up?: boolean;
  tabs: Tab[];
  onTab: (key: string) => void;
}) {
  useFrameFlag('standings-frame', up);
  const t = useMessages('leaderboard');
  return (
    <Frame data-standings-frame="">
      <div className={k('inner')}>
        <Head title={t('leaderboard:tabs.challenges')} purpose={t('leaderboard:standing.pointsNote')} />
        <Tabs tabs={tabs} current="topochain" onPick={(key) => onTab(key)} />
      </div>
    </Frame>
  );
}

/** The event on show, as the event bar's hero has it (../event-bar.tsx HeroView). */
export type FrameEvent =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'empty' }
  | { kind: 'event'; name: string; statusLabel: string; description: string | null; dates: string; seasonNote: boolean; fallbackNote: boolean };

/**
 * Standings' two columns: the board, and the event's card beside it (above
 * it on a phone). A member with no earlier season has no picker and no card
 * (`event` null), as on the standard page, and the board is one column.
 */
export function StandingsFrameCols({ event, children }: { event: FrameEvent | null; children?: React.ReactNode }) {
  const t = useMessages('leaderboard');
  const tc = useMessages('core');
  return (
    <Frame data-standings-cols="">
      <div className={k('inner')}>
        <Cols
          sideFirst
          side={event ? (
            <Sec label={t('leaderboard:eventBar.label')} data-frame-event="">
              {event.kind === 'loading' ? <Card pad>{tc('core:common.loading')}</Card> : null}
              {event.kind === 'error' ? <div role="alert"><Note tone="bad" icon="alert">{event.message}</Note></div> : null}
              {event.kind === 'empty' ? <Card pad>{t('leaderboard:eventBar.noneSelected')}</Card> : null}
              {event.kind === 'event' ? (
                <Card text>
                  <div className={k('btnrow')}><h2 className={k('sub22')}>{event.name}</h2><Pill>{event.statusLabel}</Pill></div>
                  {event.description ? <div className={k('sub15')}>{event.description}</div> : null}
                  <div className={k('txt')}>{event.dates}</div>
                  {event.seasonNote ? <div className={k('txt')}>{t('leaderboard:eventBar.seasonNote')}</div> : null}
                  {event.fallbackNote ? <div className={k('txt')}>{t('leaderboard:eventBar.fallbackNote')}</div> : null}
                </Card>
              ) : null}
            </Sec>
          ) : undefined}
        >
          {children}
        </Cols>
      </div>
    </Frame>
  );
}

/**
 * Over the board: "10 of 11 challenges done · View challenges →", and the
 * chip that brings the non-podium people back. The ids are the standard
 * line's and chip's: they are the same controls.
 */
export function StandingsFrameLine({ line, toggle, onChallenges, onToggle }: {
  line: { done: string | null; total: string } | null;
  toggle: { count: number | null; on: boolean } | null;
  onChallenges: () => void;
  onToggle: () => void;
}) {
  const t = useMessages('leaderboard');
  if (!line && !toggle) return null;
  return (
    <div className={k('btnrow', 'line13')} data-standings-line="">
      {line ? (
        <span id="tc-lb-challenge-link">
          <RichMessage
            id={line.done == null ? 'leaderboard:standings.viewChallenges' : 'leaderboard:standings.challengesDone'}
            values={{ done: line.done, count: Number(line.total) }}
            components={[<span />, <button type="button" id="tc-lb-to-challenges" className={k('link')} onClick={onChallenges} />]}
          />
        </span>
      ) : null}
      {toggle ? (
        <Btn small kind={toggle.on ? '' : 'quiet'} id="tc-lb-non-podium-toggle" aria-pressed={toggle.on} onClick={onToggle}>
          {toggle.count == null ? t('leaderboard:standings.showNonPodium') : t('leaderboard:standings.showNonPodiumCount', { count: toggle.count })}
        </Btn>
      ) : null}
    </div>
  );
}

/** "You · #16 · 15,128 points": your own line, lit, which opens your details. */
export function StandingsFrameYou({ you, onOpen }: { you: { rank: string; points: string; count: number } | null | undefined; onOpen: () => void }) {
  const t = useMessages('leaderboard');
  if (!you) return null;
  return (
    <Card>
      <button type="button" id="tc-lb-you" className={k('row', 'sm', 'on', 'you')} onClick={onOpen}>
        <span className={k('tx')}><span className={k('t')}>{t('leaderboard:standings.you', { rank: you.rank, points: you.points, count: you.count })}</span></span>
      </button>
    </Card>
  );
}

/** A row of the board as the pane's view has it; `viewer` marks your own. */
export interface StandingRowLike {
  index: number; rank: string; nonPodium: boolean; user: string; anonymous?: boolean; points: string; viewer?: boolean;
}

/**
 * The board (the tour's s55): one card, its headings as the first row, then
 * a row a person from first place down: the rank as a plain figure, the
 * name, the points. Your own row is lit. A row's details open under it,
 * inside the card, as they do under the table.
 */
export function StandingsFrameRows({ headers, rows, you, openIndex, details, onOpen }: {
  /** The table's own headings: Rank, User, and the points column's name. */
  headers: { rank: string; user: string; points: string };
  rows: StandingRowLike[];
  you: { rank: string } | null;
  openIndex: number | null;
  details?: React.ReactNode;
  onOpen: (index: number) => void;
}) {
  const t = useMessages('leaderboard');
  return (
    <div data-standings-rows="">
      <Card>
        <div className={k('row', 'sm', 'th')}>
          <span className={k('num')}>{headers.rank}</span>
          <span className={k('tx')}><span className={k('t')}>{headers.user}</span></span>
          <span className={k('meta')}>{headers.points}</span>
        </div>
        {rows.map((row) => {
          const mine = !!you && (row.viewer || (!row.nonPodium && row.rank === you.rank));
          return (
            <Fragment key={row.index}>
              <button
                type="button"
                className={k('row', !row.nonPodium && 'sm', 'rk', mine && 'on')}
                data-row-index={row.index}
                aria-label={row.anonymous ? t('leaderboard:standings.openDetailsAnonymous') : t('leaderboard:standings.openDetails', { name: row.user })}
                aria-pressed={openIndex === row.index}
                onClick={() => onOpen(row.index)}
              >
                <span className={k('num')}>{row.rank}</span>
                <span className={k('tx')}>
                  <span className={k('t')}>{row.user}</span>
                  {row.nonPodium ? <span className={k('s')}>{t('leaderboard:standings.nonPodiumTip')}</span> : null}
                </span>
                <span className={k('meta', !row.nonPodium && 'ink')}>{row.points}</span>
              </button>
              {openIndex === row.index && details ? <div className={k('pad')}>{details}</div> : null}
            </Fragment>
          );
        })}
      </Card>
    </div>
  );
}
