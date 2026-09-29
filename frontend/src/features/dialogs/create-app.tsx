/**
 * Create-project dialog (#create-modal).
 *
 * ── Six questions, in the order a person answers them ─────────────────
 *
 * Communities, stage 3 asked who a project is FOR before anything else,
 * because that answer decides the rest. The create-dialog rework (drawn and
 * agreed as a clickable mock first) turned each question into a step of its
 * own and moved "how do you want to start" to the end:
 *
 *   who      Just me, A group, or A community: the audiences
 *            services/communities.js derives (`solo`, `invited`, `open`), in
 *            the words the Workshop tab heads its sections with.
 *   invite   a group only: who is in it, one row per person. A @username is
 *            picked from GET /api/users/search; an email address becomes a
 *            row that says "Will invite" (services/email-invites.js sends it
 *            and turns it into a project invite when that person signs up).
 *   kind     what you are making: App, with Document and Video there, dimmed,
 *            saying Soon.
 *   details  the name, and the optional one line about what it is.
 *   approve  who approves changes: members vote, or people you pick (starting
 *            with you), with "at least N yes votes" as a follow-up under the
 *            second. A group or a community only.
 *   start    how to begin: from scratch, from a template (Soon), or from a
 *            GitHub repo, whose check opens under its row. The check also
 *            reads the repo's dapp.json, and a notice names each earlier
 *            answer it will replace (name, what it is, who it is for, who
 *            approves); those answers are dimmed.
 *
 * NOTHING IS CHOSEN FOR THE PERSON, AND NOTHING MOVES WITHOUT THEM. Every
 * answer starts empty. Pressing a row selects it; Next, beside Cancel on
 * every step, stays dimmed until the step is answered, and moves on. The
 * last step's button is Create (or Import), dimmed the same way. A collapsed
 * step's "Change" reopens it with its answer still picked.
 *
 * `POST /api/apps` takes `audience`, `invitees`, `inviteEmails`,
 * `description` and `governance` (services/create-options.js); the rule and
 * the line are written to the new repository's dapp.json, or, for an import
 * whose dapp.json does not already set them, committed into it by the bot
 * (services/import-manifest.js), so both are votable later like any other
 * line of it.
 *
 * `data-mode` controls "new" vs "import"; `data-import-state` the import
 * sub-states (idle / checking / ok / error); `data-audience`, `data-step`,
 * `data-approvers` and `data-approvals` the rest. CSS in app.css keys off
 * all of them to show and hide sections, so this component only flips
 * attributes and never juggles per-element classes.
 *
 * Markup extracted verbatim from Shell.tsx by #1078 chunk A; #1078 chunk I
 * moved the behaviour in and made it stateful. #1910 restyled it in the
 * pane language (the recipe is spelled out above the class constants
 * below). The INITIAL render still carries every id, every `hidden` and
 * every data-* attribute the shell shipped — `public/js/**` looks those up
 * and the declared dapp.json checks select on them — and
 * tests/baselines/shell-markup.json is the proof; only the class strings
 * are new.
 *
 * ── The second view, and why it costs the baseline nothing ────────────
 *
 * `POST /api/apps` returns 201 with the row still in `'creating'`; the build
 * runs async server-side. This dialog no longer closes on that 201 — it
 * swaps its card to ./create-progress.tsx and reports the four phases
 * `services/app-creator.js` broadcasts, resolving into live /
 * awaiting-secrets / failed.
 *
 * That second view is gated on `created`, which starts null. The prerender
 * pass has no user to submit the form, so it renders the form and nothing
 * else — the progress subtree contributes no ids to public/index.html and
 * therefore nothing to the shell-markup baseline, the id inventory, or the
 * 338 declared dapp.json selectors. A separate tenth shell dialog would have
 * needed an entry in all three; this needs none, which is the whole reason
 * the progress view lives inside this card rather than beside it.
 *
 * ── What moved, and from where ────────────────────────────────────────
 *
 * `App.showCreateModal`, `.hideCreateModal`, `._createVis`,
 * `.setCreateVisibility`, `.setCreateMode`, `._setImportState`,
 * `.handleImportCheck` and `.handleCreateApp` were public/js/app.js:3775-3985;
 * the cancel, backdrop, submit, mode-pill, visibility-pill, Check-button and
 * import-url listeners were its `bindEvents`. Seven functions that read each
 * other's state out of the document are four `useState` calls here.
 *
 * `App.showCreateModal()` survives in app.js as a one-line forward: the home
 * screen's empty-state and "+" buttons (frontend/src/features/home/home.js)
 * and the deep-link handler both call it by name.
 *
 * ── The first render is the prerendered one ──────────────────────────
 *
 * Every answer starts at a constant — nothing chosen, idle, the first step —
 * and renders that, so the first client render matches public/index.html
 * exactly (a mismatch `console.error`s, which fails proposal checks). What a
 * choice changes is written as data attributes on the card and the root,
 * which app.css reads; `.active`-style classes are not rendered from state
 * at all (a row's `aria-pressed` is, and starts false).
 *
 * The text inputs stay UNCONTROLLED (refs, not `value`) for the matching
 * reason: a controlled input renders a `value` attribute in the prerender
 * pass. What the name, the line and the invite field hold is mirrored into
 * state from their input events, for the step's Next.
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { DialogCard, DialogRoot } from '@/components/ui/dialog';
import {
  AppWindowIcon, ChevronRightIcon, EnvelopeIcon, InfoCircleIcon, LockIcon, NewspaperIcon, PlayIcon, PlusIcon,
  SpinnerArcIcon, UserGroupIcon, UserIcon, XIcon,
} from '@/components/ui/icons';
import { Input } from '@/components/ui/input';

import { useHiddenClass, useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { AppAllowance, useAppAllowance } from './app-allowance';
import { invalidateAppAllowance } from './app-allowance-store.js';
import { CreateProgress } from './create-progress';
import {
  creationProgressStore,
  fetchCreationProgress,
  outcomeOf,
  publishAppStatus,
  stopWatchingCreation,
  watchCreation,
} from './creation-progress-store.js';
import { normalizeRepositoryUrl } from './repository-url';
import { useDialog } from './use-dialog';

type Mode = 'new' | 'import';
type ImportState = 'idle' | 'checking' | 'ok' | 'error';
/** Who it is for: services/communities.js's audiences, by their internal names. */
type Audience = 'solo' | 'invited' | 'open';
type Kind = 'app';
type Approvers = 'anyone' | 'invited';
type Approvals = 'majority' | 'atLeast';
/**
 * The steps UNFOLD in one card (#1911), rather than one page of every
 * choice. `step` is the FURTHEST step reached; everything up to it is
 * showing. Every section stays in the document on every step (the declared
 * checks select on the same ids); app.css folds and unfolds them off
 * `#create-card[data-step]`. See the header for what each one asks.
 */
type Step = 'who' | 'invite' | 'kind' | 'details' | 'approve' | 'start';

/** One person a group is created with: a Homeroom account, or an address. */
export type Invitee =
  | { kind: 'user'; username: string; friend?: boolean }
  | { kind: 'email'; email: string };

/** The most people a group is created with (services/create-options.js). */
export const MAX_INVITEES = 20;

/** An address worth offering as a "Will invite" row. The server checks again. */
export const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

/**
 * The steps a given set of answers walks. A group names its people; a group
 * or a community says who approves changes; how to begin comes last for
 * everyone. An unanswered audience counts as Just me, so the indicator reads
 * "Step 1 of 4" before anything is chosen. Exported and pure: the
 * indicator's "of N" and the footer's Next-or-Create both read it.
 */
export function stepsFor(audience: Audience | null): readonly Step[] {
  const who = audience ?? 'solo';
  return [
    'who',
    ...(who === 'invited' ? (['invite'] as const) : []),
    'kind',
    'details',
    ...(who !== 'solo' ? (['approve'] as const) : []),
    'start',
  ];
}

/** What a repo's dapp.json already says, as the import check reads it. */
export interface RepoManifest {
  name?: string | null;
  description?: string | null;
  visibility?: { build: 'public' | 'private' | null; view: 'public' | 'private' | null } | null;
  governance?: { approvers: Approvers; approvals: number | null } | null;
}

/** One earlier answer an import will replace, for the notice. */
export interface RepoOverride {
  key: 'name' | 'desc' | 'vis' | 'gov';
  label: string;
  repo: string;
  yours: string;
}

const WHO_WORDS: Record<Audience, string> = { solo: 'Just me', invited: 'A group', open: 'A community' };

function ruleWords(approvers: Approvers, approvals: number | null): string {
  if (approvers === 'anyone') return 'Members vote';
  return approvals ? `People I pick, at least ${approvals} yes` : 'People I pick, a majority of them';
}

function visibilityWords(v: NonNullable<RepoManifest['visibility']>): string {
  if (v.build === 'public' && v.view === 'public') return 'Anyone can find it, join and build';
  if (v.build === 'private' && v.view === 'public') return 'Anyone can see it; only people invited can build';
  if (v.build === 'public') return 'Anyone can build it';
  return 'Private to the people invited';
}

/**
 * The earlier answers a repo's dapp.json will replace on the first deploy
 * (the name, visibility and governance reconciles in
 * services/app-manifest.js, and the description every surface reads). Only
 * real differences: a repo that keeps a project private does not clash with
 * "A group". Exported and pure for tests/create-app-steps.test.js.
 */
export function repoOverrides(manifest: RepoManifest | null, answers: {
  name: string;
  description: string;
  audience: Audience | null;
  approvers: Approvers | null;
  approvals: Approvals | null;
  approvalsN?: number;
}): RepoOverride[] {
  if (!manifest) return [];
  const out: RepoOverride[] = [];
  const name = answers.name.trim();
  if (manifest.name && manifest.name !== name) {
    out.push({ key: 'name', label: 'Name', repo: manifest.name, yours: name || 'left blank' });
  }
  const description = answers.description.replace(/\s+/g, ' ').trim();
  if (manifest.description && manifest.description !== description) {
    out.push({ key: 'desc', label: 'What it is', repo: manifest.description, yours: description || 'left blank' });
  }
  // An audience is a pair of visibilities (communities.visibilityForAudience):
  // a community is public to see and to build, Just me and a group private.
  // A repo that sets either axis the other way changes who it is for.
  const v = manifest.visibility;
  if (v && answers.audience) {
    const expected = answers.audience === 'open' ? 'public' : 'private';
    const clash = (v.build != null && v.build !== expected) || (v.view != null && v.view !== expected);
    if (clash) out.push({ key: 'vis', label: 'Who it’s for', repo: visibilityWords(v), yours: WHO_WORDS[answers.audience] });
  }
  const g = manifest.governance;
  if (g && answers.audience && answers.audience !== 'solo') {
    const n = Math.round(Number(answers.approvalsN));
    const mine = ruleWords(
      answers.approvers ?? 'anyone',
      answers.approvers === 'invited' && answers.approvals === 'atLeast' && n >= 1 ? n : null,
    );
    const theirs = ruleWords(g.approvers, g.approvals);
    if (mine !== theirs) out.push({ key: 'gov', label: 'Who approves changes', repo: theirs, yours: mine });
  }
  return out;
}

/**
 * The `POST /api/apps` body for a set of answers. Exported and pure so the
 * wire shape is pinned without a browser (tests/create-app-steps.test.js).
 * An import sends the description and the rule only where its repo's
 * dapp.json does not already set them: those the bot commits into it.
 */
export function createBody(answers: {
  name: string;
  /** "What is it?": one optional line. */
  description?: string;
  mode: Mode;
  repoUrl?: string;
  audience: Audience;
  invitees?: readonly Invitee[];
  approvers: Approvers | null;
  approvals: Approvals | null;
  approvalsN?: number;
  /** An import's dapp.json, as the check read it. */
  repo?: RepoManifest | null;
}): Record<string, unknown> {
  const body: Record<string, unknown> = { name: answers.name, audience: answers.audience };
  const importing = answers.mode === 'import';
  if (importing && answers.repoUrl) body.repoUrl = answers.repoUrl;
  const description = (answers.description || '').replace(/\s+/g, ' ').trim();
  if (description && !(importing && answers.repo?.description)) body.description = description;
  if (answers.audience === 'invited') {
    const people = answers.invitees || [];
    const usernames = people.flatMap((p) => (p.kind === 'user' ? [p.username] : []));
    const emails = people.flatMap((p) => (p.kind === 'email' ? [p.email] : []));
    if (usernames.length) body.invitees = usernames;
    if (emails.length) body.inviteEmails = emails;
  }
  if (answers.audience !== 'solo' && answers.approvers === 'invited' && !(importing && answers.repo?.governance)) {
    const n = Math.round(Number(answers.approvalsN));
    body.governance = {
      approvers: 'invited',
      approvals: answers.approvals === 'atLeast' && n >= 1 && n <= 50 ? { atLeast: n } : 'default',
    };
  }
  return body;
}

/** The inline row under the repo URL: spinner, green tick, or red error. */
interface ImportStatus {
  tone: 'none' | 'ok' | 'err';
  text: string;
  spinner?: boolean;
}

const IDLE_STATUS: ImportStatus = { tone: 'none', text: '' };

/** The answers a `?shot=` link opens on. */
interface ShotState {
  step: Step;
  audience: Audience | null;
  kind: Kind | null;
  mode: Mode | null;
  approvers: Approvers | null;
  name: string;
}

/**
 * The state a `?shot=` link opens on, so a URL can reach each step for the
 * declared checks and for screenshots. Display only, read once on open, and
 * never on the prerender pass (no `location` there).
 *
 *   create-group    A group chosen, on the invite step
 *   create-details  Just me, an app, on the name step
 *   create-approve  A community, on the approval step
 *   create-start    A community, on the last step, nothing picked yet
 *   create-import   the last step, importing
 *
 * `create-access`, an older link, lands on `create-approve`.
 */
function shotState(): ShotState {
  const open: ShotState = { step: 'who', audience: null, kind: null, mode: null, approvers: null, name: '' };
  try {
    const shot = new URLSearchParams(location.search).get('shot');
    const named = { ...open, kind: 'app' as Kind, name: 'Seed swap' };
    if (shot === 'create-group') return { ...open, step: 'invite', audience: 'invited' };
    if (shot === 'create-details') return { ...open, step: 'details', audience: 'solo', kind: 'app' };
    if (shot === 'create-approve' || shot === 'create-access') return { ...named, step: 'approve', audience: 'open' };
    if (shot === 'create-start') return { ...named, step: 'start', audience: 'open', approvers: 'anyone' };
    if (shot === 'create-import') return { ...named, step: 'start', audience: 'solo', mode: 'import' };
    return open;
  } catch {
    return open;
  }
}

/**
 * How often the progress view re-asks the server while a creation is
 * still pending. The WS broadcasts do the real work; this only has to be
 * often enough that a dropped socket is noticed, and rare enough that a
 * dialog left open costs the API almost nothing.
 */
const POLL_INTERVAL_MS = 4000;

function statusClass(status: ImportStatus): string {
  if (status.tone === 'ok') return 'px-1 text-sm mt-2 import-status--ok';
  if (status.tone === 'err') return 'px-1 text-sm mt-2 import-status--err';
  return 'px-1 text-sm mt-2';
}

/*
 * ── The pane recipe (#1910) ───────────────────────────────────────────
 *
 * The dialog is drawn in the widget language the shell's panes wear: a grey
 * pane ground, white cards floating on it with no border, and one
 * high-contrast state for "selected" — the accent, the fill the dialog's own
 * Create button wears (#2566). The selection colours live in app.css, keyed
 * off the card's data attributes.
 *
 *   PANE     the card's own ground (`--dc-strip`); inside the kit's modal
 *            shell the same ground comes from the shell instead.
 *   CARD/ROW the auth screens' field card: rounded-2xl, white, one row.
 *   FIELD    the borderless input that sits in such a row.
 *   RAIL/SEGMENT  a segmented control: a raised white track and
 *            full-width segments.
 *   PILL_SECONDARY  the white pill for a secondary action; the primary is
 *            <Button variant="pillAccent">.
 */
const PANE = 'bg-[color:var(--dc-strip)] dark:bg-[color:var(--dc-strip)] rounded-3xl';
const CARD = 'rounded-2xl bg-white dark:bg-zinc-800 overflow-hidden';
const ROW = 'px-4 pt-3 pb-2';
const LABEL = 'block text-[13px] text-zinc-500 dark:text-zinc-400';
const CAPTION = 'px-1 text-xs text-zinc-500 dark:text-zinc-400';
const FIELD = { box: 'card', hint: 'dim', ring: 'bare' } as const;
const RAIL = 'flex items-center gap-0.5 rounded-full bg-white dark:bg-zinc-800 p-0.5 text-sm font-semibold';
const SEGMENT = 'flex-1 min-h-8 rounded-full px-3 py-1 leading-tight transition-colors';
const PILL_SECONDARY = 'flex-1 h-11 rounded-full bg-white text-[15px] font-semibold text-zinc-900 shadow-sm '
  + 'hover:bg-zinc-50 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700 transition-colors';
/*
 * A choice row: one white card each, full width, a title and a one-line
 * caption, and a chevron at the trailing edge. The selection colours stay in
 * app.css, keyed off the card's data attribute for that question.
 */
const CHOICE_BASE = 'w-full text-left ' + CARD + ' px-4 py-3 flex items-center gap-3 transition-colors';
const CHOICE = 'create-mode-pill ' + CHOICE_BASE;
const WHO_CHOICE = 'create-who-pill ' + CHOICE_BASE;
const APPROVER_CHOICE = 'create-approver-pill ' + CHOICE_BASE;
const CHOICE_TITLE = 'block text-[15px] font-semibold';
const CHOICE_CAPTION = 'create-choice-caption block text-xs mt-0.5';
// Shown in place of the chevron once the step has collapsed to the chosen
// row: pressing the row then reopens the choice.
const CHOICE_CHANGE = 'create-choice-change text-xs font-medium shrink-0';
/* The small numbered heading each unfolded step opens with. */
const STEP_HEADING = 'text-[13px] font-semibold text-zinc-700 dark:text-zinc-300 mb-2';
/* A row that is there but cannot be pressed yet: dimmed, saying Soon. */
const SOON = 'create-soon-row w-full text-left ' + CARD + ' px-4 py-3 flex items-center gap-3 text-zinc-500 dark:text-zinc-400';
const SOON_TAG = 'shrink-0 text-xs font-medium text-zinc-500 dark:text-zinc-400';

/** The three audiences, in the order and the words the screen uses. */
const WHO: ReadonlyArray<{ key: Audience; title: string; caption: string }> = [
  { key: 'solo', title: 'Just me', caption: 'Only you can see it. Invite people or open it up later, from its page.' },
  { key: 'invited', title: 'A group', caption: 'Private to you and the people you invite.' },
  { key: 'open', title: 'A community', caption: 'Anyone can find it, join and build.' },
];

function WhoGlyph({ audience }: { audience: Audience }) {
  const cls = 'w-5 h-5 shrink-0 opacity-80';
  if (audience === 'solo') return <UserIcon className={cls} aria-hidden="true" />;
  if (audience === 'invited') return <LockIcon className={cls} aria-hidden="true" />;
  return <UserGroupIcon className={cls} aria-hidden="true" />;
}

/* ── The invite step's rows ────────────────────────────────────────────── */

interface Suggestion { username: string; friend?: boolean }

/** Up to five handles for what is typed, friends first (the Messages scope). */
async function searchUsers(q: string): Promise<Suggestion[]> {
  const res = await fetch(`/api/users/search?scope=messages&q=${encodeURIComponent(q)}`, { credentials: 'same-origin' });
  if (!res.ok) return [];
  const data = (await res.json()) as { users?: Suggestion[] };
  return (data.users || []).slice(0, 5);
}

const P_ROW = 'flex items-center gap-3 min-h-[52px] py-2.5 pl-4 pr-3';
const AVATAR = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-sm font-[650] text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200';
const P_TITLE = 'block truncate text-[15px] font-[650] leading-5 text-zinc-900 dark:text-zinc-100';
const P_SUB = 'block text-[13px] leading-[18px] text-zinc-500 dark:text-zinc-400';
const REMOVE = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-700';

/**
 * #create-invite-block: one row per person, a typing row, and "Add another
 * person". The typing field (#create-invitees) stays uncontrolled, like the
 * dialog's other text fields; what is typed is mirrored into state for the
 * suggestions. Nothing outside React writes into this block.
 */
function InviteRows({ people, setPeople, inputRef }: {
  people: Invitee[];
  setPeople: (next: Invitee[]) => void;
  inputRef: { current: HTMLInputElement | null };
}) {
  const [typing, setTyping] = useState(true);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [searched, setSearched] = useState('');
  const [active, setActive] = useState(0);
  const seq = useRef(0);
  const open = typing || people.length === 0;
  const full = people.length >= MAX_INVITEES;

  // Suggestions follow what is typed, a beat behind, and a late answer to an
  // older query never replaces a newer one.
  useEffect(() => {
    const q = text.trim().replace(/^@/, '');
    if (!q || (text.includes('@') && !text.trim().startsWith('@'))) {
      setSuggestions([]); setSearched(q); return undefined;
    }
    const mine = ++seq.current;
    const timer = setTimeout(() => {
      searchUsers(q).then((found) => {
        if (mine !== seq.current) return;
        const taken = new Set(people.flatMap((p) => (p.kind === 'user' ? [p.username.toLowerCase()] : [])));
        setSuggestions(found.filter((u) => !taken.has(u.username.toLowerCase())));
        setSearched(q);
        setActive(0);
      }).catch(() => { if (mine === seq.current) { setSuggestions([]); setSearched(q); } });
    }, 150);
    return () => clearTimeout(timer);
  }, [text, people]);

  function clearTyping(close: boolean) {
    if (inputRef.current) inputRef.current.value = '';
    setText(''); setError(''); setSuggestions([]); setActive(0);
    if (close) setTyping(false);
  }

  function add(person: Invitee) {
    setPeople([...people, person]);
    clearTyping(true);
  }

  function commit() {
    const typed = text.trim();
    if (!typed) return;
    if (EMAIL_RE.test(typed)) {
      if (people.some((p) => p.kind === 'email' && p.email.toLowerCase() === typed.toLowerCase())) {
        setError('That email is already on the list.');
        return;
      }
      add({ kind: 'email', email: typed });
      return;
    }
    const name = typed.replace(/^@/, '');
    if (suggestions.length) {
      const pick = suggestions[Math.min(active, suggestions.length - 1)];
      add({ kind: 'user', username: pick.username, friend: pick.friend });
      return;
    }
    if (searched !== name) return; // still looking; Enter again once the list arrives
    if (people.some((p) => p.kind === 'user' && p.username.toLowerCase() === name.toLowerCase())) {
      setError(`@${name} is already on the list.`);
      return;
    }
    setError(typed.includes('@') && !typed.startsWith('@')
      ? 'That doesn’t look like an email address.'
      : `No one on Homeroom is called @${name}. Check the spelling, or invite them by email.`);
  }

  return (
    <div id="create-invite-block" className={CARD + ' create-invite-list'}>
      {people.map((p, i) => (
        <div key={p.kind === 'user' ? `u:${p.username}` : `e:${p.email}`} className={P_ROW + ' create-invitee-row'} data-invitee={p.kind}>
          {p.kind === 'user' ? (
            <>
              <span className={AVATAR} aria-hidden="true">{p.username.charAt(0).toUpperCase()}</span>
              <span className="min-w-0 flex-1">
                <span className={P_TITLE}>{'@' + p.username}</span>
                {p.friend ? <span className={P_SUB}>Friend</span> : null}
              </span>
            </>
          ) : (
            <>
              <span className={AVATAR} aria-hidden="true"><EnvelopeIcon className="h-4 w-4" /></span>
              <span className="min-w-0 flex-1">
                {/* A break offered after the @, so a long address wraps
                    between its two halves rather than mid-word. */}
                <span className={P_TITLE + ' create-invitee-email'}>
                  {p.email.slice(0, p.email.indexOf('@') + 1)}<wbr />{p.email.slice(p.email.indexOf('@') + 1)}
                </span>
              </span>
              <span className="create-will-invite shrink-0 rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-semibold text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200">
                Will invite
              </span>
            </>
          )}
          <button
            type="button"
            className={REMOVE}
            aria-label={`Remove ${p.kind === 'user' ? '@' + p.username : p.email}`}
            onClick={() => {
              const next = people.filter((_, j) => j !== i);
              setPeople(next);
              if (!next.length) setTyping(true);
            }}
          >
            <XIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      ))}
      {open ? (
        <div className="create-invitee-typing">
          <div className="px-4 py-2">
            <Input
              id="create-invitees"
              ref={inputRef}
              name="invitees"
              type="text"
              autoComplete="off"
              spellCheck="false"
              {...FIELD}
              placeholder="@username or email"
              aria-label="Add a person by @username or email"
              role="combobox"
              aria-expanded={suggestions.length > 0}
              aria-controls="create-invitee-suggestions"
              onInput={(e) => { setText(e.currentTarget.value); setError(''); }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' && suggestions.length) { e.preventDefault(); setActive((active + 1) % suggestions.length); }
                else if (e.key === 'ArrowUp' && suggestions.length) { e.preventDefault(); setActive((active - 1 + suggestions.length) % suggestions.length); }
                else if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); e.stopPropagation(); commit(); }
                else if (e.key === 'Escape' && people.length) { e.preventDefault(); clearTyping(true); }
              }}
              onBlur={() => {
                // Leaving the field keeps a whole address as a row; an empty
                // field folds back to "Add another person".
                const typed = (inputRef.current?.value || '').trim();
                if (EMAIL_RE.test(typed)) commit();
                else if (!typed && people.length) setTyping(false);
              }}
            />
          </div>
          {error ? <p className="px-4 pb-2.5 -mt-0.5 text-[13px] leading-[18px] text-red-700 dark:text-red-400" role="alert">{error}</p> : null}
          {suggestions.length ? (
            <div id="create-invitee-suggestions" role="listbox">
              {suggestions.map((u, i) => (
                <button
                  key={u.username}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  className="flex w-full items-center gap-2.5 px-4 py-2 text-left hover:bg-zinc-100 aria-selected:bg-zinc-100 dark:hover:bg-zinc-700 dark:aria-selected:bg-zinc-700"
                  // Taken on mousedown, before the field's blur can fold it away.
                  onMouseDown={(e) => { e.preventDefault(); add({ kind: 'user', username: u.username, friend: u.friend }); }}
                >
                  <span className={AVATAR.replace('h-8 w-8', 'h-7 w-7')} aria-hidden="true">{u.username.charAt(0).toUpperCase()}</span>
                  <span className="min-w-0 flex-1">
                    <span className={P_TITLE.replace('font-[650]', 'font-semibold')}>{'@' + u.username}</span>
                    {u.friend ? <span className={P_SUB}>Friend</span> : null}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <button
          type="button"
          className="create-invitee-add flex w-full min-h-[52px] items-center gap-3 px-4 py-2.5 text-left text-[15px] font-semibold text-violet-600 disabled:cursor-not-allowed disabled:opacity-50 dark:text-violet-400"
          disabled={full}
          onClick={() => { setTyping(true); setTimeout(() => inputRef.current?.focus(), 0); }}
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-[1.5px] ring-inset ring-current" aria-hidden="true">
            <PlusIcon className="h-4 w-4" />
          </span>
          {full ? `${MAX_INVITEES} is the most for now` : 'Add another person'}
        </button>
      )}
    </div>
  );
}

/* ── The repo notice, under an import's check ──────────────────────────── */

function RepoNotice({ overrides, unread }: { overrides: RepoOverride[]; unread: boolean }) {
  if (unread) {
    return (
      <p id="create-repo-notice" className={CAPTION} data-overrides="unread">
        Couldn’t read this repo’s dapp.json. Anything it sets still applies once it’s imported.
      </p>
    );
  }
  if (!overrides.length) {
    return (
      <p id="create-repo-notice" className={CAPTION} data-overrides="0">
        Nothing in this repo’s dapp.json changes your answers. They’re written into it when it’s imported.
      </p>
    );
  }
  return (
    <div id="create-repo-notice" className={CARD + ' px-4 pt-3 pb-3.5 ring-[1.5px] ring-inset ring-violet-600'} data-overrides={String(overrides.length)} role="status">
      <div className="flex items-center gap-2 text-[15px] font-[650] leading-5 text-zinc-900 dark:text-zinc-100">
        <InfoCircleIcon className="h-[18px] w-[18px] shrink-0 text-violet-600 dark:text-violet-400" aria-hidden="true" />
        <span>This repo already sets some of this</span>
      </div>
      <p className="mt-1.5 text-[13px] leading-[18px] text-zinc-500 dark:text-zinc-400">
        {`Its dapp.json decides ${overrides.length === 1 ? 'this one' : `these ${overrides.length}`}, so importing uses the repo’s answer in place of yours:`}
      </p>
      <ul className="mt-2.5 flex flex-col gap-2.5">
        {overrides.map((o) => (
          <li key={o.key} className="flex flex-col gap-px" data-override={o.key}>
            <span className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">{o.label}</span>
            <span className="text-[15px] leading-5 text-zinc-900 dark:text-zinc-100">{o.repo}</span>
            <span className="text-[13px] leading-[18px] text-zinc-500 dark:text-zinc-400">{`You chose: ${o.yours}`}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2.5 text-xs text-zinc-500 dark:text-zinc-400">
        Your other answers are written into the repo. Any of this can be changed later, with a vote.
      </p>
    </div>
  );
}

export function CreateAppDialog() {
  const formRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const describeRef = useRef<HTMLInputElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const inviteesRef = useRef<HTMLInputElement>(null);
  const approvalsNRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const lastStepRef = useRef<HTMLDivElement>(null);

  // Every answer starts empty: nothing in this dialog is chosen for the
  // person (request #3160 and the rework after it).
  const [audience, setAudience] = useState<Audience | null>(null);
  const [people, setPeople] = useState<Invitee[]>([]);
  const [kind, setKind] = useState<Kind | null>(null);
  const [name, setName] = useState('');
  const [describe, setDescribe] = useState('');
  const [approvers, setApprovers] = useState<Approvers | null>(null);
  const [approvals, setApprovals] = useState<Approvals | null>(null);
  const [approvalsN, setApprovalsN] = useState(1);
  const [mode, setMode] = useState<Mode | null>(null);
  const [step, setStep] = useState<Step>('who');
  const [importState, setImportState] = useState<ImportState>('idle');
  const [repo, setRepo] = useState<RepoManifest | null>(null);
  const [repoUnread, setRepoUnread] = useState(false);
  const [status, setStatus] = useState<ImportStatus>(IDLE_STATUS);
  const [error, setError] = useState('');
  // QA 2026-09-24 Q5: a double-click on Create sent two POSTs and made two
  // apps, each taking a slot. `submitting` drives the button's disabled and
  // busy look; the ref is the handler's own guard, because a second click can
  // be dispatched before React has re-rendered the button as disabled (and
  // Enter in the name field never goes through the button at all).
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const { blocked: quotaBlocksCreation } = useAppAllowance();
  // The app this dialog is now reporting on. Null until a POST succeeds,
  // which is what keeps the FIRST render byte-identical to the
  // prerendered shell — the progress subtree exists only after a user
  // action, so it never reaches public/index.html.
  const [created, setCreated] = useState<{ slug: string; name: string } | null>(null);
  const progress = useStoreState(creationProgressStore);

  const steps = stepsFor(audience);
  const last = steps[steps.length - 1];
  const isLast = step === last;
  const importing = mode === 'import';

  /** Whether a step has its answer, which is what turns its button on. */
  function answered(which: Step): boolean {
    switch (which) {
      case 'who': return audience != null;
      case 'invite': return people.length > 0;
      case 'kind': return kind != null;
      case 'details': return name.trim().length > 0;
      case 'approve': return approvers != null && (approvers !== 'invited' || approvals != null);
      case 'start': return mode != null && (mode !== 'import' || importState === 'ok');
      default: return false;
    }
  }
  const stepAnswered = answered(step);
  const overrides = importing && importState === 'ok'
    ? repoOverrides(repo, { name, description: describe, audience, approvers, approvals, approvalsN })
    : [];

  const dialog = useDialog('create', {
    onOpen: () => {
      // A real open starts on the first step with nothing chosen; the shot
      // links land on the state they name. Focus follows: nothing on a
      // question step wants the keyboard, the name step's field does.
      const initial = shotState();
      setAudience(initial.audience);
      setKind(initial.kind);
      applyMode(initial.mode);
      setApprovers(initial.approvers);
      setStep(initial.step);
      if (nameRef.current) nameRef.current.value = initial.name;
      setName(initial.name);
      void invalidateAppAllowance();
      if (initial.step === 'details') setTimeout(() => nameRef.current?.focus(), 0);
    },
    // Reset the form, clear the error, and put every answer back to empty
    // so the next open never inherits the last one's half-finished import
    // or group.
    onClose: () => {
      formRef.current?.reset();
      setError('');
      applyMode(null);
      setAudience(null);
      setPeople([]);
      setKind(null);
      setName('');
      setDescribe('');
      setStep('who');
      setApprovers(null);
      setApprovals(null);
      setApprovalsN(1);
      // Drop the progress view too, so the next open lands on the form.
      // The build carries on server-side either way — closing this is
      // dismissing a report, not cancelling anything.
      setCreated(null);
      stopWatchingCreation();
    },
  });

  useHiddenClass(errorRef, !error);
  useIsomorphicLayoutEffect(() => {
    if (nameRef.current) nameRef.current.required = true;
  }, []);

  // Progress arrives on the WS `app_status` channel, which public/js/app.js
  // forwards into the store. That is the fast path and it is not the only
  // one it can be: a socket that drops right before the terminal event
  // would leave a step spinning forever. So while the outcome is still
  // pending, also ASK — GET /api/apps/:slug serves the same phase from the
  // server-side store, plus the status, so one poll recovers everything a
  // missed broadcast would have carried.
  const creatingSlug = created && outcomeOf(progress.status) === 'pending' ? created.slug : null;
  useEffect(() => {
    if (!creatingSlug) return undefined;
    let stopped = false;
    const poll = () => {
      if (stopped) return;
      void fetchCreationProgress(creatingSlug, (url) => fetch(url));
    };
    // Immediately, not only on the interval: the first phase broadcast
    // may already have been sent before this dialog started listening,
    // and four seconds of four idle steps reads as nothing happening.
    poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [creatingSlug]);

  /** Bring the step that just unfolded into view, with the footer under it. */
  function reveal() {
    setTimeout(() => lastStepRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 0);
  }

  /** Pressing a collapsed row reopens its step, answers kept; on its own step, a row selects. */
  function chooseAudience(next: Audience) {
    setError('');
    if (step !== 'who') { setStep('who'); return; }
    setAudience(next);
  }

  function chooseKind(next: Kind) {
    setError('');
    if (step !== 'kind') { setStep('kind'); return; }
    setKind(next);
  }

  function chooseStart(next: Mode) {
    if (step !== 'start' || next === mode) return;
    applyMode(next);
    if (next === 'import') setTimeout(() => urlRef.current?.focus(), 0);
  }

  /** Move one step along, once this one is answered. */
  function next() {
    if (!stepAnswered) {
      if (step === 'details') {
        setError('Give your project a name.');
        nameRef.current?.focus();
      }
      return;
    }
    const to = steps[steps.indexOf(step) + 1];
    if (!to) return;
    setError('');
    setStep(to);
    if (to === 'invite') setTimeout(() => inviteesRef.current?.focus(), 0);
    if (to === 'details') setTimeout(() => nameRef.current?.focus(), 0);
    if (to === 'approve' || to === 'start') reveal();
  }

  /** One entry point keeps every mirror of the mode in sync. */
  function applyMode(next: Mode | null) {
    setMode(next);
    setError('');
    // A new answer here starts the check over: no stale banner, no stale read.
    setImportState('idle');
    setStatus(IDLE_STATUS);
    setRepo(null);
  }

  // The import check.
  //
  //   idle ─┬─ Check click ─→ checking ─┬─ ok    (the repo's dapp.json is
  //         │                           │        read, the notice shows,
  //         │                           │        Import enables)
  //         │                           └─ error (inline message, retry)
  //         └─ user edits URL after a successful check → back to idle
  //
  // Why explicit Check and not a debounced auto-check? Two reasons: (1) "I
  // just invited the bot, click here" is a clear action that pairs with the
  // inline error text from the server, vs. a debounced surprise; (2)
  // verifyBotAccess can mutate state by accepting a pending invitation, and we
  // don't want that firing on every keystroke.
  function normalizeRepositoryUrlInput(): string {
    const input = urlRef.current;
    const normalized = normalizeRepositoryUrl(input?.value || '');
    if (input) input.value = normalized;
    return normalized;
  }

  async function check() {
    const url = normalizeRepositoryUrlInput();
    const fail = (text: string) => {
      setImportState('error');
      setStatus({ tone: 'err', text });
    };
    if (!url) return fail('Paste a GitHub repo URL first.');

    setImportState('checking');
    setRepo(null);
    setStatus({ tone: 'none', text: 'Checking bot access…', spinner: true });

    let res: Response;
    try {
      res = await fetch(`/api/github/verify-access?url=${encodeURIComponent(url)}`);
    } catch {
      return fail('Network error. Try again.');
    }

    let data: Record<string, unknown> = {};
    try {
      data = await res.json();
    } catch {
      /* a non-JSON body is reported through the HTTP status below */
    }
    if (!res.ok) return fail((data.error as string) || `Check failed (HTTP ${res.status}).`);

    const fullName = (data.fullName as string) || `${data.owner}/${data.repo}`;
    // {} when the repo has no dapp.json; null when the server could not read it.
    const manifest = data.manifest as RepoManifest | null | undefined;
    setRepo(manifest && typeof manifest === 'object' ? manifest : {});
    setRepoUnread(manifest === null);
    setImportState('ok');
    setStatus({ tone: 'ok', text: `✓ usernode-bot has Write access to ${fullName}.` });
    reveal();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    // Enter before the last step advances; only the last step creates.
    if (!isLast) {
      next();
      return;
    }
    const trimmed = (nameRef.current?.value || '').trim();
    setError('');
    if (!trimmed) {
      setError('Give your project a name.');
      return;
    }
    if (!mode) {
      setError('Choose how you want to start.');
      return;
    }
    const repoUrl = mode === 'import' ? normalizeRepositoryUrlInput() : '';
    // Guard: an import is gated behind a successful check. The server runs
    // the pre-flight again on POST anyway.
    if (importing) {
      if (!repoUrl) return setError('Paste a GitHub repo URL first.');
      if (importState !== 'ok') return setError('Click "Check" to verify bot access first.');
    }

    const body = createBody({
      name: trimmed,
      description: describeRef.current?.value || '',
      mode,
      repoUrl,
      audience: audience ?? 'solo',
      invitees: people,
      approvers,
      approvals,
      approvalsN,
      repo,
    });

    // One request at a time (QA 2026-09-24 Q5). Claimed synchronously, before
    // the first await, so a second click in the same frame finds it taken.
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const res = await fetch('/api/apps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      void invalidateAppAllowance();
      if (!res.ok) return setError(data.error || 'Failed to create app');
      // The POST returns 201 with the row still in 'creating' — the build
      // runs async server-side. The dialog STAYS OPEN and reports the phases
      // app-creator broadcasts.
      const slug = data.app?.slug;
      if (!slug) {
        // A 201 we cannot follow. Nothing to report progress on, so fall
        // back to closing with a toast rather than an empty progress view.
        dialog.close();
        window.PlatformUI?.toast?.(
          importing
            ? 'Your app is being imported. It will appear in your list of apps when it’s ready.'
            : 'Your app is being created. It will appear in your list of apps when it’s ready.',
        );
        (window.Home?.load as (() => void) | undefined)?.();
        return;
      }
      watchCreation(slug);
      setCreated({ slug, name: data.app?.name || trimmed });
      // Refresh the grid behind the dialog so the new tile is already
      // there when the user closes it.
      (window.Home?.load as (() => void) | undefined)?.();
    } catch {
      setError('Network error');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const stepIndex = Math.max(0, steps.indexOf(step)) + 1;
  // A step's number follows the answers so far: a group has one more.
  const numberOf = (which: Step) => stepsFor(audience ?? 'open').indexOf(which) + 1;
  // The card and the root carry every answer, like data-mode always has:
  // the kit lifts the card out of the root while presented, so CSS keyed on
  // the root alone would stop matching. Each is empty until answered, so no
  // row wears the fill on arrival.
  const answers = {
    'data-mode': mode ?? '',
    'data-import-state': importState,
    'data-step': step,
    'data-audience': audience ?? '',
    'data-kind': kind ?? '',
    'data-approvers': approvers ?? '',
    'data-approvals': approvals ?? '',
    'data-final': isLast ? 'true' : 'false',
    // Which earlier answers an import's dapp.json replaces (app.css dims them).
    'data-repo-sets': overrides.map((o) => o.key).join(' '),
  };

  return (
    <DialogRoot
      id="create-modal"
      ref={dialog.rootRef}
      {...answers}
      {...dialog.backdropProps}
    >
      <DialogCard
        size="sm"
        id="create-card"
        {...answers}
        className={PANE}
      >
        {created ? (
          <CreateProgress
            appName={created.name}
            mode={mode ?? 'new'}
            surface="pane"
            progress={progress}
            openLabel="Open project"
            onOpenApp={() => {
              // Stage 3: the new project's own page (its Workshop, which
              // opens on who it is for), not the running app. That is where
              // the first change is started.
              const slug = created.slug;
              dialog.close();
              (window.App?.navigateToApp as ((s: string, v: string) => void) | undefined)?.(slug, 'dev');
            }}
            onSetSecrets={() => {
              const slug = created.slug;
              dialog.close();
              // Published by features/app-secrets — a bare global read is
              // what broke the last cross-surface jump, so guard it and
              // leave the tile's own "fix secrets" path as the fallback.
              (window.Secrets?.open as ((s: string) => void) | undefined)?.(slug);
            }}
            onRetry={() => {
              const slug = created.slug;
              // Put the view back into its pending state immediately —
              // the retry re-enters createApp server-side and will start
              // broadcasting phases again.
              watchCreation(slug);
              void fetch(`/api/apps/${encodeURIComponent(slug)}/retry`, { method: 'POST' })
                .then(() => (window.Home?.load as (() => void) | undefined)?.())
                .catch(() => {
                  publishAppStatus({
                    slug,
                    status: 'error',
                    errorReason: 'Couldn’t reach the server to retry. Try again from the app’s tile.',
                  });
                });
            }}
            onClose={() => dialog.close()}
          />
        ) : (
        <>
        <h2 id="create-title" className="text-[17px] font-semibold text-zinc-900 dark:text-zinc-100 mb-1">
          {importing && step === 'start' ? 'Import a project' : 'New project'}
        </h2>
        {/*
            How far the flow has unfolded, and how far it goes for the
            answers so far: four steps for Just me, five for a community,
            six for a group. The index is also on the attribute for the
            declared checks.
        */}
        <p
          id="create-step-indicator"
          data-step-index={String(stepIndex)}
          className="text-xs text-zinc-500 dark:text-zinc-400 mb-3"
        >
          {`Step ${stepIndex} of ${steps.length}`}
        </p>
        <AppAllowance id="create-app-quota" surface="pane" />
        <form id="create-form" ref={formRef} className="space-y-4" onSubmit={submit}>
          {/*
              STEP 1: who it is for. The rows are the Workshop's three
              sections, in its words. Pressing one selects it; Next moves on,
              and the step collapses to the chosen row, whose "Change"
              reopens it.
          */}
          <div data-create-step="who" className="space-y-2">
            <p className={STEP_HEADING}>
              1. Who is it for?
              <span className="create-repo-sets-tag" data-repo-tag="vis">{' · the repo sets this'}</span>
            </p>
            {WHO.map((choice) => (
              <button
                key={choice.key}
                type="button"
                data-audience-pill={choice.key}
                aria-pressed={audience === choice.key}
                className={WHO_CHOICE}
                onClick={() => chooseAudience(choice.key)}
              >
                <WhoGlyph audience={choice.key} />
                <span className="min-w-0 flex-1">
                  <span className={CHOICE_TITLE}>{choice.title}</span>
                  <span className={CHOICE_CAPTION}>{choice.caption}</span>
                </span>
                <ChevronRightIcon className="create-choice-chevron w-5 h-5 shrink-0 opacity-60" aria-hidden="true" />
                <span className={CHOICE_CHANGE}>Change</span>
              </button>
            ))}
          </div>
          {/*
              STEP 2, a group only: who is in it, one row per person. The rows
              stay on screen, still editable, as the later steps open.
          */}
          <div data-create-step="invite" className="space-y-2">
            <p className={STEP_HEADING}>{`${numberOf('invite')}. Who do you want to invite?`}</p>
            <InviteRows people={people} setPeople={setPeople} inputRef={inviteesRef} />
            <p className={CAPTION + ' mt-1.5'}>
              Add people on Homeroom by @username, or type an email to invite someone who isn’t here yet. They get an invite when it’s created.
            </p>
          </div>
          {/*
              What it is: an App, the one kind there is today; Document and
              Video are there, dimmed, saying Soon, because the question is
              the one the screen will keep asking.
          */}
          <div data-create-step="kind" className="space-y-2">
            <p className={STEP_HEADING}>{`${numberOf('kind')}. What are you making?`}</p>
            <button
              type="button"
              data-kind-pill="app"
              aria-pressed={kind === 'app'}
              className={'create-kind-row ' + CHOICE_BASE}
              onClick={() => chooseKind('app')}
            >
              <AppWindowIcon className="w-5 h-5 shrink-0 opacity-80" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className={CHOICE_TITLE}>App</span>
                <span className={CHOICE_CAPTION}>Something you build and use together.</span>
              </span>
              <ChevronRightIcon className="create-choice-chevron w-5 h-5 shrink-0 opacity-60" aria-hidden="true" />
              <span className={CHOICE_CHANGE}>Change</span>
            </button>
            <div className={SOON + ' create-kind-soon'} data-kind-pill="doc" aria-disabled="true">
              <NewspaperIcon className="w-5 h-5 shrink-0 opacity-50" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className={CHOICE_TITLE}>Document</span>
                <span className={CHOICE_CAPTION}>Pages you write and edit together.</span>
              </span>
              <span className={SOON_TAG}>Soon</span>
            </div>
            <div className={SOON + ' create-kind-soon'} data-kind-pill="video" aria-disabled="true">
              <PlayIcon className="w-5 h-5 shrink-0 opacity-50" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className={CHOICE_TITLE}>Video</span>
                <span className={CHOICE_CAPTION}>A video you make together, from script to cut.</span>
              </span>
              <span className={SOON_TAG}>Soon</span>
            </div>
          </div>
          {/* The name, and one optional line about what it is. */}
          <div data-create-step="details" className="space-y-4">
            <p className={STEP_HEADING}>
              {`${numberOf('details')}. What to call it`}
              <span className="create-repo-sets-tag" data-repo-tag="details">{' · the repo sets some of this'}</span>
            </p>
            <div id="create-name-block" className={CARD}>
              <div className={ROW + ' create-name-row'}>
                <label htmlFor="app-name" className={LABEL}>
                  Project name
                </label>
                <Input
                  id="app-name"
                  ref={nameRef}
                  name="name"
                  type="text"
                  autoComplete="off"
                  {...FIELD}
                  placeholder="my cool app"
                  onInput={(e) => { setName(e.currentTarget.value); setError(''); }}
                />
              </div>
              {/* What it is: optional. Written into the new repository's
                  dapp.json, where people read it on the join screen, in
                  Discover and on its page. */}
              <div className={ROW + ' create-describe-row shadow-[inset_0_1px_0_var(--app-sheet-line)]'}>
                <label htmlFor="app-description" className={LABEL}>
                  What is it? (optional)
                </label>
                <Input
                  id="app-description"
                  ref={describeRef}
                  name="description"
                  type="text"
                  autoComplete="off"
                  maxLength={100}
                  {...FIELD}
                  placeholder="Shared shopping list"
                  onInput={(e) => setDescribe(e.currentTarget.value)}
                />
              </div>
            </div>
          </div>
          {/*
              Who approves changes — a group or a community. Members vote is
              the platform's default rule; People I pick starts with just the
              creator as approver, and under it "at least N yes votes" is the
              follow-up. Written into the new repository's dapp.json, so it
              can be voted on later like any other rule there. Nothing is
              picked on arrival, and neither is the follow-up once it shows.
          */}
          <div data-create-step="approve" className="space-y-2">
            <p className={STEP_HEADING}>
              {`${numberOf('approve')}. Who approves changes?`}
              <span className="create-repo-sets-tag" data-repo-tag="gov">{' · the repo sets this'}</span>
            </p>
            <div id="create-approve-block" className="space-y-2">
              <button
                type="button"
                data-approver-pill="anyone"
                aria-pressed={approvers === 'anyone'}
                className={APPROVER_CHOICE}
                onClick={() => setApprovers('anyone')}
              >
                <span className="min-w-0 flex-1">
                  <span className={CHOICE_TITLE}>Members vote</span>
                  <span className={CHOICE_CAPTION}>A change merges when most active members say yes, or when nobody objects after a wait.</span>
                </span>
              </button>
              <button
                type="button"
                data-approver-pill="invited"
                aria-pressed={approvers === 'invited'}
                className={APPROVER_CHOICE}
                onClick={() => setApprovers('invited')}
              >
                <span className="min-w-0 flex-1">
                  <span className={CHOICE_TITLE}>People I pick</span>
                  <span className={CHOICE_CAPTION}>Starts with just you. Add approvers later from Members &amp; approvals.</span>
                </span>
              </button>
              <div className="create-approvals-block space-y-2 pt-1">
                <p className={LABEL}>How many of them must say yes?</p>
                <div className={RAIL}>
                  <button
                    type="button"
                    data-approvals-pill="majority"
                    aria-pressed={approvals === 'majority'}
                    className={'create-approvals-pill ' + SEGMENT}
                    onClick={() => setApprovals('majority')}
                  >
                    A majority
                  </button>
                  <button
                    type="button"
                    data-approvals-pill="atLeast"
                    aria-pressed={approvals === 'atLeast'}
                    className={'create-approvals-pill ' + SEGMENT}
                    onClick={() => {
                      setApprovals('atLeast');
                      setTimeout(() => approvalsNRef.current?.focus(), 0);
                    }}
                  >
                    At least a number
                  </button>
                </div>
                <div className={CARD + ' create-approvals-n-block'}>
                  <div className={ROW + ' flex items-center gap-3'}>
                    <label htmlFor="create-approvals-n" className={LABEL + ' flex-1'}>
                      Yes votes needed
                    </label>
                    <Input
                      id="create-approvals-n"
                      ref={approvalsNRef}
                      name="approvalsN"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={50}
                      defaultValue="1"
                      {...FIELD}
                      className="w-16 text-right"
                      onInput={(e) => setApprovalsN(Number(e.currentTarget.value) || 0)}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
          {/*
              LAST: how to begin. From scratch; from a template, which is
              coming; or from a GitHub repo, whose URL and Check open under
              its row. The check also reads the repo's dapp.json, and the
              notice under it names each earlier answer the repo replaces.
          */}
          <div data-create-step="start" className="space-y-2" ref={lastStepRef}>
            <p className={STEP_HEADING}>{`${numberOf('start')}. How do you want to start?`}</p>
            <button
              type="button"
              data-mode-pill="new"
              aria-pressed={mode === 'new'}
              className={CHOICE}
              onClick={() => chooseStart('new')}
            >
              <span className="min-w-0 flex-1">
                <span className={CHOICE_TITLE}>Start from scratch</span>
                <span className={CHOICE_CAPTION}>An empty app. Describe what you want and build it with the group.</span>
              </span>
            </button>
            <div className={SOON} data-mode-pill="template" aria-disabled="true">
              <span className="min-w-0 flex-1">
                <span className={CHOICE_TITLE}>Start from a template</span>
                <span className={CHOICE_CAPTION}>A ready-made app to make your own.</span>
              </span>
              <span className={SOON_TAG}>Soon</span>
            </div>
            <button
              type="button"
              data-mode-pill="import"
              aria-pressed={mode === 'import'}
              className={CHOICE}
              onClick={() => chooseStart('import')}
            >
              <span className="min-w-0 flex-1">
                <span className={CHOICE_TITLE}>Import a GitHub repo</span>
                <span className={CHOICE_CAPTION}>Bring an app that already exists. You will invite the bot to it first.</span>
              </span>
            </button>
            <div id="create-import-block" className="create-import-block">
              <div className={CARD}>
                <div className={ROW}>
                  <label htmlFor="import-url" className={LABEL}>
                    GitHub repo URL
                  </label>
                  <div className="flex items-center gap-2">
                    <Input
                      id="import-url"
                      ref={urlRef}
                      name="repoUrl"
                      type="text"
                      inputMode="url"
                      autoComplete="off"
                      spellCheck="false"
                      width="flex"
                      {...FIELD}
                      className="font-mono text-[15px]"
                      placeholder="github.com/owner/repo"
                      onBlur={() => {
                        normalizeRepositoryUrlInput();
                      }}
                      onInput={() => {
                        // Any edit invalidates the previous check; the user must
                        // click again. Without this they could verify repo A, edit
                        // the URL to point at repo B, then submit — the route's own
                        // pre-flight catches it, but the UI shouldn't claim
                        // "verified" for a URL that hasn't been verified.
                        setImportState('idle');
                        setStatus(IDLE_STATUS);
                        setRepo(null);
                      }}
                    />
                    <Button
                      type="button"
                      id="import-check"
                      variant="pillNeutral"
                      size="sm"
                      ink="neutral"
                      layout="shrink"
                      disabledStyle="block"
                      // The pill sits INSIDE a white card, so its neutral fill
                      // has to be one step off the card in both themes.
                      className="whitespace-nowrap dark:bg-zinc-700 dark:hover:bg-zinc-600"
                      disabled={importState === 'checking'}
                      onClick={check}
                    >
                      {importState === 'ok' ? 'Re-check' : 'Check'}
                    </Button>
                  </div>
                </div>
              </div>
              {/*
                  ONE text node on each side of the <code>. `Invite{' '}` is two
                  adjacent text children, and renderToStaticMarkup emits no
                  separator comment between them, so the browser sees one node
                  where hydration expects two and React reports #418 — a
                  console error, which fails proposal checks.
              */}
              <p className={CAPTION + ' mt-1.5'}>
                {'Invite '}
                <code className="font-mono text-xs">
                  usernode-bot
                </code>
                {' as a collaborator (Write access on an organization repo).'}
              </p>
              {/*
                  Inline status row: spinner while checking, green check on
                  ok, red error text on failure. Hidden in idle.
              */}
              <div id="import-status" className={statusClass(status)}>
                {status.spinner ? <span className="import-spinner"></span> : null}
                {status.text}
              </div>
              <div className="mt-2">
                {importState === 'ok' ? (
                  <RepoNotice overrides={overrides} unread={repoUnread} />
                ) : (
                  <p className={CAPTION}>Check the repo to see what its dapp.json already sets.</p>
                )}
              </div>
            </div>
          </div>
          <div id="create-error" ref={errorRef} className="px-1 text-red-700 dark:text-red-400 text-sm hidden">
            {error}
          </div>
          {/*
              The footer follows how far the card has unfolded, through CSS
              on #create-card[data-final] rather than by mounting and
              unmounting (every id ships on every step). Cancel is always
              there; Next beside it until the last step, then Create /
              Import. Either one stays dimmed until its step is answered
              (`stepAnswered`). No Back: the earlier steps are still on
              screen, and each collapsed row's "Change" reopens its choice.
          */}
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              id="create-cancel"
              className={PILL_SECONDARY}
              onClick={() => dialog.close()}
            >
              Cancel
            </button>
            <Button
              type="button"
              id="create-next"
              variant="pillAccent"
              size="pill"
              layout="flex"
              disabledStyle="block"
              disabled={quotaBlocksCreation || !stepAnswered}
              onClick={next}
            >
              Next
            </Button>
            {/*
                QA 2026-09-24 Q5: disabled with a spinner while the POST is
                in flight. `submitting` starts false, so the first render is
                still the prerendered button: no aria-busy, no spinner.
            */}
            <Button
              type="submit"
              id="create-submit"
              variant="pillAccent"
              size="pill"
              layout="flex"
              disabledStyle="block"
              disabled={quotaBlocksCreation || submitting || !stepAnswered}
              aria-busy={submitting || undefined}
            >
              {submitting ? <SpinnerArcIcon className="inline-block h-4 w-4 mr-2 -mt-0.5 align-middle animate-spin" aria-hidden="true" /> : null}
              {submitting
                ? (importing ? 'Importing…' : 'Creating…')
                : (importing ? 'Import' : 'Create')}
            </Button>
          </div>
        </form>
        </>
        )}
      </DialogCard>
    </DialogRoot>
  );
}
