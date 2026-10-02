/**
 * The project hub's own cards. The hub is the first of the project page's
 * four tabs (Hub, Discussion, Needs you, Workshop: ./project-band.tsx), and
 * it answers "what is new, what is owed, what are people saying, what is
 * mine" itself. Under the hero (./community-card.tsx), in the order agreed
 * in #852:
 *
 *   the since-your-last-visit summary (./since-summary-card.tsx), NEEDS YOU
 *   when a vote is owed, the DISCUSSION's last two messages, YOUR WORK when
 *   you have some, and Start a new change.
 *
 * Your work is the first two of your items with the rest a press away IN
 * PLACE, because a list you came to the hub to glance at should not send
 * you to another page to see its third row. Needs you and the discussion
 * open their tabs; the Workshop door went with the Workshop becoming a tab.
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
 * the community's own room, its Discussion, so the hub shows its last two
 * messages and the way to the Discussion tab (./project-discussion.tsx),
 * where the room is whole. The room itself is the same one it always was,
 * at the same address —
 * `#messages/app/<slug>`, or #general for Homeroom's own hub, whose channel
 * #general became — and it opens under the Communities tab with its chevron
 * back to this hub (public/js/app.js, features/messages/store.ts).
 *
 * A viewer who may not talk here (a view-public, collab-private app) gets no
 * card, for the reason the hero's old row gave: no door that refuses them.
 *
 * THE COMPOSER POSTS FROM HERE, on the card in full (Homeroom's Discussion
 * tab: #general has no pane to mount there); the hub's preview has none. Its
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

import { ArrowUpIcon, ChevronDownIcon, ChevronRightIcon } from '@/components/ui/icons';
import { agoStamp } from '../../../lib/timestamp';
import { swatchFor } from '../../messages/format';
import { CardRowView } from '../card/fold';
import { FeedMentionMenu, mentionSuggestionsPath, useMentionTypeahead } from '../card/mention-typeahead';
import type { DevWorkshopView, ListRow } from '../card/model';
import { isNeedsSeen, needsRowKey, useNeedsSeen } from '../../workshop/needs-seen';
import { reloadCommunity, type CommunityPayload } from './community-card';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function Avatar({ name }: { name: string }) {
  return (
    <span className="dev-ws-hub-avatar" style={{ background: swatchFor(name) }} aria-hidden="true">
      {(name || '?').charAt(0).toUpperCase()}
    </span>
  );
}

/** How many of the discussion's newest messages the hub's preview shows. */
export const HUB_DISCUSSION_LINES = 2;

/**
 * Unread messages the preview does not show: the newest are the ones it
 * shows, so they are the unread ones first.
 */
export function moreUnread(unread: number, shown: number): number {
  return Math.max(0, (Number(unread) || 0) - Math.max(0, shown));
}

/**
 * The discussion: its newest messages, how many are new, and the way in.
 *
 * TWO SIZES, one look. On the hub it is a PREVIEW (`compact`): the last two
 * messages and no composer, with how many more are unread above them (since
 * you last opened the discussion), and Open is the page's own Discussion tab
 * (`onOpen`). In full, on Homeroom's Discussion tab (#general has no pane to
 * mount there, ./project-discussion.tsx), it is the newest few with the
 * composer at its foot and Open going to the room itself.
 */
export function ChannelCard({ slug, name, data, compact = false, onOpen }: {
  slug: string;
  name: string;
  data: CommunityPayload | null;
  compact?: boolean;
  /** Where the preview's Open (and its unread line) goes: the Discussion tab. */
  onOpen?: () => void;
}): ReactNode {
  const channel = data?.channel;
  if (!data || !channel) return null;
  const href = channel.href || `#messages/app/${encodeURIComponent(slug)}`;
  const all = channel.recent || [];
  const recent = compact ? all.slice(-HUB_DISCUSSION_LINES) : all;
  const unread = Number(channel.unread_count) || 0;
  const more = compact ? moreUnread(unread, recent.length) : 0;
  const toTab = compact && !!onOpen;
  return (
    <section
      className={compact ? 'dev-ws-strip dev-ws-hub-channel dev-ws-hub-channel-preview' : 'dev-ws-strip dev-ws-hub-channel'}
      data-ws-channel={compact ? 'preview' : ''}
      data-ws-channel-handle={channel.handle || undefined}
    >
      <div className="dev-ws-head">
        <span className="dev-ws-head-title">Discussion</span>
        {channel.handle ? <span className="dev-ws-hub-handle">#{channel.handle}</span> : null}
        <span className="dev-ws-hub-head-end">
          {unread > 0 && !compact ? (
            <span className="dev-ws-hub-new" data-ws-channel-unread={String(unread)}>
              {unread > 99 ? '99+' : unread} new
            </span>
          ) : null}
          {toTab ? (
            <button type="button" className="dev-ws-hub-open un-touch-target" data-ws-channel-open="" onClick={onOpen}>
              Open
              <ChevronRightIcon className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          ) : (
            <a href={href} className="dev-ws-hub-open un-touch-target" data-ws-channel-open="">
              Open
              <ChevronRightIcon className="w-3.5 h-3.5" aria-hidden="true" />
            </a>
          )}
        </span>
      </div>
      {more > 0 ? (
        <button
          type="button"
          className="dev-ws-hub-more-unread un-touch-target"
          data-ws-channel-more-unread={String(more)}
          onClick={onOpen}
        >
          {`${more > 99 ? '99+' : more} more unread ${more === 1 ? 'message' : 'messages'}`}
        </button>
      ) : null}
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
 * A reel, drawn small: a phone-shaped card with its progress segments, a
 * second card peeking out behind it. Needs you is a feed of one decision
 * per screen, so its door previews that shape rather than an icon.
 * Decoration only; the row's words are its name.
 */
export function ReelThumb(): ReactNode {
  return (
    <span className="dev-ws-reel" aria-hidden="true">
      <span className="dev-ws-reel-back" />
      <span className="dev-ws-reel-front">
        <span className="dev-ws-reel-bars"><span /><span /><span /></span>
        <span className="dev-ws-reel-line" />
        <span className="dev-ws-reel-pic" />
        <span className="dev-ws-reel-line dev-ws-reel-line-short" />
      </span>
    </span>
  );
}

/**
 * What is waiting on you: the votes you owe, the first of them and how many
 * more, opening the queue itself — one decision per screen, as it always
 * was. The queue also carries requests nobody has claimed, which are the
 * group's to pick up rather than yours to answer, so they are not counted
 * here: a card that said 14 where two votes were owed read as a backlog
 * with your name on it.
 *
 * A DOOR to the Needs you tab, and only while a vote is owed (#3408): with
 * none, the lander draws NothingToVote instead, one quiet line rather than
 * a card.
 *
 * #3526: THE COUNT IS WHAT YOU HAVE NOT SEEN. A vote swiped past in the feed
 * unanswered is left out of it, as the band's tab count leaves it out
 * (../../workshop/needs-seen.ts), and the first title is the first vote you
 * have not seen. The door stays while any vote is owed, seen or not: the
 * skipped ones are still there to vote on, and with nothing new it says how
 * many of those there are instead of a number to act on.
 */
export function NeedsCard({ queue, slug, canPost, onOpen }: {
  queue: DevWorkshopView['queue'];
  /** Whose votes these are, for the ones passed over. */
  slug?: string;
  canPost: boolean;
  onOpen: () => void;
}): ReactNode {
  useNeedsSeen();
  const votes = queue.filter((row) => row.kind === 'vote');
  const fresh = votes.filter((row) => !isNeedsSeen(slug, needsRowKey(row)));
  const skipped = votes.length - fresh.length;
  const first = fresh.find((row) => row.t === 'card') || null;
  const count = fresh.length;
  const title = first && first.t === 'card' ? first.card.title.text || first.card.title.title : '';
  return (
    <section className="dev-ws-strip dev-ws-hub-needs" data-ws-hub-needs="" data-ws-hub-needs-votes={String(count)}>
      <button type="button" className="dev-ws-hub-row dev-ws-hub-door" onClick={onOpen} data-ws-hub-needs-open="">
        <ReelThumb />
        <span className="dev-ws-hub-door-text">
          <span className="dev-ws-head">
            <span className="dev-ws-head-title">Needs you</span>
            {count ? <span className="dev-ws-head-n">{count} to vote</span> : null}
          </span>
          {count && title ? (
            <span className="dev-ws-hub-needs-first">
              <span className="dev-ws-hub-needs-title">{title}</span>
              <span className="dev-ws-hub-needs-sub">
                {first && first.who ? `from @${first.who}` : ''}
                {first && first.who && count > 1 ? ' · ' : ''}
                {count > 1 ? `and ${count - 1} more` : ''}
              </span>
            </span>
          ) : skipped ? (
            <span className="dev-ws-hub-needs-first">
              <span className="dev-ws-hub-needs-sub" data-ws-hub-needs-skipped="">
                {`${plural(skipped, 'vote', 'votes')} you skipped ${skipped === 1 ? 'is' : 'are'} still open`}
              </span>
            </span>
          ) : null}
        </span>
        <ChevronRightIcon className="dev-ws-hub-chev" aria-hidden="true" />
      </button>
      {count && !canPost ? (
        <p className="dev-ws-hub-needs-join" data-ws-hub-needs-join="">Join to vote on these.</p>
      ) : null}
    </section>
  );
}

/** Whether the queue holds a vote the viewer owes: the hub's Needs you door
    is drawn only then. */
export const owesVote = (queue: DevWorkshopView['queue']): boolean => queue.some((row) => row.kind === 'vote');

/**
 * NO VOTE OWED (#3408): in the Needs you card's place, one quiet line that
 * says so, instead of a card whose whole content was that nothing waits.
 * Requests nobody has picked up are still the Needs you page's rows, so when
 * there are some the line names them, and that phrase is the way in.
 */
export function NothingToVote({ queue, onOpen }: {
  queue: DevWorkshopView['queue'];
  onOpen: () => void;
}): ReactNode {
  const claims = queue.filter((row) => row.kind !== 'vote').length;
  return (
    <p className="dev-ws-week-note" data-ws-hub-needs-none="">
      {claims ? 'Nothing more to vote on · ' : 'Nothing more to vote on.'}
      {claims ? (
        <button type="button" className="dev-ws-link un-touch-target" onClick={onOpen} data-ws-hub-needs-requests="">
          {`${plural(claims, 'request', 'requests')} nobody has picked up`}
        </button>
      ) : null}
    </p>
  );
}

/** How many of your items the hub shows before "Show N more". */
export const HUB_WORK_FIRST = 2;

/**
 * YOUR WORK, on the hub. The first two of your items as the board's own
 * folded rows (they open in place, as they do on the Workshop page), and the
 * rest under "Show N more" right below them, which unfolds the list where it
 * is and folds it again as "Show less". Newest activity first, the order the
 * Workshop page lists them in.
 *
 * WITH NOTHING IN PROGRESS it stays, and says so (#3489): it used to leave
 * the hub, so the place your work appears moved with your workload. The
 * page draws it for a signed-in viewer only (`mine.viewer`), as the Workshop
 * page's strip is.
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
  if (!cards.length) {
    return (
      <section className="dev-ws-strip dev-ws-hub-work" data-ws-mine-card="">
        <div className="dev-ws-head">
          <span className="dev-ws-head-title">Your work</span>
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400" data-ws-mine-empty="">No work in progress.</p>
      </section>
    );
  }
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
