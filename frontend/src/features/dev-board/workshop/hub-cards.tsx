/**
 * The project hub's own cards. The hub is the first of the project page's
 * four tabs (Hub, Chat, Needs you, All items: ./project-band.tsx), and it
 * answers "what is new, what is owed, what are people saying, what is mine"
 * itself. Under the hero (./community-card.tsx), in the order agreed in
 * #852:
 *
 *   the since-your-last-visit summary (./since-summary-card.tsx), the VOTES
 *   waiting on you as one row, the CHAT's last two lines, YOUR WORK when you
 *   have some, and Start a new change.
 *
 * Your work is the first two of your items with the rest a press away IN
 * PLACE, because a list you came to the hub to glance at should not send
 * you to another page to see its third row. The votes row and the chat's
 * Open are the Needs you and Chat tabs; the doors to Needs you and the
 * Workshop page went with the tabs coming back (the Workshop page opens
 * from the summary card's Week by week).
 *
 * Members & activity was the third card. It is the hero's now (#3268,
 * ./community-card.tsx HeroPeople and HeroActivity): who is here and how
 * lively it has been are part of what the project IS, so they are read
 * where the page starts rather than three cards down.
 *
 * ── The channel lives here now ─────────────────────────────────────────
 *
 * A project's channel was a row in Messages (#2718 review) and a one-line
 * door on this page. Messages is people and agents now, and the channel is
 * the community's own room, so the hub shows its last two lines and the way
 * to its Chat tab (./project-chat.tsx), where the room is whole. The room
 * itself is the same one it always was, at the same address:
 * `#messages/app/<slug>`, or #general for Homeroom's own hub, whose channel
 * #general became — and it opens under the Communities tab with its chevron
 * back to this hub (public/js/app.js, features/messages/store.ts).
 *
 * A viewer who may not talk here (a view-public, collab-private app) gets no
 * card, for the reason the hero's old row gave: no door that refuses them.
 *
 * THE COMPOSER POSTS FROM HERE, on the card in full (Homeroom's Chat tab,
 * whose #general has no pane to mount); the hub's preview has none. Its
 * foot is a real box, not a link dressed
 * as one: what is typed goes to the room's own write route (`post_url`: the
 * app chat's REST path, or #general's conversation), which keeps every rule
 * it keeps anywhere else. A non-member's send is refused `join_required`,
 * and the platform's fetch wrapper (lib/join-required.ts) asks Join at the
 * hero and sends it again, so nothing here handles membership by hand.
 *
 * ── Island rules ───────────────────────────────────────────────────────
 *
 * The lander mounts client-side into a legacy host and has no server render,
 * so these read the shared community record (./community-card.tsx's
 * useCommunity) and draw nothing until it has answered.
 */

import { useCallback, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { ArrowUpIcon, BallotIcon, ChevronDownIcon, ChevronRightIcon } from '@/components/ui/icons';
import { agoStamp } from '../../../lib/timestamp';
import { swatchFor } from '../../messages/format';
import { CardRowView } from '../card/fold';
import { FeedMentionMenu, mentionSuggestionsPath, useMentionTypeahead } from '../card/mention-typeahead';
import type { DevWorkshopView, ListRow } from '../card/model';
import { reloadCommunity, type CommunityPayload } from './community-card';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function Avatar({ name }: { name: string }) {
  return (
    <span className="dev-ws-hub-avatar" style={{ background: swatchFor(name) }} aria-hidden="true">
      {(name || '?').charAt(0).toUpperCase()}
    </span>
  );
}

/** How many of the channel's newest lines the hub's preview shows. */
export const HUB_CHAT_LINES = 2;

/**
 * The channel: its newest messages, how many are new, and the way in.
 *
 * TWO SIZES. On the hub it is a PREVIEW (`compact`): the last two lines, one
 * line each, and Open, which is the page's own Chat tab (`onOpen`) — the
 * room whole, a tab away. In full, on Homeroom's Chat tab (#general has no
 * pane to mount there, ./project-chat.tsx), it is the newest few with the
 * composer at its foot and Open going to the room itself.
 */
export function ChannelCard({ slug, name, data, compact = false, onOpen }: {
  slug: string;
  name: string;
  data: CommunityPayload | null;
  compact?: boolean;
  /** Where the preview's Open goes: the page's Chat tab. */
  onOpen?: () => void;
}): ReactNode {
  const channel = data?.channel;
  if (!data || !channel) return null;
  const href = channel.href || `#messages/app/${encodeURIComponent(slug)}`;
  const all = channel.recent || [];
  const recent = compact ? all.slice(-HUB_CHAT_LINES) : all;
  const unread = Number(channel.unread_count) || 0;
  const open = compact && onOpen ? (
    <button type="button" className="dev-ws-hub-open un-touch-target" data-ws-channel-open="" onClick={onOpen}>
      Open
      <ChevronRightIcon className="w-3.5 h-3.5" aria-hidden="true" />
    </button>
  ) : (
    <a href={href} className="dev-ws-hub-open un-touch-target" data-ws-channel-open="">
      Open
      <ChevronRightIcon className="w-3.5 h-3.5" aria-hidden="true" />
    </a>
  );
  return (
    <section
      className={compact ? 'dev-ws-strip dev-ws-hub-channel dev-ws-hub-channel-compact' : 'dev-ws-strip dev-ws-hub-channel'}
      data-ws-channel={compact ? 'preview' : ''}
      data-ws-channel-handle={channel.handle || undefined}
    >
      <div className="dev-ws-head">
        <span className="dev-ws-head-title">Chat</span>
        {channel.handle ? <span className="dev-ws-hub-handle">#{channel.handle}</span> : null}
        <span className="dev-ws-hub-head-end">
          {unread > 0 ? (
            <span className="dev-ws-hub-new" data-ws-channel-unread={String(unread)}>
              {unread > 99 ? '99+' : unread} new
            </span>
          ) : null}
          {open}
        </span>
      </div>
      {recent.length ? (
        <ol className="dev-ws-hub-msgs" data-ws-channel-recent="">
          {recent.map((m) => {
            const when = m.created_at ? agoStamp(m.created_at) : null;
            const who = m.by || name;
            return (
              <li key={m.id} className="dev-ws-hub-msg">
                <Avatar name={who} />
                <span className="min-w-0 flex-1">
                  <span className="dev-ws-hub-msg-head">
                    <span className="dev-ws-hub-msg-by">{m.by ? `@${m.by}` : name}</span>
                    {when ? <time dateTime={m.created_at} title={when.title}>{when.text}</time> : null}
                  </span>
                  <span className="dev-ws-hub-msg-text">{m.content}</span>
                </span>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="dev-ws-week-note" data-ws-channel-empty="">Nobody has said anything here yet.</p>
      )}
      {channel.post_url && !compact ? (
        <HubComposer slug={slug} url={channel.post_url} placeholder={`Message ${channel.handle ? `#${channel.handle}` : name}…`} />
      ) : null}
    </section>
  );
}

/** The #general conversation a hub composer posts to, or null for an app's own chat. */
export function conversationIdFromPostUrl(url: string): number | null {
  const m = /^\/api\/conversations\/([1-9]\d*)\/messages$/.exec(url);
  return m ? Number(m[1]) : null;
}

/**
 * The channel card's foot: one line, sent where the room's own composer
 * sends it. A sent message clears the box and re-reads the hub, so it shows
 * up among the last few above; a refusal keeps the draft and says why.
 *
 * #3361: `@` offers people here as it does in the room itself, asked for by
 * the prefix being typed. An app's channel asks the app's list
 * (GET /api/apps/:slug/mention-suggestions?q=, which the room's own composer
 * reads whole), so a member of a large community is found by name; #general,
 * on Homeroom's own hub, asks its conversation (GET /api/conversations/:id/
 * mention-candidates), whose people are everybody and whose usernames may
 * carry hyphens (wide tokens). Either answers only a viewer who may read
 * that room.
 */
function HubComposer({ slug, url, placeholder }: { slug: string; url: string; placeholder: string }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const conversationId = conversationIdFromPostUrl(url);
  const lookup = useCallback(async (query: string): Promise<string[]> => {
    const q = encodeURIComponent(query);
    const res = await fetch(conversationId
      ? `/api/conversations/${conversationId}/mention-candidates?q=${q}&limit=8`
      : `${mentionSuggestionsPath(slug)}?q=${q}`);
    // Rate-limited: a failure, so this prefix is not remembered as empty.
    if (res.status === 429) throw new Error('rate_limited');
    if (!res.ok) return [];
    const data = await res.json().catch(() => null);
    return Array.isArray(data?.users) ? data.users.map((u: any) => String((u && u.username) || '')).filter(Boolean) : [];
  }, [conversationId, slug]);
  const mention = useMentionTypeahead({
    slug, inputRef, value: text, onChange: setText, lookup, wideTokens: !!conversationId,
  });
  const send = async (e: FormEvent) => {
    e.preventDefault();
    const content = text.trim();
    if (!content || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        // Asked and answered Not now: the question was the answer.
        if (body && body.code === 'join_required') return;
        throw new Error((body && body.error) || 'That did not send. Try again.');
      }
      setText('');
      await reloadCommunity(slug);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not send. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="dev-ws-hub-compose" data-ws-channel-compose="" onSubmit={(e) => { void send(e); }}>
      <input
        ref={inputRef}
        type="text"
        className="dev-ws-hub-compose-input"
        data-ws-channel-input=""
        aria-label={placeholder.replace(/…$/, '')}
        placeholder={placeholder}
        maxLength={4000}
        value={text}
        disabled={busy}
        onChange={(e) => { setText(e.target.value); if (error) setError(''); mention.sync(); }}
        onSelect={mention.sync}
        onFocus={mention.warm}
        onBlur={mention.close}
        onCompositionStart={mention.onCompositionStart}
        onCompositionEnd={mention.onCompositionEnd}
        // An open list owns the arrows, Enter, Tab and Escape, so Enter
        // picks the person instead of sending "@be".
        onKeyDown={(e) => { if (!e.nativeEvent.isComposing) mention.onKeyDown(e); }}
      />
      <button
        type="submit"
        className="dev-ws-hub-compose-send"
        data-ws-channel-send=""
        aria-label="Send"
        disabled={busy || !text.trim()}
      >
        <ArrowUpIcon className="w-4 h-4" aria-hidden="true" />
      </button>
      {error ? <p className="dev-ws-hub-compose-error" role="alert" data-ws-channel-error="">{error}</p> : null}
      <FeedMentionMenu
        items={mention.items}
        active={mention.active}
        below={mention.below}
        menuRef={mention.menuRef}
        onPick={mention.accept}
      />
    </form>
  );
}

/**
 * VOTES WAITING ON YOU, on the hub: one row, "2 votes waiting on you", and
 * Vote, which opens the Needs you tab (one decision per screen, as it always
 * was). The queue also carries requests nobody has claimed, which are the
 * group's to pick up rather than yours to answer, so they are not counted
 * here: a row that said 14 where two votes were owed read as a backlog with
 * your name on it.
 *
 * Only while a vote is owed. With none the hub says nothing: the Needs you
 * tab carries its own count, and a zero says nothing there either.
 */
export function NeedsCard({ queue, canPost, onOpen }: {
  queue: DevWorkshopView['queue'];
  canPost: boolean;
  onOpen: () => void;
}): ReactNode {
  const count = queue.filter((row) => row.kind === 'vote').length;
  if (!count) return null;
  return (
    <section className="dev-ws-strip dev-ws-hub-needs" data-ws-hub-needs="" data-ws-hub-needs-votes={String(count)}>
      <button type="button" className="dev-ws-hub-row dev-ws-hub-votes" onClick={onOpen} data-ws-hub-needs-open="">
        <span className="dev-ws-hub-votes-tile" aria-hidden="true">
          <BallotIcon className="dev-ws-hub-votes-glyph" />
        </span>
        <span className="dev-ws-hub-votes-text">{`${plural(count, 'vote', 'votes')} waiting on you`}</span>
        <span className="dev-ws-hub-votes-cta">Vote</span>
      </button>
      {!canPost ? (
        <p className="dev-ws-hub-needs-join" data-ws-hub-needs-join="">Join to vote on these.</p>
      ) : null}
    </section>
  );
}

/** Whether the queue holds a vote the viewer owes: the hub's Needs you door
    is drawn only then. */
export const owesVote = (queue: DevWorkshopView['queue']): boolean => queue.some((row) => row.kind === 'vote');

/** How many of your items the hub shows before "Show N more". */
export const HUB_WORK_FIRST = 2;

/**
 * YOUR WORK, on the hub: only when you have some. The first two of your
 * items as the board's own folded rows (they open in place, as they do on
 * the Workshop page), and the rest under "Show N more" right below them,
 * which unfolds the list where it is and folds it again as "Show less".
 * Newest activity first, the order the Workshop page lists them in.
 */
export function YourWorkCard({ rows, slug, canPost, openKey, onToggleRow, all, onAll }: {
  rows: ListRow[];
  slug: string;
  canPost: boolean;
  openKey: string | null;
  onToggleRow: (key: string) => void;
  /** Whether every row is out. The page holds it, so the rows it reveals
      are wired by the page's fillers like any other (see workshop.tsx). */
  all: boolean;
  onAll: () => void;
}): ReactNode {
  const cards = rows.filter((row): row is Extract<ListRow, { t: 'card' }> => row.t === 'card');
  if (!cards.length) return null;
  const rest = cards.length - HUB_WORK_FIRST;
  const shown = all ? cards : cards.slice(0, HUB_WORK_FIRST);
  return (
    <section className="dev-ws-strip dev-ws-hub-work" data-ws-mine-card="">
      <div className="dev-ws-head">
        <span className="dev-ws-head-title">Your work</span>
        <span className="dev-ws-head-n">{cards.length}</span>
      </div>
      <div className="dev-ws-lane" data-ws-lane="mine-hub">
        {shown.map((row) => (
          <CardRowView
            key={row.key}
            row={row}
            slug={slug}
            canPost={canPost}
            open={openKey === row.key}
            onToggle={() => onToggleRow(row.key)}
          />
        ))}
      </div>
      {rest > 0 ? (
        <button
          type="button"
          className="dev-ws-reveal dev-ws-hub-work-more touch-target-32"
          data-ws-mine-more=""
          aria-expanded={all}
          onClick={onAll}
        >
          <ChevronDownIcon className="dev-ws-reveal-chev" aria-hidden="true" />
          {all ? 'Show less' : `Show ${rest} more`}
        </button>
      ) : null}
    </section>
  );
}

