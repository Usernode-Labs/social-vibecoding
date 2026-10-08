'use strict';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
import { returnKeyHandler } from '../../lib/return-to-next';
import { agoStamp } from '../../lib/timestamp';

// Test accounts (#admin/test-accounts): make a genuinely new account for
// first-time-user testing, get a one-time phone sign-in for a test number,
// see the live ones, and retire one when testing is done. The routes are
// src/routes/test-accounts.js, the same four the connector's
// create_test_account / create_test_phone_sign_in / list_test_accounts /
// retire_test_account wrap; this section replaces pasting a fetch() into
// devtools.
//
// PERMISSIONS: every one of those routes is requireAdminWrite, the LIST
// included, so a view-only admin can neither make nor see test accounts. The
// section says so and fetches nothing for them (the db-export section's
// "requires full admin" shape); a full admin gets the form and the list.
//
// THE ONE-TIME PASSWORD. POST /api/test-accounts answers with the password
// once (no-store) and never again. Here it lives in exactly one place: the
// `result` of CreateCard's reducer, rendered as text in one <code>. Nothing
// writes it anywhere else: no storage, no console, no URL, no attribute, no
// module-level variable. It goes away when
//   * Create is pressed again (`start` clears it before the request is sent),
//   * the admin presses "Hide it",
//   * the section unmounts (destroy() drops the portal, and its state with it:
//     leaving for another section, the phone menu or another screen), and
//   * the page is hidden for good (pagehide), so a back/forward cache restore
//     cannot bring it back on screen.
// A response that lands after the section has gone is dropped unread.
//
// Data from the API (usernames, notes, app slugs, statuses) is rendered as
// text children; nothing here is an anchor.

export interface NewAccount {
  userId: number;
  username: string;
  password: string;
  needsUsernameChoice: boolean;
  platformAccess: boolean;
  homeroomBotDm: boolean;
  welcomeDm: boolean;
  note: string | null;
}

export interface LiveApp { slug: string; status: string | null }

export interface LiveAccount {
  userId: number;
  username: string;
  createdBy: string | null;
  createdAt: string | null;
  lastActiveAt: string | null;
  note: string | null;
  apps: LiveApp[];
}

export interface Fields {
  username: string;
  note: string;
  platformAccess: boolean;
  homeroomBotDm: boolean;
  welcomeDm: boolean;
}

export interface CreateBody {
  username?: string;
  note?: string;
  platformAccess: boolean;
  homeroomBotDm: boolean;
  welcomeDm: boolean;
}

export type Field = 'username' | 'note';
type Tone = 'ok' | 'err';
interface Status { text: string; tone: Tone }

export type ListState =
  | { kind: 'loading' }
  | { kind: 'error'; error: string }
  | { kind: 'ready'; accounts: LiveAccount[]; max: number };

// The server's own limits (services/test-accounts.js MAX_LIVE, NOTE_MAX).
// MAX_LIVE is only the fallback until the list answers with its `max`.
export const MAX_LIVE = 25;
export const NOTE_MAX = 200;
export const RETIRE_CONFIRMATION = 'RETIRE';
// services/usernames.js USERNAME_RE. The server still decides: reserved
// names and taken ones come back as its own sentence.
const USERNAME_RE = /^[A-Za-z0-9_]{3,32}$/;

export const BLANK: Fields = Object.freeze({
  username: '', note: '', platformAccess: true, homeroomBotDm: false, welcomeDm: false,
}) as Fields;

const HINT = 'text-xs text-zinc-500 dark:text-zinc-400 mt-1';
const ERROR = 'text-xs text-red-700 dark:text-red-400 mt-1';
const DONE = 'text-xs text-emerald-700 dark:text-emerald-400 mb-3';
const FAILED = 'text-xs text-red-700 dark:text-red-400 mb-3';
const CHECK = 'mt-0.5 h-4 w-4 shrink-0 accent-violet-600';
const SECRET = 'flex-1 min-w-0 break-all rounded-lg bg-white dark:bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-900 dark:text-zinc-100';
const CELL_FINE = 'text-xs text-zinc-500 dark:text-zinc-400';

// ── Talking to the routes ───────────────────────────────────────────────

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
// Called as a plain function, never as a method, so `fetch` keeps its window.
const browserFetch: Fetch = (input, init) => fetch(input, init);

interface Reply { status: number; data: any }

const is2xx = (status: number) => status >= 200 && status < 300;

// Never throws: a network failure is status 0, an unreadable body is null.
async function send(fetchImpl: Fetch, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Reply> {
  const init: RequestInit = { method, cache: 'no-store' };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetchImpl(path, init);
  } catch {
    return { status: 0, data: null };
  }
  let data: any = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

/**
 * The sentence to show for a refusal, and the field it belongs to. The
 * server's own sentence wins, except where it names a connector parameter
 * (at_capacity, bot_dm_full) or is not a sentence at all (a 403 from a guard,
 * a bare 500). `unsure` says what to do when the request may have landed.
 */
export function refusal(reply: Reply, unsure: string): { error: string; field: Field | null } {
  const data = reply.data && typeof reply.data === 'object' ? reply.data : {};
  const field: Field | null = data.field === 'username' || data.field === 'note' ? data.field : null;
  if (reply.status === 0) return { error: `Could not reach the server. ${unsure}`, field: null };
  if (reply.status === 403) return { error: 'Only a full admin can do this, from this page.', field: null };
  if (data.code === 'at_capacity') {
    const live = Number.isFinite(data.live) ? data.live : MAX_LIVE;
    return {
      error: `There are already ${live} live test accounts, the most allowed at once. Retire one below, then try again.`,
      field: null,
    };
  }
  if (data.code === 'bot_dm_full') {
    return {
      error: 'The Homeroom bot\'s list is full. Make the account with "Homeroom bot builds for it" off, '
        + 'or free a place in the Homeroom bot section first.',
      field: null,
    };
  }
  if (typeof data.error === 'string' && data.error && reply.status !== 500) return { error: data.error, field };
  return { error: `Something went wrong on the server (HTTP ${reply.status}). ${unsure}`, field: null };
}

/**
 * The POST body for the form, or the field that stops it. Light on purpose:
 * the server is the judge of a username (reserved, taken), so this only
 * catches what is plainly not one. An empty username is left out, which is
 * what asks for a placeholder and the first-run "choose your username" step.
 */
export function buildCreateBody(fields: Fields):
  { ok: true; body: CreateBody } | { ok: false; field: Field; error: string } {
  const username = String(fields.username || '').trim().replace(/^@/, '');
  if (username && !USERNAME_RE.test(username)) {
    return { ok: false, field: 'username', error: 'Use 3 to 32 letters, numbers and underscores, or leave it empty.' };
  }
  const note = String(fields.note || '').trim();
  if (note.length > NOTE_MAX) {
    return { ok: false, field: 'note', error: `Keep the note to ${NOTE_MAX} characters.` };
  }
  const body: CreateBody = {} as CreateBody;
  if (username) body.username = username;
  if (note) body.note = note;
  body.platformAccess = !!fields.platformAccess;
  body.homeroomBotDm = !!fields.homeroomBotDm;
  body.welcomeDm = !!fields.welcomeDm;
  return { ok: true, body };
}

function toNewAccount(a: any): NewAccount {
  return {
    userId: Number(a.userId),
    username: String(a.username || ''),
    password: String(a.password || ''),
    needsUsernameChoice: !!a.needsUsernameChoice,
    platformAccess: a.platformAccess !== false,
    homeroomBotDm: !!a.homeroomBotDm,
    welcomeDm: !!a.welcomeDm,
    note: a.note ? String(a.note) : null,
  };
}

function toLiveAccount(a: any): LiveAccount {
  return {
    userId: Number(a.userId),
    username: String(a.username || ''),
    createdBy: a.createdBy ? String(a.createdBy) : null,
    createdAt: a.createdAt ? String(a.createdAt) : null,
    lastActiveAt: a.lastActiveAt ? String(a.lastActiveAt) : null,
    note: a.note ? String(a.note) : null,
    apps: (Array.isArray(a.apps) ? a.apps : []).map((app: any) => ({
      slug: String(app && app.slug),
      status: app && app.status != null ? String(app.status) : null,
    })),
  };
}

/** GET /api/test-accounts, as the list's state. */
export async function loadLive(fetchImpl: Fetch = browserFetch): Promise<ListState> {
  const reply = await send(fetchImpl, 'GET', '/api/test-accounts');
  if (is2xx(reply.status) && reply.data && Array.isArray(reply.data.accounts)) {
    const max = Number(reply.data.max);
    return {
      kind: 'ready',
      accounts: reply.data.accounts.map(toLiveAccount),
      max: Number.isFinite(max) && max > 0 ? max : MAX_LIVE,
    };
  }
  return { kind: 'error', error: refusal(reply, 'Try Refresh.').error };
}

// ── Making one ──────────────────────────────────────────────────────────

export interface CreateState {
  busy: boolean;
  // The one-time answer, password included. See the header: this is the
  // only place the password is ever held.
  result: NewAccount | null;
  error: string | null;
  field: Field | null;
}

export type CreateAction =
  | { type: 'start' }
  | { type: 'created'; account: NewAccount }
  | { type: 'refused'; error: string; field: Field | null }
  | { type: 'dismiss' };

export const CREATE_IDLE: CreateState = Object.freeze({
  busy: false, result: null, error: null, field: null,
}) as CreateState;

export function createReducer(state: CreateState, action: CreateAction): CreateState {
  switch (action.type) {
    // A new Create forgets the last account's password before anything else.
    case 'start': return { busy: true, result: null, error: null, field: null };
    case 'created': return { busy: false, result: action.account, error: null, field: null };
    case 'refused': return { busy: false, result: null, error: action.error, field: action.field };
    case 'dismiss': return state.result ? { ...state, result: null } : state;
    default: return state;
  }
}

const CREATE_UNSURE = 'Check the list below before you try again, in case it was made.';

/**
 * One press of Create: clear the last result, check the form, POST it, and
 * hand the answer to `dispatch`. Resolves whether an account was made. The
 * password goes to `dispatch` and nowhere else.
 */
export async function runCreate(fields: Fields, { dispatch, fetchImpl = browserFetch }: {
  dispatch: (action: CreateAction) => void; fetchImpl?: Fetch;
}): Promise<boolean> {
  dispatch({ type: 'start' });
  const built = buildCreateBody(fields);
  if (!built.ok) {
    dispatch({ type: 'refused', error: built.error, field: built.field });
    return false;
  }
  const reply = await send(fetchImpl, 'POST', '/api/test-accounts', built.body);
  const account = is2xx(reply.status) && reply.data ? reply.data.account : null;
  if (account && typeof account.password === 'string' && account.password) {
    dispatch({ type: 'created', account: toNewAccount(account) });
    return true;
  }
  const { error, field } = refusal(reply, CREATE_UNSURE);
  dispatch({ type: 'refused', error, field });
  return false;
}

// ── Retiring one ────────────────────────────────────────────────────────

export interface ConfirmOptions { title: string; message: string; confirmLabel: string; danger: boolean }

export function retireConfirmation(account: LiveAccount): ConfirmOptions {
  const n = account.apps.length;
  const apps = n
    ? `its ${n === 1 ? 'app' : `${n} apps`} (${account.apps.map((a) => a.slug).join(', ')})`
    : '';
  return {
    title: `Retire @${account.username}?`,
    message: (apps ? `This takes down ${apps} and deletes the account.` : 'This deletes the account. It has made no apps.')
      + ' It is signed out everywhere and its open votes are withdrawn. This can\'t be undone.',
    confirmLabel: 'Retire',
    danger: true,
  };
}

export interface RetireOutcome { confirmed: boolean; status: Status | null }

/**
 * One press of Retire: ask first, in the page (AdminConsole._confirm), and
 * only on a yes POST the retire with its confirmation word.
 */
export async function runRetire(account: LiveAccount, { confirm, onConfirmed, fetchImpl = browserFetch }: {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  onConfirmed?: () => void;
  fetchImpl?: Fetch;
}): Promise<RetireOutcome> {
  const yes = await confirm(retireConfirmation(account));
  if (!yes) return { confirmed: false, status: null };
  if (onConfirmed) onConfirmed();
  const reply = await send(fetchImpl, 'POST', `/api/test-accounts/${account.userId}/retire`,
    { confirm: RETIRE_CONFIRMATION });
  const retired = is2xx(reply.status) && reply.data ? reply.data.retired : null;
  if (retired) {
    const gone: unknown[] = Array.isArray(retired.appsDeleted) ? retired.appsDeleted : [];
    const apps = gone.length ? ` and took down ${gone.length === 1 ? 'its app' : `its ${gone.length} apps`}` : '';
    return { confirmed: true, status: { text: `Retired @${account.username}${apps}.`, tone: 'ok' } };
  }
  const { error } = refusal(reply, 'Refresh the list to see whether it was retired.');
  return { confirmed: true, status: { text: error, tone: 'err' } };
}

// ── The one-time result ─────────────────────────────────────────────────

/**
 * A value with a Copy button. The Clipboard API is called inside the click
 * handler (it needs the gesture); where it is missing or refused, the text is
 * selected instead so a keyboard copy takes it.
 */
function CopyValue({ id, label, value }: { id: string; label: string; value: string }) {
  const valueRef = useRef<HTMLElement | null>(null);
  const [said, setSaid] = useState<'idle' | 'copied' | 'selected'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const show = (next: 'copied' | 'selected') => {
    setSaid(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaid('idle'), 2500);
  };
  const select = () => {
    const el = valueRef.current;
    const sel = typeof window !== 'undefined' ? window.getSelection() : null;
    if (!el || !sel) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  };
  const copy = () => {
    const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (clip && typeof clip.writeText === 'function') {
      clip.writeText(value).then(() => show('copied'), () => { select(); show('selected'); });
    } else {
      select();
      show('selected');
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-20 shrink-0 text-xs font-medium text-amber-900 dark:text-amber-200">{label}</span>
      <code id={id} ref={valueRef} className={SECRET} translate="no">{value}</code>
      <button type="button" className={AdminUI.btn.outlineSm} aria-label={`Copy the ${label.toLowerCase()}`} onClick={copy}>
        {said === 'copied' ? 'Copied' : (said === 'selected' ? 'Selected, copy it' : 'Copy')}
      </button>
    </div>
  );
}

export function OneTimeResult({ account, onDone }: { account: NewAccount; onDone: () => void }) {
  return (
    <section id="admin-test-accounts-result" aria-label="The new test account"
      className="mt-4 rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-4">
      <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">Shown once. Copy it now.</p>
      <p className="text-xs text-amber-800 dark:text-amber-300 mt-1 mb-3">
        The password is not kept anywhere you can read it again. Leaving this section or making another account clears it.
      </p>
      <div className="space-y-2">
        <CopyValue id="admin-test-accounts-new-username" label="Username" value={account.username} />
        <CopyValue id="admin-test-accounts-new-password" label="Password" value={account.password} />
      </div>
      <ul className="mt-3 list-disc pl-5 space-y-1 text-sm text-amber-900 dark:text-amber-200">
        <li>Sign out on the device first, then sign in with these.</li>
        {account.needsUsernameChoice ? (
          <li>The username is a placeholder. Sign in with it, and Homeroom asks for a real one straight after, as it does for a newcomer.</li>
        ) : null}
        {account.platformAccess ? null : <li>It is not let in yet, so it signs in to the waiting room.</li>}
        <li>Retire it below when testing is done.</li>
      </ul>
      <button id="admin-test-accounts-done" type="button" className={`${AdminUI.btn.outline} mt-3`} onClick={onDone}>
        Hide it
      </button>
    </section>
  );
}

// ── The form ────────────────────────────────────────────────────────────

function Toggle({ id, checked, disabled, onChange, title, hint }: {
  id: string; checked: boolean; disabled: boolean; onChange: (next: boolean) => void; title: string; hint: string;
}) {
  return (
    <label htmlFor={id} className="flex items-start gap-2 rounded-xl bg-zinc-50 dark:bg-zinc-800/60 p-3">
      <input id={id} type="checkbox" className={CHECK} checked={checked} disabled={disabled}
        onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-zinc-900 dark:text-zinc-100">{title}</span>
        <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{hint}</span>
      </span>
    </label>
  );
}

export function CreateCard({ full, max, onCreated }: { full: boolean; max: number; onCreated: () => void }) {
  const [fields, setFields] = useState<Fields>(BLANK);
  const [state, dispatch] = useReducer(createReducer, CREATE_IDLE);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // A page put away for good (a navigation off Homeroom, a closed tab) may be
  // kept in the back/forward cache and shown again exactly as it was. Clear
  // the password before that snapshot, synchronously, so it cannot come back.
  useEffect(() => {
    const forget = () => { flushSync(() => dispatch({ type: 'dismiss' })); };
    window.addEventListener('pagehide', forget);
    return () => window.removeEventListener('pagehide', forget);
  }, []);

  const set = (patch: Partial<Fields>) => setFields((prev) => ({ ...prev, ...patch }));
  const submit = async () => {
    if (state.busy || full) return;
    // Once the section has gone, an answer is dropped unread.
    const made = await runCreate(fields, { dispatch: (action) => { if (alive.current) dispatch(action); } });
    if (!alive.current || !made) return;
    set({ username: '', note: '' });
    onCreated();
  };

  const busy = state.busy;
  const fieldError = (f: Field) => (state.field === f ? state.error : null);
  const general = state.field ? null : state.error;

  return (
    <div id="admin-test-accounts-create" className={`${AdminUI.card} p-4`}>
      <div className={AdminUI.cardHeader}>
        <h2 className={AdminUI.cardTitle}>Make a test account</h2>
      </div>
      <p className={`${AdminUI.muted} mb-4`}>
        A real account for trying Homeroom the way a newcomer does: the sign-in form, the terms, the
        community picker, the tour and Getting started, with no history. It stays a test account for
        good. It is left off the leaderboards and the Journey page, and its votes on projects real
        people made are shown but not counted.
      </p>
      <form id="admin-test-accounts-form" noValidate autoComplete="off"
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
        onKeyDown={returnKeyHandler()}>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className={AdminUI.label} htmlFor="admin-test-accounts-username">
              Username <span className="font-normal text-zinc-500 dark:text-zinc-400">(optional)</span>
            </label>
            <input id="admin-test-accounts-username" type="text" autoComplete="off" autoCapitalize="none"
              spellCheck={false} enterKeyHint="next" disabled={busy}
              className={`${AdminUI.input} mt-1 font-mono disabled:opacity-60`}
              placeholder="maya_test" value={fields.username}
              aria-invalid={state.field === 'username' ? true : undefined}
              aria-describedby="admin-test-accounts-username-hint"
              onChange={(e) => set({ username: e.target.value })} />
            <p id="admin-test-accounts-username-hint" className={HINT}>
              Leave it empty for a placeholder name. The tester then picks a username at first sign-in, in the same step a newcomer sees.
            </p>
            {fieldError('username') ? (
              <p id="admin-test-accounts-username-error" role="alert" className={ERROR}>{fieldError('username')}</p>
            ) : null}
          </div>
          <div>
            <label className={AdminUI.label} htmlFor="admin-test-accounts-note">Note</label>
            <input id="admin-test-accounts-note" type="text" autoComplete="off" enterKeyHint="go"
              maxLength={NOTE_MAX} disabled={busy}
              className={`${AdminUI.input} mt-1 disabled:opacity-60`}
              placeholder="What it's for, e.g. first-session run with Maya" value={fields.note}
              aria-invalid={state.field === 'note' ? true : undefined}
              aria-describedby="admin-test-accounts-note-hint"
              onChange={(e) => set({ note: e.target.value })} />
            <p id="admin-test-accounts-note-hint" className={HINT}>
              {`Shown in the list below. Up to ${NOTE_MAX} characters.`}
            </p>
            {fieldError('note') ? (
              <p id="admin-test-accounts-note-error" role="alert" className={ERROR}>{fieldError('note')}</p>
            ) : null}
          </div>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <Toggle id="admin-test-accounts-platform-access" checked={fields.platformAccess} disabled={busy}
            onChange={(v) => set({ platformAccess: v })} title="Let in now"
            hint="It signs in to Homeroom itself. Off, it waits in the waiting room, to test that screen." />
          <Toggle id="admin-test-accounts-bot-dm" checked={fields.homeroomBotDm} disabled={busy}
            onChange={(v) => set({ homeroomBotDm: v })} title="Homeroom bot builds for it"
            hint="Puts it on the Homeroom bot's list, as Settings, Experimental does: the bot builds its first version and talks to it in Messages." />
          <Toggle id="admin-test-accounts-welcome-dm" checked={fields.welcomeDm} disabled={busy}
            onChange={(v) => set({ welcomeDm: v })} title="Welcome DM"
            hint="Lets the welcome message reach it: a group with the people set in Welcome messages." />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button id="admin-test-accounts-submit" type="submit" className={AdminUI.btn.primary} disabled={busy || full}>
            {busy ? 'Creating…' : 'Create test account'}
          </button>
          {full ? (
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              {`${max} of ${max} live. Retire one below to make another.`}
            </span>
          ) : null}
        </div>
        {general ? <p id="admin-test-accounts-error" role="alert" className={ERROR}>{general}</p> : null}
      </form>
      {state.result ? <OneTimeResult account={state.result} onDone={() => dispatch({ type: 'dismiss' })} /> : null}
    </div>
  );
}

// ── A one-time phone sign-in ────────────────────────────────────────────
//
// POST /api/test-accounts/phone-sign-ins (services/test-accounts.js
// mintPhoneSignIn): a fictional test number and a code that signs in once,
// for the flows that ask for a phone, above all an invite's Join sheet. The
// code is handled like the password above: held only in PhoneSignInCard's
// state, cleared on Hide, on a new request, on unmount and on pagehide.

export interface PhoneSignIn {
  phoneNumber: string;
  code: string;
  expiresAt: string;
  signsInTo: string | null;
}

/** "18:42", the local time a sign-in's code stops working. */
export function untilText(expiresAt: string): string {
  const at = new Date(expiresAt);
  if (Number.isNaN(at.getTime())) return 'in 30 minutes';
  return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** One press: POST, and the sign-in or the sentence to show. Never throws. */
export async function runPhoneSignIn(fetchImpl: Fetch = browserFetch):
  Promise<{ ok: true; signIn: PhoneSignIn } | { ok: false; error: string }> {
  const reply = await send(fetchImpl, 'POST', '/api/test-accounts/phone-sign-ins', {});
  const s = is2xx(reply.status) && reply.data ? reply.data.signIn : null;
  if (s && typeof s.code === 'string' && s.code && typeof s.phoneNumber === 'string') {
    return {
      ok: true,
      signIn: {
        phoneNumber: s.phoneNumber,
        code: s.code,
        expiresAt: String(s.expiresAt || ''),
        signsInTo: s.signsInTo ? String(s.signsInTo) : null,
      },
    };
  }
  return { ok: false, error: refusal(reply, 'Try again in a moment.').error };
}

export function PhoneSignInResult({ signIn, onDone }: { signIn: PhoneSignIn; onDone: () => void }) {
  return (
    <section id="admin-test-accounts-phone-result" aria-label="The one-time phone sign-in"
      className="mt-4 rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-4">
      <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">Shown once. Copy it now.</p>
      <p className="text-xs text-amber-800 dark:text-amber-300 mt-1 mb-3">
        {`The code works once, until ${untilText(signIn.expiresAt)}. Leaving this section or asking for another clears it.`}
      </p>
      <div className="space-y-2">
        <CopyValue id="admin-test-accounts-phone-number" label="Number" value={signIn.phoneNumber} />
        <CopyValue id="admin-test-accounts-phone-code" label="Code" value={signIn.code} />
      </div>
      <ul className="mt-3 list-disc pl-5 space-y-1 text-sm text-amber-900 dark:text-amber-200">
        <li>Sign out on the device first.</li>
        <li>Open the invite link and enter this number. Tap Text me a code: no text is sent.</li>
        <li>Enter the code.</li>
        {signIn.signsInTo
          ? <li>{`It signs in to the test account @${signIn.signsInTo}.`}</li>
          : <li>The account it makes is a test account. Retire it below when testing is done.</li>}
      </ul>
      <button id="admin-test-accounts-phone-done" type="button" className={`${AdminUI.btn.outline} mt-3`} onClick={onDone}>
        Hide it
      </button>
    </section>
  );
}

export function PhoneSignInCard({ full }: { full: boolean }) {
  const [busy, setBusy] = useState(false);
  const [signIn, setSignIn] = useState<PhoneSignIn | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // As for the password: clear the code before a back/forward cache snapshot.
  useEffect(() => {
    const forget = () => { flushSync(() => setSignIn(null)); };
    window.addEventListener('pagehide', forget);
    return () => window.removeEventListener('pagehide', forget);
  }, []);

  const ask = async () => {
    if (busy || full) return;
    setBusy(true);
    setSignIn(null);
    setError(null);
    const out = await runPhoneSignIn();
    if (!alive.current) return;
    setBusy(false);
    if (out.ok) setSignIn(out.signIn);
    else setError(out.error);
  };

  return (
    <div id="admin-test-accounts-phone" className={`${AdminUI.card} p-4`}>
      <div className={AdminUI.cardHeader}>
        <h2 className={AdminUI.cardTitle}>A one-time phone sign-in</h2>
      </div>
      <p className={`${AdminUI.muted} mb-4`}>
        For the flows that ask for a phone number, like an invite&apos;s Join sheet. You get a
        made-up test number and a code that works once, within 30 minutes. No text is sent. The
        account it makes is a test account, like the ones above.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button id="admin-test-accounts-phone-submit" type="button" className={AdminUI.btn.primary}
          disabled={busy || full} onClick={() => { void ask(); }}>
          {busy ? 'Getting one…' : 'Get a number and code'}
        </button>
      </div>
      {error ? <p id="admin-test-accounts-phone-error" role="alert" className={ERROR}>{error}</p> : null}
      {signIn ? <PhoneSignInResult signIn={signIn} onDone={() => setSignIn(null)} /> : null}
    </div>
  );
}

// ── The live accounts ───────────────────────────────────────────────────

function appsText(apps: LiveApp[]): string {
  return apps.map((a) => (a.status ? `${a.slug} (${a.status})` : a.slug)).join(', ');
}

function AccountRow({ account, now, busy, disabled, onRetire }: {
  account: LiveAccount; now: Date; busy: boolean; disabled: boolean; onRetire: () => void;
}) {
  const made = agoStamp(account.createdAt, { now });
  const seen = agoStamp(account.lastActiveAt, { now });
  const by = account.createdBy ? `by @${account.createdBy}` : '';
  const seenText = seen.text || 'not yet';
  return (
    <tr className={AdminUI.trHover} data-test-account={account.userId}>
      <td className={AdminUI.td}>
        {/* break-all: a placeholder handle is one 27-character word, and the
            console never scrolls sideways, so it wraps rather than pushing
            Retire out of the card at phone width. */}
        <span className="break-all font-medium text-zinc-900 dark:text-zinc-100">{`@${account.username}`}</span>
        {account.note ? <span className="block mt-0.5 break-words text-xs text-zinc-500 dark:text-zinc-400">{account.note}</span> : null}
        {/* Below md the three middle columns fold into one line here. */}
        <span className="block md:hidden mt-1 break-words text-xs text-zinc-500 dark:text-zinc-400">
          {[`Made ${made.text}${by ? ` ${by}` : ''}`, `last active ${seenText}`,
            account.apps.length ? appsText(account.apps) : 'no apps'].join(' · ')}
        </span>
      </td>
      <td className={`${AdminUI.td} hidden md:table-cell ${CELL_FINE}`}>
        <span className="block" title={made.title}>{made.text}</span>
        {by ? <span className="block">{by}</span> : null}
      </td>
      <td className={`${AdminUI.td} hidden md:table-cell ${CELL_FINE}`} title={seen.title || undefined}>
        {seen.text || 'Not yet'}
      </td>
      <td className={`${AdminUI.td} hidden md:table-cell ${CELL_FINE}`}>
        {account.apps.length ? (
          <ul className="space-y-0.5">
            {account.apps.map((app) => (
              <li key={app.slug}>
                <span className="font-mono text-zinc-700 dark:text-zinc-300">{app.slug}</span>
                {app.status ? ` · ${app.status}` : ''}
              </li>
            ))}
          </ul>
        ) : 'None'}
      </td>
      <td className={`${AdminUI.td} text-right`}>
        <button type="button" className={AdminUI.btn.destructiveSm} data-retire-test-account={account.userId}
          disabled={busy || disabled} onClick={onRetire}>
          {busy ? 'Retiring…' : 'Retire'}
        </button>
      </td>
    </tr>
  );
}

export function LiveAccounts({ state, retiring, status, onRefresh, onRetire, now = new Date(Date.now()) }: {
  state: ListState;
  retiring: number | null;
  status: Status | null;
  onRefresh: () => void;
  onRetire: (account: LiveAccount) => void;
  now?: Date;
}) {
  const ready = state.kind === 'ready' ? state : null;
  return (
    <div id="admin-test-accounts-list" className={`${AdminUI.card} p-4`}>
      <div className={AdminUI.cardHeader}>
        <h2 className={AdminUI.cardTitle}>Live test accounts</h2>
        <div className="flex items-center gap-3">
          {ready ? (
            <span id="admin-test-accounts-count" className="text-xs text-zinc-500 dark:text-zinc-400">
              {`${ready.accounts.length} of ${ready.max} live`}
            </span>
          ) : null}
          <button id="admin-test-accounts-refresh" type="button" className={`${AdminUI.btn.link} text-xs`} onClick={onRefresh}>
            Refresh
          </button>
        </div>
      </div>
      {status ? (
        <p id="admin-test-accounts-status" role={status.tone === 'err' ? 'alert' : 'status'}
          className={status.tone === 'err' ? FAILED : DONE}>{status.text}</p>
      ) : null}
      {state.kind === 'loading' ? <p className={AdminUI.loading}>Loading…</p> : null}
      {state.kind === 'error' ? <p role="alert" className={ERROR}>{state.error}</p> : null}
      {ready && !ready.accounts.length ? (
        <p id="admin-test-accounts-empty" className={AdminUI.muted}>
          No live test accounts. One you make appears here until it is retired.
        </p>
      ) : null}
      {ready && ready.accounts.length ? (
        <div className={AdminUI.tableWrap}>
          <table id="admin-test-accounts-table" className={AdminUI.table}>
            <thead className={AdminUI.thead}>
              <tr>
                <th className={AdminUI.th}>Account</th>
                <th className={`${AdminUI.th} hidden md:table-cell`}>Made</th>
                <th className={`${AdminUI.th} hidden md:table-cell`}>Last active</th>
                <th className={`${AdminUI.th} hidden md:table-cell`}>Apps</th>
                <th className={AdminUI.th}><span className="sr-only">Retire</span></th>
              </tr>
            </thead>
            <tbody>
              {ready.accounts.map((account) => (
                <AccountRow key={account.userId} account={account} now={now}
                  busy={retiring === account.userId} disabled={retiring != null}
                  onRetire={() => onRetire(account)} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

// ── The section ─────────────────────────────────────────────────────────

export function ViewOnlyNotice() {
  return (
    <div id="admin-test-accounts-view-only" className={`${AdminUI.card} p-4`}>
      <h2 className={`${AdminUI.cardTitle} mb-1`}>Test accounts</h2>
      <p className={AdminUI.muted}>
        Making, listing and retiring test accounts needs a full admin, so there is nothing to show
        a view-only admin here.
      </p>
    </div>
  );
}

const consoleApi = () => (typeof window !== 'undefined' ? (window as any).AdminConsole : null);

function ManageTestAccounts() {
  const [list, setList] = useState<ListState>({ kind: 'loading' });
  const [retiring, setRetiring] = useState<number | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    const next = await loadLive();
    if (alive.current) setList(next);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const retire = async (account: LiveAccount) => {
    if (retiring != null) return;
    setStatus(null);
    const out = await runRetire(account, {
      confirm: (opts) => consoleApi()._confirm(opts),
      onConfirmed: () => { if (alive.current) setRetiring(account.userId); },
    });
    if (!alive.current) return;
    setRetiring(null);
    if (out.status) setStatus(out.status);
    // A refused retire may still have taken some apps down, so read again.
    if (out.confirmed) void load();
  };

  const ready = list.kind === 'ready' ? list : null;
  const max = ready ? ready.max : MAX_LIVE;
  const full = !!ready && ready.accounts.length >= ready.max;
  return (
    <div id="admin-test-accounts" className="space-y-4">
      <CreateCard full={full} max={max} onCreated={() => { void load(); }} />
      <PhoneSignInCard full={full} />
      <LiveAccounts state={list} retiring={retiring} status={status}
        onRefresh={() => { setStatus(null); void load(); }} onRetire={(a) => { void retire(a); }} />
    </div>
  );
}

export function TestAccountsSection() {
  if (!consoleApi()?.canWrite?.()) {
    return (
      <div id="admin-test-accounts" className="space-y-4">
        <ViewOnlyNotice />
      </div>
    );
  }
  return <ManageTestAccounts />;
}

let host: Element | null = null;

const AdminTestAccounts = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <TestAccountsSection />);
  },

  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminTestAccounts = AdminTestAccounts;

export { AdminTestAccounts };
