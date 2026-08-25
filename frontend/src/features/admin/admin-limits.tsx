'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// Spend limits (#admin/limits) — the platform's LLM budget dials, plus the
// Anthropic credit balance the remaining-credit figure is derived from.
//
// PERMISSIONS: visible to any admin; every field and both Save buttons are
// gated on AdminConsole.canWrite() (canAdminWrite). The server enforces the
// same on PUT /api/admin/limits and PUT /api/admin/anthropic-credits.
//
// ── Sixth section out of the chassis (#1120 slice 21) ─────────────────
//
// `centsToDollars` and `parseDollarsToCents` stay on AdminConsole rather than
// moving here: the Users section still uses both for its per-user cap
// override, and it is still in the chassis. They come back here when it
// leaves — until then this module reads them off the global exactly as it
// reads `fetchJson` and `canWrite`.
//
// The two status lines were `<p>`s whose className was REASSIGNED on every
// write — `status.className = 'text-xs mt-2 text-red-400'` — so the base
// classes were repeated at each of the six call sites and a seventh would
// have had to remember them. They are one `{ text, tone }` value each now.
// The limits one keeps its 2s auto-hide, and the timer is cleared on unmount
// rather than left to fire into a section the operator has left.

type Tone = 'ok' | 'err';

interface Status { text: string; tone: Tone }

const TONE_CLASS: Record<Tone, string> = {
  // Two different greens, preserved: the credits line has always been
  // emerald and the limits line green-500.
  ok: '',
  err: 'text-red-400',
};

const LABEL = 'text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400';
const MONEY_INPUT = `${AdminUI.input} pl-6 font-mono disabled:opacity-60`;

/** A `$`-prefixed money field. */
function MoneyField({ id, label, title, placeholder, value, onChange, disabled }: {
  id: string; label: string; title?: string; placeholder: string;
  value: string; onChange: (v: string) => void; disabled: boolean;
}) {
  return (
    <label className="block">
      <span className={LABEL} title={title}>{label}</span>
      <div className="relative mt-1">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-zinc-500 dark:text-zinc-400 pointer-events-none">$</span>
        <input id={id} type="number" min="0" step="0.01" inputMode="decimal" disabled={disabled}
          className={MONEY_INPUT} placeholder={placeholder}
          value={value} onChange={(e) => onChange(e.target.value)} />
      </div>
    </label>
  );
}

function StatusLine({ id, status, okClass }: { id: string; status: Status | null; okClass: string }) {
  return (
    <p id={id} className={status
      ? `text-xs mt-2 ${status.tone === 'err' ? TONE_CLASS.err : okClass}`
      : 'text-xs mt-2 hidden'}>
      {status ? status.text : ''}
    </p>
  );
}

function LimitsSection() {
  const console_ = () => (window as any).AdminConsole;
  const canWrite = !!console_()?.canWrite();
  const dis = !canWrite;

  const [user, setUser] = useState('');
  const [global, setGlobal] = useState('');
  const [system, setSystem] = useState('');
  const [limitsStatus, setLimitsStatus] = useState<Status | null>(null);

  const [balance, setBalance] = useState('');
  const [asOf, setAsOf] = useState('');
  const [derived, setDerived] = useState('');
  const [creditsStatus, setCreditsStatus] = useState<Status | null>(null);

  const alive = useRef(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    alive.current = false;
    if (hideTimer.current) clearTimeout(hideTimer.current);
  }, []);

  const fillLimits = useCallback((data: any) => {
    setUser(console_().centsToDollars(data.user_daily_limit_cents));
    setGlobal(console_().centsToDollars(data.global_daily_limit_cents));
    setSystem(console_().centsToDollars(data.system_tokens_daily_limit_cents));
  }, []);

  // Echo the derived figure back here, so an admin can confirm the admin key
  // is actually working. This is the only place it shows.
  const fillCredits = useCallback((data: any) => {
    if (data.configured) {
      setBalance(console_().centsToDollars(data.balanceCents));
      setAsOf(data.asOf || '');
    }
    if (!data.configured) {
      setDerived('Nothing recorded yet. No remaining-credit figure is being tracked.');
    } else if (typeof data.remainingCents !== 'number') {
      setDerived(`Couldn’t reach Anthropic to compute the remaining credit${
        data.error ? ` (${data.error})` : ''}.`);
    } else {
      const src = data.source === 'anthropic'
        ? 'from Anthropic’s billed cost report'
        : 'estimated from platform spend records (no ANTHROPIC_ADMIN_KEY configured)';
      setDerived(`$${console_().centsToDollars(data.remainingCents)} remaining: `
        + `$${console_().centsToDollars(data.spentCents)} spent since ${data.asOf}, ${src}.`
        + (data.stale ? ' Showing a cached figure; the last refresh failed.' : ''));
    }
  }, []);

  useEffect(() => {
    (async () => {
      const { data } = await console_().fetchJson('/api/admin/limits');
      if (alive.current && data && typeof data === 'object') fillLimits(data);
    })();
    (async () => {
      const { data } = await console_().fetchJson('/api/admin/anthropic-credits');
      if (alive.current && data && typeof data === 'object') fillCredits(data);
    })();
  }, [fillLimits, fillCredits]);

  const saveLimits = async () => {
    setLimitsStatus(null);
    const body: Record<string, number> = {};
    try {
      const u = console_().parseDollarsToCents('Default per-user', user.trim());
      const g = console_().parseDollarsToCents('Global', global.trim());
      const s = console_().parseDollarsToCents('System tokens', system.trim());
      if (u !== null) body.user = u;
      if (g !== null) body.global = g;
      if (s !== null) body.system = s;
      if (!Object.keys(body).length) throw new Error('Provide at least one value.');
    } catch (err: any) {
      setLimitsStatus({ text: err.message, tone: 'err' });
      return;
    }
    try {
      const res = await fetch('/api/admin/limits', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (!alive.current) return;
      fillLimits(data);
      setLimitsStatus({ text: 'Saved.', tone: 'ok' });
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setLimitsStatus(null), 2000);
    } catch (err: any) {
      if (alive.current) setLimitsStatus({ text: `Save failed: ${err.message}`, tone: 'err' });
    }
  };

  const saveCredits = async () => {
    setCreditsStatus(null);
    let body: any;
    try {
      const cents = console_().parseDollarsToCents('Credit balance', balance.trim());
      const when = asOf.trim();
      if (cents === null) throw new Error('Enter the credit balance.');
      if (!when) throw new Error('Enter the date that balance was correct.');
      body = { balanceCents: cents, asOf: when };
    } catch (err: any) {
      setCreditsStatus({ text: err.message, tone: 'err' });
      return;
    }
    try {
      const res = await fetch('/api/admin/anthropic-credits', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Save failed (${res.status})`);
      if (!alive.current) return;
      fillCredits(data);
      setCreditsStatus({ text: 'Saved.', tone: 'ok' });
    } catch (err: any) {
      if (alive.current) setCreditsStatus({ text: err.message, tone: 'err' });
    }
  };

  return (
    <>
      <div className={`${AdminUI.card} p-4`}>
        <div className="flex items-center justify-between mb-3">
          <h2 className={AdminUI.cardTitle}>LLM Spend Limits</h2>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">USD · resets midnight UTC</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
          <MoneyField id="admin-limit-user" label="Default per-user daily cap" placeholder="25.00"
            value={user} onChange={setUser} disabled={dis} />
          <MoneyField id="admin-limit-global" label="Global daily cap" placeholder="200.00"
            value={global} onChange={setGlobal} disabled={dis} />
          <MoneyField id="admin-limit-system" label="System tokens daily cap" placeholder="25.00"
            title="Funds platform-driven merge-conflict / sync-with-main resolution turns"
            value={system} onChange={setSystem} disabled={dis} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Per-user overrides live in the Users section; these are the platform defaults.
          </p>
          {canWrite ? (
            <button id="admin-save-limits-btn" type="button" className={AdminUI.btn.primary}
              onClick={saveLimits}>Save</button>
          ) : null}
        </div>
        <StatusLine id="admin-limits-status" status={limitsStatus} okClass="text-green-800 dark:text-green-400" />
      </div>

      {/* Anthropic credits (#555). Anthropic's API publishes billed spend,
          never a balance, so the remaining figure is derived: the balance
          recorded here minus cost_report spend since the as-of date.
          Re-record both after every top-up. View-only admins see the values,
          disabled.

          This is the ONLY surface for the figure — the drawer's status pane
          carried a matching row until it was removed for reading "Not set up"
          indefinitely. */}
      <div className={`${AdminUI.card} p-4 mt-4`}>
        <div className="flex items-center justify-between mb-3">
          <h2 className={AdminUI.cardTitle}>Anthropic credits</h2>
        </div>
        <p className={`${AdminUI.muted} mb-3`}>
          Anthropic doesn’t publish a remaining-credit figure, only what it has
          billed. Record the balance and the date it was correct, and the platform
          subtracts billed spend since then. Re-record both after every top-up.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
          <MoneyField id="admin-credit-balance" label="Credit balance" placeholder="5000.00"
            value={balance} onChange={setBalance} disabled={dis} />
          <label className="block">
            <span className={LABEL} title="The date that balance was correct">As of</span>
            <input id="admin-credit-as-of" type="date" disabled={dis}
              className={`${AdminUI.input} mt-1 font-mono disabled:opacity-60`}
              value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </label>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p id="admin-credit-derived" className="text-xs text-zinc-500 dark:text-zinc-400">{derived}</p>
          {canWrite ? (
            <button id="admin-save-credits-btn" type="button" className={AdminUI.btn.primary}
              onClick={saveCredits}>Save</button>
          ) : null}
        </div>
        <StatusLine id="admin-credits-status" status={creditsStatus} okClass="text-emerald-700 dark:text-emerald-400" />
      </div>
    </>
  );
}

let host: Element | null = null;

const AdminLimits = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <LimitsSection />);
  },

  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminLimits = AdminLimits;

export { AdminLimits };
