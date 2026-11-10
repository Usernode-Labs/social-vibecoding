/**
 * Homeroom bot's list in the one frame, as the 2026-11-06 screen tour draws
 * it (its steps s08, s09 and s14): the page's head (title, one sentence
 * with the counts, New thread), its tabs (All, then your busiest
 * projects), a search, then Main Chat's row and one group per project of
 * the threads that need you, each row ending in the one blue word that says
 * what to do. With a project picked, its work in progress follows, each
 * row with the small five-stop line.
 *
 * It is the same list as ./lists.tsx with another face: the page
 * (./index.tsx) hands it the rows, words and presses it hands that one,
 * built by ./model.ts, and draws this in its place while the device's look
 * is one of the frame's. Nothing is read or decided here.
 */
import { useState, type RefObject } from 'react';

import { RichMessage, useMessages } from '../../lib/i18n/react';
import { getDateLocale } from '../../lib/i18n/runtime';
import { Btn, Card, Frame, GroupLink, Head, Lead, Meta, Pill, Row, Search, Sec, Tabs, Tile, Track, k } from '@/components/ui/kit';
import { HISTORY_KINDS, type HistoryKind } from './filter-address';
import { byMonth, historyGlyph, historyTooltip, historyWords, monthName, type HistoryRow, type HistoryState } from './history';
import { BOT_AVATAR } from '../messages/format';
import { rowKey } from './column';
import {
  GROUP_FIRST, byProject, notMoving, rankProjects, railProjects, shortWords,
  type AiApp, type AiThread, type Phrase, type WorkRow,
} from './model';
import type { Stage } from '../../lib/work-state';

/** Where a stage sits on the five-stop line, and whether it waits on someone. */
const STOP: Record<Stage, [number, 'now' | 'wait']> = {
  reading: [0, 'now'], planning: [0, 'now'], waiting_for_you: [0, 'wait'], building: [1, 'now'], checking: [2, 'now'],
  up_for_vote: [3, 'wait'], going_live: [4, 'now'], live: [5, 'now'], stopped: [1, 'wait'], closed: [5, 'now'],
};

/** The glyph a Needs you row leads with, by what it asks (./lists.tsx needGlyph's kinds). */
function needIcon(row: WorkRow): string {
  const kind = row.key.startsWith('need:') ? row.key.split(':')[1] : row.key.split(':')[0];
  if (kind === 'question' || kind === 'bot_question') return 'reply';
  if (kind === 'decide' || kind === 'plan') return 'hand';
  if (kind === 'private') return 'lock';
  return 'vote';
}

/** The glyph of a finished item: what became of it. */
const HISTORY_ICON: Record<ReturnType<typeof historyGlyph>, string> = { live: 'check', closed: 'x', request: 'chat', vote: 'vote', private: 'lock' };

export function AiFrameList({
  heroLine, main, lit = null, ready, rows, progress, waiting, live, openRow, openThread, picked = [], onPick, appFor, onNew, query, onQuery,
  history = null, historyKind = null, onHistoryKind, openHistory, historyRef,
}: {
  /** The one sentence under the title: the counts, as the page's own heading says them (./model.ts heroWords). */
  heroLine: Phrase | null;
  main: { lit: boolean; unread: number; open: () => void };
  lit?: string | null;
  ready: boolean;
  rows: WorkRow[];
  progress: AiThread[];
  waiting: AiThread[];
  live: AiThread[];
  openRow: (row: WorkRow) => void;
  openThread: (t: AiThread) => void;
  picked?: readonly string[];
  onPick?: (slugs: string[]) => void;
  appFor?: (slug: string) => AiApp | null;
  onNew: () => void;
  query: string;
  onQuery: (next: string) => void;
  /** HISTORY (./history.ts): what finished, by month; the You tab's three lists (your changes, requests, votes) are its kinds. */
  history?: HistoryState | null;
  historyKind?: HistoryKind | null;
  onHistoryKind?: (kind: HistoryKind | null) => void;
  openHistory?: (row: HistoryRow) => void;
  /** The group itself, which #homeroom-bot/history scrolls to. */
  historyRef?: RefObject<HTMLDivElement | null>;
}) {
  const t = useMessages('messages');
  const tc = useMessages('changes');
  const tco = useMessages('core');
  const say = (p: Phrase | null): string => {
    if (!p) return '';
    const nested = p.nested ? Object.fromEntries(Object.entries(p.nested).map(([key, q]) => [key, say(q)])) : null;
    return t(p.id, nested ? { ...p.values, ...nested } : p.values);
  };
  const stops = [tc('changes:track.plan'), tc('changes:track.build'), tc('changes:track.checks'), tc('changes:track.vote'), tc('changes:track.live')] as const;

  // The tabs: All, then the busiest projects, then any other one a link picked.
  const ranked = rankProjects(rows, progress, waiting, live);
  const projects = railProjects(ranked, [...picked]);
  for (const slug of picked) {
    if (!projects.some((p) => p.slug === slug)) { const app = appFor?.(slug); if (app) projects.push(app); }
  }
  const current = picked.length === 1 ? picked[0] : picked.length === 0 ? '' : picked.join();

  const q = query.trim().toLowerCase();
  const matches = (title: string | null, app: AiApp | null, number?: number | null) => {
    if (picked.length && !(app && picked.includes(app.slug))) return false;
    if (!q) return true;
    return (title || '').toLowerCase().includes(q) || (app?.name || '').toLowerCase().includes(q) || (number != null && `#${number}`.includes(q));
  };
  const needs = rows.filter((row) => matches(row.title, row.app));
  const busy = picked.length ? progress.filter((th) => matches(th.title, th.app, th.number)) : [];
  // Under All, the product's three groups (./lists.tsx): what is under way
  // and what moves while it waits as one, folded after its first rows; the
  // rows nobody is moving put away under their head; what went live this
  // week, folded the same way. A search shows every match.
  const [moreBusy, setMoreBusy] = useState(false);
  const [showStill, setShowStill] = useState(false);
  const [moreLive, setMoreLive] = useState(false);
  const allBusy = picked.length ? [] : [...progress, ...waiting.filter((th) => !notMoving(th))].filter((th) => matches(th.title, th.app, th.number));
  const still = picked.length ? [] : waiting.filter((th) => notMoving(th) && matches(th.title, th.app, th.number));
  const went = live.filter((th) => matches(th.title, th.app, th.number));
  const fold = <T,>(list: T[], open: boolean, first: number): T[] => (q || open || list.length <= first ? list : list.slice(0, first));
  const threadRow = (th: AiThread, kind: 'busy' | 'live') => {
    const [at, state] = STOP[th.work.stage] || [0, 'now'];
    return (
      <Row
        key={`${kind}:${th.threadId}`}
        lead={kind === 'live' ? <Lead icon="check" tone="ok" /> : <Lead icon={notMoving(th) ? 'clock' : 'tool'} />}
        title={th.title || (th.number != null ? `#${th.number}` : '')}
        line={kind === 'live' ? th.app?.name || undefined : say(shortWords(th)) || undefined}
        right={kind === 'live' ? undefined : <Track mini at={at} state={state} words={stops} />}
        on={!!lit && rowKey(th) === lit}
        onClick={() => openThread(th)}
      />
    );
  };
  const moreLink = (list: unknown[], open: boolean, first: number, toggle: (next: boolean) => void) => (q || list.length <= first ? null : (
    <GroupLink onClick={() => toggle(!open)}>{open ? t('messages:frame.bot.showLess') : t('messages:frame.bot.showMore', { count: list.length - first })}</GroupLink>
  ));
  const locale = getDateLocale();
  const done = (history?.rows || []).filter((row) => matches(row.title, row.app, row.number));
  const months = byMonth(done);
  const kindWord = (kind: HistoryKind | null) => (kind === 'change' ? t('messages:ai.history.kind.change')
    : kind === 'request' ? t('messages:ai.history.kind.request')
      : kind === 'vote' ? t('messages:ai.history.kind.vote')
        : kind === 'solo' ? t('messages:ai.history.kind.solo') : t('messages:ai.history.kind.all'));

  return (
    <Frame className="fr-pane" data-ai-frame-list="">
      <div className={k('scroll')}>
        <Head
          title={t('messages:ai.hero.name')}
          purpose={heroLine ? <RichMessage id={heroLine.id} values={heroLine.values} components={[<span />]} /> : undefined}
          acts={<Btn icon="plus" onClick={onNew}>{t('messages:frame.bot.new')}</Btn>}
        />
        <Tabs
          tabs={[
            { key: '', label: t('messages:frame.bot.all'), count: picked.length === 0 ? rows.length : undefined },
            ...projects.map((p) => ({ key: p.slug, label: p.name })),
          ]}
          current={current}
          onPick={(key) => onPick?.(key ? [key] : [])}
        />
        <Search value={query} onChange={onQuery} placeholder={t('messages:frame.bot.search')} />
        <div className={k('stack')}>
          {q || picked.length ? null : (
            <Sec>
              <Card>
                <Row
                  lead={<Tile name={t('messages:store.header.main')} src={BOT_AVATAR} />}
                  title={t('messages:store.header.main')}
                  line={t('messages:frame.bot.mainLine')}
                  right={main.unread > 0 ? <Pill kind="act">{t('messages:frame.bot.newCount', { count: main.unread })}</Pill> : null}
                  on={main.lit}
                  onClick={main.open}
                />
              </Card>
            </Sec>
          )}

          {byProject(needs).map(({ app, items }) => (
            <Sec key={app?.slug || '-'} label={app ? t('messages:frame.bot.groupNeeds', { project: app.name }) : t('messages:frame.bot.needs')}>
              <Card>
                {items.map((row) => (
                  <Row
                    key={row.key}
                    lead={<Lead icon={needIcon(row)} tone={row.pill ? 'acc' : undefined} />}
                    title={row.title}
                    line={say(row.sub) || undefined}
                    right={row.pill ? <Pill kind="act">{say(row.pill)}</Pill> : <Meta>{t('messages:frame.bot.onlyYou')}</Meta>}
                    on={!!lit && rowKey(row) === lit}
                    onClick={() => openRow(row)}
                  />
                ))}
              </Card>
            </Sec>
          ))}

          {byProject(busy).map(({ app, items }) => (
            <Sec key={`busy:${app?.slug || '-'}`} label={app ? t('messages:frame.bot.groupProgress', { project: app.name }) : t('messages:frame.bot.progress')}>
              <Card>
                {items.map((th) => {
                  const [at, state] = STOP[th.work.stage] || [0, 'now'];
                  return (
                    <Row
                      key={th.threadId}
                      lead={<Lead icon="tool" />}
                      title={th.title || (th.number != null ? `#${th.number}` : '')}
                      line={say(shortWords(th)) || undefined}
                      right={<Track mini at={at} state={state} words={stops} />}
                      on={!!lit && rowKey(th) === lit}
                      onClick={() => openThread(th)}
                    />
                  );
                })}
              </Card>
            </Sec>
          ))}

          {allBusy.length ? (
            <Sec label={t('messages:ai.busy.title', { count: allBusy.length })} action={moreLink(allBusy, moreBusy, GROUP_FIRST.busy, setMoreBusy)}>
              <Card>{fold(allBusy, moreBusy, GROUP_FIRST.busy).map((th) => threadRow(th, 'busy'))}</Card>
            </Sec>
          ) : null}
          {still.length ? (
            <Sec label={t('messages:ai.up.stillCount', { count: still.length })} action={q ? null : <GroupLink onClick={() => setShowStill(!showStill)}>{showStill ? t('messages:frame.bot.showLess') : t('messages:frame.bot.show')}</GroupLink>}>
              {q || showStill ? <Card>{still.map((th) => threadRow(th, 'busy'))}</Card> : null}
            </Sec>
          ) : null}
          {went.length ? (
            <Sec label={t('messages:ai.live.title', { count: went.length })} action={moreLink(went, moreLive, GROUP_FIRST.live, setMoreLive)}>
              <Card>{fold(went, moreLive, GROUP_FIRST.live).map((th) => threadRow(th, 'live'))}</Card>
            </Sec>
          ) : null}

          {ready && needs.length === 0 && busy.length === 0 && allBusy.length === 0 && went.length === 0 ? <Card pad>{t('messages:frame.bot.quiet')}</Card> : null}

          {history && (!q || done.length) ? (
            <div ref={historyRef} data-ai-frame-history="">
              <Sec
                label={t('messages:ai.history.title')}
                action={(
                  <span className={k('btnrow')} role="group" aria-label={t('messages:ai.history.kind.label')}>
                    {[null, ...HISTORY_KINDS].map((kind) => (
                      <Btn key={kind || 'all'} kind={historyKind === kind ? '' : 'quiet'} small aria-pressed={historyKind === kind} onClick={() => onHistoryKind?.(kind)}>{kindWord(kind)}</Btn>
                    ))}
                  </span>
                )}
              >
                {!history.ready ? <Card pad>{t('messages:ai.history.loading')}</Card>
                  : history.failed && !done.length ? (
                    <Card pad>{t('messages:ai.history.failed')} <Btn kind="quiet" small onClick={history.retry}>{tco('core:common.tryAgain')}</Btn></Card>
                  ) : !done.length && !history.next ? <Card pad>{t('messages:ai.history.empty')}</Card> : null}
              </Sec>
              {months.map((month) => (
                <Sec key={month.key} label={monthName(month.at, locale)}>
                  <Card>
                    {month.rows.map((row) => (
                      <Row
                        key={row.key}
                        lead={<Lead icon={HISTORY_ICON[historyGlyph(row)]} tone={historyGlyph(row) === 'live' ? 'ok' : undefined} />}
                        title={row.title || (row.number != null ? `#${row.number}` : '')}
                        line={say(historyTooltip(row)) || undefined}
                        right={<Meta>{say(historyWords(row, locale))}</Meta>}
                        on={!!lit && rowKey({ rootId: row.rootId ?? null, href: row.href }) === lit}
                        onClick={() => openHistory?.(row)}
                      />
                    ))}
                  </Card>
                </Sec>
              ))}
              {history.ready && history.next ? (
                <GroupLink onClick={history.more}>{history.loading ? t('messages:ai.history.loading') : t('messages:ai.history.earlier')}</GroupLink>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </Frame>
  );
}
