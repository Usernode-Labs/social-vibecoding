/**
 * Changes, Requests and Votes, as tabs of You under a look (the version 2
 * tour's s46 to s48): the bot's History for one kind, drawn here.
 *
 * The rows, their words and their reads are History's own (../../ai/history.ts
 * useHistory, the hook the Homeroom bot page's card reads with; GET
 * /api/ai/history), so a thing listed there is listed here and says the same:
 * by month, then by project, one line each (its mark, its number, its title,
 * how it ended), "Earlier months" at the end. The tab is the kind, so there
 * are no kind buttons. The side column holds the projects to narrow the list
 * to (a row of small buttons over the list on a phone); one project picked is
 * read from the server, whose pages are then that project's.
 *
 * `#homeroom-bot/history?kind=…` still opens the Homeroom bot page; this is
 * another way to the same list, from You.
 */
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';

import { Btn, Card, Icon, Meta, Row, Sec, ShowAll, Tile, k } from '@/components/ui/kit';
import { getDateLocale } from '../../../lib/i18n/runtime';
import { useMessages } from '../../../lib/i18n/react';
import type { HistoryKind } from '../../ai/filter-address';
import { byMonth, historyGlyph, historyWords, monthName, useHistory, type HistoryRow } from '../../ai/history';
import { byProject, type AiApp, type Phrase } from '../../ai/model';
import { YouPage, type YouShell } from './you-frame';

/** The glyph of a finished item: what became of it (../../ai/frame-list.tsx draws the same). */
const HISTORY_ICON: Record<ReturnType<typeof historyGlyph>, string> = { live: 'check', closed: 'x', request: 'chat', vote: 'vote', private: 'lock' };

const NONE: readonly string[] = [];

function isDemo(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('demo') === '1';
}

function ProjectTile({ app, size }: { app: AiApp; size: number }): ReactNode {
  return <Tile size={size} src={app.icon_url} emoji={app.icon_emoji} name={app.name || app.slug} />;
}

export function YouHistory({ shell, kind }: { shell: YouShell; kind: HistoryKind }) {
  const t = useMessages('messages');
  const tp = useMessages('profile');
  const tc = useMessages('core');
  const locale = getDateLocale();
  const say = (p: Phrase): string => String(t(p.id, p.values as Record<string, unknown> | undefined));
  // One project, or all of them. The list of projects is every one a read has
  // named: once one is picked the server answers with its rows alone, and the
  // others must stay there to be picked.
  const [picked, setPicked] = useState<string | null>(null);
  const [projects, setProjects] = useState<AiApp[]>([]);
  // Read once the tab is up (after mount, as the page's first render is the server's).
  const [showing, setShowing] = useState(0);
  useEffect(() => { setShowing(1); }, []);
  const one = useMemo(() => (picked ? [picked] : NONE), [picked]);
  const history = useHistory({
    showing,
    signedIn: showing > 0 && typeof window !== 'undefined' && !!(window as any).App?.user,
    projects: one,
    kind,
    demo: isDemo(),
  });
  useEffect(() => {
    setProjects((had) => {
      const seen = new Set(had.map((app) => app.slug));
      const more = history.rows.map((row) => row.app).filter((app): app is AiApp => !!app && !seen.has(app.slug) && !!seen.add(app.slug));
      return more.length ? [...had, ...more] : had;
    });
  }, [history.rows]);
  // A read that is on its way for another project still holds the last one's rows.
  const rows = picked ? history.rows.filter((row) => row.app?.slug === picked) : history.rows;
  const months = byMonth(rows);
  const more = history.ready && history.next
    ? <ShowAll onClick={history.more}>{history.loading ? t('messages:ai.history.loading') : t('messages:ai.history.earlier')}</ShowAll>
    : null;
  const number = (row: HistoryRow) => (row.number
    ? t(row.change && row.app?.changesOnGithub ? 'messages:ai.live.numberPr' : 'messages:ai.live.number', { number: row.number })
    : '');
  return (
    <YouPage
      shell={shell}
      side={projects.length ? (
        <div className={k('d')}>
          <Sec label={tp('profile:frame.projects')}>
            <Card>
              <Row sm kind="item" title={tp('profile:frame.allProjects')} on={!picked} pressed={!picked} right={!picked ? <Icon name="check" size={18} /> : null} onClick={() => setPicked(null)} />
              {projects.map((app) => (
                <Row
                  key={app.slug}
                  sm
                  kind="item"
                  lead={<ProjectTile app={app} size={24} />}
                  title={app.name || app.slug}
                  on={picked === app.slug}
                  pressed={picked === app.slug}
                  right={picked === app.slug ? <Icon name="check" size={18} /> : null}
                  onClick={() => setPicked(app.slug)}
                />
              ))}
            </Card>
          </Sec>
        </div>
      ) : undefined}
    >
      {projects.length ? (
        <div className={k('btnrow', 'chips', 'p')} role="group" aria-label={tp('profile:frame.projects')}>
          <Btn small kind={picked ? 'quiet' : ''} aria-pressed={!picked} onClick={() => setPicked(null)}>{tp('profile:frame.allProjects')}</Btn>
          {projects.map((app) => (
            <Btn key={app.slug} small kind={picked === app.slug ? '' : 'quiet'} aria-pressed={picked === app.slug} onClick={() => setPicked(app.slug)}>{app.name || app.slug}</Btn>
          ))}
        </div>
      ) : null}
      {!history.ready ? <Card pad>{t('messages:ai.history.loading')}</Card>
        : history.failed && !rows.length ? (
          <Card pad>{t('messages:ai.history.failed')} <Btn kind="quiet" small onClick={history.retry}>{tc('core:common.tryAgain')}</Btn></Card>
        ) : !rows.length && !history.next ? <Card pad>{t('messages:ai.history.empty')}</Card> : null}
      {months.map((month, at) => (
        <Sec key={month.key} label={monthName(month.at, locale)} data-you-history-month={month.key}>
          <Card>
            {byProject(month.rows).map((group) => (
              <Fragment key={group.app?.slug || ''}>
                {group.app ? (
                  <Row
                    sm
                    kind="proj"
                    lead={<ProjectTile app={group.app} size={24} />}
                    title={group.items[0]?.left ? tp('profile:frame.projectLeft', { project: group.app.name || group.app.slug }) : (group.app.name || group.app.slug)}
                  />
                ) : null}
                {group.items.map((row) => (
                  <Row
                    key={row.key}
                    sm
                    kind="item"
                    glyph={HISTORY_ICON[historyGlyph(row)]}
                    num={number(row)}
                    title={row.title || ''}
                    right={<Meta>{say(historyWords(row, locale))}</Meta>}
                    href={row.href || undefined}
                  />
                ))}
              </Fragment>
            ))}
            {at === months.length - 1 ? more : null}
          </Card>
        </Sec>
      ))}
      {history.ready && !months.length && more ? <Card>{more}</Card> : null}
    </YouPage>
  );
}
