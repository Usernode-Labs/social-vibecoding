'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { AdminUI } from './admin-console.js';
import { requestBenchLaunch } from './admin-homeroom-bench';
import type { BenchRequest } from './admin-homeroom-bench';
import { EFFORTS, armOf, parseArm } from './bench-arms';

// Homeroom bot → Configurations (#admin/homeroom-bot/configs). It was a
// section of its own, #admin/bot-configs, which still opens this tab.
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
// confirmation, and set the scope's weekly side-build budget. A version is
// copied into a NEW SIDE VERSION here (its models, reasoning effort and
// clock per stage; its reviewer, pack and tweaks as they are), which only
// builds beside live builds until somebody makes it current from its row;
// the connector's save_bot_config writes any recipe. Each row also shows the
// version's own benchmark runs (a studio arm, `config:<id>`), and "Compare
// on the benchmark" opens the Benchmark tab's launch for it beside the
// current version, where nothing launches until a person presses Launch.

type Role = 'current' | 'side' | 'retired';
export type Scope = 'first_version' | 'later';

const SCOPES: Array<{ scope: Scope; label: string }> = [
  { scope: 'first_version', label: 'First versions' },
  { scope: 'later', label: 'Later changes' },
];

// The stages a recipe decides (services/bot-configs.js): triage, plan and
// build in both scopes, and a later change's follow-ups (replies on its
// proposal and fixes of its checks).
export type RecipeStage = 'triage' | 'spec' | 'build' | 'followup';
export const RECIPE_STAGES: { key: RecipeStage; label: string }[] = [
  { key: 'triage', label: 'Triage' },
  { key: 'spec', label: 'Plan' },
  { key: 'build', label: 'Build' },
  { key: 'followup', label: 'Follow-ups and check fixes' },
];
// bot-configs.js EFFORTS (bench-arms.ts); blank is the deployment's own.
export { EFFORTS };
export const MAX_CLOCK_MINUTES = 180;

export interface Recipe {
  models: { triage: string; spec: string; build: string; followup?: string };
  reviewer: { model: string; maxRounds: number; budgetMinutes: number } | null;
  pack: number | null;
  // Build-speed tweaks (services/bot-configs.js TWEAKS); recipeLine names them.
  tweaks?: string[];
  // Per stage, where it names one: the reasoning effort, and the clock in minutes.
  effort?: Partial<Record<RecipeStage, string>>;
  clocks?: Partial<Record<RecipeStage, number>>;
}

/** The stages a scope's recipe decides. Pure. */
export function stagesOf(scope: Scope): { key: RecipeStage; label: string }[] {
  return scope === 'later' ? RECIPE_STAGES : RECIPE_STAGES.filter((st) => st.key !== 'followup');
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
    // Builds the platform failed (a side build's infra failure, a live one a
    // restart failed): left out of builds and the build rate on both sides.
    platformFailures?: number;
    // A later change's current version: what became of its live builds' proposals.
    proposals?: { merged: number; closed: number; open: number; none: number };
    avgCostUsd: number | null;
    medianActiveMs: number | null;
    bootRate: number | null;
    pairsWaiting: number;
    vsCurrent: VsCurrent | null;
    // Its own benchmark runs as a studio arm (bot-configs.js benchOfVersions).
    bench?: BenchOfVersion | null;
  };
}

export interface BenchOfVersion {
  runs: number;
  trials: number;
  ok: number;
  avgCostUsd: number | null;
  medianMs: number | null;
  lastRunId: number | null;
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

/** "2 runs: 9 of 10 built, $1.10, 18 min", or '' for none. Pure. */
export function benchText(b: BenchOfVersion | null | undefined): string {
  if (!b || !b.trials) return '';
  const parts = [`${b.ok} of ${b.trials} built`];
  if (b.avgCostUsd != null) parts.push(usd(b.avgCostUsd));
  if (b.medianMs != null) parts.push(minutes(b.medianMs));
  return `${b.runs} run${b.runs === 1 ? '' : 's'}: ${parts.join(', ')}`;
}

// ── A new side version, from a copy of one ─────────────────────────────────

/** The form's fields: a model per stage, and an effort and clock per stage ('' is the default). */
export interface Draft {
  scope: Scope;
  label: string;
  models: Record<RecipeStage, string>;
  effort: Record<RecipeStage, string>;
  clocks: Record<RecipeStage, string>;
  // Carried over from the version it was copied from, as they are.
  base: Pick<Recipe, 'reviewer' | 'pack' | 'tweaks'>;
  from: string;
}

/**
 * A draft copied from `v`, with `change` (a stage and its model) applied:
 * the Benchmark's Use for, whose model may be an arm at an effort
 * (`vendor/model@max`, bench-arms.ts), which sets that stage's effort too. Pure.
 */
export function draftFrom(v: BotConfigVersion, change: { stage: RecipeStage; model: string } | null = null): Draft {
  const r = v.recipe;
  const scope: Scope = v.scope === 'later' ? 'later' : 'first_version';
  const each = (fn: (st: RecipeStage) => string) => Object.fromEntries(RECIPE_STAGES.map((st) => [st.key, fn(st.key)])) as Record<RecipeStage, string>;
  const arm = change ? parseArm(change.model) : null;
  const draft: Draft = {
    scope,
    label: change && arm ? `${v.label}, ${change.stage} on ${arm.model.split('/').pop()}${arm.effort ? ` at ${arm.effort}` : ''}` : `${v.label} (copy)`,
    models: each((st) => (r.models as Record<string, string | undefined>)[st] || ''),
    effort: each((st) => r.effort?.[st] || ''),
    clocks: each((st) => (r.clocks?.[st] ? String(r.clocks[st]) : '')),
    base: { reviewer: r.reviewer, pack: r.pack, ...(r.tweaks?.length ? { tweaks: r.tweaks } : {}) },
    from: `${v.label} v${v.version}`,
  };
  if (change && arm && (scope === 'later' || change.stage !== 'followup')) {
    draft.models[change.stage] = arm.model;
    if (arm.effort) draft.effort[change.stage] = arm.effort;
  }
  return draft;
}

/** The recipe a draft saves, or the first thing wrong with it. Pure. */
export function recipeOfDraft(d: Draft): { recipe: Recipe | null; error: string | null } {
  const stages = stagesOf(d.scope);
  const models: Recipe['models'] = { triage: '', spec: '', build: '' };
  const effort: Partial<Record<RecipeStage, string>> = {};
  const clocks: Partial<Record<RecipeStage, number>> = {};
  for (const st of stages) {
    const id = String(d.models[st.key] || '').trim();
    if (st.key === 'followup') {
      if (id) models.followup = id;
    } else if (!id) {
      return { recipe: null, error: `${st.label}: name a model (vendor/model).` };
    } else {
      models[st.key as 'triage' | 'spec' | 'build'] = id;
    }
    if (d.effort[st.key]) effort[st.key] = d.effort[st.key];
    const raw = String(d.clocks[st.key] || '').trim();
    if (raw) {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > MAX_CLOCK_MINUTES) {
        return { recipe: null, error: `${st.label}: a clock is a whole number of minutes from 1 to ${MAX_CLOCK_MINUTES}, or blank for the default.` };
      }
      clocks[st.key] = n;
    }
  }
  if (!d.label.trim()) return { recipe: null, error: 'Give the version a name.' };
  return {
    recipe: {
      models, ...d.base,
      ...(Object.keys(effort).length ? { effort } : {}),
      ...(Object.keys(clocks).length ? { clocks } : {}),
    },
    error: null,
  };
}

export function DraftForm({ draft, busy, onChange, onSave, onCancel }: {
  draft: Draft; busy: boolean; onChange: (d: Draft) => void; onSave: () => void; onCancel: () => void;
}) {
  const set = (part: 'models' | 'effort' | 'clocks', st: RecipeStage, value: string) => onChange({ ...draft, [part]: { ...draft[part], [st]: value } });
  const kept = [
    draft.base.reviewer ? `review ${draft.base.reviewer.model.split('/').pop()} ×${draft.base.reviewer.maxRounds} in ${draft.base.reviewer.budgetMinutes} min` : 'no review',
    draft.base.pack ? `pack ${draft.base.pack}` : '',
    draft.base.tweaks?.length ? `tweaks ${draft.base.tweaks.join(', ')}` : '',
  ].filter(Boolean).join(' · ');
  return (
    <form
      className={`${AdminUI.card} p-4 mb-3`} id="admin-bot-configs-draft"
      onSubmit={(e) => { e.preventDefault(); onSave(); }}
    >
      <div className={AdminUI.cardHeader}>
        <h3 className={AdminUI.cardTitle}>New side version</h3>
        <span className={AdminUI.cardDescription}>{`Copied from ${draft.from}`}</span>
      </div>
      <label className={AdminUI.label} htmlFor="admin-bot-configs-draft-label">Name</label>
      <input id="admin-bot-configs-draft-label" className={`${AdminUI.input} mb-3`} value={draft.label} maxLength={80}
        onChange={(e) => onChange({ ...draft, label: e.target.value })} />
      <div className={AdminUI.tableWrap}>
        <table className={`${AdminUI.table} min-w-[40rem]`}>
          <thead className={AdminUI.thead}>
            <tr>
              <th className={AdminUI.th}>Stage</th>
              <th className={AdminUI.th}>Model</th>
              <th className={AdminUI.th}>Effort</th>
              <th className={AdminUI.th}>Clock (min)</th>
            </tr>
          </thead>
          <tbody>
            {stagesOf(draft.scope).map((st) => (
              <tr key={st.key} className={AdminUI.trHover} data-draft-stage={st.key}>
                <td className={AdminUI.td}>{st.label}</td>
                <td className={AdminUI.td}>
                  <input className={`${AdminUI.input} font-mono text-xs`} value={draft.models[st.key]} spellCheck={false}
                    placeholder={st.key === 'followup' ? 'the per-stage setting' : 'vendor/model'} aria-label={`${st.label} model`}
                    onChange={(e) => set('models', st.key, e.target.value.trim())} />
                </td>
                <td className={AdminUI.td}>
                  <select className={AdminUI.select} value={draft.effort[st.key]} aria-label={`${st.label} effort`}
                    onChange={(e) => set('effort', st.key, e.target.value)}>
                    <option value="">Default</option>
                    {EFFORTS.map((x) => <option key={x} value={x}>{x}</option>)}
                  </select>
                </td>
                <td className={AdminUI.td}>
                  <input className={AdminUI.input} type="number" min="1" max={MAX_CLOCK_MINUTES} step="1" value={draft.clocks[st.key]}
                    placeholder="Default" aria-label={`${st.label} clock in minutes`}
                    onChange={(e) => set('clocks', st.key, e.target.value)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={`${AdminUI.muted} mt-2`} id="admin-bot-configs-draft-kept">
        {`Kept as they are: ${kept}. Effort max reaches Claude Code turns only; a Codex turn runs it at xhigh. A blank effort is the deployment's (an Anthropic plan at medium), and a blank clock the default. It is built beside every ${draft.scope === 'later' ? 'later change' : 'live first version'} within the side builds' weekly budget, and builds nothing live until it is made current.`}
      </p>
      <div className="flex gap-2 mt-3">
        <button type="submit" className={AdminUI.btn.primarySm} disabled={busy} id="admin-bot-configs-draft-save">Save as a side version</button>
        <button type="button" className={AdminUI.btn.outlineSm} disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/**
 * What "Compare on the benchmark" asks the Benchmark for: a first version's
 * studio arms (this version and the current one), or for a later change the
 * launcher on the stages the two run differently, in a model or in an
 * effort, with each one's arm there (`vendor/model@effort` for an effort,
 * bench-arms.ts); null when they differ only in clocks or what the bench
 * does not run (a later change is then compared by its blind pairs). Pure.
 */
export function benchRequestFor(v: BotConfigVersion, current: BotConfigVersion | null):
  | { view: 'studio'; models: string }
  | { view: 'launch'; preset: { stages: string[]; models: string[] } }
  | null {
  if (v.scope !== 'later') return { view: 'studio', models: current && current.id !== v.id ? `config:${v.id}, config:${current.id}` : `config:${v.id}` };
  if (!current || current.id === v.id) return null;
  // Each one's arm at a stage: its model, at its effort there when it names one.
  const armAt = (r: Recipe, st: RecipeStage) => {
    const model = (r.models as Record<string, string | undefined>)[st];
    return model ? armOf(model, r.effort?.[st] || null) : '';
  };
  // The benchmark's own stage for each (a follow-up's fix is its checks fix).
  const benchStage: Record<RecipeStage, string> = { triage: 'triage', spec: 'spec', build: 'build', followup: 'checks_fix' };
  const differ = RECIPE_STAGES.map((st) => st.key)
    .filter((st) => armAt(v.recipe, st) && armAt(current.recipe, st) && armAt(v.recipe, st) !== armAt(current.recipe, st));
  if (!differ.length) return null;
  const models = [...new Set(differ.flatMap((st) => [armAt(v.recipe, st), armAt(current.recipe, st)]))];
  return { view: 'launch', preset: { stages: differ.map((st) => benchStage[st]), models } };
}

/** The actions a row offers a full admin: never one that leaves no current version. */
export function actionsFor(role: Role): Array<{ role: Role; label: string }> {
  if (role === 'current') return [];
  if (role === 'side') return [{ role: 'current', label: 'Make current' }, { role: 'retired', label: 'Retire' }];
  return [{ role: 'current', label: 'Make current' }, { role: 'side', label: 'Make side' }];
}

function Row({ v, canWrite, busy, onRole, onCopy, onCompare }: {
  v: BotConfigVersion; canWrite: boolean; busy: boolean; onRole: (v: BotConfigVersion, role: Role) => void;
  onCopy?: (v: BotConfigVersion) => void; onCompare?: (v: BotConfigVersion) => void;
}) {
  const s = v.stats;
  const benched = benchText(s.bench);
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
        {s.platformFailures ? (
          <div className={`${AdminUI.muted} text-xs`} data-platform-failures={s.platformFailures}>
            {`${s.platformFailures} platform failure${s.platformFailures === 1 ? '' : 's'}, left out`}
          </div>
        ) : null}
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
      <td className={`${AdminUI.td} whitespace-nowrap`} data-bot-config-bench={v.id}>
        {benched || <span className={AdminUI.muted}>Not run</span>}
        {s.bench?.lastRunId ? <div className={`${AdminUI.muted} text-xs`}>{`Latest: studio run ${s.bench.lastRunId}`}</div> : null}
      </td>
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
        {canWrite && (onCopy || onCompare) ? (
          <div className="flex gap-2 mt-1">
            {onCopy ? (
              <button type="button" className={`${AdminUI.btn.link} text-xs`} disabled={busy} data-bot-config-action="copy"
                onClick={() => onCopy(v)}>Copy to a side version</button>
            ) : null}
            {onCompare && v.role !== 'current' ? (
              <button type="button" className={`${AdminUI.btn.link} text-xs`} disabled={busy} data-bot-config-action="compare"
                onClick={() => onCompare(v)}>Compare on the benchmark</button>
            ) : null}
          </div>
        ) : null}
      </td>
    </tr>
  );
}

export function BotConfigsView({
  payload, canWrite, busy = false, showRetired = false, onToggleRetired, onRole, error = null,
  scope = 'first_version', onScope, onBudget, onCopy, onCompare, draftForm = null,
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
  onCopy?: (v: BotConfigVersion) => void;
  onCompare?: (v: BotConfigVersion) => void;
  // The new side version's form, when one is being made.
  draftForm?: ReactNode;
}) {
  const versions = payload?.versions || [];
  const active = versions.filter((v) => v.role !== 'retired');
  const retired = versions.filter((v) => v.role === 'retired');
  const rows = showRetired ? [...active, ...retired] : active;
  const budgetInput = useRef<HTMLInputElement | null>(null);
  return (
    <div className={`${AdminUI.card} p-4`}>
      <div className={AdminUI.cardHeader}>
        <h2 className={AdminUI.cardTitle}>Configurations</h2>
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
          How the Homeroom bot handles every request that is not a first version: the current configuration decides
          its triage, its plan, its build and its follow-ups (replies on its proposal and fixes of its checks), and
          each stage&apos;s reasoning effort and clock where it names them. Side configurations are built silently
          beside each later change on the App bench lane, never shown to the person, and pairs compare the two sides&apos;
          plans and diffs. Each version is measured on its own, and its blind win rate is against the current one,
          where a tie counts half. Pairs are picked through the connector.
        </p>
      ) : (
        <p className={`${AdminUI.muted} mb-2`} id="admin-bot-configs-about">
          How the Homeroom bot builds a project&apos;s first version. The current configuration builds every live first
          version (its triage, plan, build and review, and each stage&apos;s reasoning effort and clock where it names
          them); side configurations are built silently beside it on the App bench lane, never shown to the person.
          Each version is measured on its own: average real cost, median active time (queue left out), boot rate, and
          its blind win rate against the current one, where a tie counts half. Pairs are picked through the connector.
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
      {draftForm}
      <div className={AdminUI.tableWrap}>
        <table className={`${AdminUI.table} min-w-[72rem]`} id="admin-bot-configs-table">
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
              <th className={AdminUI.th}>Benchmark</th>
              <th className={AdminUI.th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((v) => <Row key={v.id} v={v} canWrite={canWrite} busy={busy} onRole={onRole} onCopy={onCopy} onCompare={onCompare} />)}
            {payload && rows.length === 0 ? (
              <tr>
                <td className={AdminUI.td} colSpan={11} id="admin-bot-configs-empty">
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

/**
 * The Configurations tab. `onOpenBenchmark` shows the Benchmark tab (its
 * launch is handed over through requestBenchLaunch); `asked` is the
 * Benchmark's "Use for <stage>": a new side version of the later changes'
 * current one with that stage's model, opened as a draft to save or not.
 */
function BotConfigsSection({ onOpenBenchmark, asked = null }: {
  onOpenBenchmark?: () => void;
  asked?: { stage: RecipeStage; model: string; nonce: number } | null;
} = {}) {
  const console_ = () => (window as any).AdminConsole;
  const canWrite = !!console_()?.canWrite();
  const [scope, setScope] = useState<Scope>(asked ? 'later' : 'first_version');
  const [draft, setDraft] = useState<Draft | null>(null);
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

  // The Benchmark's "Use for <stage>", once the later changes' versions are here.
  const askedDone = useRef<number | null>(null);
  useEffect(() => {
    if (!asked || askedDone.current === asked.nonce) return;
    if (scope !== 'later') { setPayload(null); setScope('later'); return; }
    const current = (payload?.versions || []).find((v) => v.role === 'current');
    if (!current) return;
    askedDone.current = asked.nonce;
    setDraft(draftFrom(current, { stage: asked.stage, model: asked.model }));
  }, [asked, scope, payload]);

  const onCopy = useCallback((v: BotConfigVersion) => setDraft(draftFrom(v)), []);

  const onSaveDraft = useCallback(async () => {
    if (!draft) return;
    const { recipe, error: wrong } = recipeOfDraft(draft);
    if (!recipe) { console_()._alert(wrong); return; }
    const sure = await console_()._confirm({
      title: `Save ${draft.label} as a side version?`,
      message: `${draft.scope === 'later' ? 'It will be built silently beside every later change' : 'It will be built silently beside every live first version'}, within the side builds' weekly budget. Nothing live uses it until it is made current.`,
      confirmLabel: 'Save',
    });
    if (!sure) return;
    setBusy(true);
    try {
      const res = await fetch('/api/admin/homeroom-bot/configs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: draft.label.trim(), scope: draft.scope, recipe, role: 'side' }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        console_()._alert(body?.error || `Could not save it (HTTP ${res.status}).`);
      } else if (alive.current) {
        setDraft(null);
      }
    } catch {
      console_()._alert('Could not save it.');
    } finally {
      if (alive.current) setBusy(false);
      await load();
    }
  }, [draft, load]);

  const onCompare = useCallback((v: BotConfigVersion) => {
    const current = (payload?.versions || []).find((x) => x.role === 'current') || null;
    const request = benchRequestFor(v, current);
    if (!request) {
      console_()._alert('These two run the same models at the same efforts wherever the benchmark runs one, so it cannot tell them apart. Their blind pairs on live builds compare them.');
      return;
    }
    requestBenchLaunch(request as BenchRequest);
    onOpenBenchmark?.();
  }, [payload, onOpenBenchmark]);

  const onScope = useCallback((next: Scope) => {
    if (next === scope) return;
    setPayload(null);
    setShowRetired(false);
    setDraft(null);
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
      onCopy={canWrite ? onCopy : undefined}
      onCompare={canWrite ? onCompare : undefined}
      draftForm={draft ? (
        <DraftForm draft={draft} busy={busy} onChange={setDraft} onSave={onSaveDraft} onCancel={() => setDraft(null)} />
      ) : null}
    />
  );
}

export { BotConfigsSection };
