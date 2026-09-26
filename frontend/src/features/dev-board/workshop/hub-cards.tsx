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
 * THE COMPOSER POSTS FROM HERE. Its foot is a real box, not a link dressed
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

import { useState, type FormEvent, type ReactNode } from 'react';

import { ArrowUpIcon, ChevronRightIcon } from '@/components/ui/icons';
import { agoStamp } from '../../../lib/timestamp';
import { swatchFor } from '../../messages/format';
import type { DevWorkshopView } from '../card/model';
import { reloadCommunity, type CommunityPayload } from './community-card';

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
      {channel.post_url ? (
        <HubComposer slug={slug} url={channel.post_url} placeholder={`Message ${channel.handle ? `#${channel.handle}` : name}…`} />
      ) : null}
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
 * The channel card's foot: one line, sent where the room's own composer
 * sends it. A sent message clears the box and re-reads the hub, so it shows
 * up among the last few above; a refusal keeps the draft and says why.
 */
function HubComposer({ slug, url, placeholder }: { slug: string; url: string; placeholder: string }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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
        type="text"
        className="dev-ws-hub-compose-input"
        data-ws-channel-input=""
        aria-label={placeholder.replace(/…$/, '')}
        placeholder={placeholder}
        maxLength={4000}
        value={text}
        disabled={busy}
        onChange={(e) => { setText(e.target.value); if (error) setError(''); }}
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
    </form>
  );
}

/**
 * What is waiting on you: the votes you owe, the first of them and how many
 * more, opening the queue itself — one decision per screen, as it always
 * was. The queue also carries requests nobody has claimed, which are the
 * group's to pick up rather than yours to answer, so they are not counted
 * here: a card that said 14 where two votes were owed read as a backlog
 * with your name on it. They are named under it when they are all there is.
 */
export function NeedsCard({ queue, canPost, onOpen }: {
  queue: DevWorkshopView['queue'];
  canPost: boolean;
  onOpen: () => void;
}): ReactNode {
  const votes = queue.filter((row) => row.kind === 'vote');
  const claims = queue.length - votes.length;
  const first = votes.find((row) => row.t === 'card') || null;
  const count = votes.length;
  const title = first && first.t === 'card' ? first.card.title.text || first.card.title.title : '';
  return (
    <section className="dev-ws-strip dev-ws-hub-needs" data-ws-hub-needs="" data-ws-hub-needs-votes={String(count)}>
      <button type="button" className="dev-ws-hub-row" onClick={onOpen} data-ws-hub-needs-open="" disabled={!queue.length}>
        <span className="dev-ws-head">
          <span className="dev-ws-head-title">Needs you</span>
          {count ? <span className="dev-ws-head-n">{count} to vote</span> : null}
          {queue.length ? <ChevronRightIcon className="dev-ws-hub-chev" aria-hidden="true" /> : null}
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
          <span className="dev-ws-week-note" data-ws-hub-needs-none="">
            {claims
              ? `No votes owed. ${plural(claims, 'request', 'requests')} nobody has picked up.`
              : 'Nothing is waiting on you.'}
          </span>
        )}
      </button>
      {count && !canPost ? (
        <p className="dev-ws-hub-needs-join" data-ws-hub-needs-join="">Join to vote on these.</p>
      ) : null}
    </section>
  );
}

/**
 * The last fourteen days as fourteen bars: how many different people took
 * part each day (said something, started a change, voted). Heights are
 * relative to the busiest day; a quiet day keeps a sliver so the fortnight
 * reads as a row of days rather than a gap. Nothing is drawn until the read
 * carries the days, and a fortnight in which nobody did anything is one
 * sentence rather than fourteen slivers.
 */
function ActivityTrend({ days }: { days: Array<{ day: string; n: number }> }) {
  if (days.length < 2) return null;
  const peak = Math.max(0, ...days.map((d) => Number(d.n) || 0));
  const label = (d: { day: string; n: number }) => {
    const when = new Date(`${d.day}T12:00:00`);
    const date = Number.isNaN(when.getTime()) ? d.day
      : when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `${date}: ${plural(Number(d.n) || 0, 'person', 'people')}`;
  };
  if (!peak) {
    return <p className="dev-ws-week-note" data-ws-members-trend="" data-ws-trend-empty="">Nobody has been around in the last 14 days.</p>;
  }
  return (
    <figure className="dev-ws-hub-trend" data-ws-members-trend="">
      <div className="dev-ws-hub-trend-bars" role="img" aria-label={`People taking part each day, last ${days.length} days: ${days.map((d) => Number(d.n) || 0).join(', ')}`}>
        {days.map((d) => {
          const n = Number(d.n) || 0;
          return (
            <span
              key={d.day}
              className={n ? 'dev-ws-hub-trend-bar' : 'dev-ws-hub-trend-bar dev-ws-hub-trend-bar-quiet'}
              style={{ height: `${n ? Math.max(12, Math.round((n / peak) * 100)) : 6}%` }}
              title={label(d)}
            />
          );
        })}
      </div>
      <figcaption className="dev-ws-hub-trend-cap">
        <span>Last 14 days</span>
        <span>Today</span>
      </figcaption>
    </figure>
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
      <ActivityTrend days={data.activity?.daily || []} />
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
