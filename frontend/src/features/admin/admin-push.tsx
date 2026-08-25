'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// Read-only mobile push diagnostics (#admin/push). The server deliberately
// returns operational metadata only: this module never receives an FCM token,
// encrypted registration, token hash, APNs key or service-account value.
//
// ── React-owned (#1120 slice 10) ──────────────────────────────────────
//
// Fifth section through the seam admin-e2e.tsx established. This one is a
// pure read surface — nine nested `.map(...).join('')` renderers building one
// string, assigned into two hosts — so the conversion is the most mechanical
// so far and the payoff is correspondingly narrow: the nine renderers are
// nine components, and `esc()` is gone from twenty-odd interpolations of
// server-supplied strings (installation ids, error codes, usernames).
//
// The one piece of real logic it drops is the double generation counter.
// `generation` was bumped by destroy() and `requestGeneration` by each new
// lookup, and every response checked both before writing — a hand-rolled
// "is this still the current request, in the current mount". A ref for the
// request sequence plus React's unmount covers the same two cases, and the
// second one is no longer this module's problem to remember.

interface PushRow { [key: string]: any }

function fmtTime(value: any): string {
  if (!value) return '—';
  try { return new Date(value).toLocaleString(); } catch { return String(value); }
}

function badge(status?: string): string {
  switch (status) {
    case 'sent':
    case 'registration_active':
    case 'provider_accepted':
      return AdminUI.badge.success;
    case 'pending':
    case 'sending':
    case 'provider_retrying':
    case 'provider_sending':
    case 'delivery_missing':
      return AdminUI.badge.warn;
    case 'dead':
    case 'cancelled':
    case 'registration_missing':
    case 'permission_ineligible':
    case 'session_inactive':
      return AdminUI.badge.destructive;
    default:
      return AdminUI.badge.default;
  }
}

function deliveryStatusLabel(status?: string): string {
  return status === 'sent' ? 'FCM accepted' : String(status ?? '');
}

function diagnosticClasses(severity?: string): string {
  switch (severity) {
    case 'success':
      return 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200';
    case 'error':
      return 'border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200';
    case 'warning':
      return 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200';
    default:
      return 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200';
  }
}

const MUTED_LABEL = 'text-zinc-500 dark:text-zinc-400 w-28 shrink-0';

/** `label: value` on one line, the `<dt>`/`<dd>` pair the old templates spelled inline. */
function Kv({ label, mono, children }: { label: string; mono?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className={MUTED_LABEL}>{label}</dt>
      <dd className={mono ? 'font-mono break-all' : undefined}>{children}</dd>
    </div>
  );
}

/** The inline variant — `Label: value` inside one `<div>`. */
function KvInline({ label, mono, children }: { label: string; mono?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <dt className="inline text-zinc-500 dark:text-zinc-400">{`${label}: `}</dt>
      <dd className={mono ? 'inline font-mono break-all' : 'inline'}>{children}</dd>
    </div>
  );
}

function Runtime({ runtime, deployment }: { runtime?: PushRow; deployment?: PushRow[] }) {
  const runtimeReady = !!(runtime && runtime.enabled && runtime.environment && runtime.firebaseProjectId);
  const rows = deployment || [];
  return (
    <section className={`${AdminUI.card} p-5`}>
      <div className={AdminUI.cardHeader}>
        <div>
          <h3 className={AdminUI.cardTitle}>Sender health</h3>
          <p className={AdminUI.cardDescription}>Runtime configuration and durable deployment state.</p>
        </div>
        <span className={runtimeReady ? AdminUI.badge.success : AdminUI.badge.destructive}>
          {runtimeReady ? 'configured' : 'incomplete'}
        </span>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 text-sm">
          <div className="font-medium">Running process</div>
          <dl className="mt-2 space-y-1 text-xs">
            <Kv label="Sender">{runtime?.enabled ? 'enabled' : 'disabled'}</Kv>
            <div className="flex gap-2">
              <dt className={MUTED_LABEL}>Environment</dt>
              <dd className="font-mono">{runtime?.environment || '—'}</dd>
            </div>
            <Kv label="Firebase project" mono>{runtime?.firebaseProjectId || '—'}</Kv>
          </dl>
        </div>
        {rows.length ? rows.map((row, i) => (
          // eslint-disable-next-line react/no-array-index-key
          <div key={i} className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 text-sm">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <code className="font-mono text-xs">{row.environment}</code>
              <span className={row.send_enabled ? AdminUI.badge.success : AdminUI.badge.destructive}>
                {row.send_enabled ? 'enabled' : 'disabled'}
              </span>
            </div>
            <dl className="mt-2 space-y-1 text-xs">
              <Kv label="Firebase project" mono>{row.firebase_project_id}</Kv>
              <Kv label="Active since">{fmtTime(row.send_not_before)}</Kv>
              <Kv label="State updated">{fmtTime(row.updated_at)}</Kv>
            </dl>
          </div>
        )) : <p className={`${AdminUI.muted} p-3`}>No deployment state has been recorded.</p>}
      </div>
    </section>
  );
}

function Fleet({ overview }: { overview: PushRow }) {
  const platforms = new Map<string, PushRow>((overview.registrations || []).map((row: PushRow) => [row.platform, row]));
  const activity = (overview.deliveriesLast24h || []).slice(0, 12);
  return (
    <section>
      <h3 className={`${AdminUI.sectionTitle} mb-3`}>Current registrations</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        {['ios', 'android'].map((platform) => {
          const row = platforms.get(platform) || { total: 0, eligible: 0, last_seen_at: null };
          return (
            <div key={platform} className={`${AdminUI.card} p-4`}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{platform === 'ios' ? 'iOS' : 'Android'}</span>
                <span className={Number(row.eligible) > 0 ? AdminUI.badge.success : AdminUI.badge.warn}>
                  {`${row.eligible} permission/session eligible`}
                </span>
              </div>
              <div className="text-2xl font-semibold mt-2">{row.total}</div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                {`registrations · last seen ${fmtTime(row.last_seen_at)}`}
              </div>
            </div>
          );
        })}
      </div>
      <div className={`${AdminUI.card} p-4 mt-3`}>
        <div className="font-medium mb-2">Delivery outcomes · last 24 hours</div>
        {activity.length ? (
          <ul>
            {activity.map((row: PushRow, i: number) => (
              // eslint-disable-next-line react/no-array-index-key
              <li key={i} className="flex items-start justify-between gap-3 border-b border-zinc-100 dark:border-zinc-800 py-2 last:border-0">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{row.platform}</span>
                    <span className={badge(row.status)}>{deliveryStatusLabel(row.status)}</span>
                    {row.last_error_code ? <code className="font-mono text-xs break-all">{row.last_error_code}</code> : null}
                  </div>
                  <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{`last updated ${fmtTime(row.last_updated_at)}`}</div>
                </div>
                <span className="text-sm font-semibold">{row.total}</span>
              </li>
            ))}
          </ul>
        ) : <p className={AdminUI.muted}>No delivery activity recorded.</p>}
      </div>
    </section>
  );
}

function Diagnostics({ items }: { items?: PushRow[] }) {
  return (
    <>
      {(items || []).map((item, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <div key={i} className={`rounded-lg border p-3 text-sm ${diagnosticClasses(item.severity)}`}>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold">{`${item.platform === 'ios' ? 'iOS' : 'Android'} · ${item.area}`}</span>
            <code className="font-mono text-xs">{item.code}</code>
          </div>
          <p className="mt-1">{item.message}</p>
        </div>
      ))}
    </>
  );
}

function Registrations({ rows }: { rows?: PushRow[] }) {
  if (!(rows || []).length) return <p className={AdminUI.muted}>No current device registrations.</p>;
  return (
    <>
      {(rows || []).map((row) => (
        <article key={row.id} className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 text-sm">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="font-semibold">{row.platform}</span>
              <span className={row.delivery_eligible ? AdminUI.badge.success : AdminUI.badge.destructive}>
                {row.delivery_eligible ? 'permission/session eligible' : 'inactive'}
              </span>
              <span className={badge(row.permission_status)}>{row.permission_status}</span>
            </div>
            <code className="font-mono text-xs">{`#${row.id}`}</code>
          </div>
          <dl className="mt-3 grid gap-1 text-xs">
            <KvInline label="Environment" mono>{row.environment}</KvInline>
            <KvInline label="Installation" mono>{row.installation_id}</KvInline>
            <KvInline label="Session expires">{fmtTime(row.session_expires_at)}</KvInline>
            <KvInline label="Last seen">{fmtTime(row.last_seen_at)}</KvInline>
            <KvInline label="Updated">{fmtTime(row.updated_at)}</KvInline>
          </dl>
        </article>
      ))}
    </>
  );
}

function RegistrationEvents({ events }: { events?: PushRow[] }) {
  if (!(events || []).length) {
    return <p className={AdminUI.muted}>No recent registration lifecycle events are available.</p>;
  }
  return (
    <>
      {(events || []).map((event, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <article key={i} className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 text-sm">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold">{event.platform || 'unknown'}</span>
              <span className={AdminUI.badge.secondary}>
                {String(event.eventKind || 'unknown').replace(/_/g, ' ')}
              </span>
              {event.reasonCode ? <code className="font-mono text-xs break-all">{event.reasonCode}</code> : null}
            </div>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">{fmtTime(event.createdAt)}</span>
          </div>
          <dl className="mt-2 grid gap-1 text-xs">
            <KvInline label="Environment" mono>{event.environment || 'unknown'}</KvInline>
            <KvInline label="Installation" mono>{event.installationId || 'unknown'}</KvInline>
            {event.registrationId == null ? null : (
              <div>
                <dt className="inline text-zinc-500 dark:text-zinc-400">Registration: </dt>
                <dd className="inline font-mono">{`#${event.registrationId}`}</dd>
              </div>
            )}
            {event.permissionStatus ? <KvInline label="Permission">{event.permissionStatus}</KvInline> : null}
          </dl>
        </article>
      ))}
    </>
  );
}

function Delivery({ d }: { d: PushRow }) {
  return (
    <div className="rounded-lg bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200 dark:border-zinc-800 p-3 text-xs">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-semibold">{d.platform}</span>
        <span className={badge(d.status)}>{deliveryStatusLabel(d.status)}</span>
        <span>{`${d.attempts} attempt${Number(d.attempts) === 1 ? '' : 's'}`}</span>
        {d.errorCode ? <code className="font-mono break-all">{d.errorCode}</code> : null}
      </div>
      <div className="mt-2 grid gap-1 text-zinc-500 dark:text-zinc-400">
        <span>{'Environment '}<code className="font-mono">{d.environment}</code></span>
        <span>{'Installation '}<code className="font-mono break-all">{d.installationId}</code></span>
        <span>{`Created ${fmtTime(d.createdAt)}`}</span>
        {d.sentAt ? <span>{`FCM accepted ${fmtTime(d.sentAt)}`}</span> : null}
        <span>{`Updated ${fmtTime(d.updatedAt)}`}</span>
      </div>
    </div>
  );
}

function Notifications({ items }: { items?: PushRow[] }) {
  if (!(items || []).length) return <p className={AdminUI.muted}>No recent push-capable inbox notifications.</p>;
  return (
    <>
      {(items || []).map((n) => (
        <article key={n.id} className={`${AdminUI.card} p-4`}>
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold">{n.kind}</span>
                <span className={n.pushEnabled ? AdminUI.badge.success : AdminUI.badge.warn}>
                  {`current preference: ${n.pushEnabled ? 'on' : 'off'}`}
                </span>
                <span className={AdminUI.badge.secondary}>{n.category}</span>
              </div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                {`Notification #${n.id} · ${fmtTime(n.createdAt)}`}
              </div>
            </div>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              {n.readAt ? `read ${fmtTime(n.readAt)}` : 'unread'}
            </span>
          </div>
          <div className="grid gap-2 mt-3">
            {n.deliveries.length
              // eslint-disable-next-line react/no-array-index-key
              ? n.deliveries.map((d: PushRow, i: number) => <Delivery key={i} d={d} />)
              : (
                <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-3 text-sm text-amber-900 dark:text-amber-200">
                  No retained delivery row is available for this notification.
                </div>
              )}
          </div>
        </article>
      ))}
    </>
  );
}

function UserResult({ data }: { data: PushRow }) {
  if (!data.lookup) {
    return (
      <div className={`${AdminUI.card} p-5 ${AdminUI.muted}`}>
        Search for an account to inspect its device registrations and recent deliveries.
      </div>
    );
  }
  if (!data.lookup.found || !data.user) {
    return (
      <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-4 text-sm text-amber-900 dark:text-amber-200">
        {'No account matched '}<code className="font-mono">{data.lookup.query}</code>{'.'}
      </div>
    );
  }
  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">{data.user.username}</h3>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{`User #${data.user.id}`}</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {(data.preferences || []).map((row: PushRow) => (
            <span key={row.category} className={row.enabled ? AdminUI.badge.success : AdminUI.badge.warn}>
              {`${row.category}: ${row.enabled ? 'on' : 'off'}`}
            </span>
          ))}
        </div>
      </div>
      <div className="grid gap-2 md:grid-cols-2"><Diagnostics items={data.diagnostics} /></div>
      <div>
        <h3 className={`${AdminUI.sectionTitle} mb-3`}>Current registrations</h3>
        <div className="grid gap-3 lg:grid-cols-2"><Registrations rows={data.registrations} /></div>
      </div>
      <div>
        <h3 className={`${AdminUI.sectionTitle} mb-1`}>Recent registration lifecycle</h3>
        <p className={`${AdminUI.muted} mb-3`}>
          Short-lived, best-effort debugging history. It may be incomplete, and missing events do not prove that nothing happened.
        </p>
        <div className="grid gap-3 lg:grid-cols-2"><RegistrationEvents events={data.registrationEvents || []} /></div>
      </div>
      <div>
        <h3 className={`${AdminUI.sectionTitle} mb-3`}>Recent push-capable inbox activity</h3>
        <div className="grid gap-3"><Notifications items={data.notifications} /></div>
      </div>
    </section>
  );
}

function PushSection() {
  const [query, setQuery] = useState('');
  const [data, setData] = useState<PushRow | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadingUser, setLoadingUser] = useState(false);
  const alive = useRef(true);
  // Which lookup is the current one. The old module carried TWO counters —
  // one bumped by destroy(), one by each request — and checked both before
  // writing. React's unmount covers the first case now, so only this is left.
  const seq = useRef(0);

  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async (user: string | null) => {
    const request = ++seq.current;
    setData(null);
    setFailed(false);
    setLoadingUser(!!user);
    const suffix = user ? `?user=${encodeURIComponent(user)}` : '';
    const { ok, data: payload } = await (window as any).AdminConsole
      .fetchJson(`/api/admin/mobile-push/diagnostics${suffix}`);
    if (!alive.current || request !== seq.current) return;
    setLoadingUser(false);
    if (!ok || !payload) { setFailed(true); return; }
    setData(payload);
  }, []);

  useEffect(() => { load(null); }, [load]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Push delivery</h2>
        <p className={`${AdminUI.muted} mt-1`}>
          Inspect current registrations, recent delivery records and short-lived lifecycle events.
          FCM acceptance does not confirm device receipt or notification presentation.
          Provider tokens and credentials are never shown.
        </p>
      </div>
      <div id="admin-push-overview" className="grid gap-4">
        {failed
          ? <p className="text-sm text-rose-600 dark:text-rose-400">Could not load mobile push diagnostics.</p>
          : data
            ? <><Runtime runtime={data.runtime} deployment={data.overview?.deployment} /><Fleet overview={data.overview || {}} /></>
            : <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading push deployment health…</p>}
      </div>
      <section className={`${AdminUI.card} p-5`}>
        <div className={AdminUI.cardHeader}>
          <div>
            <h3 className={AdminUI.cardTitle}>Account diagnostics</h3>
            <p className={AdminUI.cardDescription}>Exact match by username, email address or numeric user ID.</p>
          </div>
        </div>
        <form
          id="admin-push-search"
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => { e.preventDefault(); load(query.trim() || null); }}
        >
          <input id="admin-push-user" className={AdminUI.input} maxLength={255} autoComplete="off"
            placeholder="username, email or user ID"
            value={query} onChange={(e) => setQuery(e.target.value)} />
          <button type="submit" className={`${AdminUI.btn.primary} shrink-0`}>Inspect account</button>
        </form>
      </section>
      <div id="admin-push-user-result">
        {failed ? null
          : loadingUser
            ? <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading account diagnostics…</p>
            : data ? <UserResult data={data} /> : null}
      </div>
    </div>
  );
}

let host: Element | null = null;

const AdminPush = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <PushSection />);
  },

  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

if (typeof window !== 'undefined') (window as any).AdminPush = AdminPush;

export { AdminPush };
