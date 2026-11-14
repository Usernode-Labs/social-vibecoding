/**
 * The Messages list in the one frame, version 2 (the tour's s15 and s20):
 * the first tour's layout holding the list the standard look draws.
 *
 * The page's head (Messages, one sentence, New message), People and Agents
 * as the page's tabs, the product's search under them, then the tab's
 * conversations as the kit's one row in one card. The standard list's two
 * sections are the two tabs; everything inside a section is as it is there:
 * a group's member count after its name, "N new" or the time, an agent
 * chat's project and where its change stands, this week's agent chats with
 * the older ones behind "N older chats", and the archived ones behind "Show
 * archived" at the end. What the list says when it is offline, failed,
 * loading, empty or searched to nothing is the product's sentence.
 *
 * Presentational. The list pane (./index.tsx ConversationList) builds each
 * row from the conversations, sessions and words it already has, folds
 * Agents with the standard list's own rule, and hands the result here in
 * place of its own rows while the device's look is one of the frame's.
 * Nothing is read, searched, folded or opened in this file.
 */
import type { MouseEvent, ReactNode } from 'react';

import { Btn, Card, Frame, Head, Icon, Note, Pill, Row, Search, Sec, Tabs, k } from '@/components/ui/kit';
import type { PillKind } from '@/components/ui/kit';
import { useMessages } from '../../lib/i18n/react';

export type FrameInboxTab = 'people' | 'agents';

export interface FrameInboxRow {
  key: string;
  /** The picture: a person, a group, or an agent's glyph (kit Av or Lead). */
  lead: ReactNode;
  title: string;
  /** One small word after the name: "AI" on a bot's direct message. */
  tag?: string | null;
  /** A group's size after its name: the figure, and the words a screen reader hears ("4 members"). */
  members?: { count: number; words: string } | null;
  /** Said after the title to a screen reader: an agent at work, or finished and not yet seen. */
  said?: string | null;
  line?: string | null;
  /** How long ago, in the list's own words, and the whole instant as its hover. */
  time?: string | null;
  timeTitle?: string | null;
  /** New since the viewer last looked, in words ("2 new"); the row then ends in the blue pill. */
  fresh?: string | null;
  /** Where an agent's work stands, as one word; drawn when nothing is new. */
  status?: { text: string; kind: PillKind } | null;
  /** A change in flight with news not seen yet (the standard row's dot): the words a screen reader hears, and the session it marks. */
  unseen?: { said: string; session: number | string } | null;
  active: boolean;
  href: string;
  onClick: (event: MouseEvent<HTMLElement>) => void;
}

export interface FrameInboxState {
  /** The first read is under way: nothing says "nothing here" yet. */
  loading: boolean;
  /** A read is under way with nothing to show yet, a retry after a failed one too: no tab says "Nothing here yet." meanwhile. */
  reading?: boolean;
  /** The read failed, in the store's words. */
  error: string | null;
  onRetry: () => void;
  offline: boolean;
  /** The inbox holds nothing at all (not: this search matched nothing). */
  empty: boolean;
  /** The empty inbox's one action: the product's create dialog. */
  onStart: () => void;
  /** What is being searched for, or null when nothing is. */
  searched: string | null;
}

export interface FrameInboxArchive {
  open: boolean;
  onToggle: () => void;
  /** Null while the archived chats are being read. */
  rows: FrameInboxRow[] | null;
  error: string;
  onRetry: () => void;
}

/** The centred link inside a card that opens more of it in place, and says whether it has. */
function Fold({ open, onClick, children, ...data }: { open: boolean; onClick: () => void; children: ReactNode } & Record<`data-${string}`, string>) {
  return (
    <button type="button" className={k('row', 'sm', 'showall')} aria-expanded={open} onClick={onClick} {...data}>
      <span className={k('tx')}><span className={k('t')}>{children}</span></span>
    </button>
  );
}

function InboxRow({ row }: { row: FrameInboxRow }) {
  return (
    <Row
      // The list's own key, as the standard row carries it: what the pane finds a row by (index.tsx, #6508).
      data-inbox-row={row.key}
      href={row.href}
      onClick={row.onClick}
      lead={row.lead}
      title={(
        <>
          {/* The name is what is cut short: the badge and the member count after it are never pushed out of the row (app.css). */}
          <span className={k('cut')}>{row.title}</span>
          {row.tag ? <Pill mini>{row.tag}</Pill> : null}
          {row.members ? <span className={k('pill', 'mini')} role="img" aria-label={row.members.words} title={row.members.words}><Icon name="users" size={12} />{row.members.count}</span> : null}
          {row.said ? <span className="sr-only">{row.said}</span> : null}
        </>
      )}
      line={row.line || undefined}
      right={row.fresh
        ? <Pill kind="act">{row.fresh}</Pill>
        : row.status ? (
          <>
            <Pill kind={row.status.kind}>{row.status.text}</Pill>
            {/* News not seen yet: the standard row's dot, after its state (features/improve/session-row.tsx). */}
            {row.unseen ? <span role="img" aria-label={row.unseen.said} data-inbox-unseen="" data-session-unread={row.unseen.session} /> : null}
          </>
        ) : row.time ? <span className={k('meta')} title={row.timeTitle || undefined}>{row.time}</span> : null}
      on={row.active}
    />
  );
}

export function MessagesFrameList({
  people, agents, older = 0, olderRows = [], olderOpen = false, onOlder, archive = null, unread = 0, working = null, tab, onTab, query, onQuery, onNew, state,
}: {
  people: FrameInboxRow[];
  /** Agents, as the standard list shows it: this week's chats, the open one, and any that asks for you. */
  agents: FrameInboxRow[];
  /** How many more are behind "N older chats", and those rows once it is pressed. */
  older?: number;
  olderRows?: FrameInboxRow[];
  olderOpen?: boolean;
  onOlder?: () => void;
  /** "Show archived" and what it opens; null where the standard list does not offer it. */
  archive?: FrameInboxArchive | null;
  /** Messages from people not read yet: the People tab's count. */
  unread?: number;
  /** Agents at work, as the standard heading says it ("2 working"); null when none is. */
  working?: string | null;
  tab: FrameInboxTab;
  onTab: (next: FrameInboxTab) => void;
  query: string;
  onQuery: (next: string) => void;
  onNew: () => void;
  state: FrameInboxState;
}) {
  const t = useMessages('messages');
  const tc = useMessages('core');
  const onAgents = tab === 'agents';
  const shown = onAgents ? agents : people;
  const has = shown.length > 0 || (onAgents && (older > 0 || !!archive));
  const placeholder = t('messages:inbox.searchPlaceholder');
  const label = t('messages:inbox.searchLabel');
  return (
    <Frame className="fr-pane" data-messages-frame-list="" data-inbox-tab={tab}>
      <div className={k('scroll')}>
        <Head
          title={tc('core:tabs.messages')}
          purpose={onAgents ? t('messages:frame.inbox.agentsPurpose') : t('messages:frame.inbox.purpose')}
          acts={<Btn icon="edit" onClick={onNew}>{t('messages:inbox.new.button')}</Btn>}
        />
        <Tabs
          tabs={[
            { key: 'people', label: t('messages:inbox.section.people'), count: unread },
            // "2 working" is not a count that asks for you: a small grey word after the name, as on the standard heading.
            { key: 'agents', label: working ? <>{t('messages:inbox.section.agents')}<Pill mini>{working}</Pill></> : t('messages:inbox.section.agents') },
          ]}
          current={tab}
          onPick={(key) => onTab(key as FrameInboxTab)}
        />
        {/* Under the tabs at every width: the pane is 520px, too narrow for a field at the tabs' end. */}
        <Search value={query} onChange={onQuery} placeholder={placeholder} label={label} />
        <div className={k('stack')}>
          {state.offline ? <Note tone="wait">{t('messages:inbox.offline')}</Note> : null}
          {state.error ? (
            <Card pad>
              <div className={k('txt')} role="status" data-inbox-failed="">
                {`${state.error} `}
                <button type="button" className={k('link')} onClick={state.onRetry}>{tc('core:common.tryAgain')}</button>
              </div>
            </Card>
          ) : null}
          {state.loading ? <p className={k('txt')} role="status" data-inbox-loading="">{t('messages:inbox.loading')}</p> : null}
          {has ? (
            <Sec>
              <Card>
                {shown.map((row) => <InboxRow key={row.key} row={row} />)}
                {onAgents && older > 0 ? (
                  <Fold open={olderOpen} onClick={() => onOlder?.()} data-inbox-more="agents">
                    {olderOpen ? t('messages:inbox.older.hide') : t('messages:inbox.older.show', { count: older })}
                  </Fold>
                ) : null}
                {onAgents ? olderRows.map((row) => <InboxRow key={row.key} row={row} />) : null}
                {onAgents && archive ? (
                  <Fold open={archive.open} onClick={archive.onToggle} data-inbox-archived="">
                    {archive.open ? t('messages:inbox.archived.hide') : t('messages:inbox.archived.show')}
                  </Fold>
                ) : null}
              </Card>
            </Sec>
          ) : null}
          {onAgents && archive?.open ? (
            <Sec label={t('messages:inbox.archived.heading')} data-inbox-section="archived">
              {archive.error ? (
                <Card pad>
                  <div className={k('txt')} role="status">
                    {`${archive.error} `}
                    <button type="button" className={k('link')} onClick={archive.onRetry}>{tc('core:common.tryAgain')}</button>
                  </div>
                </Card>
              ) : !archive.rows ? (
                <p className={k('txt')} role="status">{t('messages:inbox.loading')}</p>
              ) : !archive.rows.length ? (
                <Card pad>{t('messages:inbox.archived.empty')}</Card>
              ) : (
                <Card>{archive.rows.map((row) => <InboxRow key={row.key} row={row} />)}</Card>
              )}
            </Sec>
          ) : null}
          {state.empty ? (
            <Card pad text>
              <div className={k('sub15')}>{t('messages:inbox.empty.title')}</div>
              <p className={k('txt')}>{t('messages:inbox.empty.body')}</p>
              <div className={k('btnrow')}><Btn kind="quiet" small onClick={state.onStart}>{t('messages:inbox.empty.action')}</Btn></div>
            </Card>
          ) : has || state.loading || state.reading || state.error ? null : state.searched !== null ? (
            <Card pad><span data-inbox-search-empty="">{t('messages:inbox.searchEmpty', { query: state.searched })}</span></Card>
          ) : (
            <Card pad>{t('messages:frame.inbox.none')}</Card>
          )}
        </div>
      </div>
    </Frame>
  );
}
