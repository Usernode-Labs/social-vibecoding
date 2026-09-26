/**
 * The project hub's own cards: its channel, what needs you, and its members
 * and activity. They sit on the hub tab of a project's page
 * (./workshop.tsx), under the hero, in the order the hub was agreed in:
 *
 *   the CHANNEL, then NEEDS YOU, then MEMBERS & ACTIVITY, with Since your
 *   last visit at the foot of the tab (drawn by the lander itself).
 *
 * ── The channel lives here now ─────────────────────────────────────────
 *
 * A project's channel was a row in Messages (#2718 review) and a one-line
 * door on this page. Messages is people and agents now, and the channel is
 * the community's own room, so the hub shows its last few messages and a way
 * in. The room itself is the same one it always was, at the same address —
 * `#messages/app/<slug>`, or #general for Homeroom's own hub, whose channel
 * #general became — and it opens under the Communities tab with its chevron
 * back to this hub (public/js/app.js, features/messages/store.ts).
 *
 * A viewer who may not talk here (a view-public, collab-private app) gets no
 * card, for the reason the hero's old row gave: no door that refuses them.
 *
 * ── Island rules ───────────────────────────────────────────────────────
 *
 * The lander mounts client-side into a legacy host and has no server render,
 * so these read the shared community record (./community-card.tsx's
 * useCommunity) and draw nothing until it has answered.
 */

import type { ReactNode } from 'react';

import { ChevronRightIcon } from '@/components/ui/icons';
import { agoStamp } from '../../../lib/timestamp';
import { swatchFor } from '../../messages/format';
import type { DevWorkshopView } from '../card/model';
import type { CommunityPayload } from './community-card';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function Avatar({ name }: { name: string }) {
  return (
    <span className="dev-ws-hub-avatar" style={{ background: swatchFor(name) }} aria-hidden="true">
      {(name || '?').charAt(0).toUpperCase()}
    </span>
  );
}

/**
 * The channel: its newest messages, how many are new, and the way in.
 * Everything on it is a link to the room, including the composer-shaped row
 * at its foot, which is where a person looking to say something taps.
 */
export function ChannelCard({ slug, name, data }: {
  slug: string;
  name: string;
  data: CommunityPayload | null;
}): ReactNode {
  const channel = data?.channel;
  if (!data || !channel) return null;
  const href = channel.href || `#messages/app/${encodeURIComponent(slug)}`;
  const recent = channel.recent || [];
  const unread = Number(channel.unread_count) || 0;
  return (
    <section className="dev-ws-strip dev-ws-hub-channel" data-ws-channel="" data-ws-channel-handle={channel.handle || undefined}>
      <div className="dev-ws-head">
        <span className="dev-ws-head-title">Channel</span>
        {channel.handle ? <span className="dev-ws-hub-handle">#{channel.handle}</span> : null}
        <span className="dev-ws-hub-head-end">
          {unread > 0 ? (
            <span className="dev-ws-hub-new" data-ws-channel-unread={String(unread)}>
              {unread > 99 ? '99+' : unread} new
            </span>
          ) : null}
          <a href={href} className="dev-ws-hub-open un-touch-target" data-ws-channel-open="">
            Open
            <ChevronRightIcon className="w-3.5 h-3.5" aria-hidden="true" />
          </a>
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
      <a href={href} className="dev-ws-hub-compose" data-ws-channel-compose="">
        Message {name}…
      </a>
      {channel.archive_href ? (
        <a href={channel.archive_href} className="dev-ws-hub-archive" data-ws-channel-archive="">
          Earlier project discussion, read-only
          <ChevronRightIcon className="w-3.5 h-3.5" aria-hidden="true" />
        </a>
      ) : null}
    </section>
  );
}

/**
 * What is waiting on you: the Needs-you queue's first item and how many more,
 * opening the queue itself — one decision per screen, as it always was.
 */
export function NeedsCard({ queue, canPost, onOpen }: {
  queue: DevWorkshopView['queue'];
  canPost: boolean;
  onOpen: () => void;
}): ReactNode {
  const first = queue.find((row) => row.t === 'card') || null;
  const count = queue.length;
  const title = first && first.t === 'card' ? first.card.title.text || first.card.title.title : '';
  return (
    <section className="dev-ws-strip dev-ws-hub-needs" data-ws-hub-needs="">
      <button type="button" className="dev-ws-hub-row" onClick={onOpen} data-ws-hub-needs-open="" disabled={!count}>
        <span className="dev-ws-head">
          <span className="dev-ws-head-title">Needs you</span>
          {count ? <span className="dev-ws-head-n">{count}</span> : null}
          {count ? <ChevronRightIcon className="dev-ws-hub-chev" aria-hidden="true" /> : null}
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
        ) : (
          <span className="dev-ws-week-note" data-ws-hub-needs-none="">Nothing is waiting on you.</span>
        )}
      </button>
      {count && !canPost ? (
        <p className="dev-ws-hub-needs-join" data-ws-hub-needs-join="">Join to vote on these.</p>
      ) : null}
    </section>
  );
}

/** Members & activity: how many, who was around this week, what shipped. */
export function MembersCard({ data }: { data: CommunityPayload | null }): ReactNode {
  if (!data || data.audience === 'solo') return null;
  const members = Number(data.member_count) || 0;
  const active = Number(data.activity?.active_week) || 0;
  const shipped = Number(data.activity?.shipped_month) || 0;
  const cells = [
    { key: 'members', n: members, label: members === 1 ? 'member' : 'members' },
    { key: 'active', n: active, label: 'active this week' },
    { key: 'shipped', n: shipped, label: 'shipped this month', tone: shipped ? 'good' : undefined },
  ];
  return (
    <section className="dev-ws-strip dev-ws-hub-members" data-ws-members="">
      <div className="dev-ws-head">
        <span className="dev-ws-head-title">Members &amp; activity</span>
      </div>
      <div className="dev-ws-dash dev-ws-dash-3" data-ws-members-stats="">
        {cells.map((c) => (
          <span
            key={c.key}
            className={c.tone ? `dev-ws-dash-cell dev-ws-dash-cell-${c.tone}` : 'dev-ws-dash-cell'}
            data-ws-members-cell={c.key}
          >
            <b>{c.n}</b>
            <span className="dev-ws-dash-label">
              {c.tone ? <i className={`dev-ws-dash-dot dev-ws-dash-dot-${c.tone}`} aria-hidden="true" /> : null}
              <span>{c.label}</span>
            </span>
          </span>
        ))}
      </div>
      {data.members && data.members.length ? (
        <div className="dev-ws-hub-people" aria-label={plural(members, 'member', 'members')}>
          {data.members.map((m) => (
            <span key={m.id} className="dev-ws-hub-person" title={`@${m.username}`}>
              <Avatar name={m.username} />
            </span>
          ))}
          {members > data.members.length ? (
            <span className="dev-ws-hub-more">+{members - data.members.length}</span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
