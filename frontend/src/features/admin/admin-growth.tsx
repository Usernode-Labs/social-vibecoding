// Growth: the Journey page's views since it became the Growth dashboard.
// What newcomers do since the landing page went live (14 Sep 2026), counted
// in groups, not accounts. One reading, GET /api/admin/journey/growth
// (src/services/growth.js), filtered here: when, who, compare and scope.
//
// Every label is a term: tap it and it says what it counts (Journey's
// mileLabel pattern; a phone has no hover). Nothing from the API is drawn as
// a link. Every number or bar that counts people opens them in one sidebar
// (PeopleDrawer), where a person opens in Journey's own person view.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AdminUI } from './admin-console.js';

// ── Payload ────────────────────────────────────────────────────────────

export type GrowthPerson = {
  key: string;
  userId: number | null;
  name: string | null;
  early: boolean;
  seasonEarly: boolean;
  connected: boolean;
  way: 'waitlist' | 'link' | 'signup';
  admittedDay: string | null;
  cameAt: string | null;
  heard: string | null;
  mail: 'clicked' | 'opened' | 'sent' | 'not_on_record' | null;
  opened: boolean;
  stayed: boolean;
  lastSeen: string | null;
  activeWeeks: string[];
  last7: { opened: boolean; used: boolean; contributed: boolean; analyticsWau: boolean };
};

export type GrowthGroup = {
  appId: number;
  weeks: string[];
  people: number[];
  cameBack: boolean;
  name: string | null;
  slug: string | null;
  private: boolean;
  madeAt: string | null;
  builds: number;
  firstBuildMinutes: number | null;
};

export type GrowthData = {
  demo: boolean;
  eraStart: string;
  groupMin: number;
  staySeconds: number;
  weeks: string[];
  thisWeek: string;
  people: GrowthPerson[];
  groups: { newcomers: GrowthGroup[]; everyone: GrowthGroup[] };
};

type Timeline = { appId: number; events: Array<{ kind: string; at: string; userId: number | null; until: string | null }> };

// ── Recipes (complete literals: Tailwind reads this file as text) ──────

const G = Object.freeze({
  card: `${AdminUI.card} p-4 sm:p-5`,
  title: 'text-base font-semibold text-zinc-900 dark:text-zinc-100',
  label: 'text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400',
  fine: 'text-xs text-zinc-500 dark:text-zinc-400',
  big: 'text-4xl font-semibold leading-none tabular-nums text-zinc-900 dark:text-zinc-100',
  pill: 'inline-flex h-6 items-center rounded-full px-3 text-xs font-medium transition-colors',
  pillOn: 'bg-violet-600 text-white',
  pillOff: 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700',
  pillCmpOn: 'bg-amber-600 text-white',
  stepper: 'inline-flex h-6 w-6 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-40',
  term: 'text-start underline decoration-dotted decoration-zinc-400 dark:decoration-zinc-500 underline-offset-4 hover:text-zinc-900 dark:hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 rounded',
  help: 'rounded-lg bg-zinc-900 dark:bg-zinc-100 px-3 py-2 text-xs leading-snug text-white dark:text-zinc-900 max-w-md',
  track: 'h-3 rounded bg-zinc-100 dark:bg-zinc-800 overflow-hidden',
  link: 'text-xs font-medium text-violet-700 dark:text-violet-400 hover:underline',
  row: 'flex items-center justify-between gap-2 py-2 border-b border-zinc-100 dark:border-zinc-800/60 last:border-b-0',
  check: 'h-4 w-4 accent-violet-600',
  count: 'rounded tabular-nums underline-offset-2 enabled:hover:underline enabled:hover:text-violet-700 enabled:dark:hover:text-violet-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 disabled:cursor-default',
  countRow: 'w-full rounded-md text-start enabled:hover:bg-zinc-50 dark:enabled:hover:bg-zinc-800/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 disabled:cursor-default',
});

// ── Small helpers ──────────────────────────────────────────────────────

const DAY = 86400000;

function weekOf(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back)).toISOString().slice(0, 10);
}

function dayLabel(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
}

function pct(n: number, of: number): string {
  return of ? `${Math.round((n / of) * 100)}%` : '–';
}

function people(n: number): string {
  return n === 1 ? '1 person' : `${n} people`;
}

const WAYS: Array<[GrowthPerson['way'], string]> = [['waitlist', 'Waitlist'], ['link', 'Friend’s invite link'], ['signup', 'Signed up, not let in']];
const WAY_NAME: Record<GrowthPerson['way'], string> = { waitlist: 'Waitlist', link: 'Friend’s link', signup: 'Signed up' };
const STEPS = ['Let in', 'Opened Homeroom', 'Stayed 30 s+', 'Used it with a group', 'Came back together'];
const STEP_SHORT = ['Let in', 'Opened', 'Stayed 30 s+', 'With a group', 'Came back'];

// ── Help terms ─────────────────────────────────────────────────────────

const HELP: Record<string, string> = {
  view: 'Which part of the reading to show. The filters above apply to every view.',
  when: 'Newcomers are picked by the week they came in (let in, or joined), then followed through every later step. Weekly charts count activity in a week instead and fade the weeks outside the choice.',
  who: 'Excluding Season 1: only people who came since 14 Sep and were not brought in by the early community. Including Season 1: everyone real.',
  leftOut: 'Who the current choice removes. Team, admins, test accounts and the Left out list are never counted.',
  back: 'Groups that acted together in a week and again in a later week. The north star: a group using Homeroom as a habit.',
  together: 'Projects where 3 or more people in scope started a change, voted or wrote in the same week.',
  stayed: '30 seconds or more in any app on some day.',
  opened: 'Any trace inside Homeroom: a page view, a visit to an app, a message, a vote, a project or a request. A floor: a visit can leave no trace.',
  funnel: 'Each band is a step; its width is the share of people still there out of those let in. The light shapes show how many were kept from the step before. Click a band for its people.',
  compare: 'Draw a cohort on top of the funnel as a thin band, with its own percentages. Percentages are of that cohort’s own start, so cohorts of different sizes compare fairly.',
  s0: 'Let in from the waitlist, joined through a friend’s invite link, or signed up without being let in.',
  s1: 'Any trace inside Homeroom. A floor, since a visit can leave no trace.',
  s2: 'Spent 30 seconds or more in any app. Everyone between the last step and this one opened Homeroom and left within 30 seconds.',
  s3: 'Acted in a project (started a change, voted or wrote) in a week when 3 or more people in scope did.',
  s4: 'Their group acted together again in a later week. This is the north star.',
  mail: 'Waitlist admits only. On record: the admit mail is in Homeroom’s mail log, which keeps 30 days. Opened is not reliable, because image proxies can trigger it; only Clicked counts.',
  drop: 'The funnel step that keeps the smallest share of the step before it.',
  wLet: 'People by the week they came in.',
  wActive: 'People with 30 seconds or more in an app, or an act, that week.',
  wGroups: 'Projects where 3 or more people in scope acted that week.',
  retention: 'People grouped by the first week they were active since 14 Sep. Each cell shows how many of them were active again N weeks later.',
  wau: 'Admin › Analytics counts anyone with any app heartbeat (even a second), a message, vote, kudos or request in the last 7 days. It leaves out admins and tests but keeps Season 1.',
  wauDid: 'What the people in that WAU did in the same 7 days, each counted once at their deepest. Acted: wrote a message, voted, filed a request or started a change. Stayed: 30 seconds or more in an app, no act. Glanced: under 30 seconds in an app, or only gave kudos.',
  lifeNew: 'Active this week for the first time.',
  lifeReturning: 'Active this week and the week before.',
  lifeResurrecting: 'Active this week, not the week before, but some week earlier.',
  lifeDormant: 'Active the week before, not this week. Drawn below the line.',
  lifecycle: 'Each week’s active people split four ways. New: active for the first time. Returning: active this week and last. Resurrecting: active this week, not last, but before. Dormant (below the line): active last week, not this one.',
  l4: 'Of people active at least once in the last 4 weeks, how many weeks each was active. Many at 3 or 4 means a habit.',
  depth: 'The last 7 days, from any trace to acting in a group.',
  groupsTable: 'Every project where 3 or more people in scope acted in the same week. Click a group to see its sessions.',
  weeksCol: 'One square per week since 14 Sep, filled for the weeks the group was active together.',
  firstBuild: 'Time from the project being made to its first change going live.',
  ways: 'How people came in. Only a friend’s invite link says why: somebody brought them.',
  heard: 'The optional answer on the waitlist form: self-reported, often blank.',
  scopeWays: 'Which ways in to count.',
  scopeDays: 'Which admit days to count. Never admitted means they signed up but are still waiting.',
  saved: 'A saved scope becomes a cohort under Compare on the Overview. It is kept in this browser.',
};

function useHelp() {
  const [open, setOpen] = useState<string | null>(null);
  const term = (id: string, label: ReactNode) => (
    <button type="button" className={G.term} aria-expanded={open === id} data-growth-term={id}
      onClick={() => setOpen(open === id ? null : id)}>{label}</button>
  );
  // The words float over what follows, so opening them never moves the page.
  const help = (...ids: string[]) => (open && ids.includes(open) ? (
    <div className="relative h-0">
      <p className={`${G.help} absolute start-0 top-1 z-30 w-max max-w-[min(28rem,calc(var(--platform-float-w)-24px))] shadow-lg`} role="note">{HELP[open]}</p>
    </div>
  ) : null);
  return { term, help };
}

// ── Saved cohorts (this browser) ───────────────────────────────────────

const SAVED_KEY = 'homeroom.admin.growth.cohorts';
type Saved = { name: string; ways: GrowthPerson['way'][]; days: string[] };

function readSaved(): Saved[] {
  try {
    const raw = window.localStorage.getItem(SAVED_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((c) => c && typeof c.name === 'string') : [];
  } catch {
    return [];
  }
}

function writeSaved(list: Saved[]): void {
  try { window.localStorage.setItem(SAVED_KEY, JSON.stringify(list)); } catch { /* private mode: keep it in memory */ }
}

// ── The reading, filtered ──────────────────────────────────────────────

type When = { kind: 'all' | 'last4' | 'week'; week: string };
type Who = 'newcomers' | 'everyone';
type Cohort = { key: string; label: string; match: (p: GrowthPerson) => boolean };

function useReading(data: GrowthData, who: Who, when: When) {
  return useMemo(() => {
    const inWho = (p: GrowthPerson) => who === 'everyone' || (!p.early && !p.connected);
    const lastIdx = data.weeks.length - 1;
    const last4From = data.weeks[Math.max(0, lastIdx - 3)];
    const inWhen = (p: GrowthPerson) => {
      if (when.kind === 'all') return true;
      const w = weekOf(p.cameAt);
      if (!w) return false;
      return when.kind === 'week' ? w === when.week : w >= last4From;
    };
    const groups = who === 'everyone' ? data.groups.everyone : data.groups.newcomers;
    const inGroup = new Map<number, { grp: boolean; back: boolean; appIds: number[] }>();
    for (const g of groups) {
      for (const id of g.people) {
        const cur = inGroup.get(id) || { grp: false, back: false, appIds: [] };
        cur.grp = true;
        cur.back = cur.back || g.cameBack;
        cur.appIds.push(g.appId);
        inGroup.set(id, cur);
      }
    }
    const scoped = data.people.filter((p) => inWho(p) && inWhen(p));
    const reached = (p: GrowthPerson): number => {
      const g = p.userId ? inGroup.get(p.userId) : undefined;
      if (g?.back) return 4;
      if (g?.grp) return 3;
      if (p.stayed) return 2;
      if (p.opened) return 1;
      return 0;
    };
    const funnel = (list: GrowthPerson[]) => [0, 1, 2, 3, 4].map((s) => list.filter((p) => reached(p) >= s).length);
    const ids = new Set(scoped.map((p) => p.userId).filter((id): id is number => id != null));
    const groupsInScope = groups.filter((g) => g.people.some((id) => ids.has(id)));
    const whoPeople = data.people.filter(inWho);
    // The people in scope who acted in any of these groups.
    const peopleOfGroups = (gs: GrowthGroup[]) => {
      const set = new Set(gs.flatMap((g) => g.people));
      return whoPeople.filter((p) => p.userId != null && set.has(p.userId));
    };
    return { inWho, inWhen, scoped, reached, funnel, groups, groupsInScope, whoPeople, peopleOfGroups, last4From };
  }, [data, who, when]);
}

function cohortsFor(data: GrowthData, saved: Saved[]): Cohort[] {
  const days = [...new Set(data.people.map((p) => p.admittedDay).filter((d): d is string => !!d))].sort().reverse();
  const out: Cohort[] = WAYS.map(([w, label]) => ({ key: `way:${w}`, label, match: (p) => p.way === w }));
  for (const d of days) out.push({ key: `day:${d}`, label: `Let in ${dayLabel(d)}`, match: (p) => p.admittedDay === d });
  saved.forEach((c, i) => out.push({
    key: `saved:${i}`, label: c.name,
    match: (p) => c.ways.includes(p.way) && c.days.includes(p.admittedDay || 'never'),
  }));
  return out;
}

// ── People behind a number ─────────────────────────────────────────────

// Every number or bar that counts people opens them in the one sidebar the
// page owns. A list is computed where the number is, from the same filter, so
// the sidebar always shows exactly the people the number counted.
type PeopleList = { kicker: string; title: string; list: GrowthPerson[]; pick?: number };
const PeopleCtx = createContext<(l: PeopleList) => void>(() => {});

function Count({ list, kicker, title, row = false, className = '', style, children }: {
  list: GrowthPerson[]; kicker: string; title: string; row?: boolean; className?: string; style?: CSSProperties; children: ReactNode;
}) {
  const show = useContext(PeopleCtx);
  return (
    <button type="button" data-growth-count="" disabled={!list.length} aria-label={`${people(list.length)}: ${title}. List them`}
      className={`${row ? G.countRow : G.count} ${className}`} style={style} onClick={() => show({ kicker, title, list })}>{children}</button>
  );
}

// ── Shared pieces ──────────────────────────────────────────────────────

function Pill({ on, onClick, children, cmp = false, id }: { on: boolean; onClick: () => void; children: ReactNode; cmp?: boolean; id?: string }) {
  return (
    <button type="button" id={id} aria-pressed={on} onClick={onClick}
      className={`${G.pill} ${on ? (cmp ? G.pillCmpOn : G.pillOn) : G.pillOff}`}>{children}</button>
  );
}

function Tile({ id, term, value, unit, north = false, peopleOf }: {
  id?: string; term: ReactNode; value: number | string; unit: string; north?: boolean; peopleOf: PeopleList;
}) {
  return (
    <div className={`${G.card} flex flex-col gap-2 ${north ? 'ring-2 ring-zinc-900 dark:ring-zinc-100' : ''}`} id={id}>
      <div className="flex items-center justify-between gap-2">
        <span className={G.title}>{term}</span>
        {north ? <span className={AdminUI.badge.outline}>North star</span> : null}
      </div>
      <Count {...peopleOf} className={`${G.big} self-start`}>{value}</Count>
      <div className="flex items-center justify-between gap-2">
        <span className={G.fine}>{unit}</span>
        <Count {...peopleOf} className={G.link}>People ›</Count>
      </div>
    </div>
  );
}

function Bars({ values, labels, fade, tone, lists }: {
  values: number[]; labels: string[]; fade: (i: number) => boolean; tone: string; lists: Array<PeopleList>;
}) {
  const max = Math.max(1, ...values);
  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${values.length}, minmax(0, 1fr))` }}>
      {values.map((v, i) => (
        <Count key={`b${i}`} row {...lists[i]} className={`flex h-28 flex-col items-center justify-end gap-0.5 rounded-b-none border-b border-zinc-200 dark:border-zinc-800 ${fade(i) ? 'opacity-30' : ''}`}>
          <span className="text-[11px] font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{v || ''}</span>
          <span className={`block w-full max-w-[26px] rounded-t ${tone}`} style={{ height: `${v ? Math.max(3, (v / max) * 90) : 0}px` }} />
        </Count>
      ))}
      {labels.map((l, i) => <span key={`l${i}`} className="pt-1 text-center text-[10px] text-zinc-500 dark:text-zinc-400 whitespace-nowrap">{l}</span>)}
    </div>
  );
}

function Drawer({ title, kicker, onClose, children, wide = false }: { title: string; kicker: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const panel = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    panel.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} data-growth-drawer=""
        className={`h-full w-full ${wide ? 'max-w-4xl' : 'max-w-md'} overflow-y-auto bg-white dark:bg-zinc-900 p-5 shadow-xl outline-none flex flex-col gap-3`}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <span className={G.label}>{kicker}</span>
            <h3 className={AdminUI.sectionTitle}>{title}</h3>
          </div>
          <button type="button" className={`${AdminUI.btn.ghost} text-xl leading-none px-1`} aria-label="Close" onClick={onClose}>×</button>
        </div>
        {children}
      </aside>
    </div>
  );
}

// ── The page ───────────────────────────────────────────────────────────

const VIEWS: Array<[string, string]> = [['overview', 'Overview'], ['activity', 'Activity'], ['groups', 'Groups'], ['sources', 'Sources'], ['scope', 'Scope']];

export function Growth({ data, onOpenPerson, onLeftOut, onRefresh, fetchJson, renderPerson }: {
  data: GrowthData;
  onOpenPerson: (userId: number) => void;
  onLeftOut: () => void;
  onRefresh: () => void;
  fetchJson: (path: string) => Promise<{ ok: boolean; data: unknown }>;
  renderPerson?: (userId: number) => ReactNode;
}) {
  const [shown, setShown] = useState<(PeopleList & { seq: number }) | null>(null);
  const show = useCallback((l: PeopleList) => setShown((cur) => ({ ...l, seq: (cur?.seq || 0) + 1 })), []);
  const closeShown = useCallback(() => setShown(null), []);
  const [view, setView] = useState('overview');
  const [who, setWho] = useState<Who>('newcomers');
  const lastWeek = data.weeks[data.weeks.length - 1];
  const [when, setWhen] = useState<When>({ kind: 'all', week: lastWeek });
  const [saved, setSaved] = useState<Saved[]>(() => readSaved());
  const r = useReading(data, who, when);
  const { term, help } = useHelp();
  const weekIdx = Math.max(0, data.weeks.indexOf(when.week));
  const counts = {
    season: data.people.filter((p) => p.seasonEarly).length,
    older: data.people.filter((p) => p.early && !p.seasonEarly).length,
    connected: data.people.filter((p) => p.connected).length,
    newcomers: data.people.filter((p) => !p.early && !p.connected).length,
    all: data.people.length,
  };
  const leftOutOf = (title: string, list: GrowthPerson[]) => ({ kicker: 'Left out', title, list });
  return (
    <PeopleCtx.Provider value={show}>
    <div className="space-y-4">
      <div className={G.card} id="admin-journey-filters">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h2 className={AdminUI.cardTitle}>Growth</h2>
            {data.demo ? <span className={AdminUI.badge.warn}>demo</span> : null}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className={`${AdminUI.btn.ghost} text-xs`} data-journey-open="leftout" onClick={onLeftOut}>Left out</button>
            <button type="button" className={`${AdminUI.btn.link} text-xs`} onClick={onRefresh}>Refresh</button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-1.5" data-growth-filter="view">
          <span className={`${G.label} w-16`}>{term('view', 'View')}</span>
          {VIEWS.map(([k, label]) => <Pill key={k} on={view === k} onClick={() => setView(k)}>{label}</Pill>)}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5" data-growth-filter="when">
          <span className={`${G.label} w-16`}>{term('when', 'When')}</span>
          <Pill on={when.kind === 'all'} onClick={() => setWhen({ ...when, kind: 'all' })}>Since {dayLabel(data.eraStart)}</Pill>
          <Pill on={when.kind === 'last4'} onClick={() => setWhen({ ...when, kind: 'last4' })}>Last 4 weeks</Pill>
          <span className="inline-flex items-center gap-1">
            <button type="button" className={G.stepper} aria-label="Week before" disabled={weekIdx <= 0}
              onClick={() => setWhen({ kind: 'week', week: data.weeks[weekIdx - 1] })}>‹</button>
            <Pill on={when.kind === 'week'} onClick={() => setWhen({ ...when, kind: 'week' })}>Week of {dayLabel(when.week)}</Pill>
            <button type="button" className={G.stepper} aria-label="Week after" disabled={weekIdx >= data.weeks.length - 1}
              onClick={() => setWhen({ kind: 'week', week: data.weeks[weekIdx + 1] })}>›</button>
          </span>
          {when.kind === 'week' && when.week === data.thisWeek ? <span className={G.fine}>still running</span> : null}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5" data-growth-filter="who">
          <span className={`${G.label} w-16`}>{term('who', 'Who')}</span>
          <Pill id="admin-growth-newcomers" on={who === 'newcomers'} onClick={() => setWho('newcomers')}>Excluding Season 1 · {counts.newcomers}</Pill>
          <Pill on={who === 'everyone'} onClick={() => setWho('everyone')}>Including Season 1 · {counts.all}</Pill>
        </div>
        <div className="mt-2 flex flex-wrap items-baseline gap-1.5" data-growth-filter="left-out">
          <span className={`${G.label} w-16`}>{term('leftOut', 'Left out')}</span>
          <span className="text-xs text-zinc-600 dark:text-zinc-300">
            {who === 'newcomers' ? (
              <>
                Season 1 accounts · <Count {...leftOutOf('Season 1 accounts', data.people.filter((p) => p.seasonEarly))}>{counts.season}</Count>
                {` · Accounts from before ${dayLabel(data.eraStart)} · `}<Count {...leftOutOf(`Accounts from before ${dayLabel(data.eraStart)}`, data.people.filter((p) => p.early && !p.seasonEarly))}>{counts.older}</Count>
                {' · People they brought in · '}<Count {...leftOutOf('People they brought in', data.people.filter((p) => p.connected))}>{counts.connected}</Count>
                {' · Team, admins and tests'}
              </>
            ) : 'Team, admins and tests'}
          </span>
        </div>
        <div className="mt-2">{help('view', 'when', 'who', 'leftOut')}</div>
      </div>
      {view === 'overview' ? <Overview data={data} r={r} when={when} saved={saved} /> : null}
      {view === 'activity' ? <Activity data={data} who={who} r={r} when={when} /> : null}
      {view === 'groups' ? <Groups data={data} r={r} fetchJson={fetchJson} /> : null}
      {view === 'sources' ? <Sources r={r} /> : null}
      {view === 'scope' ? <Scope data={data} r={r} saved={saved} onSave={(list) => { writeSaved(list); setSaved(list); }} /> : null}
    </div>
    {shown ? (
      <PeopleDrawer key={shown.seq} spec={shown} data={data} r={r} renderPerson={renderPerson} onOpenPerson={onOpenPerson} onClose={closeShown} />
    ) : null}
    </PeopleCtx.Provider>
  );
}

type Reading = ReturnType<typeof useReading>;

// ── Overview ───────────────────────────────────────────────────────────

function Overview({ data, r, when, saved }: {
  data: GrowthData; r: Reading; when: When; saved: Saved[];
}) {
  const { term, help } = useHelp();
  const [cmpKey, setCmpKey] = useState<string | null>(null);
  const cohorts = cohortsFor(data, saved);
  const cmp = cohorts.find((c) => c.key === cmpKey) || null;
  const base = r.funnel(r.scoped);
  const cv = cmp ? r.funnel(r.scoped.filter(cmp.match)) : null;
  const back = r.groupsInScope.filter((g) => g.cameBack).length;
  const drops = base.slice(1).map((v, i) => ({ i, lost: base[i] ? 1 - v / base[i] : 0 }));
  const worst = drops.reduce((a, d) => (d.lost > a.lost ? d : a), drops[0]);
  const atStep = (i: number, list = r.scoped) => list.filter((p) => r.reached(p) >= i);
  const stopped = (i: number) => r.scoped.filter((p) => r.reached(p) === i);
  const stepOf = (i: number): PeopleList => ({ kicker: 'Reached this step', title: STEPS[i], list: atStep(i) });
  const waitlist = r.scoped.filter((p) => p.way === 'waitlist' && p.admittedDay);
  const mailLists: Array<[string, GrowthPerson[], string]> = [
    ['Let in', waitlist, 'bg-violet-200 dark:bg-violet-800'],
    ['On record', waitlist.filter((p) => p.mail && p.mail !== 'not_on_record'), 'bg-violet-400'],
    ['Opened', waitlist.filter((p) => p.mail === 'opened' || p.mail === 'clicked'), 'bg-zinc-300 dark:bg-zinc-600'],
    ['Clicked', waitlist.filter((p) => p.mail === 'clicked'), 'bg-violet-600'],
  ];
  const labels = data.weeks.map((w) => dayLabel(w));
  const fade = (i: number) => (when.kind === 'week' ? data.weeks[i] !== when.week : when.kind === 'last4' ? data.weeks[i] < r.last4From : false);
  const letInL = data.weeks.map((w) => r.whoPeople.filter((p) => weekOf(p.cameAt) === w));
  const activeL = data.weeks.map((w) => r.whoPeople.filter((p) => p.activeWeeks.includes(w)));
  const groupsWeek = data.weeks.map((w) => r.groups.filter((g) => g.weeks.includes(w)).length);
  const groupPeopleL = data.weeks.map((w) => r.peopleOfGroups(r.groups.filter((g) => g.weeks.includes(w))));
  const weekly: Array<[string, string, number[], string, PeopleList[]]> = [
    ['wLet', 'Let in', letInL.map((l) => l.length), 'bg-violet-400', letInL.map((list, i) => ({ kicker: 'Let in', title: `Week of ${labels[i]}`, list }))],
    ['wActive', 'Active', activeL.map((l) => l.length), 'bg-violet-600', activeL.map((list, i) => ({ kicker: 'Active', title: `Week of ${labels[i]}`, list }))],
    ['wGroups', 'Groups active together', groupsWeek, 'bg-zinc-900 dark:bg-zinc-100', groupPeopleL.map((list, i) => ({ kicker: 'In a group active together', title: `Week of ${labels[i]}`, list }))],
  ];
  // Retention by the first week a person was active.
  const firstWeek = new Map<string, GrowthPerson[]>();
  for (const p of r.scoped) {
    const f = p.activeWeeks.find((w) => w >= data.weeks[0]);
    if (!f) continue;
    if (!firstWeek.has(f)) firstWeek.set(f, []);
    firstWeek.get(f)!.push(p);
  }
  const retention = [...firstWeek.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([w, ps]) => {
    const start = data.weeks.indexOf(w);
    return { week: w, ps, cells: data.weeks.slice(start).map((wk) => ps.filter((p) => p.activeWeeks.includes(wk))) };
  });
  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4" id="admin-journey-north-star">
        <Tile north term={term('back', 'Groups came back together')} value={back} unit="groups of 3+, a second week" peopleOf={stepOf(4)} />
        <Tile term={term('together', 'Active groups')} value={r.groupsInScope.length} unit="groups of 3+ that acted together" peopleOf={stepOf(3)} />
        <Tile term={term('stayed', 'Stayed 30 s+')} value={base[2]} unit={`people · ${base[1] - base[2]} of ${base[1]} left within 30 s`} peopleOf={stepOf(2)} />
        <Tile term={term('opened', 'Opened Homeroom')} value={base[1]} unit={`people · of ${base[0]} let in`} peopleOf={stepOf(1)} />
      </div>
      {help('back', 'together', 'stayed', 'opened')}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 items-start">
        <div className={`${G.card} xl:col-span-2`} id="admin-growth-funnel">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className={G.title}>{term('funnel', 'Funnel · people')}</h3>
            <span className={G.fine}>{cmp ? `${cmp.label} · ${cv![0]}` : ''}</span>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className={G.fine}>{term('compare', 'Compare')}</span>
            <Pill on={!cmp} onClick={() => setCmpKey(null)}>None</Pill>
            {cohorts.map((c) => <Pill key={c.key} cmp on={cmpKey === c.key} onClick={() => setCmpKey(c.key)}>{c.label}</Pill>)}
          </div>
          <div className="mt-2">{help('funnel', 'compare')}</div>
          <div className="mt-3 flex flex-col">
            {STEPS.map((label, i) => {
              const w = base[0] ? Math.max(base[i] ? 1.5 : 0, (base[i] / base[0]) * 100) : 0;
              const prevW = i && base[0] ? Math.max(base[i - 1] ? 1.5 : 0, (base[i - 1] / base[0]) * 100) : 0;
              const cw = cv && cv[0] ? Math.max(cv[i] ? 1.5 : 0, (cv[i] / cv[0]) * 100) : 0;
              return (
                <div key={label}>
                  {i ? (
                    <div className="grid grid-cols-[9rem_minmax(0,1fr)_8rem] gap-3 items-center">
                      <span className="text-end text-[11px] text-amber-700 dark:text-amber-400">{base[i - 1] ? (
                        <Count kicker="Stopped here" title={`${STEPS[i - 1]}, not ${STEPS[i]}`} list={stopped(i - 1)}>{pct(base[i], base[i - 1])} kept</Count>
                      ) : ''}</span>
                      <span className="block h-4 bg-violet-100 dark:bg-violet-900/40"
                        style={{ clipPath: `polygon(${50 - prevW / 2}% 0, ${50 + prevW / 2}% 0, ${50 + Math.max(w, 0.8) / 2}% 100%, ${50 - Math.max(w, 0.8) / 2}% 100%)` }} />
                      <span />
                    </div>
                  ) : null}
                  <div className="grid grid-cols-[9rem_minmax(0,1fr)_8rem] gap-3 items-center" data-growth-step={i}>
                    <span className="text-end text-sm font-semibold text-zinc-900 dark:text-zinc-100">{term(`s${i}`, label)}</span>
                    <Count row {...stepOf(i)} className="relative block h-11">
                      {base[i] ? <span className="absolute top-0 h-11 rounded-md bg-violet-600" style={{ left: `${50 - w / 2}%`, width: `${w}%` }} />
                        : <span className="absolute top-0 h-11 w-10 rounded-md border-2 border-dashed border-violet-600" style={{ left: 'calc(50% - 1.25rem)' }} />}
                      {cv ? (cv[i]
                        ? <span className="absolute top-4 h-3 rounded bg-amber-500 ring-2 ring-white dark:ring-zinc-900" style={{ left: `${50 - cw / 2}%`, width: `${cw}%` }} />
                        : <span className="absolute top-4 h-3 w-7 rounded border-2 border-dashed border-amber-500" style={{ left: 'calc(50% - 0.875rem)' }} />) : null}
                    </Count>
                    <span className="flex flex-col items-start leading-tight tabular-nums">
                      <Count {...stepOf(i)}><b>{pct(base[i], base[0])}</b><span className={G.fine}> · {people(base[i])}</span></Count>
                      {cv && cmp ? (
                        <Count kicker={cmp.label} title={STEPS[i]} list={atStep(i, r.scoped.filter(cmp.match))} className="text-amber-700 dark:text-amber-400 text-xs">
                          <b>{pct(cv[i], cv[0])}</b> · {people(cv[i])}
                        </Count>
                      ) : null}
                    </span>
                  </div>
                  <div className="grid grid-cols-[9rem_minmax(0,1fr)_8rem] gap-3"><span /><div>{help(`s${i}`)}</div><span /></div>
                </div>
              );
            })}
          </div>
        </div>
        <div className={`${G.card} flex flex-col gap-3`}>
          <h3 className={G.title}>{term('mail', 'Admit mail')}</h3>
          {help('mail')}
          {mailLists.map(([label, list, tone]) => (
            <Count key={label} row kicker="Admit mail" title={label} list={list} className="grid grid-cols-[5rem_minmax(0,1fr)_2rem] gap-2 items-center text-sm">
              <span className="text-zinc-600 dark:text-zinc-300">{label}</span>
              <span className={G.track}><span className={`block h-3 rounded ${tone}`} style={{ width: `${waitlist.length ? (list.length / waitlist.length) * 100 : 0}%` }} /></span>
              <span className="text-end font-semibold tabular-nums">{list.length}</span>
            </Count>
          ))}
          <div className="mt-2 border-t border-zinc-100 dark:border-zinc-800 pt-3 flex flex-col gap-1">
            <span className={G.title}>{term('drop', 'Biggest drop')}</span>
            {help('drop')}
            {worst && base[worst.i] ? (
              <Count kicker="Stopped here" title={`${STEPS[worst.i]}, not ${STEPS[worst.i + 1]}`} list={stopped(worst.i)} className={`${G.big} self-start`}>−{Math.round(worst.lost * 100)}%</Count>
            ) : <span className={G.big}>–</span>}
            <span className={G.fine}>{worst ? `${STEPS[worst.i]} → ${STEPS[worst.i + 1]}` : ''}</span>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        {weekly.map(([id, title, vals, tone, lists]) => (
          <div key={id} className={G.card}>
            <h3 className={`${G.title} mb-2`}>{term(id, title)}</h3>
            {help(id)}
            <Bars values={vals} labels={labels} fade={fade} tone={tone} lists={lists} />
          </div>
        ))}
      </div>
      <div className={G.card}>
        <h3 className={`${G.title} mb-2`}>{term('retention', 'Retention by first week')}</h3>
        {help('retention')}
        {retention.length ? (
          <table className="mt-2 border-separate border-spacing-1 text-xs tabular-nums">
            <thead>
              <tr>
                <th className="pe-3 text-start font-medium text-zinc-500 dark:text-zinc-400">First week · people</th>
                {data.weeks.map((_, i) => <th key={`h${i}`} className="w-11 font-medium text-zinc-500 dark:text-zinc-400">W{i}</th>)}
              </tr>
            </thead>
            <tbody>
              {retention.map((row) => (
                <tr key={row.week}>
                  <th className="pe-3 text-start font-medium whitespace-nowrap">
                    {dayLabel(row.week)} · <Count kicker="First active" title={`Week of ${dayLabel(row.week)}`} list={row.ps}>{row.ps.length}</Count>
                  </th>
                  {data.weeks.map((wk, i) => {
                    const list = row.cells[i];
                    if (list == null) return <td key={`c${i}`} />;
                    const v = list.length;
                    const share = row.ps.length ? v / row.ps.length : 0;
                    return (
                      <td key={`c${i}`} className={`h-7 rounded text-center font-semibold ${v ? (share > 0.55 ? 'bg-violet-600 text-white' : 'bg-violet-200 dark:bg-violet-800 text-zinc-900 dark:text-zinc-100') : 'bg-zinc-100 dark:bg-zinc-800'}`}>
                        <Count kicker={`First active ${dayLabel(row.week)}`} title={`Active again W${i} (${dayLabel(data.weeks[data.weeks.indexOf(row.week) + i] || wk)})`} list={list} className="h-7 w-full">{v}</Count>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className={AdminUI.muted}>Nobody in scope has been active yet.</p>}
      </div>
    </>
  );
}

const STEP_TONE = ['bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300', 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300',
  'bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-200', 'bg-violet-600 text-white', 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'];

function StepPill({ step }: { step: number }) {
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${STEP_TONE[step]}`}>{STEP_SHORT[step]}</span>;
}

function personName(p: GrowthPerson): string {
  return p.name || (p.userId ? `#${p.userId}` : 'No account yet');
}

function PeopleTable({ list, reached, onPick }: { list: GrowthPerson[]; reached: (p: GrowthPerson) => number; onPick: (i: number) => void }) {
  return (
    <table className={AdminUI.table} data-growth-people="">
      <thead className={AdminUI.thead}>
        <tr><th className="py-2 pe-2 text-start text-xs font-medium uppercase tracking-wider text-zinc-500">Person</th>
          <th className="py-2 px-2 text-start text-xs font-medium uppercase tracking-wider text-zinc-500">Came by</th>
          <th className="py-2 px-2 text-start text-xs font-medium uppercase tracking-wider text-zinc-500">Got to</th>
          <th className="py-2 ps-2 text-end text-xs font-medium uppercase tracking-wider text-zinc-500">Last seen</th></tr>
      </thead>
      <tbody>
        {list.map((p, i) => (
          <tr key={p.key} className={`${AdminUI.trHover} cursor-pointer`} onClick={() => onPick(i)}>
            <td className="py-2 pe-2">
              <button type="button" className={`font-medium hover:underline text-start ${p.userId ? 'text-violet-700 dark:text-violet-400' : 'text-zinc-500 dark:text-zinc-400'}`}
                onClick={(e) => { e.stopPropagation(); onPick(i); }}>{personName(p)}</button>
            </td>
            <td className="py-2 px-2 text-zinc-600 dark:text-zinc-300">{WAY_NAME[p.way]}{p.admittedDay ? ` · ${dayLabel(p.admittedDay)}` : ''}</td>
            <td className="py-2 px-2"><StepPill step={reached(p)} /></td>
            <td className="py-2 ps-2 text-end text-zinc-600 dark:text-zinc-300 whitespace-nowrap">{p.lastSeen ? dayLabel(p.lastSeen) : '–'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const MAIL_WORDS: Record<string, string> = { clicked: 'Clicked', opened: 'Opened, not clicked', sent: 'Sent, not opened', not_on_record: 'Not in the mail log' };

// What the reading knows about one person, drawn above Journey's own view.
function PersonFacts({ p, step, data, groups }: { p: GrowthPerson; step: number; data: GrowthData; groups: GrowthGroup[] }) {
  const mine = p.userId == null ? [] : groups.filter((g) => g.people.includes(p.userId!));
  const fact = (label: string, value: ReactNode) => (
    <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-2 py-1.5 text-sm border-b border-zinc-100 dark:border-zinc-800 last:border-b-0">
      <span className="text-zinc-500 dark:text-zinc-400">{label}</span><span className="min-w-0">{value}</span>
    </div>
  );
  const last7 = [p.last7.opened && 'opened Homeroom', p.last7.used && 'stayed 30 s+', p.last7.contributed && 'acted', p.last7.analyticsWau && 'in Analytics\' WAU'].filter(Boolean).join(' · ');
  return (
    <div className="flex flex-col" data-growth-person-facts="">
      {fact('Got to', <StepPill step={step} />)}
      {fact('Came by', `${WAY_NAME[p.way]}${p.admittedDay ? `, let in ${dayLabel(p.admittedDay)}` : ''}${p.cameAt ? ` · arrived ${dayLabel(p.cameAt)}` : ''}`)}
      {p.early || p.connected ? fact('Group', p.seasonEarly ? 'Season 1' : p.early ? `Account from before ${dayLabel(data.eraStart)}` : 'Brought in by the early community') : null}
      {p.heard ? fact('Heard about it', <span className="capitalize">{p.heard}</span>) : null}
      {p.way === 'waitlist' && p.admittedDay ? fact('Admit mail', p.mail ? MAIL_WORDS[p.mail] : '–') : null}
      {fact('Last seen', p.lastSeen ? dayLabel(p.lastSeen) : 'Never')}
      {fact('Weeks active', (
        <span className="inline-flex flex-wrap items-center gap-0.5" role="img" aria-label={`Active ${p.activeWeeks.filter((w) => data.weeks.includes(w)).length} of ${data.weeks.length} weeks`}>
          {data.weeks.map((w) => <span key={w} className={`h-3.5 w-2 rounded-sm ${p.activeWeeks.includes(w) ? 'bg-violet-600' : 'bg-zinc-100 dark:bg-zinc-800'}`} />)}
        </span>
      ))}
      {fact('Last 7 days', last7 || 'Nothing')}
      {mine.length ? fact('Groups', mine.map((g) => `${g.name || `Project ${g.appId}`}${g.cameBack ? ' (came back)' : ''}`).join(', ')) : null}
    </div>
  );
}

// The one sidebar every count opens: its people, then one of them in place,
// with the previous and next person a tap away.
function PeopleDrawer({ spec, data, r, renderPerson, onOpenPerson, onClose }: {
  spec: PeopleList; data: GrowthData; r: Reading; renderPerson?: (userId: number) => ReactNode;
  onOpenPerson: (id: number) => void; onClose: () => void;
}) {
  const [sel, setSel] = useState<number | null>(spec.pick != null && spec.pick >= 0 ? spec.pick : null);
  const n = spec.list.length;
  const p = sel == null ? null : spec.list[sel];
  return (
    <Drawer wide={!!p} kicker={p ? `${spec.kicker} · ${spec.title}` : spec.kicker} title={p ? personName(p) : spec.title} onClose={onClose}>
      {p && sel != null ? (
        <>
          <div className="flex items-center gap-2">
            <button type="button" className={`${AdminUI.btn.ghost} text-sm`} data-growth-back="" onClick={() => setSel(null)}>‹ All {people(n)}</button>
            <span className="ms-auto inline-flex items-center gap-1.5">
              <button type="button" className={G.stepper} aria-label="Previous person" disabled={sel <= 0} onClick={() => setSel(sel - 1)}>‹</button>
              <span className={`${G.fine} tabular-nums`}>{sel + 1} of {n}</span>
              <button type="button" className={G.stepper} aria-label="Next person" disabled={sel >= n - 1} onClick={() => setSel(sel + 1)}>›</button>
            </span>
          </div>
          <PersonFacts p={p} step={r.reached(p)} data={data} groups={r.groups} />
          {p.userId != null ? (
            <>
              {renderPerson ? <div key={p.userId}>{renderPerson(p.userId)}</div> : null}
              <button type="button" className={`${G.link} self-start`} onClick={() => onOpenPerson(p.userId!)}>Open on its own page ›</button>
            </>
          ) : <p className={AdminUI.muted}>Let in from the waitlist, but no account yet: nothing more is recorded.</p>}
        </>
      ) : (
        <>
          <span className="text-sm text-zinc-600 dark:text-zinc-300">{people(n)}</span>
          {n ? <PeopleTable list={spec.list} reached={r.reached} onPick={setSel} /> : <p className={AdminUI.muted}>Nobody here.</p>}
        </>
      )}
    </Drawer>
  );
}

// ── Activity ───────────────────────────────────────────────────────────

function Activity({ data, who, r, when }: { data: GrowthData; who: Who; r: Reading; when: When }) {
  const { term, help } = useHelp();
  const [pick, setPick] = useState<string | null>(null);
  const pool = r.whoPeople;
  const weeks = data.weeks;
  const life = weeks.map((w, i) => {
    const prev = weeks[i - 1];
    const L: Record<'nw' | 'ret' | 'res' | 'dor', GrowthPerson[]> = { nw: [], ret: [], res: [], dor: [] };
    for (const p of pool) {
      const now = p.activeWeeks.includes(w);
      const before = prev ? p.activeWeeks.includes(prev) : false;
      const earlier = p.activeWeeks.some((x) => x < w);
      if (now && !earlier) L.nw.push(p);
      else if (now && before) L.ret.push(p);
      else if (now) L.res.push(p);
      else if (before) L.dor.push(p);
    }
    return { w, L, nw: L.nw.length, ret: L.ret.length, res: L.res.length, dor: L.dor.length };
  });
  const up = Math.max(1, ...life.map((l) => l.nw + l.ret + l.res));
  const down = Math.max(1, ...life.map((l) => l.dor));
  const scale = 110 / Math.max(up, down);
  const last4 = weeks.slice(-4);
  const l4L = [1, 2, 3, 4].map((k) => pool.filter((p) => last4.filter((w) => p.activeWeeks.includes(w)).length === k));
  const l4max = Math.max(1, ...l4L.map((l) => l.length));
  const groupsNow = r.groups.filter((g) => g.weeks.includes(data.thisWeek));
  // The group row counts groups; its people are the ones in those groups.
  const depth: Array<[string, number, GrowthPerson[]]> = [
    ['Opened Homeroom', 0, pool.filter((p) => p.last7.opened)],
    ['Stayed 30 s+', 0, pool.filter((p) => p.last7.used)],
    ['Contributed', 0, pool.filter((p) => p.last7.contributed)],
    ['Active groups', groupsNow.length, r.peopleOfGroups(groupsNow)],
  ];
  for (const d of depth) if (d[0] !== 'Active groups') d[1] = d[2].length;
  const dmax = Math.max(1, ...depth.map((d) => d[1]));
  const wau = data.people.filter((p) => p.last7.analyticsWau);
  const parts: Array<[string, GrowthPerson[], string]> = [
    ['Season 1', wau.filter((p) => p.seasonEarly), 'bg-zinc-300 dark:bg-zinc-600'],
    ['Other early', wau.filter((p) => p.early && !p.seasonEarly), 'bg-zinc-500'],
    ['Brought in by them', wau.filter((p) => p.connected), 'bg-zinc-700 dark:bg-zinc-400'],
    ['Newcomers', wau.filter((p) => !p.early && !p.connected), 'bg-violet-600'],
  ];
  // Each person once, at the deepest thing they did.
  const wauDid: Array<[string, GrowthPerson[], string]> = [
    ['Acted: wrote, voted or built', wau.filter((p) => p.last7.contributed), 'bg-violet-600'],
    ['Stayed 30 s+, no act', wau.filter((p) => !p.last7.contributed && p.last7.used), 'bg-violet-400'],
    ['Glanced: under 30 s, or kudos', wau.filter((p) => !p.last7.contributed && !p.last7.used), 'bg-zinc-300 dark:bg-zinc-600'],
  ];
  const fade = (w: string) => (when.kind === 'week' ? w !== when.week : when.kind === 'last4' ? w < r.last4From : false);
  return (
    <>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 items-start">
        <div className={`${G.card} xl:col-span-2`} id="admin-growth-lifecycle">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className={G.title}>{term('lifecycle', 'Weekly lifecycle')}</h3>
            <span className="flex flex-wrap gap-3 text-xs text-zinc-600 dark:text-zinc-300">
              <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-violet-300" />{term('lifeNew', 'New')}</span>
              <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-violet-600" />{term('lifeReturning', 'Returning')}</span>
              <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-emerald-600" />{term('lifeResurrecting', 'Resurrecting')}</span>
              <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-amber-400" />{term('lifeDormant', 'Dormant')}</span>
            </span>
          </div>
          {help('lifecycle', 'lifeNew', 'lifeReturning', 'lifeResurrecting', 'lifeDormant')}
          <div className="mt-3 grid gap-2" style={{ gridTemplateColumns: `repeat(${life.length}, minmax(0, 1fr))` }}>
            {life.map((l, i) => (
              <div key={l.w} className="relative" onMouseEnter={() => setPick(l.w)} onMouseLeave={() => setPick(null)}>
              <button type="button" aria-expanded={pick === l.w} aria-label={`Week of ${dayLabel(l.w)}: ${l.nw} new, ${l.ret} returning, ${l.res} resurrecting, ${l.dor} dormant`}
                onClick={() => setPick(pick === l.w ? null : l.w)}
                className={`flex w-full flex-col items-center rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800 ${pick === l.w ? 'bg-zinc-100 dark:bg-zinc-800' : ''} ${fade(l.w) ? 'opacity-30' : ''} ${l.w === data.thisWeek ? 'opacity-60' : ''}`}>
                <div className="flex h-32 w-full flex-col items-center justify-end">
                  <span className="text-[11px] font-semibold tabular-nums">{l.nw + l.ret + l.res || ''}</span>
                  <span className="block w-3/4 bg-emerald-600" style={{ height: `${l.res * scale}px` }} />
                  <span className="block w-3/4 bg-violet-600" style={{ height: `${l.ret * scale}px` }} />
                  <span className="block w-3/4 bg-violet-300" style={{ height: `${l.nw * scale}px` }} />
                </div>
                <div className="w-full border-t border-zinc-900 dark:border-zinc-100" />
                <div className="flex h-28 w-full flex-col items-center">
                  <span className="block w-3/4 bg-amber-400" style={{ height: `${l.dor * scale}px` }} />
                  <span className="text-[11px] font-semibold tabular-nums text-amber-700 dark:text-amber-400">{l.dor ? `−${l.dor}` : ''}</span>
                </div>
                <span className="text-[10px] text-zinc-500 dark:text-zinc-400 whitespace-nowrap">{dayLabel(l.w)}</span>
              </button>
              {pick === l.w ? (
                <div role="note" className={`${G.help} absolute top-0 z-30 flex w-44 flex-col gap-0.5 shadow-lg ${i < life.length / 2 ? 'start-0' : 'end-0'}`}>
                  <p className="font-semibold">Week of {dayLabel(l.w)}{l.w === data.thisWeek ? ' (so far)' : ''}</p>
                  {([['New', l.L.nw, 'bg-violet-300'], ['Returning', l.L.ret, 'bg-violet-600'], ['Resurrecting', l.L.res, 'bg-emerald-600'], ['Dormant', l.L.dor, 'bg-amber-400']] as Array<[string, GrowthPerson[], string]>).map(([name, list, tone]) => (
                    <Count key={name} row kicker={`Week of ${dayLabel(l.w)}`} title={name} list={list} className="flex items-center gap-2 px-1 enabled:hover:bg-white/10 dark:enabled:hover:bg-black/10">
                      <span className={`h-2 w-2 rounded-sm ${tone}`} /><span className="flex-1">{name}</span><b className="tabular-nums">{list.length}</b>
                    </Count>
                  ))}
                  <Count row kicker={`Week of ${dayLabel(l.w)}`} title="Active" list={[...l.L.nw, ...l.L.ret, ...l.L.res]} className="mt-1 px-1 enabled:hover:bg-white/10 dark:enabled:hover:bg-black/10">
                    {people(l.nw + l.ret + l.res)} active ›
                  </Count>
                </div>
              ) : null}
              </div>
            ))}
          </div>
        </div>
        <div className={`${G.card} flex flex-col gap-3`}>
          <h3 className={G.title}>{term('l4', 'Weeks active, last 4')}</h3>
          {help('l4')}
          {l4L.map((list, i) => (
            <Count key={`l${i}`} row kicker="Weeks active, last 4" title={`${i + 1} ${i ? 'weeks' : 'week'}`} list={list} className="grid grid-cols-[4rem_minmax(0,1fr)_2rem] gap-2 items-center text-sm">
              <span className="text-zinc-600 dark:text-zinc-300">{i + 1} {i ? 'weeks' : 'week'}</span>
              <span className={G.track}><span className="block h-3 rounded bg-violet-600" style={{ width: `${(list.length / l4max) * 100}%`, opacity: 0.4 + i * 0.2 }} /></span>
              <span className="text-end font-semibold tabular-nums">{list.length}</span>
            </Count>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
        <div className={`${G.card} flex flex-col gap-3`}>
          <h3 className={G.title}>{term('depth', 'Last 7 days, by depth')}</h3>
          {help('depth')}
          {depth.map(([label, n, list], i) => (
            <Count key={label} row kicker="Last 7 days" title={i === 3 ? 'In a group active this week' : label} list={list} className="grid grid-cols-[9rem_minmax(0,1fr)_2rem] gap-2 items-center text-sm">
              <span className="text-zinc-600 dark:text-zinc-300">{label}</span>
              <span className={G.track}><span className={`block h-3 rounded ${['bg-violet-200', 'bg-violet-400', 'bg-violet-600', 'bg-zinc-900 dark:bg-zinc-100'][i]}`} style={{ width: `${(n / dmax) * 100}%` }} /></span>
              <span className="text-end font-semibold tabular-nums">{n}</span>
            </Count>
          ))}
        </div>
        <div className={`${G.card} flex flex-col gap-3`} id="admin-growth-wau">
          <h3 className={G.title}>{term('wau', `Who is in Analytics' WAU of ${wau.length}`)}</h3>
          {help('wau')}
          <div className="flex h-7 overflow-hidden rounded-md gap-0.5">
            {parts.map(([label, list, tone]) => (list.length
              ? <Count key={label} row kicker="In Analytics' WAU" title={label} list={list} className={`${tone} rounded-none`} style={{ flex: list.length }}><span className="sr-only">{label}</span></Count>
              : null))}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {parts.map(([label, list, tone]) => (
              <Count key={label} kicker="In Analytics' WAU" title={label} list={list} className="inline-flex items-center gap-1.5">
                <span className={`h-2.5 w-2.5 rounded-sm ${tone}`} /><b className="tabular-nums">{list.length}</b> {label}
              </Count>
            ))}
          </div>
          <h4 className={`${G.title} mt-2`}>{term('wauDid', 'What they did in those 7 days')}</h4>
          {help('wauDid')}
          {wauDid.map(([label, list, tone]) => (
            <Count key={label} row kicker="In Analytics' WAU" title={label} list={list} className="grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)_2.5rem] gap-2 items-center text-sm">
              <span className="text-zinc-600 dark:text-zinc-300">{label}</span>
              <span className={G.track}><span className={`block h-3 rounded ${tone}`} style={{ width: `${wau.length ? (list.length / wau.length) * 100 : 0}%` }} /></span>
              <span className="text-end font-semibold tabular-nums">{list.length}</span>
            </Count>
          ))}
          <p className={G.fine}>{who === 'newcomers' ? 'Shown for everyone: this is what the old number counts.' : ''}</p>
        </div>
      </div>
    </>
  );
}

// ── Groups ─────────────────────────────────────────────────────────────

function Groups({ data, r, fetchJson }: {
  data: GrowthData; r: Reading; fetchJson: (path: string) => Promise<{ ok: boolean; data: unknown }>;
}) {
  const show = useContext(PeopleCtx);
  const { term, help } = useHelp();
  const [open, setOpen] = useState<GrowthGroup | null>(null);
  const list = r.groupsInScope;
  const names = new Map(data.people.filter((p) => p.userId).map((p) => [p.userId as number, p.name || `#${p.userId}`]));
  return (
    <div className={G.card} id="admin-growth-groups">
      <h3 className={`${G.title} mb-2`}>{term('groupsTable', `Groups · ${list.length}`)}</h3>
      {help('groupsTable', 'weeksCol', 'firstBuild')}
      {list.length ? (
        <table className={AdminUI.table}>
          <thead className={AdminUI.thead}>
            <tr>
              <th className="py-2 pe-2 text-start text-xs font-medium uppercase tracking-wider text-zinc-500">Group</th>
              <th className="py-2 px-2 text-end text-xs font-medium uppercase tracking-wider text-zinc-500">People</th>
              <th className="py-2 px-2 text-end text-xs font-medium uppercase tracking-wider text-zinc-500">Builds</th>
              <th className="py-2 px-2 text-end text-xs font-medium uppercase tracking-wider text-zinc-500">{term('firstBuild', 'First build')}</th>
              <th className="py-2 px-2 text-start text-xs font-medium uppercase tracking-wider text-zinc-500">{term('weeksCol', 'Weeks active')}</th>
              <th className="py-2 ps-2 text-end text-xs font-medium uppercase tracking-wider text-zinc-500">Came back</th>
            </tr>
          </thead>
          <tbody>
            {list.map((g) => (
              <tr key={g.appId} className={AdminUI.trHover}>
                <td className="py-3 pe-2">
                  <button type="button" className="font-medium text-violet-700 dark:text-violet-400 hover:underline text-start" onClick={() => setOpen(g)}>
                    {g.name || `Project ${g.appId}`}{g.private ? ' (private)' : ''} ›
                  </button>
                  <div className={G.fine}>made {dayLabel(g.madeAt)}</div>
                </td>
                <td className="py-3 px-2 text-end tabular-nums">
                  <Count kicker="Group" title={g.name || `Project ${g.appId}`} list={data.people.filter((p) => p.userId != null && g.people.includes(p.userId))}>{g.people.length}</Count>
                </td>
                <td className="py-3 px-2 text-end tabular-nums">{g.builds}</td>
                <td className="py-3 px-2 text-end tabular-nums">{g.firstBuildMinutes == null ? '–' : g.firstBuildMinutes < 120 ? `${g.firstBuildMinutes} min` : `${Math.round(g.firstBuildMinutes / 60)} h`}</td>
                <td className="py-3 px-2">
                  <span className="inline-flex items-center gap-0.5" role="img" aria-label={`Active ${g.weeks.length} of ${data.weeks.length} weeks`}>
                    {data.weeks.map((w) => <span key={w} className={`h-3.5 w-2 rounded-sm ${g.weeks.includes(w) ? 'bg-violet-600' : 'bg-zinc-100 dark:bg-zinc-800'}`} />)}
                    <span className="ms-1.5 tabular-nums">{g.weeks.length}</span>
                  </span>
                </td>
                <td className="py-3 ps-2 text-end">{g.cameBack ? <span className={AdminUI.badge.success}>Yes</span> : <span className={AdminUI.badge.warn}>No</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className={AdminUI.muted}>No group in scope yet: no project where {data.groupMin} or more of these people acted in the same week.</p>}
      {open ? (
        <GroupTimeline group={open} names={names} fetchJson={fetchJson} onClose={() => setOpen(null)}
          onOpenPerson={(id) => {
            const list = data.people.filter((p) => p.userId != null && open.people.includes(p.userId));
            setOpen(null);
            show({ kicker: 'Group', title: open.name || `Project ${open.appId}`, list, pick: list.findIndex((p) => p.userId === id) });
          }} />
      ) : null}
    </div>
  );
}

function GroupTimeline({ group, names, fetchJson, onOpenPerson, onClose }: {
  group: GrowthGroup; names: Map<number, string>; fetchJson: (path: string) => Promise<{ ok: boolean; data: unknown }>;
  onOpenPerson: (id: number) => void; onClose: () => void;
}) {
  const [data, setData] = useState<Timeline | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    fetchJson(`/api/admin/journey/growth/groups/${group.appId}`).then((res) => {
      if (!live) return;
      if (!res.ok || !res.data) setFailed(true); else setData(res.data as Timeline);
    });
    return () => { live = false; };
  }, [group.appId, fetchJson]);
  const title = `${group.name || `Project ${group.appId}`}${group.private ? ' (private)' : ''}`;
  let body: ReactNode = <p className={AdminUI.loading}>Loading the sessions…</p>;
  if (failed) body = <p className={AdminUI.muted}>Could not load the sessions.</p>;
  else if (data) {
    // The busiest day the group acted, minute by minute.
    const events = data.events.filter((e) => e.at);
    const byDay = new Map<string, number>();
    for (const e of events) byDay.set(e.at.slice(0, 10), (byDay.get(e.at.slice(0, 10)) || 0) + 1);
    const dayPick = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const day = events.filter((e) => e.at.slice(0, 10) === dayPick);
    const t0 = Math.min(...day.map((e) => Date.parse(e.at)));
    const t1 = Math.max(...day.map((e) => Date.parse(e.until || e.at)));
    const span = Math.max(15 * 60000, t1 - t0);
    const pos = (iso: string) => `${((Date.parse(iso) - t0) / span) * 100}%`;
    const joined = new Map<number, string>();
    for (const e of day) if (e.kind === 'joined' && e.userId && !joined.has(e.userId)) joined.set(e.userId, e.at);
    const lanes = [...new Set(day.filter((e) => e.userId).map((e) => e.userId as number))];
    const lastAt = new Date(t1).toISOString();
    body = (
      <>
        <span className="text-sm text-zinc-600 dark:text-zinc-300">{dayLabel(dayPick)} · {timeLabel(new Date(t0).toISOString())}–{timeLabel(lastAt)} UTC · {group.people.length} people · {group.builds} builds</span>
        <div className="flex flex-wrap gap-3 text-xs text-zinc-600 dark:text-zinc-300">
          <span className="inline-flex items-center gap-1"><span className="h-2 w-3.5 rounded-sm bg-violet-600" />In the project</span>
          <span className="inline-flex items-center gap-1"><span className="h-2 w-3.5 rounded-sm bg-zinc-900 dark:bg-zinc-100" />Building</span>
          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-500" />Message</span>
        </div>
        <div className="flex flex-col gap-2" role="img" aria-label="Session timeline">
          {lanes.map((id) => {
            const from = joined.get(id) || day.find((e) => e.userId === id)!.at;
            return (
              <div key={id} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 items-center">
                <button type="button" className="truncate text-start text-sm font-medium text-violet-700 dark:text-violet-400 hover:underline" onClick={() => onOpenPerson(id)}>{names.get(id) || `#${id}`}</button>
                <div className="relative h-6 rounded bg-zinc-50 dark:bg-zinc-800">
                  <span className="absolute top-0 h-6 rounded bg-violet-600" style={{ left: pos(from), width: `calc(100% - ${pos(from)})` }} />
                  {day.filter((e) => e.kind === 'message' && e.userId === id).map((e, i) => (
                    <span key={`m${i}`} className="absolute top-2 h-2 w-2 -ms-1 rounded-full bg-amber-500 ring-1 ring-white" style={{ left: pos(e.at) }} />
                  ))}
                </div>
              </div>
            );
          })}
          <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 items-center">
            <span className="text-sm font-medium">Builds</span>
            <div className="relative h-6 rounded bg-zinc-50 dark:bg-zinc-800">
              {day.filter((e) => e.kind === 'build').map((e, i) => (
                <span key={`b${i}`} className="absolute top-0 h-6 rounded bg-zinc-900 dark:bg-zinc-100" style={{ left: pos(e.at), width: `max(4px, calc(${pos(e.until || e.at)} - ${pos(e.at)}))` }} />
              ))}
            </div>
          </div>
          <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3">
            <span />
            <div className="flex justify-between text-[11px] text-zinc-500 dark:text-zinc-400">
              <span>{timeLabel(new Date(t0).toISOString())}</span><span>{timeLabel(new Date(t0 + span / 2).toISOString())}</span><span>{timeLabel(new Date(t0 + span).toISOString())}</span>
            </div>
          </div>
        </div>
      </>
    );
  }
  return <Drawer wide kicker="Group" title={title} onClose={onClose}>{body}</Drawer>;
}

// ── Sources ────────────────────────────────────────────────────────────

function Sources({ r }: { r: Reading }) {
  const { term, help } = useHelp();
  const rows = WAYS.map(([w, label]) => {
    const ps = r.scoped.filter((p) => p.way === w);
    return { w, label, ps, stayed: ps.filter((p) => r.reached(p) >= 2), group: ps.filter((p) => r.reached(p) >= 3) };
  });
  const waitlist = r.scoped.filter((p) => p.way === 'waitlist');
  const answers = [...new Set(waitlist.map((p) => p.heard || 'blank'))];
  const heard = answers.map((a) => {
    const ps = waitlist.filter((p) => (p.heard || 'blank') === a);
    return { a, ps, came: ps.length, stayedL: ps.filter((p) => p.stayed), stayed: ps.filter((p) => p.stayed).length };
  }).sort((x, y) => y.came - x.came);
  const hmax = Math.max(1, ...heard.map((h) => h.came));
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
      <div className={G.card} id="admin-growth-sources">
        <h3 className={`${G.title} mb-2`}>{term('ways', 'Ways in')}</h3>
        {help('ways')}
        <table className={AdminUI.table}>
          <thead className={AdminUI.thead}>
            <tr>
              <th className="py-2 pe-2 text-start text-xs font-medium uppercase tracking-wider text-zinc-500">Way in</th>
              <th className="py-2 px-2 text-end text-xs font-medium uppercase tracking-wider text-zinc-500">Let in</th>
              <th className="py-2 px-2 text-end text-xs font-medium uppercase tracking-wider text-zinc-500">Stayed 30 s+</th>
              <th className="py-2 ps-2 text-end text-xs font-medium uppercase tracking-wider text-zinc-500">With a group</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.w} className="border-b border-zinc-100 dark:border-zinc-800/60">
                <td className="py-3 pe-2">
                  <span className="inline-flex items-center gap-2">{row.label}
                    {row.w === 'link' ? <span className={AdminUI.badge.success}>intent</span> : <span className={AdminUI.badge.outline}>no intent</span>}</span>
                </td>
                <td className="py-3 px-2 text-end"><Count kicker={row.label} title="Let in" list={row.ps}>{row.ps.length}</Count></td>
                <td className="py-3 px-2 text-end"><Count kicker={row.label} title="Stayed 30 s+" list={row.stayed}>{row.stayed.length}</Count></td>
                <td className="py-3 ps-2 text-end"><Count kicker={row.label} title="Used it with a group" list={row.group}>{row.group.length}</Count></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={`${G.card} flex flex-col gap-2`}>
        <h3 className={G.title}>{term('heard', '“How did you hear” · waitlist')}</h3>
        {help('heard')}
        {heard.map((h) => (
          <div key={h.a} className="grid grid-cols-[6rem_minmax(0,1fr)_4rem] gap-2 items-center text-sm">
            <Count row kicker="Heard about it" title={h.a} list={h.ps} className="text-zinc-600 dark:text-zinc-300 capitalize">{h.a}</Count>
            <Count row kicker="Heard about it" title={h.a} list={h.ps} className={G.track}>
              <span className="flex h-3 rounded bg-violet-200 dark:bg-violet-800" style={{ width: `${(h.came / hmax) * 100}%` }}>
                <span className="block h-3 rounded bg-violet-600" style={{ width: `${h.came ? (h.stayed / h.came) * 100 : 0}%` }} />
              </span>
            </Count>
            <span className="text-end tabular-nums">
              <Count kicker={`Heard about it: ${h.a}`} title="Stayed 30 s+" list={h.stayedL}><b>{h.stayed}</b></Count>
              <span className={G.fine}> / </span><Count kicker="Heard about it" title={h.a} list={h.ps} className={G.fine}>{h.came}</Count>
            </span>
          </div>
        ))}
        <p className={G.fine}>Dark: stayed 30 s+. Light: let in.</p>
      </div>
    </div>
  );
}

// ── Scope ──────────────────────────────────────────────────────────────

// A count beside a checkbox: its own button, so a tap lists the people and
// does not tick the box.
function ScopeCount(props: PeopleList) {
  return (
    <span onClick={(e) => e.preventDefault()}>
      <Count {...props} className="text-zinc-500">{props.list.length}</Count>
    </span>
  );
}

function Scope({ data, r, saved, onSave }: { data: GrowthData; r: Reading; saved: Saved[]; onSave: (list: Saved[]) => void }) {
  const { term, help } = useHelp();
  const days = [...new Set(r.whoPeople.map((p) => p.admittedDay).filter((d): d is string => !!d))].sort().reverse().concat(['never']);
  const [ways, setWays] = useState<GrowthPerson['way'][]>(WAYS.map(([w]) => w));
  const [picked, setPicked] = useState<string[]>(days);
  const match = (p: GrowthPerson) => ways.includes(p.way) && picked.includes(p.admittedDay || 'never');
  const inScope = r.scoped.filter(match);
  const f = r.funnel(inScope);
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const name = [ways.length === WAYS.length ? 'All ways in' : ways.map((w) => WAY_NAME[w]).join(', '),
    picked.length === days.length ? 'all admit days' : picked.map((d) => (d === 'never' ? 'never admitted' : dayLabel(d))).join(', ')].join(' · ');
  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 items-start" id="admin-growth-scope">
      <div className={`${G.card} flex flex-col gap-2`}>
        <h3 className={G.title}>{term('scopeWays', 'Way in')}</h3>
        {help('scopeWays')}
        {WAYS.map(([w, label]) => (
          <label key={w} className="flex items-center gap-2 text-sm">
            <input type="checkbox" className={G.check} checked={ways.includes(w)} onChange={() => setWays(toggle(ways, w))} />
            <span className="flex-1">{label}</span>
            <ScopeCount kicker="Way in" title={label} list={r.scoped.filter((p) => p.way === w && picked.includes(p.admittedDay || 'never'))} />
          </label>
        ))}
      </div>
      <div className={`${G.card} flex flex-col gap-2`}>
        <h3 className={G.title}>{term('scopeDays', 'Admit day')}</h3>
        {help('scopeDays')}
        {days.map((d) => (
          <label key={d} className="flex items-center gap-2 text-sm">
            <input type="checkbox" className={G.check} checked={picked.includes(d)} onChange={() => setPicked(toggle(picked, d))} />
            <span className="flex-1">{d === 'never' ? 'Never admitted' : `Let in ${dayLabel(d)}`}</span>
            <ScopeCount kicker="Admit day" title={d === 'never' ? 'Never admitted' : `Let in ${dayLabel(d)}`} list={r.scoped.filter((p) => (p.admittedDay || 'never') === d && ways.includes(p.way))} />
          </label>
        ))}
      </div>
      <div className={`${G.card} flex flex-col gap-3`}>
        <h3 className={G.title}>This scope · {people(f[0])}</h3>
        {STEPS.map((label, i) => (
          <Count key={label} row kicker="This scope" title={label} list={inScope.filter((p) => r.reached(p) >= i)} className="grid grid-cols-[8.5rem_minmax(0,1fr)_2.5rem] gap-2 items-center text-sm">
            <span className="text-zinc-600 dark:text-zinc-300">{label}</span>
            <span className={G.track}><span className="block h-3 rounded bg-violet-600" style={{ width: `${f[0] ? (f[i] / f[0]) * 100 : 0}%` }} /></span>
            <span className="text-end font-semibold tabular-nums">{f[i]}</span>
          </Count>
        ))}
        <div className="border-t border-zinc-100 dark:border-zinc-800 pt-3 flex flex-col gap-2">
          <span className={G.title}>{term('saved', 'Saved cohorts')}</span>
          {help('saved')}
          <button type="button" className={AdminUI.btn.primary} onClick={() => onSave([...saved, { name, ways, days: picked }])}>Save this scope as a cohort</button>
          {saved.length ? saved.map((c, i) => (
            <div key={`${c.name}-${i}`} className="flex items-center justify-between gap-2 rounded-lg bg-zinc-50 dark:bg-zinc-800 px-3 py-2 text-sm">
              <span className="min-w-0 truncate">{c.name}</span>
              <button type="button" className={`${AdminUI.btn.ghost} text-base leading-none`} aria-label={`Remove ${c.name}`} onClick={() => onSave(saved.filter((_, j) => j !== i))}>×</button>
            </div>
          )) : <p className={G.fine}>None yet. A saved cohort shows up under Compare on the Overview.</p>}
        </div>
      </div>
      <p className={`${G.fine} xl:col-span-3`}>Counts follow the filters above. {data.demo ? 'Demo data.' : ''}</p>
    </div>
  );
}

export const GROWTH_HELP = HELP;
export { weekOf as growthWeekOf, DAY as GROWTH_DAY_MS };
