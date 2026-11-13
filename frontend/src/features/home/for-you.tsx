/**
 * HOME'S FOR YOU COLUMN (#6650): `#home-for-you`, the third of Home on the
 * right beside Pinned apps, Pinned communities and Communities to join, and
 * on top of them once the window is too narrow for both (app.css
 * `.home-split`). What asks for the viewer, in this order:
 *
 *   New project            the way to make something, with how many project
 *                          slots are left (GET /api/me/app-allowance), or a
 *                          way to ask for more when none are. It was the
 *                          grid's trailing tile and Pinned communities' New
 *                          community tile; it keeps their
 *                          `data-panel-slot="create"` hook.
 *   Needs you              the votes waiting on the viewer (community-scope
 *                          `badgeNeeds`, the number a vote lowers at once),
 *                          split into votes that decide and advisory ones,
 *                          and the next two (GET /api/workshop/needs-feed).
 *                          It was Pinned communities' Needs you tile. A zero
 *                          says nothing: no votes, no card.
 *   New in your communities what happened in each community since the last
 *                          look: messages, changes that went live, new
 *                          requests (GET /api/me/home-activity; Mark all
 *                          read is POST /api/me/home-activity/seen). The
 *                          unread badges said only a number.
 *   Your work              points and this week's share of them, then the
 *                          viewer's changes, requests and votes, each with
 *                          where it stands (GET /api/me/home-work).
 *   Challenges             the section that sat under Pinned communities
 *                          (./panels/sections.tsx), at most two cards.
 *
 * Signed in only, and never in the prerender: the column ships `hidden`
 * and empty, and the first client render agrees; it shows once the shell
 * knows a platform viewer is signed in (lib/platform-viewer.ts). A private
 * member has no New project card (their waitlist card says how to make
 * one) and no Your work; the rest is theirs as anybody's.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import {
  BallotIcon, ChatIcon, CheckIcon, CodeIcon, LightBulbIcon, PlusIcon, TrophyIcon,
} from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { whenPlatformViewer } from '../../lib/platform-viewer';
import { useStoreState } from '../../lib/use-store-state';
import { useVisibility } from '../../lib/visibility-store';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { communityScopeStore } from '../workshop/community-scope';
import { gridStore } from './grid-store';
import { ChallengesSection } from './panels/sections';

// Cards are the plane colour, 20px, one hairline (AGENTS.md).
export const CARD = 'flex min-w-0 flex-col gap-3 rounded-[20px] bg-[color:var(--dc-sheet-solid)] p-4 shadow-[inset_0_0_0_1px_var(--app-sheet-line)]';
// A title inside a card is a sentence (AGENTS.md): 15 over 13.
const TITLE = 'm-0 text-[15px] font-[650] leading-5 text-zinc-900 dark:text-zinc-100';
const SUB = 'm-0 text-[13px] leading-[1.125rem] text-zinc-500 dark:text-zinc-400';
const HEAD_LINK = 'shrink-0 text-[13px] font-semibold text-[color:var(--accent)] hover:underline whitespace-nowrap un-touch-target';
const PRIMARY = 'inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-zinc-900 px-4 text-[15px] font-semibold text-white no-underline transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white';
const ROW = 'flex min-h-[44px] items-center gap-3 rounded-xl px-2 py-1.5 text-zinc-900 no-underline hover:bg-zinc-500/[0.06] dark:text-zinc-100';
const ICON = 'app-icon-tile flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-[10px] text-base font-bold [&_.text-3xl]:text-xl';
const CHIP_ICON = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-zinc-500/10 text-zinc-600 dark:text-zinc-300';

function win(): any {
  return typeof window !== 'undefined' ? (window as any) : {};
}

function demoQuery(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('demo') === '1' ? '?demo=1' : '';
}

async function readJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: 'no-cache', credentials: 'same-origin' });
    if (!res.ok) return null;
    return await res.json() as T;
  } catch {
    return null;
  }
}

function formatCount(n: number): string {
  try { return new Intl.NumberFormat().format(n); } catch { return String(n); }
}

/** A small app or community icon, as the tiles draw it. */
function SmallIcon({ slug, name, iconUrl, iconEmoji }: {
  slug: string; name: string; iconUrl?: string | null; iconEmoji?: string | null;
}) {
  const app = { slug, name, icon_url: iconUrl || null, icon_emoji: iconEmoji || null };
  return (
    <span className={ICON} data-icon={appIconKind(app as any)} aria-hidden="true">
      <AppIconContent app={app as any} />
    </span>
  );
}

// ── New project ─────────────────────────────────────────────────────────

interface Allowance {
  quota?: { used: number; limit: number | null; remaining: number | null };
  canCreateApps?: boolean;
}

/**
 * The slots line under New project, as a pure function of the allowance:
 * how many are left, or, with none, the way to ask for more (Profile's
 * `#profile?slots` card). Nothing while it loads, and nothing for an
 * account with no limit.
 */
export function SlotsLine({ allowance }: { allowance: Allowance | null }) {
  const t = useMessages('home');
  const remaining = allowance?.quota?.remaining;
  if (!allowance || remaining === null || remaining === undefined) return null;
  if (remaining > 0) {
    return (
      <p className="m-0 flex items-center justify-center gap-2 text-[13px] text-zinc-600 dark:text-zinc-300" data-home-slots={String(remaining)}>
        <span className="h-2 w-2 shrink-0 rounded-full bg-[color:var(--state-ok)]" aria-hidden="true" />
        {t('home:forYou.newProject.slots', { count: remaining })}
      </p>
    );
  }
  return (
    <p className="m-0 text-center text-[13px] leading-[1.125rem] text-zinc-600 dark:text-zinc-300" data-home-slots="0">
      {t('home:forYou.newProject.noSlots')}{' '}
      <a href="#profile?slots" className="font-semibold text-[color:var(--accent)] hover:underline">
        {t('home:forYou.newProject.requestSlots')}
      </a>
    </p>
  );
}

export function NewProjectCard() {
  const t = useMessages('home');
  const grid = useStoreState(gridStore);
  const [allowance, setAllowance] = useState<Allowance | null>(null);
  useEffect(() => {
    let live = true;
    void readJson<Allowance>('/api/me/app-allowance').then((body) => { if (live && body) setAllowance(body); });
    return () => { live = false; };
  }, []);
  // A few of the viewer's own apps fanned out above the line: what a
  // project turns into. Their pinned apps' faces, as the grid draws them.
  const faces = useMemo(() => grid.items.filter((it) => !it.app.demo).slice(0, 4).map((it) => it.app), [grid.items]);
  // Home.canCreate(): the account's own flag, which ?shot=create-enabled and
  // ?shot=create-disabled pin for the declared checks (home.js).
  const enabled = !!win().Home?.canCreate?.();
  const locked = t('home:communities.newLocked', { hint: t('home:create.disabledHint') });
  return (
    <section id="home-new-project" className={CARD} aria-labelledby="home-new-project-title">
      {faces.length ? (
        <div className="flex items-end gap-1.5" aria-hidden="true">
          {faces.map((app, i) => (
            <span key={app.slug} className={i % 2 ? 'rotate-[6deg]' : '-rotate-[6deg]'}>
              <span className={ICON} data-icon={app.icon.kind}>
                {app.icon.kind === 'image'
                  ? <img src={app.icon.src} alt="" className="h-full w-full object-cover" loading="lazy" decoding="async" />
                  : app.icon.kind === 'emoji' ? <span className="text-xl leading-none">{app.icon.emoji}</span> : app.icon.letter}
              </span>
            </span>
          ))}
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border-2 border-dashed border-zinc-300 text-zinc-500 dark:border-zinc-600 dark:text-zinc-400">
            <PlusIcon className="h-4 w-4" aria-hidden="true" />
          </span>
        </div>
      ) : null}
      <div>
        <h2 id="home-new-project-title" className="m-0 text-[17px] font-bold leading-6 text-zinc-900 dark:text-zinc-100">
          {t('home:forYou.newProject.title')}
        </h2>
        <p className={`${SUB} mt-1`}>{t('home:forYou.newProject.text')}</p>
      </div>
      <button
        type="button"
        id="home-new-project-btn"
        className={enabled ? PRIMARY : `${PRIMARY} opacity-60`}
        data-panel-slot="create"
        data-create-enabled={String(enabled)}
        title={enabled ? undefined : locked}
        // Both states open the same dialog: without slots its quota row says
        // why, as the old New project tile did.
        onClick={() => { win().App?.showCreateModal?.(); }}
      >
        <PlusIcon className="h-4 w-4" aria-hidden="true" />
        {t('home:forYou.newProject.button')}
      </button>
      <SlotsLine allowance={allowance} />
    </section>
  );
}

// ── Needs you ───────────────────────────────────────────────────────────

export interface NeedsItem {
  kind?: string;
  id?: number | string;
  title?: string;
  advisory?: boolean;
  app?: { slug?: string; name?: string; icon_url?: string | null; icon_emoji?: string | null };
}

/** Pure: the feed → the two counts the bar draws, and the next two. */
export function needsSplit(items: readonly NeedsItem[] | null, total: number) {
  const list = items || [];
  const advisory = list.filter((it) => it.advisory).length;
  // The feed is bounded; the count is not. What the feed does not hold is
  // counted as deciding, which is what a vote is unless it says otherwise.
  const decide = Math.max(0, total - advisory);
  return { decide, advisory: Math.min(advisory, total), next: list.slice(0, 2) };
}

export function NeedsCardView({ count, items }: { count: number; items: readonly NeedsItem[] | null }) {
  const t = useMessages('home');
  const { decide, advisory, next } = needsSplit(items, count);
  return (
    <section id="home-needs-card" className={`${CARD} bg-violet-50/60 shadow-[inset_0_0_0_1px_rgba(10,110,224,0.22)] dark:bg-violet-950/25`} aria-labelledby="home-needs-title" data-home-needs={String(count)}>
      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <p className="m-0 text-xs font-bold uppercase tracking-[0.06em] text-violet-700 dark:text-violet-400">{t('home:forYou.needs.label')}</p>
          <h2 id="home-needs-title" className={`${TITLE} mt-0.5`}>{t('home:forYou.needs.title')}</h2>
        </div>
        <span className="text-[34px] font-bold leading-none tabular-nums text-violet-700 dark:text-violet-400" aria-hidden="true">{count > 99 ? '99+' : count}</span>
      </div>
      <div>
        <div className="flex h-2 gap-[3px]" role="img" aria-label={t('home:forYou.needs.split', { decide, advisory })}>
          {decide ? <span className="rounded-full bg-violet-600 dark:bg-violet-500" style={{ flex: decide }} /> : null}
          {advisory ? <span className="rounded-full bg-violet-200 dark:bg-violet-900" style={{ flex: advisory }} /> : null}
        </div>
        <div className="mt-1.5 flex justify-between text-xs text-zinc-600 dark:text-zinc-300">
          <span>{t('home:forYou.needs.decide', { count: decide })}</span>
          {advisory ? <span>{t('home:forYou.needs.advisory', { count: advisory })}</span> : null}
        </div>
      </div>
      {next.length ? (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {next.map((item, i) => (
            <li key={`${item.kind || 'item'}:${item.id ?? i}`}>
              <a href="#needs" className="flex min-h-[44px] items-center gap-2.5 rounded-xl bg-white px-2.5 py-1.5 text-zinc-900 no-underline shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900 dark:text-zinc-100">
                <SmallIcon slug={item.app?.slug || ''} name={item.app?.name || ''} iconUrl={item.app?.icon_url} iconEmoji={item.app?.icon_emoji} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">{item.app?.name || ''}</span>
                  <span className="block truncate text-[14px] font-semibold leading-5">{item.title || ''}</span>
                </span>
                <span className={item.advisory
                  ? 'shrink-0 rounded-full bg-zinc-500/10 px-2 py-0.5 text-[11px] font-bold text-zinc-600 dark:text-zinc-300'
                  : 'shrink-0 rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-bold text-violet-800 dark:bg-violet-900/60 dark:text-violet-200'}
                >
                  {item.advisory ? t('home:forYou.needs.tagAdvisory') : t('home:forYou.needs.tagDecides')}
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      <a
        href="#needs"
        id="home-needs-review"
        className="inline-flex h-11 w-full items-center justify-center rounded-xl bg-violet-600 px-4 text-[15px] font-semibold text-white no-underline hover:bg-violet-500"
        aria-label={t('home:communities.needsNamed', { count })}
      >
        {t('home:forYou.needs.review', { count })}
      </a>
    </section>
  );
}

export function NeedsCard() {
  const { badgeNeeds } = useStoreState(communityScopeStore) as { badgeNeeds?: number | null };
  const count = Math.max(0, Number(badgeNeeds) || 0);
  const shown = useVisibility('home-screen', true);
  const [items, setItems] = useState<NeedsItem[] | null>(null);
  useEffect(() => {
    if (!count || !shown) return undefined;
    let live = true;
    void readJson<{ items?: NeedsItem[] }>(`/api/workshop/needs-feed${demoQuery()}`).then((body) => {
      if (live && body) setItems(Array.isArray(body.items) ? body.items : []);
    });
    return () => { live = false; };
  }, [count, shown]);
  if (!count) return null;
  return <NeedsCardView count={count} items={items} />;
}

// ── New in your communities ─────────────────────────────────────────────

export interface ActivityCommunity {
  slug: string;
  name: string;
  iconUrl?: string | null;
  iconEmoji?: string | null;
  messages: number;
  merged: number;
  requests: number;
}

/** Pure: what one row says happened, each kind with its glyph, zeros left out. */
export function activityParts(c: Pick<ActivityCommunity, 'messages' | 'merged' | 'requests'>) {
  const parts: Array<{ kind: 'messages' | 'merged' | 'requests'; count: number }> = [];
  if (c.messages > 0) parts.push({ kind: 'messages', count: c.messages });
  if (c.merged > 0) parts.push({ kind: 'merged', count: c.merged });
  if (c.requests > 0) parts.push({ kind: 'requests', count: c.requests });
  return parts;
}

const KIND_ICON = {
  messages: ChatIcon,
  merged: CheckIcon,
  requests: LightBulbIcon,
} as const;

const KIND_MESSAGE = {
  messages: 'home:forYou.activity.messages',
  merged: 'home:forYou.activity.merged',
  requests: 'home:forYou.activity.requests',
} as const;

function openHub(event: React.MouseEvent<HTMLAnchorElement>, slug: string) {
  const w = win();
  if (w.NavLink?.isNativeClick?.(event)) return;
  event.preventDefault();
  try { w.AppView?._landOnHub?.(slug); } catch { /* the page opens on what it remembers */ }
  w.App?.navigateToApp?.(slug, 'dev');
}

export function ActivityCardView({ communities, more, onMarkRead }: {
  communities: readonly ActivityCommunity[];
  more: number;
  onMarkRead: () => void;
}) {
  const t = useMessages('home');
  return (
    <section id="home-activity-card" className={CARD} aria-labelledby="home-activity-title">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 id="home-activity-title" className={TITLE}>{t('home:forYou.activity.title')}</h2>
          <p className={`${SUB} mt-0.5`}>{t('home:forYou.activity.since')}</p>
        </div>
        <button type="button" id="home-activity-read" className={HEAD_LINK} onClick={onMarkRead}>
          {t('home:forYou.activity.markRead')}
        </button>
      </div>
      <ul className="-mx-2 m-0 flex list-none flex-col p-0">
        {communities.map((c) => (
          <li key={c.slug}>
            <a
              href={`/app/${encodeURIComponent(c.slug)}/workshop`}
              className={ROW}
              data-home-activity={c.slug}
              onClick={(event) => openHub(event, c.slug)}
            >
              <SmallIcon slug={c.slug} name={c.name} iconUrl={c.iconUrl} iconEmoji={c.iconEmoji} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-[650] leading-5">{c.name}</span>
                <span className="flex flex-wrap gap-x-2.5 gap-y-0.5 text-[13px] leading-[1.125rem] text-zinc-600 dark:text-zinc-300">
                  {activityParts(c).map(({ kind, count }) => {
                    const Icon = KIND_ICON[kind];
                    return (
                      <span key={kind} className="inline-flex items-center gap-1" data-activity-kind={kind}>
                        <Icon className="h-3.5 w-3.5 shrink-0 text-zinc-400 dark:text-zinc-500" aria-hidden="true" />
                        {t(KIND_MESSAGE[kind], { count })}
                      </span>
                    );
                  })}
                </span>
              </span>
            </a>
          </li>
        ))}
      </ul>
      {more > 0 ? <p className={SUB}>{t('home:forYou.activity.more', { count: more })}</p> : null}
    </section>
  );
}

interface ActivityBody { communities?: ActivityCommunity[]; more?: number }

export function ActivityCard() {
  const shown = useVisibility('home-screen', true);
  const [body, setBody] = useState<ActivityBody | null>(null);
  useEffect(() => {
    if (!shown) return undefined;
    let live = true;
    void readJson<ActivityBody>(`/api/me/home-activity${demoQuery()}`).then((read) => { if (live && read) setBody(read); });
    return () => { live = false; };
  }, [shown]);
  const communities = body?.communities || [];
  // A zero says nothing: with nothing new, no card.
  if (!communities.length) return null;
  const markRead = () => {
    setBody({ communities: [], more: 0 });
    void fetch('/api/me/home-activity/seen', { method: 'POST', credentials: 'same-origin' }).catch(() => null);
  };
  return <ActivityCardView communities={communities} more={Number(body?.more) || 0} onMarkRead={markRead} />;
}

// ── Your work ───────────────────────────────────────────────────────────

export interface WorkBody {
  points: number;
  pointsWeek: number;
  changes: { total: number; waiting: number };
  requests: { total: number; open: number };
  votes: { cast: number };
}

function WorkRow({ icon, label, sub, value, href }: { icon: ReactNode; label: string; sub: string | null; value: number; href: string }) {
  return (
    <li>
      <a href={href} className={ROW}>
        <span className={CHIP_ICON} aria-hidden="true">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-[650] leading-5">{label}</span>
          {sub ? <span className="block truncate text-[13px] leading-[1.125rem] text-zinc-500 dark:text-zinc-400">{sub}</span> : null}
        </span>
        <span className="text-[17px] font-bold tabular-nums">{formatCount(value)}</span>
      </a>
    </li>
  );
}

export function WorkCardView({ work, owed }: { work: WorkBody; owed: number }) {
  const t = useMessages('home');
  return (
    <section id="home-work-card" className={CARD} aria-labelledby="home-work-title">
      <div className="flex items-baseline gap-2">
        <h2 id="home-work-title" className={`${TITLE} flex-1`}>{t('home:forYou.work.title')}</h2>
        <a href="#profile" className={HEAD_LINK}>{t('home:forYou.work.profile')}</a>
      </div>
      <a href="#profile" className="flex items-center gap-3 rounded-2xl bg-zinc-500/[0.07] px-3.5 py-3 text-zinc-900 no-underline dark:text-zinc-100">
        <TrophyIcon className="h-5 w-5 shrink-0 text-zinc-500 dark:text-zinc-400" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-xs text-zinc-500 dark:text-zinc-400">{t('home:forYou.work.points')}</span>
          <span className="block text-[26px] font-bold leading-8 tabular-nums tracking-tight">{formatCount(work.points)}</span>
        </span>
        {work.pointsWeek > 0 ? (
          <span className="shrink-0 text-xs font-bold text-[color:var(--state-ok)]" data-home-points-week={String(work.pointsWeek)}>
            {t('home:forYou.work.pointsWeek', { points: formatCount(work.pointsWeek), count: work.pointsWeek })}
          </span>
        ) : null}
      </a>
      <ul className="-mx-2 m-0 flex list-none flex-col p-0">
        <WorkRow
          icon={<CodeIcon className="h-4 w-4" aria-hidden="true" />}
          label={t('home:forYou.work.changes')}
          sub={work.changes.waiting ? t('home:forYou.work.changesWaiting', { count: work.changes.waiting }) : null}
          value={work.changes.total}
          href="#profile?tab=changes"
        />
        <WorkRow
          icon={<LightBulbIcon className="h-4 w-4" aria-hidden="true" />}
          label={t('home:forYou.work.requests')}
          sub={work.requests.open ? t('home:forYou.work.requestsOpen', { count: work.requests.open }) : null}
          value={work.requests.total}
          href="#profile?tab=requests"
        />
        <WorkRow
          icon={<BallotIcon className="h-4 w-4" aria-hidden="true" />}
          label={t('home:forYou.work.votes')}
          sub={owed ? t('home:forYou.work.votesOwed', { count: owed }) : null}
          value={work.votes.cast}
          href="#profile?tab=votes"
        />
      </ul>
    </section>
  );
}

export function WorkCard() {
  const shown = useVisibility('home-screen', true);
  const { badgeNeeds } = useStoreState(communityScopeStore) as { badgeNeeds?: number | null };
  const [work, setWork] = useState<WorkBody | null>(null);
  useEffect(() => {
    if (!shown) return undefined;
    let live = true;
    void readJson<WorkBody>(`/api/me/home-work${demoQuery()}`).then((read) => { if (live && read) setWork(read); });
    return () => { live = false; };
  }, [shown]);
  if (!work) return null;
  return <WorkCardView work={work} owed={Math.max(0, Number(badgeNeeds) || 0)} />;
}

// ── The column ──────────────────────────────────────────────────────────

export function HomeForYou() {
  const t = useMessages('home');
  // The prerender and the first client render agree: hidden and empty.
  const [viewer, setViewer] = useState(false);
  useEffect(() => whenPlatformViewer(() => setViewer(true)), []);
  const privateMember = viewer && !!win().App?.user?.privateMember;
  return (
    <aside id="home-for-you" className="home-for-you" hidden={!viewer} aria-label={t('home:forYou.label')}>
      {viewer && !privateMember ? <NewProjectCard /> : null}
      {viewer ? <NeedsCard /> : null}
      {viewer ? <ActivityCard /> : null}
      {viewer && !privateMember ? <WorkCard /> : null}
      <ChallengesSection limit={2} />
    </aside>
  );
}
