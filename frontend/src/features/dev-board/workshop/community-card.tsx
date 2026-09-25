/**
 * The community card: who a project is for, who is in it, how a change gets
 * in, and where they talk — on that project's own Workshop page.
 *
 * ── Why it is here ─────────────────────────────────────────────────────
 *
 * Every project belongs to one community (src/services/communities.js), and
 * while the two are one-to-one the community is drawn AS its project: there
 * is no separate community page, so the facts that are the community's
 * rather than the code's live on the page the Workshop tab's row opens. Four
 * of them, one row each:
 *
 *   WHO IT IS FOR. The audience, in the words people see — Community, Group,
 *   Just you — and the member count. "Community", not "public": the label is
 *   the same one the Workshop tab heads its section with, so the row you
 *   tapped and the page you landed on agree about what this is.
 *
 *   WHO IS IN IT. A few names, and the door to Members & approvals, which is
 *   where the roster, invites and approvers are managed. This card lists; it
 *   does not manage — that dialog already does, and a second copy of its
 *   controls is a copy that drifts.
 *
 *   HOW A CHANGE GETS IN. The approval rule, read from the server rather
 *   than restated here (GET /api/apps/:slug/community, `approval`): the
 *   headline number an unopposed change needs. It is a headline and it says
 *   so — "to merge", not "exactly" — because opposition raises it and the
 *   quiet-week path can merge below it (services/active-users.js).
 *
 *   WHERE THEY TALK. The channel: the app's general discussion, which the
 *   Messages list carried as one row per app until this card took it over
 *   (see features/messages/inbox.ts). Its address is unchanged —
 *   `#messages/app/<slug>` — so it opens where it always opened; what moved
 *   is where you find it. A viewer who may not talk here (a view-public,
 *   collab-private app) gets no row rather than a door that refuses them.
 *
 * And JOIN. Joining is what lets you take part here, so an outsider sees the
 * button at the top of the card and a member sees Leave at its foot. The
 * button asks before it joins, in a popup UNDER it — the way Vote asks under
 * Vote (the Workshop's vote popover, whose lines and answer button this
 * wears) — and while it is on screen it is also where every other refusal
 * for this app is asked: file a request or start a change from this page
 * without having joined, and the question opens here rather than in a
 * dialog over the page (lib/join-required.ts, registerJoinAnchor). The join
 * itself is Home.setMembership's, the same call Discover's pill makes, so
 * every path leaves the same flags behind.
 *
 * ── The island rules it keeps ──────────────────────────────────────────
 *
 * The card renders nothing until its read has answered: the first render is
 * null, the fetch runs in an effect, and a failed read leaves the page as it
 * was before this card existed rather than drawing an error where nothing
 * was asked for.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { HashIcon, LockIcon, UserGroupIcon, UserIcon } from '@/components/ui/icons';
import { offerJoin, registerJoinAnchor } from '../../../lib/join-required';
import { agoStamp } from '../../../lib/timestamp';

type Audience = 'open' | 'invited' | 'solo';

export type CommunityPayload = {
  slug: string;
  name?: string;
  member_count: number;
  is_member: boolean;
  is_creator: boolean;
  audience: Audience;
  audience_label: string;
  members: Array<{ id: number; username: string; display_name?: string | null; source?: string }>;
  channel: {
    last_message: string | null;
    last_at: string | null;
    last_by: string | null;
    unread_count: number;
  } | null;
  approval: {
    policy: 'anyone' | 'invited';
    approvals_required: number | null;
    electorate: number;
    required: number;
  };
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The approval rule as one sentence. Exported and pure so the wording is
 * tested against the three regimes governance.js knows.
 */
export function approvalLine(approval: CommunityPayload['approval'] | null | undefined): string {
  if (!approval) return '';
  const required = Math.max(1, Number(approval.required) || 1);
  const electorate = Math.max(1, Number(approval.electorate) || 1);
  if (approval.policy === 'invited') {
    return `Approvers decide: ${plural(required, 'yes vote', 'yes votes')} from ${plural(electorate, 'approver', 'approvers')} to merge a change.`;
  }
  if (approval.approvals_required != null) {
    return `A change needs ${plural(required, 'yes vote', 'yes votes')} from members to merge.`;
  }
  return `Members vote: a change merges at ${plural(required, 'yes vote', 'yes votes')} (${plural(electorate, 'active member', 'active members')}), or unopposed after a wait.`;
}

/** "Community · 12 members"; "Just you" alone, because there is one. */
export function audienceLine(p: Pick<CommunityPayload, 'audience' | 'audience_label' | 'member_count'>): string {
  if (p.audience === 'solo') return p.audience_label || 'Just you';
  return `${p.audience_label} · ${plural(Number(p.member_count) || 0, 'member', 'members')}`;
}

function AudienceGlyph({ audience }: { audience: Audience }) {
  const cls = 'w-4 h-4 shrink-0';
  if (audience === 'solo') return <UserIcon className={cls} aria-hidden="true" />;
  if (audience === 'invited') return <LockIcon className={cls} aria-hidden="true" />;
  return <UserGroupIcon className={cls} aria-hidden="true" />;
}

async function readCommunity(slug: string): Promise<CommunityPayload | null> {
  try {
    const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/community`);
    if (!res.ok) return null;
    return (await res.json()) as CommunityPayload;
  } catch {
    return null;
  }
}

export function CommunityCard({ slug }: { slug: string }) {
  const [data, setData] = useState<CommunityPayload | null>(null);
  const [busy, setBusy] = useState(false);
  // The open Join question, if one is: its answer goes back to whoever asked
  // (lib/join-required.ts's offerJoin), which does the joining.
  const [asking, setAsking] = useState<null | { answer: (ok: boolean) => void }>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const joinRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    const next = slug ? await readCommunity(slug) : null;
    setData((prev) => (next && next.slug === slug ? next : (prev && prev.slug === slug ? prev : null)));
  }, [slug]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  // THE ANCHOR. While this card shows a Join button, the question for this
  // app is asked here. `visible` is what stops a card on a screen that is
  // mounted but hidden from swallowing a question asked in Messages. On the
  // way out, a question still open is answered No, so nothing waits forever.
  const canJoin = !!data && !data.is_member;
  useEffect(() => {
    if (!canJoin) return undefined;
    let open: ((ok: boolean) => void) | null = null;
    const off = registerJoinAnchor(slug, {
      visible: () => !!joinRef.current && joinRef.current.getClientRects().length > 0,
      ask: () => new Promise<boolean>((resolve) => {
        open = resolve;
        setAsking({
          answer: (ok) => {
            open = null;
            setAsking(null);
            resolve(ok);
          },
        });
        cardRef.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
      }),
    });
    return () => {
      off();
      if (open) open(false);
    };
  }, [slug, canJoin]);

  // Closing it: Escape, or a press anywhere outside the popup. A listener
  // rather than a scrim, because this card is `.dev-ws-strip`, whose
  // backdrop-filter makes it the containing block for anything fixed inside
  // it — a full-screen scrim drawn here would cover the card and nothing else.
  useEffect(() => {
    if (!asking) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') asking.answer(false); };
    const onDown = (e: Event) => {
      const t = e.target as Node | null;
      if (t && (popRef.current?.contains(t) || joinRef.current?.contains(t))) return;
      asking.answer(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [asking]);

  if (!data) return null;

  // The button asks the same question every other refusal asks, through the
  // same function, which finds this card as its anchor.
  const join = async () => {
    if (busy) return;
    if (asking) { asking.answer(false); return; }
    setBusy(true);
    try {
      await offerJoin({ code: 'join_required', app: { slug, name: data.name || slug } });
    } finally {
      setBusy(false);
      void load();
    }
  };

  const leave = async () => {
    const home = (window as any).Home;
    if (!home?.setMembership || busy) return;
    setBusy(true);
    try {
      await home.setMembership(slug, false);
    } finally {
      setBusy(false);
      void load();
    }
  };

  // The dialog's own gate (AppView._plusMenuShowsMembers, the "+" menu's):
  // offered here to exactly the people the "+" menu offers it to. Read at
  // render, which is safe because this card has no server render — it is
  // null until its fetch has answered in the browser.
  const showsMembers = !!(window as any).AppView?._plusMenuShowsMembers?.();
  // Three names, then a count: enough to say who is here, short enough that
  // the rule under it is still on the first screen at phone width.
  const names = data.members.slice(0, 3).map((m) => m.display_name || m.username);
  const more = Math.max(0, (Number(data.member_count) || 0) - names.length);
  const channel = data.channel;
  const when = channel?.last_at ? agoStamp(channel.last_at) : null;

  return (
    <section
      ref={cardRef}
      className="dev-ws-strip"
      data-ws-community=""
      data-audience={data.audience}
      // Lifted while the popup is open: the popup hangs below this card, and
      // the card after it is its own stacking context (backdrop-filter) that
      // would otherwise paint over it.
      style={asking ? { position: 'relative', zIndex: 5 } : undefined}
    >
      <div className="dev-ws-head">
        <span className="dev-ws-head-title">Who it’s for</span>
      </div>
      <div className="flex items-center gap-2 text-sm text-zinc-900 dark:text-zinc-100" data-ws-community-audience="">
        <AudienceGlyph audience={data.audience} />
        <span className="font-medium">{audienceLine(data)}</span>
        {!data.is_member ? (
          <span className="dev-ws-join-anchor">
            <Button
              ref={joinRef}
              type="button"
              variant="pillAccent"
              size="sm"
              ink="solid"
              data-ws-community-join=""
              aria-haspopup="dialog"
              aria-expanded={!!asking}
              disabled={busy && !asking}
              onClick={() => { void join(); }}
            >
              Join
            </Button>
            {asking ? (
              <div
                ref={popRef}
                className="dev-ws-join-pop"
                role="dialog"
                aria-label={`Join ${data.name || slug}?`}
                data-ws-join-pop=""
              >
                <p className="dev-ws-ask-q">Join {data.name || slug}?</p>
                <p className="dev-ws-vote-sub">Members start changes, file requests, vote and chat here.</p>
                <div className="dev-ws-answer-row">
                  <button
                    type="button"
                    className="dev-ws-answer-btn dev-ws-answer-join"
                    data-ws-join-answer="join"
                    autoFocus
                    onClick={() => asking.answer(true)}
                  >
                    Join
                  </button>
                </div>
                <button type="button" className="dev-ws-vote-later" data-ws-join-answer="later" onClick={() => asking.answer(false)}>
                  Not now
                </button>
              </div>
            ) : null}
          </span>
        ) : null}
      </div>
      {names.length ? (
        <p className="m-0 text-sm text-zinc-600 dark:text-zinc-400" data-ws-community-members="">
          {names.join(', ')}{more > 0 ? ` and ${plural(more, 'other', 'others')}` : ''}
          {showsMembers ? (
            <>
              {' · '}
              <button
                type="button"
                className="font-medium text-violet-700 dark:text-violet-300 hover:underline"
                data-ws-community-manage=""
                onClick={() => { (window as any).AppView?.openMembersModal?.(); }}
              >
                Members &amp; approvals
              </button>
            </>
          ) : null}
        </p>
      ) : null}
      <p className="m-0 text-sm text-zinc-600 dark:text-zinc-400" data-ws-community-rule="">
        {approvalLine(data.approval)}
      </p>
      {channel ? (
        <a
          href={`#messages/app/${encodeURIComponent(slug)}`}
          className="flex items-center gap-2 rounded-xl px-2 py-2 -mx-2 hover:bg-zinc-500/10 text-sm text-zinc-900 dark:text-zinc-100 no-underline"
          data-ws-community-channel=""
        >
          <HashIcon className="w-4 h-4 shrink-0 text-zinc-500" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">
            <span className="font-medium">Channel</span>
            <span className="text-zinc-500 dark:text-zinc-400">
              {' · '}
              {channel.last_message
                ? `${channel.last_by ? `@${channel.last_by}: ` : ''}${channel.last_message}`
                : 'No messages yet'}
            </span>
          </span>
          {when ? <time className="shrink-0 text-xs text-zinc-500" dateTime={channel.last_at || undefined} title={when.title}>{when.text}</time> : null}
          {channel.unread_count > 0 ? (
            <span className="messages-unread" aria-label={`${channel.unread_count} unread`}>
              {channel.unread_count > 99 ? '99+' : channel.unread_count}
            </span>
          ) : null}
        </a>
      ) : null}
      {data.is_member && !data.is_creator ? (
        <div className="flex justify-end">
          <button
            type="button"
            className="text-xs text-zinc-500 hover:text-red-700 dark:text-zinc-400 dark:hover:text-red-400"
            data-ws-community-leave=""
            disabled={busy}
            onClick={() => { void leave(); }}
          >
            Leave
          </button>
        </div>
      ) : null}
    </section>
  );
}
