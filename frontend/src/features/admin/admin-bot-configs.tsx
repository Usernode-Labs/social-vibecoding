'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// Bot configurations (#admin/bot-configs).
//
// How the Homeroom bot builds, as versioned recipes
// (src/services/bot-configs.js), in two scopes the switch at the top picks
// between: FIRST VERSIONS (a project's first version) and LATER CHANGES
// (every other build, live or shadow). In each, the CURRENT configuration
// builds, SIDE configurations are built silently beside it on the App bench
// lane, and each version's numbers are measured: builds, average real cost,
// median active time, boot rate, and a blind pairwise win rate against the
// current one, picked by an admin through the connector.
//
// One row per active version, the current one first, then the side ones;
// retired versions are folded away. A full admin can promote a version to
// current, make one a side configuration, or retire it, each after a
// confirmation, and set the scope's weekly side-build budget. Recipes are
// written through the connector only (save_bot_config), so a recipe is never
// typed into a form here.

type Role = 'current' | 'side' | 'retired';
export type Scope = 'first_version' | 'later';

const SCOPES: Array<{ scope: Scope; label: string }> = [
  { scope: 'first_version', label: 'First versions' },
  { scope: 'later', label: 'Later changes' },
];

interface Recipe {
  models: { triage: string; spec: string; build: string };
  reviewer: { model: string; maxRounds: number; budgetMinutes: number } | null;
  pack: number | null;
}

interface VsCurrent {
  against: number;
  wins: number;
  ties: number;
  losses: number;
  rate: number | null;
  low: number | null;
  high: number | null;
  n: number;
  excluded: number;
  didntBoot: number;
  didntBuild: number;
  // Left out with nothing captured (a restart proposed its review as it
  // stood), and the same commit on both sides (the review changed nothing).
  noScreenshots?: number;
  identical?: number;
  waiting: number;
}

export interface BotConfigVersion {
  id: number;
  key: string;
  label: string;
  version: number;
  role: Role;
  scope?: Scope;
  recipe: Recipe;
  recipeLine: string;
  notes: string | null;
  createdAt: string | null;
  stats: {
    builds: number;
    built: number;
    buildRate?: number | null;
    // A later change's current version: what became of its live builds' proposals.
    proposals?: { merged: number; closed: number; open: number; none: number };
    avgCostUsd: number | null;
    medianActiveMs: number | null;
    bootRate: number | null;
    pairsWaiting: number;
    vsCurrent: VsCurrent | null;
  };
}

export interface BotConfigsPayload {
  scope?: Scope;
  versions: BotConfigVersion[];
  currentId: number | null;
  pairsWaiting: number;
  sideBuilds: { limitUsd: number; spentUsd: number; pendingUsd: number; leftUsd: number; skipped: number; paused?: boolean } | null;
}

const ROLE_LABEL: Record<Role, string> = { current: 'Current', side: 'Side', retired: 'Retired' };
const ROLE_BADGE: Record<Role, string> = {
  current: AdminUI.badge.secondary,
  side: AdminUI.badge.default,
  retired: AdminUI.badge.outline,
};

export function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return '';
  const v = Number(n);
  return v > 0 && v < 0.01 ? '<$0.01' : `$${v.toFixed(2)}`;
}

export function minutes(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(Number(ms))) return '';
  const m = Math.round(Number(ms) / 60000);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function pct(x: number | null | undefined): string {
  return x == null || !Number.isFinite(Number(x)) ? '' : `${Math.round(Number(x) * 100)}%`;
}

/** "62% (41 to 79%), n 18", or why there is none yet. */
export function winRateText(v: VsCurrent | null | undefined, role: Role): string {
  if (role === 'current') return 'The baseline';
  if (!v || !v.n) return 'No picks yet';
  const low = v.low == null || !Number.isFinite(Number(v.low)) ? '' : String(Math.round(Number(v.low) * 100));
  return `${pct(v.rate)} (${low} to ${pct(v.high)}), n ${v.n}`;
}

/** What was left out of the picks, in words, or ''. */
export function leftOutText(v: VsCurrent | null | undefined): string {
  if (!v) return '';
  const parts = [];
  if (v.didntBuild) parts.push(`${v.didntBuild} didn't build`);
  if (v.didntBoot) parts.push(`${v.didntBoot} didn't boot`);
  if (v.noScreenshots) parts.push(`${v.noScreenshots} without screenshots`);
  if (v.identical) parts.push(`${v.identical} identical (the review changed nothing)`);
  return parts.join(', ');
}

export function budgetLine(b: BotConfigsPayload['sideBuilds'] | undefined, scope: Scope = 'first_version'): string {
  if (!b) return '';
  const givenUp = scope === 'later' ? 'a build given up or the platform\'s own repository' : 'a first version given up';
  return `Side builds in the last 7 days: ${usd(b.spentUsd) || '$0.00'} of ${usd(b.limitUsd)} spent`
    + `${b.pendingUsd > 0 ? `, about ${usd(b.pendingUsd)} more under way` : ''}`
    + `${b.skipped ? `. ${b.skipped} side build${b.skipped === 1 ? ' was' : 's were'} skipped for the budget, a missing snapshot, a platform failure or ${givenUp}` : ''}.`
    + `${b.paused ? ' Paused: the week\'s budget is spent, so side builds start again once the last 7 days\' spend is back under it.' : ''}`;
}

/** What became of a later change's live builds' proposals, in words, or ''. */
export function proposalsText(p: BotConfigVersion['stats']['proposals']): string {
  if (!p) return '';
  const parts = [];
  if (p.merged) parts.push(`${p.merged} merged`);
  if (p.closed) parts.push(`${p.closed} closed`);
  if (p.open) parts.push(`${p.open} open`);
  if (p.none) parts.push(`${p.none} not proposed`);
  return parts.length ? `Proposals: ${parts.join(', ')}` : '';
}

/** The actions a row offers a full admin: never one that leaves no current version. */
export function actionsFor(role: Role): Array<{ role: Role; label: string }> {
  if (role === 'current') return [];
  if (role === 'side') return [{ role: 'current', label: 'Make current' }, { role: 'retired', label: 'Retire' }];
  return [{ role: 'current', label: 'Make current' }, { role: 'side', label: 'Make side' }];
}

function Row({ v, canWrite, busy, onRole }: {
  v: BotConfigVersion; canWrite: boolean; busy: boolean; onRole: (v: BotConfigVersion, role: Role) => void;
}) {
  const s = v.stats;
  const left = leftOutText(s.vsCurrent);
  const proposals = proposalsText(s.proposals);
  return (
    <tr className={AdminUI.trHover} data-bot-config={v.id} data-role={v.role}>
      <td className={AdminUI.td}>
        <div className="font-medium text-zinc-900 dark:text-zinc-100">{v.label}</div>
        <div className={`${AdminUI.muted} text-xs`}>
          <span className="font-mono">{v.key}</span> v{v.version}
        </div>
      </td>
      <td className={`${AdminUI.td} whitespace-nowrap`}>
        <span className={ROLE_BADGE[v.role] || AdminUI.badge.default}>{ROLE_LABEL[v.role] || v.role}</span>
      </td>
      <td className={`${AdminUI.td} text-xs`}>{v.recipeLine}</td>
      <td className={`${AdminUI.td} whitespace-nowrap`}>
        <div>{s.builds}</div>
        {s.builds > 0 && s.buildRate != null ? <div className={`${AdminUI.muted} text-xs`}>{pct(s.buildRate)} built</div> : null}
        {proposals ? <div className={`${AdminUI.muted} text-xs`}>{proposals}</div> : null}
      </td>
      <td className={`${AdminUI.td} whitespace-nowrap`}>{usd(s.avgCostUsd) || 'None yet'}</td>
      <td className={`${AdminUI.td} whitespace-nowrap`}>{minutes(s.medianActiveMs) || 'None yet'}</td>
      <td className={`${AdminUI.td} whitespace-nowrap`}>{s.bootRate == null ? 'None yet' : pct(s.bootRate)}</td>
      <td className={AdminUI.td}>
        <div className="whitespace-nowrap">{winRateText(s.vsCurrent, v.role)}</div>
        {left ? <div className={`${AdminUI.muted} text-xs`}>{left}</div> : null}
      </td>
      <td className={`${AdminUI.td} whitespace-nowrap`}>{s.pairsWaiting}</td>
      <td className={`${AdminUI.td} whitespace-nowrap`}>
        {v.role === 'current'
          ? <span className={`${AdminUI.muted} text-xs`}>{v.scope === 'later' ? 'Builds every later change' : 'Builds every first version'}</span>
          : (canWrite ? (
            <div className="flex gap-2">
              {actionsFor(v.role).map((a) => (
                <button
                  key={a.role}
                  type="button"
                  className={a.role === 'current' ? AdminUI.btn.primarySm : AdminUI.btn.outlineSm}
                  disabled={busy}
                  data-bot-config-action={a.role}
                  onClick={() => onRole(v, a.role)}
                >{a.label}</button>
              ))}
            </div>
          ) : null)}
      </td>
    </tr>
  );
}

export function BotConfigsView({
  payload, canWrite, busy = false, showRetired = false, onToggleRetired, onRole, error = null,
  scope = 'first_version', onScope, onBudget,
}: {
  payload: BotConfigsPayload | null;
  canWrite: boolean;
  busy?: boolean;
  showRetired?: boolean;
  onToggleRetired: () => void;
  onRole: (v: BotConfigVersion, role: Role) => void;
  error?: string | null;
  scope?: Scope;
  onScope?: (scope: Scope) => void;
  onBudget?: (weeklyUsd: number) => void;
}) {
  const versions = payload?.versions || [];
  const active = versions.filter((v) => v.role !== 'retired');
  const retired = versions.filter((v) => v.role === 'retired');
  const rows = showRetired ? [...active, ...retired] : active;
  const budgetInput = useRef<HTMLInputElement | null>(null);
  return (
    <div className={`${AdminUI.card} p-4`}>
      <div className={AdminUI.cardHeader}>
        <h2 className={AdminUI.cardTitle}>Bot configurations</h2>
        <span className={AdminUI.cardDescription} id="admin-bot-configs-waiting">
          {payload ? `${payload.pairsWaiting} pair${payload.pairsWaiting === 1 ? '' : 's'} waiting for a pick` : 'Loading…'}
        </span>
      </div>
      <div className="flex gap-2 mb-3" id="admin-bot-configs-scope">
        {SCOPES.map((o) => (
          <button
            key={o.scope}
            type="button"
            className={scope === o.scope ? AdminUI.btn.primarySm : AdminUI.btn.outlineSm}
            aria-pressed={scope === o.scope}
            data-bot-config-scope={o.scope}
            onClick={() => onScope?.(o.scope)}
          >{o.label}</button>
        ))}
      </div>
      {scope === 'later' ? (
        <p className={`${AdminUI.muted} mb-2`} id="admin-bot-configs-about">
          How the Homeroom bot builds every later change, live or shadow: the current configuration&apos;s spec and
          build models. The triage and follow-up turns keep their own models. Side configurations are built silently
          beside each later change on the App bench lane, never shown to the person, and pairs compare the two sides&apos;
          specs and diffs. Each version is measured on its own, and its blind win rate is against the current one,
          where a tie counts half. Recipes are saved and pairs are picked through the connector.
        </p>
      ) : (
        <p className={`${AdminUI.muted} mb-2`} id="admin-bot-configs-about">
          How the Homeroom bot builds a project&apos;s first version. The current configuration builds every live first
          version; side configurations are built silently beside it on the App bench lane, never shown to the person.
          Each version is measured on its own: average real cost, median active time (queue left out), boot rate, and
          its blind win rate against the current one, where a tie counts half. Recipes are saved and pairs are picked
          through the connector.
        </p>
      )}
      {payload?.sideBuilds ? (
        <p className="text-sm mb-3" id="admin-bot-configs-budget">{budgetLine(payload.sideBuilds, scope)}</p>
      ) : null}
      {payload?.sideBuilds && canWrite && onBudget ? (
        <form
          className="flex items-center gap-2 mb-3"
          id="admin-bot-configs-budget-form"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number(budgetInput.current?.value);
            if (Number.isFinite(n) && n >= 0) onBudget(n);
          }}
        >
          <label className={AdminUI.label} htmlFor="admin-bot-configs-budget-input">Weekly side-build budget ($)</label>
          <div className="w-28">
            <input
              key={`${scope}-${payload.sideBuilds.limitUsd}`}
              ref={budgetInput}
              id="admin-bot-configs-budget-input"
              className={AdminUI.input}
              type="number"
              min="0"
              step="1"
              defaultValue={String(payload.sideBuilds.limitUsd)}
            />
          </div>
          <button type="submit" className={AdminUI.btn.outlineSm} disabled={busy}>Save</button>
        </form>
      ) : null}
      {error ? <p className="text-sm text-red-700 dark:text-red-300 mb-2" role="alert">{error}</p> : null}
      <div className={AdminUI.tableWrap}>
        <table className={`${AdminUI.table} min-w-[64rem]`} id="admin-bot-configs-table">
          <thead className={AdminUI.thead}>
            <tr>
              <th className={AdminUI.th}>Configuration</th>
              <th className={AdminUI.th}>Role</th>
              <th className={`${AdminUI.th} min-w-[16rem]`}>Recipe</th>
              <th className={AdminUI.th}>Builds</th>
              <th className={AdminUI.th}>Avg cost</th>
              <th className={AdminUI.th}>Median time</th>
              <th className={AdminUI.th}>Booted</th>
              <th className={AdminUI.th}>Win rate vs current</th>
              <th className={AdminUI.th}>Waiting</th>
              <th className={AdminUI.th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((v) => <Row key={v.id} v={v} canWrite={canWrite} busy={busy} onRole={onRole} />)}
            {payload && rows.length === 0 ? (
              <tr>
                <td className={AdminUI.td} colSpan={10} id="admin-bot-configs-empty">
                  No configurations yet. They are made when the platform starts.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {retired.length ? (
        <button type="button" className={`${AdminUI.btn.link} text-sm mt-3`} id="admin-bot-configs-retired" onClick={onToggleRetired}>
          {showRetired ? 'Hide retired versions' : `Show ${retired.length} retired version${retired.length === 1 ? '' : 's'}`}
        </button>
      ) : null}
    </div>
  );
}

/** What a role change is confirmed with, in words, for the version's own scope. */
export function confirmCopy(v: BotConfigVersion, role: Role, current: BotConfigVersion | null) {
  const name = `${v.label} v${v.version}`;
  const later = v.scope === 'later';
  if (role === 'current') {
    return {
      title: later ? `Build later changes with ${name}?` : `Build first versions with ${name}?`,
      message: `${later ? 'Every later change, live or shadow,' : 'Every new project\'s first version'} will be built with it (${v.recipeLine}).`
        + `${current ? ` ${current.label} v${current.version} becomes a side configuration.` : ''}`,
      confirmLabel: 'Make current',
    };
  }
  if (role === 'side') {
    return {
      title: `Make ${name} a side configuration?`,
      message: later
        ? 'It will be built silently beside every later change, within the later changes\' side builds\' weekly budget.'
        : 'It will be built silently beside every live first version, within the side builds\' weekly budget.',
      confirmLabel: 'Make side',
    };
  }
  return {
    title: `Retire ${name}?`,
    message: later
      ? 'It stops being built beside later changes. Its numbers are kept.'
      : 'It stops being built beside live first versions. Its numbers are kept.',
    confirmLabel: 'Retire',
  };
}

function BotConfigsSection() {
  const console_ = () => (window as any).AdminConsole;
  const canWrite = !!console_()?.canWrite();
  const [scope, setScope] = useState<Scope>('first_version');
  const [payload, setPayload] = useState<BotConfigsPayload | null>(null);
  const [showRetired, setShowRetired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  // The scope on screen, so a load for the one switched away from is dropped.
  const shown = useRef<Scope>(scope);
  shown.current = scope;

  const load = useCallback(async () => {
    const asked = scope;
    const { ok, data } = await console_().fetchJson(`/api/admin/homeroom-bot/configs?scope=${asked}`);
    if (!alive.current || shown.current !== asked) return;
    if (ok && data && typeof data === 'object') {
      setPayload(data as BotConfigsPayload);
      setError(null);
    } else {
      setError('Could not load the configurations.');
    }
  }, [scope]);

  useEffect(() => { load(); }, [load]);

  const onScope = useCallback((next: Scope) => {
    if (next === scope) return;
    setPayload(null);
    setShowRetired(false);
    setScope(next);
  }, [scope]);

  const onBudget = useCallback(async (weeklyUsd: number) => {
    setBusy(true);
    try {
      const res = await fetch('/api/admin/homeroom-bot/configs/budget', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, weeklyUsd }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        console_()._alert(body?.error || `Could not set the budget (HTTP ${res.status}).`);
      }
    } catch {
      console_()._alert('Could not set the budget.');
    } finally {
      if (alive.current) setBusy(false);
      await load();
    }
  }, [scope, load]);

  const onRole = useCallback(async (v: BotConfigVersion, role: Role) => {
    const current = (payload?.versions || []).find((x) => x.role === 'current') || null;
    const sure = await console_()._confirm(confirmCopy(v, role, current));
    if (!sure) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/homeroom-bot/configs/${Number(v.id)}/role`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, scope }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        console_()._alert(body?.error || `Could not change the role (HTTP ${res.status}).`);
      }
    } catch {
      console_()._alert('Could not change the role.');
    } finally {
      if (alive.current) setBusy(false);
      await load();
    }
  }, [payload, scope, load]);

  return (
    <BotConfigsView
      payload={payload}
      canWrite={canWrite}
      busy={busy}
      showRetired={showRetired}
      onToggleRetired={() => setShowRetired((x) => !x)}
      onRole={onRole}
      error={error}
      scope={scope}
      onScope={onScope}
      onBudget={onBudget}
    />
  );
}

let host: Element | null = null;

const AdminBotConfigs = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <BotConfigsSection />);
  },

  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminBotConfigs = AdminBotConfigs;

export { AdminBotConfigs };
