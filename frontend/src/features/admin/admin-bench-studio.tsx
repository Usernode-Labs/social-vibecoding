'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { AdminUI } from './admin-console.js';

// The Benchmark area's Studio place (#admin/homeroom-bot/benchmark/studio):
// the App bench studio (services/bench/studio.js) as a person reads it. The
// studio builds a brand-new app's first version from a brief the way a new
// project's is built today, on any model, with or without a context pack,
// beside reference builds a Claude Code session hands in through the admin
// connector. Most of the driving is done from that connector; this place is
// where the results are looked at side by side.
//
//   Gallery    every studio brief, with its builds across runs, newest
//              first: the arm (model and pack, or a reference's label), its
//              state and the judge's verdict, rubric criteria held, two of
//              its screenshots, its code on GitHub, and its preview. Keep,
//              Run again and Preview act on one build.
//   Runs       the studio's runs, each with what ran of it against its cap;
//              Watch shows one run's builds as they move (step, time, spend,
//              the last activity line and the skills it reached for), read
//              again every ten seconds while anything is under way.
//   Packs      the context packs, each version with its sizes, and a form
//              to save the next version of one.
//   New run    the launcher: starter briefs and a brief of your own, models
//              ("today" is the live bot's own), packs, references per brief,
//              and the cap. A cap over $100 is confirmed first.
//
// PERMISSIONS: any admin reads; every button that writes is gated on
// canWrite here and requireAdminWrite on the server (routes/bench-studio.js).

const BASE = '/api/admin/homeroom-bot/bench';
const STUDIO = `${BASE}/studio`;
const POLL_MS = 10_000;
const CONFIRM_ABOVE_USD = 100;

type Tone = 'ok' | 'err';
type Say = (text: string, tone?: Tone) => void;

export type StudioArm = { kind: 'platform' | 'reference'; model: string | null; reference: string | null; pack: { id: number; name: string | null; version: number | null } | null };
export type StudioBuild = {
  trialId: number; runId: number; taskId: number; ref: string | null; appName: string | null;
  arm: StudioArm; armLabel: string; attempt: number; status: string; step: string | null;
  startedAt: string | null; finishedAt: string | null; elapsedMs: number | null; costUsd: number | null;
  activity: string[]; skills: { invoked: string[]; read: string[] };
  built: boolean; booted: boolean | null;
  shots: { caption: string; artifactId: string }[];
  code: { branch: string; sha: string | null; treeUrl: string; compareUrl: string | null; kept: boolean } | null;
  preview: { id: number; status: string; url: string | null; path: string | null; expiresAt: string | null; error: string | null } | null;
  error: string | null; final: string; critique: string | null; criteria: { held: number; of: number } | null;
};
type StudioRun = {
  id: number; status: string; models: string[]; contextPackIds: number[]; referencesPerBrief: number;
  capUsd: number | null; spentUsd: number | null; note: string | null; startedBy: string | null; createdAt: string | null;
  counts: Record<string, number>;
};
type Pack = {
  id: number; name: string; version: number; parentId: number | null; notes: string | null; createdBy: string | null;
  guidanceChars: number; stages: string[]; files: { path: string; chars: number }[]; usedAt: string | null;
};
type Home = {
  runs: StudioRun[]; packs: Pack[]; host: { slug: string; status: string; repoUrl: string | null } | null;
  starter: { ref: string; appName: string }[];
  limits: { briefs: number; models: number; packs: number; references: number; concurrency: number; livePreviews: number; previewHours: number };
};
type Brief = { taskId: number; ref: string | null; appName: string; brief: string; builds: StudioBuild[] };
type Watch = { run: { id: number; status: string }; counts: Record<string, number>; trials: StudioBuild[] };

async function send(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── Words ───────────────────────────────────────────────────────────────

const OPEN = ['pending', 'running', 'awaiting'];

/** A run's state in words, and whether it is still under way. Pure. */
export function studioRunWords(r: Pick<StudioRun, 'status' | 'counts'>): { label: string; open: boolean; line: string } {
  const c = r.counts || {};
  const total = Object.values(c).reduce((s, n) => s + (Number(n) || 0), 0);
  const done = ['ok', 'model_fail', 'infra_fail', 'timeout'].reduce((s, k) => s + (Number(c[k]) || 0), 0);
  const moving = OPEN.reduce((s, k) => s + (Number(c[k]) || 0), 0);
  const label = { queued: 'Queued', running: 'Running', done: 'Done', capped: 'Stopped at cap', cancelled: 'Cancelled' }[r.status] || r.status;
  const parts = [`${done} of ${total} built`];
  if (c.running) parts.push(`${c.running} running`);
  if (c.awaiting) parts.push(`${c.awaiting} awaiting a reference`);
  if (c.skipped_cap) parts.push(`${c.skipped_cap} skipped at the cap`);
  return { label, open: r.status === 'queued' || r.status === 'running' || moving > 0, line: parts.join(' · ') };
}

/** "45s", "3m 20s", "1h 4m". Pure. */
export function elapsedWords(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** A build's state in a few words, and the badge it is drawn with. Pure. */
export function buildState(b: Pick<StudioBuild, 'status' | 'step' | 'final' | 'booted'>): { text: string; tone: 'success' | 'destructive' | 'warn' | 'secondary' | 'default' } {
  if (b.status === 'running') return { text: b.step ? `Running: ${b.step}` : 'Running', tone: 'secondary' };
  if (b.status === 'pending') return { text: 'Waiting', tone: 'default' };
  if (b.status === 'awaiting') return { text: 'Awaiting the reference', tone: 'default' };
  if (b.status === 'cancelled') return { text: 'Cancelled', tone: 'default' };
  if (b.status === 'ok' && b.booted === false) return { text: 'Did not boot', tone: 'destructive' };
  if (b.final === 'pass') return { text: 'Pass', tone: 'success' };
  if (b.final === 'fail') return { text: 'Fail', tone: 'destructive' };
  if (b.status === 'ok') return { text: 'Built, waiting for the judge', tone: 'warn' };
  return { text: b.status.replace(/_/g, ' '), tone: 'destructive' };
}

const usd = (v: number | null | undefined) => (v == null ? '' : `$${(Math.round(v * 100) / 100).toFixed(2)}`);

function Badge({ tone, children }: { tone: 'success' | 'destructive' | 'warn' | 'secondary' | 'default'; children: ReactNode }) {
  const cls = tone === 'success' ? AdminUI.badge.success
    : tone === 'destructive' ? AdminUI.badge.destructive
      : tone === 'warn' ? AdminUI.badge.warn
        : tone === 'secondary' ? AdminUI.badge.secondary : AdminUI.badge.default;
  return <span className={cls}>{children}</span>;
}

// ── One build ───────────────────────────────────────────────────────────

type Act = (trialId: number, what: 'rerun' | 'cancel' | 'keep' | 'unkeep' | 'preview') => void;

export function BuildCard({ b, canWrite, act }: { b: StudioBuild; canWrite: boolean; act: Act }) {
  const state = buildState(b);
  const live = b.preview && b.preview.status === 'live' && (b.preview.path || b.preview.url);
  return (
    <div className={`${AdminUI.card} p-4 space-y-2 ring-1 ring-zinc-200 dark:ring-zinc-800`} data-studio-build={b.trialId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          {b.armLabel}{b.attempt > 1 ? <span className={AdminUI.muted}> · attempt {b.attempt}</span> : null}
        </p>
        <Badge tone={state.tone}>{state.text}</Badge>
      </div>
      {b.shots.length ? (
        <div className="flex gap-2">
          {b.shots.slice(0, 2).map((sh) => (
            <a key={sh.artifactId} href={`${BASE}/artifacts/${sh.artifactId}`} target="_blank" rel="noopener noreferrer" className="block w-1/2">
              <img src={`${BASE}/artifacts/${sh.artifactId}`} alt={sh.caption} loading="lazy" className="w-full h-auto rounded-md ring-1 ring-zinc-200 dark:ring-zinc-700" />
            </a>
          ))}
        </div>
      ) : null}
      <p className={AdminUI.muted}>
        {[b.criteria ? `${b.criteria.held} of ${b.criteria.of} criteria held` : '', usd(b.costUsd), elapsedWords(b.elapsedMs)].filter(Boolean).join(' · ')}
      </p>
      {b.critique ? <p className="text-sm text-zinc-700 dark:text-zinc-300 line-clamp-4">{b.critique}</p> : null}
      {b.error ? <p className="text-sm text-red-600 dark:text-red-400">{b.error}</p> : null}
      {b.skills.invoked.length || b.skills.read.length ? (
        <p className={AdminUI.muted}>Skills: {[...b.skills.invoked, ...b.skills.read.map((s) => `${s} (read)`)].join(', ')}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {b.code ? <a className={AdminUI.btn.link} href={b.code.compareUrl || b.code.treeUrl} target="_blank" rel="noopener noreferrer">Code</a> : null}
        {live ? <a className={AdminUI.btn.link} href={b.preview!.path || b.preview!.url || '#'} target="_blank" rel="noopener noreferrer">Open preview</a> : null}
        {b.preview && b.preview.status === 'building' ? <span className={AdminUI.muted}>Preview building…</span> : null}
        {canWrite && b.status === 'ok' && b.code && !live && !(b.preview && b.preview.status === 'building') ? (
          <button type="button" className={AdminUI.btn.outlineSm} onClick={() => act(b.trialId, 'preview')}>Preview for a day</button>
        ) : null}
        {canWrite && b.code ? (
          <button type="button" className={AdminUI.btn.outlineSm} onClick={() => act(b.trialId, b.code!.kept ? 'unkeep' : 'keep')}>{b.code.kept ? 'Kept' : 'Keep'}</button>
        ) : null}
        {canWrite && !OPEN.includes(b.status) ? <button type="button" className={AdminUI.btn.outlineSm} onClick={() => act(b.trialId, 'rerun')}>Run again</button> : null}
        {canWrite && OPEN.includes(b.status) ? <button type="button" className={AdminUI.btn.outlineSm} onClick={() => act(b.trialId, 'cancel')}>Stop</button> : null}
      </div>
    </div>
  );
}

// ── The gallery ─────────────────────────────────────────────────────────

export function StudioGallery({ briefs, canWrite, act }: { briefs: Brief[] | null; canWrite: boolean; act: Act }) {
  if (briefs == null) return <p className={AdminUI.loading}>Loading…</p>;
  if (!briefs.length) return <p className={AdminUI.muted}>No studio briefs yet. Launch a run below, or from an admin connector session.</p>;
  return (
    <div className="space-y-6" id="admin-bench-studio-gallery">
      {briefs.map((brief) => (
        <section key={brief.taskId} className="space-y-3" data-studio-brief={brief.ref || brief.taskId}>
          <div>
            <h4 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{brief.appName}</h4>
            <p className={`${AdminUI.muted} line-clamp-3`}>{brief.brief}</p>
          </div>
          {brief.builds.length ? (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {brief.builds.map((b) => <BuildCard key={b.trialId} b={b} canWrite={canWrite} act={act} />)}
            </div>
          ) : <p className={AdminUI.muted}>No builds yet.</p>}
        </section>
      ))}
    </div>
  );
}

// ── Runs, and one run as it moves ───────────────────────────────────────

function RunsCard({ runs, watching, onWatch }: { runs: StudioRun[]; watching: number | null; onWatch: (id: number | null) => void }) {
  if (!runs.length) return <p className={AdminUI.muted}>No studio runs yet.</p>;
  return (
    <ul className="divide-y divide-zinc-100 dark:divide-zinc-800" id="admin-bench-studio-runs">
      {runs.map((r) => {
        const w = studioRunWords(r);
        return (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2" data-studio-run={r.id}>
            <div>
              <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                Run {r.id} · {r.models.join(', ')}{r.contextPackIds.some((p) => p) ? ` · packs ${r.contextPackIds.filter(Boolean).join(', ')}` : ''}
              </p>
              <p className={AdminUI.muted}>{w.label} · {w.line} · {usd(r.spentUsd)} of {usd(r.capUsd)}{r.note ? ` · ${r.note}` : ''}</p>
            </div>
            <button type="button" className={AdminUI.btn.outlineSm} onClick={() => onWatch(watching === r.id ? null : r.id)}>
              {watching === r.id ? 'Stop watching' : 'Watch'}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function WatchTable({ watch, canWrite, act }: { watch: Watch | null; canWrite: boolean; act: Act }) {
  if (!watch) return <p className={AdminUI.loading}>Loading…</p>;
  return (
    <div className={AdminUI.tableWrap} id="admin-bench-studio-watch">
      <table className={AdminUI.table}>
        <thead className={AdminUI.thead}>
          <tr><th className={AdminUI.th}>Brief</th><th className={AdminUI.th}>Arm</th><th className={AdminUI.th}>State</th><th className={AdminUI.th}>Now</th><th className={AdminUI.th} /></tr>
        </thead>
        <tbody>
          {watch.trials.map((b) => {
            const state = buildState(b);
            return (
              <tr key={b.trialId} className={AdminUI.trHover} data-studio-trial={b.trialId}>
                <td className={AdminUI.td}>{b.appName || b.ref || `Task ${b.taskId}`}</td>
                <td className={AdminUI.td}>{b.armLabel}</td>
                <td className={AdminUI.td}>
                  <Badge tone={state.tone}>{state.text}</Badge>
                  <span className={AdminUI.muted}> {[elapsedWords(b.elapsedMs), usd(b.costUsd)].filter(Boolean).join(' · ')}</span>
                </td>
                <td className={`${AdminUI.td} max-w-xs`}>
                  <p className="truncate text-sm text-zinc-700 dark:text-zinc-300">{b.activity[b.activity.length - 1] || ''}</p>
                  {b.skills.invoked.length ? <p className={AdminUI.muted}>Skills: {b.skills.invoked.join(', ')}</p> : null}
                </td>
                <td className={AdminUI.td}>
                  {canWrite && OPEN.includes(b.status) ? <button type="button" className={AdminUI.btn.outlineSm} onClick={() => act(b.trialId, 'cancel')}>Stop</button> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Packs ───────────────────────────────────────────────────────────────

function PacksCard({ packs, canWrite, say, onSaved }: { packs: Pack[]; canWrite: boolean; say: Say; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [guidance, setGuidance] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { notes: notes || null };
      if (parentId) body.parentId = Number(parentId);
      if (name.trim()) body.name = name.trim();
      if (guidance.trim() || !parentId) body.guidance = guidance;
      const out = await send(`${STUDIO}/packs`, 'POST', body);
      say(`Saved ${out.pack.name} v${out.pack.version}.`);
      setName(''); setGuidance(''); setNotes(''); setParentId('');
      onSaved();
    } catch (err: any) { say(err.message, 'err'); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-3" id="admin-bench-studio-packs">
      {packs.length ? (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {packs.map((p) => (
            <li key={p.id} className="py-2" data-studio-pack={p.id}>
              <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{p.name} v{p.version} <span className={AdminUI.muted}>· pack {p.id}</span></p>
              <p className={AdminUI.muted}>
                {[`${p.guidanceChars} characters of guidance`, p.stages.length ? `stage notes for ${p.stages.join(', ')}` : '',
                  p.files.length ? `${p.files.length} files (${p.files.map((f) => f.path).join(', ')})` : '', p.usedAt ? 'used' : 'never used'].filter(Boolean).join(' · ')}
              </p>
              {p.notes ? <p className={AdminUI.muted}>{p.notes}</p> : null}
            </li>
          ))}
        </ul>
      ) : <p className={AdminUI.muted}>No packs yet. A pack is guidance (and files) added to every first version the bot builds in a run.</p>}
      {canWrite ? (
        <details className="space-y-2">
          <summary className={`${AdminUI.btn.ghost} cursor-pointer text-sm`}>Save a pack version</summary>
          <div className="space-y-2 pt-2">
            <label className={AdminUI.label} htmlFor="admin-bench-studio-pack-parent">Start from</label>
            <select id="admin-bench-studio-pack-parent" className={AdminUI.select} value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">Nothing (a new pack)</option>
              {packs.map((p) => <option key={p.id} value={p.id}>{p.name} v{p.version}</option>)}
            </select>
            <label className={AdminUI.label} htmlFor="admin-bench-studio-pack-name">Name</label>
            <input id="admin-bench-studio-pack-name" className={AdminUI.input} value={name} onChange={(e) => setName(e.target.value)} placeholder={parentId ? 'The parent\'s' : 'warm theme'} />
            <label className={AdminUI.label} htmlFor="admin-bench-studio-pack-guidance">Guidance (every first version, every stage)</label>
            <textarea id="admin-bench-studio-pack-guidance" className={AdminUI.textarea} rows={6} value={guidance} onChange={(e) => setGuidance(e.target.value)}
              placeholder={parentId ? 'Leave empty to keep the parent\'s' : 'Brief-agnostic: never name one app'} />
            <label className={AdminUI.label} htmlFor="admin-bench-studio-pack-notes">Notes</label>
            <input id="admin-bench-studio-pack-notes" className={AdminUI.input} value={notes} onChange={(e) => setNotes(e.target.value)} />
            <p className={AdminUI.muted}>Files and per-stage guidance are saved from the admin connector (create_bench_context_pack).</p>
            <button type="button" className={AdminUI.btn.primarySm} disabled={busy || (!parentId && (!name.trim() || !guidance.trim()))} onClick={save}>Save version</button>
          </div>
        </details>
      ) : null}
    </div>
  );
}

// ── New run ─────────────────────────────────────────────────────────────

function LaunchForm({ home, say, onLaunched }: { home: Home; say: Say; onLaunched: (runId: number) => void }) {
  const [refs, setRefs] = useState<string[]>(() => home.starter.map((s) => s.ref));
  const [ownName, setOwnName] = useState('');
  const [ownBrief, setOwnBrief] = useState('');
  const [models, setModels] = useState('today');
  const [packIds, setPackIds] = useState<number[]>([0]);
  const [references, setReferences] = useState(0);
  const [cap, setCap] = useState('20');
  const [busy, setBusy] = useState(false);
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const launch = async () => {
    const capUsd = Number(cap);
    if (capUsd > CONFIRM_ABOVE_USD) {
      const ok = await (window as any).AdminConsole?._confirm?.({
        title: `Launch with a $${capUsd} cap?`,
        message: `The run may spend up to $${capUsd} of the platform's money.`,
        confirmLabel: 'Launch',
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const out = await send(`${STUDIO}/launch`, 'POST', {
        briefSet: refs.length ? 'starter' : undefined,
        refs: refs.length ? refs : undefined,
        briefs: ownBrief.trim() ? [{ name: ownName.trim() || 'My app', brief: ownBrief.trim() }] : undefined,
        models: models.split(',').map((m) => m.trim()).filter(Boolean),
        contextPackIds: packIds.length ? packIds : [0],
        references,
        capUsd,
      });
      say(`Launched run ${out.run.id}: ${out.trials} builds, about ${usd(out.estimateUsd)} against a cap of ${usd(out.run.capUsd)}.`);
      onLaunched(out.run.id);
    } catch (err: any) { say(err.message, 'err'); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-3" id="admin-bench-studio-launch">
      <fieldset className="space-y-1">
        <legend className={AdminUI.label}>Starter briefs</legend>
        {home.starter.map((s) => (
          <label key={s.ref} className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
            <input type="checkbox" checked={refs.includes(s.ref)} onChange={() => setRefs(toggle(refs, s.ref))} /> {s.appName}
          </label>
        ))}
      </fieldset>
      <label className={AdminUI.label} htmlFor="admin-bench-studio-own-name">And a brief of your own</label>
      <input id="admin-bench-studio-own-name" className={AdminUI.input} value={ownName} onChange={(e) => setOwnName(e.target.value)} placeholder="App name" />
      <textarea className={AdminUI.textarea} rows={3} value={ownBrief} onChange={(e) => setOwnBrief(e.target.value)} placeholder="What a creator would type when making the app" aria-label="Brief" />
      <label className={AdminUI.label} htmlFor="admin-bench-studio-models">Models (comma separated; today is the live bot's own)</label>
      <input id="admin-bench-studio-models" className={AdminUI.input} value={models} onChange={(e) => setModels(e.target.value)} />
      <fieldset className="space-y-1">
        <legend className={AdminUI.label}>Context packs</legend>
        <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
          <input type="checkbox" checked={packIds.includes(0)} onChange={() => setPackIds(toggle(packIds, 0))} /> No pack
        </label>
        {home.packs.slice(0, 12).map((p) => (
          <label key={p.id} className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
            <input type="checkbox" checked={packIds.includes(p.id)} onChange={() => setPackIds(toggle(packIds, p.id))} /> {p.name} v{p.version}
          </label>
        ))}
      </fieldset>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={AdminUI.label} htmlFor="admin-bench-studio-references">References per brief</label>
          <input id="admin-bench-studio-references" type="number" min={0} max={home.limits.references} className={AdminUI.input} value={references} onChange={(e) => setReferences(Number(e.target.value) || 0)} />
        </div>
        <div>
          <label className={AdminUI.label} htmlFor="admin-bench-studio-cap">Cap (US dollars)</label>
          <input id="admin-bench-studio-cap" type="number" min={1} className={AdminUI.input} value={cap} onChange={(e) => setCap(e.target.value)} />
        </div>
      </div>
      <p className={AdminUI.muted}>References are built by a Claude Code session from the admin connector (get_bench_reference_order, then submit_bench_reference).</p>
      <button type="button" className={AdminUI.btn.primary} disabled={busy || (!refs.length && !ownBrief.trim()) || !(Number(cap) > 0)} onClick={launch}>Launch</button>
    </div>
  );
}

// ── The place ───────────────────────────────────────────────────────────

function Card({ title, description, children, id }: { title: string; description?: string; children: ReactNode; id?: string }) {
  return (
    <div className={`${AdminUI.card} p-6`} id={id}>
      <div className={AdminUI.cardHeader}>
        <div>
          <h3 className={AdminUI.cardTitle}>{title}</h3>
          {description ? <p className={AdminUI.cardDescription}>{description}</p> : null}
        </div>
      </div>
      {children}
    </div>
  );
}

export function StudioPage({ canWrite, say }: { canWrite: boolean; say: Say }) {
  const [home, setHome] = useState<Home | null>(null);
  const [briefs, setBriefs] = useState<Brief[] | null>(null);
  const [watching, setWatching] = useState<number | null>(null);
  const [watch, setWatch] = useState<Watch | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    try {
      const [h, g] = await Promise.all([send(STUDIO, 'GET'), send(`${STUDIO}/gallery`, 'GET')]);
      if (!alive.current) return;
      setHome(h);
      setBriefs(g.briefs || []);
    } catch (err: any) { say(`Could not read the studio: ${err.message}`, 'err'); }
  }, [say]);
  const loadWatch = useCallback(async (id: number) => {
    try {
      const w = await send(`${STUDIO}/runs/${id}/watch`, 'GET');
      if (alive.current) setWatch(w);
    } catch (err: any) { say(err.message, 'err'); }
  }, [say]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    setWatch(null);
    if (watching != null) loadWatch(watching);
  }, [watching, loadWatch]);
  const anyOpen = !!home && home.runs.some((r) => studioRunWords(r).open);
  useEffect(() => {
    if (!anyOpen) return undefined;
    const handle = window.setInterval(() => {
      load();
      if (watching != null) loadWatch(watching);
    }, POLL_MS);
    return () => window.clearInterval(handle);
  }, [anyOpen, watching, load, loadWatch]);

  const act: Act = async (trialId, what) => {
    try {
      const verb = what === 'unkeep' ? 'keep' : what;
      const out = await send(`${STUDIO}/trials/${trialId}/${verb}`, 'POST', what === 'unkeep' ? { keep: false } : {});
      say({
        rerun: `Build ${trialId} runs again as trial ${out.trialId}.`,
        cancel: 'Stopping it.',
        keep: 'Kept past the seven-day sweep.',
        unkeep: 'No longer kept.',
        preview: 'The preview is building; it opens here once live, for a day.',
      }[what]);
      load();
      if (watching != null) loadWatch(watching);
    } catch (err: any) { say(err.message, 'err'); }
  };

  return (
    <div className="space-y-4" id="admin-bench-studio">
      <Card title="Gallery" description="Every studio brief's builds, newest first: the bot's on each model and pack, beside the references" id="admin-bench-studio-gallery-card">
        <StudioGallery briefs={briefs} canWrite={canWrite} act={act} />
      </Card>
      <Card title="Runs" description={home?.host ? `Built on the studio's own app, ${home.host.slug}, whose previews start from an empty database` : undefined}>
        {home == null ? <p className={AdminUI.loading}>Loading…</p> : <RunsCard runs={home.runs} watching={watching} onWatch={setWatching} />}
        {watching != null ? <div className="pt-4"><WatchTable watch={watch} canWrite={canWrite} act={act} /></div> : null}
      </Card>
      <Card title="Context packs" description="What a run adds to the bot's first-version prompts and to the new app's first commit">
        {home == null ? <p className={AdminUI.loading}>Loading…</p> : <PacksCard packs={home.packs} canWrite={canWrite} say={say} onSaved={load} />}
      </Card>
      {canWrite && home ? (
        <Card title="New studio run" description="It spends the platform's money, up to the cap">
          <LaunchForm home={home} say={say} onLaunched={(id) => { load(); setWatching(id); }} />
        </Card>
      ) : null}
    </div>
  );
}
