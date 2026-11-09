/**
 * A project's page in the one frame, as the 2026-11-06 screen tour draws it
 * (its steps s23 to s37): the project's places are the page's tabs, the
 * same control every page with more than one view uses, and the Hub is
 * groups of the standard row. For you, Recently live and Topics sit in the
 * content column; who is here, how a change goes live and the app in the
 * context column. One primary button: Ask for a change.
 *
 * Presentational. The page (../workshop.tsx) hands in what its own Hub
 * reads, already as words, with the presses its own cards make. Nothing is
 * fetched, counted or opened here.
 */
import { useEffect, type ReactNode } from 'react';

import { Ballot, Btn, Card, Facts, Frame, GroupLink, Head, Lead, Meta, PageBody, Pill, type PillKind, Row, Search, Sec, Tabs, Tile, Track, k } from '@/components/ui/kit';
import { useMessages } from '../../../../lib/i18n/react';

export interface ProjectTab { key: string; label: string; count?: number }

interface HeadProps {
  tabs: ProjectTab[];
  tab: string;
  onTab: (key: string) => void;
  /** Ask for a change; null for someone who may not ask (a visitor). */
  onAsk?: (() => void) | null;
  onInvite?: (() => void) | null;
  /** Join, for someone signed in who is not a member yet: the page's primary button until they are. */
  onJoin?: (() => void) | null;
  /** The place's own second button, in Invite's place (the Workshop's All items). */
  second?: { label: string; icon: string; onClick: () => void } | null;
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

/** The page's actions, or nothing at all for someone who has none (a visitor): no empty box. */
function useActs({ onAsk, onInvite, onJoin, second }: Pick<HeadProps, 'onAsk' | 'onInvite' | 'onJoin' | 'second'>): ReactNode {
  const t = useMessages('project');
  if (!onAsk && !onInvite && !onJoin && !second) return undefined;
  return (
    <>
      {second
        ? <Btn kind="line" icon={second.icon} onClick={second.onClick}>{second.label}</Btn>
        : onInvite ? <Btn kind="line" icon="users" onClick={onInvite}>{t('project:frame.invite')}</Btn> : null}
      {onJoin
        ? <Btn icon="plus" onClick={onJoin}>{t('project:communityCard.join.button')}</Btn>
        : onAsk ? <Btn icon="plus" onClick={onAsk}>{t('project:frame.ask')}</Btn> : null}
    </>
  );
}

const PlaceTabs = ({ tabs, tab, onTab }: Pick<HeadProps, 'tabs' | 'tab' | 'onTab'>) => (
  <Tabs tabs={tabs} current={tab} onPick={(key) => onTab(key)} />
);

/**
 * The head of a place that is not yet drawn in the kit: its title, its
 * sentence, the project's places. The place's own body follows it.
 */
export function ProjectFrameHead({ title, purpose, ...head }: HeadProps & { title: string; purpose?: string | null }) {
  useProjectFrameFlag();
  const acts = useActs(head);
  return (
    <Frame data-project-frame={head.tab}>
      <div className={k('inner')}>
        <Head title={title} purpose={purpose || undefined} acts={acts} />
        <PlaceTabs {...head} />
      </div>
    </Frame>
  );
}

export interface ProjectHubProps extends HeadProps {
  name: string;
  purpose?: string | null;
  /** The votes owed here: how many, and the first one's title. */
  needs: { count: number; title: string } | null;
  /** Said under Needs you when no vote is owed; null leaves the row out. */
  quiet: string | null;
  onNeeds: () => void;
  /** Your work with Homeroom bot in this project; null draws the Workshop's own row. */
  work: { line: string | null; words: string | null; href: string } | null;
  onWorkshop: () => void;
  general: { handle: string; line: string | null; ago: string | null; unread: number } | null;
  onGeneral: () => void;
  /** The last changes that went live, each a link to its own page. */
  live: Array<{ key: string; title: string; who: string | null; ago: string | null; href: string }>;
  onAllLive: () => void;
  topics: Array<{ key: string; name: string; about: string; unread: number }>;
  topicsTotal: number;
  onTopic: (key: string) => void;
  onAllTopics: () => void;
  people: { title: string; line: string | null } | null;
  audience: { kind: 'solo' | 'invited' | 'open'; title: string; line: string | null };
  rule: { title: string; line: string | null; onOpen: (() => void) | null } | null;
  app: { name: string; src: string | null; emoji: string | null; color: string | null; line: string | null; onOpen: () => void } | null;
}

export function ProjectHubFrame(p: ProjectHubProps) {
  const t = useMessages('project');
  useProjectFrameFlag();
  const acts = useActs(p);
  const news = (count: number) => t('project:hub.channel.unread', { count, shown: count > 99 ? '99+' : String(count) });
  const side = (
    <>
      <Sec label={t('project:frame.hub.people')}>
        <Card>
          {p.people ? <Row lead={<Lead icon="users" />} title={p.people.title} line={p.people.line || undefined} /> : null}
          <Row lead={<Lead icon={p.audience.kind === 'open' ? 'globe' : p.audience.kind === 'solo' ? 'user' : 'lock'} />} title={p.audience.title} line={p.audience.line || undefined} />
        </Card>
      </Sec>
      {p.rule ? (
        <Sec label={t('project:frame.hub.rule')}>
          <Card>
            <Row lead={<Lead icon="shield" />} title={p.rule.title} line={p.rule.line || undefined} go={!!p.rule.onOpen} onClick={p.rule.onOpen || undefined} sm={false} wrap />
          </Card>
        </Sec>
      ) : null}
      {p.app ? (
        <Sec label={t('project:frame.hub.app')}>
          <Card>
            <Row
              lead={<Tile size={40} src={p.app.src} emoji={p.app.emoji} color={p.app.color} name={p.app.name} />}
              title={t('project:frame.hub.openApp', { app: p.app.name })}
              line={p.app.line || undefined}
              right={<Btn kind="quiet" small onClick={p.app.onOpen}>{t('project:frame.hub.open')}</Btn>}
            />
          </Card>
        </Sec>
      ) : null}
    </>
  );
  return (
    <PageBody
      data-project-frame="status"
      title={p.name}
      purpose={p.purpose || undefined}
      acts={acts}
      tabs={<PlaceTabs tabs={p.tabs} tab={p.tab} onTab={p.onTab} />}
      side={side}
    >
      <Sec label={t('project:hub.forYou.title')}>
        <Card>
          {p.needs ? (
            <Row
              lead={<Lead icon="vote" tone="acc" />}
              title={t('project:hub.needs.title')}
              line={p.needs.title}
              right={<Pill kind="act">{t('project:hub.needs.toVote', { count: p.needs.count })}</Pill>}
              go
              onClick={p.onNeeds}
            />
          ) : p.quiet ? (
            <Row lead={<Lead icon="vote" />} title={t('project:hub.needs.title')} line={p.quiet} go onClick={p.onNeeds} />
          ) : null}
          {p.work ? (
            <Row
              href={p.work.href}
              lead={<Lead icon="tool" />}
              title={t('project:workshop.desk.title')}
              line={p.work.line || undefined}
              right={<Meta>{p.work.words}</Meta>}
              go
              sm={false}
            />
          ) : (
            <Row lead={<Lead icon="tool" />} title={t('project:places.list.workshop')} line={t('project:hub.workshop.sub')} go onClick={p.onWorkshop} />
          )}
          {p.general ? (
            <Row
              lead={<Lead icon="hash" />}
              title={t('project:frame.hub.channel', { handle: p.general.handle })}
              line={p.general.line || t('project:hub.channel.empty')}
              right={p.general.unread > 0 ? <Pill kind="act">{news(p.general.unread)}</Pill> : <Meta>{p.general.ago}</Meta>}
              go
              onClick={p.onGeneral}
            />
          ) : null}
        </Card>
      </Sec>
      {p.live.length ? (
        <Sec label={t('project:hub.recent.title')} action={<GroupLink onClick={p.onAllLive}>{t('project:hub.recent.all')}</GroupLink>}>
          <Card>
            {p.live.map((row) => (
              <Row
                key={row.key}
                lead={<Lead icon="rocket" tone="ok" />}
                title={row.title}
                line={row.who ? t('project:frame.hub.builtBy', { username: row.who }) : undefined}
                right={<Meta>{row.ago}</Meta>}
                go
                href={row.href}
              />
            ))}
          </Card>
        </Sec>
      ) : null}
      {p.topics.length ? (
        <Sec
          label={t('project:hub.topics.title')}
          action={p.topicsTotal > p.topics.length ? <GroupLink onClick={p.onAllTopics}>{t('project:frame.hub.allTopics', { count: p.topicsTotal })}</GroupLink> : undefined}
        >
          <Card>
            {p.topics.map((topic) => (
              <Row
                key={topic.key}
                lead={<Lead icon="hash" />}
                title={topic.name}
                line={topic.about || undefined}
                right={topic.unread > 0 ? <Pill kind="act">{news(topic.unread)}</Pill> : undefined}
                go
                onClick={() => p.onTopic(topic.key)}
              />
            ))}
          </Card>
        </Sec>
      ) : null}
    </PageBody>
  );
}

/**
 * Topics (the tour's s25): each topic is a channel and a category of work.
 * #general first, then the topics, each a row that opens its channel; a new
 * topic is the page's one primary button and goes to a vote.
 */
export function ProjectTopicsFrame({ general, topics, onOpen, onPropose, ...head }: HeadProps & {
  general: { handle: string; unread: number } | null;
  topics: Array<{ key: string; name: string; about: string; requests: number | null; unread: number }>;
  onOpen: (key: string) => void;
  /** Propose a topic; null for someone who may not. */
  onPropose: (() => void) | null;
}) {
  useProjectFrameFlag();
  const t = useMessages('project');
  const news = (count: number) => t('project:hub.channel.unread', { count, shown: count > 99 ? '99+' : String(count) });
  const line = (topic: { about: string; requests: number | null }) => {
    const open = topic.requests && topic.requests > 0 ? t('project:frame.topics.requests', { count: topic.requests }) : '';
    return open && topic.about ? t('project:frame.topics.requestsAbout', { requests: open, about: topic.about }) : open || topic.about || undefined;
  };
  return (
    <PageBody
      data-project-frame="topics"
      title={t('project:places.list.topics')}
      purpose={t('project:frame.topics.purpose')}
      acts={onPropose ? <Btn icon="plus" onClick={onPropose}>{t('project:frame.topics.propose')}</Btn> : undefined}
      tabs={<PlaceTabs tabs={head.tabs} tab={head.tab} onTab={head.onTab} />}
      side={(
        <Sec label={t('project:frame.topics.about')}>
          <Card>
            <Row lead={<Lead icon="shield" />} title={t('project:frame.topics.byVote')} line={t('project:frame.topics.byVoteLine')} />
          </Card>
        </Sec>
      )}
    >
      {general ? (
        <Sec label={t('project:places.list.channels')}>
          <Card>
            <Row
              lead={<Lead icon="hash" />}
              title={t('project:frame.hub.channel', { handle: general.handle })}
              right={general.unread > 0 ? <Pill kind="act">{news(general.unread)}</Pill> : undefined}
              go
              onClick={() => onOpen('discussion')}
            />
          </Card>
        </Sec>
      ) : null}
      {topics.length ? (
        <Sec label={t('project:places.list.topics')}>
          <Card>
            {topics.map((topic) => (
              <Row
                key={topic.key}
                lead={<Lead icon="hash" />}
                title={topic.name}
                line={line(topic)}
                right={topic.unread > 0 ? <Pill kind="act">{news(topic.unread)}</Pill> : undefined}
                go
                onClick={() => onOpen(topic.key)}
              />
            ))}
          </Card>
        </Sec>
      ) : null}
    </PageBody>
  );
}

type RuleRow = { title: string; line: string | null; onOpen: (() => void) | null };

/**
 * The Workshop (the tour's s27): where things are, the vote that waits for
 * you, your work, what went live and the weeks before; beside them
 * Homeroom bot's slots, who decides and the requests nobody is on.
 *
 * The ballot's one button opens Needs you, where a vote is cast: a No there
 * says why, which the tour's two buttons leave no room for.
 */
export function ProjectWorkshopFrame({
  purpose, onAll, facts, vote, work, live, weeks, slots, rule, unclaimed, unclaimedTotal, onAllUnclaimed, ...head
}: HeadProps & {
  purpose: string;
  /** All items, the Workshop's own page. */
  onAll: () => void;
  facts: Array<{ value: number | string; label: string; tone?: 'acc' | 'ok' | 'wait' }>;
  vote: { id: string | null; title: string; line: string | null; yes: number; no: number; of: number; need: number; note: string | null; onVote: () => void } | null;
  work: { line: string | null; words: string | null; href: string } | null;
  live: Array<{ key: string; title: string; ago: string | null; href: string }>;
  weeks: Array<{ key: string; title: string; line: string | null; right: string | null; onOpen: () => void }>;
  slots: { title: string; line: string | null; onOpen: () => void } | null;
  rule: RuleRow | null;
  unclaimed: Array<{ key: string; title: string; id: string | null; onOpen: () => void }>;
  unclaimedTotal: number;
  onAllUnclaimed: () => void;
}) {
  useProjectFrameFlag();
  const t = useMessages('project');
  const acts = useActs({ ...head, second: { label: t('project:workshop.allItems.title'), icon: 'list', onClick: onAll } });
  const left = vote ? Math.max(0, vote.need - vote.yes) : 0;
  return (
    <PageBody
      data-project-frame="workshop-kit"
      title={t('project:places.list.workshop')}
      purpose={purpose}
      acts={acts}
      tabs={<PlaceTabs tabs={head.tabs} tab={head.tab} onTab={head.onTab} />}
      side={(
        <>
          {slots ? (
            <Sec label={t('project:frame.workshop.bot')}>
              <Card><Row lead={<Lead icon="spark" />} title={slots.title} line={slots.line || undefined} go onClick={slots.onOpen} sm={false} /></Card>
            </Sec>
          ) : null}
          {rule ? (
            <Sec label={t('project:frame.workshop.rule')}>
              <Card><Row lead={<Lead icon="shield" />} title={rule.title} line={rule.line || undefined} go={!!rule.onOpen} onClick={rule.onOpen || undefined} sm={false} wrap /></Card>
            </Sec>
          ) : null}
          {unclaimed.length ? (
            <Sec
              label={t('project:frame.workshop.unclaimed')}
              action={unclaimedTotal > unclaimed.length ? <GroupLink onClick={onAllUnclaimed}>{t('project:frame.workshop.all', { count: unclaimedTotal })}</GroupLink> : undefined}
            >
              <Card>
                {unclaimed.map((row) => <Row key={row.key} title={row.title} line={row.id || undefined} go onClick={row.onOpen} sm={false} />)}
              </Card>
            </Sec>
          ) : null}
        </>
      )}
    >
      {facts.length ? <Sec label={t('project:frame.workshop.where')}><Facts items={facts} /></Sec> : null}
      {vote ? (
        <Sec label={t('project:frame.workshop.needsVote')}>
          <Ballot
            pill={<Pill kind="act">{t('project:frame.workshop.yourVote')}</Pill>}
            id={vote.id}
            title={vote.title}
            line={vote.line}
            yes={vote.yes}
            no={vote.no}
            of={vote.of}
            need={vote.need}
            words={{
              yes: t('project:frame.workshop.yes', { count: vote.yes }),
              rest: left > 0 ? t('project:frame.workshop.noMore', { no: vote.no, count: left }) : t('project:frame.workshop.noPassed', { no: vote.no }),
              needed: t('project:frame.workshop.needed', { count: vote.need }),
            }}
            actions={<Btn kind="ok" icon="check" onClick={vote.onVote}>{t('project:frame.workshop.review')}</Btn>}
            note={vote.note}
          />
        </Sec>
      ) : null}
      {work ? (
        <Sec label={t('project:workshop.desk.title')}>
          <Card>
            <Row href={work.href} lead={<Lead icon="tool" />} title={t('project:workshop.desk.title')} line={work.line || undefined} right={<Meta>{work.words}</Meta>} go sm={false} />
          </Card>
        </Sec>
      ) : null}
      {live.length ? (
        <Sec label={t('project:hub.recent.title')}>
          <Card>
            {live.map((row) => <Row key={row.key} sm href={row.href} lead={<Lead icon="rocket" tone="ok" />} title={row.title} right={<Meta>{row.ago}</Meta>} go />)}
          </Card>
        </Sec>
      ) : null}
      {weeks.length ? (
        <Sec label={t('project:frame.workshop.weeks')}>
          <Card>
            {weeks.map((week) => (
              <Row key={week.key} lead={<Lead icon="clock" />} title={week.title} line={week.line || undefined} right={<Meta>{week.right}</Meta>} go onClick={week.onOpen} sm={false} />
            ))}
          </Card>
        </Sec>
      ) : null}
    </PageBody>
  );
}

/** One of All items' rows: an open request or change, as the page says it. */
export interface AllItemRow {
  key: string;
  title: string;
  /** "#6204 · Onboarding": the number and the topic. */
  line: string | null;
  href: string | null;
  mine: boolean;
  /** The word that says where it stands ("Building"), when no pill does. */
  word?: string | null;
  /** The one pill: Vote, Reply, On votes. */
  pill?: { kind: PillKind; label: string } | null;
}

/** A stage of the board: its name, and the items in it, newest first. */
export interface AllItemsCol { key: string; title: string; items: AllItemRow[] }

/** The five-stop line's stop for each of the board's columns. */
const COL_STOP: Record<string, [number, 'now' | 'wait']> = {
  issues: [0, 'now'], inprogress: [1, 'now'], inreview: [3, 'wait'], done: [5, 'now'],
};

/**
 * All items (the tour's s29): the Workshop's own page of every open request
 * and change. The board's columns are the page's tabs; one row per item,
 * with the five-stop line and the word that says where it stands; Show
 * beside them narrows the list to yours.
 */
export function ProjectAllItemsFrame({
  project, cols, loading, stage, onStage, mine, onMine, query, onQuery, openKey, onOpen, ...head
}: HeadProps & {
  project: string;
  cols: AllItemsCol[];
  loading: boolean;
  /** The column shown, or '' for all. */
  stage: string;
  onStage: (key: string) => void;
  mine: boolean;
  onMine: (mine: boolean) => void;
  query: string;
  onQuery: (next: string) => void;
  /** The item open beside the list, as `kind:id`. */
  openKey: string | null;
  onOpen: (event: React.MouseEvent<HTMLAnchorElement>, row: AllItemRow) => void;
}) {
  useProjectFrameFlag();
  const t = useMessages('project');
  const tc = useMessages('changes');
  const acts = useActs(head);
  const stops = [tc('changes:track.plan'), tc('changes:track.build'), tc('changes:track.checks'), tc('changes:track.vote'), tc('changes:track.live')] as const;
  // Done is on the board for what went live; the page counts what is open.
  const total = cols.filter((col) => col.key !== 'done').reduce((n, col) => n + col.items.length, 0);
  const q = query.trim().toLowerCase();
  // All is what is open; what went live is its own tab, as the tour's "Live this week".
  const shown = cols
    .filter((col) => (stage ? col.key === stage : col.key !== 'done'))
    .flatMap((col) => col.items.map((row) => ({ col, row })))
    .filter(({ row }) => !mine || row.mine)
    .filter(({ row }) => !q || row.title.toLowerCase().includes(q) || (row.line || '').toLowerCase().includes(q));
  return (
    <PageBody
      data-project-frame="all-kit"
      title={t('project:workshop.allItems.title')}
      purpose={t('project:frame.allItems.purpose', { count: total, project })}
      acts={acts}
      tabs={(
        <Tabs
          tabs={[{ key: '', label: t('project:frame.allItems.all') }, ...cols.map((col) => ({ key: col.key, label: col.title, count: col.items.length }))]}
          current={stage}
          onPick={(key) => onStage(key)}
        />
      )}
      side={(
        <Sec label={t('project:frame.allItems.show')}>
          <Card>
            <Row lead={<Lead icon={mine ? '' : 'check'} />} title={t('project:frame.allItems.everyone')} on={!mine} pressed={!mine} onClick={() => onMine(false)} sm />
            <Row lead={<Lead icon={mine ? 'check' : ''} />} title={t('project:frame.allItems.mine')} on={mine} pressed={mine} onClick={() => onMine(true)} sm />
          </Card>
        </Sec>
      )}
    >
      <Search value={query} onChange={onQuery} placeholder={t('project:frame.allItems.search')} />
      <Sec label={t('project:frame.allItems.open', { count: shown.length })}>
        {loading && !cols.length ? <Card pad>{t('project:frame.allItems.loading')}</Card>
          : !shown.length ? <Card pad>{t('project:frame.allItems.none')}</Card>
            : (
              <Card>
                {shown.map(({ col, row }) => {
                  const [at, state] = COL_STOP[col.key] || [0, 'now'];
                  return (
                    <Row
                      key={row.key}
                      href={row.href || undefined}
                      onClick={row.href ? (event) => onOpen(event as React.MouseEvent<HTMLAnchorElement>, row) : undefined}
                      title={row.title}
                      line={row.line || undefined}
                      right={(
                        <>
                          <Track mini at={at} state={state} words={stops} />
                          {row.pill ? <Pill kind={row.pill.kind}>{row.pill.label}</Pill> : <Meta>{row.word || col.title}</Meta>}
                        </>
                      )}
                      on={!!openKey && openKey === row.key}
                      go
                    />
                  );
                })}
              </Card>
            )}
      </Sec>
    </PageBody>
  );
}
