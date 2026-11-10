/**
 * The Messages list in the one frame, as the 2026-11-06 screen tour draws
 * it (its step s15): the page's head (Messages, one sentence, New message),
 * People and Agents as the page's tabs, a search, then the conversations as
 * the kit's one row. A conversation with something new ends in the blue
 * pill; the others in a grey time. Agents (s20) is the same list of the
 * older chats with coding agents: its own sentence and search, the chats
 * counted over the group, each row ending in its status as one word.
 *
 * Presentational. The list pane (./index.tsx ConversationList) builds each
 * row from the conversations, sessions and words it already has and hands
 * them here in place of its own rows while the device's look is one of the
 * frame's. Nothing is read, searched or opened in this file.
 */
import type { MouseEvent, ReactNode } from 'react';

import { Btn, Card, Frame, Head, Meta, Pill, Row, Search, Sec, Tabs, k } from '@/components/ui/kit';
import type { PillKind } from '@/components/ui/kit';
import { useMessages } from '../../lib/i18n/react';

export type FrameInboxTab = 'people' | 'agents';

export interface FrameInboxRow {
  key: string;
  section: FrameInboxTab;
  /** The picture: a person, a group, or an agent's glyph (kit Av or Lead). */
  lead: ReactNode;
  title: string;
  line?: string | null;
  /** How long ago, in the list's own words. */
  time?: string | null;
  /** New since the viewer last looked, in words ("2 new"); the row then ends in the blue pill. */
  fresh?: string | null;
  /** Where an agent's work stands, as one word; drawn when nothing is new. */
  status?: { text: string; kind: PillKind } | null;
  active: boolean;
  href: string;
  onClick: (event: MouseEvent<HTMLElement>) => void;
}

export function MessagesFrameList({ rows, tab, onTab, query, onQuery, onNew, loaded }: {
  rows: FrameInboxRow[];
  tab: FrameInboxTab;
  onTab: (next: FrameInboxTab) => void;
  query: string;
  onQuery: (next: string) => void;
  onNew: () => void;
  /** The list has been read: until then nothing says "nothing here". */
  loaded: boolean;
}) {
  const t = useMessages('messages');
  const tc = useMessages('core');
  const shown = rows.filter((row) => row.section === tab);
  const fresh = rows.filter((row) => row.section === 'people' && row.fresh).length;
  const agents = tab === 'agents';
  return (
    <Frame className="fr-pane" data-messages-frame-list="">
      <div className={k('scroll')}>
        <Head
          title={tc('core:tabs.messages')}
          purpose={agents ? t('messages:frame.inbox.agentsPurpose') : t('messages:frame.inbox.purpose')}
          acts={<Btn icon="edit" onClick={onNew}>{t('messages:frame.inbox.new')}</Btn>}
        />
        <Tabs
          tabs={[
            { key: 'people', label: t('messages:frame.inbox.tabPeople'), count: fresh },
            { key: 'agents', label: t('messages:frame.inbox.tabAgents') },
          ]}
          current={tab}
          onPick={(key) => onTab(key as FrameInboxTab)}
        />
        <Search value={query} onChange={onQuery} placeholder={agents ? t('messages:frame.inbox.agentsSearch') : t('messages:frame.inbox.search')} />
        <div className={k('stack')}>
          {shown.length > 0 ? (
            <Sec label={agents ? t('messages:frame.inbox.agentsCount', { count: shown.length }) : undefined}>
              <Card>
                {shown.map((row) => (
                  <Row
                    key={row.key}
                    href={row.href}
                    onClick={row.onClick}
                    lead={row.lead}
                    title={row.title}
                    line={row.line || undefined}
                    right={row.fresh
                      ? <Pill kind="act">{row.fresh}</Pill>
                      : row.status ? <Pill kind={row.status.kind}>{row.status.text}</Pill> : <Meta>{row.time}</Meta>}
                    on={row.active}
                  />
                ))}
              </Card>
            </Sec>
          ) : loaded ? <Card pad>{t('messages:frame.inbox.none')}</Card> : null}
        </div>
      </div>
    </Frame>
  );
}
