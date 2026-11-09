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
import { RichMessage, useMessages } from '../../lib/i18n/react';
import { Btn, Card, Frame, Head, Lead, Meta, Pill, Row, Search, Sec, Tabs, Tile, Track, k } from '@/components/ui/kit';
import { BOT_AVATAR } from '../messages/format';
import { rowKey } from './column';
import {
  byProject, rankProjects, railProjects, shortWords,
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

export function AiFrameList({
  heroLine, main, lit = null, ready, rows, progress, waiting, live, openRow, openThread, picked = [], onPick, appFor, onNew, query, onQuery,
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
}) {
  const t = useMessages('messages');
  const tc = useMessages('changes');
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

          {ready && needs.length === 0 && busy.length === 0 ? <Card pad>{t('messages:frame.bot.quiet')}</Card> : null}
        </div>
      </div>
    </Frame>
  );
}
