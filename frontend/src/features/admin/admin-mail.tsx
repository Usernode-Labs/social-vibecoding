'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

// The shared admin class-string registry. This was a bare global read that
// depended on <script> order (admin-console.js loaded first); inside the
// React bundle the dependency is explicit (#1082 chunk E).
import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// Email delivery section of the admin console (#admin/mail).
//
// Platform outbound mail is always-200 by contract (SPEC 1667): the OTP
// request and the waitlist join tell the user "check your email" whether
// the mail was delivered, throttled, or never had a transport to go out
// on. That is deliberate — it is what stops the endpoints being account
// oracles — but it means a broken mailer is INVISIBLE from every user
// surface. This section is the compensating visibility, and it answers
// the three questions an operator actually has, in order:
//
//   1. Is mail configured, and as whom?          (status card)
//   2. Does it work RIGHT NOW?                   (send a test)
//   3. What has it been doing?                   (activity ledger)
//
// The status and activity cards deliberately mirror the ones on
// Admin → Settings (the programme settings screen), down to the copy and
// the colours: an operator who learned to read one should not have to
// learn the other. That card is untouched; this section reads the newer
// /api/admin/mail/* routes, which add the test send and the per-kind
// filter it needs.
//
// PERMISSIONS: visible to any admin (full and view-only). The two reads
// are open to both; the test send is full-admin-only, so a view-only
// admin gets an explanatory note where the form would be. The server
// enforces that independently via requireAdminWrite — the hidden form is
// a courtesy, not the control.
//
// ── React-owned (#1120 slice 12) ──────────────────────────────────────
//
// Seventh section through the seam. Two things worth naming here.
//
// The `generation` counter is gone, and this section is the clearest case
// for why it existed: a test send legitimately takes up to ~17 seconds, so
// the window in which the operator navigates away mid-request is not
// theoretical. Every one of the four request paths checked
// `if (mine !== generation) return;` before writing. React unmounting the
// component covers that, and the one remaining `alive` ref covers the
// narrower "did THIS component go away" question rather than "does that id
// still belong to me".
//
// And the activity table re-bound its own two buttons after every repaint —
// `getElementById('admin-mail-refresh')?.addEventListener(...)` at the foot
// of `loadActivity`, because the repaint had just replaced the nodes it
// bound last time. That is the shape that leaks a listener the day someone
// repaints without re-binding, or binds twice.

interface MailStatus {
  configured?: boolean;
  stagingLogOnly?: boolean;
  provider?: string;
  from?: string;
  usingDefaultFrom?: boolean;
  suggestedRecipient?: string;
  affectedFlows?: string[];
  providers?: Array<{ name: string; label?: string; configured?: boolean; missing?: string[] }>;
  missing?: string[];
}

interface Outcome {
  status?: string;
  provider?: string;
  from?: string;
  reference?: string;
  providerMessageId?: string;
  durationMs?: number;
  error?: string;
  deliveryId?: number;
  message?: { subject?: string };
}

interface Delivery {
  id: number;
  created_at?: string;
  kind?: string;
  recipient?: string;
  provider?: string;
  status?: string;
  error?: string;
}

const canWrite = () => !!(typeof window !== 'undefined'
  && (window as any).AdminConsole && (window as any).AdminConsole.canWrite());

// Non-throwing fetch: an /api/* route that falls through to the SPA shell on
// auth loss answers 200 + HTML, and res.json() on that throws. `status: 0`
// means the request never got an answer at all, which the result panel
// reports differently from a send the platform refused.
async function fetchJson(url: string, opts?: RequestInit): Promise<{ status: number; ok: boolean; data: any }> {
  try {
    const res = await fetch(url, { credentials: 'same-origin', ...(opts || {}) });
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return { status: res.status, ok: res.ok, data: null };
    try { return { status: res.status, ok: res.ok, data: await res.json() }; } catch {
      return { status: res.status, ok: res.ok, data: null };
    }
  } catch {
    return { status: 0, ok: false, data: null };
  }
}

// Colour per delivery status. `sent` is the only unambiguously good outcome;
// `suppressed_rate_limit` is the throttle working, not a fault, so it reads
// as informational rather than red.
function statusClass(status?: string): string {
  if (status === 'sent') return 'text-emerald-700 dark:text-emerald-400';
  if (status === 'failed') return 'text-rose-700 dark:text-rose-400';
  if (status === 'suppressed_rate_limit') return 'text-amber-800 dark:text-amber-400';
  if (status === 'no_transport') return 'text-amber-800 dark:text-amber-400';
  if (status === 'skipped_staging') return 'text-sky-700 dark:text-sky-400';
  return 'text-zinc-500 dark:text-zinc-400';
}

// One plain-English sentence per outcome. The raw status is shown too — it is
// the same word the ledger uses, and an operator comparing the panel to the
// table below should see the same vocabulary in both.
function outcomeHeadline(outcome: Outcome): string {
  switch (outcome.status) {
    case 'sent': return 'Delivered to the provider. Check the inbox.';
    case 'skipped_staging': return 'Rendered to the platform log — staging never delivers mail.';
    case 'failed': return 'The provider refused the message.';
    case 'no_transport': return 'Nothing was sent — no mail transport is configured.';
    case 'suppressed_rate_limit': return 'Held back by the outbound throttle.';
    case 'invalid_recipient': return 'Nothing was sent — that address could not be used.';
    default: return 'The send finished with an unexpected result.';
  }
}

function Mono({ children }: { children: React.ReactNode }) {
  return <code className="font-mono text-xs">{children}</code>;
}

/** The sender line, shown under every shape of the status card. */
function Sender({ s }: { s: MailStatus }) {
  return (
    <div className="text-zinc-500 dark:text-zinc-400 mt-1">
      {'Sending as '}<Mono>{s.from || '(unset)'}</Mono>
      {s.usingDefaultFrom ? <> <span className="text-zinc-500 dark:text-zinc-400">(built-in default)</span></> : null}
    </div>
  );
}

/** Comma-joined `<code>` list — the `.map(...).join(', ')` the templates used. */
function CodeList({ keys }: { keys?: string[] }) {
  return (
    <>
      {(keys || []).map((k, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <span key={i}>{i ? ', ' : ''}<Mono>{k}</Mono></span>
      ))}
    </>
  );
}

function StatusCard({ status, failed }: { status: MailStatus | null; failed: boolean }) {
  if (failed) return <p className="text-sm text-zinc-500 dark:text-zinc-400">Could not load the mail configuration.</p>;
  if (!status) return <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>;

  // A staging preview is a clone of production data, so it can never reach a
  // real provider — say so plainly rather than letting a tester read a card
  // and wait for an inbox that will never fill.
  if (status.stagingLogOnly) {
    return (
      <div className="rounded-lg border border-sky-300 dark:border-sky-800 bg-sky-50 dark:bg-sky-950/40 px-4 py-3 text-sm">
        <div className="font-semibold text-sky-800 dark:text-sky-300">
          Staging preview — email is rendered to the log, never delivered
        </div>
        <p className="text-sky-800/80 dark:text-sky-300/80 mt-1">
          {'This preview holds a clone of production data, so it must not mail real people. Login codes and links appear in the platform log ('}
          <Mono>platform-mail</Mono>
          {') so you can complete a flow by hand. A test send here checks the plumbing up to the transport and stops there.'}
        </p>
        <Sender s={status} />
      </div>
    );
  }

  if (status.configured) {
    return (
      <div className={`${AdminUI.card} px-4 py-3 text-sm`}>
        <span className="font-semibold text-emerald-700 dark:text-emerald-400">Email is configured</span>
        <span className="text-zinc-500 dark:text-zinc-400">
          {' — login codes and waitlist confirmations are being sent via '}
          <span className="font-medium">{status.provider || 'unknown'}</span>{'.'}
        </span>
        <Sender s={status} />
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-4 py-3 text-sm">
      <div className="font-semibold text-amber-800 dark:text-amber-300">
        Email is not deliverable — no mail sender configured
      </div>
      <p className="text-amber-800/80 dark:text-amber-300/80 mt-1">
        These flows still report success to the user but deliver nothing:
      </p>
      <ul className="list-disc ml-5 mt-1 text-amber-800/80 dark:text-amber-300/80">
        {/* eslint-disable-next-line react/no-array-index-key */}
        {(status.affectedFlows || []).map((f, i) => <li key={i}>{f}</li>)}
      </ul>
      <p className="text-amber-800/80 dark:text-amber-300/80 mt-2">Providers:</p>
      {/* Per-provider readiness, so the card says which provider needs what
          instead of a flat "mail is broken". */}
      <ul className="list-disc ml-5 mt-1 text-amber-800/80 dark:text-amber-300/80">
        {(status.providers || []).map((p) => (
          <li key={p.name}>
            {`${p.label || p.name} — `}
            {p.configured
              ? <span className="text-emerald-700 dark:text-emerald-400">ready</span>
              : <>{'needs '}<CodeList keys={p.missing} /></>}
          </li>
        ))}
      </ul>
      <p className="text-amber-800/80 dark:text-amber-300/80 mt-2">
        {'Set '}<CodeList keys={status.missing} />
        {' in the platform’s Platform variables panel, then redeploy. The mailbox behind those credentials must also be authorised to send as '}
        <Mono>{status.from || ''}</Mono>{'.'}
      </p>
    </div>
  );
}

function OutcomeRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="text-zinc-500 dark:text-zinc-400 w-24 shrink-0">{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

function OutcomePanel({ outcome }: { outcome: Outcome }) {
  const subject = outcome.message && outcome.message.subject;
  return (
    <div className={`${AdminUI.card} px-4 py-3 text-sm mt-3`}>
      <div className="font-semibold mb-2">{outcomeHeadline(outcome)}</div>
      <div className="space-y-1">
        <OutcomeRow label="Status">
          <span className={`font-medium ${statusClass(outcome.status)}`}>{outcome.status}</span>
        </OutcomeRow>
        <OutcomeRow label="Provider">{outcome.provider || '—'}</OutcomeRow>
        <OutcomeRow label="Sent as"><Mono>{outcome.from || '(unset)'}</Mono></OutcomeRow>
        {outcome.reference ? <OutcomeRow label="Reference"><Mono>{outcome.reference}</Mono></OutcomeRow> : null}
        {outcome.providerMessageId
          ? <OutcomeRow label="Provider id"><Mono>{outcome.providerMessageId}</Mono></OutcomeRow>
          : null}
        {Number.isFinite(outcome.durationMs as number)
          ? <OutcomeRow label="Took">{`${outcome.durationMs} ms`}</OutcomeRow>
          : null}
        {outcome.error ? <OutcomeRow label="Detail">{outcome.error}</OutcomeRow> : null}
      </div>
      {subject ? <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-2">{`Subject: ${subject}`}</div> : null}
    </div>
  );
}

/**
 * Distinct from every mail outcome: the platform never answered, so we cannot
 * say whether anything was attempted. Saying "failed" here would be a claim
 * about the mailer we have no evidence for.
 */
function TransportError() {
  return (
    <div className="rounded-lg border border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/40 px-4 py-3 text-sm mt-3">
      <div className="font-semibold text-rose-800 dark:text-rose-300">Could not reach the platform</div>
      <p className="text-rose-800/80 dark:text-rose-300/80 mt-1">
        The request did not get a reply, so whether the email was attempted is
        unknown. Check the activity table below before sending again.
      </p>
    </div>
  );
}

const CHIP_BTN = 'rounded-lg border border-zinc-300 dark:border-zinc-700 px-2 py-1 text-xs';
const TH = 'text-left font-medium pb-1 pr-3';

function ActivityCard({
  data, failed, kindFilter, onToggleFilter, onRefresh, highlightId,
}: {
  data: { deliveries?: Delivery[]; last24h?: Record<string, number> } | null;
  failed: boolean; kindFilter: string | null; highlightId: number | null;
  onToggleFilter: () => void; onRefresh: () => void;
}) {
  if (failed) return <p className="text-sm text-zinc-500 dark:text-zinc-400">Could not load recent activity.</p>;
  if (!data) return <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>;
  const deliveries = data.deliveries || [];
  const last24h = data.last24h || {};
  const totals = Object.keys(last24h).sort().map((k) => `${k} ${last24h[k]}`).join(' · ');
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">Recent email activity</h3>
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            {totals ? `last 24h: ${totals}` : 'nothing in the last 24h'}
          </span>
          <button id="admin-mail-filter" type="button" className={CHIP_BTN} onClick={onToggleFilter}>
            {kindFilter ? 'Show all mail' : 'Test emails only'}
          </button>
          <button id="admin-mail-refresh" type="button" className={CHIP_BTN} onClick={onRefresh}>Refresh</button>
        </div>
      </div>
      {deliveries.length ? (
        <div className="overflow-x-auto mt-2">
          <table className="w-full text-xs">
            <thead className="text-zinc-500 dark:text-zinc-400">
              <tr>
                <th className={TH}>When</th>
                <th className={TH}>Kind</th>
                <th className={TH}>Recipient</th>
                <th className={TH}>Provider</th>
                <th className={TH}>Status</th>
                <th className="text-left font-medium pb-1">Detail</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((r) => (
                <tr key={r.id}
                  className={`border-t border-zinc-100 dark:border-zinc-800${
                    highlightId && r.id === highlightId ? ' bg-violet-50 dark:bg-violet-950/40' : ''}`}>
                  <td className="py-1.5 pr-3 whitespace-nowrap text-zinc-500 dark:text-zinc-400">
                    {r.created_at ? String(r.created_at).replace('T', ' ').slice(0, 19) : ''}
                  </td>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{r.kind || ''}</td>
                  <td className="py-1.5 pr-3">{r.recipient || ''}</td>
                  <td className="py-1.5 pr-3 whitespace-nowrap text-zinc-500 dark:text-zinc-400">{r.provider || '—'}</td>
                  <td className={`py-1.5 pr-3 whitespace-nowrap font-medium ${statusClass(r.status)}`}>{r.status || ''}</td>
                  <td className="py-1.5 text-zinc-500 dark:text-zinc-400">{r.error || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-2">
          {kindFilter ? 'No test emails have been sent yet.' : 'No mail has been attempted yet.'}
        </p>
      )}
    </div>
  );
}

type Result =
  | { kind: 'none' }
  | { kind: 'note'; text: string; bad?: boolean }
  | { kind: 'outcome'; outcome: Outcome }
  | { kind: 'transport' };

function MailSection() {
  const write = canWrite();
  const [status, setStatus] = useState<MailStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [activity, setActivity] = useState<any>(null);
  const [activityFailed, setActivityFailed] = useState(false);
  const [kindFilter, setKindFilter] = useState<string | null>(null);
  // Ledger id of the row the last test produced, so it can be pointed at in
  // the table below rather than described in prose.
  const [highlightId, setHighlightId] = useState<number | null>(null);
  const [to, setTo] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<Result>({ kind: 'none' });
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const loadActivity = useCallback(async (filter: string | null) => {
    const url = `/api/admin/mail/activity?limit=25${filter ? `&kind=${encodeURIComponent(filter)}` : ''}`;
    const { ok, data } = await fetchJson(url);
    if (!alive.current) return;
    if (!ok || !data) { setActivityFailed(true); return; }
    setActivityFailed(false);
    setActivity(data);
  }, []);

  useEffect(() => {
    (async () => {
      const { ok, data } = await fetchJson('/api/admin/mail/status');
      if (!alive.current) return;
      if (!ok || !data) { setStatusFailed(true); return; }
      setStatus(data);
      // Pre-fill the test form with the admin's own address, once the status
      // answers. Never overwrite something already typed.
      if (data.suggestedRecipient) setTo((prev) => prev || data.suggestedRecipient);
    })();
  }, []);

  useEffect(() => { loadActivity(kindFilter); }, [kindFilter, loadActivity]);

  const sendTest = async () => {
    if (sending) return;
    const addr = to.trim();
    if (!addr) { setResult({ kind: 'note', text: 'Enter an email address first.', bad: true }); return; }
    setSending(true);
    setHighlightId(null);
    // A send can legitimately take a while: the transports allow 8s per
    // attempt and retry once, so the honest worst case is ~17 seconds. Say
    // so, rather than letting a patient operator think it hung.
    setResult({ kind: 'note', text: 'Sending… this can take up to about 17 seconds if the provider is slow.' });

    const res = await fetchJson('/api/admin/mail/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: addr }),
    });
    if (!alive.current) return;
    setSending(false);

    if (res.status === 0) { setResult({ kind: 'transport' }); return; }
    if (!res.ok || !res.data) {
      setResult({
        kind: 'note',
        text: (res.data && res.data.error) || 'The platform refused the request.',
        bad: true,
      });
      return;
    }
    const outcome: Outcome = res.data.outcome || {};
    setHighlightId(outcome.deliveryId || null);
    setResult({ kind: 'outcome', outcome });
    // The new ledger row is the durable half of the answer — pull it in
    // straight away so the panel and the table agree.
    loadActivity(kindFilter);
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <h2 className={AdminUI.cardTitle}>Email delivery</h2>
      </div>
      <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
        Login codes and waitlist mail are sent on always-200 endpoints, so a user
        is told “check your email” whether or not anything went out.
        This is where that becomes visible.
      </p>
      <div id="admin-mail-status" className="mb-4">
        <StatusCard status={status} failed={statusFailed} />
      </div>
      <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-3 mb-4">
        <h3 className="text-sm font-semibold mb-2">Send a test email</h3>
        {write ? (
          <>
            <div className="flex flex-wrap items-end gap-2">
              <label className="block text-xs grow max-w-md">
                <span className="text-zinc-500 dark:text-zinc-400">Recipient</span>
                <input id="admin-mail-to" type="email" autoComplete="off" spellCheck={false}
                  placeholder="you@example.com"
                  className="mt-1 w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-1.5 text-sm"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); sendTest(); } }} />
              </label>
              <button id="admin-mail-send" type="button" className={AdminUI.btn.primary}
                disabled={sending} onClick={sendTest}>
                {sending ? 'Sending…' : 'Send test email'}
              </button>
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-2">
              Sends one message through the configured provider and reports exactly what
              happened — unlike the flows this checks, which always report success. Up to
              10 per hour, and no more than one to the same address every 30 seconds.
            </p>
          </>
        ) : (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Sending a test email needs full admin access. The configuration and the
            delivery history above and below are readable by any admin.
          </p>
        )}
        <div id="admin-mail-result">
          {result.kind === 'outcome' ? <OutcomePanel outcome={result.outcome} /> : null}
          {result.kind === 'transport' ? <TransportError /> : null}
          {result.kind === 'note' ? (
            <p className={`text-sm mt-3 ${result.bad ? 'text-rose-600 dark:text-rose-400' : 'text-zinc-500 dark:text-zinc-400'}`}>
              {result.text}
            </p>
          ) : null}
        </div>
      </div>
      <div id="admin-mail-activity">
        <ActivityCard
          data={activity} failed={activityFailed} kindFilter={kindFilter} highlightId={highlightId}
          onToggleFilter={() => setKindFilter((k) => (k ? null : 'admin_test'))}
          onRefresh={() => loadActivity(kindFilter)}
        />
      </div>
    </div>
  );
}

let host: Element | null = null;

const AdminMail = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <MailSection />);
  },

  // No timers to clear — nothing here polls. Dropping the portal is the
  // teardown: any in-flight status/activity/test response resolves into a
  // no-op instead of writing into the next section's host element.
  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminMail = AdminMail;

export { AdminMail };
