'use strict';

// #2380 — end-to-end coordinator for exact-revision visual evidence. This
// module deliberately separates model exploration from deterministic replay:
// the evidence agent can submit a plan through RunControl, while only these
// callbacks may reset fixtures, execute the plan twice, store bytes, or move
// the durable run to verified.

const appManifest = require('./app-manifest');
const github = require('./github');
const log = require('./logger');
const evidenceAgent = require('./visual-evidence-agent');
const evidenceControl = require('./visual-evidence-control');
const environment = require('./visual-evidence-environment');
const identities = require('./visual-evidence-identities');
const planContract = require('./visual-evidence-plan');
const replay = require('./visual-evidence-replay');
const reviewer = require('./visual-evidence-reviewer');
const state = require('./visual-evidence-state');
const worker = require('./worker');

const ACTIVE_STATES = new Set(['planned', 'provisioning', 'exploring', 'replaying', 'reviewing']);
const DIFF_CONTEXT_CHARS = 8_000;
const inFlight = new Map();

class VisualEvidenceOrchestrationError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'VisualEvidenceOrchestrationError';
    this.code = code;
    this.detail = detail;
  }
}

function exactSha(value) {
  const sha = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

function headForSession(session, explicit = null) {
  return exactSha(explicit)
    || exactSha(session.imported_pr_head_sha)
    // Once a proposal is promoted, reviewed_head_sha is the authoritative
    // revision reviewers and votes describe. A native handoff pin can lag it
    // after a same-proposal update, so it must not win merely because it was
    // written earlier in the lifecycle.
    || exactSha(session.reviewed_head_sha)
    || exactSha(session.checks_commit_sha)
    || exactSha(session.handoff_head_sha)
    || exactSha(session.staging_commit_sha)
    || null;
}

function intentForSession(session) {
  const detail = session?.visual_evidence_detail;
  return detail && typeof detail === 'object' && detail.intent
    ? planContract.parseIntent(detail.intent)
    : null;
}

function uiFileHeuristic(files) {
  return (files || []).some((name) => /(?:^|\/)(?:frontend|public|client|web|ui|components?|pages?|views?|styles?)(?:\/|$)/i.test(name)
    || /\.(?:html?|css|scss|sass|less|tsx?|jsx?|vue|svelte|svg)$/i.test(name));
}

function publicSessionAndApp(row) {
  return {
    session: row,
    app: {
      id: row.app_id,
      slug: row.app_slug,
      name: row.app_name,
      repo_url: row.repo_url,
      manifest_snapshot: row.manifest_snapshot,
    },
  };
}

async function loadSession(pool, sessionId) {
  const { rows } = await pool.query(
    `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url,
            a.manifest_snapshot
       FROM chat_sessions cs
       JOIN apps a ON a.id = cs.app_id
      WHERE cs.id = $1`,
    [sessionId]
  );
  if (!rows[0]) throw new VisualEvidenceOrchestrationError('session_not_found', 'Proposal session not found.');
  return rows[0];
}

async function resolveRevisionContext(session, explicitHead = null, githubService = github) {
  const headSha = headForSession(session, explicitHead);
  if (!headSha) {
    throw new VisualEvidenceOrchestrationError(
      'missing_evidence_head',
      'The visual change preview cannot start until the proposal has an exact submitted head commit.'
    );
  }
  const { owner, repo } = environment.repoParts(session.repo_url);
  let baseSha = exactSha(session.handoff_base_sha);
  let comparison = null;
  if (!baseSha) {
    const repository = await githubService.getRepoHead(owner, repo);
    comparison = await githubService.compareRefs(owner, repo, `${repository.defaultBranch}...${headSha}`);
    baseSha = exactSha(comparison.mergeBaseSha);
  }
  if (!baseSha) {
    throw new VisualEvidenceOrchestrationError(
      'missing_evidence_base',
      'GitHub did not return an exact merge base for this proposal revision.'
    );
  }
  if (!comparison) {
    comparison = await githubService.compareRefs(owner, repo, `${baseSha}...${headSha}`);
  }
  let diffSummary = null;
  if (typeof githubService.getProposalDiff === 'function') {
    try {
      const summary = await githubService.getProposalDiff(
        owner, repo, `${baseSha}...${headSha}`, DIFF_CONTEXT_CHARS
      );
      diffSummary = {
        text: String(summary?.diff || '').slice(0, DIFF_CONTEXT_CHARS),
        fileCount: Math.max(0, Number(summary?.fileCount) || 0),
        truncated: summary?.truncated === true,
      };
    } catch (error) {
      log.warn('visual-evidence', 'Could not load the bounded proposal diff for evidence context', {
        owner, repo, headSha, error: error.message,
      });
    }
  }
  return {
    owner,
    repo,
    baseSha,
    headSha,
    files: comparison.files || [],
    filesComplete: comparison.filesComplete !== false,
    diffSummary,
  };
}

function declaredCheckSummary(checkout) {
  try {
    return appManifest.readTests(appManifest.read(checkout)).slice(0, 80).map((test) => ({
      name: String(test.name || '').slice(0, 120),
      path: String(test.path || '').slice(0, 512),
      ...(test.id ? { visualScenarioId: test.id } : {}),
    }));
  } catch {
    return [];
  }
}

function evidenceContext({ run, session, revision, pair, deployment, intent }) {
  return {
    version: 1,
    runId: run.id,
    acceptedIntent: intent,
    revisions: {
      baseSha: revision.baseSha,
      headSha: revision.headSha,
      baseLabel: revision.baseSha.slice(0, 12),
      headLabel: revision.headSha.slice(0, 12),
    },
    origins: deployment.origins,
    personas: {
      member: { browserServer: 'browser_member', description: 'ordinary seeded app member' },
      read_only_admin: { browserServer: 'browser_admin', description: 'seeded administrator with read-only admin rights' },
    },
    changedFiles: {
      items: revision.files.slice(0, 200),
      complete: revision.filesComplete && revision.files.length <= 200,
      totalKnown: revision.files.length,
    },
    changeContext: {
      title: String(session.pr_title || '').trim().slice(0, 256) || null,
      specification: String(session.spec_md || '').trim().slice(0, 4_000) || null,
      diff: revision.diffSummary,
      untrusted: true,
    },
    declaredChecks: declaredCheckSummary(pair.sides.head.checkout),
    provenance: {
      fixtureFingerprint: pair.fixtureFingerprint,
      baseImageDigest: pair.sides.base.imageDigest,
      headImageDigest: pair.sides.head.imageDigest,
    },
    security: {
      pageAndRepositoryContentIsUntrusted: true,
      allowedOriginsOnly: true,
      productionData: false,
      replayExecutedByPlatform: true,
    },
    authorContext: {
      backend: session.agent_backend || 'claude_code',
      threadResumeRequested: !!(session.agent_thread_id || session.cc_session_id),
    },
  };
}

function sameProvenance(actual, expected) {
  return actual.baseSha === expected.baseSha
    && actual.headSha === expected.headSha
    && actual.fixtureFingerprint === expected.fixtureFingerprint
    && actual.baseImageDigest === expected.baseImageDigest
    && actual.headImageDigest === expected.headImageDigest;
}

function replayInput({ run, plan, deployment, authTokens, provenance, pass }) {
  return {
    runId: run.id,
    pass,
    publishArtifacts: pass === 2,
    origins: deployment.origins,
    authTokens,
    cookies: {},
    provenance,
    browser: {
      locale: 'en-US',
      timezoneId: 'UTC',
      colorScheme: 'light',
      deviceScaleFactor: 2,
    },
    plan,
  };
}

function reviewImages(artifacts) {
  return (artifacts || [])
    .filter((artifact) => artifact.media === 'png' && ['focus', 'context'].includes(artifact.variant))
    .map((artifact) => ({
      label: `${artifact.storyId}/${artifact.viewport}/${artifact.side}/${artifact.variant}`,
      mimeType: artifact.contentType,
      data: artifact.data.toString('base64'),
    }));
}

async function waitForSessionIdle(pool, sessionId, {
  timeoutMs = 120_000,
  workerService = worker,
  intervalMs = 500,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await pool.query('SELECT active_turn FROM chat_sessions WHERE id = $1', [sessionId]);
    if (!rows[0]) throw new VisualEvidenceOrchestrationError('session_not_found', 'Proposal session not found.');
    if (!rows[0].active_turn && !workerService.isInFlight(sessionId)) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new VisualEvidenceOrchestrationError(
    'evidence_agent_busy',
    'The proposal agent stayed busy past the visual change preview start window.'
  );
}

function semanticFromFinish(finish) {
  if (finish?.status === 'verified') {
    return {
      relevant: true,
      focusAccurate: true,
      needsRepair: false,
      reason: finish.reason,
      reviewer: 'author_agent',
    };
  }
  if (finish) {
    return {
      relevant: false,
      focusAccurate: false,
      needsRepair: true,
      reason: finish.reason,
      reviewer: 'author_agent',
      authorStatus: finish.status,
    };
  }
  return null;
}

function errorCode(error) {
  return String(error?.code || 'visual_evidence_failed').slice(0, 64);
}

function visibleError(error) {
  const message = String(error?.message || 'The visual change preview could not be produced.').trim();
  return message.slice(0, 2000) || 'The visual change preview could not be produced.';
}

function newRunMetrics() {
  return {
    startedAtMs: Date.now(),
    timingsMs: {
      idleWait: 0,
      provisioning: 0,
      agentExploration: 0,
      replay: 0,
      semanticReview: 0,
      artifactPersist: 0,
      cleanup: 0,
    },
    replayPasses: [],
    agentAttempts: 0,
    repairCount: 0,
    artifactBytes: 0,
    tokenUsage: {},
  };
}

function addTiming(metrics, key, startedAtMs) {
  const elapsed = Math.max(0, Date.now() - startedAtMs);
  metrics.timingsMs[key] = Math.max(0, Number(metrics.timingsMs[key]) || 0) + elapsed;
  return elapsed;
}

function addAgentUsage(metrics, dispatched) {
  const result = dispatched?.result;
  if (!result || typeof result !== 'object') return;
  for (const key of [
    'inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens',
    'outputTokens', 'reasoningOutputTokens', 'costCents',
  ]) {
    if (result[key] == null) continue;
    const value = Number(result[key]);
    if (!Number.isFinite(value) || value < 0) continue;
    metrics.tokenUsage[key] = (metrics.tokenUsage[key] || 0) + value;
  }
}

function traceSummary(metrics, extra = {}) {
  return {
    ...extra,
    timingsMs: {
      ...metrics.timingsMs,
      total: Math.max(0, Date.now() - metrics.startedAtMs),
    },
    replayPasses: metrics.replayPasses.slice(0, 12),
    agentAttempts: metrics.agentAttempts,
    repairCount: metrics.repairCount,
    artifactBytes: metrics.artifactBytes,
    ...(Object.keys(metrics.tokenUsage).length ? { tokenUsage: { ...metrics.tokenUsage } } : {}),
  };
}

function notifyEvidence(session, app, evidenceState, extra = {}) {
  try {
    require('./ws').pushVoteUpdate({
      sessionId: Number(session.id),
      appId: app?.id || session.app_id || null,
      appSlug: app?.slug || session.app_slug || null,
      merged: false,
      action: 'visual_evidence',
      visualEvidenceState: evidenceState,
      ...extra,
    });
  } catch (_) { /* live refresh is best-effort; durable state is authoritative */ }
}

async function failCurrentRun(pool, runId, error, stateService = state, runTrace = null) {
  try {
    const current = await stateService.getRun(pool, runId);
    if (current.current_run_id !== current.id || !ACTIVE_STATES.has(current.state)) return false;
    await stateService.transitionRun(pool, runId, 'failed', {
      failureCode: errorCode(error),
      failureReason: visibleError(error),
      ...(runTrace ? { traceSummary: runTrace } : {}),
    });
    return true;
  } catch (transitionError) {
    if (!['stale_evidence_operation', 'invalid_evidence_transition'].includes(transitionError?.code)) {
      log.warn('visual-evidence', 'Could not terminalize failed evidence run', {
        runId,
        code: transitionError?.code,
        error: transitionError?.message,
      });
    }
    return false;
  }
}

async function executeRun(config, options, injected = {}) {
  const deps = {
    state: injected.state || state,
    environment: injected.environment || environment,
    identities: injected.identities || identities,
    replay: injected.replay || replay,
    reviewer: injected.reviewer || reviewer,
    evidenceAgent: injected.evidenceAgent || evidenceAgent,
    evidenceControl: injected.evidenceControl || evidenceControl,
    worker: injected.worker || worker,
  };
  const { pool, revision, onProgress = null } = options;
  let run = options.run;
  let session = options.session;
  let app = options.app;
  let pair = null;
  let registration = null;
  let latestArtifacts = null;
  let latestPlanHash = null;
  let latestHardVerdict = null;
  let agentThreadId;
  const metrics = newRunMetrics();
  const agentDeadline = Date.now() + (config.visualEvidence?.maxAgentMs || 240_000);
  const progress = (message) => {
    if (typeof onProgress === 'function') onProgress(message);
  };

  try {
    if (!run || !session || !app) {
      const current = await deps.state.getRun(pool, options.runId);
      const row = await loadSession(pool, current.session_id);
      ({ session, app } = publicSessionAndApp(row));
      run = current;
    }
    if (run.current_run_id && run.current_run_id !== run.id) {
      throw new VisualEvidenceOrchestrationError('stale_evidence_operation', 'This visual change preview run was superseded before it started.');
    }
    const intent = planContract.parseIntent(run.intent || intentForSession(session));
    if (run.state === 'not_required') return deps.state.getForSession(pool, session.id, { headSha: run.head_sha });

    const idleStartedAt = Date.now();
    await waitForSessionIdle(pool, session.id, {
      timeoutMs: Math.min(config.visualEvidence?.maxRunMs || 720_000, 120_000),
      workerService: deps.worker,
    });
    addTiming(metrics, 'idleWait', idleStartedAt);
    progress('Preparing exact base and head revisions for visual evidence…');
    const provisioningStartedAt = Date.now();
    await deps.state.transitionRun(pool, run.id, 'provisioning', { startedAt: new Date() });
    notifyEvidence(session, app, 'provisioning');
    pair = await deps.environment.preparePair(config, { pool, run, session, app, onProgress });
    const exploration = await deps.environment.resetPair(config, pair);
    const expectedProvenance = {
      baseSha: run.base_sha,
      headSha: run.head_sha,
      fixtureFingerprint: pair.fixtureFingerprint,
      baseImageDigest: pair.sides.base.imageDigest,
      headImageDigest: pair.sides.head.imageDigest,
    };
    if (!sameProvenance(exploration, expectedProvenance)) {
      throw new VisualEvidenceOrchestrationError('evidence_provenance_mismatch', 'The paired exploration environment did not match its prepared fixture and images.');
    }
    const authTokens = await deps.identities.mintEvidenceAuthTokens(pool, app.id);
    await deps.state.transitionRun(pool, run.id, 'exploring', {
      fixtureFingerprint: pair.fixtureFingerprint,
      baseImageDigest: pair.sides.base.imageDigest,
      headImageDigest: pair.sides.head.imageDigest,
    });
    addTiming(metrics, 'provisioning', provisioningStartedAt);
    notifyEvidence(session, app, 'exploring');

    const context = evidenceContext({ run, session, revision, pair, deployment: exploration, intent });
    registration = deps.evidenceControl.registerRun({
      runId: run.id,
      sessionId: session.id,
      intent,
      context,
      expiresAt: Date.now() + (config.visualEvidence?.maxRunMs || 720_000),
      resetSide: async (side) => {
        const reset = await deps.environment.resetPair(config, pair);
        if (!sameProvenance(reset, expectedProvenance)) {
          throw new VisualEvidenceOrchestrationError('evidence_provenance_mismatch', 'The exploration reset changed the paired fixture or image.');
        }
        return { side, origin: reset.origins[side], bothSidesReset: true };
      },
      runPlan: async (plan, { attempt }) => {
        const replayStartedAt = Date.now();
        progress(attempt === 1
          ? 'Replaying the agent-authored UI flow twice…'
          : 'Replaying the corrected UI flow twice…');
        await deps.state.transitionRun(pool, run.id, 'replaying', {
          replayPlan: plan,
          planHash: planContract.planHash(plan),
          repairAttempt: attempt - 1,
        });
        notifyEvidence(session, app, 'replaying');
        const planHash = planContract.planHash(plan);
        const firstDeployment = await deps.environment.resetPair(config, pair);
        if (!sameProvenance(firstDeployment, expectedProvenance)) {
          throw new VisualEvidenceOrchestrationError('evidence_provenance_mismatch', 'Replay pass one did not use the prepared fixture and images.');
        }
        const firstStartedAt = Date.now();
        const first = await deps.replay.runPass(
          config,
          session.id,
          replayInput({ run, plan, deployment: firstDeployment, authTokens, provenance: expectedProvenance, pass: 1 }),
          { onEvent: (event) => progress(`Evidence pass 1: ${event.type}`), previewRunId: run.id }
        );
        metrics.replayPasses.push({
          attempt,
          pass: 1,
          durationMs: Math.max(0, Date.now() - firstStartedAt),
        });
        const secondDeployment = await deps.environment.resetPair(config, pair);
        if (!sameProvenance(secondDeployment, expectedProvenance)) {
          throw new VisualEvidenceOrchestrationError('evidence_provenance_mismatch', 'Replay pass two did not use the prepared fixture and images.');
        }
        const secondStartedAt = Date.now();
        const second = await deps.replay.runPass(
          config,
          session.id,
          replayInput({ run, plan, deployment: secondDeployment, authTokens, provenance: expectedProvenance, pass: 2 }),
          { onEvent: (event) => progress(`Evidence pass 2: ${event.type}`), previewRunId: run.id }
        );
        metrics.replayPasses.push({
          attempt,
          pass: 2,
          durationMs: Math.max(0, Date.now() - secondStartedAt),
        });
        const hardVerdict = deps.replay.comparePasses(first, second, {
          plan,
          provenance: expectedProvenance,
          runId: run.id,
        });
        if (!hardVerdict.passed) {
          throw new VisualEvidenceOrchestrationError(hardVerdict.code, hardVerdict.reason);
        }
        const replayTrace = traceSummary(metrics, {
          planHash,
          runs: 2,
          stories: hardVerdict.stories,
          relativePointer: hardVerdict.relativePointer,
        });
        await deps.state.transitionRun(pool, run.id, 'reviewing', {
          hardVerdict,
          traceSummary: replayTrace,
          repairAttempt: attempt - 1,
        });
        notifyEvidence(session, app, 'reviewing');
        const artifactPersistStartedAt = Date.now();
        await deps.replay.storeArtifacts(pool, run.id, second.artifacts, {
          headSha: run.head_sha,
          planHash,
        });
        addTiming(metrics, 'artifactPersist', artifactPersistStartedAt);
        addTiming(metrics, 'replay', replayStartedAt);
        metrics.artifactBytes = second.artifacts.reduce(
          (sum, artifact) => sum + Math.max(0, Number(artifact.bytes) || artifact.data?.length || 0),
          0
        );
        latestArtifacts = second.artifacts;
        latestPlanHash = planHash;
        latestHardVerdict = hardVerdict;
        return {
          hardVerdict,
          planHash,
          traceSummary: traceSummary(metrics, {
            planHash,
            runs: 2,
            stories: hardVerdict.stories,
            relativePointer: hardVerdict.relativePointer,
          }),
          images: reviewImages(second.artifacts),
        };
      },
    });

    const dispatchOnce = async (repairReason = null, forceBackend = null) => {
      const dispatchStartedAt = Date.now();
      metrics.agentAttempts += 1;
      try {
        const remainingAgentMs = agentDeadline - Date.now();
        if (remainingAgentMs <= 0) {
          throw new VisualEvidenceOrchestrationError(
            'evidence_agent_timeout',
            'The preview agent used its bounded exploration and review time.'
          );
        }
        const dispatched = await deps.evidenceAgent.dispatch(config, {
          pool,
          session,
          runId: run.id,
          origins: exploration.origins,
          authTokens,
          onProgress: (line) => progress(`Evidence agent: ${line}`),
          resumeThreadId: agentThreadId,
          repairReason,
          forceBackend,
          timeoutMs: remainingAgentMs,
        }, injected.agentDependencies || {});
        addAgentUsage(metrics, dispatched);
        agentThreadId = dispatched.threadId || agentThreadId || null;
        return { dispatched, error: null };
      } catch (error) {
        return { dispatched: null, error };
      } finally {
        addTiming(metrics, 'agentExploration', dispatchStartedAt);
      }
    };

    progress('The proposal agent is exploring the changed UI…');
    let agentOutcome = await dispatchOnce(null);
    if (agentOutcome.error && !latestHardVerdict
        && registration.control.planCalls === 0
        && session.agent_backend === 'codex_openrouter') {
      progress('The selected Codex model could not start the evidence flow; using the platform vision agent…');
      agentOutcome = await dispatchOnce(null, 'claude_code');
    }
    if (agentOutcome.error && !latestHardVerdict) throw agentOutcome.error;

    const semanticVerdict = async () => {
      const authored = semanticFromFinish(registration.control.finished);
      if (authored) return authored;
      if (!latestHardVerdict || !latestArtifacts) {
        throw new VisualEvidenceOrchestrationError('missing_evidence_replay', 'The preview agent did not submit a replay plan.');
      }
      progress('Checking whether the replay images prove the declared claim…');
      return deps.reviewer.review({
        intent,
        artifacts: latestArtifacts,
        telemetryContext: { sessionId: session.id, runId: run.id },
      });
    };

    let semanticStartedAt = Date.now();
    let semantic = await semanticVerdict();
    addTiming(metrics, 'semanticReview', semanticStartedAt);
    if (!(semantic.relevant === true && semantic.focusAccurate === true)) {
      registration.control.allowRepair(semantic.reason || 'The first evidence did not clearly prove the declared claim.');
      metrics.repairCount = 1;
      progress('The first evidence was not relevant enough; the agent gets one bounded repair…');
      agentOutcome = await dispatchOnce(semantic.reason);
      if (agentOutcome.error && (!latestHardVerdict || Number(registration.control.planCalls) < 2)) {
        throw agentOutcome.error;
      }
      semanticStartedAt = Date.now();
      semantic = await semanticVerdict();
      addTiming(metrics, 'semanticReview', semanticStartedAt);
    }
    if (semantic.relevant !== true || semantic.focusAccurate !== true || !latestPlanHash) {
      throw new VisualEvidenceOrchestrationError(
        'irrelevant_visual_evidence',
        semantic.reason || 'The replay did not clearly demonstrate the declared visual change.'
      );
    }

    // A successful run tears down its exact-revision environment before it
    // becomes reviewer-visible. Cleanup is part of the durable timing trace,
    // and no verified row can leave private fixture runtimes live.
    if (pair) {
      const cleanupStartedAt = Date.now();
      await deps.environment.cleanupPair(config, pair);
      addTiming(metrics, 'cleanup', cleanupStartedAt);
      pair = null;
    }
    const finalTrace = traceSummary(metrics, {
      planHash: latestPlanHash,
      runs: 2,
      stories: latestHardVerdict?.stories || [],
      relativePointer: latestHardVerdict?.relativePointer === true,
      terminalFailureClass: null,
    });
    await deps.state.transitionRun(pool, run.id, 'verified', {
      hardVerdict: latestHardVerdict,
      semanticVerdict: semantic,
      planHash: latestPlanHash,
      repairAttempt: Math.max(0, registration.control.planCalls - 1),
      traceSummary: finalTrace,
    });
    log.info('visual-evidence', 'Visual evidence run verified', {
      sessionId: session.id,
      runId: run.id,
      trace: finalTrace,
    });
    notifyEvidence(session, app, 'verified');
    progress('Visual evidence verified.');
    return deps.state.getForSession(pool, session.id, { headSha: run.head_sha });
  } catch (error) {
    const failureTrace = traceSummary(metrics, { terminalFailureClass: errorCode(error) });
    const failed = await failCurrentRun(
      pool,
      run?.id || options.runId,
      error,
      deps.state,
      failureTrace
    );
    if (failed && session && app) {
      notifyEvidence(session, app, 'failed', { failureCode: errorCode(error) });
    }
    log.warn('visual-evidence', 'Visual evidence run ended without verified evidence', {
      sessionId: session?.id || null,
      runId: run?.id || options.runId || null,
      code: errorCode(error),
      trace: failureTrace,
    });
    throw error;
  } finally {
    registration?.unregister();
    if (pair) {
      const cleanupStartedAt = Date.now();
      try { await deps.environment.cleanupPair(config, pair); }
      finally {
        addTiming(metrics, 'cleanup', cleanupStartedAt);
        log.info('visual-evidence', 'Visual evidence environment cleanup finished', {
          sessionId: session?.id || null,
          runId: run?.id || options.runId || null,
          cleanupMs: metrics.timingsMs.cleanup,
        });
      }
    }
  }
}

async function scheduleForSession(config, options, injected = {}) {
  if (!config.visualEvidence?.execute) return { scheduled: false, reason: 'disabled' };
  const { pool, sessionId, headSha = null, trigger = 'preview-ready', onProgress = null } = options;
  const session = await loadSession(pool, sessionId);
  const intent = intentForSession(session);
  if (!intent) return { scheduled: false, reason: 'missing_intent' };
  const revision = await resolveRevisionContext(session, headSha, injected.github || github);
  const key = `${sessionId}:${revision.headSha}`;
  if (inFlight.has(key)) return { scheduled: false, reason: 'already_running', promise: inFlight.get(key) };
  const heuristicUi = uiFileHeuristic(revision.files);
  const created = await (injected.state || state).createRun(pool, {
    sessionId,
    baseSha: revision.baseSha,
    headSha: revision.headSha,
    intent,
    trigger,
    heuristicUi,
  });
  const run = created.run;
  notifyEvidence(session, publicSessionAndApp(session).app, run.state);
  require('./pr-metadata').syncEvidencePrBlock(pool, sessionId).catch((error) => {
    log.warn('visual-evidence', 'Could not publish the authenticated evidence link to the PR', {
      sessionId, runId: run.id, error: error.message,
    });
  });
  if (run.state === 'not_required') {
    return { scheduled: false, reason: 'not_required', runId: run.id };
  }
  if (!created.created && run.state !== 'planned') {
    return { scheduled: false, reason: run.state, runId: run.id };
  }
  const { session: sessionValue, app } = publicSessionAndApp(session);
  const promise = executeRun(config, {
    pool,
    run,
    session: sessionValue,
    app,
    revision,
    onProgress,
  }, injected).catch((error) => {
    log.warn('visual-evidence', 'Visual evidence run failed', {
      sessionId,
      runId: run.id,
      code: errorCode(error),
      error: visibleError(error),
    });
    throw error;
  }).finally(() => inFlight.delete(key));
  // Attach a rejection observer now so fire-and-forget callers never create
  // an unhandled rejection; callers that need completion may still await the
  // original promise returned below.
  promise.catch(() => {});
  inFlight.set(key, promise);
  return { scheduled: true, runId: run.id, promise };
}

function inFlightSnapshot() {
  return [...inFlight.keys()];
}

module.exports = {
  VisualEvidenceOrchestrationError,
  exactSha,
  headForSession,
  intentForSession,
  uiFileHeuristic,
  loadSession,
  resolveRevisionContext,
  declaredCheckSummary,
  evidenceContext,
  sameProvenance,
  replayInput,
  reviewImages,
  waitForSessionIdle,
  semanticFromFinish,
  newRunMetrics,
  addTiming,
  addAgentUsage,
  traceSummary,
  notifyEvidence,
  failCurrentRun,
  executeRun,
  scheduleForSession,
  inFlightSnapshot,
};
