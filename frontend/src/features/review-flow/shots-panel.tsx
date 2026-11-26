/**
 * The rest of a change's before & after, around the one viewer
 * (./shots-viewer.tsx):
 *
 *   ShotsRun     where a run stands before it has shots to show: taking them,
 *                failed, stopped, waived, never started. Its words, the
 *                changes declared, the two builds, and Take the screenshots
 *                again or Stop where they apply.
 *   ShotsPanel   the whole Before & after as the About sheet and the admin
 *                Screenshot gallery show it: the viewer with each change's
 *                steps, the builds behind "Screenshot details", and Take the
 *                screenshots again; or the run's state, with the previous
 *                version's shots under it until this version's are taken.
 *   ShotDetails  Details' "Before & after" part: how each change was reached,
 *                at which sizes and as whom, and the builds; or, for a run
 *                that failed, what happened.
 *
 * The state words are the change page's own (AppView._shotsStateCopy), and
 * the two buttons call AppView.rerunShots and AppView.stopShots, which the
 * routes check: only the change's author or a project admin may take the
 * screenshots again.
 */

import type { ReactNode } from 'react';

import { RichMessage, useMessages } from '../../lib/i18n/react';
import { listText } from '../../lib/i18n/runtime';
import { readShots, shortSha, shownShots } from './shots-model';
import { ShotsViewer, seenAsText, sizeName, type ShotsSource } from './shots-viewer';

type Raw = Record<string, any>;

const RUNNING = ['provisioning', 'exploring', 'replaying', 'reviewing'];

function legacy(): any {
  return typeof window !== 'undefined' ? (window as any).AppView || null : null;
}

function rawOf(source: ShotsSource): Raw | null {
  return source.shots && typeof source.shots === 'object' ? source.shots as Raw : null;
}

const code = <code />;

/** "before abc12345 → after def67890": the two builds the shots were taken on. */
function Provenance({ base, head }: { base: unknown; head: unknown }): ReactNode {
  const t = useMessages('changes');
  const commit = (sha: unknown) => shortSha(typeof sha === 'string' ? sha : null) || t('changes:shots.card.unknownCommit');
  return (
    <>
      <span><RichMessage id="changes:shots.card.beforeCommit" values={{ commit: commit(base) }} components={[code]} /></span>
      <span aria-hidden="true">→</span>
      <span><RichMessage id="changes:shots.card.afterCommit" values={{ commit: commit(head) }} components={[code]} /></span>
    </>
  );
}

function PlanHash({ hash }: { hash: unknown }): ReactNode {
  const t = useMessages('changes');
  const value = typeof hash === 'string' && hash ? hash.slice(0, 12) : t('changes:shots.card.unknownPlan');
  return <span><RichMessage id="changes:shots.card.planHash" values={{ hash: value }} components={[code]} /></span>;
}

function TakeAgain({ sessionId }: { sessionId: number }): ReactNode {
  const t = useMessages('changes');
  return (
    <button
      type="button"
      data-shots-retake="1"
      className="text-xs font-medium text-violet-700 dark:text-violet-400"
      onClick={(e) => legacy()?.rerunShots?.(sessionId, e.currentTarget)}
    >
      {t('changes:shots.card.takeAgain')}
    </button>
  );
}

/** Where a run stands while it has no shots of its own to show. */
export function ShotsRun({ source, details = false, canRetake = false }: {
  source: ShotsSource;
  /** Details' reading: Take the screenshots again only for whoever may press it. */
  details?: boolean;
  canRetake?: boolean;
}): ReactNode {
  const t = useMessages('changes');
  const shots = rawOf(source);
  if (!shots) return null;
  const state = String(shots.state || 'planned');
  const av = legacy();
  const copy: [string, string] = (av?._shotsStateCopy?.(shots) || {})[state]
    || [t('changes:shots.state.pending.label'), t('changes:shots.state.pending.detail')];
  const autoRetry = shots.automaticRetryPending === true;
  const notStarted = !!av?._shotsNotStarted?.(shots);
  // A run that never started can be kicked: the rerun route takes a planned
  // run. Not while an automatic retry is coming.
  const retryable = (state === 'failed' && !autoRetry && (shots.repairAvailable === true || shots.failureCode === 'shots_stopped')) || notStarted;
  const sessionId = Number(source.sessionId);
  const known = Number.isInteger(sessionId) && sessionId > 0;
  const retry = (details ? canRetake : retryable) && known;
  const stop = RUNNING.includes(state) && known;
  const red = state === 'failed' && shots.failureCode !== 'shots_stopped' && !autoRetry;
  const claims: Raw[] = (Array.isArray(shots.claims) ? shots.claims : []).slice(0, 3);
  const zone = typeof window !== 'undefined' ? (window as any).PlatformI18n?.timeZone?.() : null;
  return (
    <section data-shots="1" data-shots-state={state} className="rounded-lg border border-zinc-200 bg-zinc-50/70 p-3 dark:border-zinc-800 dark:bg-zinc-900/60">
      <div className="flex items-center justify-between gap-3">
        <strong className="text-sm">{copy[0]}</strong>
        <span className={red ? 'dev-badge bg-red-500/10 text-red-700 dark:text-red-400' : 'dev-badge bg-zinc-500/10 text-zinc-600 dark:text-zinc-400'}>{copy[0]}</span>
      </div>
      <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">{copy[1]}</p>
      {claims.length ? (
        <ul className="mt-2 list-disc ps-4 text-xs text-zinc-700 dark:text-zinc-300">
          {claims.map((claim, i) => <li key={i}>{String((claim && claim.claim) || '')}</li>)}
        </ul>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[0.68rem] text-zinc-500 dark:text-zinc-400">
        <Provenance base={shots.baseSha} head={shots.headSha} />
        {retry ? <TakeAgain sessionId={sessionId} /> : null}
        {stop ? (
          <button
            type="button"
            data-shots-stop="1"
            className="text-xs font-medium text-violet-700 dark:text-violet-400"
            onClick={(e) => av?.stopShots?.(sessionId, e.currentTarget)}
          >
            {t('changes:shots.card.stop')}
          </button>
        ) : null}
      </div>
      {state === 'overridden' && shots.overriddenAt ? (
        <div className="text-[0.68rem] text-zinc-500 dark:text-zinc-400">
          {t('changes:shots.card.overriddenAt', { when: new Date(shots.overriddenAt).toLocaleString(undefined, zone ? { timeZone: zone } : {}) })}
        </div>
      ) : null}
    </section>
  );
}

/** The whole Before & after: the About sheet's and the admin Screenshot gallery's. */
export function ShotsPanel({ source }: { source: ShotsSource }): ReactNode {
  const t = useMessages('changes');
  const shots = rawOf(source);
  if (!shots) return null;
  if (String(shots.state || '') !== 'verified') {
    // The previous version's shots stay under this version's state until
    // this version's are taken.
    const previous = shownShots(shots);
    return (
      <>
        <ShotsRun source={source} />
        {previous ? <div className="mt-3" data-shots-previous="1"><ShotsPanel source={{ shots: previous, sessionId: source.sessionId }} /></div> : null}
      </>
    );
  }
  const model = readShots(shots, { sessionId: source.sessionId });
  if (!model) return null;
  const sessionId = Number(source.sessionId);
  const introId = model.previousVersion ? 'changes:shots.card.previousIntro'
    : model.afterOnly ? (model.withClips ? 'changes:shots.card.introNewAppClips' : 'changes:shots.card.introNewApp')
      : (model.withClips ? 'changes:shots.card.introClips' : 'changes:shots.card.intro');
  return (
    <section
      data-shots-panel="1"
      data-shots-state={model.previousVersion ? 'previous' : 'verified'}
      aria-label={t('changes:shots.card.label')}
      className="space-y-3"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-zinc-600 dark:text-zinc-400">{t(introId)}</p>
        {model.previousVersion
          ? <span className="dev-badge bg-zinc-500/10 text-zinc-600 dark:text-zinc-400" data-shots-previous-badge="1">{t('changes:shots.card.previousBadge')}</span>
          : <span className="dev-badge bg-violet-500/10 text-violet-700 dark:text-violet-400">{t('changes:shots.card.readyBadge')}</span>}
      </div>
      <ShotsViewer source={source} steps />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <details className="text-xs text-zinc-600 dark:text-zinc-400">
          <summary className="cursor-pointer font-medium">{t('changes:shots.card.details')}</summary>
          <div className="mt-1 flex flex-wrap gap-2">
            <Provenance base={shots.baseSha} head={shots.headSha} />
            <PlanHash hash={shots.planHash} />
            {model.takenByAgent ? <span>{t('changes:shots.card.takenByAgent')}</span> : null}
          </div>
        </details>
        {/* The previous version's are not this version's to take again. */}
        {Number.isInteger(sessionId) && sessionId > 0 && !model.previousVersion ? <TakeAgain sessionId={sessionId} /> : null}
      </div>
    </section>
  );
}

/** Whether Details has a Before & after part for these shots. */
export function shotDetailsShown(shots: unknown): boolean {
  if (!shots || typeof shots !== 'object') return false;
  const raw = shots as Raw;
  const state = String(raw.state || '');
  return state === 'verified' || (state === 'failed' && raw.automaticRetryPending !== true);
}

/** Details' Before & after part: how each change was reached, and the builds. */
export function ShotDetails({ source, canRetake = false }: { source: ShotsSource; canRetake?: boolean }): ReactNode {
  const t = useMessages('changes');
  const shots = rawOf(source);
  if (!shots || !shotDetailsShown(shots)) return null;
  if (String(shots.state) !== 'verified') return <ShotsRun source={source} details canRetake={canRetake} />;
  const model = readShots(shots, { sessionId: source.sessionId });
  if (!model) return null;
  return (
    <>
      {model.claims.length ? (
        <ol className="dev-shot-details-claims">
          {model.claims.map((claim) => (
            <li key={claim.id || claim.n} className="dev-shot-details-claim" data-shots-detail={claim.id}>
              <strong>{claim.text}</strong>
              <div className="dev-shot-details-meta">
                {t('changes:facts.pair', { first: listText(claim.viewports.map((v) => sizeName(t, v))), second: seenAsText(t, [claim.persona]) })}
              </div>
              {claim.steps.length ? (
                <div className="dev-shot-details-flow">
                  {claim.steps.map((step, i) => <span key={i}>{i ? <span aria-hidden="true"> → </span> : null}{step}</span>)}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      <p className="dev-shot-details-builds">
        {t('changes:shots.details.builds')} <Provenance base={shots.baseSha} head={shots.headSha} />
        <PlanHash hash={shots.planHash} />
      </p>
    </>
  );
}
