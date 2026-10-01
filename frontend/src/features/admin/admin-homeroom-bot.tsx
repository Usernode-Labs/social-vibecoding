'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// Homeroom bot (#admin/homeroom-bot) — #2684, slice 1.
//
// The bot triages open requests in SHADOW MODE: for each issue it runs a
// read-only scout turn with the app's repository open and records one
// verdict — the question it would ask, that the issue is ready to build,
// or that a person has to decide — without posting, claiming, building or
// notifying anybody. This screen is the only place those verdicts show,
// and the two one-tap ratings per row are the calibration signal the later
// slices (posting, building) are gated on. services/homeroom-bot.js has the
// full reasoning; routes/admin.js the five endpoints.
//
// PERMISSIONS: visible to any admin; the controls, the "run now" box, the
// ratings and the CSV export are gated on AdminConsole.canWrite(), and the
// server enforces the same with requireAdminWrite on the four of them that
// are not the page read. The export is a write-gated READ — routes/admin.js
// says why a bulk download sits with the mutations rather than the screen.

interface Settings {
  mode: 'off' | 'shadow' | 'live';
  concurrency: number;
  batchSize: number;
  pausedApps: string[];
  // #3146: the apps the bot acts on for real. Shadow everywhere else.
  liveApps: string[];
  turnSeconds: number;
  turnInputTokens: number;
  // Shadow builds: ready verdicts off the live list built on a branch
  // nobody is shown, in a lane of their own, this many at once. The
  // platform's own repository is left out unless included.
  shadowBuilds: boolean;
  buildConcurrency: number;
  shadowBuildPlatform: boolean;
}

interface BuildLane {
  queued: number;
  building: number;
  built: number;
  failed: number;
  costUsd: number;
  lane: { at: string; started: number; inFlight: number; paused: string | null; detail?: string } | null;
  fault: { error: string; retryAt: string } | null;
}

interface Bot {
  id: number;
  username: string;
  weeklyLimitCents: number;
  weeklySpentCents: number;
  hasIncludedKey: boolean;
  model: string | null;
}

interface Totals {
  days: number;
  runs: number;
  questions: number;
  ready: number;
  person: number;
  failed: number;
  budgetStopped: number;
  rated: number;
  agreed: number;
  suppressed: number;
  costUsd: number;
}

interface QueueItem {
  id: number;
  issue_number: number;
  priority: number;
  reason: string;
  enqueued_at: string;
  started_at: string | null;
  app_slug: string;
  app_name: string;
}

interface Run {
  id: number;
  issue_number: number;
  mode: string;
  // #3264: 'answer' and 'revise' are follow-ups on the bot's own proposal.
  verdict: 'question' | 'ready' | 'person' | 'empty' | 'failed' | 'answer' | 'revise';
  determined: boolean | null;
  missing_fact: string | null;
  question: string | null;
  question_default: string | null;
  build_note: string | null;
  reason: string | null;
  cap_suppressed: string | null;
  budget_stop: string | null;
  rating: 'yes' | 'no' | null;
  rating_note: string | null;
  rated_at: string | null;
  rated_by: string | null;
  model: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  error: string | null;
  created_at: string;
  // #3146: the proposal a live `ready` run opened.
  proposal_session_id: number | null;
  build_ok: boolean | null;
  build_branch: string | null;
  build_sha: string | null;
  build_commits: number | null;
  build_error: string | null;
  build_cost_usd: number | null;
  build_at: string | null;
  build_queued_at: string | null;
  // The spec the bot wrote before building, live or shadow.
  build_spec_md: string | null;
  buildUrl: string | null;
  app_slug: string;
  app_name: string;
  issueUrl: string | null;
}

interface Refusal {
  app: string;
  error: string;
  retryInMs?: number;
}

interface LastPass {
  at: string;
  mode: string | null;
  busy: boolean;
  refreshed: boolean;
  processed: number;
  paused: string | null;
  detail?: string | null;
  // How long the bot waits before trying again after a platform fault (#3122).
  retryInMs?: number | null;
  refusals?: Refusal[];
}

/** When a paused pass will try again, from the pass time and its backoff. */
function retryAt(loop: LastPass): string {
  if (!loop.retryInMs) return '';
  const at = Date.parse(loop.at);
  if (Number.isNaN(at)) return '';
  return when(new Date(at + loop.retryInMs).toISOString());
}

interface Payload {
  settings: Settings;
  modes: string[];
  bot: Bot | null;
  loop: LastPass | null;
  totals: Totals;
  queue: { depth: number; items: QueueItem[] };
  runs: Run[];
  apps: { slug: string; name: string }[];
  caps: { proposalsPerApp: number; proposalsTotal: number; questionsPerAppPerDay: number };
  builds: BuildLane;
  mentionOptOuts: { total: number; items: MentionOptOut[] };
}

// Somebody who asked the bot to stop tagging them on one issue.
interface MentionOptOut {
  app_slug: string;
  app_name: string;
  issue_number: number;
  username: string;
  created_at: string;
}

type Tone = 'ok' | 'err';
interface Status { text: string; tone: Tone }

function money(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(Number(usd))) return '–';
  return `$${Number(usd).toFixed(2)}`;
}

function dollarsFromCents(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(Number(cents))) return '–';
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

function when(iso: string | null | undefined): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const VERDICT_LABEL: Record<Run['verdict'], string> = {
  question: 'Needs a question',
  ready: 'Ready to build',
  person: 'Needs a person',
  empty: 'Nothing to build',
  failed: 'Failed',
  answer: 'Answered',
  revise: 'Revised its proposal',
};

const VERDICT_BADGE: Record<Run['verdict'], string> = {
  question: AdminUI.badge.warn,
  ready: AdminUI.badge.success,
  person: AdminUI.badge.secondary,
  empty: AdminUI.badge.outline,
  failed: AdminUI.badge.destructive,
  answer: AdminUI.badge.secondary,
  revise: AdminUI.badge.success,
};

/** #3264: a run that followed up on a proposal the bot had already opened. */
function isFollowUp(run: Run): boolean {
  return !!run.proposal_session_id && run.verdict !== 'ready';
}

function ProposalLink({ run, children }: { run: Run; children: string }) {
  return (
    <a className={AdminUI.btn.link} href={`#app/${encodeURIComponent(run.app_slug)}/dev/proposals/${Number(run.proposal_session_id)}`}>
      {children}
    </a>
  );
}

const CAP_LABEL: Record<string, string> = {
  proposals_per_app: 'would be held: 5 bot proposals already open on this app',
  proposals_total: 'would be held: the bot is at its ceiling of proposals open across Homeroom',
  question_tripwire: 'would be held: question tripwire for this app tripped today',
};

/**
 * A shadow build of a ready verdict: the branch it left on the app's
 * repository, for a spot check, or why there is none. The compare address
 * is text to copy, not a link: it is built from the app's repo_url, and the
 * console never renders an API-supplied URL as an anchor.
 */
function ShadowBuild({ run }: { run: Run }) {
  if (run.build_ok == null) {
    if (run.build_at) {
      return <p className={AdminUI.muted} data-shadow-build="building">{`Shadow build under way since ${when(run.build_at)}.`}</p>;
    }
    if (run.build_queued_at) {
      return <p className={AdminUI.muted} data-shadow-build="queued">{`Shadow build queued ${when(run.build_queued_at)}.`}</p>;
    }
    // Skipped (the issue closed, the app went live) or replaced by a later
    // verdict: the reason is kept, and there is no branch.
    if (run.build_error) {
      return <p className={`${AdminUI.muted} break-words`} data-shadow-build="skipped">{`Not shadow built: ${run.build_error.replace(/^(skipped|superseded): /, '')}.`}</p>;
    }
    return null;
  }
  if (!run.build_ok) {
    return (
      <p className={`${AdminUI.muted} break-words`} data-shadow-build="failed">
        {`Shadow build did not produce a change: ${run.build_error || 'no reason recorded'}.`}
      </p>
    );
  }
  const parts = [
    `Shadow build on ${run.build_branch}`,
    run.build_commits != null ? `${run.build_commits} commit${run.build_commits === 1 ? '' : 's'}` : null,
    run.build_sha ? `at ${String(run.build_sha).slice(0, 7)}` : null,
    run.build_cost_usd != null ? money(run.build_cost_usd) : null,
  ].filter(Boolean);
  return (
    <div className="space-y-0.5" data-shadow-build="built">
      <p className={AdminUI.muted}>{`${parts.join(', ')}. Not proposed, not posted.`}</p>
      {run.buildUrl ? <p className={`${AdminUI.muted} break-all select-all`}>{run.buildUrl}</p> : null}
    </div>
  );
}

/**
 * What a live build came to (#3509), recorded on the run in the columns a
 * shadow build fills. A build that became a proposal is said by the
 * proposal link below; this says what else is worth knowing: what it pushed,
 * why it did not become a proposal, or why it worked without a spec.
 */
function LiveBuild({ run }: { run: Run }) {
  if (run.build_ok == null) return null;
  if (!run.build_ok) {
    const why = run.build_error || 'no reason recorded';
    return (
      <p className={`${AdminUI.muted} break-words`} data-live-build={why.startsWith('blocked: ') ? 'blocked' : 'failed'}>
        {why.startsWith('blocked: ')
          ? `Building showed it cannot be done as asked: ${why.slice('blocked: '.length)}.`
          : `Live build did not become a proposal: ${why}.`}
      </p>
    );
  }
  const parts = [
    run.build_branch ? `Built on ${run.build_branch}` : 'Built',
    run.build_commits != null ? `${run.build_commits} commit${run.build_commits === 1 ? '' : 's'}` : null,
    run.build_sha ? `at ${String(run.build_sha).slice(0, 7)}` : null,
    run.build_cost_usd != null ? money(run.build_cost_usd) : null,
  ].filter(Boolean);
  return (
    <div className="space-y-0.5" data-live-build="built">
      <p className={AdminUI.muted}>{`${parts.join(', ')}.`}</p>
      {run.build_error ? <p className={`${AdminUI.muted} break-words`}>{run.build_error}</p> : null}
    </div>
  );
}

/** A question's "user_facing: why" as words. */
function blockerLabel(reason: string): string {
  const [kind, ...rest] = reason.split(': ');
  const why = rest.join(': ');
  if (kind === 'user_facing') return `it changes what people see, and the default could be the wrong build. ${why}`;
  if (kind === 'impossible') return `it may not be buildable as asked. ${why}`;
  return reason;
}

/**
 * The spec the bot wrote just before it built, folded away: on a live app it
 * was also posted on the issue and the proposal, on a shadow one it was
 * shown to nobody. Plain text, as the rest of this table is.
 */
function BuildSpec({ run }: { run: Run }) {
  if (!run.build_spec_md) return null;
  return (
    <details className="text-sm" data-build-spec>
      <summary className={`${AdminUI.muted} cursor-pointer`}>The spec it built from</summary>
      <p className="mt-1 whitespace-pre-wrap break-words">{run.build_spec_md}</p>
    </details>
  );
}

/** What the bot would have posted, as one block of plain text per verdict. */
function VerdictBody({ run }: { run: Run }) {
  if (run.verdict === 'question') {
    return (
      <div className="space-y-1">
        <p className="text-sm">{run.question || '(no question text)'}</p>
        {run.question_default ? (
          <p className={AdminUI.muted}>Suggested default: {run.question_default}</p>
        ) : null}
        {run.reason ? (
          <p className={AdminUI.muted} data-question-blocker>{`Why it is a blocker: ${blockerLabel(run.reason)}`}</p>
        ) : null}
      </div>
    );
  }
  if (run.verdict === 'ready') {
    return (
      <div className="space-y-1">
        <p className="text-sm whitespace-pre-line">{run.build_note || '(no build note)'}</p>
        {run.reason ? <p className={AdminUI.muted} data-demoted-question>{run.reason}</p> : null}
        {run.mode === 'live' ? <LiveBuild run={run} /> : <ShadowBuild run={run} />}
        <BuildSpec run={run} />
        {run.proposal_session_id ? (
          <p className={AdminUI.muted}>
            {'Built and '}
            <a className={AdminUI.btn.link} href={`#app/${encodeURIComponent(run.app_slug)}/dev/proposals/${Number(run.proposal_session_id)}`}>
              opened as a proposal
            </a>
            .
          </p>
        ) : null}
      </div>
    );
  }
  // #3264: what it answered on its own proposal, and what it changed there.
  if (run.verdict === 'answer') {
    return (
      <div className="space-y-1">
        <p className="text-sm whitespace-pre-line">{run.reason || '(no reply recorded)'}</p>
        {run.proposal_session_id ? (
          <p className={AdminUI.muted}>
            {'Replied about '}
            <ProposalLink run={run}>its proposal</ProposalLink>
            .
          </p>
        ) : null}
      </div>
    );
  }
  if (run.verdict === 'revise') {
    return (
      <div className="space-y-1">
        <p className="text-sm whitespace-pre-line">{run.build_note || run.reason || '(no summary recorded)'}</p>
        {run.build_note && run.reason ? <p className={`${AdminUI.muted} whitespace-pre-line`}>{run.reason}</p> : null}
        {run.proposal_session_id ? (
          <p className={AdminUI.muted}>
            {'Pushed to '}
            <ProposalLink run={run}>its proposal</ProposalLink>
            {', which cleared its votes and re-ran its checks.'}
          </p>
        ) : null}
      </div>
    );
  }
  if (run.verdict === 'person') {
    return <p className="text-sm">{run.reason || '(no reason given)'}</p>;
  }
  // A verdict, not a failure (#3144): the bot found nothing to build and says
  // why. Without its own branch it fell through to the red failure line below.
  if (run.verdict === 'empty') {
    return <p className="text-sm">{run.reason || '(no reason given)'}</p>;
  }
  if (run.budget_stop) {
    return (
      <div className="space-y-1">
        <p className="text-sm">
          {`The bot stopped this turn itself: it ran past the ${run.budget_stop} limit before reaching a verdict.`}
        </p>
        <p className={AdminUI.muted}>
          It goes back to the end of the queue once. A second stop lets the issue go, rather than retrying it forever.
        </p>
        <p className={AdminUI.muted}>
          Its cost counts the model requests that finished before the stop. The one still running when it was
          stopped never reports what it used, so the real cost is a little higher.
        </p>
      </div>
    );
  }
  return <p className="text-sm text-red-400 break-words">{run.error || 'The run failed before it produced a verdict.'}</p>;
}

/** The build lane in one line: what is waiting, running, done, and why it idles. */
function buildLaneLine(b: BuildLane | undefined): string {
  if (!b) return '';
  const parts = [
    `${b.queued} queued`,
    `${b.building} building`,
    `${b.built} built`,
    `${b.failed} failed`,
    `${money(b.costUsd)} spent on builds`,
  ];
  let line = `${parts.join(', ')}.`;
  if (b.fault) line += ` Backing off after a platform fault until ${when(b.fault.retryAt)}: ${b.fault.error}.`;
  else if (b.lane?.paused === 'budget') line += ' Waiting on the weekly cap.';
  return line;
}

function HomeroomBotSection() {
  const console_ = () => (window as any).AdminConsole;
  const canWrite = !!console_()?.canWrite();

  const [payload, setPayload] = useState<Payload | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState('');
  const [appFilter, setAppFilter] = useState('');
  const [verdictFilter, setVerdictFilter] = useState('');
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [capDraft, setCapDraft] = useState('');
  const [runSlug, setRunSlug] = useState('');
  const [runIssue, setRunIssue] = useState('');
  // #3152: the live list being edited, or null while it matches what is
  // saved. Null is what lets the 30-second poll refresh the rows without
  // throwing away an edit in progress.
  const [liveDraft, setLiveDraft] = useState<string[] | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const apply = useCallback((data: Payload) => {
    setPayload(data);
    setCapDraft(data.bot ? (data.bot.weeklyLimitCents / 100).toFixed(2) : '');
  }, []);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (appFilter) params.set('app', appFilter);
    if (verdictFilter) params.set('verdict', verdictFilter);
    const qs = params.toString();
    const { data } = await console_().fetchJson(`/api/admin/homeroom-bot${qs ? `?${qs}` : ''}`);
    if (alive.current && data && typeof data === 'object') apply(data as Payload);
  }, [apply, appFilter, verdictFilter]);

  useEffect(() => { load(); }, [load]);

  // A pass takes a minute or two per issue; a slow poll keeps the queue and
  // the totals honest without hammering the endpoint. Cleared on destroy.
  useEffect(() => {
    const handle = window.setInterval(() => { load(); }, 30_000);
    return () => window.clearInterval(handle);
  }, [load]);

  const write = async (url: string, method: string, body: unknown, okText: string) => {
    setStatus(null);
    setBusy(url);
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (!alive.current) return null;
      setStatus({ text: okText, tone: 'ok' });
      return data;
    } catch (err: any) {
      if (alive.current) setStatus({ text: `Save failed: ${err.message}`, tone: 'err' });
      return null;
    } finally {
      if (alive.current) setBusy('');
    }
  };

  const saveSettings = async (patch: Partial<Settings> & { weeklyLimitCents?: number }, okText: string) => {
    const data = await write('/api/admin/homeroom-bot/settings', 'PUT', patch, okText);
    if (data) apply(data as Payload);
  };

  const rate = async (run: Run, rating: 'yes' | 'no' | null) => {
    const data = await write(`/api/admin/homeroom-bot/runs/${run.id}/rating`, 'POST', { rating },
      rating ? `#${run.issue_number} rated.` : `#${run.issue_number} rating cleared.`);
    if (data) load();
  };

  // A plain link, not a fetch: the endpoint streams the file and the browser
  // is better at receiving one than a Blob assembled in page memory. It
  // carries whatever filters the table is showing, so "all verdicts" is the
  // export with both filters cleared.
  const exportParams = new URLSearchParams();
  if (appFilter) exportParams.set('app', appFilter);
  if (verdictFilter) exportParams.set('verdict', verdictFilter);
  const exportQs = exportParams.toString();
  const exportHref = `/api/admin/homeroom-bot/export.csv${exportQs ? `?${exportQs}` : ''}`;

  const runNow = async () => {
    const n = Number(runIssue);
    if (!runSlug || !Number.isInteger(n) || n <= 0) {
      setStatus({ text: 'Pick an app and type an issue number.', tone: 'err' });
      return;
    }
    const data = await write('/api/admin/homeroom-bot/run', 'POST', { slug: runSlug, issueNumber: n },
      `#${n} on ${runSlug} is at the head of the queue${payload?.settings.mode === 'off' ? ' (the bot is off, so it waits)' : ''}.`);
    if (data) { setRunIssue(''); load(); }
  };

  // Every open request whose latest verdict is ready and that has no build
  // yet, into the build lane. The lane works through it at its own pace.
  const backfill = async () => {
    const data = await write('/api/admin/homeroom-bot/shadow-builds/backfill', 'POST', {}, 'Queued.');
    if (!data || !alive.current) return;
    const left = data.left || {};
    const notes = [
      left.live ? `${left.live} on live apps` : null,
      left.platform ? `${left.platform} on the platform's own repository` : null,
      left.paused ? `${left.paused} on paused apps` : null,
    ].filter(Boolean);
    setStatus({
      text: data.queued
        ? `Queued ${data.queued} build${data.queued === 1 ? '' : 's'} across ${data.apps} app${data.apps === 1 ? '' : 's'}.${notes.length ? ` Left out: ${notes.join(', ')}.` : ''}`
        : `Nothing new to build.${notes.length ? ` Left out: ${notes.join(', ')}.` : ''}`,
      tone: 'ok',
    });
    load();
  };

  // The questions the bot asked under an older bar, triaged again under the
  // current prompt: old and new verdicts sit side by side in the export.
  const retriage = async () => {
    const data = await write('/api/admin/homeroom-bot/retriage-questions', 'POST', {}, 'Queued.');
    if (!data || !alive.current) return;
    setStatus({
      text: data.queued
        ? `${data.queued} question${data.queued === 1 ? '' : 's'} will be triaged again.${data.live ? ` ${data.live} on live apps left alone.` : ''}`
        : `No questions to triage again.${data.live ? ` ${data.live} on live apps left alone.` : ''}`,
      tone: 'ok',
    });
    load();
  };

  // A live app's open issues, all of them, as if just posted (#3480): the
  // loop takes them one at a time, as it takes new ones.
  const retriageApp = async (slug: string) => {
    const data = await write('/api/admin/homeroom-bot/retriage-app', 'POST', { slug }, 'Queued.');
    if (!data || !alive.current) return;
    const busy = data.left?.busy || 0;
    setStatus({
      text: data.queued
        ? `${data.queued} open issue${data.queued === 1 ? '' : 's'} on ${appName(slug)} will be triaged again, one at a time, oldest first.${busy ? ` ${busy} somebody is working on left alone.` : ''}`
        : `No open issues on ${appName(slug)} to triage again.${busy ? ` ${busy} somebody is working on left alone.` : ''}`,
      tone: 'ok',
    });
    load();
  };

  // An ask the bot misread: tag this person on this issue again.
  const tagAgain = async (o: MentionOptOut) => {
    const data = await write('/api/admin/homeroom-bot/mention-optouts/remove', 'POST',
      { slug: o.app_slug, issueNumber: o.issue_number, username: o.username },
      `@${o.username} is tagged again on ${o.app_name} #${o.issue_number}.`);
    if (data && alive.current && payload) setPayload({ ...payload, mentionOptOuts: data.mentionOptOuts });
  };

  const savedLive = payload?.settings.liveApps || [];
  const liveRows = liveDraft ?? savedLive;
  const liveChosen = [...new Set(liveRows.filter(Boolean))];
  const liveDirty = liveChosen.join(',') !== savedLive.join(',');
  const appName = (slug: string) => payload?.apps.find((a) => a.slug === slug)?.name || slug;
  const editLive = (rows: string[]) => setLiveDraft(rows);

  const saveLive = async () => {
    if (!liveDirty) return;
    const data = await write('/api/admin/homeroom-bot/settings', 'PUT', { liveApps: liveChosen }, liveChosen.length
      ? `Saved. The bot now acts for real on ${liveChosen.map(appName).join(', ')}.`
      : 'Saved. The bot is back to shadow on every app.');
    if (data) {
      setLiveDraft(null);
      apply(data as Payload);
    }
  };

  const togglePause = async (slug: string) => {
    if (!payload) return;
    const paused = new Set(payload.settings.pausedApps);
    const willPause = !paused.has(slug);
    if (willPause) paused.add(slug); else paused.delete(slug);
    await saveSettings({ pausedApps: [...paused] }, willPause ? `${slug} paused.` : `${slug} resumed.`);
  };

  const settings = payload?.settings;
  const totals = payload?.totals;
  const bot = payload?.bot;
  const runs = payload?.runs || [];
  const paused = new Set(settings?.pausedApps || []);
  const agreement = totals && totals.rated > 0 ? Math.round((totals.agreed / totals.rated) * 100) : null;

  const tile = (label: string, value: string, id: string) => (
    <div className="rounded-lg bg-zinc-100 dark:bg-zinc-800 p-3" id={id}>
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
    </div>
  );

  return (
    <div className="space-y-4" id="admin-homeroom-bot">
      <div className={`${AdminUI.card} p-4`}>
        <div className={AdminUI.cardHeader}>
          <h2 className={AdminUI.cardTitle}>Homeroom bot</h2>
          <span className={AdminUI.cardDescription} id="admin-homeroom-bot-mode-label">
            {settings ? (settings.mode === 'off' ? 'Off' : settings.mode === 'shadow' ? 'Shadow mode: triaging, posting nothing' : 'Live') : 'Loading…'}
          </span>
        </div>
        <p className={`${AdminUI.muted} mb-4`} id="admin-homeroom-bot-intro">
          In shadow mode the bot reads each open request, its discussion and the app’s code, and records what it
          would do: the one question it would ask, that the request is ready to build, or that a person has to decide.
          It posts nothing and claims nothing, and builds nothing unless shadow builds are on below. Rate its verdicts
          here; that is what decides whether it is ever allowed to post.
        </p>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          {tile(`Runs, ${totals?.days || 7} days`, String(totals?.runs ?? 0), 'admin-homeroom-bot-tile-runs')}
          {tile('Ask / ready / person', totals ? `${totals.questions} / ${totals.ready} / ${totals.person}` : '–', 'admin-homeroom-bot-tile-mix')}
          {tile('Agreed with', agreement == null ? (totals && totals.rated ? '–' : 'unrated') : `${agreement}% of ${totals?.rated}`, 'admin-homeroom-bot-tile-agreement')}
          {tile('Spent this week', bot ? `${dollarsFromCents(bot.weeklySpentCents)} of ${dollarsFromCents(bot.weeklyLimitCents)}` : '–', 'admin-homeroom-bot-tile-spend')}
          {tile('Stopped on budget', String(totals?.budgetStopped ?? 0), 'admin-homeroom-bot-tile-budget')}
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <div>
            <label className={AdminUI.label} htmlFor="admin-homeroom-bot-mode">Mode</label>
            <select
              id="admin-homeroom-bot-mode"
              className={`${AdminUI.select} mt-1`}
              value={settings?.mode || 'off'}
              disabled={!canWrite || busy !== ''}
              onChange={(e) => saveSettings({ mode: e.target.value as Settings['mode'] },
                e.target.value === 'off' ? 'The bot is off.' : 'Shadow mode on: the next pass starts within two minutes.')}
            >
              <option value="off">Off</option>
              <option value="shadow">Shadow (record only)</option>
              <option value="live" disabled>Live (not in this build)</option>
            </select>
          </div>
          <div>
            <label className={AdminUI.label} htmlFor="admin-homeroom-bot-cap">Weekly cap, dollars</label>
            <div className="flex items-center gap-2 mt-1">
              <input
                id="admin-homeroom-bot-cap"
                type="number" min="0" step="1" inputMode="decimal"
                className={AdminUI.input}
                value={capDraft}
                disabled={!canWrite}
                onChange={(e) => setCapDraft(e.target.value)}
              />
              {canWrite ? (
                <button
                  type="button" className={AdminUI.btn.primarySm}
                  disabled={busy !== ''}
                  onClick={() => {
                    const dollars = Number(capDraft);
                    if (!Number.isFinite(dollars) || dollars < 0) {
                      setStatus({ text: 'Enter a dollar amount.', tone: 'err' });
                      return;
                    }
                    saveSettings({ weeklyLimitCents: Math.round(dollars * 100) }, `Weekly cap is now $${dollars.toFixed(2)}.`);
                  }}
                >Save</button>
              ) : null}
            </div>
          </div>
          <div>
            <label className={AdminUI.label} htmlFor="admin-homeroom-bot-batch">Issues per app before switching apps</label>
            <div className="flex items-center gap-2 mt-1">
              <input
                id="admin-homeroom-bot-batch"
                type="number" min="1" max="500" step="1"
                className={AdminUI.input}
                defaultValue={settings?.batchSize ?? 100}
                key={`batch-${settings?.batchSize ?? 100}`}
                disabled={!canWrite}
                onBlur={(e) => {
                  const n = Number(e.target.value);
                  if (n === settings?.batchSize) return;
                  if (!Number.isInteger(n) || n < 1 || n > 500) {
                    setStatus({ text: 'Issues per app must be a whole number from 1 to 500.', tone: 'err' });
                    return;
                  }
                  saveSettings({ batchSize: n }, `The bot now takes up to ${n} issues on one app before it looks at another.`);
                }}
              />
            </div>
          </div>

          <div>
            <label className={AdminUI.label} htmlFor="admin-homeroom-bot-turn-minutes">Minutes one issue may take</label>
            <div className="flex items-center gap-2 mt-1">
              <input
                id="admin-homeroom-bot-turn-minutes"
                type="number" min="1" max="180" step="1"
                className={AdminUI.input}
                defaultValue={Math.round((settings?.turnSeconds ?? 1200) / 60)}
                key={`turn-${settings?.turnSeconds ?? 1200}`}
                disabled={!canWrite}
                onBlur={(e) => {
                  const mins = Number(e.target.value);
                  const n = Math.round(mins * 60);
                  if (n === settings?.turnSeconds) return;
                  if (!Number.isInteger(mins) || mins < 1 || mins > 180) {
                    setStatus({ text: 'Minutes per issue must be a whole number from 1 to 180.', tone: 'err' });
                    return;
                  }
                  saveSettings({ turnSeconds: n }, `The bot now gives up on an issue after ${mins} minutes.`);
                }}
              />
            </div>
          </div>

          <div>
            <label className={AdminUI.label} htmlFor="admin-homeroom-bot-turn-tokens">Million tokens one issue may read</label>
            <div className="flex items-center gap-2 mt-1">
              <input
                id="admin-homeroom-bot-turn-tokens"
                type="number" min="1" max="5000" step="1"
                className={AdminUI.input}
                defaultValue={Math.round((settings?.turnInputTokens ?? 10_000_000) / 1_000_000)}
                key={`tok-${settings?.turnInputTokens ?? 10_000_000}`}
                disabled={!canWrite}
                onBlur={(e) => {
                  const millions = Number(e.target.value);
                  const n = Math.round(millions * 1_000_000);
                  if (n === settings?.turnInputTokens) return;
                  if (!Number.isInteger(millions) || millions < 1 || millions > 5000) {
                    setStatus({ text: 'Millions of tokens must be a whole number from 1 to 5000.', tone: 'err' });
                    return;
                  }
                  saveSettings({ turnInputTokens: n }, `The bot now warns when an issue reads more than ${millions} million tokens.`);
                }}
              />
            </div>
            <p className={`${AdminUI.muted} mt-1`} id="admin-homeroom-bot-turn-tokens-note">
              A warning, not a stop. The bot only learns what a turn read once the
              turn is over, so a turn past this keeps its verdict and the overrun is
              logged. The minute limit above is what actually ends a runaway turn.
            </p>
          </div>

          <div>
            <label className={AdminUI.label} htmlFor="admin-homeroom-bot-shadow-builds">Shadow builds</label>
            <select
              id="admin-homeroom-bot-shadow-builds"
              className={`${AdminUI.select} mt-1`}
              value={settings?.shadowBuilds ? 'on' : 'off'}
              disabled={!canWrite || busy !== ''}
              onChange={(e) => saveSettings({ shadowBuilds: e.target.value === 'on' }, e.target.value === 'on'
                ? 'Shadow builds on: each new ready request is built on a branch nobody is shown.'
                : 'Shadow builds are off. A build under way finishes; nothing new starts.')}
            >
              <option value="off">Off</option>
              <option value="on">On</option>
            </select>
            <label className={`${AdminUI.label} block mt-3`} htmlFor="admin-homeroom-bot-build-concurrency">Builds at once</label>
            <input
              id="admin-homeroom-bot-build-concurrency"
              type="number" min="1" max="4" step="1"
              className={`${AdminUI.input} mt-1`}
              defaultValue={settings?.buildConcurrency ?? 2}
              key={`builds-${settings?.buildConcurrency ?? 2}`}
              disabled={!canWrite}
              onBlur={(e) => {
                const n = Number(e.target.value);
                if (n === settings?.buildConcurrency) return;
                if (!Number.isInteger(n) || n < 1 || n > 4) {
                  setStatus({ text: 'Builds at once must be a whole number from 1 to 4.', tone: 'err' });
                  return;
                }
                saveSettings({ buildConcurrency: n }, `The bot now runs up to ${n} shadow build${n === 1 ? '' : 's'} at once, shared between apps in turns.`);
              }}
            />
            <label className="flex items-center gap-2 mt-3 text-sm" htmlFor="admin-homeroom-bot-shadow-build-platform">
              <input
                id="admin-homeroom-bot-shadow-build-platform" type="checkbox"
                className="h-4 w-4 rounded border-zinc-600 bg-zinc-800 text-violet-700 focus:ring-violet-500 dark:text-violet-400"
                checked={!!settings?.shadowBuildPlatform}
                disabled={!canWrite || busy !== ''}
                onChange={(e) => saveSettings({ shadowBuildPlatform: e.target.checked }, e.target.checked
                  ? "The platform's own repository is shadow built too."
                  : "The platform's own repository is left out of shadow builds.")}
              />
              <span>Include the platform's own repository</span>
            </label>
            <p className={`${AdminUI.muted} mt-2`} id="admin-homeroom-bot-build-lane">{buildLaneLine(payload?.builds)}</p>
            {canWrite ? (
              <button
                type="button" id="admin-homeroom-bot-shadow-backfill"
                className={`${AdminUI.btn.outlineSm} mt-2`}
                disabled={busy !== '' || !settings?.shadowBuilds}
                onClick={backfill}
              >Build every open ready request</button>
            ) : null}
            <p className={`${AdminUI.muted} mt-1`} id="admin-homeroom-bot-shadow-builds-note">
              On apps outside the live list, a ready request is also built on a branch
              of the app's repository, and nothing else happens: no proposal, no post,
              nothing in the app. Each build first writes a spec and then works from it.
              Builds run beside triage, never in its way, and are paid from the weekly cap
              above. Each run below shows its branch and its spec for a spot check.
            </p>
          </div>

          <div>
            <p className={AdminUI.label} id="admin-homeroom-bot-live-apps-label">Apps it acts on for real</p>
            <div id="admin-homeroom-bot-live-apps" role="group" aria-labelledby="admin-homeroom-bot-live-apps-label" className="mt-1 space-y-2">
              {liveRows.length ? liveRows.map((slug, i) => (
                <div key={i} className="flex items-center gap-2" data-live-app-row={slug || 'new'}>
                  <select
                    id={`admin-homeroom-bot-live-app-${i}`}
                    aria-label={`Live app ${i + 1}`}
                    className={AdminUI.select}
                    value={slug}
                    disabled={!canWrite}
                    onChange={(e) => editLive(liveRows.map((v, j) => (j === i ? e.target.value : v)))}
                  >
                    <option value="">Pick an app…</option>
                    {slug && !payload?.apps.some((a) => a.slug === slug)
                      ? <option value={slug}>{`${slug} (not running)`}</option>
                      : null}
                    {(payload?.apps || [])
                      .filter((a) => a.slug === slug || !liveRows.includes(a.slug))
                      .map((a) => <option key={a.slug} value={a.slug}>{a.name}</option>)}
                  </select>
                  {canWrite && slug && savedLive.includes(slug) && !settings?.pausedApps.includes(slug) ? (
                    <button
                      type="button"
                      className={AdminUI.btn.outlineSm}
                      data-live-app-retriage={slug}
                      title="Every open issue on this app, as if just posted: the bot takes them one at a time, oldest first."
                      onClick={() => retriageApp(slug)}
                    >
                      Triage again
                    </button>
                  ) : null}
                  {canWrite ? (
                    <button
                      type="button"
                      className={AdminUI.btn.outlineSm}
                      aria-label={`Remove ${slug ? appName(slug) : 'this row'}`}
                      onClick={() => editLive(liveRows.filter((_, j) => j !== i))}
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
              )) : (
                <p className={AdminUI.muted} id="admin-homeroom-bot-live-apps-none">None: it only records verdicts, on every app.</p>
              )}
            </div>
            {canWrite ? (
              <div className="flex flex-wrap items-center gap-2 mt-2">
                <button
                  type="button"
                  id="admin-homeroom-bot-live-apps-add"
                  className={AdminUI.btn.outlineSm}
                  onClick={() => editLive([...liveRows, ''])}
                >
                  Add app
                </button>
                <button
                  type="button"
                  id="admin-homeroom-bot-live-apps-save"
                  className={AdminUI.btn.primarySm}
                  disabled={!liveDirty || !!busy}
                  onClick={saveLive}
                >
                  Save
                </button>
                {liveDraft !== null ? (
                  <button
                    type="button"
                    id="admin-homeroom-bot-live-apps-reset"
                    className={AdminUI.btn.ghost}
                    onClick={() => setLiveDraft(null)}
                  >
                    Undo changes
                  </button>
                ) : null}
                <span className={AdminUI.muted} id="admin-homeroom-bot-live-apps-state">
                  {liveDirty
                    ? 'Not saved yet.'
                    : savedLive.length
                      ? `Saved: acts for real on ${savedLive.map(appName).join(', ')}${settings?.mode === 'off' ? ', once the bot is turned on' : ''}.`
                      : 'Saved: shadow on every app.'}
                </span>
              </div>
            ) : null}
            <p className={`${AdminUI.muted} mt-1`} id="admin-homeroom-bot-live-apps-note">
              On these apps it posts on each issue it looks at, asks its questions
              there, and builds the clear requests into proposals for the group to
              vote on. Everywhere else it only records verdicts. The mode above has
              to be on, and a staging copy never acts.
            </p>
          </div>
        </div>

        <p className={`${AdminUI.muted} mt-3`} id="admin-homeroom-bot-identity">
          {`${bot
            ? `Runs as ${bot.username} on ${bot.model || 'the platform default model'}, ${bot.hasIncludedKey ? 'with its included OpenRouter key' : 'with no OpenRouter key yet (the first pass mints one)'}.`
            : 'The bot user is not set up yet; the dashboard creates it on load, so check the logs if this persists.'} Before posting anything the live rules would hold a verdict at ${payload?.caps.proposalsPerApp ?? 5} open bot proposals per app (${payload?.caps.proposalsTotal ?? 5} across all its live apps) and ${payload?.caps.questionsPerAppPerDay ?? 10} questions per app per day; rows below say when they would have.`}
        </p>

        <p className={`${AdminUI.muted} mt-1`} id="admin-homeroom-bot-loop">
          {payload?.loop
            ? `Last pass ${when(payload.loop.at)}: ${payload.loop.processed} triaged${payload.loop.refreshed ? ', queue refreshed' : ''}${
              payload.loop.paused === 'budget' ? '; paused on the weekly cap'
                : payload.loop.paused === 'infra' ? `; paused on a platform fault (${payload.loop.detail || 'see the logs'})${
                  retryAt(payload.loop) ? `, trying again at ${retryAt(payload.loop)}` : ''}`
                  : payload.loop.paused === 'mode_off' ? '; stopped because the mode was switched off'
                    : payload.loop.busy ? '; another instance held the loop' : ''}.`
            : 'No pass has run since the platform started.'}
        </p>
        <p className={`${AdminUI.muted} mt-1`} id="admin-homeroom-bot-refusals">
          {payload?.loop?.refusals?.length
            ? `Backing off: ${payload.loop.refusals.map((r) => `${r.app} (${r.error}, retrying in ${Math.round((r.retryInMs || 0) / 60000)} min)`).join('; ')}.`
            : 'No app is backed off. A session that refuses a turn is retried after 2 minutes, then at doubling intervals up to an hour.'}
        </p>
        <p className={`${AdminUI.muted} mt-1`} id="admin-homeroom-bot-cadence">
          The loop wakes the moment a request is filed, edited or discussed here, drains the queue, then sleeps until the next one. A sweep of GitHub every five minutes catches what happens there directly.
        </p>
        <p id="admin-homeroom-bot-status" className={status
          ? `text-xs mt-3 ${status.tone === 'err' ? 'text-red-400' : 'text-green-800 dark:text-green-400'}`
          : 'text-xs mt-3 hidden'}>
          {status ? status.text : ''}
        </p>
      </div>

      <div className={`${AdminUI.card} p-4`}>
        <div className={AdminUI.cardHeader}>
          <h3 className={AdminUI.cardTitle}>Queue</h3>
          <span className={AdminUI.cardDescription} id="admin-homeroom-bot-queue-depth">
            {payload ? `${payload.queue.depth} waiting` : ''}
          </span>
        </div>
        {payload && payload.queue.items.length ? (
          <ul className="text-sm space-y-1" id="admin-homeroom-bot-queue">
            {payload.queue.items.map((q) => (
              <li key={q.id} className="flex flex-wrap items-center gap-2">
                <span className={q.started_at ? AdminUI.badge.secondary : AdminUI.badge.default}>
                  {q.started_at ? 'running' : q.priority === 0 ? 'run now' : q.reason}
                </span>
                <span>{q.app_name}</span>
                <span className={AdminUI.muted}>#{q.issue_number}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className={AdminUI.muted}>Nothing queued. The queue refreshes from open requests every five minutes while the bot is on.</p>
        )}
        {canWrite ? (
          <div className="flex flex-wrap items-end gap-2 mt-4">
            <div>
              <label className={AdminUI.label} htmlFor="admin-homeroom-bot-run-app">Run now on</label>
              <select
                id="admin-homeroom-bot-run-app"
                className={`${AdminUI.select} mt-1`}
                value={runSlug}
                onChange={(e) => setRunSlug(e.target.value)}
              >
                <option value="">Pick an app…</option>
                {(payload?.apps || []).map((a) => <option key={a.slug} value={a.slug}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <label className={AdminUI.label} htmlFor="admin-homeroom-bot-run-issue">Issue #</label>
              <input
                id="admin-homeroom-bot-run-issue"
                type="number" min="1" step="1"
                className={`${AdminUI.input} mt-1 w-28`}
                value={runIssue}
                onChange={(e) => setRunIssue(e.target.value)}
              />
            </div>
            <button type="button" className={AdminUI.btn.outlineSm} disabled={busy !== ''} onClick={runNow}>
              Queue it first
            </button>
            <button
              type="button" id="admin-homeroom-bot-retriage"
              className={AdminUI.btn.outlineSm} disabled={busy !== ''} onClick={retriage}
            >
              Triage every open question again
            </button>
          </div>
        ) : null}
      </div>

      <div className={`${AdminUI.card} p-4`} id="admin-homeroom-bot-optouts">
        <div className={AdminUI.cardHeader}>
          <h3 className={AdminUI.cardTitle}>Asked not to be tagged</h3>
          <span className={AdminUI.cardDescription} id="admin-homeroom-bot-optouts-count">
            {payload ? `${payload.mentionOptOuts.total} ${payload.mentionOptOuts.total === 1 ? 'person' : 'people'}` : ''}
          </span>
        </div>
        <p className={`${AdminUI.muted} mb-2`}>
          The bot tags whoever filed an issue and whoever took part in it, except these people, who asked
          it to stop on that issue. They are tagged again when they say so there. Tag again from here only
          when the bot misread what somebody said.
        </p>
        {payload && payload.mentionOptOuts.items.length ? (
          <ul className="text-sm space-y-1" id="admin-homeroom-bot-optouts-list">
            {payload.mentionOptOuts.items.map((o) => (
              <li key={`${o.app_slug}-${o.issue_number}-${o.username}`} className="flex flex-wrap items-center gap-2"
                data-optout={`${o.app_slug}#${o.issue_number}@${o.username}`}>
                <span>{`@${o.username} on ${o.app_name} #${o.issue_number}`}</span>
                <span className={AdminUI.muted}>{`since ${when(o.created_at)}`}</span>
                {canWrite ? (
                  <button type="button" className={AdminUI.btn.outlineSm} disabled={busy !== ''} onClick={() => tagAgain(o)}>
                    Tag again
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className={AdminUI.muted} id="admin-homeroom-bot-optouts-none">Nobody has asked.</p>
        )}
      </div>

      <div className={`${AdminUI.card} p-4`}>
        <div className={AdminUI.cardHeader}>
          <h3 className={AdminUI.cardTitle}>Verdicts</h3>
          <div className="flex flex-wrap items-center gap-2">
            <select
              id="admin-homeroom-bot-filter-app"
              className={AdminUI.select}
              aria-label="Filter by app"
              value={appFilter}
              onChange={(e) => setAppFilter(e.target.value)}
            >
              <option value="">All apps</option>
              {(payload?.apps || []).map((a) => <option key={a.slug} value={a.slug}>{a.name}</option>)}
            </select>
            <select
              id="admin-homeroom-bot-filter-verdict"
              className={AdminUI.select}
              aria-label="Filter by verdict"
              value={verdictFilter}
              onChange={(e) => setVerdictFilter(e.target.value)}
            >
              <option value="">All verdicts</option>
              <option value="question">Needs a question</option>
              <option value="ready">Ready to build</option>
              <option value="empty">Nothing to build</option>
              <option value="person">Needs a person</option>
              <option value="answer">Answered (follow-up)</option>
              <option value="revise">Revised its proposal</option>
              <option value="failed">Failed</option>
              <option value="budget">Stopped on budget</option>
            </select>
            {canWrite ? (
              <a
                id="admin-homeroom-bot-export"
                className={AdminUI.btn.outlineSm}
                href={exportHref}
                download
              >Download CSV</a>
            ) : null}
          </div>
        </div>
        <div className={AdminUI.tableWrap}>
          <table className={AdminUI.table} id="admin-homeroom-bot-table">
            <thead className={AdminUI.thead}>
              <tr>
                <th className={AdminUI.th}>When</th>
                <th className={AdminUI.th}>App</th>
                <th className={AdminUI.th}>Issue</th>
                <th className={AdminUI.th}>Verdict</th>
                <th className={AdminUI.th}>Cost</th>
                <th className={AdminUI.th}>Rating</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const isOpen = !!open[run.id];
                const ratingLabel = run.verdict === 'question' ? 'Right question?' : run.verdict === 'ready' ? 'Would you have built this?' : 'Agree?';
                return [
                  <tr className={AdminUI.trHover} key={run.id} data-homeroom-bot-run={run.id} data-verdict={run.verdict}>
                    <td className={`${AdminUI.td} whitespace-nowrap`}>{when(run.created_at)}</td>
                    <td className={AdminUI.td}>
                      <span>{run.app_name}</span>
                      {canWrite ? (
                        <button
                          type="button"
                          className={`${AdminUI.btn.ghost} ml-2 text-xs`}
                          disabled={busy !== ''}
                          onClick={() => togglePause(run.app_slug)}
                        >{paused.has(run.app_slug) ? 'resume' : 'pause'}</button>
                      ) : null}
                    </td>
                    <td className={AdminUI.td}>
                      {run.issueUrl
                        ? <a className={AdminUI.btn.link} href={run.issueUrl}>#{run.issue_number}</a>
                        : <span>#{run.issue_number}</span>}
                    </td>
                    <td className={AdminUI.td}>
                      <button
                        type="button"
                        className="text-left"
                        aria-expanded={isOpen}
                        onClick={() => setOpen((o) => ({ ...o, [run.id]: !isOpen }))}
                      >
                        <span className={run.budget_stop ? AdminUI.badge.warn : VERDICT_BADGE[run.verdict]}>
                          {run.budget_stop ? `Stopped: ${run.budget_stop}` : VERDICT_LABEL[run.verdict]}
                        </span>
                        {run.cap_suppressed ? <span className={`${AdminUI.badge.outline} ml-1`}>held</span> : null}
                        {isFollowUp(run) ? <span className={`${AdminUI.badge.outline} ml-1`}>follow-up</span> : null}
                        <span className={`${AdminUI.muted} ml-2`}>{isOpen ? 'hide' : 'show'}</span>
                      </button>
                    </td>
                    <td className={`${AdminUI.td} whitespace-nowrap`}>{money(run.cost_usd)}</td>
                    <td className={`${AdminUI.td} whitespace-nowrap`}>
                      {run.verdict === 'failed' ? (
                        <span className={AdminUI.muted}>–</span>
                      ) : canWrite ? (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            className={run.rating === 'yes' ? AdminUI.btn.primarySm : AdminUI.btn.outlineSm}
                            disabled={busy !== ''}
                            title={ratingLabel}
                            onClick={() => rate(run, run.rating === 'yes' ? null : 'yes')}
                          >Yes</button>
                          <button
                            type="button"
                            className={run.rating === 'no' ? AdminUI.btn.destructiveSm : AdminUI.btn.outlineSm}
                            disabled={busy !== ''}
                            title={ratingLabel}
                            onClick={() => rate(run, run.rating === 'no' ? null : 'no')}
                          >No</button>
                        </div>
                      ) : (
                        <span className={AdminUI.muted}>{run.rating ? `${run.rating}${run.rated_by ? ` (${run.rated_by})` : ''}` : 'unrated'}</span>
                      )}
                    </td>
                  </tr>,
                  isOpen ? (
                    <tr key={`${run.id}-detail`} data-homeroom-bot-detail={run.id}>
                      <td className={AdminUI.td} colSpan={6}>
                        <div className="space-y-2">
                          <div className={AdminUI.muted}>{ratingLabel}</div>
                          <VerdictBody run={run} />
                          <div className={`${AdminUI.muted} flex flex-wrap gap-x-4 gap-y-1`}>
                            {run.mode === 'live' ? <span>live: acted on the issue</span> : null}
                            <span>determined: {run.determined == null ? '–' : run.determined ? 'yes' : 'no'}</span>
                            {run.missing_fact ? <span>missing: {run.missing_fact}</span> : null}
                            {run.cap_suppressed ? <span>{CAP_LABEL[run.cap_suppressed] || run.cap_suppressed}</span> : null}
                            {run.model ? <span>{run.model}</span> : null}
                            {run.duration_ms != null ? <span>{Math.round(run.duration_ms / 1000)}s</span> : null}
                            {run.rating_note ? <span>note: {run.rating_note}</span> : null}
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : null,
                ];
              })}
              {runs.length === 0 ? (
                <tr>
                  <td className={AdminUI.td} colSpan={6} id="admin-homeroom-bot-empty">
                    {payload
                      ? (settings?.mode === 'off'
                        ? 'No verdicts yet. Switch the mode to shadow and the first pass starts within two minutes.'
                        : 'No verdicts yet for this filter.')
                      : 'Loading…'}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

let host: Element | null = null;

const AdminHomeroomBot = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <HomeroomBotSection />);
  },

  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminHomeroomBot = AdminHomeroomBot;

export { AdminHomeroomBot };
