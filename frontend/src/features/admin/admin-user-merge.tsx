'use strict';

import { useEffect, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { DetailCard, Row, fmtDate } from './admin-detail-parts.tsx';
import { fetchJson, send } from './topochain/api.ts';

// "Deduplicate user" on the Users details view (#admin/users/<id>): merge two
// accounts that belong to one person. The server does the work in one
// transaction (src/services/user-merge.js); this is the four-step form in
// front of it.
//
//   1. Pick the other account (client-side search over the /api/admin/users
//      list the section already holds; this account is never offered).
//   2. Choose which account to KEEP, with both side by side from
//      GET /api/admin/users/<id>/merge-preview.
//   3. Choose which email address the kept account ends up with.
//   4. Read what will happen, then type the exact username of the account
//      that will be anonymised. "Merge accounts" stays disabled until it
//      matches.
//
// PERMISSIONS: full admins only. The entry button renders only when
// AdminConsole.canWrite() is true, and the POST is behind requireAdminWrite
// on the server. A view-only admin never sees any of this.
//
// Nothing here renders an address as a link: emails are plain text.

export interface MergeCandidate {
  id: number;
  username: string;
  created_at?: string | null;
}

export interface MergeSummary {
  id: number;
  username: string;
  display_name: string | null;
  email: string | null;
  email_confirmed: boolean;
  created_at: string | null;
  role: 'user' | 'view_admin' | 'admin';
  has_wallet: boolean;
  providers: string[];
  apps: number;
  proposals: number;
  messages: number;
  points: number;
  merge_away_blocked: string | null;
  keep_blocked: string | null;
  references: Record<string, number>;
  reference_total: number;
}

export type EmailFrom = 'kept' | 'merged';

const console_ = () => (typeof window !== 'undefined' ? (window as any).AdminConsole : null);

/** The typed confirmation must be the anonymised account's exact username. */
export function confirmationMatches(typed: string, username: string): boolean {
  return !!username && typed === username;
}

/** Email choices worth offering: only addresses that exist. */
export function emailOptions(kept: MergeSummary, merged: MergeSummary): { value: EmailFrom; email: string; label: string }[] {
  const out: { value: EmailFrom; email: string; label: string }[] = [];
  if (kept.email) out.push({ value: 'kept', email: kept.email, label: `Keep ${kept.username}'s current email` });
  if (merged.email) out.push({ value: 'merged', email: merged.email, label: `Use ${merged.username}'s email instead` });
  return out;
}

/** Candidates for step 1: everyone but this account, matched on username or id. */
export function filterCandidates(all: MergeCandidate[], selfId: number, query: string, limit = 20): MergeCandidate[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return all
    .filter((u) => u.id !== selfId)
    .filter((u) => String(u.id) === q.replace(/^#/, '') || (u.username || '').toLowerCase().includes(q))
    .slice(0, limit);
}

const ROLE: Record<string, string> = { user: 'User', view_admin: 'View-only admin', admin: 'Admin' };

/** The "Deduplicate user" entry point. Renders nothing for a view-only admin. */
export function MergeEntryButton({ canWrite, onOpen }: { canWrite: boolean; onOpen: () => void }) {
  if (!canWrite) return null;
  return (
    <button type="button" id="admin-user-merge-btn" className={AdminUI.btn.outlineSm} onClick={onOpen}>
      Deduplicate user
    </button>
  );
}

function SummaryCard({ s, chosen, disabledReason, onChoose }: {
  s: MergeSummary; chosen: boolean; disabledReason: string | null; onChoose: () => void;
}) {
  return (
    <label className={`${AdminUI.card} block p-4 ring-1 ${chosen ? 'ring-violet-500' : 'ring-zinc-200 dark:ring-zinc-800'} ${disabledReason ? 'opacity-60' : 'cursor-pointer'}`}
      data-merge-keep={s.id}>
      <div className="flex items-start gap-3">
        <input type="radio" name="admin-user-merge-keep" className="mt-1" checked={chosen}
          disabled={!!disabledReason} onChange={onChoose} aria-label={`Keep ${s.username}`} />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-zinc-900 dark:text-zinc-100 break-words">{s.username}</p>
          <p className={AdminUI.muted}>{`User #${s.id}${s.created_at ? ` · Joined ${fmtDate(s.created_at)}` : ''}`}</p>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-zinc-500 dark:text-zinc-400">Email</dt>
            <dd className="break-all">{s.email ? `${s.email}${s.email_confirmed ? ' (confirmed)' : ' (not confirmed)'}` : 'None'}</dd>
            <dt className="text-zinc-500 dark:text-zinc-400">Role</dt><dd>{ROLE[s.role] || s.role}</dd>
            <dt className="text-zinc-500 dark:text-zinc-400">Sign-in</dt>
            <dd>{[...s.providers.map((p) => (p === 'x' ? 'X' : 'GitHub')), s.has_wallet ? 'Wallet' : null].filter(Boolean).join(', ') || 'Password or email only'}</dd>
            <dt className="text-zinc-500 dark:text-zinc-400">Activity</dt>
            <dd>{`${s.apps} apps · ${s.proposals} proposals · ${s.messages} messages · ${s.points} points`}</dd>
            <dt className="text-zinc-500 dark:text-zinc-400">Linked rows</dt><dd>{String(s.reference_total)}</dd>
          </dl>
          {disabledReason ? <p className="mt-2 text-xs text-amber-800 dark:text-amber-300">{disabledReason}</p> : null}
        </div>
      </div>
    </label>
  );
}

/**
 * Step 4, a pure render so the gating is testable: the destructive button is
 * disabled until `typed` is exactly the anonymised account's username.
 */
export function MergeConfirmStep({ kept, merged, emailFrom, typed, busy, error, onType, onBack, onMerge }: {
  kept: MergeSummary; merged: MergeSummary; emailFrom: EmailFrom; typed: string; busy: boolean;
  error: string | null; onType: (v: string) => void; onBack: () => void; onMerge: () => void;
}) {
  const ok = confirmationMatches(typed, merged.username);
  const keptEmail = emailFrom === 'merged' ? merged.email : kept.email;
  const rows = Object.entries(merged.references || {}).sort((a, b) => b[1] - a[1]);
  return (
    <div id="admin-user-merge-confirm" className="flex flex-col gap-3">
      <Row label="Account kept">{`${kept.username} (User #${kept.id})`}</Row>
      <Row label="Account anonymised" help={`Renamed to merged-${merged.id}, email replaced, personal details cleared, signed out everywhere and locked.`}>
        {`${merged.username} (User #${merged.id})`}
      </Row>
      <Row label="Email kept">{keptEmail || 'No email'}</Row>
      <Row label="Rows that will move" help="Where both accounts hold the same one-per-person record, the kept account's copy wins.">
        {`${merged.reference_total} rows in ${rows.length} tables`}
      </Row>
      {rows.length ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-zinc-600 dark:text-zinc-300">Show the tables</summary>
          <ul className="mt-2 grid gap-1 sm:grid-cols-2">
            {rows.map(([k, n]) => (
              <li key={k} className="flex justify-between gap-3"><code className="text-xs break-all">{k}</code><span>{String(n)}</span></li>
            ))}
          </ul>
        </details>
      ) : null}
      <p className="text-sm text-red-700 dark:text-red-400">This cannot be undone.</p>
      <label className={AdminUI.label} htmlFor="admin-user-merge-typed">
        {`Type ${merged.username} to confirm`}
      </label>
      <input id="admin-user-merge-typed" type="text" autoComplete="off" spellCheck={false}
        className={AdminUI.input} value={typed} onChange={(e) => onType(e.target.value)} />
      {error ? <p role="alert" id="admin-user-merge-error" className="text-sm text-red-700 dark:text-red-400">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={AdminUI.btn.outlineSm} onClick={onBack} disabled={busy}>Back</button>
        <button type="button" id="admin-user-merge-submit" className={`${AdminUI.btn.destructiveSm} disabled:opacity-50`}
          disabled={!ok || busy} onClick={onMerge}>{busy ? 'Merging…' : 'Merge accounts'}</button>
      </div>
    </div>
  );
}

type Step = 'pick' | 'keep' | 'email' | 'confirm';

/** The whole flow, shown inline on user A's details view. */
export function UserMergePanel({ user, candidates, onClose, onMerged }: {
  user: MergeCandidate;
  candidates: MergeCandidate[];
  onClose: () => void;
  onMerged: (keptId: number, message: string) => void;
}) {
  const [step, setStep] = useState<Step>('pick');
  const [query, setQuery] = useState('');
  const [other, setOther] = useState<MergeCandidate | null>(null);
  const [pair, setPair] = useState<{ user: MergeSummary; other: MergeSummary } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [keepId, setKeepId] = useState<number | null>(null);
  const [emailFrom, setEmailFrom] = useState<EmailFrom>('kept');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!other) return undefined;
    let live = true;
    setPair(null);
    setLoadError(null);
    (async () => {
      const { ok, status, data } = await fetchJson(`/api/admin/users/${user.id}/merge-preview?other=${other.id}`);
      if (!live) return;
      if (!ok || !data || !data.user) {
        setLoadError((data && data.error) || `Could not load the two accounts (HTTP ${status}).`);
        return;
      }
      setPair(data);
      // Default to keeping this account when it may be kept and the other may go.
      const a = data.user as MergeSummary;
      const b = data.other as MergeSummary;
      if (!a.keep_blocked && !b.merge_away_blocked) setKeepId(a.id);
      else if (!b.keep_blocked && !a.merge_away_blocked) setKeepId(b.id);
      else setKeepId(null);
    })();
    return () => { live = false; };
  }, [user.id, other]);

  const kept = pair && keepId != null ? (pair.user.id === keepId ? pair.user : pair.other) : null;
  const merged = pair && keepId != null ? (pair.user.id === keepId ? pair.other : pair.user) : null;
  const options = kept && merged ? emailOptions(kept, merged) : [];

  const merge = async () => {
    if (!kept || !merged || !confirmationMatches(typed, merged.username)) return;
    setBusy(true);
    setError(null);
    try {
      const { ok, status, data } = await send('POST', `/api/admin/users/${kept.id}/merge`, {
        mergeUserId: merged.id, emailFrom, confirmation: typed,
      });
      if (!ok) {
        setError((data && data.error) || `The merge failed (HTTP ${status}). Nothing was changed.`);
        return;
      }
      onMerged(kept.id, `Merged ${merged.username} into ${kept.username}. The merged account is now merged-${merged.id}.`);
    } finally {
      setBusy(false);
    }
  };

  const matches = filterCandidates(candidates, user.id, query);

  return (
    <DetailCard title="Deduplicate user" id="admin-user-merge"
      action={<button type="button" className={AdminUI.btn.ghost} onClick={onClose} disabled={busy}>Cancel</button>}>
      {step === 'pick' ? (
        <div className="flex flex-col gap-3">
          <p className={AdminUI.muted}>{`Find the other account that belongs to the same person as ${user.username}.`}</p>
          <input id="admin-user-merge-search" type="search" autoComplete="off" spellCheck={false}
            placeholder="Search by username or id" aria-label="Search for the other account"
            className={AdminUI.input} value={query} onChange={(e) => setQuery(e.target.value)} />
          {query.trim() && !matches.length ? <p className={AdminUI.muted}>No other account matches.</p> : null}
          <ul className="flex flex-col divide-y divide-zinc-100 dark:divide-zinc-800">
            {matches.map((u) => (
              <li key={u.id} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0 break-words text-sm">
                  <span className="font-medium">{u.username}</span>
                  <span className="text-zinc-500 dark:text-zinc-400">{` · User #${u.id}${u.created_at ? ` · Joined ${fmtDate(u.created_at)}` : ''}`}</span>
                </span>
                <button type="button" className={AdminUI.btn.outlineSm} data-merge-pick={u.id}
                  onClick={() => { setOther(u); setStep('keep'); }}>Choose</button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {step === 'keep' ? (
        <div className="flex flex-col gap-3">
          <p className={AdminUI.muted}>Which account should stay? The other one is anonymised and its activity moves here.</p>
          {loadError ? <p role="alert" className="text-sm text-red-700 dark:text-red-400">{loadError}</p> : null}
          {!pair && !loadError ? <p className={AdminUI.loading}>Loading…</p> : null}
          {pair ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {[pair.user, pair.other].map((s) => {
                const partner = s.id === pair.user.id ? pair.other : pair.user;
                const reason = s.keep_blocked || (partner.merge_away_blocked
                  ? `${partner.username} cannot be merged away. ${partner.merge_away_blocked}` : null);
                return <SummaryCard key={s.id} s={s} chosen={keepId === s.id} disabledReason={reason}
                  onChoose={() => setKeepId(s.id)} />;
              })}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={AdminUI.btn.outlineSm} onClick={() => { setStep('pick'); setOther(null); }}>Back</button>
            <button type="button" id="admin-user-merge-keep-next" className={AdminUI.btn.primarySm}
              disabled={!kept} onClick={() => {
                // The kept account's own address by default; the other one when it has none.
                setEmailFrom(kept && merged ? (emailOptions(kept, merged)[0]?.value || 'kept') : 'kept');
                setStep('email');
              }}>Continue</button>
          </div>
        </div>
      ) : null}

      {step === 'email' && kept && merged ? (
        <div className="flex flex-col gap-3">
          <p className={AdminUI.muted}>{`Which email address should ${kept.username} have after the merge?`}</p>
          {options.length ? options.map((o) => (
            <label key={o.value} className="flex items-start gap-2 text-sm">
              <input type="radio" name="admin-user-merge-email" className="mt-1" checked={emailFrom === o.value}
                onChange={() => setEmailFrom(o.value)} />
              <span className="min-w-0 break-all"><span className="font-medium">{o.label}</span>{`: ${o.email}`}</span>
            </label>
          )) : <p className={AdminUI.muted}>Neither account has an email address.</p>}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={AdminUI.btn.outlineSm} onClick={() => setStep('keep')}>Back</button>
            <button type="button" id="admin-user-merge-email-next" className={AdminUI.btn.primarySm}
              onClick={() => { setTyped(''); setError(null); setStep('confirm'); }}>Continue</button>
          </div>
        </div>
      ) : null}

      {step === 'confirm' && kept && merged ? (
        <MergeConfirmStep kept={kept} merged={merged} emailFrom={emailFrom} typed={typed} busy={busy}
          error={error} onType={setTyped} onBack={() => setStep('email')}
          onMerge={() => { merge().catch((err) => { setBusy(false); console_()?._alert(`Merge failed: ${err.message}`); }); }} />
      ) : null}
    </DetailCard>
  );
}
