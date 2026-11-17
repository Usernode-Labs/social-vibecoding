'use strict';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { AdminUI } from './admin-console.js';
import { Growth, type GrowthData } from './admin-growth';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// Journey (#admin/journey, #3369): the user journey and the North Star.
//
// One read surface over the endpoints slice 1 shipped under
// /api/admin/journey/* (src/services/journey.js), drawn as eight chart cards
// so it reads at a glance: the North Star (active groups, with eight weeks
// of trend, the week's lifecycle as units, and the votes behind it), the
// seven stages, the first mile per admit cohort (one track per newcomer,
// under the staircase it sums to), the creation path (making a project to a
// change of theirs going live, against its targets, with each first
// version's stages and how it ended), the first session (with the made
// screen and the tour after Make it, card by card) and the pairs (the aha:
// two people active on a project together), the change loop and the invite
// loop as rings, and where newcomers go next. Each check sits on the card whose
// reading it qualifies: group votes and lockstep under the North Star, the
// team's share of live changes beside the change loop, navigation coverage
// under the paths. Names are chips that open one person; a stage bar opens
// its names. Nothing expands inside the page.
//
// Three rules from the endpoints are kept on screen, and the section test
// pins them:
// - a reading the platform does not record arrives as
//   `{ recorded: false, reason }` and reads "not recorded yet", never 0;
// - Hear back arrives as `{ status: 'coming' }` and reads "coming";
// - every mark carries its count, and no share is printed as a percentage:
//   at one to six people a rate claims more than the data holds. The one
//   exception is the invite funnel's conversion from step to step (#4176),
//   printed beside its counts and only from FUNNEL_RATE_FROM people; the
//   made screen's steps after Make it are read the same way.
// - what a maker asked for is shown in their own words, as text, never as
//   markup or a link.
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
  mail_page: 'Opened the mail\u2019s page',
  code_asked: 'Followed the mail',
  account: 'Account created',
  access: 'Has access',
  opened: 'Opened Homeroom',
  username: 'Username chosen',
  join: 'Join screen answered',
  first_act: 'First act',
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

// Local class recipes: complete literals, because Tailwind's extractor is a
// regex over this file's source (see the AdminUI note in admin-console.js).
const JUI = Object.freeze({
  card: `${AdminUI.card} p-4 sm:p-5`,
  blockTitle: 'text-base font-semibold text-zinc-900 dark:text-zinc-100',
  headline: 'text-5xl font-bold leading-none tabular-nums text-zinc-900 dark:text-zinc-100',
  label: 'text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400',
  fine: 'text-xs text-zinc-500 dark:text-zinc-400',
  row: 'flex flex-wrap items-baseline gap-x-2 gap-y-1 py-2 border-b border-zinc-100 dark:border-zinc-800/60 last:border-b-0',
  name: 'font-medium text-violet-700 dark:text-violet-400 hover:underline',
  dialogPanel: 'w-full max-w-2xl max-h-[82vh] overflow-y-auto bg-white dark:bg-zinc-900 rounded-2xl p-5 shadow-xl',
  chip: 'inline-flex items-center gap-1 rounded-full bg-zinc-100 dark:bg-zinc-800 py-0.5 ps-0.5 pe-2 text-xs font-medium text-zinc-800 dark:text-zinc-200 transition-colors',
  chipOn: 'bg-violet-600 text-white',
  chipOff: 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700',
  path: 'flex flex-wrap gap-1 text-xs',
  empty: 'bg-zinc-200 dark:bg-zinc-700',
  avatar: 'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-violet-100 dark:bg-violet-500/25 text-[11px] font-semibold text-violet-800 dark:text-violet-200',
  chipTap: 'hover:bg-zinc-200 dark:hover:bg-zinc-700',
  chipDashed: 'border border-dashed border-zinc-300 dark:border-zinc-600 bg-transparent dark:bg-transparent text-zinc-500 dark:text-zinc-400',
  // The filter bar's controls are one family: 24px pills, chips, arrows and
  // the search alike, so nothing in the bar stands taller than the rest.
  cohort: 'inline-flex h-6 items-center rounded-full px-3 text-xs font-medium transition-colors',
  stepper: 'inline-flex h-6 w-6 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-40',
  search: 'h-6 w-full sm:w-44 rounded-full border-0 bg-zinc-100 dark:bg-zinc-800 px-3 text-xs text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-500 dark:placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-violet-500',
  // Nine steps, then the onboard column, then days since.
  mileGrid: 'grid items-center gap-x-1 gap-y-1.5 grid-cols-[repeat(11,minmax(0,1fr))_2.5rem] sm:grid-cols-[7.5rem_repeat(11,minmax(0,1fr))_2.5rem]',
  // The waiting cohort's five steps and the onboard column.
  mileGridWaiting: 'grid items-center gap-x-1 gap-y-1.5 grid-cols-[repeat(6,minmax(0,1fr))_2.5rem] sm:grid-cols-[7.5rem_repeat(6,minmax(0,1fr))_2.5rem]',
  // The invited cohort's six steps and the onboard column.
  mileGridInvited: 'grid items-center gap-x-1 gap-y-1.5 grid-cols-[repeat(7,minmax(0,1fr))_2.5rem] sm:grid-cols-[7.5rem_repeat(7,minmax(0,1fr))_2.5rem]',
  // A column label is a button: tapping it says what the column counts.
  mileLabel: 'w-full min-w-0 rounded text-center text-[10px] leading-tight tracking-tight text-zinc-500 dark:text-zinc-400 underline decoration-dotted decoration-zinc-400 dark:decoration-zinc-500 underline-offset-2 hover:text-zinc-900 dark:hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500',
  mileHelp: 'absolute top-full z-20 mt-1 w-56 max-w-[70vw] rounded-lg bg-zinc-900 dark:bg-zinc-100 px-3 py-2 text-start text-xs font-normal normal-case leading-snug tracking-normal text-white dark:text-zinc-900 shadow-lg',
  // The creation path by week: the week, then one column per step.
  weekGrid: 'grid items-start gap-x-2 gap-y-1 grid-cols-[3.5rem_repeat(5,minmax(0,1fr))]',
  pathStep: 'rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 text-zinc-700 dark:text-zinc-300',
});

// ── Types (the parts of the payloads this page reads) ──────────────────

type NotRecorded = { recorded: false; reason: string };
type Person = { userId: number | null; name: string };
type MileStep = { key: string; state: string; at: string | null; note: string | null; weak?: boolean; unrecorded?: boolean };
// How a person came in (services/journey.js cameInFacts). Each part is null
// when nothing says.
type CameIn = {
  signupMethod?: string | null;
  waitlist?: {
    joinedAt: string | null; waitedDays: number | null; source: string | null; discovery: string | null;
    answeredFollowUp: boolean; referred: boolean; projectInvite: boolean;
  } | null;
  mailPage?: { at: string | null; outcome: string | null } | null;
  fromEmail?: number | null;
  invite?: { by: string | null; project: string | null; slug: string | null; openedAt: string | null; how: string | null; status: string | null } | null;
};
// Where somebody came from (#6540): hosts and short tags only. `null`
// means nothing was recorded; 'none' means looked for and none given.
type CameFromInvite = { referrerHost: string | null; via: string | null; project: string | null; at: string };
type CameFromWaitlist = {
  referrerHost: string | null; utmSource: string | null; utmCampaign: string | null; ref: string | null; at: string;
};
type CameFrom = { invite: CameFromInvite | null; waitlist: CameFromWaitlist | null };
type MilePerson = {
  userId: number | null; name: string; steps: MileStep[]; furthest: string | null; stuckAt: string | null;
  stuckReason: string | null; daysSince: number; failedAttempts: number; repeatedTaps: number;
  tour: { ended: string; step: number | null; at: string | null } | null;
  // The first-run list: the tour and the season's First challenges, x of n.
  // `null` without an account; `shown: false` for an account from before it.
  onboard?: { shown: boolean; done: number | null; total: number | null; complete: boolean } | null;
  // What the admit mail's tracking saw; `null` when it was not tracked.
  mail?: { opened: boolean; clicked: boolean } | null;
  cameFrom?: CameFrom | null;
} & CameIn;

type OpenPerson = (userId: number) => void;

// ── Small pieces ───────────────────────────────────────────────────────

function isNotRecorded(v: unknown): v is NotRecorded {
  return !!v && typeof v === 'object' && (v as NotRecorded).recorded === false;
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

/** A source as Journey says it: the site, "no referrer", or "Not recorded". */
function fromWords(host: string | null | undefined): string {
  if (host === 'none') return 'no referrer';
  if (!host) return 'Not recorded';
  return host;
}

/** How an invite link went out, in words; null when it was not tagged. */
function viaWords(via: string | null | undefined): string | null {
  if (via === 'copied') return 'link was copied';
  if (via === 'shared') return 'link was shared';
  return null;
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

// ── Kept for the person view (its helpers from the retired cards) ─────

/** A person as a small chip: their initial and name; tapping opens them. */
function PersonChip({ person, onOpen, dashed = false }: { person: Person; onOpen: OpenPerson; dashed?: boolean }) {
  const initial = (person.name || '?').replace(/^[^a-z0-9]+/i, '').charAt(0).toUpperCase() || '?';
  const body = (
    <>
      <span aria-hidden="true" className={JUI.avatar}>{initial}</span>
      <span className="truncate min-w-0 max-w-[7rem]">{person.name}</span>
    </>
  );
  if (person.userId == null) return <span className={`${JUI.chip} max-w-full ${dashed ? JUI.chipDashed : ''}`}>{body}</span>;
  const id = person.userId;
  return (
    <button type="button" className={`${JUI.chip} ${JUI.chipTap} max-w-full`} data-journey-person={id} onClick={() => onOpen(id)}>{body}</button>
  );
}

const INVITED_STEPS: Record<string, string> = {
  invite_opened: 'Opened the invite',
  signed_up: 'Signed up',
  joined: 'Joined the project',
  opened: 'Opened Homeroom',
  first_act: 'First act',
  let_in: 'Let in',
};

// The first mile of somebody still on the waitlist (journey.js
// WAITING_MILE_STEPS): what they did while waiting, then the release they
// are all waiting for.
const WAITING_STEPS: Record<string, string> = {
  wl_joined: 'Joined the waitlist',
  wl_confirmed: 'Confirmed their address',
  wl_answered: 'Answered the follow-up',
  wl_account: 'Has an account',
  wl_released: 'Let off the waitlist',
};
const STEP_NAMES: Record<string, string> = { ...MILE_STEPS, ...INVITED_STEPS, ...WAITING_STEPS };

const SIGNUP_METHOD: Record<string, string> = {
  phone: 'phone', apple: 'Apple', google: 'Google', mail_link: 'mail link', email_code: 'email code', password: 'password',
};
const WAITLIST_SOURCE: Record<string, string> = {
  form: 'waitlist page', app: 'in the app', account: 'made an account first', test: 'test release',
};
const MAIL_PAGE_OUTCOME: Record<string, string> = {
  opened: 'opened', signed_in: 'signed in', welcome: 'welcome shown, no Get started',
  link_expired: 'link expired', link_used: 'link already used',
};
const waitlistSourceWords = (source: string | null | undefined) => (!source ? null
  : source.startsWith('partner:') ? `${source.slice('partner:'.length)} (partner form)` : WAITLIST_SOURCE[source] || source);

type FirstVersionBrief = { recorded: boolean; outcome: string | null; last: string | null };

// [stage, label, what it records], in pipeline order.
const FIRST_VERSION_STAGES: Array<[string, string, string]> = [
  ['plan_written', 'Plan written', 'its plan exists: written at Make it, or by the triage of its request'],
  ['go_ahead', 'Go-ahead', 'its maker tapped Build it, or Submit under the plan\u2019s questions'],
  ['picked_up', 'Build picked up', 'its build took its slot'],
  ['spec_started', 'Screens started', 'the screens it will have are being drawn'],
  ['first_look_saved', 'First look saved', 'its first look was drawn and kept'],
  ['build_started', 'Build started', 'the build turn began'],
  ['build_done', 'Build pushed', 'the build turn pushed its code'],
  ['review_round', 'Reviewed', 'a review round began'],
  ['testing_started', 'Checks started', 'it was proposed, so its checks began'],
  ['merged', 'Merged', 'its proposal merged'],
  ['live', 'Live', 'it answered on the build that was deployed'],
];
const FIRST_VERSION_LABEL: Record<string, string> = Object.fromEntries(FIRST_VERSION_STAGES.map(([key, label]) => [key, label]));

// [outcome, words, fill], from the best to the worst.
const FIRST_VERSION_OUTCOMES: Array<[string, string, string]> = [
  ['live', 'live', 'bg-emerald-500'],
  ['building', 'still building', 'bg-violet-500'],
  ['waiting', 'waiting on its maker', 'bg-violet-300 dark:bg-violet-400/50'],
  ['stalled', 'stalled', 'bg-amber-400'],
  ['failed', 'failed', 'bg-red-500'],
];
const OUTCOME_WORDS: Record<string, string> = Object.fromEntries(FIRST_VERSION_OUTCOMES.map(([key, words]) => [key, words]));

/** A project's first version in a few words: "first version live", "first version stalled at build picked up". */
function firstVersionWords(fv: FirstVersionBrief | null | undefined): string | null {
  if (!fv) return null;
  if (!fv.recorded || !fv.outcome) return 'first version not recorded';
  if (fv.outcome === 'live' || !fv.last) return `first version ${OUTCOME_WORDS[fv.outcome] || fv.outcome}`;
  return `first version ${OUTCOME_WORDS[fv.outcome] || fv.outcome}, at ${(FIRST_VERSION_LABEL[fv.last] || fv.last).toLowerCase()}`;
}

/** What a maker asked for, in their words, or the ready-made app it was made from. */
function Asked({ asked, template }: { asked?: string | null; template?: string | null }) {
  if (asked) return <p className="mt-0.5 text-xs text-zinc-700 dark:text-zinc-300" data-journey-asked="">{`\u201c${asked}\u201d`}</p>;
  if (template) return <p className={`mt-0.5 ${JUI.fine}`} data-journey-asked="">{`Ready-made: ${template}`}</p>;
  return null;
}

function dur(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return '';
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 600) return `${Math.round(s / 6) / 10} min`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} days`;
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
          <span className={`${JUI.fine} sm:ms-auto`}>{weekLabel((e.addedAt || '').slice(0, 10))}</span>
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
                <button type="button" className={`${AdminUI.btn.link} text-xs ms-2`} onClick={() => setPick(null)}>Change</button>
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
                <button key={m.id} type="button" className={`${JUI.row} w-full text-start`} onClick={() => setPick(m)}>
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

/** "How they came in": the person dialog's facts from services/journey.js cameInFacts. */
function CameInFacts({ cameIn }: { cameIn: CameIn & { door?: string | null } }) {
  const rows: Array<[string, string]> = [];
  const w = cameIn.waitlist;
  if (cameIn.invite) {
    const inv = cameIn.invite;
    const parts = [
      inv.by ? `by ${inv.by}` : null,
      inv.project ? `to ${inv.project}` : null,
      inv.openedAt ? `opened the link ${when(inv.openedAt)}` : null,
      inv.status === 'joined' ? 'joined' : inv.status === 'queued' ? 'waiting for access to join' : null,
    ].filter(Boolean);
    rows.push(['Invited', parts.join(' · ') || 'through an invite link']);
  }
  if (w) {
    const parts = [
      w.joinedAt ? `joined ${when(w.joinedAt)}` : null,
      w.waitedDays != null ? `waited ${days(w.waitedDays)}` : null,
      waitlistSourceWords(w.source),
      w.discovery ? `heard from: ${w.discovery}` : null,
      w.answeredFollowUp ? 'answered the follow-up' : 'no follow-up answers',
      w.referred ? 'referred by a waitlist member' : null,
      w.projectInvite ? 'invited to a project by email' : null,
    ].filter(Boolean);
    rows.push(['Waitlist', parts.join(' · ')]);
  }
  if (cameIn.mailPage) {
    const outcome = cameIn.mailPage.outcome ? MAIL_PAGE_OUTCOME[cameIn.mailPage.outcome] || cameIn.mailPage.outcome : null;
    rows.push(['Mail\u2019s page', [cameIn.mailPage.at ? `opened ${when(cameIn.mailPage.at)}` : null, outcome].filter(Boolean).join(' · ')]);
  }
  if (cameIn.fromEmail) rows.push(['Admit mail', cameIn.fromEmail === 1 ? 'the first send led in' : `send ${cameIn.fromEmail} led in`]);
  if (cameIn.door === 'open_signup') rows.push(['Let in', 'at sign-up, while the waitlist was off']);
  rows.push(['Signed up with', cameIn.signupMethod ? SIGNUP_METHOD[cameIn.signupMethod] || cameIn.signupMethod : 'not recorded']);
  return (
    <div data-journey-person-came-in>
      {rows.map(([k, v]) => (
        <div key={k} className={JUI.row}>
          <span className="text-sm w-44 shrink-0">{k}</span>
          <span className={JUI.fine}>{v}</span>
        </div>
      ))}
    </div>
  );
}

type PersonData = {
  userId: number; name: string; cohort: string | null; firstMile: MilePerson;
  // How they came in; absent from older servers and the staging demo.
  cameIn?: CameIn & { door?: string | null };
  cameFrom: CameFrom;
  found: Array<{ slug: string; name: string; how: string | null; stayed: boolean | null; seconds: number | null }>;
  cameBackTo: Array<{ slug: string; name: string; days: number }>;
  usedOftenNotOnHome: Array<{ slug: string; name: string; days: number }>;
  waysIn: Record<string, number>;
  visits: number;
  possiblyLost: Array<{ at: string; path: string[]; steps: number; distinct: number; seconds: number; secondsPerStep: number; repeatShare: number; cutoffs: Record<string, number> }>;
  failedAttempts: number; repeatedTaps: number;
  challenges: { openedAt: string | null; credits: Array<{ challengeId: number; title: string; points: number; at: string; firstChallenge: boolean }> };
  navigation: { recorded: true } | NotRecorded;
  made?: Array<{
    slug: string; project: string; createdAt: string; asked: string | null; template: string | null;
    firstVersion: (FirstVersionBrief & { nearLive: boolean | null; backSeconds: number | null }) | null;
  }>;
  madeScreen?: Array<{ kind: string; at: string; how?: string; step?: number; steps?: number }>;
};

/** One moment of the made screen or the tour, in a word or two. */
function momentLabel(m: { kind: string; how?: string; step?: number; steps?: number }): string {
  switch (m.kind) {
    case 'made_shown': return 'Made screen';
    case 'planning_shown': return 'Planning';
    case 'questions_shown': return 'Questions';
    case 'submit_tapped': return 'Answered';
    case 'invite_shown': return 'Invite shown';
    case 'share_invite_tapped': return 'Share invite';
    case 'invite_sent': return m.how === 'copied' ? 'Link copied' : 'Invite shared';
    case 'invite_later_tapped': return 'Invite later';
    case 'continue_tapped': return 'Went on';
    case 'tour_started': return m.steps ? `Tour of ${m.steps}` : 'Tour';
    case 'tour_step_shown': return `Card ${m.step ?? '?'}`;
    case 'tour_ended': return m.how === 'done' ? 'Finished the tour' : `Skipped at card ${m.step ?? '?'}`;
    default: return m.kind;
  }
}

function PersonView({ userId, onBack, onName }: { userId: number; onBack: () => void; onName: (name: string) => void }) {
  const { data: p, failed } = useJourney<PersonData>(`/api/admin/journey/people/${userId}`);
  useEffect(() => { if (p) onName(p.name); }, [p, onName]);
  const section = (label: string, body: ReactNode) => (
    <div className="mt-4">
      <div className={JUI.label}>{label}</div>
      {body}
    </div>
  );
  let prevAt: string | null = null;
  return (
    <section id="admin-journey-person" className={JUI.card}>
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <button type="button" className={`${JUI.cohort} ${JUI.chipOff}`} onClick={onBack}>← Everyone</button>
        <h3 className={AdminUI.sectionTitle}>{p ? p.name : 'Person'}</h3>
      </div>
      {p ? (
        <>
          <p className={AdminUI.muted}>
            {p.cohort ? `Admitted ${weekLabel(p.cohort)}` : 'No admit date'} · {plural(p.visits, 'visit', 'visits')}
            {' · '}
            <button type="button" className={AdminUI.btn.link}
              onClick={() => { location.hash = `#admin/support/${p.userId}`; }}>Open in Support</button>
          </p>
          {isNotRecorded(p.navigation) ? <p className={`${JUI.fine} mt-1`}>Navigation not recorded yet: {p.navigation.reason}</p> : null}
          {p.cameIn ? section('How they came in', <CameInFacts cameIn={p.cameIn} />) : null}
          {section('Came from', (p.cameFrom?.invite || p.cameFrom?.waitlist) ? (
            <>
              {p.cameFrom.invite ? (
                <div className={JUI.row} data-journey-came-from="invite">
                  <span className="text-sm w-44 shrink-0">Invite link</span>
                  <span className="text-sm font-medium">{fromWords(p.cameFrom.invite.referrerHost)}</span>
                  <span className={JUI.fine}>
                    {[viaWords(p.cameFrom.invite.via), p.cameFrom.invite.project, when(p.cameFrom.invite.at)].filter(Boolean).join(' · ')}
                  </span>
                </div>
              ) : null}
              {p.cameFrom.waitlist ? (
                <div className={JUI.row} data-journey-came-from="waitlist">
                  <span className="text-sm w-44 shrink-0">Waitlist</span>
                  <span className="text-sm font-medium">{fromWords(p.cameFrom.waitlist.referrerHost)}</span>
                  <span className={JUI.fine}>
                    {[
                      p.cameFrom.waitlist.utmSource ? `utm_source ${p.cameFrom.waitlist.utmSource}` : null,
                      p.cameFrom.waitlist.utmCampaign ? `utm_campaign ${p.cameFrom.waitlist.utmCampaign}` : null,
                      p.cameFrom.waitlist.ref ? `ref ${p.cameFrom.waitlist.ref}` : null,
                      when(p.cameFrom.waitlist.at),
                    ].filter(Boolean).join(' · ')}
                  </span>
                </div>
              ) : null}
            </>
          ) : <Empty>Not recorded.</Empty>)}
          {section('First mile', p.firstMile.steps.map((st) => {
            const g = st.at ? gap(prevAt, st.at) : '';
            if (st.at) prevAt = st.at;
            return (
              <div key={st.key} className={JUI.row} data-journey-person-step={st.key}>
                <span className="text-sm w-44 shrink-0">{STEP_NAMES[st.key] || st.key}</span>
                <span className={st.state === 'stuck' ? AdminUI.badge.warn : st.state === 'done' ? AdminUI.badge.success : AdminUI.badge.outline}>
                  {st.state === 'not_yet' ? 'not yet' : st.state}
                </span>
                {st.at ? <span className={JUI.fine}>{when(st.at)} {g}</span> : null}
                {st.note ? <span className={JUI.fine}>{st.note}</span> : null}
              </div>
            );
          }))}
          {section('Made', p.made && p.made.length ? p.made.map((m) => (
            <div key={m.slug} className="py-2 border-b border-zinc-100 dark:border-zinc-800/60 last:border-b-0" data-journey-person-made={m.slug}>
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">{m.project}</span>
                <span className={JUI.fine}>{when(m.createdAt)}</span>
                {m.firstVersion ? <span className={JUI.fine}>{firstVersionWords(m.firstVersion)}</span> : null}
                {m.firstVersion && m.firstVersion.nearLive != null ? (
                  <span className={JUI.fine}>
                    {`${m.firstVersion.nearLive ? 'there when it went live' : 'away when it went live'}${m.firstVersion.backSeconds != null ? `, opened it ${dur(m.firstVersion.backSeconds)} after` : ''}`}
                  </span>
                ) : null}
              </div>
              <Asked asked={m.asked} template={m.template} />
            </div>
          )) : <Empty>No project of their own.</Empty>)}
          {p.madeScreen && p.madeScreen.length ? section('After Make it', (
            <div className={`${JUI.path} mt-1`} id="admin-journey-person-made-screen">
              {p.madeScreen.map((m, i) => <span key={i} className={JUI.pathStep}>{momentLabel(m)}</span>)}
            </div>
          )) : null}
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
    </section>
  );
}

// ── The section ────────────────────────────────────────────────────────

// Find one person by name or id (Support's search) and open their view.
function PersonSearch({ onPick }: { onPick: (id: number) => void }) {
  const [q, setQ] = useState('');
  const [matches, setMatches] = useState<Suggestion[] | null>(null);
  const find = async () => {
    const term = q.trim().replace(/^@/, '');
    if (!term) { setMatches(null); return; }
    const res = await consoleApi().fetchJson(`/api/admin/support/search?q=${encodeURIComponent(term)}`);
    setMatches(res.ok && res.data ? (res.data.results || []).slice(0, 6) : []);
  };
  return (
    <div className="w-full sm:w-auto">
      <input className={JUI.search} value={q} placeholder="Find a person"
        aria-label="Find a person" onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') find(); }} onBlur={() => { if (q.trim()) find(); }} />
      {matches ? (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {matches.length ? matches.map((m) => (
            <PersonChip key={m.id} person={{ userId: m.id, name: m.username }} onOpen={(id) => { setMatches(null); setQ(''); onPick(id); }} />
          )) : <span className={JUI.fine}>No match.</span>}
        </div>
      ) : null}
    </div>
  );
}

function JourneySection() {
  // One reading behind every view (services/growth.js); the views filter it.
  const { data, failed, reload } = useJourney<GrowthData>('/api/admin/journey/growth');
  const [leftOut, setLeftOut] = useState(false);
  const [person, setPerson] = useState<number | null>(null);
  const [personName, setPersonName] = useState<string | null>(null);
  const openPerson = useCallback((id: number) => {
    setPersonName(null);
    setLeftOut(false);
    setPerson(id);
    document.getElementById('admin-journey')?.scrollIntoView({ block: 'start' });
  }, []);
  const closeLeftOut = useCallback(() => setLeftOut(false), []);
  const fetchJson = useCallback((path: string) => consoleApi().fetchJson(withDemo(path)), []);

  return (
    <div id="admin-journey" className="space-y-4">
      {person != null ? (
        <>
          <div className={JUI.card}>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={`${AdminUI.btn.ghost} text-sm`} onClick={() => setPerson(null)}>‹ Growth</button>
              <span className={JUI.label}>Person</span>
              <span className="text-sm font-medium">{personName || 'One person'}</span>
              <span className="ms-auto"><PersonSearch onPick={openPerson} /></span>
            </div>
          </div>
          <PersonView userId={person} onBack={() => setPerson(null)} onName={setPersonName} />
        </>
      ) : data ? (
        <Growth data={data} onOpenPerson={openPerson} onLeftOut={() => setLeftOut(true)} onRefresh={reload} fetchJson={fetchJson} />
      ) : <div className={JUI.card}><Loading failed={failed} what="the growth reading" /></div>}
      {leftOut ? <LeftOutDialog onOpen={openPerson} onClose={closeLeftOut} /> : null}
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
