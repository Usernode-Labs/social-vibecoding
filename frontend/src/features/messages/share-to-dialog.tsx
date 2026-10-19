/**
 * Share to… (#3660): a card, posted into a chat the sharer picks.
 *
 * A request's or a proposal's ⋯ menu used to say "Share to Messages" and
 * take the sharer to Messages, where they picked a conversation, met the
 * composer's "Share item" dialog filled in, attached it, and sent. Four
 * steps and two screens to put one card in front of someone, and an app's
 * discussion was not a place it could go at all. This is one dialog: pick a
 * DM, a group, #general or an app's discussion, add a line if you like, and
 * Send posts it there.
 *
 * ── Two destinations, two ways in ──────────────────────────────────────
 *
 *   * A CONVERSATION (a DM, a group, #general) takes the card as a shared
 *     item, the same structured reference the composer's Share item sends
 *     (store.ts `shareToConversation`). The server checks the sharer can see
 *     it, and draws it for each reader as THEY can see it.
 *   * AN APP'S DISCUSSION has no shared items. It takes the card's link,
 *     on this platform's own address, which the discussion draws as the same
 *     card (./link-cards.tsx) — also resolved for each reader. Posting there
 *     is the discussion's own write (routes/chat.js), with its own rule:
 *     a member of the community, which the server answers with the reason
 *     when the sharer is not one.
 *
 * ── Where the list comes from ──────────────────────────────────────────
 *
 * The Messages store's own two lists, loaded on open if Messages has not
 * loaded them yet: the viewer's conversations they can write in, and their
 * apps' discussions. Homeroom's own app is not listed as a discussion — its
 * channel is #general, which is.
 *
 * The rows draw only while the dialog is open, so the prerendered card is
 * the same empty shell on every load (the islands rule in AGENTS.md).
 */

import { useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { DialogCard, DialogRoot } from '@/components/ui/dialog';
import { XIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';
import { useDialog } from '../dialogs/use-dialog';
import { toast } from '../message-actions/clipboard';
import * as api from './api';
import { platformSlug } from './channel-hub';
import { UserAvatar } from './format';
import type { AppDiscussion } from './inbox';
import { loadAppDiscussions, loadConversations, shareToConversation, useMessagesSnapshot } from './store';
import type { ConversationSummary, SharedObjectReference } from './types';

/** What a card's menu hands the dialog: the item, and its title to show. */
export interface ShareToPayload extends SharedObjectReference {
  title?: string | null;
}

/** One place the card can go, as a row of the list. */
export interface ShareDestination {
  key: string;
  kind: 'direct' | 'group' | 'channel' | 'discussion';
  /** What the row says, and the toast after: "@ada", "Design crew", "#general", "Recipe Box". */
  label: string;
  /** `label` is a stand-in, for a person with no username or a conversation with no name: the toast has its own wording. */
  unnamed?: 'person' | 'conversation';
  /** The muted line under it. */
  detail: string;
  conversation?: ConversationSummary;
  slug?: string;
}

/** What an item is called alone, and with its number: message ids. */
const TYPE_WORDS: Record<SharedObjectReference['type'], { plain: string; numbered: string }> = {
  app: { plain: 'messages:shareTo.item.app', numbered: 'messages:shareTo.item.app' },
  issue: { plain: 'messages:shareTo.item.issue', numbered: 'messages:shareTo.item.issueNumbered' },
  proposal: { plain: 'messages:shareTo.item.proposal', numbered: 'messages:shareTo.item.proposalNumbered' },
  governance: { plain: 'messages:shareTo.item.governance', numbered: 'messages:shareTo.item.governanceNumbered' },
  spec: { plain: 'messages:shareTo.item.spec', numbered: 'messages:shareTo.item.specNumbered' },
};
const UNKNOWN_TYPE_WORDS = { plain: 'messages:shareTo.item.unknown', numbered: 'messages:shareTo.item.unknownNumbered' };

/** "Request #12", "Proposal #4209": what the card is, when no title came with it. */
export function itemName(item: SharedObjectReference): string {
  const word = TYPE_WORDS[item.type] || UNKNOWN_TYPE_WORDS;
  const n = item.type === 'issue' ? item.issueNumber
    : item.type === 'governance' ? item.proposalId
      : item.type === 'app' ? null : item.sessionId;
  return n ? translate(word.numbered, { number: n }) : translate(word.plain);
}

/**
 * The card's page on this platform's own address, which an app's
 * discussion draws as its card. The clean path the router writes for it
 * (public/js/app.js `_appUrl`).
 */
export function itemLink(item: SharedObjectReference, origin: string): string {
  const slug = encodeURIComponent(item.appSlug || '');
  const base = `${origin}/app/${slug}`;
  if (item.type === 'issue' && item.issueNumber) return `${base}/dev/issues/${item.issueNumber}`;
  if (item.type === 'proposal' && item.sessionId) return `${base}/dev/proposals/${item.sessionId}`;
  if (item.type === 'governance' && item.proposalId) return `${base}/dev/governance/${item.proposalId}`;
  if (item.type === 'spec' && item.sessionId) return `${base}/dev/sessions/${item.sessionId}`;
  return base;
}

/** The reference alone, as the server takes it: no title, nothing else. */
function referenceOf(item: ShareToPayload): SharedObjectReference {
  const { type, appId, appSlug, issueNumber, sessionId, proposalId, version } = item;
  return { type, appId, appSlug, issueNumber, sessionId, proposalId, version };
}

function directPeer(conversation: ConversationSummary, me: number) {
  return conversation.peer || conversation.members.find((member) => Number(member.id) !== me) || null;
}

/**
 * Every place the viewer can post to, conversations first in the inbox's
 * order, then the discussions in theirs. Exported for the test that pins
 * which rows are offered.
 */
export function shareDestinations(
  conversations: readonly ConversationSummary[],
  discussions: readonly AppDiscussion[],
  { me = 0, platform = null }: { me?: number; platform?: string | null } = {},
): ShareDestination[] {
  const rows: ShareDestination[] = [];
  for (const conversation of conversations) {
    // Somewhere they can write now: a member, not a request or an
    // invitation still waiting, and not archived.
    if (conversation.membershipStatus !== 'member' || !conversation.canSend || conversation.archived) continue;
    if (conversation.kind === 'direct') {
      const peer = directPeer(conversation, me);
      rows.push({
        key: `c:${conversation.id}`, kind: 'direct', conversation,
        label: peer ? `@${peer.username}` : conversation.title, detail: translate('messages:shareTo.detail.direct'),
        // Which stand-in the label is, if it is one: the person's, or the conversation's.
        ...(peer ? (peer.unnamed ? { unnamed: 'person' as const } : {}) : (conversation.untitled ? { unnamed: 'conversation' as const } : {})),
      });
    } else if (conversation.kind === 'channel') {
      rows.push({
        key: `c:${conversation.id}`, kind: 'channel', conversation,
        label: `#${conversation.channelKey || conversation.title}`, detail: translate('messages:shareTo.detail.everyone'),
      });
    } else {
      rows.push({
        key: `c:${conversation.id}`, kind: 'group', conversation,
        label: conversation.title, detail: translate('messages:shareTo.detail.group', { count: conversation.memberCount }),
        ...(conversation.untitled ? { unnamed: 'conversation' as const } : {}),
      });
    }
  }
  for (const discussion of discussions) {
    if (platform && discussion.slug === platform) continue;
    rows.push({
      key: `d:${discussion.slug}`, kind: 'discussion', slug: discussion.slug,
      label: discussion.name, detail: translate('messages:shareTo.detail.discussion', { channel: discussion.channel || discussion.slug }),
    });
  }
  return rows;
}

/**
 * What a refused send says. A discussion answers 404 to a viewer who may
 * read it but not write there (routes/chat.js hides which), so that reads
 * as the place, not as "App not found"; a community's own refusal ("Join …
 * to take part") and a conversation's arrive worded and are shown as sent.
 */
export function shareError(err: unknown, choice: Pick<ShareDestination, 'kind' | 'label'>): string {
  const status = Number((err as { status?: unknown } | null)?.status) || 0;
  if (choice.kind === 'discussion' && status === 404) return translate('messages:shareTo.error.cannotPost', { discussion: choice.label });
  if (status === 429) return translate('messages:shareTo.error.tooFast');
  return err instanceof Error && err.message ? err.message : translate('messages:shareTo.error.failed');
}

function matches(row: ShareDestination, query: string): boolean {
  const q = query.trim().toLowerCase().replace(/^[@#]/, '');
  if (!q) return true;
  return `${row.label} ${row.detail} ${row.slug || ''}`.toLowerCase().includes(q);
}

function DestinationTile({ row }: { row: ShareDestination }) {
  if (row.kind === 'direct') {
    const peer = row.conversation?.peer || null;
    return <UserAvatar user={peer} title={row.label.replace(/^@/, '')} size="sm" shape="square" />;
  }
  if (row.kind === 'group') return <UserAvatar title={row.label} size="sm" shape="square" />;
  return (
    <span aria-hidden="true" className="w-7 h-7 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 text-xs font-bold flex items-center justify-center shrink-0">#</span>
  );
}

export function ShareToDialog() {
  const t = useMessages('messages');
  const snap = useMessagesSnapshot();
  const [item, setItem] = useState<ShareToPayload | null>(null);
  const [query, setQuery] = useState('');
  const [note, setNote] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // What `canClose` reads: the dialog consults it outside a render, so the
  // state above would answer with the value from the last one.
  const busy = useRef(false);
  const [error, setError] = useState('');
  const dialog = useDialog<ShareToPayload>('shareTo', {
    onOpen: (payload) => {
      setItem(payload || null); setQuery(''); setNote(''); setChosen(null); setError('');
      busy.current = false; setSending(false);
      // The two lists Messages keeps. Conversations once per page (the
      // socket keeps them current after that); discussions every open,
      // since nothing else refreshes them off the Messages screen.
      void loadConversations();
      void loadAppDiscussions();
    },
    // Not while a send is in flight: closing mid-request would leave the
    // sharer not knowing whether the card went.
    canClose: () => !busy.current,
  });

  const me = typeof window !== 'undefined' ? Number(window.App?.user?.id) || 0 : 0;
  const rows = useMemo(() => (dialog.isOpen
    ? shareDestinations(snap.conversations, snap.discussions, { me, platform: platformSlug() })
    // `t` changes with the language: the rows' second lines are read from the catalog.
    : []), [dialog.isOpen, snap.conversations, snap.discussions, me, t]);
  const shown = useMemo(() => rows.filter((row) => matches(row, query)), [rows, query]);
  const choice = rows.find((row) => row.key === chosen) || null;
  const loading = dialog.isOpen && !rows.length && (!snap.listLoaded || !snap.discussionsLoaded);

  async function send() {
    if (!item || !choice || busy.current) return;
    busy.current = true; setSending(true); setError('');
    try {
      const reference = referenceOf(item);
      if (choice.conversation) {
        await shareToConversation(choice.conversation.id, reference, note);
      } else if (choice.slug) {
        const link = itemLink(reference, window.location.origin);
        const words = note.trim();
        await api.postAppMessage(choice.slug, words ? `${words}\n\n${link}` : link);
      }
      busy.current = false; setSending(false);
      toast(choice.unnamed === 'person' ? t('messages:shareTo.sharedToUnknown')
        : choice.unnamed === 'conversation' ? t('messages:shareTo.sharedToUntitled')
          : t('messages:shareTo.sharedTo', { destination: choice.label }));
      dialog.close();
    } catch (err) {
      busy.current = false; setSending(false);
      setError(shareError(err, choice));
    }
  }

  const title = item ? (item.title || itemName(item)) : '';

  return (
    <DialogRoot id="share-to-dialog" layout="scroll" ref={dialog.rootRef} {...dialog.backdropProps}>
      <DialogCard size="md">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold">{t('messages:shareTo.title')}</h2>
          <button type="button" onClick={dialog.close} className="text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 dark:text-zinc-400" aria-label={t('core:common.close')}><XIcon className="w-5 h-5" /></button>
        </div>
        {item ? (
          <div className="mb-3 flex items-center gap-3 rounded-lg bg-zinc-100 dark:bg-zinc-800 px-3 py-2" data-share-item="">
            <span aria-hidden="true" className="w-7 h-7 rounded-lg bg-white dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300 text-xs font-bold flex items-center justify-center shrink-0">{item.type === 'app' ? '◆' : '#'}</span>
            <div className="min-w-0">
              <div className="text-xs text-zinc-500 dark:text-zinc-400">{itemName(item)}</div>
              <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">{title}</div>
            </div>
          </div>
        ) : null}
        <label className="block">
          <span className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">{t('messages:shareTo.sendTo')}</span>
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('messages:shareTo.searchPlaceholder')} autoComplete="off" />
        </label>
        <div role="listbox" aria-label={t('messages:shareTo.listName')} data-share-destinations="" className="mt-2 min-h-12 max-h-60 overflow-y-auto">
          {loading ? <p className="text-xs text-zinc-500 dark:text-zinc-400 px-2 py-3">{t('messages:shareTo.loading')}</p> : null}
          {dialog.isOpen && !loading && !shown.length ? (
            <p className="text-xs text-zinc-500 dark:text-zinc-400 px-2 py-3">{query.trim() ? t('messages:shareTo.noMatch') : t('messages:shareTo.empty')}</p>
          ) : null}
          {shown.map((row) => {
            const selected = row.key === chosen;
            return (
              <button
                key={row.key}
                type="button"
                role="option"
                aria-selected={selected}
                data-share-destination={row.kind}
                disabled={sending}
                onClick={() => { setChosen(row.key); setError(''); }}
                className={`w-full flex items-center gap-3 rounded-lg px-2 py-2 text-left disabled:opacity-50 ${selected ? 'bg-violet-100 dark:bg-violet-950' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800'}`}
              >
                <DestinationTile row={row} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium truncate">{row.label}</span>
                  <span className="block text-xs text-zinc-500 dark:text-zinc-400 truncate">{row.detail}</span>
                </span>
                {selected ? <span className="text-xs font-semibold text-violet-700 dark:text-violet-300">{t('messages:shareTo.selected')}</span> : null}
              </button>
            );
          })}
        </div>
        <label className="block mt-3">
          <span className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">{t('messages:shareTo.noteLabel')}</span>
          <Textarea value={note} onChange={(event) => setNote(event.target.value.slice(0, 2000))} rows={2} maxLength={2000} placeholder={t('messages:shareTo.notePlaceholder')} />
        </label>
        {choice?.kind === 'discussion' ? (
          <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{t('messages:shareTo.discussionNote', { discussion: choice.label })}</p>
        ) : null}
        {error ? <p role="alert" className="mt-3 text-xs text-red-700 dark:text-red-400">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="neutral" ink="neutral" disabled={sending} onClick={dialog.close}>{t('core:common.cancel')}</Button>
          <Button type="button" disabled={!item || !choice || sending} onClick={() => void send()}>{sending ? t('messages:shareTo.sharing') : t('messages:shareTo.send')}</Button>
        </div>
      </DialogCard>
    </DialogRoot>
  );
}
