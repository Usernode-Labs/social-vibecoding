/**
 * The project page's hero: what this is, who it is for, and Join, at the top
 * of the project's own Workshop page, above where the app is.
 *
 * ── Why it leads the page ──────────────────────────────────────────────
 *
 * Every project belongs to one community (src/services/communities.js), and
 * while the two are one-to-one the community is drawn AS its project: there
 * is no separate community page, so the facts that are the community's
 * rather than the code's live on the page the Workshop tab's row opens. The
 * page used to open on its dashboard, four numbers about the code, with the
 * community in a card under it; a person arriving from Discover or a shared
 * link met "18 open items" before they met the thing's name. So the page
 * leads with identity, the way a profile does, and the dashboard follows:
 *
 *   WHAT IT IS. The app's tile and name (the header chip's, from the page's
 *   own store) and dapp.json's one-line description when it has one.
 *
 *   WHO IT IS FOR. The audience, in the words people see (Community, Group,
 *   Just you) as a chip, and the member count. "Community", not "public":
 *   the label is the same one the Workshop tab heads its section with, so
 *   the row you tapped and the page you landed on agree about what this is.
 *
 *   JOIN, JOINED, INVITE. An outsider sees Join, which asks in a popup under
 *   itself (below). A member sees Joined, which is also the way out: a tap
 *   asks before leaving, the same pill Discover draws. Invite opens Members
 *   & approvals, where the roster, invites and approvers are managed, for
 *   exactly whom the "+" menu offers it. This hero lists; it does not manage.
 *
 *   HOW A CHANGE GETS IN. The approval rule, read from the server rather
 *   than restated here (GET /api/apps/:slug/community, `approval`): the
 *   headline number an unopposed change needs. It is a headline and it says
 *   so ("to merge", not "exactly") because opposition raises it and the
 *   quiet-week path can merge below it (services/active-users.js).
 *
 *   WHERE THEY TALK is no longer a row here. The channel has a card of its
 *   own on the hub (./hub-cards.tsx), with its last messages, because it
 *   lives on the hub now rather than in Messages.
 *
 * Joining is what lets you take part here. The button asks the question every
 * join_required refusal asks, through lib/join-required.ts's offerJoin, and
 * while it shows it registers itself as that app's anchor, so a refusal from
 * anywhere on this page asks in the same popup.
 *
 * ── The island rules it keeps ──────────────────────────────────────────
 *
 * The hero's community half waits for its read: the fetch runs in an
 * effect, the first render is the identity alone (or nothing, without a
 * name), and a failed read leaves just that, rather than drawing an error
 * where nothing was asked for.
 */

import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { CheckIcon, LockIcon, UserGroupIcon, UserIcon } from '@/components/ui/icons';
import { AppIconContent, appIconKind } from '../../apps/app-card-view';
import { offerJoin, registerJoinAnchor } from '../../../lib/join-required';

type Audience = 'open' | 'invited' | 'solo';

export type CommunityPayload = {
  slug: string;
  name?: string;
  /** dapp.json's one-line description, when the repository declares one. */
  description?: string | null;
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
    /** The newest few messages, oldest first, for the hub's preview. */
    recent?: Array<{ id: number; content: string; created_at: string; by: string | null }>;
    /** Where Open goes: the app's channel, or #general for Homeroom's. */
    href?: string;
    /** `general` on Homeroom's own hub, whose channel #general is. */
    handle?: string | null;
    /** Homeroom's earlier project discussion, kept read-only. */
    archive_href?: string | null;
  } | null;
  /** Who has been around lately, for Members & activity. */
  activity?: { active_week: number; shipped_month: number } | null;
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
  const cls = 'w-3.5 h-3.5 shrink-0';
  if (audience === 'solo') return <UserIcon className={cls} aria-hidden="true" />;
  if (audience === 'invited') return <LockIcon className={cls} aria-hidden="true" />;
  return <UserGroupIcon className={cls} aria-hidden="true" />;
}

/** The tile and the name, with whatever line goes under the name. */
function HeroId({ app, children }: {
  app: { slug: string; name: string; icon_url: string | null; icon_emoji: string | null };
  children: ReactNode;
}) {
  return (
    <div className="dev-ws-hero-id">
      <div className="app-icon-tile dev-ws-hero-tile" data-icon={appIconKind(app)} aria-hidden="true">
        <AppIconContent app={app} />
      </div>
      <div className="min-w-0">
        <h2 className="dev-ws-hero-name">{app.name}</h2>
        {children}
      </div>
    </div>
  );
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

/*
 * ONE READ FOR THE WHOLE HUB. The hero, the channel card and Members &
 * activity all draw from GET /api/apps/:slug/community, so they share this
 * cache rather than asking three times. Each consumer's mount asks for a
 * fresh copy unless one is already on its way, and a failed read keeps the
 * last good answer rather than blanking the page.
 */
const communities = new Map<string, CommunityPayload>();
const inflight = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

export function reloadCommunity(slug: string): Promise<void> {
  if (!slug) return Promise.resolve();
  const pending = readCommunity(slug).then((next) => {
    inflight.delete(slug);
    if (next && next.slug === slug) {
      communities.set(slug, next);
      for (const listener of [...listeners]) listener();
    }
  });
  inflight.set(slug, pending);
  return pending;
}

export function useCommunity(slug: string): CommunityPayload | null {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    listeners.add(bump);
    return () => { listeners.delete(bump); };
  }, []);
  useEffect(() => {
    if (slug && !inflight.has(slug)) void reloadCommunity(slug);
  }, [slug]);
  return slug ? communities.get(slug) || null : null;
}

export function CommunityCard({ slug, name, iconUrl, iconEmoji }: {
  slug: string;
  /** The app's identity as the page already knows it (improveStore), so the
      hero draws the same tile and name as the header's chip. */
  name?: string;
  iconUrl?: string | null;
  iconEmoji?: string | null;
}) {
  const data = useCommunity(slug);
  const [busy, setBusy] = useState(false);
  // The open Join question, if one is: its answer goes back to whoever asked
  // (lib/join-required.ts's offerJoin), which does the joining.
  const [asking, setAsking] = useState<null | { answer: (ok: boolean) => void }>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const joinRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  const load = () => reloadCommunity(slug);

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

  // BEFORE THE READ: the identity alone, when the page already knows it, so
  // the dashboard under the hero does not jump down when the read answers.
  // Nothing when it does not (the page's own store has not loaded either).
  if (!data) {
    return name ? (
      <section className="dev-ws-hero" data-ws-community-pending="">
        <HeroId app={{ slug, name, icon_url: iconUrl || null, icon_emoji: iconEmoji || null }}>
          <div className="dev-ws-hero-meta" aria-hidden="true">&nbsp;</div>
        </HeroId>
      </section>
    ) : null;
  }

  // The button asks the same question every other refusal asks, through the
  // same function, which finds this card as its anchor.
  const join = async () => {
    if (busy) return;
    if (asking) { asking.answer(false); return; }
    setBusy(true);
    try {
      await offerJoin({ code: 'join_required', app: { slug, name: name || data.name || slug } });
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
  const displayName = name || data.name || slug;
  const tileApp = { slug, name: displayName, icon_url: iconUrl || null, icon_emoji: iconEmoji || null };

  return (
    <section
      ref={cardRef}
      className="dev-ws-hero"
      data-ws-community=""
      data-audience={data.audience}
      // Lifted while the popup is open: the popup hangs below the hero, over
      // the dashboard card after it.
      style={asking ? { position: 'relative', zIndex: 5 } : undefined}
    >
      <HeroId app={tileApp}>
        <div className="dev-ws-hero-meta" data-ws-community-audience="">
          <span className="dev-ws-hero-chip">
            <AudienceGlyph audience={data.audience} />
            {data.audience_label}
          </span>
          {data.audience !== 'solo' ? (
            <span>{plural(Number(data.member_count) || 0, 'member', 'members')}</span>
          ) : null}
        </div>
      </HeroId>
      <div className="dev-ws-hero-actions">
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
                aria-label={`Join ${displayName}?`}
                data-ws-join-pop=""
              >
                <p className="dev-ws-ask-q">Join {displayName}?</p>
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
        ) : data.is_creator ? null : (
          // JOINED IS THE LEAVE CONTROL. A state you can see, with a check,
          // and a tap asks before it takes you out (Home.setMembership), the
          // same pill Discover draws. The creator gets none: they cannot
          // leave what they started.
          <Button
            type="button"
            variant="pillNeutral"
            size="sm"
            ink="neutral"
            className="inline-flex items-center gap-1"
            data-ws-community-leave=""
            title={`Joined. Tap to leave ${displayName}`}
            disabled={busy}
            onClick={() => { void leave(); }}
          >
            <CheckIcon className="w-3.5 h-3.5" strokeWidth="3" aria-hidden="true" />
            Joined
          </Button>
        )}
        {showsMembers ? (
          <Button
            type="button"
            variant="pillNeutral"
            size="sm"
            ink="neutral"
            data-ws-community-manage=""
            title="Members & approvals"
            onClick={() => { (window as any).AppView?.openMembersModal?.(); }}
          >
            Invite
          </Button>
        ) : null}
      </div>
      {data.description ? (
        <p className="dev-ws-hero-desc" data-ws-community-description="">{data.description}</p>
      ) : null}
      <p className="dev-ws-hero-line" data-ws-community-rule="">
        {approvalLine(data.approval)}
      </p>
    </section>
  );
}
