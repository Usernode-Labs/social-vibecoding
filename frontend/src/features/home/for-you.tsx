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
  ArrowUpTrayIcon, ChatIcon, CheckIcon, ChevronRightIcon, GitBranchIcon, PlusIcon,
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
const CARD_SHELL = 'flex min-w-0 flex-col rounded-[20px] bg-[color:var(--dc-sheet-solid)] shadow-[inset_0_0_0_1px_var(--app-sheet-line)]';
export const CARD = `${CARD_SHELL} gap-3 p-4`;
// The canvas's card titles (#6650): 17px bold, a 12px line under them.
const TITLE = 'm-0 text-[17px] font-bold leading-6 text-zinc-900 dark:text-zinc-100';
const SUB = 'm-0 text-xs leading-4 text-zinc-500 dark:text-zinc-400';
const HEAD_LINK = 'shrink-0 text-[13px] font-semibold text-[color:var(--accent)] hover:underline whitespace-nowrap un-touch-target';
const PRIMARY = 'inline-flex h-[52px] w-full items-center justify-center gap-2 rounded-full bg-zinc-900 px-5 text-base font-semibold text-white no-underline transition-colors hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white';
const ROW = 'flex min-h-[44px] items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-zinc-900 no-underline hover:bg-zinc-500/[0.06] dark:text-zinc-100';
const ICON = 'app-icon-tile flex h-[34px] w-[34px] shrink-0 items-center justify-center overflow-hidden rounded-[10px] text-base font-bold [&_.text-3xl]:text-xl';
const CHIP_ICON = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-[#f7f5ef] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300';

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
        <span className="h-2 w-2 shrink-0 rounded-full bg-[#2e9d5b]" aria-hidden="true" />
        <span>
          <b className="font-bold text-zinc-900 dark:text-zinc-100">{formatCount(remaining)}</b>{' '}
          {t('home:forYou.newProject.slotsWord', { count: remaining })}
        </span>
      </p>
    );
  }
  return (
    <p className="m-0 text-center text-[13px] leading-[1.45] text-zinc-600 dark:text-zinc-300" data-home-slots="0">
      {t('home:forYou.newProject.noSlots')}{' '}
      <a href="#profile?slots" className="font-semibold text-[color:var(--accent)] hover:underline">
        {t('home:forYou.newProject.requestSlots')}
      </a>{' '}
      {t('home:forYou.newProject.requestSlotsWhy')}
    </p>
  );
}

// The fan above the New project title (#6650): five faces, the middle one
// largest, tilted outwards, then the dashed + that is the project to come.
const FAN = [
  { size: 'h-[38px] w-[38px] rounded-[10px]', tilt: '-rotate-12' },
  { size: 'h-11 w-11 rounded-xl', tilt: '-rotate-[8deg]' },
  { size: 'h-14 w-14 rounded-[15px]', tilt: '' },
  { size: 'h-11 w-11 rounded-xl', tilt: 'rotate-[8deg]' },
  { size: 'h-[38px] w-[38px] rounded-[10px]', tilt: 'rotate-12' },
] as const;
// When the viewer has fewer than five apps of their own to show, the fan is
// filled with these, so the card never opens on an empty strip.
const FAN_FILL = [
  { emoji: '📚', bg: 'bg-amber-100 dark:bg-amber-900/40' },
  { emoji: '🍳', bg: 'bg-rose-100 dark:bg-rose-900/40' },
  { emoji: '🎓', bg: 'bg-sky-100 dark:bg-sky-900/40' },
  { emoji: '🐑', bg: 'bg-emerald-100 dark:bg-emerald-900/40' },
  { emoji: '🎮', bg: 'bg-violet-100 dark:bg-violet-900/40' },
] as const;

export function NewProjectCard() {
  const t = useMessages('home');
  const grid = useStoreState(gridStore);
  const [allowance, setAllowance] = useState<Allowance | null>(null);
  useEffect(() => {
    let live = true;
    void readJson<Allowance>('/api/me/app-allowance').then((body) => { if (live && body) setAllowance(body); });
    return () => { live = false; };
  }, []);
  // The viewer's own apps first (their pinned faces, as the grid draws
  // them), then the fill.
  const faces = useMemo(() => grid.items.slice(0, FAN.length).map((it) => it.app), [grid.items]);
  // Home.canCreate(): the account's own flag, which ?shot=create-enabled and
  // ?shot=create-disabled pin for the declared checks (home.js).
  const enabled = !!win().Home?.canCreate?.();
  const locked = t('home:communities.newLocked', { hint: t('home:create.disabledHint') });
  return (
    <section
      id="home-new-project"
      className="flex min-w-0 flex-col gap-3.5 overflow-hidden rounded-[20px] bg-[#f6f2fc] px-5 pb-5 pt-[22px] shadow-[inset_0_0_0_1px_#d9d0ec] dark:bg-[#201b2f] dark:shadow-[inset_0_0_0_1px_#3a3152]"
      aria-labelledby="home-new-project-title"
    >
      <div className="flex items-end gap-2" aria-hidden="true">
        {FAN.map((slot, i) => {
          const app = faces[i];
          const box = `flex shrink-0 items-center justify-center overflow-hidden ${slot.size} ${slot.tilt}`;
          if (!app) {
            const fill = FAN_FILL[i];
            return <span key={`fill-${i}`} className={`${box} ${fill.bg} text-xl`}>{fill.emoji}</span>;
          }
          return (
            <span key={app.slug} className={`app-icon-tile ${box} font-bold`} data-icon={app.icon.kind}>
              {app.icon.kind === 'image'
                ? <img src={app.icon.src} alt="" className="h-full w-full object-cover" loading="lazy" decoding="async" />
                : app.icon.kind === 'emoji' ? <span className="text-xl leading-none">{app.icon.emoji}</span> : app.icon.letter}
            </span>
          );
        })}
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border-2 border-dashed border-[#b9abd9] text-[#7a68b0] dark:border-[#5f5190] dark:text-[#b9aaec]">
          <PlusIcon className="h-5 w-5" strokeWidth="2.4" aria-hidden="true" />
        </span>
      </div>
      <div>
        <h2 id="home-new-project-title" className="m-0 text-[22px] font-bold leading-[1.2] tracking-[-0.01em] text-zinc-900 dark:text-zinc-100">
          {t('home:forYou.newProject.title')}
        </h2>
        <p className="m-0 mt-1.5 text-sm leading-[1.45] text-zinc-600 dark:text-zinc-300">{t('home:forYou.newProject.text')}</p>
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
        <PlusIcon className="h-[18px] w-[18px]" strokeWidth="2.6" aria-hidden="true" />
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
  uncounted?: boolean;
  app?: { slug?: string; name?: string; icon_url?: string | null; icon_emoji?: string | null };
}

/** A feed item whose vote does not decide: advisory, or recorded but not counted. */
export function isAdvisory(item: NeedsItem): boolean {
  return !!(item.advisory || item.uncounted);
}

/**
 * Pure: the badge's count and the feed → the card's numbers. Once the feed
 * is read, it is the one source: its length is the count (the Needs you
 * page lists exactly those), and its items say which decide and which are
 * advisory, so the bar, the tags on the next two and "Start reviewing · N"
 * agree. Until then, the badge's count, all of it on the deciding side.
 */
export function needsSplit(items: readonly NeedsItem[] | null, badge: number) {
  if (!items) return { count: badge, decide: badge, advisory: 0, next: [] as NeedsItem[] };
  const advisory = items.filter(isAdvisory).length;
  return { count: items.length, decide: items.length - advisory, advisory, next: items.slice(0, 2) };
}

/** The next decisions, each a way into Needs you, tagged decides or advisory. */
function NeedsRows({ next }: { next: readonly NeedsItem[] }) {
  const t = useMessages('home');
  if (!next.length) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
      {next.map((item, i) => (
        <li key={`${item.kind || 'item'}:${item.id ?? i}`}>
          <a href="#needs" className="flex min-h-[44px] items-center gap-2.5 rounded-xl bg-white px-2.5 py-[7px] text-zinc-900 no-underline shadow-[inset_0_0_0_1px_#e1e8f5] dark:bg-zinc-900 dark:text-zinc-100 dark:shadow-[inset_0_0_0_1px_#2e3443]">
            <span className="[&_.app-icon-tile]:h-[30px] [&_.app-icon-tile]:w-[30px] [&_.app-icon-tile]:rounded-lg">
              <SmallIcon slug={item.app?.slug || ''} name={item.app?.name || ''} iconUrl={item.app?.icon_url} iconEmoji={item.app?.icon_emoji} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">{item.app?.name || ''}</span>
              <span className="block truncate text-sm font-bold leading-[1.3]">{item.title || ''}</span>
            </span>
            <span className={isAdvisory(item)
              ? 'shrink-0 rounded-full bg-zinc-500/10 px-2 py-[3px] text-[11px] font-bold text-zinc-600 dark:text-zinc-300'
              : 'shrink-0 rounded-full bg-[#dce7fb] px-2 py-[3px] text-[11px] font-bold text-[#0b4fae] dark:bg-[#21345a] dark:text-[#9cc0ff]'}
            >
              {isAdvisory(item) ? t('home:forYou.needs.tagAdvisory') : t('home:forYou.needs.tagDecides')}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

export function NeedsCardView({ count: badge, items }: { count: number; items: readonly NeedsItem[] | null }) {
  const t = useMessages('home');
  const { count, decide, advisory, next } = needsSplit(items, badge);
  if (!count) return null;
  return (
    <section
      id="home-needs-card"
      className="flex min-w-0 flex-col gap-3 rounded-[20px] bg-[#f6f9ff] p-4 shadow-[inset_0_0_0_1px_#cddcf5] dark:bg-[#161f33] dark:shadow-[inset_0_0_0_1px_#2a3b5f]"
      aria-labelledby="home-needs-title"
      data-home-needs={String(count)}
    >
      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <p className="m-0 text-xs font-bold uppercase tracking-[0.08em] text-[#2a62c2] dark:text-[#7aa6f0]">{t('home:forYou.needs.label')}</p>
          <h2 id="home-needs-title" className="m-0 mt-0.5 text-lg font-bold leading-6 text-zinc-900 dark:text-zinc-100">{t('home:forYou.needs.title')}</h2>
        </div>
        <span className="text-[34px] font-bold leading-none tracking-[-0.03em] tabular-nums text-[#2a62c2] dark:text-[#7aa6f0]" aria-hidden="true">{count > 99 ? '99+' : count}</span>
      </div>
      <div>
        <div className="flex h-2 gap-[3px]" role="img" aria-label={t('home:forYou.needs.split', { decide, advisory })}>
          {decide ? <span className="rounded-full bg-[#5b8fe6]" style={{ flex: decide }} /> : null}
          {advisory ? <span className="rounded-full bg-[#c6d8f6] dark:bg-[#2c4170]" style={{ flex: advisory }} /> : null}
        </div>
        <div className="mt-1.5 flex justify-between text-xs text-zinc-600 dark:text-zinc-300">
          <span><b className="font-bold text-zinc-900 dark:text-zinc-100">{decide}</b> {t('home:forYou.needs.decideWord', { count: decide })}</span>
          {advisory ? <span><b className="font-bold text-zinc-900 dark:text-zinc-100">{advisory}</b> {t('home:forYou.needs.advisoryWord', { count: advisory })}</span> : null}
        </div>
      </div>
      <NeedsRows next={next} />
      <a
        href="#needs"
        id="home-needs-review"
        className="inline-flex h-11 w-full items-center justify-center rounded-full bg-[#2a62c2] px-[18px] text-sm font-semibold text-white no-underline hover:bg-[#2457b0] dark:bg-[#3d78e0]"
        aria-label={t('home:communities.needsNamed', { count })}
      >
        {t('home:forYou.needs.review', { count })}
      </a>
    </section>
  );
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
  merged: GitBranchIcon,
  requests: ArrowUpTrayIcon,
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

/** One row per community with news: what happened there, kind by kind. */
function ActivityRows({ communities }: { communities: readonly ActivityCommunity[] }) {
  const t = useMessages('home');
  return (
    <ul className="m-0 flex list-none flex-col p-0">
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
              <span className="block truncate text-sm font-bold leading-5">{c.name}</span>
              <span className="flex flex-wrap gap-x-1.5 gap-y-0.5 text-xs leading-4 text-zinc-600 dark:text-zinc-300">
                {activityParts(c).map(({ kind, count }, i) => {
                  const Icon = KIND_ICON[kind];
                  return (
                    <span key={kind} className="inline-flex items-center gap-1.5">
                      {i ? <span aria-hidden="true">·</span> : null}
                      <span className="inline-flex items-center gap-1" data-activity-kind={kind}>
                        <Icon className="h-[13px] w-[13px] shrink-0" strokeWidth="2.2" aria-hidden="true" />
                        {t(KIND_MESSAGE[kind], { count })}
                      </span>
                    </span>
                  );
                })}
              </span>
            </span>
            <ChevronRightIcon className="h-4 w-4 shrink-0 text-zinc-400 dark:text-zinc-500" aria-hidden="true" />
          </a>
        </li>
      ))}
    </ul>
  );
}

export function ActivityCardView({ communities, more, onMarkRead }: {
  communities: readonly ActivityCommunity[];
  more: number;
  onMarkRead: () => void;
}) {
  const t = useMessages('home');
  return (
    <section id="home-activity-card" className={`${CARD_SHELL} gap-1 px-3 pb-2.5 pt-4`} aria-labelledby="home-activity-title">
      <div className="flex items-start gap-2.5 px-1.5 pb-1.5">
        <div className="min-w-0 flex-1">
          <h2 id="home-activity-title" className={TITLE}>{t('home:forYou.activity.title')}</h2>
          <p className={`${SUB} mt-0.5`}>{t('home:forYou.activity.since')}</p>
        </div>
        <button type="button" id="home-activity-read" className={HEAD_LINK} onClick={onMarkRead}>
          {t('home:forYou.activity.markRead')}
        </button>
      </div>
      <ActivityRows communities={communities} />
      {more > 0 ? <p className={`${SUB} px-2 pt-1`}>{t('home:forYou.activity.more', { count: more })}</p> : null}
    </section>
  );
}

interface ActivityBody { communities?: ActivityCommunity[]; more?: number }

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
          <span className="block text-sm font-bold leading-5">{label}</span>
          {sub ? <span className="block truncate text-xs leading-4 text-zinc-500 dark:text-zinc-400">{sub}</span> : null}
        </span>
        <span className="text-lg font-bold tabular-nums">{formatCount(value)}</span>
      </a>
    </li>
  );
}

/** The viewer's changes, requests and votes, each with where it stands. */
function WorkRows({ work, owed }: { work: WorkBody; owed: number }) {
  const t = useMessages('home');
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      <WorkRow
        icon={<GitBranchIcon className="h-4 w-4" strokeWidth="2.1" aria-hidden="true" />}
        label={t('home:forYou.work.changes')}
        sub={work.changes.waiting ? t('home:forYou.work.changesWaiting', { count: work.changes.waiting }) : null}
        value={work.changes.total}
        href="#profile?tab=changes"
      />
      <WorkRow
        icon={<ArrowUpTrayIcon className="h-4 w-4" strokeWidth="2.1" aria-hidden="true" />}
        label={t('home:forYou.work.requests')}
        sub={work.requests.open ? t('home:forYou.work.requestsOpen', { count: work.requests.open }) : null}
        value={work.requests.total}
        href="#profile?tab=requests"
      />
      <WorkRow
        icon={<CheckIcon className="h-4 w-4" strokeWidth="2.2" aria-hidden="true" />}
        label={t('home:forYou.work.votes')}
        sub={owed ? t('home:forYou.work.votesOwed', { count: owed }) : null}
        value={work.votes.cast}
        href="#profile?tab=votes"
      />
    </ul>
  );
}

export function WorkCardView({ work, owed }: { work: WorkBody; owed: number }) {
  const t = useMessages('home');
  return (
    <section id="home-work-card" className={`${CARD_SHELL} gap-2.5 p-4`} aria-labelledby="home-work-title">
      <div className="flex items-baseline gap-2.5">
        <h2 id="home-work-title" className={`${TITLE} flex-1`}>{t('home:forYou.work.title')}</h2>
        <a href="#profile" className={HEAD_LINK}>{t('home:forYou.work.profile')}</a>
      </div>
      <a href="#profile" className="flex items-center gap-3 rounded-[14px] bg-[#f7f5ef] px-3.5 py-3 text-zinc-900 no-underline dark:bg-zinc-800 dark:text-zinc-100">
        <span className="min-w-0 flex-1">
          <span className="block text-xs text-zinc-500 dark:text-zinc-400">{t('home:forYou.work.points')}</span>
          <span className="block text-[26px] font-bold leading-8 tabular-nums tracking-[-0.02em]">{formatCount(work.points)}</span>
        </span>
        {work.pointsWeek > 0 ? (
          <span className="shrink-0 rounded-full bg-[#dcf2e4] px-[9px] py-1 text-xs font-bold text-[#1f7a45] dark:bg-[#183a27] dark:text-[#6fd39a]" data-home-points-week={String(work.pointsWeek)}>
            {t('home:forYou.work.pointsWeek', { points: formatCount(work.pointsWeek), count: work.pointsWeek })}
          </span>
        ) : null}
      </a>
      <WorkRows work={work} owed={owed} />
    </section>
  );
}

// ── The data, read once for the full cards and the phone card ──────────

/** The Needs you feed, read while votes wait and Home is on screen. */
function useNeedsFeed(enabled: boolean, badge: number) {
  const shown = useVisibility('home-screen', true);
  const [items, setItems] = useState<NeedsItem[] | null>(null);
  useEffect(() => {
    if (!enabled || !badge || !shown) return undefined;
    let live = true;
    void readJson<{ items?: NeedsItem[] }>(`/api/workshop/needs-feed${demoQuery()}`).then((body) => {
      if (live && body) setItems(Array.isArray(body.items) ? body.items : []);
    });
    return () => { live = false; };
  }, [enabled, badge, shown]);
  return items;
}

/** What is new in the viewer's communities, and Mark all read. */
function useActivity(enabled: boolean) {
  const shown = useVisibility('home-screen', true);
  const [body, setBody] = useState<ActivityBody | null>(null);
  useEffect(() => {
    if (!enabled || !shown) return undefined;
    let live = true;
    void readJson<ActivityBody>(`/api/me/home-activity${demoQuery()}`).then((read) => { if (live && read) setBody(read); });
    return () => { live = false; };
  }, [enabled, shown]);
  const markRead = () => {
    setBody({ communities: [], more: 0 });
    void fetch('/api/me/home-activity/seen', { method: 'POST', credentials: 'same-origin' }).catch(() => null);
  };
  return { communities: body?.communities || [], more: Number(body?.more) || 0, markRead };
}

/** The viewer's own numbers. */
function useWork(enabled: boolean) {
  const shown = useVisibility('home-screen', true);
  const [work, setWork] = useState<WorkBody | null>(null);
  useEffect(() => {
    if (!enabled || !shown) return undefined;
    let live = true;
    void readJson<WorkBody>(`/api/me/home-work${demoQuery()}`).then((read) => { if (live && read) setWork(read); });
    return () => { live = false; };
  }, [enabled, shown]);
  return work;
}

// ── The phone card ──────────────────────────────────────────────────────

/** Pure: everything new, summed, and how many communities it is in. */
export function activityTotal(communities: readonly ActivityCommunity[], more: number) {
  const total = communities.reduce((n, c) => n + c.messages + c.merged + c.requests, 0);
  return { total, places: communities.length + Math.max(0, more) };
}

type GlanceKey = 'needs' | 'new' | 'work';
const GLANCE_TILE = 'flex min-w-0 flex-col items-center justify-center gap-1 rounded-[14px] px-2 py-3 text-center text-zinc-900 dark:text-zinc-100';
const GLANCE_LABEL = 'text-[11px] font-bold uppercase tracking-[0.06em]';
const GLANCE_NUMBER = 'text-[28px] font-bold leading-none tracking-[-0.03em] tabular-nums';

/**
 * #6650, on a phone: Needs you, New in your communities and Your work as ONE
 * card of numbers, side by side, centred. Each number is a button: it opens
 * that part's detail inside the card (the vote split and the next
 * decisions; the communities and what happened in each, with Mark all read;
 * the viewer's changes, requests and votes), and pressing it again closes
 * it. No button under the tiles: the tiles are the way in.
 */
export function GlanceCardView({ needs, activity, work, owed, initialOpen = null }: {
  needs: { count: number; decide: number; advisory: number; next: readonly NeedsItem[] };
  activity: { communities: readonly ActivityCommunity[]; more: number; onMarkRead: () => void };
  work: WorkBody | null;
  owed: number;
  initialOpen?: GlanceKey | null;
}) {
  const t = useMessages('home');
  const [open, setOpen] = useState<GlanceKey | null>(initialOpen);
  const toggle = (key: GlanceKey) => () => setOpen((now) => (now === key ? null : key));
  const { total, places } = activityTotal(activity.communities, activity.more);
  const tileRing = (key: GlanceKey, tint: boolean) => {
    const base = tint
      ? 'bg-[#f6f9ff] dark:bg-[#161f33]'
      : 'bg-[#f7f5ef] dark:bg-zinc-800';
    if (open === key) return `${base} shadow-[inset_0_0_0_2px_#2a62c2] dark:shadow-[inset_0_0_0_2px_#3d78e0]`;
    return `${base} ${tint ? 'shadow-[inset_0_0_0_1px_#cddcf5] dark:shadow-[inset_0_0_0_1px_#2a3b5f]' : 'shadow-[inset_0_0_0_1px_var(--app-sheet-line)]'}`;
  };
  return (
    <section id="home-glance-card" className={`${CARD} home-for-you-glance`} aria-label={t('home:forYou.label')}>
      <div className={`grid gap-2 ${work ? 'grid-cols-3' : 'grid-cols-2'}`}>
        <button
          type="button"
          className={`${GLANCE_TILE} ${tileRing('needs', true)}`}
          aria-expanded={open === 'needs'}
          aria-controls="home-glance-detail"
          aria-label={t('home:forYou.glance.needsAria', { count: needs.count })}
          data-glance="needs"
          onClick={toggle('needs')}
        >
          <span className={`${GLANCE_LABEL} text-[#2a62c2] dark:text-[#7aa6f0]`}>{t('home:forYou.needs.label')}</span>
          <b className={`${GLANCE_NUMBER} text-[#2a62c2] dark:text-[#7aa6f0]`}>{needs.count > 99 ? '99+' : needs.count}</b>
          <span className="text-xs leading-4 text-zinc-600 dark:text-zinc-300">{t('home:forYou.glance.decisions', { count: needs.count })}</span>
        </button>
        <button
          type="button"
          className={`${GLANCE_TILE} ${tileRing('new', false)}`}
          aria-expanded={open === 'new'}
          aria-controls="home-glance-detail"
          aria-label={t('home:forYou.glance.newAria', { count: total })}
          data-glance="new"
          onClick={toggle('new')}
        >
          <span className={`${GLANCE_LABEL} text-zinc-500 dark:text-zinc-400`}>{t('home:forYou.glance.new')}</span>
          <b className={GLANCE_NUMBER}>{formatCount(total)}</b>
          <span className="text-xs leading-4 text-zinc-600 dark:text-zinc-300">
            {total ? t('home:forYou.glance.inCommunities', { count: places }) : t('home:forYou.glance.caughtUp')}
          </span>
        </button>
        {work ? (
          <button
            type="button"
            className={`${GLANCE_TILE} ${tileRing('work', false)}`}
            aria-expanded={open === 'work'}
            aria-controls="home-glance-detail"
            aria-label={t('home:forYou.glance.workAria', { points: formatCount(work.points), count: work.points })}
            data-glance="work"
            onClick={toggle('work')}
          >
            <span className={`${GLANCE_LABEL} text-zinc-500 dark:text-zinc-400`}>{t('home:forYou.work.points')}</span>
            <b className={GLANCE_NUMBER}>{formatCount(work.points)}</b>
            <span className={work.pointsWeek > 0 ? 'text-xs font-bold leading-4 text-[#1f7a45] dark:text-[#6fd39a]' : 'text-xs leading-4 text-zinc-600 dark:text-zinc-300'}>
              {work.pointsWeek > 0
                ? t('home:forYou.work.pointsWeek', { points: formatCount(work.pointsWeek), count: work.pointsWeek })
                : t('home:forYou.work.title')}
            </span>
          </button>
        ) : null}
      </div>
      <div id="home-glance-detail" hidden={!open}>
        {open === 'needs' ? <GlanceNeeds needs={needs} /> : null}
        {open === 'new' ? <GlanceNew activity={activity} /> : null}
        {open === 'work' && work ? <GlanceWork work={work} owed={owed} /> : null}
      </div>
    </section>
  );
}

function GlanceNeeds({ needs }: { needs: { count: number; decide: number; advisory: number; next: readonly NeedsItem[] } }) {
  const t = useMessages('home');
  if (!needs.count) return <p className={`${SUB} py-2 text-center`}>{t('home:forYou.glance.noVotes')}</p>;
  return (
    <div className="flex flex-col gap-2">
      <div>
        <div className="flex h-2 gap-[3px]" role="img" aria-label={t('home:forYou.needs.split', { decide: needs.decide, advisory: needs.advisory })}>
          {needs.decide ? <span className="rounded-full bg-[#5b8fe6]" style={{ flex: needs.decide }} /> : null}
          {needs.advisory ? <span className="rounded-full bg-[#c6d8f6] dark:bg-[#2c4170]" style={{ flex: needs.advisory }} /> : null}
        </div>
        <div className="mt-1.5 flex justify-between text-xs text-zinc-600 dark:text-zinc-300">
          <span><b className="font-bold text-zinc-900 dark:text-zinc-100">{needs.decide}</b> {t('home:forYou.needs.decideWord', { count: needs.decide })}</span>
          {needs.advisory ? <span><b className="font-bold text-zinc-900 dark:text-zinc-100">{needs.advisory}</b> {t('home:forYou.needs.advisoryWord', { count: needs.advisory })}</span> : null}
        </div>
      </div>
      <NeedsRows next={needs.next} />
    </div>
  );
}

function GlanceNew({ activity }: { activity: { communities: readonly ActivityCommunity[]; more: number; onMarkRead: () => void } }) {
  const t = useMessages('home');
  if (!activity.communities.length) return <p className={`${SUB} py-2 text-center`}>{t('home:forYou.glance.caughtUpLine')}</p>;
  return (
    <div className="flex flex-col">
      <ActivityRows communities={activity.communities} />
      {activity.more > 0 ? <p className={`${SUB} px-2 pt-1`}>{t('home:forYou.activity.more', { count: activity.more })}</p> : null}
      <button type="button" id="home-glance-read" className={`${HEAD_LINK} self-end px-1 pt-1`} onClick={activity.onMarkRead}>
        {t('home:forYou.activity.markRead')}
      </button>
    </div>
  );
}

function GlanceWork({ work, owed }: { work: WorkBody; owed: number }) {
  return <WorkRows work={work} owed={owed} />;
}

// ── The column ──────────────────────────────────────────────────────────

export function HomeForYou() {
  const t = useMessages('home');
  // The prerender and the first client render agree: hidden and empty.
  const [viewer, setViewer] = useState(false);
  useEffect(() => whenPlatformViewer(() => setViewer(true)), []);
  const privateMember = viewer && !!win().App?.user?.privateMember;
  const { badgeNeeds } = useStoreState(communityScopeStore) as { badgeNeeds?: number | null };
  const badge = Math.max(0, Number(badgeNeeds) || 0);
  const items = useNeedsFeed(viewer, badge);
  const activity = useActivity(viewer);
  const work = useWork(viewer && !privateMember);
  const needs = needsSplit(items, badge);
  return (
    <aside id="home-for-you" className="home-for-you" hidden={!viewer} aria-label={t('home:forYou.label')}>
      {viewer && !privateMember ? <NewProjectCard /> : null}
      {/* Wider than a phone: three cards, each in a cell of the column's
          grid (app.css .home-for-you-full is display: contents). */}
      <div className="home-for-you-full">
        {viewer && needs.count ? <NeedsCardView count={badge} items={items} /> : null}
        {viewer && activity.communities.length
          ? <ActivityCardView communities={activity.communities} more={activity.more} onMarkRead={activity.markRead} />
          : null}
        {viewer && work ? <WorkCardView work={work} owed={badge} /> : null}
      </div>
      {/* A phone: the same three as one card of numbers (app.css). */}
      {viewer ? (
        <GlanceCardView
          needs={needs}
          activity={{ communities: activity.communities, more: activity.more, onMarkRead: activity.markRead }}
          work={work}
          owed={badge}
        />
      ) : null}
      <ChallengesSection limit={2} />
    </aside>
  );
}
