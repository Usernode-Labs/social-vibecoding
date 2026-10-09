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
 *   WHO IT IS FOR. The audience, in the words people see (Public community,
 *   Private community, Just you), and for a public or a private community
 *   WHO IS HERE AND HOW LIVELY IT HAS BEEN, as one block under what it is:
 *   faces, the member count over a line of this week's activity, and the
 *   last fourteen days as a small bar chart across from both (#3268; it was
 *   the hub's Members & activity card, fourth down the page). The chart
 *   names a day when it is pointed at, or dragged across with a finger
 *   (Spark, below), so it needs no caption of its own.
 *
 *   JOIN, JOINED, INVITE, ⋯. Membership sits across from the name, because
 *   it is a fact about you and this project, the way a profile's Follow
 *   sits across from the person's name. An outsider sees Join, which asks
 *   in a popup under itself (below). A member sees Joined, which is also
 *   the way out: a tap asks before leaving, the same pill Discover draws.
 *   What you can DO here ends the members row: Invite opens Members &
 *   approvals, where the roster, invites and approvers are managed, for
 *   exactly whom the ⋯ menu offers it, and the ⋯ itself (`menu`, the
 *   page's DevPlusMenu) holds Suggest an improvement and the project's settings.
 *   This hero lists; it does not manage.
 *
 *   MAKE IT PUBLIC. Who a project is for can grow after it exists: Invite
 *   makes a Just-you project a private community, and "Make it public" (it
 *   was "Open it up") makes it a public one. Taking a public community back
 *   is "Make it private", a row of the ⋯ rather than a button here
 *   (confirmMakePrivate): narrowing who a project is for is a setting, not
 *   an invitation, and the hero's row is for asking people in. That is the
 *   visibility change the settings dialog proposes, POST
 *   /api/apps/:slug/visibility-pr, offered to the same people the route
 *   lets open it (`can_manage`). It is a PROPOSAL, not a switch: dapp.json
 *   says who a project is for, so the change is voted in like any other
 *   line of it and applies once it merges. While one is up, the hero says
 *   so and links to it instead of offering a second.
 *
 *   HOW A CHANGE GETS IN is not on the hero any more. The approval rule is
 *   the Workshop page's Approval rules card (ApprovalRules, below), beside
 *   the work it governs: on the hero it was a line about process between
 *   who is here and the channel.
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

import { useEffect, useReducer, useRef, useState, type ReactNode, type Ref } from 'react';

import { Button } from '@/components/ui/button';
import { CheckIcon, ChevronRightIcon, LockIcon, PersonSilhouetteIcon, PlayIcon, ShieldCheckIcon, UserGroupIcon, UserIcon } from '@/components/ui/icons';
import { swatchFor } from '../../messages/format';
import { RichMessage, useMessages } from '../../../lib/i18n/react';
import { t as translate } from '../../../lib/i18n/runtime';
import { offerJoin, registerJoinAnchor } from '../../../lib/join-required';
import { askToVerifyForPublic, identityNeededHere } from '../../auth/verify-identity';
import { invitedByLine, joinByInvite, useInviteOffer, type InviteJoin, type InviteOffer } from './invite-offer';
import { hubShot, hubShotPayload } from './hub-shot';

type Audience = 'open' | 'invited' | 'solo';

/**
 * The first version Homeroom bot is building from the project's
 * description, while it builds it (routes/apps.js hubFirstVersion): the
 * App tab's state, cut to what the hub says. Null once it is live, or when
 * the bot is not building one.
 */
export type HubFirstVersion = {
  step: number | null;
  of: number | null;
  /** #4053: its build line for this viewer (homeroom-bot-progress.js
      buildLineOf), the App tab's and the made screen's; the words are
      ../../first-session/build-line.tsx's, never written here. */
  line: string | null;
  /** Built and up for approval: ready to try. */
  ready: boolean;
  /** The description is the viewer's. */
  mine: boolean;
  creator: string | null;
  /** What it waits on from its maker, for them alone. */
  waits_on: 'plan' | 'question' | null;
  /** The maker's DM with the bot, for them alone. */
  conversation_id: number | null;
  /** The change, once it is ready to try. */
  session_id: number | null;
  /** #4074: the plan waiting for its maker's Build it, read only, for a
      member who did not start it (routes/apps.js sharedPlan); #4396: the
      plan its maker chose, while it is built and tested; else null. */
  plan?: {
    bullets: string[];
    questions: Array<{ question: string; suggested: string | null }>;
  } | null;
};

export type CommunityPayload = {
  slug: string;
  name?: string;
  /** dapp.json's one-line description, or the first sentence of the
      description it was made from when dapp.json has none yet. */
  description?: string | null;
  /** #4045: made under seven days ago (never the platform's own): the hub
      leaves out what is still empty (decision D). */
  first_week?: boolean;
  /** #4045: the viewer has a live invite link for a project that is still
      just theirs, so the hub draws open seats beside their face instead of
      "Just you". Only ever true for a member, on a Just you project. */
  invite_link?: boolean;
  first_version?: HubFirstVersion | null;
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
    /** Where the hub's composer sends: the room's own write route. */
    post_url?: string | null;
  } | null;
  /** Who has been around lately, for Members & activity: two counts and
      the last fourteen days, oldest first, as people-per-day. */
  activity?: {
    active_week: number;
    shipped_month: number;
    daily?: Array<{ day: string; n: number }>;
  } | null;
  /** Whether this viewer may propose who the project is for (the creator,
      an app admin or a platform admin; never the platform's own app). */
  can_manage?: boolean;
  /** An audience change already up for a vote, if one is. */
  audience_change?: { session_id: number; pr_number: number | null; title: string | null } | null;
  approval: {
    policy: 'anyone' | 'invited';
    approvals_required: number | null;
    electorate: number;
    required: number;
  };
};

/**
 * The rule's sentences for one kind of voter, as message ids. Each is the
 * whole sentence, because who has to say yes is worded by how many that is
 * out of how many: "2 of the 12 active members", "both active members", "the
 * only approver". A count dapp.json set can name more people than there are
 * (`short`), and then says how many there are. The `Quiet` ones add the
 * path that needs one Yes and no objection.
 */
type RuleIds = {
  some: string; someQuiet: string;
  short: string; shortQuiet: string;
  only: string;
  both: string; bothQuiet: string;
  all: string; allQuiet: string;
};

const APPROVER_RULE: RuleIds = {
  some: 'project:communityCard.rule.approvers.some',
  someQuiet: 'project:communityCard.rule.approvers.someQuiet',
  short: 'project:communityCard.rule.approvers.short',
  shortQuiet: 'project:communityCard.rule.approvers.shortQuiet',
  only: 'project:communityCard.rule.approvers.only',
  both: 'project:communityCard.rule.approvers.both',
  bothQuiet: 'project:communityCard.rule.approvers.bothQuiet',
  all: 'project:communityCard.rule.approvers.all',
  allQuiet: 'project:communityCard.rule.approvers.allQuiet',
};

const MEMBER_RULE: RuleIds = {
  some: 'project:communityCard.rule.members.some',
  someQuiet: 'project:communityCard.rule.members.someQuiet',
  short: 'project:communityCard.rule.members.short',
  shortQuiet: 'project:communityCard.rule.members.shortQuiet',
  only: 'project:communityCard.rule.members.only',
  both: 'project:communityCard.rule.members.both',
  bothQuiet: 'project:communityCard.rule.members.bothQuiet',
  all: 'project:communityCard.rule.members.all',
  allQuiet: 'project:communityCard.rule.members.allQuiet',
};

function ruleLine(ids: RuleIds, required: number, of: number, quiet: boolean): string {
  if (required < of) return translate(quiet ? ids.someQuiet : ids.some, { count: required, total: of });
  // Counted by how many there are: that is the number English words differently.
  if (required > of) return translate(quiet ? ids.shortQuiet : ids.short, { count: of, required });
  if (of === 1) return translate(ids.only);
  if (of === 2) return translate(quiet ? ids.bothQuiet : ids.both);
  return translate(quiet ? ids.allQuiet : ids.all, { count: of });
}

/**
 * The approval rule as one sentence, in the words the rest of the page
 * uses: a change "goes live", people "approve" it. Exported and pure so the
 * wording is tested against the three regimes governance.js knows:
 *
 *   - members vote (the default): the eased threshold over the active
 *     members, or the quiet path, which needs one Yes and no objection
 *     (active-users.js lazyWindowMs) and so cannot apply when one Yes is
 *     already the threshold;
 *   - invited approvers: the same math over the approvers alone;
 *   - at least N (dapp.json's approvals_required, either policy): N
 *     approvals and no clock at all.
 *
 * First-session run-through, 5 Oct 2026: "Members vote: a change merges at
 * 2 yes votes (2 active members), or unopposed after a wait" was the
 * sentence a newcomer met here.
 */
export function approvalLine(
  approval: CommunityPayload['approval'] | null | undefined,
  viewer?: Pick<CommunityPayload, 'audience' | 'is_member'> | null,
): string {
  if (!approval) return '';
  const required = Math.max(1, Number(approval.required) || 1);
  const electorate = Math.max(1, Number(approval.electorate) || 1);
  // A Just you project's one approver is the person reading it (#4246).
  if (viewer?.audience === 'solo' && viewer.is_member
    && Number(approval.electorate) === 1 && Number(approval.required) === 1) {
    return translate('project:communityCard.rule.you');
  }
  const fixed = approval.approvals_required != null;
  const quiet = !fixed && required > 1;
  if (approval.policy === 'invited') {
    return ruleLine(APPROVER_RULE, required, electorate, quiet);
  }
  if (fixed) {
    return translate('project:communityCard.rule.fixed', { count: required });
  }
  return ruleLine(MEMBER_RULE, required, electorate, quiet);
}

/** "Public community · 12 members"; "Just you" alone, because there is one. */
export function audienceLine(p: Pick<CommunityPayload, 'audience' | 'audience_label' | 'member_count'>): string {
  if (p.audience === 'solo') return p.audience_label || translate('project:communityCard.audience.justYou');
  return translate('project:communityCard.audience.withMembers', { audience: p.audience_label, count: Number(p.member_count) || 0 });
}

/**
 * The pending audience change in the hero's words. The PR's title is the
 * settings dialog's ("Make this app public"); the hero says what it means
 * for who the project is for.
 */
export function audienceChangeLine(title: string | null | undefined): string {
  const t = String(title || '');
  if (/ public$/.test(t)) return translate('project:communityCard.audienceChange.toPublic');
  if (/private \(collaborators only\)$/.test(t)) return translate('project:communityCard.audienceChange.toPrivate');
  return translate('project:communityCard.audienceChange.other');
}

function AudienceGlyph({ audience }: { audience: Audience }) {
  const cls = 'w-3.5 h-3.5 shrink-0';
  if (audience === 'solo') return <UserIcon className={cls} aria-hidden="true" />;
  if (audience === 'invited') return <LockIcon className={cls} aria-hidden="true" />;
  return <UserGroupIcon className={cls} aria-hidden="true" />;
}

async function readCommunity(slug: string): Promise<CommunityPayload | null> {
  // `?shot=hub-first-week` (./hub-shot.ts): a made-up first week, drawn for
  // the before/after shots in place of the server's answer.
  const shot = hubShot();
  if (shot) return hubShotPayload(slug, shot);
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

/**
 * Invite people with a link (#3362): the Homeroom menu's invite pane, a link
 * to this project anyone can use to join it (../../app-context/invite-pane.tsx).
 * The menu's own "Invite to community" row is gone, so the hub's Invite is
 * the way in, beside the people it adds. Collaborators and approvals are
 * still the ⋯'s "Members & approvals".
 *
 * ONE CALL, which opens the menu ON the invite pane. It was `open()` then
 * `showInvite()`, and the sheet went up twice: short, on the pane's loading
 * line, then tall when the link came, with the dim fading in again between
 * (AppContext.openInvite says why).
 */
export function openInviteLinks(): void {
  const ctx = (window as any).AppContext;
  if (!ctx) return;
  void ctx.openInvite?.();
}

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

/** How many faces the hero shows before the count says the rest. */
export const HERO_FACES = 5;

/** Up to HERO_FACES faces, overlapping; nothing for nobody. */
function HeroFaces({ members }: { members: CommunityPayload['members'] | null | undefined }) {
  const faces = (members || []).slice(0, HERO_FACES);
  if (!faces.length) return null;
  return (
    <span className="dev-ws-hero-faces" aria-hidden="true">
      {faces.map((m) => (
        <span key={m.id} className="dev-ws-hero-face" style={{ background: swatchFor(m.username) }} title={`@${m.username}`}>
          {(m.username || '?').charAt(0).toUpperCase()}
        </span>
      ))}
    </span>
  );
}

/** How many faces the first week's row shows: the count says the rest. */
export const WEEK_FACES = 3;

/**
 * The seats of a project nobody has joined yet, in the colours of the
 * canvas board People (set "you-open"): one on each side of your face, pale,
 * with a person's outline in them. They are not buttons; Invite is.
 */
const SEATS = [
  { bg: '#ebefed', ink: '#cedae0' },
  { bg: '#fae5dc', ink: '#ebb199' },
] as const;

function Seat({ bg, ink }: { bg: string; ink: string }) {
  return (
    <span className="dev-ws-hero-face dev-ws-hero-seat" style={{ background: bg, color: ink }}>
      <PersonSilhouetteIcon aria-hidden="true" />
    </span>
  );
}

/**
 * The people row of a project's first week (#4045, the owner, 8 Oct 2026;
 * canvas boards Hub and People): the faces at the left, then who it is for
 * as "Private community" with its lock, and "3 people" under it.
 *
 *   Just you              the label alone: nobody else is here, and no link is out
 *   a link is out         your face between two open seats, "Private
 *                         community" and no count: the count of one person
 *                         is the seats' whole point
 *   anyone else in it     up to three faces, the audience and "N people"
 *
 * `seats` is `invite_link` on a Just you project (GET .../community): the
 * audience the server derives stays "Just you" until somebody accepts, so the
 * hub says "Private community" itself while the seats are shown.
 */
export function WeekPeople({ members, count, audience, audienceLabel, seats }: {
  members: CommunityPayload['members'] | null | undefined;
  count: number;
  audience?: Audience;
  audienceLabel?: string;
  seats?: boolean;
}) {
  const t = useMessages('project');
  const solo = audience === 'solo';
  const shown: Audience | undefined = seats ? 'invited' : audience;
  const label = seats ? t('project:communityCard.week.privateCommunity') : audienceLabel;
  const you = (members || [])[0];
  const faces = seats ? [] : solo ? [] : (members || []).slice(0, WEEK_FACES);
  const countLine = seats || solo ? '' : t('project:communityCard.week.people', { count });
  return (
    <div className="dev-ws-hero-week-people" data-ws-members="" data-ws-seats={seats ? '' : undefined}>
      {seats && you ? (
        <span className="dev-ws-hero-faces dev-ws-hero-seats" aria-hidden="true">
          <Seat {...SEATS[0]} />
          <span className="dev-ws-hero-face" style={{ background: swatchFor(you.username) }} title={`@${you.username}`}>
            {(you.username || '?').charAt(0).toUpperCase()}
          </span>
          <Seat {...SEATS[1]} />
        </span>
      ) : faces.length ? (
        <span className="dev-ws-hero-faces" aria-hidden="true">
          {faces.map((m) => (
            <span key={m.id} className="dev-ws-hero-face" style={{ background: swatchFor(m.username) }} title={`@${m.username}`}>
              {(m.username || '?').charAt(0).toUpperCase()}
            </span>
          ))}
        </span>
      ) : null}
      <span className="dev-ws-hero-week-who" data-ws-members-cell="members">
        {label ? (
          <span className="dev-ws-hero-audience" data-ws-community-audience="">
            {shown ? <AudienceGlyph audience={shown} /> : null}
            <b>{label}</b>
          </span>
        ) : null}
        {countLine ? <span className="dev-ws-hero-week-count">{countLine}</span> : null}
      </span>
    </div>
  );
}

/**
 * The hub's people line (#3268): up to HERO_FACES faces, then who the
 * community is for and how many are in it, "Public community · 23 members".
 * The label used to be a chip of its own under the name, and the name is the
 * coloured header's now, so the audience rides the count instead of spending
 * a row of the page on itself. Just you is the label alone.
 */
export function HeroPeople({ members, count, audience, audienceLabel, children }: {
  members: CommunityPayload['members'] | null | undefined;
  count: number;
  audience?: Audience;
  audienceLabel?: string;
  children?: ReactNode;
}) {
  return (
    <div className="dev-ws-hero-people" data-ws-members="">
      <HeroFaces members={members} />
      <HeroCount count={count} audience={audience} audienceLabel={audienceLabel} />
      {children}
    </div>
  );
}

/** "Public community · 23 members", the audience's glyph leading it. */
function HeroCount({ count, audience, audienceLabel }: { count: number; audience?: Audience; audienceLabel?: string }) {
  const t = useMessages('project');
  const solo = audience === 'solo';
  return (
    <span className="dev-ws-hero-count" data-ws-members-cell="members">
      {!audienceLabel ? (solo ? null : t('project:communityCard.people.members', { count }))
        : solo ? <AudienceLabel audience={audience}>{audienceLabel}</AudienceLabel>
          : (
            // One message: the audience, drawn with its glyph, then the count.
            <RichMessage
              id="project:communityCard.people.audienceMembers"
              values={{ audience: audienceLabel, count }}
              components={[<AudienceLabel audience={audience} />]}
            />
          )}
    </span>
  );
}

/** The audience's words in bold, its glyph leading them. */
function AudienceLabel({ audience, children }: { audience?: Audience; children?: ReactNode }) {
  return (
    <span className="dev-ws-hero-audience" data-ws-community-audience="">
      {audience ? <AudienceGlyph audience={audience} /> : null}
      <b>{children}</b>
    </span>
  );
}

/** "Sat, Sep 26", the day a bar stands for, in the viewer's own words. */
export function sparkDay(day: string): string {
  const when = new Date(`${day}T12:00:00`);
  return Number.isNaN(when.getTime()) ? day
    : when.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/** The tip's first line: "Sat, Sep 26 · 21 people". */
export function sparkTip(d: { day: string; n: number }): string {
  return translate('project:communityCard.spark.tip', { day: sparkDay(d.day), count: Number(d.n) || 0 });
}

/** How long a tip stays up after a finger lifts off the chart. */
const TIP_LINGER_MS = 2500;

/**
 * The fourteen days as bars, and the day under the pointer as a tip.
 *
 * NO CAPTION, AND NO `title` ON THE BARS. The chart carried "Who took part,
 * last 14 days" under the activity line, and each bar a native tooltip that
 * a phone never shows. The caption is the tip's second line now, where it
 * explains the number it sits under, and the tip is the chart's own:
 *
 *   - with a mouse it follows the pointer across the bars and leaves with
 *     it;
 *   - with a finger it shows on touch and follows the drag sideways (the
 *     chart takes the pointer, so the drag does not scroll the page; a
 *     vertical drag still does, `touch-action: pan-y` in app.css), and
 *     lingers a moment after the finger lifts, so a tap can be read.
 *
 * The tip is placed against the chart's right edge, not over the bar: the
 * chart ends the row at the screen's edge, and a tip centred on the last
 * bar would run off it. The bar it is about is lit instead.
 *
 * For a screen reader nothing changes: the chart is one image whose name
 * lists every day's count, and the tip is hidden from it.
 */
function Spark({ days, peak }: { days: Array<{ day: string; n: number }>; peak: number }) {
  const t = useMessages('project');
  const [at, setAt] = useState<number | null>(null);
  const boxRef = useRef<HTMLSpanElement | null>(null);
  const linger = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopLinger = () => {
    if (linger.current) clearTimeout(linger.current);
    linger.current = null;
  };
  useEffect(() => stopLinger, []);
  const pick = (clientX: number) => {
    const box = boxRef.current;
    if (!box) return;
    const r = box.getBoundingClientRect();
    if (!r.width) return;
    const i = Math.floor(((clientX - r.left) / r.width) * days.length);
    setAt(Math.min(days.length - 1, Math.max(0, i)));
  };
  const active = at == null ? null : days[at] || null;
  return (
    <span className="dev-ws-hero-spark-wrap">
      <span
        ref={boxRef}
        className="dev-ws-hero-spark"
        data-ws-members-trend=""
        {...(active ? { 'data-ws-spark-active': '' } : {})}
        role="img"
        aria-label={t('project:communityCard.spark.label', { count: days.length, counts: days.map((d) => Number(d.n) || 0).join(', ') })}
        onPointerDown={(e) => {
          stopLinger();
          if (e.pointerType !== 'mouse') {
            try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
          }
          pick(e.clientX);
        }}
        onPointerMove={(e) => {
          if (e.pointerType === 'mouse' || at != null) pick(e.clientX);
        }}
        onPointerLeave={(e) => { if (e.pointerType === 'mouse') setAt(null); }}
        onPointerUp={(e) => {
          if (e.pointerType === 'mouse') return;
          stopLinger();
          linger.current = setTimeout(() => setAt(null), TIP_LINGER_MS);
        }}
        onPointerCancel={() => { stopLinger(); setAt(null); }}
      >
        {days.map((d, i) => {
          const n = Number(d.n) || 0;
          return (
            <span
              key={d.day}
              className={(n ? 'dev-ws-hero-spark-bar' : 'dev-ws-hero-spark-bar dev-ws-hero-spark-bar-quiet')
                + (i === at ? ' dev-ws-hero-spark-bar-on' : '')}
              style={{ height: `${n && peak ? Math.max(12, Math.round((n / peak) * 100)) : 8}%` }}
            />
          );
        })}
      </span>
      {active ? (
        <span className="dev-ws-hero-spark-tip" aria-hidden="true" data-ws-spark-tip="">
          <span className="dev-ws-hero-spark-tip-day">{sparkTip(active)}</span>
          <span className="dev-ws-hero-spark-tip-cap">{t('project:communityCard.spark.caption')}</span>
        </span>
      ) : null}
    </span>
  );
}

/**
 * WHO IS HERE AND HOW LIVELY IT HAS BEEN, as one block (#3268 put both on
 * the hero, as two rows with the actions between them): the faces, then
 * "Public community · 23 members" over who was around this week and how
 * many changes shipped this month, and the last fourteen days as a small
 * bar chart across from both. On a phone the chart moves up across from the
 * faces and the words take the full width under them (app.css): faces,
 * words and chart in one row left the words a column a few words wide.
 *
 * "Changes shipped", not "shipped": a bare number shipped said nothing
 * about what it counted. The separator is a no-break space and a dot, so a
 * line too long for a narrow phone breaks after the dot, never before it.
 * A zero says nothing; a fortnight in which nobody did anything is one
 * quiet line instead of fourteen slivers.
 */
export function HeroPulse({ members, count, audience, audienceLabel, activity }: {
  members: CommunityPayload['members'] | null | undefined;
  count: number;
  audience?: Audience;
  audienceLabel?: string;
  activity: CommunityPayload['activity'] | null | undefined;
}) {
  const t = useMessages('project');
  const days = activity?.daily || [];
  const active = Number(activity?.active_week) || 0;
  const shipped = Number(activity?.shipped_month) || 0;
  const peak = Math.max(0, ...days.map((d) => Number(d.n) || 0));
  const quiet = !active && !shipped && !peak;
  return (
    <div className="dev-ws-hero-pulse" data-ws-members="">
      <HeroFaces members={members} />
      <span className="dev-ws-hero-pulse-words">
        <HeroCount count={count} audience={audience} audienceLabel={audienceLabel} />
        {quiet ? (
          <span className="dev-ws-hero-activity-line" data-ws-members-trend="" data-ws-trend-empty="">
            {t('project:communityCard.pulse.nobody')}
          </span>
        ) : (
          <span className="dev-ws-hero-activity-line" data-ws-members-stats="">
            {active ? (
              <span data-ws-members-cell="active">
                <RichMessage id="project:communityCard.pulse.active" values={{ count: active }} components={[<b />]} />
              </span>
            ) : null}
            {active && shipped ? '\u00a0· ' : null}
            {shipped ? (
              <span data-ws-members-cell="shipped">
                <RichMessage id="project:communityCard.pulse.shipped" values={{ count: shipped }} components={[<b />]} />
              </span>
            ) : null}
            {!active && !shipped ? t('project:communityCard.pulse.quiet') : null}
          </span>
        )}
      </span>
      {!quiet && days.length >= 2 ? <Spark days={days} peak={peak} /> : null}
    </div>
  );
}

/**
 * Open the visibility proposal (POST /api/apps/:slug/visibility-pr) that
 * makes a project public or private. A public community is public to use and
 * to build; a private community is private to both, as the create dialog
 * maps them. A 409 is one already up, which the hero shows either way, so it
 * is not an error. Throws with words a person can read.
 *
 * #4378: making it public needs a verified owner. The route answers
 * `identity_required` for one who is not; then the verify sheet asks, and
 * once a phone is linked the proposal is sent again. Resolves false when
 * they said Not now (the project stays private), true once it is up.
 */
export async function proposeAudience(slug: string, to: 'public' | 'private'): Promise<boolean> {
  const send = () => fetch(`/api/apps/${encodeURIComponent(slug)}/visibility-pr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(to === 'private'
      ? { collabVisibility: 'private', viewVisibility: 'private' }
      : { collabVisibility: 'public', viewVisibility: 'public' }),
  });
  let res = await send();
  if (!res.ok && res.status !== 409) {
    let body = await res.json().catch(() => ({}));
    if (body && body.code === 'identity_required') {
      if (!(await askToVerifyForPublic())) return false;
      res = await send();
      if (res.ok || res.status === 409) return true;
      body = await res.json().catch(() => ({}));
    }
    throw new Error((body && body.error) || translate('project:communityCard.audienceChange.failed'));
  }
  return true;
}

/**
 * Before "Make it public" asks its question: an owner the verified-identity
 * rule still holds is asked to verify first ("Verify to make it public").
 * True to go on as before; false for Not now, which leaves it private.
 */
export async function verifiedToGoPublic(): Promise<boolean> {
  if (!identityNeededHere()) return true;
  return askToVerifyForPublic();
}

/** What making it public means, said before it is proposed (the Share it popup and ⋯'s confirm): a message id. */
export const MAKE_PUBLIC_LINE = 'project:communityCard.makePublic.explain';

/**
 * What making it private means, said before it is proposed. Who can OPEN
 * it: the repository stays public on GitHub (services/github.js createRepo)
 * whatever this setting says. A message id.
 */
export const MAKE_PRIVATE_LINE = 'project:communityCard.makePrivate.explain';

/**
 * "Make it private", from the hub's ⋯ (../actions-row.tsx DevPlusMenu's
 * `onMakePrivate`). It was a button in the hero beside Invite; it is a
 * setting, so it lives with the settings. The same question the hero's
 * popup asked, as the platform's confirm (the kit's alert, which a row of
 * the touch action sheet can present, as App display name's prompt does),
 * then the same proposal, then the hero re-reads and shows it up for a vote.
 */
export async function confirmMakePrivate(slug: string, name: string): Promise<void> {
  const ui = (window as any).PlatformUI;
  if (!ui || typeof ui.confirm !== 'function') return;
  const ok = await ui.confirm({
    title: translate('project:communityCard.makePrivate.question', { project: name }),
    message: translate(MAKE_PRIVATE_LINE),
    confirmLabel: translate('project:communityCard.makePrivate.propose'),
    cancelLabel: translate('project:communityCard.makePrivate.notNow'),
  });
  if (!ok) return;
  try {
    await proposeAudience(slug, 'private');
  } catch (err) {
    ui.toast?.(err instanceof Error ? err.message : translate('project:communityCard.audienceChange.failed'));
    return;
  }
  await reloadCommunity(slug);
}

/**
 * "Make it public", from the hub's ⋯ (#4045, decision D). It was a button in
 * the hero's row; it is a setting, so it lives beside "Make it private" in
 * the ⋯ (../actions-row.tsx DevPlusMenu's `onMakePublic`), and the row keeps
 * what you do with people: Invite. The same question as the popup, as the
 * platform's confirm, then the same proposal.
 */
export async function confirmMakePublic(slug: string, name: string): Promise<void> {
  const ui = (window as any).PlatformUI;
  if (!ui || typeof ui.confirm !== 'function') return;
  if (!(await verifiedToGoPublic())) return;
  const ok = await ui.confirm({
    title: translate('project:communityCard.makePublic.question', { project: name }),
    message: translate(MAKE_PUBLIC_LINE),
    confirmLabel: translate('project:communityCard.makePublic.propose'),
    cancelLabel: translate('project:communityCard.makePublic.notNow'),
  });
  if (!ok) return;
  try {
    if (!(await proposeAudience(slug, 'public'))) return;
  } catch (err) {
    ui.toast?.(err instanceof Error ? err.message : translate('project:communityCard.audienceChange.failed'));
    return;
  }
  await reloadCommunity(slug);
}

/**
 * Whether the hub's ⋯ offers "Make it public": a private community, to
 * whoever may open the visibility proposal, while no change to who it is
 * for is already up for a vote. A project that is just yours keeps it on
 * its Share it card.
 */
export function canMakePublic(data: Pick<CommunityPayload, 'audience' | 'can_manage' | 'audience_change'> | null | undefined): boolean {
  return !!data && data.audience === 'invited' && !!data.can_manage && !data.audience_change;
}

/**
 * Leave, from the hub's ⋯ (#4045): it was the hero's Joined pill. Whether
 * the ⋯ offers it: a member who did not start the project (they cannot
 * leave what they started).
 */
export function canLeave(data: Pick<CommunityPayload, 'is_member' | 'is_creator'> | null | undefined): boolean {
  return !!data && !!data.is_member && !data.is_creator;
}

/** Leave the community: Home.setMembership asks first, then the hub re-reads. */
export async function leaveCommunity(slug: string): Promise<void> {
  const home = (window as any).Home;
  if (!slug || !home?.setMembership) return;
  try {
    await home.setMembership(slug, false);
  } finally {
    await reloadCommunity(slug);
  }
}

/**
 * "Make it public" on a project that is just yours (ShareItCard): the
 * audience change as a question under its button, the Join popup's shape. The answer opens the visibility
 * PR; the hero then re-reads and shows it as up for a vote. Only this way
 * round: "Make it private" is the ⋯'s (confirmMakePrivate, above).
 */
function MakePublic({ slug, name, onOpened }: {
  slug: string;
  name: string;
  onOpened: () => void;
}) {
  const t = useMessages('project');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onDown = (e: Event) => {
      const t = e.target as Node | null;
      if (t && (popRef.current?.contains(t) || btnRef.current?.contains(t))) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [open]);

  const propose = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const proposed = await proposeAudience(slug, 'public');
      setOpen(false);
      if (proposed) onOpened();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('project:communityCard.audienceChange.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="dev-ws-join-anchor">
      <Button
        ref={btnRef}
        type="button"
        variant="pillNeutral"
        size="sm"
        ink="neutral"
        data-ws-community-audience-change="open"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setError('');
          if (open) { setOpen(false); return; }
          // #4378: an owner still to verify is asked first; Not now leaves it private.
          void verifiedToGoPublic().then((go) => { if (go) setOpen(true); });
        }}
      >
        {t('project:communityCard.share.makePublic')}
      </Button>
      {open ? (
        <div
          ref={popRef}
          className="dev-ws-join-pop"
          role="dialog"
          aria-label={t('project:communityCard.makePublic.question', { project: name })}
          data-ws-audience-pop=""
        >
          <p className="dev-ws-ask-q">{t('project:communityCard.makePublic.question', { project: name })}</p>
          <p className="dev-ws-vote-sub">{t(MAKE_PUBLIC_LINE)}</p>
          {error ? <p className="dev-ws-audience-error" role="alert" data-ws-audience-error="">{error}</p> : null}
          <div className="dev-ws-answer-row">
            <button
              type="button"
              className="dev-ws-answer-btn dev-ws-answer-join"
              data-ws-audience-answer="propose"
              autoFocus
              disabled={busy}
              onClick={() => { void propose(); }}
            >
              {t('project:communityCard.makePublic.propose')}
            </button>
          </div>
          <button type="button" className="dev-ws-vote-later" data-ws-audience-answer="later" onClick={() => setOpen(false)}>
            {t('project:communityCard.makePublic.notNow')}
          </button>
        </div>
      ) : null}
    </span>
  );
}

/**
 * Whether the hub's ⋯ offers "Make it private": a public community, to
 * whoever may open the visibility proposal (`can_manage`, the route's own
 * rule), while no change to who it is for is already up for a vote.
 */
export function canMakePrivate(data: Pick<CommunityPayload, 'audience' | 'can_manage' | 'audience_change'> | null | undefined): boolean {
  return !!data && data.audience === 'open' && !!data.can_manage && !data.audience_change;
}

/**
 * WHO INVITED THEM, AND JOIN (#3700): "@maya invited you", their note, one
 * "Join <name>" as the screen's primary button, standing alone. The
 * confirm's words (./invite-offer.ts), on a page. First in the
 * hero of a page an invite link opened, and the body of a private
 * community's invite preview (../../invite-preview). `children` hang under
 * the button: the hero's Join question.
 */
export function InviteCard({ offer, name, busy, onJoin, joinRef, children }: {
  offer: Pick<InviteOffer, 'inviter' | 'inviterName' | 'inviterMadeIt' | 'building' | 'note'>;
  name: string;
  busy: boolean;
  onJoin: () => void;
  joinRef?: Ref<HTMLButtonElement>;
  children?: ReactNode;
}) {
  // Subscribed: who invited them is read by invitedByLine.
  const t = useMessages('project');
  return (
    <div className="dev-ws-invite" data-ws-invite="">
      <p className="dev-ws-invite-from" data-ws-invite-from="">{invitedByLine(offer)}</p>
      {offer.note ? <p className="dev-ws-invite-note" data-ws-invite-note="">{t('project:communityCard.inviteCard.note', { note: offer.note })}</p> : null}
      <div className="dev-ws-join-anchor">
        <Button
          ref={joinRef}
          type="button"
          layout="full"
          variant="pillAccent"
          disabledStyle="dim"
          size="pillLg"
          ink="solid"
          data-ws-invite-join=""
          disabled={busy}
          onClick={onJoin}
        >
          {t('project:communityCard.inviteCard.join', { project: name })}
        </Button>
        {children}
      </div>
    </div>
  );
}

export function CommunityCard({ slug, name, menu, canOpenApp = false, onJoinedByInvite }: {
  slug: string;
  /** The app's identity as the page already knows it (improveStore), so the
      hero draws the same tile and name as the header's chip. */
  name?: string;
  /** The ⋯ and its menu (../actions-row.tsx DevPlusMenu), last on the
      members row. The page renders it so its props stay the page's. */
  menu?: ReactNode;
  /** Whether "Open app" leads the actions (#3367): every project but the
      platform's own, which is the page you are on. */
  canOpenApp?: boolean;
  /** Where Join through the invite link this page was opened from lands
      (./invite-offer.ts): the page's own choice, Needs you or the hub. */
  onJoinedByInvite?: () => void;
}) {
  const t = useMessages('project');
  const data = useCommunity(slug);
  // The invite link this page was opened from, if it was (#3700).
  const offer = useInviteOffer(slug);
  const [busy, setBusy] = useState(false);
  // The open Join question, if one is: its answer goes back to whoever asked
  // (lib/join-required.ts's offerJoin), which does the joining, unless the
  // answer is 'joined': the invite link has done it already.
  const [asking, setAsking] = useState<null | { answer: (ok: boolean | 'joined') => void }>(null);
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
    let open: ((ok: boolean | 'joined') => void) | null = null;
    const off = registerJoinAnchor(slug, {
      visible: () => !!joinRef.current && joinRef.current.getClientRects().length > 0,
      ask: () => new Promise<boolean | 'joined'>((resolve) => {
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

  // BEFORE THE READ: the actions that depend on nothing the read says (Open
  // app and the ⋯), so a read that fails cannot take the project's settings
  // off the page. The name and tile are the coloured header's now.
  const openApp = canOpenApp ? (
    <button
      type="button"
      className="dev-ws-open-app"
      data-ws-community-open-app=""
      onClick={() => { (window as any).App?.openAppTab?.(slug, 'app'); }}
    >
      <PlayIcon className="w-3 h-3" aria-hidden="true" />
      {t('project:communityCard.openApp')}
    </button>
  ) : null;
  if (!data) {
    return (openApp || menu) ? (
      <section className="dev-ws-hero" data-ws-community-pending="">
        <div className="dev-ws-hero-row"><div className="dev-ws-hero-actions">{openApp}{menu}</div></div>
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

  // JOIN THROUGH THE LINK this page was opened from (./invite-offer.ts),
  // which spends a use of it and tells its maker, as the confirm's Join did.
  // From the button it lands where the page says (`onJoinedByInvite`); as
  // the answer to a question a refusal asked under it, it lands nowhere, so
  // the press that met the refusal is simply sent again (offerJoin).
  const joinThroughLink = async (land: boolean): Promise<boolean> => {
    if (!offer || busy) return false;
    setBusy(true);
    let outcome: InviteJoin['outcome'] = 'failed';
    try {
      ({ outcome } = await joinByInvite(offer));
    } finally {
      setBusy(false);
      void load();
    }
    if (outcome === 'joined' && land) onJoinedByInvite?.();
    return outcome === 'joined' || outcome === 'welcomed';
  };
  const answerThroughLink = (answer: (ok: boolean | 'joined') => void) => {
    void joinThroughLink(false).then((ok) => answer(ok ? 'joined' : false));
  };

  // Invite is a MEMBER's (#3362): an invite link can be made by anyone in
  // the community (services/community-invites.js), and the pane says so when
  // the viewer cannot make one yet. Collaborators and approvals stay behind
  // the ⋯'s own gate.
  const displayName = name || data.name || slug;
  const solo = data.audience === 'solo';
  // OPENED FROM AN INVITE LINK and not in it yet (#3700): who invited them
  // and one prominent Join lead the hero, and that Join is the only one on
  // it. `?shot=invite-join` draws the same for whoever is looking, so the
  // hero is drawn as for an outsider then (`member`).
  const invited = !!offer && (!!offer.preview || !data.is_member);
  const member = data.is_member && !offer?.preview;
  // The question a refusal asks, under whichever Join is showing.
  const popup = asking ? (
    <div
      ref={popRef}
      className="dev-ws-join-pop"
      role="dialog"
      aria-label={t('project:communityCard.join.question', { project: displayName })}
      data-ws-join-pop=""
    >
      <p className="dev-ws-ask-q">{t('project:communityCard.join.question', { project: displayName })}</p>
      <p className="dev-ws-vote-sub">{t('project:communityCard.join.explain')}</p>
      <div className="dev-ws-answer-row">
        <button
          type="button"
          className="dev-ws-answer-btn dev-ws-answer-join"
          data-ws-join-answer="join"
          autoFocus
          // Busy is the row's Join waiting on this very answer; only the
          // link's join, once pressed, is something to wait out here.
          disabled={invited && busy}
          onClick={() => { if (invited) answerThroughLink(asking.answer); else asking.answer(true); }}
        >
          {t('project:communityCard.join.answer')}
        </button>
      </div>
      <button type="button" className="dev-ws-vote-later" data-ws-join-answer="later" onClick={() => asking.answer(false)}>
        {t('project:communityCard.join.notNow')}
      </button>
    </div>
  ) : null;
  // WHO INVITED THEM, AND JOIN, first in the hero: visible without scrolling
  // on a phone, above everything the page shows them to decide by (what it
  // is, who is here and the fortnight, Open app, and below the hero what is
  // being decided).
  const inviteHead = invited && offer ? (
    <InviteCard
      offer={offer}
      name={displayName}
      busy={busy}
      joinRef={joinRef}
      onJoin={() => {
        if (asking) { answerThroughLink(asking.answer); return; }
        void joinThroughLink(true);
      }}
    >
      {popup}
    </InviteCard>
  ) : null;
  // YOU AND THIS PROJECT, at the end of the action row: Join. Joined was
  // here too, and was the way out; Leave is a row of the ⋯ now (#4045,
  // canLeave), so a member's row is what they can do, not what they are.
  const membership = invited || data.is_member ? null : (
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
        {t('project:communityCard.join.button')}
      </Button>
      {popup}
    </span>
  );
  // #4045, DECISION D: IN ITS FIRST WEEK the hero leaves out what is still
  // empty: no fortnight of activity. The people row is the week's own
  // (WeekPeople): the faces, "Private community" over "3 people", then what
  // you can do. A pending change to who it is for is not empty, so it stays.
  const week = !!data.first_week;
  // A link is out on a project that is still just theirs: their face and
  // open seats, and the audience it is about to be (WeekPeople).
  const seats = member && solo && !!data.invite_link;
  // While its first version is on the way (or, in its first week, just
  // went live) the First version card is the way into the app: Open app
  // there, so not here too.
  const appButton = data.first_version ? null : openApp;
  const descLine = (
    <p className="dev-ws-hero-desc" data-ws-community-description="">{data.description}</p>
  );

  return (
    <section
      ref={cardRef}
      className="dev-ws-hero"
      data-ws-community=""
      data-audience={data.audience}
      // Lifted while the popup is open: the popup hangs below the hero, over
      // the card after it.
      style={asking ? { position: 'relative', zIndex: 5 } : undefined}
    >
      {inviteHead}
      {/* WHAT IT IS first, under the coloured header's tile and name. In a
          project's first week it sits under the people row instead. */}
      {data.description && !week ? descLine : null}
      {/* WHO IS HERE, WHO IT IS FOR AND HOW LIVELY IT HAS BEEN, one block:
          the faces, "Public community · 23 members" over this week in words,
          and the fortnight's chart across from both. Just you is the label
          alone: nobody to show and nothing to count. In its first week the
          people are the action row's first part instead (WeekPeople, below),
          and there is no fortnight yet. */}
      {week ? null : solo ? (
        <HeroPeople members={[]} count={Number(data.member_count) || 0} audience={data.audience} audienceLabel={data.audience_label} />
      ) : (
        <HeroPulse
          members={data.members}
          count={Number(data.member_count) || 0}
          audience={data.audience}
          audienceLabel={data.audience_label}
          activity={data.activity}
        />
      )}
      {/* WHAT YOU CAN DO HERE, one row: Open app in the community's colour,
          Invite, the ⋯, and across from them Join. "Make it public" and
          "Make it private" are rows of the ⋯ (#4045), and so is Leave. A
          project that is just yours grows from its Share it card instead
          (ShareItCard), so its row keeps Open app and the ⋯. The ⋯ stays
          LAST among the actions (its menu hangs off its right edge); Join is
          the row's, pushed to the far end. */}
      <div className="dev-ws-hero-row">
      {week ? (
        <WeekPeople
          members={data.members}
          count={Number(data.member_count) || 0}
          audience={data.audience}
          audienceLabel={data.audience_label}
          seats={seats}
        />
      ) : null}
      <div className="dev-ws-hero-actions">
        {appButton}
        {member && !solo ? (
          <Button
            type="button"
            variant="pillNeutral"
            size="sm"
            ink="neutral"
            data-ws-community-invite=""
            title={t('project:communityCard.invite.title')}
            onClick={openInviteLinks}
          >
            {t('project:communityCard.invite.button')}
          </Button>
        ) : null}
        {menu}
      </div>
      {membership ? <span className="dev-ws-hero-member">{membership}</span> : null}
      </div>
      {/* The app's one line sits under the week's people row (canvas board Hub). */}
      {data.description && week ? descLine : null}
      {data.audience_change ? (
        <a
          className="dev-ws-hero-line dev-ws-hero-pending"
          href={`#app/${encodeURIComponent(slug)}/dev/proposals/${data.audience_change.session_id}`}
          data-ws-community-audience-pending={String(data.audience_change.session_id)}
        >
          {audienceChangeLine(data.audience_change.title)}
          <ChevronRightIcon className="w-3.5 h-3.5" aria-hidden="true" />
        </a>
      ) : null}
    </section>
  );
}

/**
 * SHARE IT: how a project that is just yours grows, at the foot of its hub.
 * The same two levers the hero offers a community (Invite makes it a private
 * community; "Make it public" proposes making it public, voted in like any other
 * line of dapp.json), gathered under one line that says what they do, since
 * on a project of one they are the whole of what there is to do with people.
 * Offered to exactly whom the hero would offer them; nothing when neither
 * applies, and nothing until the shared read has answered.
 *
 * While Homeroom bot builds its first version (the First version card above
 * it, ./hub-cards.tsx), the line says what an invite is for right now, in
 * the made screen's words: people can follow along while it is being built.
 */
export function shareItLine(building: boolean): string {
  return building
    ? translate('project:communityCard.share.lineBuilding')
    : translate('project:communityCard.share.line');
}

export function ShareItCard({ slug, name }: { slug: string; name?: string }) {
  const t = useMessages('project');
  const data = useCommunity(slug);
  if (!data || data.audience !== 'solo') return null;
  const canInvite = !!data.is_member;
  const canOpenUp = !!data.can_manage && !data.audience_change;
  if (!canInvite && !canOpenUp) return null;
  return (
    <section className="dev-ws-strip dev-ws-share" data-ws-share="">
      <div className="dev-ws-head">
        <span className="dev-ws-head-title">{t('project:communityCard.share.title')}</span>
      </div>
      <p className="dev-ws-strip-text">{shareItLine(!!data.first_version && !data.first_version.ready)}</p>
      <div className="dev-ws-share-actions">
        {canInvite ? (
          <Button
            type="button"
            variant="pillNeutral"
            size="sm"
            ink="neutral"
            data-ws-share-invite=""
            onClick={openInviteLinks}
          >
            {t('project:communityCard.share.invite')}
          </Button>
        ) : null}
        {canOpenUp ? (
          <MakePublic slug={slug} name={name || data.name || slug} onOpened={() => { void reloadCommunity(slug); }} />
        ) : null}
      </div>
    </section>
  );
}

/**
 * The approvers' names on an invited-approvers project, for the drawing
 * below: GET /api/apps/:slug/approvers, read once per page load and shared.
 * Null until it answers, and for a viewer it refuses (it is collaborator-
 * read), who then sees the faces of the project's members instead.
 */
const approverNames = new Map<string, string[] | null>();
const approverReads = new Map<string, Promise<void>>();
function useApprovers(slug: string, wanted: boolean): string[] | null {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!wanted || !slug || approverNames.has(slug)) return;
    let read = approverReads.get(slug);
    if (!read) {
      read = fetch(`/api/apps/${encodeURIComponent(slug)}/approvers`)
        .then((res) => (res.ok ? res.json() : null))
        .then((body: { approvers?: Array<{ username?: string; status?: string }> } | null) => {
          const list = body && Array.isArray(body.approvers)
            ? body.approvers.filter((a) => a && a.status === 'member' && a.username).map((a) => String(a.username))
            : null;
          approverNames.set(slug, list);
        })
        .catch(() => { approverNames.set(slug, null); });
      approverReads.set(slug, read);
    }
    let live = true;
    void read.then(() => { if (live) bump(); });
    return () => { live = false; };
  }, [slug, wanted]);
  return approverNames.get(slug) || null;
}

/**
 * "evan or snait", "evan, snait or maya", "evan and snait"; past three, the
 * first three and "+N". At most three names are ever written out, so each
 * shape is a whole message with the names as its parameters.
 */
function nameList(names: string[], joiner: 'or' | 'and'): string {
  if (!names.length) return '';
  const [first, second, third] = names;
  if (names.length > 3) {
    return translate('project:communityCard.step.names.more', { first, second, third, count: names.length - 3 });
  }
  if (names.length === 1) return first;
  if (names.length === 2) {
    return translate(joiner === 'or' ? 'project:communityCard.step.names.eitherOfTwo' : 'project:communityCard.step.names.bothOfTwo', { first, second });
  }
  return translate(joiner === 'or' ? 'project:communityCard.step.names.anyOfThree' : 'project:communityCard.step.names.allOfThree', { first, second, third });
}

/** How many faces the middle step shows before "+N" says the rest. */
export const RULE_FACES = 3;

/**
 * The middle step in words: who has to say yes, the names under it, and the
 * wait rule's line where there is one. Pure, for the tests; the three
 * regimes are approvalLine's.
 */
export function approvalStep(
  approval: CommunityPayload['approval'],
  viewer: Pick<CommunityPayload, 'audience' | 'is_member'> | null | undefined,
  approvers: string[] | null,
): { who: string; names: string; wait: string; solo: boolean } {
  const required = Math.max(1, Number(approval.required) || 1);
  const electorate = Math.max(1, Number(approval.electorate) || 1);
  if (viewer?.audience === 'solo' && viewer.is_member
    && Number(approval.electorate) === 1 && Number(approval.required) === 1) {
    return {
      who: translate('project:communityCard.step.you'),
      names: translate('project:communityCard.step.justYou'),
      wait: '',
      solo: true,
    };
  }
  const fixed = approval.approvals_required != null;
  const quiet = !fixed && required > 1;
  if (approval.policy === 'invited') {
    // The order is the sentence's: one approver says it whatever was asked for.
    const who = required < electorate
      ? translate('project:communityCard.step.approvers.some', { count: required, total: electorate })
      : electorate === 1 ? translate('project:communityCard.step.approvers.only')
        : electorate === 2 && required === 2 ? translate('project:communityCard.step.approvers.both')
          : required === electorate ? translate('project:communityCard.step.approvers.all', { count: electorate })
            : translate('project:communityCard.step.approvers.short', { count: electorate, required });
    return {
      who,
      names: approvers ? nameList(approvers, required === 1 ? 'or' : 'and') : '',
      wait: quiet ? translate('project:communityCard.step.approvers.wait') : '',
      solo: false,
    };
  }
  if (fixed) {
    return { who: translate('project:communityCard.step.fixed', { count: required }), names: '', wait: '', solo: false };
  }
  const who = required < electorate
    ? translate('project:communityCard.step.members.some', { count: required, total: electorate })
    // Counted by how many there are: that is the number English words differently.
    : required > electorate ? translate('project:communityCard.step.members.short', { count: electorate, required })
      : electorate === 1 ? translate('project:communityCard.step.members.only')
        : electorate === 2 ? translate('project:communityCard.step.members.both')
          : translate('project:communityCard.step.members.all', { count: electorate });
  return {
    who,
    names: '',
    wait: quiet ? translate('project:communityCard.step.members.wait') : '',
    solo: false,
  };
}

/**
 * HOW A CHANGE GETS IN, on the Workshop page (#4457): the approval rule
 * DRAWN, as the three things that happen to a change — its checks pass, the
 * people the rule names say yes, it goes live — read from the server rather
 * than restated here (GET /api/apps/:slug/community, `approval`). It was one
 * sentence with nothing to look at; that sentence is the drawing's
 * accessible name now (`approvalLine`), so a screen reader still hears the
 * rule whole.
 *
 * The middle step wears faces: the approvers' on an invited-approvers
 * project, with their names ("evan or snait"); otherwise a few members'
 * and "+N" for the rest of the electorate; on a project that is just you,
 * yours. The wait rule adds a line under it. The steps run across a wide
 * card and stack on a phone and beside the Workshop's side panel (app.css).
 */
export function ApprovalRules({ slug }: { slug: string }) {
  const t = useMessages('project');
  const data = useCommunity(slug);
  const invited = !!(data && data.approval && data.approval.policy === 'invited');
  const approvers = useApprovers(slug, invited);
  if (!data || !data.approval) return null;
  const step = approvalStep(data.approval, data, approvers);
  const electorate = Math.max(1, Number(data.approval.electorate) || 1);
  const people = step.solo
    ? (data.members || []).slice(0, 1).map((m) => m.username)
    : invited && approvers
      ? approvers.slice(0, RULE_FACES)
      : (data.members || []).slice(0, RULE_FACES).map((m) => m.username);
  const rest = step.solo ? 0 : Math.max(0, (invited && approvers ? approvers.length : electorate) - people.length);
  return (
    <section className="dev-ws-strip" data-ws-approval-rules="">
      <div className="dev-ws-head">
        <span className="dev-ws-head-title">{t('project:communityCard.rule.title')}</span>
      </div>
      <ol className="dev-ws-rules" data-ws-community-rule="" aria-label={approvalLine(data.approval, data)}>
        <li className="dev-ws-rule-step">
          <span className="dev-ws-rule-tile" aria-hidden="true"><ShieldCheckIcon aria-hidden="true" /></span>
          <span className="dev-ws-rule-text"><b>{t('project:communityCard.step.checks.title')}</b><span>{t('project:communityCard.step.checks.where')}</span></span>
        </li>
        <li className="dev-ws-rule-join" aria-hidden="true" />
        <li className="dev-ws-rule-step" data-ws-rule-people="">
          <span className="dev-ws-rule-faces" aria-hidden="true">
            {people.map((name) => (
              <span key={name} className="dev-ws-rule-face" style={{ background: swatchFor(name) }}>
                {(name || '?').charAt(0).toUpperCase()}
              </span>
            ))}
            {rest ? <span className="dev-ws-rule-face dev-ws-rule-more">{t('project:communityCard.step.moreFaces', { count: rest })}</span> : null}
            {!people.length && !rest ? (
              <span className="dev-ws-rule-tile"><UserGroupIcon aria-hidden="true" /></span>
            ) : null}
          </span>
          <span className="dev-ws-rule-text">
            <b>{step.who}</b>
            {step.names ? <span>{step.names}</span> : null}
            {step.wait ? <span className="dev-ws-rule-wait">{step.wait}</span> : null}
          </span>
        </li>
        <li className="dev-ws-rule-join" aria-hidden="true" />
        <li className="dev-ws-rule-step">
          <span className="dev-ws-rule-tile" data-tone="ok" aria-hidden="true"><CheckIcon aria-hidden="true" /></span>
          <span className="dev-ws-rule-text"><b>{t('project:communityCard.step.live.title')}</b><span>{t('project:communityCard.step.live.who')}</span></span>
        </li>
      </ol>
    </section>
  );
}
