/**
 * A project's page in the one frame, as the 2026-11-06 screen tour draws it
 * (its steps s23 to s37): the project's places are the page's tabs, the
 * same control every page with more than one view uses, and the Hub is
 * groups of the standard row. For you, Recently live and Topics sit in the
 * content column; who is here, how a change goes live and the app in the
 * context column.
 *
 * Presentational. The page (../workshop.tsx) hands in what its own Hub
 * reads, already as words, with the presses its own cards make. Nothing is
 * fetched, counted or opened here.
 */
import { useEffect, useState, type ReactNode } from 'react';

import { Avs, Btn, Card, CardNote, Facts, Frame, GroupLink, Head, HeadRow, Lead, Meta, Mut, PageBody, Pill, Row, Search, Sec, ShotCard, Shots, ShowAll, Tabs, Tile, k } from '@/components/ui/kit';
import { RichMessage, useMessages } from '../../../../lib/i18n/react';
import { BOT_AVATAR } from '../../../messages/format';

export interface ProjectTab { key: string; label: string; count?: number }

interface HeadProps {
  tabs: ProjectTab[];
  tab: string;
  /** What the page is when it is not the lit tab's own: a topic's channel lights Topics but is drawn by the product below the head. */
  page?: string;
  onTab: (key: string) => void;
  onInvite?: (() => void) | null;
  /** Join, for someone signed in who is not a member yet: the page's primary button until they are. */
  onJoin?: (() => void) | null;
}

/**
 * Says on <html> that a project's page is drawn in the kit, while one is
 * mounted, so app.css can give the page's hosts the frame's page area
 * without looking inside them. Counted: one kit page hands over to the next
 * (the Hub to a place's head) inside one commit.
 */
let framePagesUp = 0;
function useProjectFrameFlag(): void {
  useEffect(() => {
    framePagesUp += 1;
    document.documentElement.setAttribute('data-project-frame', '');
    return () => {
      framePagesUp -= 1;
      if (framePagesUp <= 0) { framePagesUp = 0; document.documentElement.removeAttribute('data-project-frame'); }
    };
  }, []);
}

const PlaceTabs = ({ tabs, tab, onTab }: Pick<HeadProps, 'tabs' | 'tab' | 'onTab'>) => (
  <Tabs tabs={tabs} current={tab} onPick={(key) => onTab(key)} />
);

/**
 * The head of a place whose body is the product's own (Needs you's review
 * stage, a channel, a week's page): its title, its sentence, the project's
 * places. No buttons: of a project's pages only the Hub's head has any.
 */
export function ProjectFrameHead({ title, purpose, ...head }: HeadProps & { title: string; purpose?: string | null }) {
  useProjectFrameFlag();
  return (
    <Frame data-project-frame={head.page || head.tab}>
      <div className={k('inner')}>
        <Head title={title} purpose={purpose || undefined} />
        <PlaceTabs {...head} />
      </div>
    </Frame>
  );
}

/** A person as a face: the name's first letter on the colour the product gives it. */
export interface HubFace { name: string; color?: string | null }

export interface ProjectHubProps extends HeadProps {
  name: string;
  purpose?: string | null;
  /** The project's tile, before its name (the hero's own). */
  tile: { src: string | null; emoji: string | null };
  /** Open app, the hero's first action; null on Homeroom's own page, which has no app. */
  onOpenApp: (() => void) | null;
  /** Needs you while a vote is owed: how many you have not seen, and the row's line (the first one's title, or how many you skipped). */
  needs: { count: number; line: string | null; join: boolean } | null;
  /** With no vote owed, the quiet line in the row's place: the requests nobody has picked up, if any; null says nothing. */
  quiet: { claims: number; alone: boolean } | null;
  onNeeds: () => void;
  /** The Workshop's row, for anyone signed in; null for a visitor. */
  onWorkshop: (() => void) | null;
  /** #general: the last thing said in it (`said`, by `by`, `ago`), or `last` false for a channel nobody has posted in. */
  general: { handle: string; last: boolean; said: string; by: string | null; ago: string; unread: number } | null;
  onGeneral: () => void;
  /** Each live topic's channel, listed on a phone only (a wide window has the Topics tab). */
  topics: Array<{ key: string; name: string; handle: string; icon: string; about: string; unread: number }>;
  onTopic: (key: string) => void;
  /** The last changes that went live, each a picture and a link to its own page. */
  live: Array<{ key: string; title: string; line: string | null; src: string | null; href: string }>;
  /** Before anything went live: the app itself, "Live since today". */
  ownLive: { name: string; line: string; onOpen: () => void } | null;
  onAllLive: () => void;
  people: { title: string; line: string | null; faces: HubFace[]; more: number } | null;
  audience: { kind: 'solo' | 'invited' | 'open'; title: string; line: string | null };
}

/**
 * The Hub (version 2 of the tour's s23, s24 and s36): today's Hub in the
 * kit's two columns. The head is the hero's (tile, name, description, Open
 * app, Invite, Join; the hero's own ⋯ stands at its end, app.css). For you
 * is the hero's three doors, Recently live its three pictures, and who is
 * around and who it is for sit in the side column. On a phone the topics
 * are listed too, as today's Hub lists them there.
 */
export function ProjectHubFrame(p: ProjectHubProps) {
  const t = useMessages('project');
  useProjectFrameFlag();
  const [allTopics, setAllTopics] = useState(false);
  const news = (count: number) => t('project:hub.channel.unread', { count, shown: count > 99 ? '99+' : String(count) });
  const tile = <Tile size={56} src={p.tile.src} emoji={p.tile.emoji} name={p.name} />;
  const acts = p.onOpenApp || p.onInvite || p.onJoin ? (
    <>
      {p.onOpenApp ? <Btn kind={p.onJoin ? 'line' : ''} icon="play" onClick={p.onOpenApp}>{t('project:communityCard.openApp')}</Btn> : null}
      {p.onInvite ? <Btn kind="line" icon="users" onClick={p.onInvite}>{t('project:communityCard.invite.button')}</Btn> : null}
      {p.onJoin ? <Btn icon="plus" onClick={p.onJoin}>{t('project:communityCard.join.button')}</Btn> : null}
    </>
  ) : undefined;
  // The message is cut short, never the time (the Hub's own row, audit P04).
  const cut = [<span className={k('cut')} />, <span className={k('aft')} />];
  const g = p.general;
  const generalLine = !g ? null : !g.last ? t('project:hub.channel.empty')
    : g.said && g.by ? <RichMessage id="project:hub.forYou.discussion.lastBy" values={{ username: g.by, message: g.said, ago: g.ago }} components={cut} />
      : g.said ? <RichMessage id="project:hub.forYou.discussion.last" values={{ message: g.said, ago: g.ago }} components={cut} />
        : g.by ? t('project:hub.forYou.discussion.postedBy', { username: g.by, ago: g.ago })
          : t('project:hub.forYou.discussion.posted', { ago: g.ago });
  const shownTopics = allTopics ? p.topics : p.topics.slice(0, HUB_TOPICS_FIRST);
  const moreTopics = p.topics.length - shownTopics.length;
  const side = (
    <Sec label={t('project:frame.hub.people')}>
      <Card>
        {p.people ? (
          <Row
            lead={p.people.faces.length ? <Avs people={p.people.faces} max={p.people.faces.length} more={p.people.more} /> : <Lead icon="users" />}
            title={p.people.title}
            line={p.people.line || undefined}
          />
        ) : null}
        <Row lead={<Lead icon={p.audience.kind === 'open' ? 'globe' : p.audience.kind === 'solo' ? 'user' : 'lock'} />} title={p.audience.title} line={p.audience.line || undefined} />
      </Card>
    </Sec>
  );
  return (
    <PageBody
      data-project-frame="status"
      title={p.name}
      purpose={p.purpose || undefined}
      lead={tile}
      acts={acts}
      tabs={<PlaceTabs tabs={p.tabs} tab={p.tab} onTab={p.onTab} />}
      side={side}
      sideFirst
    >
      {p.needs || p.quiet || p.onWorkshop || p.general ? (
        <Sec label={t('project:hub.forYou.title')}>
          <Card>
            {p.needs ? (
              <Row
                lead={<Lead icon="vote" tone={p.needs.count ? 'acc' : undefined} />}
                title={t('project:hub.needs.title')}
                line={p.needs.line || undefined}
                right={p.needs.count ? <Pill kind="act">{t('project:hub.needs.toVote', { count: p.needs.count })}</Pill> : undefined}
                go
                sm={false}
                onClick={p.onNeeds}
              />
            ) : p.quiet ? (
              <CardNote>
                {!p.quiet.claims ? t('project:hub.needs.none') : (
                  <RichMessage
                    id={p.quiet.alone ? 'project:hub.needs.requestsAlone' : 'project:hub.needs.noneButRequests'}
                    values={{ count: p.quiet.claims }}
                    components={[<button type="button" className={k('link')} onClick={p.onWorkshop || p.onNeeds} />]}
                  />
                )}
              </CardNote>
            ) : null}
            {p.needs && p.needs.join ? <CardNote>{t('project:hub.needs.joinToVote')}</CardNote> : null}
            {p.onWorkshop ? (
              <Row lead={<Lead icon="tool" />} title={t('project:places.list.workshop')} line={t('project:hub.workshop.sub')} go onClick={p.onWorkshop} />
            ) : null}
            {p.general ? (
              <Row
                lead={<Lead icon="hash" />}
                title={<RichMessage id="project:hub.forYou.discussion.title" values={{ handle: p.general.handle }} components={[<Mut />]} />}
                line={generalLine}
                right={p.general.unread > 0 ? <Pill kind="act">{news(p.general.unread)}</Pill> : undefined}
                go
                onClick={p.onGeneral}
              />
            ) : null}
          </Card>
        </Sec>
      ) : null}
      {p.topics.length ? (
        <Sec label={t('project:hub.topics.title')} className={k('sec', 'p')}>
          <Card>
            {shownTopics.map((topic) => (
              <Row
                key={topic.key}
                lead={topic.icon ? <Lead>{topic.icon}</Lead> : <Lead icon="hash" />}
                title={<>{topic.name} <Mut>#{topic.handle}</Mut></>}
                line={topic.about || undefined}
                right={topic.unread > 0 ? <Pill kind="act">{news(topic.unread)}</Pill> : undefined}
                go
                onClick={() => p.onTopic(topic.key)}
              />
            ))}
            {moreTopics > 0 ? <ShowAll onClick={() => setAllTopics(true)}>{t('project:places.list.showMore', { count: moreTopics })}</ShowAll> : null}
          </Card>
        </Sec>
      ) : null}
      {p.live.length || p.ownLive ? (
        <Sec label={t('project:hub.recent.title')} action={p.live.length ? <GroupLink onClick={p.onAllLive}>{t('project:hub.recent.all')}</GroupLink> : undefined}>
          <Card>
            <Shots cols={3} cards>
              {!p.live.length && p.ownLive ? (
                <ShotCard onClick={p.ownLive.onOpen} fallback={<Tile size={56} src={p.tile.src} emoji={p.tile.emoji} name={p.ownLive.name} />} title={p.ownLive.name} line={p.ownLive.line} />
              ) : null}
              {p.live.map((row) => (
                <ShotCard
                  key={row.key}
                  href={row.href}
                  src={row.src}
                  fallback={<Tile size={56} src={p.tile.src} emoji={p.tile.emoji} name={p.name} />}
                  title={row.title}
                  line={row.line}
                />
              ))}
            </Shots>
          </Card>
        </Sec>
      ) : null}
    </PageBody>
  );
}

/** How many topics the phone's Hub lists before "Show N more" (the standard Hub's own number). */
const HUB_TOPICS_FIRST = 6;

/**
 * Topics (version 2 of the tour's s25): the project's places list, the part
 * of it the tabs do not already say. The topics in the work column and the
 * channels beside them, each by its name alone, as the list names it, with
 * how much is new in it. A row opens its channel.
 */
export function ProjectTopicsFrame({ general, topics, onOpen, ...head }: HeadProps & {
  general: { key: string; label: string; count: number } | null;
  topics: Array<{ key: string; label: string; count: number }>;
  onOpen: (key: string) => void;
}) {
  useProjectFrameFlag();
  const t = useMessages('project');
  const news = (count: number) => (count > 0 ? <Pill kind="act">{t('project:places.count.unread', { count, shown: count > 99 ? '99+' : String(count) })}</Pill> : undefined);
  return (
    <PageBody
      data-project-frame="topics"
      title={t('project:places.list.topics')}
      purpose={t('project:frame.topics.purpose')}
      tabs={<PlaceTabs tabs={head.tabs} tab={head.tab} onTab={head.onTab} />}
      sideFirst
      side={general ? (
        <Sec label={t('project:places.list.channels')}>
          <Card>
            <Row lead={<Lead icon="hash" />} title={general.label} right={news(general.count)} go onClick={() => onOpen(general.key)} />
          </Card>
        </Sec>
      ) : undefined}
    >
      {topics.length ? (
        <Sec label={t('project:places.list.topics')}>
          <Card>
            {topics.map((topic) => (
              <Row key={topic.key} lead={<Lead icon="hash" />} title={topic.label} right={news(topic.count)} go onClick={() => onOpen(topic.key)} />
            ))}
          </Card>
        </Sec>
      ) : null}
    </PageBody>
  );
}

/** A figure of the Overview: its number, what it counts, the line under it and where its press goes. */
export interface WorkshopFact { value: number | string; label: string; tone?: 'acc' | 'ok' | 'wait'; sub?: string | null; onClick?: (() => void) | null }

/** One row of this week in What happened. */
export interface HappenedItem {
  key: string;
  title: string;
  href: string | null;
  /** What it is, as a kit glyph: a request, a change, live work, a vote. */
  glyph: string;
  /** It moved since your last visit. */
  fresh: boolean;
  you: boolean;
  going: boolean;
  /** A merge that is stuck, in the pill's own words. */
  stuck: string | null;
  ago: string | null;
  /** Its page is open beside the list. */
  on: boolean;
  onOpen?: (event: React.MouseEvent<HTMLAnchorElement>) => void;
  /** A new request nobody has picked up: Build it. */
  act?: { label: string; title?: string; onPress: (button: HTMLElement) => void } | null;
}

/** A week of What happened: its name, its dates, how many are new in it and what went live. */
export interface HappenedWeek { key: string; name: string; range: string | null; fresh: number; live: { count: number; partial: boolean } | null; onOpen: (() => void) | null }

/** "496 live", or "496+ live" when the figure is a floor. */
function WeekLive({ live }: { live: HappenedWeek['live'] }) {
  useMessages('project');
  if (!live) return null;
  return (
    <span className={k('meta', 'ok')}>
      <RichMessage id={live.partial ? 'project:weeks.row.liveAtLeast' : 'project:weeks.row.live'} values={{ count: live.count }} components={[<span />]} />
    </span>
  );
}

/**
 * The Workshop (version 2 of the tour's s27, s28 and s37): today's Workshop
 * in the kit's two columns. Overview is All items with its four figures
 * (each opens what it counts) and the Your work card; What happened is this
 * week row by row, then the weeks before it; Homeroom bot's slots and the
 * approval rule, the Overview card's last two lines, stand beside them.
 */
export function ProjectWorkshopFrame({
  purpose, overview, first, work, happened, slots, rule, below, ...head
}: HeadProps & {
  purpose: string;
  /** All items: its door (with the dot when a search or filter narrows it) and its figures; null before the board is read. */
  overview: { onAll: () => void; filtered: boolean; facts: WorkshopFact[] } | null;
  /** For somebody who has made nothing here yet, the product's own card in Your work's place. */
  first?: ReactNode;
  work: { line: string | null; words: { id: string; values?: Record<string, string | number> } | null; href: string; hint: string } | null;
  happened: {
    /** Mark all seen, where there is a last visit to measure from; `clearOff` when nothing is new. */
    onClear: (() => void) | null;
    clearOff: boolean;
    /** "Nothing new since you were last here." */
    none: boolean;
    thisWeek: (HappenedWeek & { items: HappenedItem[]; onAll: (() => void) | null }) | null;
    weeks: HappenedWeek[];
    onEarlier: (() => void) | null;
    /** In Earlier weeks' place once every week is out: when the project started. */
    started: string | null;
  } | null;
  slots: { title: string; line: string | null; onOpen: () => void } | null;
  rule: { id: string; values: Record<string, string | number>; wait: string | null; onRules: (() => void) | null } | null;
  /** Under What happened, the product's own (an admin's private requests). */
  below?: ReactNode;
}) {
  useProjectFrameFlag();
  const t = useMessages('project');
  const week = happened?.thisWeek || null;
  const weekTitle = (w: HappenedWeek) => (w.range ? <>{w.name} <Mut>{w.range}</Mut></> : w.name);
  const weekEnd = (w: HappenedWeek) => (
    <>
      {w.fresh ? <Pill kind="act">{t('project:weeks.row.fresh', { count: w.fresh })}</Pill> : null}
      <WeekLive live={w.live} />
    </>
  );
  return (
    <PageBody
      data-project-frame="workshop-kit"
      title={t('project:places.list.workshop')}
      purpose={purpose}
      tabs={<PlaceTabs tabs={head.tabs} tab={head.tab} onTab={head.onTab} />}
      sideFirst
      side={slots || rule ? (
        <>
          {slots ? (
            <Sec label={t('project:frame.workshop.bot')}>
              <Card><Row lead={<Tile size={40} src={BOT_AVATAR} />} title={slots.title} line={slots.line || undefined} go onClick={slots.onOpen} sm={false} /></Card>
            </Sec>
          ) : null}
          {rule ? (
            <Sec
              label={t('project:frame.workshop.rule')}
              action={rule.onRules ? <GroupLink onClick={rule.onRules}>{t('project:communityCard.rule.rules')}</GroupLink> : undefined}
            >
              <Card>
                <Row
                  lead={<Lead icon="shield" />}
                  title={<RichMessage id={rule.id} values={rule.values} components={[<span />, <b />]} />}
                  line={rule.wait || undefined}
                  sm={false}
                  wrap="all"
                />
              </Card>
            </Sec>
          ) : null}
        </>
      ) : undefined}
    >
      <Sec label={t('project:workshop.part.overview')}>
        {overview ? (
          <Card>
            <HeadRow
              title={t('project:workshop.allItems.title')}
              link={overview.filtered
                ? <RichMessage id="project:workshop.allItems.seeAllFiltered" components={[<span className={k('fdot')} aria-hidden="true" />, <span className={k('sro')} />]} />
                : t('project:workshop.allItems.seeAll')}
              onClick={overview.onAll}
            />
            <Facts bare items={overview.facts.map((f) => ({ value: f.value, label: f.label, tone: f.tone, sub: f.sub || undefined, onClick: f.onClick || undefined }))} />
          </Card>
        ) : null}
        {first}
        {!first && work ? (
          <Card>
            <Row
              href={work.href}
              label={work.hint}
              lead={<Tile size={40} src={BOT_AVATAR} />}
              title={t('project:workshop.desk.title')}
              line={work.line || undefined}
              right={work.words ? <span className={k('meta', 'd')}><RichMessage id={work.words.id} values={work.words.values} components={[<b className={k('acc')} />]} /></span> : undefined}
              go
              sm={false}
            />
          </Card>
        ) : null}
      </Sec>
      {happened ? (
        <Sec
          label={t('project:workshop.part.happened')}
          action={happened.onClear ? <GroupLink onClick={happened.onClear} disabled={happened.clearOff}>{t('project:since.markAllSeen')}</GroupLink> : undefined}
        >
          <Card>
            {happened.none ? <CardNote>{t('project:since.none')}</CardNote> : null}
            {week ? <Row kind="week" sm title={weekTitle(week)} right={weekEnd(week)} /> : null}
            {week ? week.items.map((item) => {
              const end = (
                <>
                  {item.you ? <Pill>{t('project:happened.row.you')}</Pill> : null}
                  {item.going ? <Pill kind="ok">{t('project:happened.row.goingLive')}</Pill> : null}
                  {item.stuck ? <Pill kind="bad">{item.stuck}</Pill> : null}
                  <Meta>{item.ago}</Meta>
                  {item.act ? <Btn small kind="line" title={item.act.title} onClick={(event) => item.act!.onPress(event.currentTarget)}>{item.act.label}</Btn> : null}
                </>
              );
              // A row with its own button is not itself a link (a button inside a link is neither): its title is.
              const title = item.fresh ? <><span className={k('sro')}>{t('project:happened.row.new')} </span>{item.title}</> : item.title;
              return item.act && item.href ? (
                <Row key={item.key} kind="item" sm glyph={item.glyph} glyphTone={item.fresh ? 'acc' : undefined} on={item.on}
                  title={<a className={k('tlink')} href={item.href} onClick={item.onOpen}>{title}</a>} right={end} />
              ) : (
                <Row key={item.key} kind="item" sm glyph={item.glyph} glyphTone={item.fresh ? 'acc' : undefined} on={item.on}
                  href={item.href || undefined} onClick={item.href && item.onOpen ? (event) => item.onOpen!(event as React.MouseEvent<HTMLAnchorElement>) : undefined}
                  title={title} right={end} />
              );
            }) : null}
            {week && week.onAll ? <ShowAll go onClick={week.onAll}>{t('project:happened.allOfWeek')}</ShowAll> : null}
            {happened.weeks.map((w) => (
              <Row key={w.key} kind="week" sm title={weekTitle(w)} right={weekEnd(w)} go={!!w.onOpen} onClick={w.onOpen || undefined} />
            ))}
            {happened.onEarlier ? <ShowAll onClick={happened.onEarlier}>{t('project:happened.earlierWeeks')}</ShowAll>
              : happened.started ? <CardNote>{happened.started}</CardNote> : null}
          </Card>
        </Sec>
      ) : null}
      {below}
    </PageBody>
  );
}

/** The board's own filters, as the kit's side column shows them (../../kanban-filters.tsx draws the same state as chips). */
export interface AllItemsFilters {
  /** How many filters the dialog holds. */
  count: number;
  /** Each active filter, with the key its × clears. */
  chips: Array<{ key: string; label: string }>;
  /** Assigned to you and Yours, or null signed out (there is no "you"). */
  quick: { assignedToMe: boolean; yours: boolean } | null;
  onOpen: () => void;
  onDismiss: (key: string) => void;
  onQuick: (key: 'assignedToMe' | 'yours') => void;
}

/**
 * All items (version 2 of the tour's s29 and s30): the kit's head, tabs and
 * side column around today's page. The tabs are its two groupings, with the
 * board's own search at their end; Show (Filters and the two quick filters)
 * and Order categories stand beside the list. The list itself (a card per
 * category, or the board by stage) is the product's own, in the content
 * column under this, wearing the look (app.css): it opens to its lanes,
 * holds its order across a re-sort and feeds the panel beside it, which a
 * second drawing would not.
 */
export function ProjectAllItemsFrame({
  project, group, onGroup, query, querySeq, onQuery, filters, sort, ...head
}: HeadProps & {
  project: string;
  group: 'category' | 'stage';
  onGroup: (key: 'category' | 'stage') => void;
  /** The board's search text, and the count that says it was cleared from outside (its chip's ×). */
  query: string;
  querySeq: number;
  onQuery: (next: string) => void;
  /** Null where the board has no filters to show. */
  filters: AllItemsFilters | null;
  /** The order of the categories; null by stage, and where there are none to order. */
  sort: { key: string; options: Array<{ key: string; label: string }>; onSort: (key: string) => void } | null;
}) {
  useProjectFrameFlag();
  const t = useMessages('project');
  const [text, setText] = useState(query);
  // Cleared from outside (the Search chip's ×): the field follows.
  useEffect(() => { setText(query); }, [querySeq]); // eslint-disable-line react-hooks/exhaustive-deps
  const type = (next: string) => { setText(next); onQuery(next); };
  const placeholder = t('project:filters.search.placeholder');
  const label = t('project:filters.search.label');
  // Beside the categories only: by stage the board has the page's width, and keeps its own filter chips over it.
  const side = group === 'category' && (filters || sort) ? (
    <>
      {filters ? (
        <Sec label={t('project:frame.allItems.show')}>
          <Card>
            <Row
              lead={<Lead icon="filter" tone={filters.count > 0 ? 'acc' : undefined} />}
              title={t('project:filters.button.none')}
              label={filters.count > 0 ? t('project:filters.button.active', { count: filters.count }) : undefined}
              right={filters.count > 0 ? <Pill kind="act">{filters.count}</Pill> : undefined}
              go
              sm
              onClick={filters.onOpen}
            />
            {filters.chips.length ? (
              <div className={k('btnrow', 'chips', 'inrow')}>
                {filters.chips.map((chip) => (
                  <Btn key={chip.key} small kind="quiet" className="chip" aria-label={t('project:filters.chip.remove', { filter: chip.label })} onClick={() => filters.onDismiss(chip.key)}>
                    {chip.label}<span aria-hidden="true">×</span>
                  </Btn>
                ))}
              </div>
            ) : null}
            {filters.quick ? (
              <>
                <Row lead={<Lead icon={filters.quick.assignedToMe ? 'check' : 'user'} />} title={t('project:filters.quick.assignedToYou')} on={filters.quick.assignedToMe} pressed={filters.quick.assignedToMe} sm onClick={() => filters.onQuick('assignedToMe')} />
                <Row lead={<Lead icon={filters.quick.yours ? 'check' : 'user'} />} title={t('project:filters.quick.yours')} on={filters.quick.yours} pressed={filters.quick.yours} sm onClick={() => filters.onQuick('yours')} />
              </>
            ) : null}
          </Card>
        </Sec>
      ) : null}
      {sort ? (
        <Sec label={t('project:allItems.sort.label')}>
          <Card>
            {sort.options.map((option) => (
              <Row key={option.key} lead={<Lead icon={sort.key === option.key ? 'check' : ''} />} title={option.label} on={sort.key === option.key} pressed={sort.key === option.key} sm onClick={() => sort.onSort(option.key)} />
            ))}
          </Card>
        </Sec>
      ) : null}
    </>
  ) : undefined;
  return (
    <Frame data-project-frame="all-items" data-all-group={group}>
      <div className={k('inner')}>
        <Head title={t('project:workshop.allItems.title')} purpose={t('project:frame.allItems.purpose', { project })} />
        <Tabs
          tabs={[{ key: 'category', label: t('project:allItems.group.category') }, { key: 'stage', label: t('project:allItems.group.stage') }]}
          current={group}
          onPick={(key) => onGroup(key === 'stage' ? 'stage' : 'category')}
          label={t('project:allItems.group.label')}
          end={<Search flush value={text} onChange={type} placeholder={placeholder} label={label} />}
        />
        <Search only="p" value={text} onChange={type} placeholder={placeholder} label={label} />
        {/* The work column is the product's own list, laid in under this (app.css): the kit draws the column beside it. */}
        {side ? <div className={k('cols', 'beside')}><div className={k('stack', 'first')}>{side}</div></div> : null}
      </div>
    </Frame>
  );
}
