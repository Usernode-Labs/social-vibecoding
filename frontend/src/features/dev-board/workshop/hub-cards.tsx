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
 * A project Homeroom bot is still building gets its FIRST VERSION card
 * first, right under the hero: where the build stands, and the way to the
 * bot's chat when the bot waits on its maker (FirstVersionCard below).
 *
 * ── A project nobody else is in ────────────────────────────────────────
 *
 * Evan, 5 Oct 2026, on a brand-new project of his own: "The initial hub if
 * no one has joined is really sad." It read "Just you", "Nothing more to
 * vote on." and "Your work · No work in progress." Nobody else can put a
 * vote up there, so the vote line says nothing (`alone` in NothingToVote),
 * and an empty Your work leaves the hub while something else on it already
 * says what is next (hubWorkEmpty). A project with people in it keeps both
 * as they were.
 *
 * Your work is the first two of your items with the rest a press away IN
 * PLACE, because a list you came to the hub to glance at should not send
 * you to another page to see its third row. Needs you and the discussion
 * open their tabs; the Workshop door went with the Workshop becoming a tab.
 *
 * Members & activity was the third card. It is the hero's now (#3268,
 * ./community-card.tsx HeroPulse): who is here and how
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

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { ArrowUpIcon, ChevronDownIcon, ChevronRightIcon } from '@/components/ui/icons';
import { agoStamp } from '../../../lib/timestamp';
import { type BuildLineState, buildLineOf } from '../../first-session/build-line';
import { useTourRunning } from '../../first-session/tour-running';
import { ThumbRow } from '../../first-session/sketch-card';
import { swatchFor } from '../../messages/format';
import { open as openConversation, openBot } from '../../messages/store';
import { CardRowView } from '../card/fold';
import { FeedMentionMenu, mentionSuggestionsPath, useMentionTypeahead } from '../card/mention-typeahead';
import type { DevWorkshopView, ListRow } from '../card/model';
import { isNeedsSeen, needsRowKey, useNeedsSeen } from '../../workshop/needs-seen';
import { reloadCommunity, type CommunityPayload, type HubFirstVersion } from './community-card';

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
      ) : toTab ? (
        // #4045 (the owner, 7 Oct): the hub always shows its discussion, a
        // new community's too. With nothing said yet the preview asks for
        // the first word, and opens the Discussion tab.
        <button type="button" className="dev-ws-hub-say-hi un-touch-target" data-ws-channel-empty="" onClick={onOpen}>
          {`Say hi to ${name}`}
        </button>
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
        // The field keeps focus through the press, so the keyboard and the
        // composer stay where the tap landed (lib/keyboard-open.ts). The
        // press still closes the people list, as the blur did.
        onMouseDown={(event) => { event.preventDefault(); mention.close(); }}
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

/** How often the hub reads the project again while its first version is being built. */
export const FIRST_VERSION_POLL_MS = 15000;

/**
 * #4053: the build line, the server's for this viewer (`line`, from
 * homeroom-bot-dm.js firstVersionState), so the hub says exactly what the
 * made screen and the App tab say: "Building it", never "Step 4 of 7: Build
 * it", which read as an instruction to the person looking at it. Step
 * numbers stay in Homeroom bot's chat.
 */
export function firstVersionLine(fv: HubFirstVersion): BuildLineState {
  return buildLineOf(fv.line) || (fv.ready ? 'ready' : 'planning');
}

/**
 * The one thing the card offers, for whoever reads it (#4045), or null:
 *
 *   review    its plan waits for their Build it      the person who started it
 *   answer    Homeroom bot asked them a question     the person who started it
 *   see       its plan waits, read only (#4074)      a member who did not start it
 *   try       built and up for approval              everyone
 *   open      live, in the project's first week      everyone
 *
 * A card with a button hides its build line (the owner, 6 Oct 2026): "Your
 * plan is ready to review" over "Review the plan" said one thing twice, so
 * the button says it and the app's own line sits under its name. See the
 * plan is a quiet link beside the line, not a button, so "Planning it"
 * stays.
 */
export type FirstVersionAction = 'review' | 'answer' | 'see' | 'try' | 'open';

export function firstVersionAction(fv: HubFirstVersion): FirstVersionAction | null {
  const line = firstVersionLine(fv);
  if (line === 'live') return 'open';
  if (fv.ready) return fv.session_id ? 'try' : null;
  if (fv.waits_on === 'plan') return 'review';
  if (fv.waits_on === 'question') return 'answer';
  if (fv.plan && fv.plan.bullets && fv.plan.bullets.length) return 'see';
  return null;
}

const ACTION_WORDS: Record<Exclude<FirstVersionAction, 'see'>, string> = {
  review: 'Review the plan',
  answer: 'Answer the question',
  try: 'Try it',
  open: 'Open app',
};

/**
 * FIRST VERSION (#4045): the project's thumbnail drawn small, its icon on
 * its colour and its name (../../first-session/sketch-card.tsx ThumbRow),
 * with ONE more line and at most one thing to do (firstVersionAction). With
 * nothing to tap, the line is the build line the made screen and the App
 * tab draw ("Building it", ../../first-session/build-line.tsx), the
 * server's for this viewer (GET /api/apps/:slug/community `first_version`).
 * With a button, the button says where it is and the card has no line: the
 * project's own description sits once, under the hub's people row (the
 * owner, 8 Oct 2026).
 *
 *   Review the plan, Answer the question   open the maker's chat with
 *                                          Homeroom bot, where it is answered
 *   See the plan                           the plan, read only (./plan-page.tsx)
 *   Try it                                 the version to try, as its message
 *                                          in the chat opens it
 *   Open app                               the app, once it is live
 *
 * No "First version" heading, no step count and no note under it: the
 * thumbnail is what it is, and one line says where it is. Nothing for a
 * project the bot is not building, or once its first version is live and
 * the project's first week is over.
 *
 * While the first-session tour runs (../../first-session/tour-running.ts)
 * there is no Review the plan: the card shows the build line, "Homeroom bot
 * is working on it", and the tour's last card is what names the plan
 * (requests #4391, #4393). After the tour, it is as above.
 *
 * No event marks each step, so while the card is on screen the record is
 * read again every FIRST_VERSION_POLL_MS, as the App tab and the made screen
 * read theirs (AppView._recheckFirstVersion, made.tsx).
 */
export function FirstVersionCard({ slug, data, emoji = null, onSeePlan }: {
  slug: string;
  data: CommunityPayload | null;
  /** The project's icon, as the page already knows it (improveStore). */
  emoji?: string | null;
  /** Opens the plan, read only (./workshop.tsx's 'plan' page). */
  onSeePlan?: () => void;
}): ReactNode {
  const fv = data?.first_version || null;
  const ref = useRef<HTMLElement | null>(null);
  const building = !!fv && fv.line !== 'live';
  useEffect(() => {
    if (!building || !slug) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (!ref.current || !ref.current.getClientRects().length) return;
      void reloadCommunity(slug);
    }, FIRST_VERSION_POLL_MS);
    return () => window.clearInterval(timer);
  }, [building, slug]);
  // While the first-session tour runs, its last card is what names the plan
  // (../../first-session/tour-running.ts): no Review the plan here, only the
  // build line saying the bot is on it.
  const touring = useTourRunning();
  if (!fv) return null;
  const asked = firstVersionAction(fv);
  const held = touring && asked === 'review';
  const line: BuildLineState = held ? 'working' : firstVersionLine(fv);
  const action = held ? null : asked;
  const press = () => {
    if (action === 'review' || action === 'answer') {
      if (fv.conversation_id) openConversation(fv.conversation_id);
      else void openBot();
    } else if (action === 'try' && fv.session_id) {
      (window as any).AppView?.tryFirstVersion?.(slug, fv.session_id);
    } else if (action === 'open') {
      (window as any).App?.openAppTab?.(slug, 'app');
    }
  };
  const button = action && action !== 'see';
  return (
    <section ref={ref} className="dev-ws-strip dev-ws-hub-first" data-ws-first-version={line}>
      <div className="dev-ws-hub-first-row">
        <ThumbRow
          name={data?.name || slug}
          colorKey={slug}
          emoji={emoji}
          line={button ? null : line}
        />
        {action === 'see' ? (
          <button
            type="button"
            className="dev-ws-hub-first-see un-touch-target"
            data-ws-first-version-plan=""
            onClick={onSeePlan}
          >
            See the plan
          </button>
        ) : null}
      </div>
      {button && action ? (
        action === 'open' ? (
          <button type="button" className="dev-ws-open-app dev-ws-hub-first-open" data-ws-first-version-action="open" onClick={press}>
            {ACTION_WORDS.open}
          </button>
        ) : (
          <Button
            type="button"
            layout="full"
            variant="pillAccent"
            size="pill"
            ink="solid"
            data-ws-first-version-action={action}
            onClick={press}
          >
            {ACTION_WORDS[action]}
          </Button>
        )
      ) : null}
    </section>
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
 *
 * ON A PROJECT NOBODY ELSE IS IN (`alone`) there is nobody to put a vote up,
 * so "Nothing more to vote on." is a zero, and a zero says nothing: the line
 * is not drawn, or it is the requests alone when there are some.
 */
export function NothingToVote({ queue, onOpen, alone = false }: {
  queue: DevWorkshopView['queue'];
  onOpen: () => void;
  /** Nobody but one person is in the project (hubAlone), or it is in its
      first week (#4045), when nothing has been up for a vote yet: the
      zero says nothing either way. */
  alone?: boolean;
}): ReactNode {
  const claims = queue.filter((row) => row.kind !== 'vote').length;
  if (alone && !claims) return null;
  return (
    <p className="dev-ws-week-note" data-ws-hub-needs-none="">
      {alone ? null : claims ? 'Nothing more to vote on · ' : 'Nothing more to vote on.'}
      {claims ? (
        <button type="button" className="dev-ws-link un-touch-target" onClick={onOpen} data-ws-hub-needs-requests="">
          {`${plural(claims, 'request', 'requests')} nobody has picked up`}
        </button>
      ) : null}
    </p>
  );
}

/**
 * Whether nobody but one person is in the project: Just you, or a
 * community whose one member is still alone in it. Not before the read has
 * answered, so nothing is taken off the hub on a guess.
 */
export function hubAlone(data: Pick<CommunityPayload, 'audience' | 'member_count'> | null | undefined): boolean {
  return !!data && (data.audience === 'solo' || (Number(data.member_count) || 0) <= 1);
}

/**
 * What the hub's Your work says with nothing in progress, or null when it
 * leaves the hub.
 *
 *   'plain'  "No work in progress." (#3489): a project with people in it,
 *            where the place your work appears stays put
 *   null     a project in its first week (#4045), or one nobody else is
 *            in while something else on the hub already says what is
 *            next: its first version being built, the start-here banner,
 *            or nothing a read-only viewer can start
 *   'bot'    nobody else is in it and Homeroom bot builds here for you: to
 *            change something, tell it (`mine.bot`, AppView._botDoor)
 *   'menu'   nobody else is in it: the ⋯ is where a change is asked for
 */
export type WorkEmpty = 'plain' | 'bot' | 'menu' | null;

export function hubWorkEmpty({ alone, building, startHere, readOnly, bot, firstWeek = false }: {
  alone: boolean;
  building: boolean;
  startHere: boolean;
  readOnly: boolean;
  bot: boolean;
  /** #4045: in a project's first week an empty Your work is left out:
      it shows once you have some. */
  firstWeek?: boolean;
}): WorkEmpty {
  if (firstWeek) return null;
  if (!alone) return 'plain';
  if (building || startHere || readOnly) return null;
  return bot ? 'bot' : 'menu';
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
 *
 * On a project nobody else is in, "No work in progress." under its own
 * heading was the saddest block on a new project's hub. There it says how to
 * change something instead (`empty`, hubWorkEmpty), or the page leaves it
 * out while something else on the hub already says what is next.
 */
export function YourWorkCard({ rows, slug, canPost, openKey, onToggleRow, all, onAll, empty = 'plain' }: {
  rows: ListRow[];
  slug: string;
  canPost: boolean;
  openKey: string | null;
  onToggleRow: (key: string) => void;
  /** Whether every row is out. The page holds it, so the rows it reveals
      are wired by the page's fillers like any other (see workshop.tsx). */
  all: boolean;
  onAll: () => void;
  /** What it says with nothing in progress (hubWorkEmpty). */
  empty?: WorkEmpty;
}): ReactNode {
  const cards = rows.filter((row): row is Extract<ListRow, { t: 'card' }> => row.t === 'card');
  if (!cards.length) {
    if (!empty) return null;
    return (
      <section className="dev-ws-strip dev-ws-hub-work" data-ws-mine-card="">
        <div className="dev-ws-head">
          <span className="dev-ws-head-title">Your work</span>
        </div>
        {empty === 'bot' ? (
          <>
            <p className="text-xs text-zinc-500 dark:text-zinc-400" data-ws-mine-empty="bot">
              Nothing in progress. To change something, tell Homeroom bot.
            </p>
            <Button
              type="button"
              variant="pillNeutral"
              size="sm"
              ink="neutral"
              className="self-start"
              data-ws-mine-bot=""
              onClick={() => { void openBot(); }}
            >
              Go to chat
            </Button>
          </>
        ) : empty === 'menu' ? (
          <p className="text-xs text-zinc-500 dark:text-zinc-400" data-ws-mine-empty="menu">
            {'Nothing in progress. Press '}
            <span className="font-medium text-violet-700 dark:text-violet-400">⋯</span>
            {' to suggest an improvement.'}
          </p>
        ) : (
          <p className="text-xs text-zinc-500 dark:text-zinc-400" data-ws-mine-empty="">No work in progress.</p>
        )}
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
