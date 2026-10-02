'use strict';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// Journey (#admin/journey, #3369): the user journey and the North Star.
//
// One read surface over the endpoints slice 1 shipped under
// /api/admin/journey/* (src/services/journey.js). The page leads with the
// three things someone acts on this week: active groups against the week
// before, newcomers stuck on a step, and open turns. Everything else is one
// tap away in a dialog, so opening a detail never moves the page under the
// reader: the first mile per cohort, the seven stages, the loops, the
// next-step counts, the left-out list and one person.
//
// Three rules from the endpoints are kept on screen, and the section test
// pins them:
// - a reading the platform does not record arrives as
//   `{ recorded: false, reason }` and reads "not recorded yet", never 0;
// - Hear back arrives as `{ status: 'coming' }` and reads "coming";
// - counts and names only: no percentages, no charts.
//
// Analytics is a separate section with its own definitions; this one does
// not read or change it. On screen it is "project", never "app".
//
// PERMISSIONS: any admin reads. Only the left-out list writes, and its
// controls show for a full admin only (the routes enforce the same).

// Under staging with ?demo=1 every Journey route answers a whole, labelled
// demo payload (src/services/journey-demo.js). Guarded: the SSG prerender
// pass evaluates this module in Node.
const DEMO = typeof window !== 'undefined'
  && new URLSearchParams(location.search).get('demo') === '1';

const consoleApi = () => (window as any).AdminConsole;

// ── Vocabulary ─────────────────────────────────────────────────────────

const MILE_STEPS: Record<string, string> = {
  admitted: 'Admitted',
  mail_sent: 'Admit mail sent',
  code_asked: 'Asked for a login code',
  account: 'Account created',
  access: 'Has access',
  opened: 'Opened Homeroom',
  username: 'Username chosen',
  join: 'Join screen answered',
  first_act: 'First act',
};

const STAGES: Array<[string, string, string]> = [
  ['arrive', 'Arrive', 'did anything we record'],
  ['explore', 'Explore', 'found something new on their own, or came back to something'],
  ['activate', 'Activate', 'gave feedback, voted or made a change'],
  ['belong', 'Belong', 'acted on another real person\'s work'],
  ['use', 'Use', 'had a change go live with someone else\'s yes'],
  ['stay', 'Stay', 'arrived this week and again the next'],
  ['invite', 'Invite', 'let someone in who then did something'],
];

const LOOP_STEPS: Record<string, string> = {
  notice: 'Notice',
  make_sense: 'Make sense',
  sketch: 'Sketch',
  decide: 'Decide',
  go_live: 'Go live',
  hear_back: 'Hear back',
};

const INVITE_STEPS: Record<string, string> = {
  invited: 'Invited',
  arrived: 'Arrived',
  did_something: 'Did something',
  invited_someone: 'Invited someone',
};

const SCREENS: Record<string, string> = {
  home: 'Home',
  discover: 'Discover',
  communities: 'Communities',
  challenges: 'Challenges',
  profile: 'Profile',
  my_proposals: 'My proposals',
  settings: 'Settings',
  messages: 'Messages',
  assistant: 'Assistant',
  agent_session: 'Agent session',
  app: 'A project',
  project: 'Project page',
  username_sheet: 'Username sheet',
  terms_sheet: 'Terms sheet',
  join_sheet: 'Join screen',
  tour: 'Tour',
  back: 'Back',
};

const WAYS: Record<string, string> = {
  own: 'on their own',
  nudged: 'from a notification',
  handed: 'from an invite link',
  address: 'from an address',
  back: 'by going back',
  returned: 'coming back after a break',
};

const LIFECYCLE: Record<string, { label: string; cls: string }> = {
  new: { label: 'New', cls: AdminUI.badge.success },
  back: { label: 'Back', cls: AdminUI.badge.secondary },
  still_active: { label: 'Still active', cls: AdminUI.badge.default },
  went_quiet: { label: 'Went quiet', cls: AdminUI.badge.warn },
};

const ACTIVATE_KINDS: Record<string, string> = { feedback: 'feedback', vote: 'vote', change: 'change' };

// Local class recipes: complete literals, because Tailwind's extractor is a
// regex over this file's source (see the AdminUI note in admin-console.js).
const JUI = Object.freeze({
  card: `${AdminUI.card} p-4 sm:p-5`,
  blockTitle: 'text-base font-semibold text-zinc-900 dark:text-zinc-100',
  headline: 'text-3xl font-bold text-zinc-900 dark:text-zinc-100',
  label: 'text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400',
  fine: 'text-xs text-zinc-500 dark:text-zinc-400',
  row: 'flex flex-wrap items-baseline gap-x-2 gap-y-1 py-2 border-b border-zinc-100 dark:border-zinc-800/60 last:border-b-0',
  pill: 'inline-flex items-center gap-1 rounded-full bg-zinc-100 dark:bg-zinc-800 px-3 py-1 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors',
  pillWarn: 'inline-flex items-center gap-1 rounded-full bg-amber-50 dark:bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-500/20 transition-colors',
  name: 'font-medium text-violet-700 dark:text-violet-400 hover:underline',
  strip: 'flex flex-wrap gap-1.5',
  stripCell: 'flex flex-col items-start rounded-lg bg-zinc-100 dark:bg-zinc-800 px-2.5 py-1.5 min-w-[4.5rem]',
  stripCount: 'text-lg font-semibold text-zinc-900 dark:text-zinc-100',
  dialogPanel: 'w-full max-w-2xl max-h-[82vh] overflow-y-auto bg-white dark:bg-zinc-900 rounded-2xl p-5 shadow-xl',
  chip: 'rounded-full px-3 py-1 text-xs font-medium transition-colors',
  chipOn: 'bg-violet-600 text-white',
  chipOff: 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700',
  path: 'flex flex-wrap gap-1 text-xs',
  pathStep: 'rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 text-zinc-700 dark:text-zinc-300',
});

// ── Types (the parts of the payloads this page reads) ──────────────────

type NotRecorded = { recorded: false; reason: string };
type Count = number | NotRecorded | null | undefined;
type Person = { userId: number | null; name: string };
type Group = { slug: string; name: string; changes?: number; people: Person[]; lifecycle: string; why?: string };
type Turn = {
  project: string; slug: string; number: number; title: string; reporter?: Person | null;
  step: string; since: string; days: number; holder: string | null;
};
type Stuck = { userId: number | null; name: string; cohort: string; stuckAt: string; reason: string | null; days: number; failedAttempts: number };
type MileStep = { key: string; state: string; at: string | null; note: string | null; weak?: boolean };
type MilePerson = {
  userId: number | null; name: string; steps: MileStep[]; furthest: string | null; stuckAt: string | null;
  stuckReason: string | null; daysSince: number; failedAttempts: number; repeatedTaps: number;
  tour: { ended: string; step: number | null; at: string | null } | null;
};
type Summary = {
  demo?: boolean;
  week: string;
  thisWeekSoFar: { week: string; count: number };
  groups: {
    week: string; finished: boolean; count: number; groups: Group[]; wentQuiet: Group[];
    oneShort: Group[]; homeroom: { changes: number; people: number } | null;
  };
  stuck: Stuck[];
  openTurns: Turn[];
  trust: {
    withoutGroupVote: { count: number; of: number; atLeastForced: number; changes: Array<{ slug: string; project: string; author: string; forced: boolean }> };
    teamShare: { team: number; of: number };
    lockstep: { possible: Array<{ userId: number; name: string; yesVotes: number; withinSeconds: number }>; cutoffs: Record<string, number> };
  };
  coverage: { activePeople: number; withNavigation: number; byDay: Array<{ day: string; build: string; rows: number }> };
};

type OpenPerson = (userId: number) => void;
type DialogKey = 'mile' | 'stages' | 'loops' | 'next' | 'leftout' | 'checks';

// ── Small pieces ───────────────────────────────────────────────────────

function isNotRecorded(v: unknown): v is NotRecorded {
  return !!v && typeof v === 'object' && (v as NotRecorded).recorded === false;
}

/** A count, or "not recorded yet" with its reason: never a silent zero. */
function Num({ v }: { v: Count }) {
  if (isNotRecorded(v)) return <span className={JUI.fine} title={v.reason}>not recorded yet</span>;
  if (v == null) return <span>—</span>;
  return <span>{v}</span>;
}

function weekLabel(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function when(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
}

function gap(fromIso: string | null, toIso: string | null): string {
  if (!fromIso || !toIso) return '';
  const mins = Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60000);
  if (!Number.isFinite(mins) || mins < 0) return '';
  if (mins < 60) return `+${mins} min`;
  if (mins < 48 * 60) return `+${Math.round(mins / 60)} h`;
  return `+${Math.round(mins / 1440)} days`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function days(n: number | null | undefined): string {
  if (n == null) return '';
  return n === 1 ? '1 day' : `${n} days`;
}

function screenLabel(code: string): string {
  const [screen, slug] = code.split(':');
  if (slug) return slug;
  return SCREENS[screen] || screen;
}

function NameButton({ person, onOpen }: { person: Person | null | undefined; onOpen: OpenPerson }) {
  if (!person) return <span className={JUI.fine}>nobody</span>;
  if (person.userId == null) return <span>{person.name}</span>;
  const id = person.userId;
  return (
    <button type="button" className={JUI.name} data-journey-person={id} onClick={() => onOpen(id)}>
      {person.name}
    </button>
  );
}

function Names({ people, onOpen }: { people: Person[]; onOpen: OpenPerson }) {
  if (!people.length) return <span className={JUI.fine}>nobody</span>;
  return (
    <span className="inline-flex flex-wrap gap-x-2 gap-y-1">
      {people.map((p, i) => <NameButton key={`${p.userId ?? p.name}-${i}`} person={p} onOpen={onOpen} />)}
    </span>
  );
}

function Block({ id, title, aside, children }: { id: string; title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className={JUI.card}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
        <h3 className={JUI.blockTitle}>{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className={AdminUI.muted}>{children}</p>;
}

// ── Data loading ───────────────────────────────────────────────────────

function withDemo(path: string): string {
  if (!DEMO) return path;
  return `${path}${path.includes('?') ? '&' : '?'}demo=1`;
}

/** One GET, re-run when `path` changes; a late answer never replaces a newer one. */
function useJourney<T>(path: string | null): { data: T | null; failed: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    if (!path) return undefined;
    const mine = ++seq.current;
    setFailed(false);
    consoleApi().fetchJson(withDemo(path)).then((res: { ok: boolean; data: T | null }) => {
      if (mine !== seq.current) return;
      if (!res.ok || !res.data) { setFailed(true); setData(null); return; }
      setData(res.data);
    });
    return () => { seq.current += 1; };
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, failed, reload };
}

function Loading({ failed, what }: { failed: boolean; what: string }) {
  if (failed) return <p className={AdminUI.muted}>Could not load {what}. Try Refresh.</p>;
  return <p className={AdminUI.loading}>Loading {what}…</p>;
}

// ── Dialog shell ───────────────────────────────────────────────────────

function Dialog({ id, title, onClose, children }: { id: string; title: string; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // Only the topmost dialog answers Escape: a person opened from inside
    // another dialog closes on its own.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const open = document.querySelectorAll('[data-journey-dialog]');
      if (open[open.length - 1] === panel.current) onClose();
    };
    document.addEventListener('keydown', onKey);
    panel.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className={AdminUI.dialogOverlay} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div id={id} ref={panel} tabIndex={-1} data-journey-dialog="" role="dialog" aria-modal="true" aria-label={title}
        className={`${JUI.dialogPanel} outline-none`}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <h3 className={AdminUI.sectionTitle}>{title}</h3>
          <button type="button" className={`${AdminUI.btn.ghost} text-xl leading-none px-1`} aria-label="Close" onClick={onClose}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── The page's three leading blocks ────────────────────────────────────

function GroupsBlock({ s, onOpen, onDialog }: { s: Summary; onOpen: OpenPerson; onDialog: (k: DialogKey) => void }) {
  const g = s.groups;
  const weekBefore = g.groups.filter((x) => x.lifecycle === 'still_active').length + g.wentQuiet.length;
  const t = s.trust;
  const lockstep = t.lockstep.possible || [];
  return (
    <Block id="admin-journey-groups" title="Active groups">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-1 mb-3">
        <div>
          <div id="admin-journey-north-star" className={JUI.headline}>{g.count}</div>
          <div className={JUI.fine}>week of {weekLabel(g.week)}{g.finished ? '' : ', so far'}</div>
        </div>
        <div>
          <div className="text-xl font-semibold text-zinc-700 dark:text-zinc-300">{weekBefore}</div>
          <div className={JUI.fine}>the week before</div>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 mb-3" id="admin-journey-checks">
        <button type="button" className={t.withoutGroupVote.count ? JUI.pillWarn : JUI.pill} onClick={() => onDialog('checks')}>
          {t.withoutGroupVote.count} of {t.withoutGroupVote.of} live without a group vote
        </button>
        <button type="button" className={JUI.pill} onClick={() => onDialog('checks')}>
          Team made {t.teamShare.team} of {t.teamShare.of}
        </button>
        <button type="button" className={lockstep.length ? JUI.pillWarn : JUI.pill} onClick={() => onDialog('checks')}>
          Lockstep: {lockstep.length ? `${lockstep.length} possible` : 'none'}
        </button>
        <button type="button" className={s.coverage.withNavigation < s.coverage.activePeople ? JUI.pillWarn : JUI.pill}
          onClick={() => onDialog('checks')}>
          Navigation from {s.coverage.withNavigation} of {s.coverage.activePeople} active
        </button>
      </div>
      {g.groups.length ? (
        <div>
          {g.groups.map((grp) => {
            const lc = LIFECYCLE[grp.lifecycle] || LIFECYCLE.still_active;
            return (
              <div key={grp.slug} className={JUI.row} data-journey-group={grp.slug}>
                <span className="font-medium">{grp.name}</span>
                <span className={lc.cls}>{lc.label}</span>
                <span className={JUI.fine}>{grp.changes} live</span>
                <span className="basis-full sm:basis-auto"><Names people={grp.people} onOpen={onOpen} /></span>
              </div>
            );
          })}
        </div>
      ) : <Empty>No project had an active group this week.</Empty>}
      {g.wentQuiet.length ? (
        <div className="mt-3">
          <div className={JUI.label}>Went quiet: talk to them</div>
          {g.wentQuiet.map((grp) => (
            <div key={grp.slug} className={JUI.row} data-journey-quiet={grp.slug}>
              <span className="font-medium">{grp.name}</span>
              <span className={AdminUI.badge.warn}>Went quiet</span>
              <Names people={grp.people} onOpen={onOpen} />
            </div>
          ))}
        </div>
      ) : null}
      {g.oneShort.length ? (
        <div className="mt-3">
          <div className={JUI.label}>One short</div>
          {g.oneShort.map((grp) => (
            <div key={grp.slug} className={JUI.row} data-journey-short={grp.slug}>
              <span className="font-medium">{grp.name}</span>
              <Names people={grp.people} onOpen={onOpen} />
              <span className={JUI.fine}>{grp.why}</span>
            </div>
          ))}
        </div>
      ) : null}
      <p className={`${JUI.fine} mt-3`}>
        This week so far: {s.thisWeekSoFar.count}.
        {g.homeroom ? ` Homeroom itself: ${g.homeroom.changes} live, ${g.homeroom.people} people, not counted.` : ''}
      </p>
    </Block>
  );
}

function StuckBlock({ s, onOpen }: { s: Summary; onOpen: OpenPerson }) {
  return (
    <Block id="admin-journey-stuck" title="Stuck newcomers" aside={<span className={JUI.fine}>longest first</span>}>
      {s.stuck.length ? s.stuck.map((p, i) => (
        <div key={`${p.userId ?? p.name}-${i}`} className={JUI.row} data-journey-stuck={p.stuckAt}>
          <NameButton person={p} onOpen={onOpen} />
          <span className="text-sm">before <b className="font-medium">{MILE_STEPS[p.stuckAt] || p.stuckAt}</b></span>
          <span className={JUI.fine}>{days(p.days)}</span>
          {p.failedAttempts ? <span className={AdminUI.badge.destructive}>{p.failedAttempts} failed</span> : null}
          {p.reason ? <span className={`${JUI.fine} basis-full`}>{p.reason} · admitted {weekLabel(p.cohort)}</span> : null}
        </div>
      )) : <Empty>No newcomer is stuck.</Empty>}
    </Block>
  );
}

function TurnRow({ turn, onOpen }: { turn: Turn; onOpen: OpenPerson }) {
  return (
    <div className={JUI.row} data-journey-turn={`${turn.slug}#${turn.number}`}>
      <span className="font-medium">{turn.project}</span>
      <span className="text-sm">#{turn.number} {turn.title}</span>
      <span className={AdminUI.badge.default}>{LOOP_STEPS[turn.step] || turn.step}</span>
      <span className={JUI.fine}>{days(turn.days)}</span>
      <span className={`${JUI.fine} basis-full`}>
        {turn.holder ? `held by ${turn.holder}` : 'nobody holds it'}
        {turn.reporter ? <> · from <NameButton person={turn.reporter} onOpen={onOpen} /></> : null}
      </span>
    </div>
  );
}

function TurnsBlock({ s, onOpen }: { s: Summary; onOpen: OpenPerson }) {
  return (
    <Block id="admin-journey-turns" title="Open turns" aside={<span className={JUI.fine}>oldest first</span>}>
      {s.openTurns.length ? s.openTurns.map((t) => <TurnRow key={`${t.slug}#${t.number}`} turn={t} onOpen={onOpen} />)
        : <Empty>No open turns.</Empty>}
    </Block>
  );
}

// ── Dialogs ────────────────────────────────────────────────────────────

function ChecksDialog({ s, onOpen, onClose }: { s: Summary; onOpen: OpenPerson; onClose: () => void }) {
  const t = s.trust;
  const c = t.lockstep.cutoffs || {};
  return (
    <Dialog id="admin-journey-checks-dialog" title="Checks" onClose={onClose}>
      <div className={JUI.label}>Live without a group vote</div>
      <p className={`${AdminUI.muted} mb-1`}>
        {t.withoutGroupVote.count} of {t.withoutGroupVote.of} changes by people went live with no yes from another real person
        {t.withoutGroupVote.atLeastForced ? `; at least ${t.withoutGroupVote.atLeastForced} forced` : ''}.
      </p>
      {t.withoutGroupVote.changes.map((ch, i) => (
        <div key={`${ch.slug}-${i}`} className={JUI.row}>
          <span className="font-medium">{ch.project}</span>
          <span className="text-sm">by {ch.author}</span>
          {ch.forced ? <span className={AdminUI.badge.warn}>forced</span> : null}
        </div>
      ))}
      <div className={`${JUI.label} mt-4`}>Team&apos;s share</div>
      <p className={AdminUI.muted}>The team made {t.teamShare.team} of the week&apos;s {t.teamShare.of} live changes.</p>
      <div className={`${JUI.label} mt-4`}>Lockstep</div>
      <p className={`${AdminUI.muted} mb-1`}>
        A warning, never a filter: at least {c.minYesVotes} yes votes in the week, and at least {Math.round((c.minShare || 0) * 10)} in 10 of
        them within {c.withinSeconds} seconds of another account&apos;s yes on the same change.
      </p>
      {t.lockstep.possible.length ? t.lockstep.possible.map((p) => (
        <div key={p.userId} className={JUI.row}>
          <NameButton person={p} onOpen={onOpen} />
          <span className={JUI.fine}>{p.withinSeconds} of {p.yesVotes} yes votes close to another account&apos;s</span>
        </div>
      )) : <Empty>Nobody this week.</Empty>}
      <div className={`${JUI.label} mt-4`}>Coverage</div>
      <p className={`${AdminUI.muted} mb-1`}>
        {s.coverage.withNavigation} of {s.coverage.activePeople} people active on the server have navigation recorded.
        A gap means an old shell or a broken hook, not people who stopped exploring.
      </p>
      {s.coverage.byDay.map((d) => (
        <div key={`${d.day}-${d.build}`} className={JUI.row}>
          <span className="text-sm">{weekLabel(d.day)}</span>
          <span className="font-mono text-xs">{d.build || 'unknown build'}</span>
          <span className={JUI.fine}>{d.rows} rows</span>
        </div>
      ))}
    </Dialog>
  );
}

type Cohorts = { cohorts: Array<{ day: string; admitted: number; withAccount: number }>; otherWay: { people: number } };
type FirstMile = {
  cohort: string; people: MilePerson[];
  steps: Array<{ key: string; passed: number; stuck: Array<Person & { days: number; reason: string | null }> }>;
  notRecorded?: Record<string, NotRecorded>;
};

function CohortChips({ cohorts, value, onPick, all }: {
  cohorts: Cohorts | null; value: string | null; onPick: (v: string | null) => void; all?: string;
}) {
  if (!cohorts) return null;
  const chip = (v: string | null, label: string) => (
    <button key={v ?? 'all'} type="button" className={`${JUI.chip} ${value === v ? JUI.chipOn : JUI.chipOff}`}
      aria-pressed={value === v} onClick={() => onPick(v)}>{label}</button>
  );
  return (
    <div className="flex flex-wrap gap-1.5 mb-3">
      {all ? chip(null, all) : null}
      {cohorts.cohorts.map((c) => chip(c.day, `${weekLabel(c.day)} · ${c.admitted}`))}
      {chip('other_way', `Came in another way · ${cohorts.otherWay.people}`)}
    </div>
  );
}

function MileDialog({ onOpen, onClose }: { onOpen: OpenPerson; onClose: () => void }) {
  const { data: cohorts, failed: cohortsFailed } = useJourney<Cohorts>('/api/admin/journey/cohorts');
  const [day, setDay] = useState<string | null>(null);
  const picked = day || cohorts?.cohorts[0]?.day || (cohorts ? 'other_way' : null);
  const { data: mile, failed } = useJourney<FirstMile>(picked ? `/api/admin/journey/first-mile?admitted=${picked}` : null);
  return (
    <Dialog id="admin-journey-mile-dialog" title="First mile" onClose={onClose}>
      <p className={`${AdminUI.muted} mb-3`}>A cohort is everyone admitted on the same day. Each person sits at the furthest step they reached.</p>
      {cohorts ? <CohortChips cohorts={cohorts} value={picked} onPick={(v) => setDay(v)} /> : <Loading failed={cohortsFailed} what="cohorts" />}
      {mile ? (
        <>
          {mile.people.length ? (
            <div className="mb-4">
              {mile.steps.map((st) => (
                <div key={st.key} className={JUI.row} data-journey-mile-step={st.key}>
                  <span className="text-sm w-44 shrink-0">{MILE_STEPS[st.key] || st.key}</span>
                  <span className="font-semibold">{st.passed}</span>
                  {st.stuck.length ? (
                    <span className="basis-full sm:basis-auto text-sm">
                      stuck before it: <Names people={st.stuck} onOpen={onOpen} />
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : <Empty>Nobody in this cohort.</Empty>}
          {mile.people.map((p, i) => (
            <div key={`${p.userId ?? p.name}-${i}`} className={JUI.row}>
              <NameButton person={p} onOpen={onOpen} />
              <span className={JUI.fine}>furthest: {p.furthest ? MILE_STEPS[p.furthest] || p.furthest : 'none yet'}</span>
              {p.stuckReason ? <span className={AdminUI.badge.warn}>{p.stuckReason}</span> : null}
            </div>
          ))}
          {Object.values(mile.notRecorded || {}).map((n, i) => <p key={i} className={`${JUI.fine} mt-3`}>Not recorded yet: {n.reason}</p>)}
        </>
      ) : picked ? <Loading failed={failed} what="the first mile" /> : null}
    </Dialog>
  );
}

type Stages = {
  week: string; finished: boolean; counts: Record<string, Count>;
  stoppedAt: Record<string, Person[]>;
  people: Array<Person & { activateKinds: string[] }>;
};

function StagesDialog({ week, onOpen, onClose }: { week: string | null; onOpen: OpenPerson; onClose: () => void }) {
  const { data, failed } = useJourney<Stages>(`/api/admin/journey/stages${week ? `?week=${week}` : ''}`);
  return (
    <Dialog id="admin-journey-stages-dialog" title="Stages" onClose={onClose}>
      {data ? (
        <>
          <p className={`${AdminUI.muted} mb-3`}>Week of {weekLabel(data.week)}{data.finished ? '' : ', so far'}. One yes or no per person.</p>
          <div className={`${JUI.strip} mb-4`}>
            {STAGES.map(([key, label]) => (
              <div key={key} className={JUI.stripCell} data-journey-stage={key}>
                <span className={JUI.label}>{label}</span>
                <span className={JUI.stripCount}><Num v={data.counts[key]} /></span>
              </div>
            ))}
          </div>
          {STAGES.map(([key, label, means]) => {
            const stopped = data.stoppedAt[key] || [];
            return (
              <div key={key} className={JUI.row}>
                <span className="text-sm w-20 shrink-0 font-medium">{label}</span>
                <span className={`${JUI.fine} basis-full sm:basis-auto sm:flex-1`}>{means}</span>
                {stopped.length ? (
                  <span className="basis-full text-sm">stopped here: <Names people={stopped} onOpen={onOpen} /></span>
                ) : null}
              </div>
            );
          })}
          {data.people.some((p) => p.activateKinds.length) ? (
            <>
              <div className={`${JUI.label} mt-4`}>How they activated</div>
              {data.people.filter((p) => p.activateKinds.length).map((p) => (
                <div key={p.userId ?? p.name} className={JUI.row}>
                  <NameButton person={p} onOpen={onOpen} />
                  {p.activateKinds.map((k) => <span key={k} className={AdminUI.badge.secondary}>{ACTIVATE_KINDS[k] || k}</span>)}
                </div>
              ))}
            </>
          ) : null}
        </>
      ) : <Loading failed={failed} what="the stages" />}
    </Dialog>
  );
}

type Coming = { status: 'coming' };
type Loops = {
  change: {
    week: string; steps: string[]; atStep: Record<string, number | Coming>; turnsClosed: Coming | number;
    live: Turn[]; open: Turn[];
    perProject: Array<{ slug: string; project: string; thisWeek: number; lastWeek: number; alsoLastWeek: boolean }>;
  };
  invite: {
    steps: string[]; counts: Record<string, number>;
    pairs: Array<{ host: Person; invitee: Person; letInAt: string; arrived: boolean; didSomething: boolean; invitedSomeone: boolean }>;
  };
};

function isComing(v: unknown): v is Coming {
  return !!v && typeof v === 'object' && (v as Coming).status === 'coming';
}

function LoopsDialog({ week, onOpen, onClose }: { week: string | null; onOpen: OpenPerson; onClose: () => void }) {
  const { data, failed } = useJourney<Loops>(`/api/admin/journey/loops${week ? `?week=${week}` : ''}`);
  return (
    <Dialog id="admin-journey-loops-dialog" title="Loops" onClose={onClose}>
      {data ? (
        <>
          <div className={JUI.label}>Change loop, in turns</div>
          <p className={`${AdminUI.muted} mb-2`}>Each piece of feedback or request, at the step it has reached.</p>
          <div className={`${JUI.strip} mb-4`}>
            {data.change.steps.map((key) => {
              const v = data.change.atStep[key];
              return (
                <div key={key} className={JUI.stripCell} data-journey-loop-step={key}>
                  <span className={JUI.label}>{LOOP_STEPS[key] || key}</span>
                  <span className={isComing(v) ? `${JUI.fine} py-1` : JUI.stripCount}>{isComing(v) ? 'coming' : v}</span>
                </div>
              );
            })}
          </div>
          <p className={`${JUI.fine} -mt-2 mb-4`}>
            Hear back closes a turn: the person who noticed is told it went live, and what they notice next starts the
            next turn. It is coming, so no turn closes yet.
          </p>
          {data.change.perProject.length ? (
            <>
              <div className={JUI.label}>Turns per project</div>
              {data.change.perProject.map((p) => (
                <div key={p.slug} className={JUI.row}>
                  <span className="font-medium">{p.project}</span>
                  <span className="text-sm">{p.thisWeek} this week</span>
                  <span className={JUI.fine}>{p.lastWeek} the week before</span>
                </div>
              ))}
            </>
          ) : null}
          {data.change.live.length ? (
            <>
              <div className={`${JUI.label} mt-4`}>Went live</div>
              {data.change.live.map((t) => <TurnRow key={`${t.slug}#${t.number}`} turn={t} onOpen={onOpen} />)}
            </>
          ) : null}
          <div className={`${JUI.label} mt-4`}>Open</div>
          {data.change.open.length ? data.change.open.map((t) => <TurnRow key={`${t.slug}#${t.number}`} turn={t} onOpen={onOpen} />)
            : <Empty>No open turns.</Empty>}
          <div className={`${JUI.label} mt-5`}>Invite loop</div>
          <div className={`${JUI.strip} mb-2 mt-1`}>
            {data.invite.steps.map((key) => (
              <div key={key} className={JUI.stripCell}>
                <span className={JUI.label}>{INVITE_STEPS[key] || key}</span>
                <span className={JUI.stripCount}>{data.invite.counts[key]}</span>
              </div>
            ))}
          </div>
          {data.invite.pairs.map((p, i) => (
            <div key={i} className={JUI.row}>
              <NameButton person={p.host} onOpen={onOpen} />
              <span className={JUI.fine}>let in</span>
              <NameButton person={p.invitee} onOpen={onOpen} />
              <span className={JUI.fine}>
                {[p.arrived ? 'arrived' : 'not arrived', p.didSomething ? 'did something' : null, p.invitedSomeone ? 'invited someone' : null]
                  .filter(Boolean).join(' · ')}
              </span>
            </div>
          ))}
        </>
      ) : <Loading failed={failed} what="the loops" />}
    </Dialog>
  );
}

type NextSteps = {
  people: number;
  leftOut: { droppedEvents: number[]; noNavigation: number[] };
  starts: Array<{ screen: string; visits: number; people: number }>;
  rows: Array<{
    screen: string; moves: number; people: number;
    next: Array<{ to: string; moves: number; people: number }>;
    other: number; left: { moves: number; people: number }; deadEnd: boolean; few: boolean;
  }>;
};

function NextDialog({ onClose }: { onClose: () => void }) {
  const { data: cohorts } = useJourney<Cohorts>('/api/admin/journey/cohorts');
  const [scope, setScope] = useState<string | null>(null);
  const { data, failed } = useJourney<NextSteps>(`/api/admin/journey/next-steps${scope ? `?admitted=${scope}` : ''}`);
  return (
    <Dialog id="admin-journey-next-dialog" title="Next steps" onClose={onClose}>
      <p className={`${AdminUI.muted} mb-3`}>Where newcomers went from each screen in their first 28 days. Moves, with the people who made them.</p>
      <CohortChips cohorts={cohorts} value={scope} onPick={setScope} all="All newcomers" />
      {data ? (
        <>
          <p className={`${JUI.fine} mb-2`}>
            {data.people} people.
            {data.leftOut.droppedEvents.length ? ` ${data.leftOut.droppedEvents.length} left out: some of their telemetry was lost.` : ''}
            {data.leftOut.noNavigation.length ? ` ${data.leftOut.noNavigation.length} with no navigation recorded.` : ''}
          </p>
          {data.starts.length ? (
            <p className="text-sm mb-3">
              Visits start on {data.starts.map((st) => `${screenLabel(st.screen)} ${st.visits}`).join(', ')}.
            </p>
          ) : null}
          {data.rows.length ? data.rows.map((r) => (
            <div key={r.screen} className={JUI.row} data-journey-next={r.screen}>
              <span className="font-medium w-28 shrink-0">{screenLabel(r.screen)}</span>
              <span className={JUI.fine}>{r.moves} moves, {r.people} people</span>
              {r.deadEnd ? <span className={AdminUI.badge.warn}>mostly left or back</span> : null}
              {r.few ? <span className={AdminUI.badge.outline}>few</span> : null}
              <span className="basis-full text-sm">
                {r.next.map((n) => `${screenLabel(n.to)} ${n.moves}`).join(', ')}
                {r.other ? `, Other ${r.other}` : ''}
                {`, Left ${r.left.moves}`}
              </span>
            </div>
          )) : <Empty>No navigation recorded for these people yet.</Empty>}
        </>
      ) : <Loading failed={failed} what="the next steps" />}
    </Dialog>
  );
}

type LeftOutEntry = { userId: number; username: string | null; reason: string; note: string | null; addedBy: string | number | null; addedAt: string };
type Suggestion = { id: number; username: string; matched_on?: string };

function LeftOutDialog({ onOpen, onClose }: { onOpen: OpenPerson; onClose: () => void }) {
  const { data, failed, reload } = useJourney<{ people: LeftOutEntry[] }>('/api/admin/journey/left-out');
  // The demo list is invented, so editing it would write to the real one.
  const canWrite = !DEMO && !!consoleApi()?.canWrite?.();
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<Suggestion[] | null>(null);
  const [pick, setPick] = useState<Suggestion | null>(null);
  const [reason, setReason] = useState('test');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    const q = query.trim().replace(/^@/, '');
    if (!q) return;
    setError(null);
    const res = await consoleApi().fetchJson(`/api/admin/support/search?q=${encodeURIComponent(q)}`);
    if (!res.ok || !res.data) { setMatches([]); setError('Type at least 3 characters, or a user id.'); return; }
    setMatches((res.data.results || []).slice(0, 8));
  };

  // Confirmations stay inside this dialog: the shell's confirm sheet is
  // translucent and reads as noise over an open dialog. Choosing "Objected"
  // shows what it erases above a red button, and Remove asks once in its row.
  const [removing, setRemoving] = useState<number | null>(null);

  const add = async () => {
    if (!pick) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/journey/left-out', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: pick.id, reason, note: note.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error || 'Could not add this person.'); return; }
      setPick(null); setMatches(null); setQuery(''); setNote('');
      reload();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (entry: LeftOutEntry) => {
    setRemoving(null);
    const res = await fetch(`/api/admin/journey/left-out/${entry.userId}`, { method: 'DELETE' });
    if (!res.ok) { setError('Could not remove this entry.'); return; }
    reload();
  };

  return (
    <Dialog id="admin-journey-leftout-dialog" title="Left out" onClose={onClose}>
      <p className={`${AdminUI.muted} mb-3`}>
        People kept out of every Journey number. A test account keeps its telemetry; someone who objected has theirs erased
        and no longer recorded.
      </p>
      {data ? (data.people.length ? data.people.map((e) => (
        <div key={e.userId} className={JUI.row} data-journey-leftout={e.userId}>
          <NameButton person={{ userId: e.userId, name: e.username || `#${e.userId}` }} onOpen={onOpen} />
          <span className={e.reason === 'objected' ? AdminUI.badge.destructive : AdminUI.badge.default}>
            {e.reason === 'objected' ? 'Objected' : 'Test account'}
          </span>
          {e.note ? <span className={JUI.fine}>{e.note}</span> : null}
          <span className={`${JUI.fine} sm:ml-auto`}>{weekLabel((e.addedAt || '').slice(0, 10))}</span>
          {canWrite && removing !== e.userId ? (
            <button type="button" className={`${AdminUI.btn.ghost} text-xs`} onClick={() => setRemoving(e.userId)}>Remove</button>
          ) : null}
          {canWrite && removing === e.userId ? (
            <span className="basis-full flex flex-wrap items-center gap-2 text-sm">
              {e.reason === 'objected'
                ? 'Count them again? Recording starts again; what was erased does not come back.'
                : 'Count them again in every Journey number?'}
              <button type="button" className={AdminUI.btn.outlineSm} onClick={() => remove(e)}>Remove from the list</button>
              <button type="button" className={`${AdminUI.btn.ghost} text-xs`} onClick={() => setRemoving(null)}>Keep</button>
            </span>
          ) : null}
        </div>
      )) : <Empty>Nobody is left out.</Empty>) : <Loading failed={failed} what="the list" />}
      {canWrite ? (
        <div className="mt-4 space-y-2">
          <div className={JUI.label}>Leave someone out</div>
          {pick ? (
            <div className="space-y-2">
              <p className="text-sm">{pick.username} <span className={JUI.fine}>#{pick.id}</span>
                <button type="button" className={`${AdminUI.btn.link} text-xs ml-2`} onClick={() => setPick(null)}>Change</button>
              </p>
              <select className={AdminUI.select} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason">
                <option value="test">Test account: leave out of the numbers</option>
                <option value="objected">Objected: erase their telemetry and stop recording</option>
              </select>
              <input className={AdminUI.input} value={note} maxLength={200} placeholder="Note (optional)"
                onChange={(e) => setNote(e.target.value)} aria-label="Note" />
              {reason === 'objected' ? (
                <p className="text-sm text-red-700 dark:text-red-400">
                  This deletes the screens and failures recorded for {pick.username} now, and nothing more is recorded.
                  It cannot be undone.
                </p>
              ) : null}
              <button type="button" className={reason === 'objected' ? AdminUI.btn.destructive : AdminUI.btn.primary}
                disabled={busy} onClick={add}>{reason === 'objected' ? 'Erase and leave out' : 'Leave out'}</button>
            </div>
          ) : (
            <>
              <div className="flex gap-2">
                <input className={AdminUI.input} value={query} placeholder="Username or id"
                  onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') search(); }}
                  aria-label="Find a person" />
                <button type="button" className={AdminUI.btn.outline} onClick={search}>Find</button>
              </div>
              {matches ? (matches.length ? matches.map((m) => (
                <button key={m.id} type="button" className={`${JUI.row} w-full text-left`} onClick={() => setPick(m)}>
                  <span className="font-medium">{m.username}</span>
                  <span className={JUI.fine}>#{m.id}</span>
                </button>
              )) : <Empty>No match.</Empty>) : null}
            </>
          )}
          {error ? <p className="text-sm text-red-700 dark:text-red-400">{error}</p> : null}
        </div>
      ) : null}
    </Dialog>
  );
}

type PersonData = {
  userId: number; name: string; cohort: string | null; firstMile: MilePerson;
  found: Array<{ slug: string; name: string; how: string | null; stayed: boolean | null; seconds: number | null }>;
  cameBackTo: Array<{ slug: string; name: string; days: number }>;
  usedOftenNotOnHome: Array<{ slug: string; name: string; days: number }>;
  waysIn: Record<string, number>;
  visits: number;
  possiblyLost: Array<{ at: string; path: string[]; steps: number; distinct: number; seconds: number; secondsPerStep: number; repeatShare: number; cutoffs: Record<string, number> }>;
  failedAttempts: number; repeatedTaps: number;
  challenges: { openedAt: string | null; credits: Array<{ challengeId: number; title: string; points: number; at: string; firstChallenge: boolean }> };
  navigation: { recorded: true } | NotRecorded;
};

function PersonDialog({ userId, onClose }: { userId: number; onClose: () => void }) {
  const { data: p, failed } = useJourney<PersonData>(`/api/admin/journey/people/${userId}`);
  const section = (label: string, body: ReactNode) => (
    <div className="mt-4">
      <div className={JUI.label}>{label}</div>
      {body}
    </div>
  );
  let prevAt: string | null = null;
  return (
    <Dialog id="admin-journey-person-dialog" title={p ? p.name : 'Person'} onClose={onClose}>
      {p ? (
        <>
          <p className={AdminUI.muted}>
            {p.cohort ? `Admitted ${weekLabel(p.cohort)}` : 'No admit date'} · {plural(p.visits, 'visit', 'visits')}
            {' · '}
            <button type="button" className={AdminUI.btn.link}
              onClick={() => { onClose(); location.hash = `#admin/support/${p.userId}`; }}>Open in Support</button>
          </p>
          {isNotRecorded(p.navigation) ? <p className={`${JUI.fine} mt-1`}>Navigation not recorded yet: {p.navigation.reason}</p> : null}
          {section('First mile', p.firstMile.steps.map((st) => {
            const g = st.at ? gap(prevAt, st.at) : '';
            if (st.at) prevAt = st.at;
            return (
              <div key={st.key} className={JUI.row} data-journey-person-step={st.key}>
                <span className="text-sm w-44 shrink-0">{MILE_STEPS[st.key] || st.key}</span>
                <span className={st.state === 'stuck' ? AdminUI.badge.warn : st.state === 'done' ? AdminUI.badge.success : AdminUI.badge.outline}>
                  {st.state === 'not_yet' ? 'not yet' : st.state}
                </span>
                {st.at ? <span className={JUI.fine}>{when(st.at)} {g}</span> : null}
                {st.note ? <span className={JUI.fine}>{st.note}</span> : null}
              </div>
            );
          }))}
          {section('Tour', p.firstMile.tour
            ? <p className="text-sm">{p.firstMile.tour.ended === 'skip' ? 'Skipped' : p.firstMile.tour.ended === 'finish' ? 'Finished' : p.firstMile.tour.ended}
              {p.firstMile.tour.step != null ? ` at step ${p.firstMile.tour.step + 1}` : ''}
              {p.firstMile.tour.at ? `, ${when(p.firstMile.tour.at)}` : ''}</p>
            : <Empty>Not opened.</Empty>)}
          {section('Found', p.found.length ? p.found.map((f) => (
            <div key={f.slug} className={JUI.row}>
              <span className="font-medium">{f.name}</span>
              <span className={JUI.fine}>{f.how === 'handed' ? 'handed to them' : f.how === 'own' ? 'on their own' : 'way not recorded'}</span>
              {f.stayed == null ? null : <span className={f.stayed ? AdminUI.badge.success : AdminUI.badge.default}>{f.stayed ? 'stayed' : 'glanced'}</span>}
            </div>
          )) : <Empty>Nothing new yet.</Empty>)}
          {section('Came back to', p.cameBackTo.length ? (
            <p className="text-sm">{p.cameBackTo.map((c) => `${c.name} (${days(c.days)})`).join(', ')}</p>
          ) : <Empty>Nothing yet.</Empty>)}
          {p.usedOftenNotOnHome.length ? section('Used often, not on their Home', (
            <p className="text-sm">{p.usedOftenNotOnHome.map((c) => `${c.name} (${days(c.days)})`).join(', ')}</p>
          )) : null}
          {Object.keys(p.waysIn).length ? section('How visits started', (
            <p className="text-sm">{Object.entries(p.waysIn).map(([k, n]) => `${n} ${WAYS[k] || k}`).join(', ')}</p>
          )) : null}
          {section('Possibly lost', p.possiblyLost.length ? p.possiblyLost.map((v, i) => (
            <div key={i} className="py-2 border-b border-zinc-100 dark:border-zinc-800/60 last:border-b-0">
              <p className={`${JUI.fine} mb-1`}>
                {when(v.at)} · {v.steps} steps over {v.distinct} screens in {Math.round(v.seconds)} s, with no stay and no act
              </p>
              <div className={JUI.path}>{v.path.map((code, j) => <span key={j} className={JUI.pathStep}>{screenLabel(code)}</span>)}</div>
              <p className={`${JUI.fine} mt-1`}>
                {`Flagged because it had ${v.cutoffs.minSteps} or more steps, under ${v.cutoffs.maxSecondsPerStep} s a step, `
                  + `at least ${Math.round(v.cutoffs.minRepeatShare * 10)} in 10 steps back to a screen already seen, `
                  + `and no ${v.cutoffs.landingSeconds} s stay.`}
              </p>
            </div>
          )) : <Empty>No visit looks lost.</Empty>)}
          {section('Failed attempts', <p className="text-sm">{plural(p.failedAttempts, 'action failed', 'actions failed')}, {plural(p.repeatedTaps, 'tap repeated', 'taps repeated')}</p>)}
          {section('Challenges', (
            <>
              <p className="text-sm">{p.challenges.openedAt ? `Opened Challenges ${when(p.challenges.openedAt)}` : 'Never opened Challenges'}</p>
              {p.challenges.credits.map((c) => (
                <div key={`${c.challengeId}-${c.at}`} className={JUI.row}>
                  <span className="text-sm">{c.title}</span>
                  {c.firstChallenge ? <span className={AdminUI.badge.secondary}>First challenge</span> : null}
                  <span className={JUI.fine}>{when(c.at)}</span>
                </div>
              ))}
            </>
          ))}
        </>
      ) : <Loading failed={failed} what="this person" />}
    </Dialog>
  );
}

// ── The section ────────────────────────────────────────────────────────

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function JourneySection() {
  const [week, setWeek] = useState<string | null>(null);
  const { data: s, failed, reload } = useJourney<Summary>(`/api/admin/journey/summary${week ? `?week=${week}` : ''}`);
  const [dialog, setDialog] = useState<DialogKey | null>(null);
  const [person, setPerson] = useState<number | null>(null);
  const openPerson = useCallback((id: number) => setPerson(id), []);
  const closeDialog = useCallback(() => setDialog(null), []);
  const closePerson = useCallback(() => setPerson(null), []);

  const shown = s?.groups.week || week;
  const current = s?.thisWeekSoFar.week || null;
  const canNext = !!(shown && current && shown < current);

  const more: Array<[DialogKey, string]> = [
    ['mile', 'First mile'], ['stages', 'Stages'], ['loops', 'Loops'], ['next', 'Next steps'], ['leftout', 'Left out'],
  ];

  return (
    <div id="admin-journey" className="space-y-4">
      <div className={JUI.card}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className={AdminUI.cardTitle}>Journey</h2>
            <p className={AdminUI.cardDescription}>Active groups are the North Star. Counts and names, no rates.</p>
          </div>
          <div className="flex items-center gap-1">
            <button type="button" className={AdminUI.btn.outlineSm} aria-label="Week before"
              disabled={!shown} onClick={() => shown && setWeek(addDays(shown, -7))}>‹</button>
            <span id="admin-journey-week" className="text-sm px-2 whitespace-nowrap">
              {shown ? `Week of ${weekLabel(shown)}` : '…'}
            </span>
            <button type="button" className={`${AdminUI.btn.outlineSm} disabled:opacity-40`} aria-label="Week after"
              disabled={!canNext} onClick={() => shown && setWeek(addDays(shown, 7))}>›</button>
            <button type="button" className={`${AdminUI.btn.link} text-xs ml-2`} onClick={reload}>Refresh</button>
          </div>
        </div>
        {s?.demo ? <p className={`${AdminUI.badge.warn} mt-2`}>Demo: invented people</p> : null}
        <div className="flex flex-wrap gap-1.5 mt-3" id="admin-journey-more">
          {more.map(([key, label]) => (
            <button key={key} type="button" className={JUI.pill} data-journey-open={key} onClick={() => setDialog(key)}>{label}</button>
          ))}
        </div>
      </div>
      {s ? (
        <>
          <GroupsBlock s={s} onOpen={openPerson} onDialog={setDialog} />
          <StuckBlock s={s} onOpen={openPerson} />
          <TurnsBlock s={s} onOpen={openPerson} />
        </>
      ) : <div className={JUI.card}><Loading failed={failed} what="the journey" /></div>}
      {dialog === 'checks' && s ? <ChecksDialog s={s} onOpen={openPerson} onClose={closeDialog} /> : null}
      {dialog === 'mile' ? <MileDialog onOpen={openPerson} onClose={closeDialog} /> : null}
      {dialog === 'stages' ? <StagesDialog week={week} onOpen={openPerson} onClose={closeDialog} /> : null}
      {dialog === 'loops' ? <LoopsDialog week={week} onOpen={openPerson} onClose={closeDialog} /> : null}
      {dialog === 'next' ? <NextDialog onClose={closeDialog} /> : null}
      {dialog === 'leftout' ? <LeftOutDialog onOpen={openPerson} onClose={closeDialog} /> : null}
      {person != null ? <PersonDialog userId={person} onClose={closePerson} /> : null}
    </div>
  );
}

let host: Element | null = null;

const AdminJourney = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <JourneySection />);
  },

  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminJourney = AdminJourney;

export { AdminJourney };
