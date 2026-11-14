/**
 * Homeroom bot's lists under a look (version 2, 11 Nov 2026): the content
 * of the standard page (./lists.tsx AiLists) in the first tour's layout.
 *
 *   [tile] Homeroom bot                  (search) ( + New chat )
 *          Needs you: 18 · In progress: 12
 *   ( All ) ( Homeroom ) ( Game Corner ) ( 15 more ⌄ )     ← tabs, a toggle each
 *   NEEDS YOU · 18                   ← a labelled group, one card
 *     [tile] Homeroom
 *      ☑ #6370  Email templates: keep…            (Vote)
 *      🔒 PR 6198  Keep a vote that decides…   Only you  ⋯
 *         Show 8 more ⌄
 *   WAITING & IN PROGRESS · 40       … with "Not moving · 24" as its last row
 *   LIVE THIS WEEK · 81
 *   HISTORY                          its kinds, then months, then Earlier months
 *
 * Every row, count, chip and note is the one ./lines.ts builds for both
 * faces; folding is ./model.ts groupRows, as the standard list folds. This
 * file only maps them to kit rows. Nothing is read or decided here.
 */
import { Fragment, useRef, useState, type FocusEvent, type ReactNode, type Ref } from 'react';

import { RichMessage, useMessages } from '../../lib/i18n/react';
import { getDateLocale } from '../../lib/i18n/runtime';
import { reload as reloadTab } from '../../lib/tab-build';
import { Btn, Card, Count, Frame, Icon, Pill, Sec, Tile, k } from '@/components/ui/kit';
import { BOT_AVATAR } from '../messages/format';
import { ThreadDoneMenu } from '../messages/private-thread-done';
import { HISTORY_KINDS, type HistoryKind } from './filter-address';
import { monthName, type HistoryRow, type HistoryState } from './history';
import { Marked, followFound } from './found';
import { dayHeading, useAiLines, type FoundLine, type Glyph, type Line } from './lines';
import { GROUP_FIRST, byDay, byProject, dayKey, freshFirst, groupRows, holdOrder, type AiApp, type AiThread, type Phrase, type WorkRow } from './model';
import { usePhone } from './phone-drawer';
import { ProjectPicker } from './project-picker';
import type { Found } from './search';

/** Each glyph's icon in the kit's set (./lines.ts names them). */
const ICON: Record<Glyph, string> = {
  chat: 'chat', play: 'play', hand: 'hand', check: 'check', again: 'refresh', warning: 'alert', lock: 'lock', ballot: 'vote',
  upload: 'up', eye: 'eye', cog: 'tool', reply: 'reply', code: 'code', clock: 'clock', x: 'x', bubble: 'chat',
};

/**
 * One line of the lists: its glyph, its number, its title, the one word on its right.
 * `where`: on a phone, where the number has no room and nothing hovers, the
 * row's own line (its project and number, the tooltip's words) is its second line.
 */
function LineRow({ line, plain = false, where = false }: { line: Line; plain?: boolean; where?: boolean }): ReactNode {
  const t = useMessages('messages');
  // #6421: a thread that holds several requests says how many after its title.
  const many = Number(line.requests) > 1;
  const requestsWord = many ? t('messages:ai.row.requests', { count: line.requests }) : '';
  const tooltip = many ? `${line.tooltip} · ${requestsWord}` : line.tooltip;
  const row = (
    <button
      type="button"
      className={k('row sm item', line.lit && 'on', line.fresh && 'fresh', plain && 'plain')}
      onClick={line.open}
      title={tooltip}
      data-ai-line={line.kind}
      data-ai-lit={line.lit ? '' : undefined}
      data-ai-fresh={line.fresh ? '' : undefined}
      aria-current={line.lit ? 'true' : undefined}
    >
      {line.fresh ? <span className={k('new')} aria-hidden="true" data-ai-dot="" /> : null}
      <span className={k('ei', line.owe && 'acc')} aria-hidden="true"><Icon name={ICON[line.glyph]} size={18} /></span>
      {/* From 768px only: a phone's title needs the room, and the tooltip still says the number. */}
      <span className={k('num mono d')}>
        {line.number ? t(line.pr ? 'messages:ai.live.numberPr' : 'messages:ai.live.number', { number: line.number }) : ''}
      </span>
      <span className={k('tx')}>
        <span className={k('t')}>
          {line.title}
          {many ? <span className={k('mut')} data-ai-line-requests={line.requests}> {requestsWord}</span> : null}
        </span>
        {line.why ? <span className={k('s p')} aria-hidden="true" data-ai-line-why="">{line.why}</span>
          : where && line.tooltip ? <span className={k('s p')} aria-hidden="true" data-ai-line-where="">{line.tooltip}</span> : null}
      </span>
      {line.owe ? <Pill kind="act">{line.right}</Pill> : line.right ? <span className={k('meta')}>{line.right}</span> : null}
      <span className="sr-only">{tooltip}</span>
    </button>
  );
  // #6159: a private thread's row has its ⋯ beside it, with Mark done.
  if (!line.done) return row;
  const { rootId, mark } = line.done;
  return (
    <div className={k('rowx')} data-ai-line-done="">
      {row}
      <ThreadDoneMenu rootId={rootId} done={false} onChanged={(state) => { if (state === 'done') mark(); }} />
    </div>
  );
}

/** The words the search found, in a snippet: the look's accent tint behind its own ink (kit tokens). */
const FOUND_MARK = 'rounded-[3px] bg-[color:var(--fr-acc-t)] font-semibold text-[color:var(--fr-ink)]';

/**
 * 13 Nov 2026 (./search.ts): a message the search found, as a kit row that
 * is a link to it: its snippet with the found words marked, where it is on
 * the row's own line under it, and its day. The link's name says all of
 * it, and who wrote it.
 */
function FoundRow({ line }: { line: FoundLine }): ReactNode {
  return (
    <a
      className={k('row sm item')}
      href={line.href}
      title={line.name}
      aria-label={line.name}
      onClick={(e) => followFound(e, line.href)}
      data-ai-found={line.thread ? 'thread' : 'chat'}
    >
      <span className={k('ei')} aria-hidden="true"><Icon name="chat" size={18} /></span>
      <span className={k('tx')}>
        <span className={k('t')} data-ai-found-words=""><Marked parts={line.parts} className={FOUND_MARK} /></span>
        <span className={k('s')} data-ai-found-place="">{line.place}</span>
      </span>
      <span className={k('meta')}>{line.date}</span>
    </a>
  );
}

/** A small caps line with a rule after it: a day inside a project's rows, or "Earlier". */
function Rule({ children, day }: { children: ReactNode; day?: string }): ReactNode {
  return <div className={k('rule')} data-ai-day={day} data-ai-earlier={day === undefined ? '' : undefined}>{children}</div>;
}

/** A compact list's last row of a part: "Show 8 more ⌄", "Not moving · 24 ⌄", "Earlier months ⌄". */
function MoreRow({ open, onClick, disabled, children, ...data }: {
  open?: boolean; onClick: () => void; disabled?: boolean; children: ReactNode;
} & Record<`data-${string}`, string | undefined>): ReactNode {
  return (
    <button type="button" className={k('row sm more')} onClick={onClick} aria-expanded={open} disabled={disabled || undefined} {...data}>
      <span className={k('tx')}><span className={k('t')}>{children}</span></span>
      <Icon name={open ? 'cu' : 'cd'} size={18} />
    </button>
  );
}

/**
 * One list's rows under their project's name, each project's first few
 * before its own Show more: the standard list's GroupList, in kit rows.
 * You's Changes, Requests and Votes draw History with it too
 * (../profile/frame/you-history.tsx).
 */
export function Groups({ lines, heads, first, freshStyle = false, freshProjects, dayHeads = false, foldFresh = false, where = false }: {
  lines: Line[];
  heads: boolean;
  first: number;
  freshStyle?: boolean;
  freshProjects?: Record<string, number>;
  dayHeads?: boolean;
  foldFresh?: boolean;
  /** Each row says its project and number on a phone's second line (<LineRow where/>). */
  where?: boolean;
}): ReactNode {
  const t = useMessages('messages');
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const locale = getDateLocale();
  return (
    <>
      {byProject(lines).map((g) => {
        const key = g.app?.slug || 'none';
        const open = !!opened[key];
        // The row you are on and a row with something new are never folded away (./model.ts groupRows).
        const { items, shown, hidden } = groupRows(dayHeads ? byDay(g.items) : g.items, first, open, !foldFresh);
        const freshHidden = foldFresh ? items.slice(shown).filter((line) => line.fresh).length : 0;
        const anyFresh = freshStyle && g.items.some((line) => line.fresh);
        const firstOld = anyFresh ? items.findIndex((line) => !line.fresh) : -1;
        const earlierAt = firstOld >= 0 && firstOld < shown ? firstOld : -1;
        const freshHere = freshStyle && g.app ? freshProjects?.[g.app.slug] || 0 : 0;
        let lastDay = '';
        const drawn = (open ? items : items.slice(0, shown)).map((line) => {
          const day = dayHeads ? dayKey(line.at) : '';
          const divider = !!day && day !== lastDay;
          if (day) lastDay = day;
          return { line, divider };
        });
        return (
          <div key={key} data-ai-group={key}>
            {heads ? (
              <div className={k('row sm proj')} data-ai-project-head="">
                {/* A private idea in no project yet goes under Only you, with a lock. */}
                {g.app
                  ? <Tile size={22} name={g.app.name || g.app.slug} src={g.app.icon_url} emoji={g.app.icon_emoji} />
                  : <span className={k('ei')} aria-hidden="true"><Icon name="lock" size={16} /></span>}
                <span className={k('tx')}>
                  <span className={k('t')}>
                    {g.app ? g.app.name || g.app.slug : t('messages:ai.short.private')}
                    {g.items.some((line) => line.left) ? <span className={k('mut')} data-ai-left=""> · {t('messages:ai.history.left')}</span> : null}
                  </span>
                </span>
                {freshHere > 0 ? <Pill kind="act">{t('messages:ai.work.fresh', { count: freshHere })}</Pill> : null}
              </div>
            ) : null}
            {drawn.map(({ line, divider }, i) => (
              <Fragment key={line.key}>
                {i === earlierAt ? <Rule>{t('messages:ai.work.earlier')}</Rule> : null}
                {divider ? <Rule day={dayKey(line.at)}>{dayHeading(line.at, t, locale)}</Rule> : null}
                <LineRow line={line} plain={anyFresh && !line.fresh} where={where} />
              </Fragment>
            ))}
            {hidden ? (
              <MoreRow open={open} onClick={() => setOpened((o) => ({ ...o, [key]: !open }))} data-ai-group-more="">
                {open
                  ? t('messages:ai.work.showLess')
                  : freshHidden > 0
                    ? t('messages:ai.work.showMoreFresh', { count: hidden, fresh: freshHidden })
                    : t('messages:ai.work.showMore', { count: hidden })}
              </MoreRow>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

/**
 * #6245: while the pointer is over Needs you, or a row in it has the
 * keyboard's focus, the rows keep the order they were drawn in, so a live
 * refresh cannot slide one out from under a press (./lists.tsx Section).
 */
function useHeld(lines: Line[]) {
  const ref = useRef<HTMLElement | null>(null);
  const drawn = useRef<string[] | null>(null);
  const [holding, setHolding] = useState(false);
  const held = holding && drawn.current ? holdOrder(lines, drawn.current) : lines;
  const start = () => { if (!drawn.current) drawn.current = lines.map((line) => line.key); setHolding(true); };
  const end = () => { drawn.current = null; setHolding(false); };
  const within = (node: EventTarget | null) => !!ref.current && node instanceof Node && ref.current.contains(node);
  return {
    held,
    props: {
      ref,
      onPointerEnter: start,
      onPointerLeave: end,
      onFocus: (e: FocusEvent) => { if (!within(e.relatedTarget)) start(); },
      onBlur: (e: FocusEvent) => { if (!within(e.relatedTarget)) end(); },
    },
  };
}

export function AiFrameList({
  heroLine, query = '', found, onFoundRetry, onQuery, searchOpen, onSearch, searchRef, lit = null, ready, failed = null, onRetry, rows, owed, progress, waiting, live,
  openRow, openThread, onDone, picked: pickedIn = [], onPick, appFor, onNew,
  history = null, historyKind = null, onHistoryKind, openHistory, historyRef,
}: {
  /** The one sentence under the title: the counts, as the page's own heading says them (./model.ts heroWords). */
  heroLine: Phrase | null;
  /** What the search box says, '' while it is closed (#6398). */
  query?: string;
  /** 13 Nov 2026: the messages that match it (./search.ts useBotSearch); null while the first answer is on its way. */
  found?: Found | null;
  /** Search the messages again, after a read that failed. */
  onFoundRetry?: () => void;
  onQuery: (next: string) => void;
  /** The search box is open under the head; its round button opens and closes it. */
  searchOpen: boolean;
  onSearch: (open: boolean) => void;
  searchRef?: Ref<HTMLInputElement>;
  lit?: string | null;
  ready: boolean;
  failed?: 'unreachable' | 'failed' | null;
  onRetry?: () => void;
  rows: WorkRow[];
  owed: number;
  progress: AiThread[];
  waiting: AiThread[];
  live: AiThread[];
  openRow: (row: WorkRow) => void;
  openThread: (t: AiThread) => void;
  onDone?: (rootId: number) => void;
  picked?: readonly string[];
  onPick?: (slugs: string[]) => void;
  appFor?: (slug: string) => AiApp | null;
  /** The "+": a new blank thread with the bot. */
  onNew: () => void;
  history?: HistoryState | null;
  historyKind?: HistoryKind | null;
  onHistoryKind?: (kind: HistoryKind | null) => void;
  openHistory?: (row: HistoryRow) => void;
  /** The group itself, which #homeroom-bot/history scrolls to. */
  historyRef?: Ref<HTMLDivElement>;
}) {
  const t = useMessages('messages');
  const tco = useMessages('core');
  const {
    searching, ranked, picked, rail, past, setOnly, toggle, freshAll, freshByApp, freshShown, freshProjects,
    needLines, busyLines, stillLines, liveLines, liveBehind, onlyApp, nothingHere, locale, historyLines, historyMonths,
    owedShown, heads, noMatches, noneWords, foundLines, foundMore, foundFailed,
  } = useAiLines({ query, lit, ready, rows, owed, progress, waiting, live, openRow, openThread, onDone, picked: pickedIn, onPick, appFor, history, openHistory, found });
  const [more, setMore] = useState<DOMRect | null>(null);
  const [stillOpen, setStillOpen] = useState(false);
  const phone = usePhone();
  // Needs you draws what is new first, then holds the order under the pointer.
  const needs = useHeld(freshFirst(needLines));
  // A row in the folded part that is where you are opens it.
  const stillShown = stillOpen || stillLines.some((line) => line.lit);
  const first = (n: number) => (searching ? Infinity : n);
  const kindWord = (kind: HistoryKind | null) => (kind === 'change' ? t('messages:ai.history.kind.change')
    : kind === 'request' ? t('messages:ai.history.kind.request')
      : kind === 'vote' ? t('messages:ai.history.kind.vote')
        : kind === 'solo' ? t('messages:ai.history.kind.solo') : t('messages:ai.history.kind.all'));
  const fresh = (count: number) => (count > 0 ? <Count label={t('messages:ai.filter.fresh', { count })}>{count}</Count> : null);

  return (
    <Frame className="fr-pane" data-ai-frame-list="">
      <div className={k('scroll botpage')}>
        <div className={k('head')} data-ai-hero="">
          <Tile size={48} name={t('messages:ai.hero.name')} src={BOT_AVATAR} />
          <div className={k('tx')}>
            <h1 className={k('title')}>{t('messages:ai.hero.name')}</h1>
            {heroLine ? <p className={k('purpose')} data-ai-hero-sub=""><RichMessage id={heroLine.id} values={heroLine.values} components={[<span />]} /></p> : null}
          </div>
          <div className={k('acts')}>
            <button
              type="button"
              className={k('ib more')}
              aria-label={t('messages:ai.search.open')}
              title={t('messages:ai.search.open')}
              aria-expanded={searchOpen}
              data-ai-search-toggle=""
              onClick={() => { if (searchOpen) onQuery(''); onSearch(!searchOpen); }}
            >
              <Icon name="search" size={18} />
            </button>
            {/* New chat: the page's one primary, labelled (14 Nov 2026). */}
            <Btn small icon="plus" data-bot-new-thread="" data-ai-new-chat="" onClick={onNew}>{t('messages:newThread.start')}</Btn>
          </div>
        </div>
        {searchOpen ? (
          <div className={k('search')}>
            <label className={k('inp', query && 'val')}>
              <Icon name="search" size={18} />
              <input
                ref={searchRef}
                type="search"
                className={k('v')}
                value={query}
                onChange={(e) => onQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onQuery(''); onSearch(false); } }}
                placeholder={t('messages:ai.search.label')}
                aria-label={t('messages:ai.search.label')}
                data-ai-search=""
              />
            </label>
          </div>
        ) : null}
        {ranked.length > 1 || picked.length ? (
          // The standard chips: a toggle each, All when none is picked, and
          // the rest of the projects behind "N more".
          <nav className={k('tabs')} aria-label={t('messages:ai.filter.label')} data-ai-project-filter="">
            <button type="button" className={k('tab', !picked.length && 'on')} aria-pressed={!picked.length} onClick={() => setOnly([])}>
              {t('messages:ai.filter.all')}{fresh(freshAll)}
            </button>
            {rail.map((app) => (
              <button key={app.slug} type="button" className={k('tab', picked.includes(app.slug) && 'on')} aria-pressed={picked.includes(app.slug)} onClick={() => toggle(app.slug)} data-ai-chip={app.slug}>
                {/* The project's own tile before its name, as on the standard chip. */}
                <Tile size={18} name={app.name || app.slug} src={app.icon_url} emoji={app.icon_emoji} />
                {app.name || app.slug}{fresh(freshByApp[app.slug] || 0)}
              </button>
            ))}
            {past > 0 ? (
              <button
                type="button"
                className={k('tab')}
                aria-haspopup="dialog"
                aria-expanded={!!more}
                onClick={(e) => setMore(more ? null : e.currentTarget.getBoundingClientRect())}
                data-ai-project-more=""
              >
                {t('messages:ai.filter.more', { count: past })}
                <Icon name="cd" size={16} />
              </button>
            ) : null}
          </nav>
        ) : null}
        {more ? (
          <ProjectPicker sheet={phone} anchor={more} ranked={ranked} picked={picked} onToggle={toggle} onClear={() => setOnly([])} onClose={() => setMore(null)} />
        ) : null}

        <div className={k('stack')}>
          {/* 13 Nov 2026: no thread and, once the messages have answered, no message either (./lines.ts noneWords). */}
          {noMatches ? <Card pad><span data-ai-search-empty="">{noneWords}</span></Card> : null}

          {!searching || !ready || needLines.length || failed ? (
            <Sec
              label={<>{owedShown ? t('messages:ai.work.titleCount', { count: owedShown }) : t('messages:ai.work.title')}{freshShown > 0 ? <Pill kind="act" mini>{t('messages:ai.work.fresh', { count: freshShown })}</Pill> : null}</>}
              data-ai-list="work"
              {...needs.props}
            >
              <Card>
                <div className={k('list')}>
                  {failed ? (
                    <div className={k('txt')} role="status" data-ai-failed={failed}>
                      {`${failed === 'unreachable' ? t('messages:ai.work.unreachable') : t('messages:ai.work.failed')} `}
                      <button type="button" className={k('link')} onClick={() => onRetry?.()} data-ai-retry="">{tco('core:common.tryAgain')}</button>
                    </div>
                  ) : null}
                  {needLines.length ? null : ready ? (
                    <p className={k('txt')} data-ai-empty={nothingHere ? 'project' : ''}>
                      {nothingHere && onlyApp ? t('messages:ai.filter.emptyProject', { project: onlyApp.name || onlyApp.slug }) : t('messages:ai.work.empty')}
                    </p>
                  ) : failed ? null : <p className={k('txt')} role="status" data-ai-loading="">{t('messages:ai.work.loading')}</p>}
                  <Groups lines={needs.held} heads={heads} first={first(GROUP_FIRST.needs)} freshStyle freshProjects={freshProjects} dayHeads />
                </div>
              </Card>
            </Sec>
          ) : null}

          {busyLines.length || stillLines.length ? (
            <Sec label={t('messages:ai.busy.title', { count: busyLines.length + stillLines.length })} data-ai-list="busy">
              <Card>
                <div className={k('list')}>
                  <Groups lines={busyLines} heads={heads} first={first(GROUP_FIRST.busy)} dayHeads />
                  {/* #6158: the rows nobody is moving, folded at the list's end. */}
                  {stillLines.length ? (
                    <div data-ai-still-part="">
                      <MoreRow open={stillShown} onClick={() => setStillOpen((o) => !o)} data-ai-still="">
                        {t('messages:ai.up.stillCount', { count: stillLines.length })}
                      </MoreRow>
                      {stillShown ? <Groups lines={stillLines} heads={heads} first={stillLines.length} dayHeads /> : null}
                    </div>
                  ) : null}
                </div>
              </Card>
            </Sec>
          ) : null}

          {liveLines.length ? (
            <Sec label={t('messages:ai.live.title', { count: liveLines.length })} data-ai-list="live">
              <Card>
                <div className={k('list')}>
                  <Groups lines={freshFirst(liveLines)} heads={heads} first={first(GROUP_FIRST.live)} foldFresh />
                  {liveBehind ? (
                    // #6233: one Reload under the list, for every row this tab is older than.
                    <div className={k('txt')} data-ai-older-tab="">
                      {`${t('messages:ai.live.olderTab')} `}
                      <button type="button" className={k('link')} onClick={() => reloadTab()} data-ai-older-tab-reload="">{t('messages:ai.short.reload')}</button>
                    </div>
                  ) : null}
                </div>
              </Card>
            </Sec>
          ) : null}

          {/* #6398: History is searched as far as it has loaded; with no match it folds away. */}
          {history && (!searching || historyLines.length) ? (
            <div ref={historyRef} data-ai-frame-history="">
              <Sec label={t('messages:ai.history.title')} data-ai-list="history">
                <Card>
                  <div className={k('list')}>
                    <div className={k('btnrow')} role="group" aria-label={t('messages:ai.history.kind.label')} data-ai-history-kinds="">
                      {[null, ...HISTORY_KINDS].map((kind) => (
                        <Btn key={kind || 'all'} kind={historyKind === kind ? '' : 'quiet'} small aria-pressed={historyKind === kind} onClick={() => onHistoryKind?.(kind)} data-ai-history-kind={kind || 'all'}>{kindWord(kind)}</Btn>
                      ))}
                    </div>
                    {!history.ready ? <p className={k('txt')} role="status" data-ai-history-loading="">{t('messages:ai.history.loading')}</p> : null}
                    {history.ready && history.failed && !historyLines.length ? (
                      <div className={k('txt')} role="status" data-ai-history-failed="">
                        {`${t('messages:ai.history.failed')} `}
                        <button type="button" className={k('link')} onClick={history.retry}>{tco('core:common.tryAgain')}</button>
                      </div>
                    ) : null}
                    {history.ready && !history.failed && !historyLines.length && !history.next ? (
                      <p className={k('txt')} data-ai-history-empty="">{t('messages:ai.history.empty')}</p>
                    ) : null}
                    {historyMonths.map((month) => (
                      <div key={month.key} data-ai-history-month={month.key}>
                        <div className={k('row sm proj month')}><span className={k('tx')}><h3 className={k('t')}>{monthName(month.at, locale)}</h3></span></div>
                        <Groups lines={month.rows} heads={heads} first={first(GROUP_FIRST.live)} />
                      </div>
                    ))}
                    {history.ready && history.next ? (
                      <MoreRow onClick={history.more} disabled={history.loading} data-ai-history-more="">{t('messages:ai.history.earlier')}</MoreRow>
                    ) : null}
                  </div>
                </Card>
              </Sec>
            </div>
          ) : null}

          {/* 13 Nov 2026: the messages that match, under the threads that do, each a link to it. */}
          {foundLines.length ? (
            <Sec label={t('messages:ai.search.messages', { count: foundLines.length })} data-ai-list="found">
              <Card>
                <div className={k('list')}>
                  {foundLines.map((line) => <FoundRow key={line.key} line={line} />)}
                  {foundMore ? <p className={k('txt')} data-ai-found-more="">{t('messages:ai.search.more')}</p> : null}
                </div>
              </Card>
            </Sec>
          ) : null}
          {foundFailed ? (
            <Card pad>
              <div className={k('txt')} role="status" data-ai-search-failed="">
                {`${t('messages:ai.search.failed')} `}
                <button type="button" className={k('link')} onClick={() => onFoundRetry?.()} data-ai-search-retry="">{tco('core:common.tryAgain')}</button>
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </Frame>
  );
}
