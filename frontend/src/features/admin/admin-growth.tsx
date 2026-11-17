// Growth: the Journey page's views since it became the Growth dashboard.
// What newcomers do since the landing page went live (14 Sep 2026), counted
// in groups, not accounts. One reading, GET /api/admin/journey/growth
// (src/services/growth.js), filtered here: when, who, compare and scope.
//
// Every label is a term: tap it and it says what it counts (Journey's
// mileLabel pattern; a phone has no hover). Nothing from the API is drawn as
// a link. People are opened in Journey's own person view.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
      <p className={`${G.help} absolute start-0 top-1 z-30 w-max max-w-[min(28rem,calc(100vw-2rem))] shadow-lg`} role="note">{HELP[open]}</p>
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
    const weekActive = (week: string, list: GrowthPerson[]) => list.filter((p) => p.activeWeeks.includes(week)).length;
    return { inWho, inWhen, scoped, reached, funnel, groups, groupsInScope, weekActive, whoPeople: data.people.filter(inWho), last4From };
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

// ── Shared pieces ──────────────────────────────────────────────────────

function Pill({ on, onClick, children, cmp = false, id }: { on: boolean; onClick: () => void; children: ReactNode; cmp?: boolean; id?: string }) {
  return (
    <button type="button" id={id} aria-pressed={on} onClick={onClick}
      className={`${G.pill} ${on ? (cmp ? G.pillCmpOn : G.pillOn) : G.pillOff}`}>{children}</button>
  );
}

function Tile({ id, term, value, unit, north = false, onPeople }: {
  id?: string; term: ReactNode; value: number | string; unit: string; north?: boolean; onPeople?: () => void;
}) {
  return (
    <div className={`${G.card} flex flex-col gap-2 ${north ? 'ring-2 ring-zinc-900 dark:ring-zinc-100' : ''}`} id={id}>
      <div className="flex items-center justify-between gap-2">
        <span className={G.title}>{term}</span>
        {north ? <span className={AdminUI.badge.outline}>North star</span> : null}
      </div>
      <span className={G.big}>{value}</span>
      <div className="flex items-center justify-between gap-2">
        <span className={G.fine}>{unit}</span>
        {onPeople ? <button type="button" className={G.link} onClick={onPeople}>People ›</button> : null}
      </div>
    </div>
  );
}

function Bars({ values, labels, fade, tone }: { values: number[]; labels: string[]; fade: (i: number) => boolean; tone: string }) {
  const max = Math.max(1, ...values);
  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${values.length}, minmax(0, 1fr))` }}>
      {values.map((v, i) => (
        <div key={`b${i}`} className={`flex h-28 flex-col items-center justify-end gap-0.5 border-b border-zinc-200 dark:border-zinc-800 ${fade(i) ? 'opacity-30' : ''}`}>
          <span className="text-[11px] font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{v || ''}</span>
          <span className={`block w-full max-w-[26px] rounded-t ${tone}`} style={{ height: `${v ? Math.max(3, (v / max) * 90) : 0}px` }} />
        </div>
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

export function Growth({ data, onOpenPerson, onLeftOut, onRefresh, fetchJson }: {
  data: GrowthData;
  onOpenPerson: (userId: number) => void;
  onLeftOut: () => void;
  onRefresh: () => void;
  fetchJson: (path: string) => Promise<{ ok: boolean; data: unknown }>;
}) {
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
  return (
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
            {who === 'newcomers'
              ? `Season 1 accounts · ${counts.season} · Accounts from before ${dayLabel(data.eraStart)} · ${counts.older} · People they brought in · ${counts.connected} · Team, admins and tests`
              : 'Team, admins and tests'}
          </span>
        </div>
        <div className="mt-2">{help('view', 'when', 'who', 'leftOut')}</div>
      </div>
      {view === 'overview' ? <Overview data={data} r={r} when={when} saved={saved} onOpenPerson={onOpenPerson} /> : null}
      {view === 'activity' ? <Activity data={data} who={who} r={r} when={when} /> : null}
      {view === 'groups' ? <Groups data={data} r={r} fetchJson={fetchJson} onOpenPerson={onOpenPerson} /> : null}
      {view === 'sources' ? <Sources r={r} /> : null}
      {view === 'scope' ? <Scope data={data} r={r} saved={saved} onSave={(list) => { writeSaved(list); setSaved(list); }} /> : null}
    </div>
  );
}

type Reading = ReturnType<typeof useReading>;

// ── Overview ───────────────────────────────────────────────────────────

function Overview({ data, r, when, saved, onOpenPerson }: {
  data: GrowthData; r: Reading; when: When; saved: Saved[]; onOpenPerson: (id: number) => void;
}) {
  const { term, help } = useHelp();
  const [cmpKey, setCmpKey] = useState<string | null>(null);
  const [list, setList] = useState<{ step: number; cohort: string | null } | null>(null);
  const cohorts = cohortsFor(data, saved);
  const cmp = cohorts.find((c) => c.key === cmpKey) || null;
  const base = r.funnel(r.scoped);
  const cv = cmp ? r.funnel(r.scoped.filter(cmp.match)) : null;
  const back = r.groupsInScope.filter((g) => g.cameBack).length;
  const drops = base.slice(1).map((v, i) => ({ i, lost: base[i] ? 1 - v / base[i] : 0 }));
  const worst = drops.reduce((a, d) => (d.lost > a.lost ? d : a), drops[0]);
  const waitlist = r.scoped.filter((p) => p.way === 'waitlist' && p.admittedDay);
  const mail = [
    ['Let in', waitlist.length, 'bg-violet-200 dark:bg-violet-800'],
    ['On record', waitlist.filter((p) => p.mail && p.mail !== 'not_on_record').length, 'bg-violet-400'],
    ['Opened', waitlist.filter((p) => p.mail === 'opened' || p.mail === 'clicked').length, 'bg-zinc-300 dark:bg-zinc-600'],
    ['Clicked', waitlist.filter((p) => p.mail === 'clicked').length, 'bg-violet-600'],
  ] as const;
  const labels = data.weeks.map((w) => dayLabel(w));
  const fade = (i: number) => (when.kind === 'week' ? data.weeks[i] !== when.week : when.kind === 'last4' ? data.weeks[i] < r.last4From : false);
  const letIn = data.weeks.map((w) => r.whoPeople.filter((p) => weekOf(p.cameAt) === w).length);
  const active = data.weeks.map((w) => r.weekActive(w, r.whoPeople));
  const groupsWeek = data.weeks.map((w) => r.groups.filter((g) => g.weeks.includes(w)).length);
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
    return { week: w, size: ps.length, cells: data.weeks.slice(start).map((wk) => ps.filter((p) => p.activeWeeks.includes(wk)).length) };
  });
  const listPeople = list ? r.scoped.filter((p) => r.reached(p) >= list.step && (!list.cohort || cohorts.find((c) => c.key === list.cohort)?.match(p))) : [];
  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4" id="admin-journey-north-star">
        <Tile north term={term('back', 'Groups came back together')} value={back} unit="groups of 3+, a second week" onPeople={() => setList({ step: 4, cohort: null })} />
        <Tile term={term('together', 'Active groups')} value={r.groupsInScope.length} unit="groups of 3+ that acted together" onPeople={() => setList({ step: 3, cohort: null })} />
        <Tile term={term('stayed', 'Stayed 30 s+')} value={base[2]} unit={`people · ${base[1] - base[2]} of ${base[1]} left within 30 s`} onPeople={() => setList({ step: 2, cohort: null })} />
        <Tile term={term('opened', 'Opened Homeroom')} value={base[1]} unit={`people · of ${base[0]} let in`} onPeople={() => setList({ step: 1, cohort: null })} />
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
                      <span className="text-end text-[11px] text-amber-700 dark:text-amber-400">{base[i - 1] ? `${pct(base[i], base[i - 1])} kept` : ''}</span>
                      <span className="block h-4 bg-violet-100 dark:bg-violet-900/40"
                        style={{ clipPath: `polygon(${50 - prevW / 2}% 0, ${50 + prevW / 2}% 0, ${50 + Math.max(w, 0.8) / 2}% 100%, ${50 - Math.max(w, 0.8) / 2}% 100%)` }} />
                      <span />
                    </div>
                  ) : null}
                  <div className="grid grid-cols-[9rem_minmax(0,1fr)_8rem] gap-3 items-center" data-growth-step={i}>
                    <span className="text-end text-sm font-semibold text-zinc-900 dark:text-zinc-100">{term(`s${i}`, label)}</span>
                    <button type="button" className="relative block h-11 w-full" aria-label={`List the people at ${label}`}
                      onClick={() => setList({ step: i, cohort: null })}>
                      {base[i] ? <span className="absolute top-0 h-11 rounded-md bg-violet-600" style={{ left: `${50 - w / 2}%`, width: `${w}%` }} />
                        : <span className="absolute top-0 h-11 w-10 rounded-md border-2 border-dashed border-violet-600" style={{ left: 'calc(50% - 1.25rem)' }} />}
                      {cv ? (cv[i]
                        ? <span className="absolute top-4 h-3 rounded bg-amber-500 ring-2 ring-white dark:ring-zinc-900" style={{ left: `${50 - cw / 2}%`, width: `${cw}%` }} />
                        : <span className="absolute top-4 h-3 w-7 rounded border-2 border-dashed border-amber-500" style={{ left: 'calc(50% - 0.875rem)' }} />) : null}
                    </button>
                    <span className="flex flex-col leading-tight tabular-nums">
                      <span><b>{pct(base[i], base[0])}</b><span className={G.fine}> · {people(base[i])}</span></span>
                      {cv ? <span className="text-amber-700 dark:text-amber-400 text-xs"><b>{pct(cv[i], cv[0])}</b> · {people(cv[i])}</span> : null}
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
          {mail.map(([label, n, tone]) => (
            <div key={label} className="grid grid-cols-[5rem_minmax(0,1fr)_2rem] gap-2 items-center text-sm">
              <span className="text-zinc-600 dark:text-zinc-300">{label}</span>
              <span className={G.track}><span className={`block h-3 rounded ${tone}`} style={{ width: `${mail[0][1] ? (n / mail[0][1]) * 100 : 0}%` }} /></span>
              <span className="text-end font-semibold tabular-nums">{n}</span>
            </div>
          ))}
          <div className="mt-2 border-t border-zinc-100 dark:border-zinc-800 pt-3 flex flex-col gap-1">
            <span className={G.title}>{term('drop', 'Biggest drop')}</span>
            {help('drop')}
            <span className={G.big}>{worst && base[worst.i] ? `−${Math.round(worst.lost * 100)}%` : '–'}</span>
            <span className={G.fine}>{worst ? `${STEPS[worst.i]} → ${STEPS[worst.i + 1]}` : ''}</span>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        {[['wLet', 'Let in', letIn, 'bg-violet-400'], ['wActive', 'Active', active, 'bg-violet-600'], ['wGroups', 'Groups active together', groupsWeek, 'bg-zinc-900 dark:bg-zinc-100']].map(([id, title, vals, tone]) => (
          <div key={id as string} className={G.card}>
            <h3 className={`${G.title} mb-2`}>{term(id as string, title as string)}</h3>
            {help(id as string)}
            <Bars values={vals as number[]} labels={labels} fade={fade} tone={tone as string} />
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
                  <th className="pe-3 text-start font-medium whitespace-nowrap">{dayLabel(row.week)} · {row.size}</th>
                  {data.weeks.map((_, i) => {
                    const v = row.cells[i];
                    if (v == null) return <td key={`c${i}`} />;
                    const share = row.size ? v / row.size : 0;
                    return <td key={`c${i}`} className={`h-7 rounded text-center font-semibold ${v ? (share > 0.55 ? 'bg-violet-600 text-white' : 'bg-violet-200 dark:bg-violet-800 text-zinc-900 dark:text-zinc-100') : 'bg-zinc-100 dark:bg-zinc-800'}`}>{v}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className={AdminUI.muted}>Nobody in scope has been active yet.</p>}
      </div>
      {list ? (
        <Drawer kicker="Reached this step" title={STEPS[list.step]} onClose={() => setList(null)}>
          <span className="text-sm text-zinc-600 dark:text-zinc-300">{people(listPeople.length)}</span>
          {cmp ? (
            <div className="flex flex-wrap gap-1.5">
              <Pill on={!list.cohort} onClick={() => setList({ ...list, cohort: null })}>Everyone in scope</Pill>
              <Pill cmp on={list.cohort === cmp.key} onClick={() => setList({ ...list, cohort: cmp.key })}>{cmp.label}</Pill>
            </div>
          ) : null}
          <PeopleTable list={listPeople} reached={r.reached} onOpenPerson={onOpenPerson} />
        </Drawer>
      ) : null}
    </>
  );
}

function PeopleTable({ list, reached, onOpenPerson }: { list: GrowthPerson[]; reached: (p: GrowthPerson) => number; onOpenPerson: (id: number) => void }) {
  const tone = ['bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300', 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300',
    'bg-violet-100 text-violet-800 dark:bg-violet-500/20 dark:text-violet-200', 'bg-violet-600 text-white', 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'];
  return (
    <table className={AdminUI.table} data-growth-people="">
      <thead className={AdminUI.thead}>
        <tr><th className="py-2 pe-2 text-start text-xs font-medium uppercase tracking-wider text-zinc-500">Person</th>
          <th className="py-2 px-2 text-start text-xs font-medium uppercase tracking-wider text-zinc-500">Came by</th>
          <th className="py-2 px-2 text-start text-xs font-medium uppercase tracking-wider text-zinc-500">Got to</th>
          <th className="py-2 ps-2 text-end text-xs font-medium uppercase tracking-wider text-zinc-500">Last seen</th></tr>
      </thead>
      <tbody>
        {list.map((p) => {
          const step = reached(p);
          return (
            <tr key={p.key} className="border-b border-zinc-100 dark:border-zinc-800/60">
              <td className="py-2 pe-2">
                {p.userId ? <button type="button" className="font-medium text-violet-700 dark:text-violet-400 hover:underline" onClick={() => onOpenPerson(p.userId!)}>{p.name || `#${p.userId}`}</button>
                  : <span className="text-zinc-500 dark:text-zinc-400">No account yet</span>}
              </td>
              <td className="py-2 px-2 text-zinc-600 dark:text-zinc-300">{WAY_NAME[p.way]}{p.admittedDay ? ` · ${dayLabel(p.admittedDay)}` : ''}</td>
              <td className="py-2 px-2"><span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${tone[step]}`}>{STEP_SHORT[step]}</span></td>
              <td className="py-2 ps-2 text-end text-zinc-600 dark:text-zinc-300 whitespace-nowrap">{p.lastSeen ? dayLabel(p.lastSeen) : '–'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ── Activity ───────────────────────────────────────────────────────────

function Activity({ data, who, r, when }: { data: GrowthData; who: Who; r: Reading; when: When }) {
  const { term, help } = useHelp();
  const pool = r.whoPeople;
  const weeks = data.weeks;
  const life = weeks.map((w, i) => {
    const prev = weeks[i - 1];
    let nw = 0; let ret = 0; let res = 0; let dor = 0;
    for (const p of pool) {
      const now = p.activeWeeks.includes(w);
      const before = prev ? p.activeWeeks.includes(prev) : false;
      const earlier = p.activeWeeks.some((x) => x < w);
      if (now && !earlier) nw += 1;
      else if (now && before) ret += 1;
      else if (now) res += 1;
      else if (before) dor += 1;
    }
    return { w, nw, ret, res, dor };
  });
  const up = Math.max(1, ...life.map((l) => l.nw + l.ret + l.res));
  const down = Math.max(1, ...life.map((l) => l.dor));
  const scale = 110 / Math.max(up, down);
  const last4 = weeks.slice(-4);
  const l4 = [1, 2, 3, 4].map((k) => pool.filter((p) => last4.filter((w) => p.activeWeeks.includes(w)).length === k).length);
  const l4max = Math.max(1, ...l4);
  const depth: Array<[string, number]> = [
    ['Opened Homeroom', pool.filter((p) => p.last7.opened).length],
    ['Stayed 30 s+', pool.filter((p) => p.last7.used).length],
    ['Contributed', pool.filter((p) => p.last7.contributed).length],
    ['Active groups', r.groups.filter((g) => g.weeks.includes(data.thisWeek)).length],
  ];
  const dmax = Math.max(1, ...depth.map((d) => d[1]));
  const wau = data.people.filter((p) => p.last7.analyticsWau);
  const parts: Array<[string, number, string]> = [
    ['Season 1', wau.filter((p) => p.seasonEarly).length, 'bg-zinc-300 dark:bg-zinc-600'],
    ['Other early', wau.filter((p) => p.early && !p.seasonEarly).length, 'bg-zinc-500'],
    ['Brought in by them', wau.filter((p) => p.connected).length, 'bg-zinc-700 dark:bg-zinc-400'],
    ['Newcomers', wau.filter((p) => !p.early && !p.connected).length, 'bg-violet-600'],
  ];
  const fade = (w: string) => (when.kind === 'week' ? w !== when.week : when.kind === 'last4' ? w < r.last4From : false);
  return (
    <>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 items-start">
        <div className={`${G.card} xl:col-span-2`} id="admin-growth-lifecycle">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className={G.title}>{term('lifecycle', 'Weekly lifecycle')}</h3>
            <span className="flex flex-wrap gap-3 text-xs text-zinc-600 dark:text-zinc-300">
              <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-violet-300" />New</span>
              <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-violet-600" />Returning</span>
              <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-emerald-600" />Resurrecting</span>
              <span className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-amber-400" />Dormant</span>
            </span>
          </div>
          {help('lifecycle')}
          <div className="mt-3 grid gap-2" style={{ gridTemplateColumns: `repeat(${life.length}, minmax(0, 1fr))` }}>
            {life.map((l) => (
              <div key={l.w} className={`flex flex-col items-center ${fade(l.w) ? 'opacity-30' : ''} ${l.w === data.thisWeek ? 'opacity-60' : ''}`}>
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
              </div>
            ))}
          </div>
        </div>
        <div className={`${G.card} flex flex-col gap-3`}>
          <h3 className={G.title}>{term('l4', 'Weeks active, last 4')}</h3>
          {help('l4')}
          {l4.map((n, i) => (
            <div key={`l${i}`} className="grid grid-cols-[4rem_minmax(0,1fr)_2rem] gap-2 items-center text-sm">
              <span className="text-zinc-600 dark:text-zinc-300">{i + 1} {i ? 'weeks' : 'week'}</span>
              <span className={G.track}><span className="block h-3 rounded bg-violet-600" style={{ width: `${(n / l4max) * 100}%`, opacity: 0.4 + i * 0.2 }} /></span>
              <span className="text-end font-semibold tabular-nums">{n}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
        <div className={`${G.card} flex flex-col gap-3`}>
          <h3 className={G.title}>{term('depth', 'Last 7 days, by depth')}</h3>
          {help('depth')}
          {depth.map(([label, n], i) => (
            <div key={label} className="grid grid-cols-[9rem_minmax(0,1fr)_2rem] gap-2 items-center text-sm">
              <span className="text-zinc-600 dark:text-zinc-300">{label}</span>
              <span className={G.track}><span className={`block h-3 rounded ${['bg-violet-200', 'bg-violet-400', 'bg-violet-600', 'bg-zinc-900 dark:bg-zinc-100'][i]}`} style={{ width: `${(n / dmax) * 100}%` }} /></span>
              <span className="text-end font-semibold tabular-nums">{n}</span>
            </div>
          ))}
        </div>
        <div className={`${G.card} flex flex-col gap-3`} id="admin-growth-wau">
          <h3 className={G.title}>{term('wau', `Who is in Analytics' WAU of ${wau.length}`)}</h3>
          {help('wau')}
          <div className="flex h-7 overflow-hidden rounded-md gap-0.5">
            {parts.map(([label, n, tone]) => (n ? <span key={label} className={tone} style={{ flex: n }} /> : null))}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {parts.map(([label, n, tone]) => (
              <span key={label} className="inline-flex items-center gap-1.5"><span className={`h-2.5 w-2.5 rounded-sm ${tone}`} /><b className="tabular-nums">{n}</b> {label}</span>
            ))}
          </div>
          <p className={G.fine}>{who === 'newcomers' ? 'Shown for everyone: this is what the old number counts.' : ''}</p>
        </div>
      </div>
    </>
  );
}

// ── Groups ─────────────────────────────────────────────────────────────

function Groups({ data, r, fetchJson, onOpenPerson }: {
  data: GrowthData; r: Reading; fetchJson: (path: string) => Promise<{ ok: boolean; data: unknown }>; onOpenPerson: (id: number) => void;
}) {
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
                <td className="py-3 px-2 text-end tabular-nums">{g.people.length}</td>
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
      {open ? <GroupTimeline group={open} names={names} fetchJson={fetchJson} onOpenPerson={onOpenPerson} onClose={() => setOpen(null)} /> : null}
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
    const f = r.funnel(ps);
    return { w, label, came: ps.length, stayed: f[2], group: f[3] };
  });
  const waitlist = r.scoped.filter((p) => p.way === 'waitlist');
  const answers = [...new Set(waitlist.map((p) => p.heard || 'blank'))];
  const heard = answers.map((a) => {
    const ps = waitlist.filter((p) => (p.heard || 'blank') === a);
    return { a, came: ps.length, stayed: ps.filter((p) => p.stayed).length };
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
                <td className="py-3 px-2 text-end tabular-nums">{row.came}</td>
                <td className="py-3 px-2 text-end tabular-nums">{row.stayed}</td>
                <td className="py-3 ps-2 text-end tabular-nums">{row.group}</td>
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
            <span className="text-zinc-600 dark:text-zinc-300 capitalize">{h.a}</span>
            <span className={G.track}>
              <span className="flex h-3 rounded bg-violet-200 dark:bg-violet-800" style={{ width: `${(h.came / hmax) * 100}%` }}>
                <span className="block h-3 rounded bg-violet-600" style={{ width: `${h.came ? (h.stayed / h.came) * 100 : 0}%` }} />
              </span>
            </span>
            <span className="text-end tabular-nums"><b>{h.stayed}</b><span className={G.fine}> / {h.came}</span></span>
          </div>
        ))}
        <p className={G.fine}>Dark: stayed 30 s+. Light: let in.</p>
      </div>
    </div>
  );
}

// ── Scope ──────────────────────────────────────────────────────────────

function Scope({ data, r, saved, onSave }: { data: GrowthData; r: Reading; saved: Saved[]; onSave: (list: Saved[]) => void }) {
  const { term, help } = useHelp();
  const days = [...new Set(r.whoPeople.map((p) => p.admittedDay).filter((d): d is string => !!d))].sort().reverse().concat(['never']);
  const [ways, setWays] = useState<GrowthPerson['way'][]>(WAYS.map(([w]) => w));
  const [picked, setPicked] = useState<string[]>(days);
  const match = (p: GrowthPerson) => ways.includes(p.way) && picked.includes(p.admittedDay || 'never');
  const f = r.funnel(r.scoped.filter(match));
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
            <span className="tabular-nums text-zinc-500">{r.scoped.filter((p) => p.way === w && picked.includes(p.admittedDay || 'never')).length}</span>
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
            <span className="tabular-nums text-zinc-500">{r.scoped.filter((p) => (p.admittedDay || 'never') === d && ways.includes(p.way)).length}</span>
          </label>
        ))}
      </div>
      <div className={`${G.card} flex flex-col gap-3`}>
        <h3 className={G.title}>This scope · {people(f[0])}</h3>
        {STEPS.map((label, i) => (
          <div key={label} className="grid grid-cols-[8.5rem_minmax(0,1fr)_2.5rem] gap-2 items-center text-sm">
            <span className="text-zinc-600 dark:text-zinc-300">{label}</span>
            <span className={G.track}><span className="block h-3 rounded bg-violet-600" style={{ width: `${f[0] ? (f[i] / f[0]) * 100 : 0}%` }} /></span>
            <span className="text-end font-semibold tabular-nums">{f[i]}</span>
          </div>
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
