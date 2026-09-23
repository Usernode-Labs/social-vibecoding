'use strict';

// An evidence turn gets one purpose-bound JWT and this in-memory run-scoped
// control plane. It cannot address another run, obtain app auth material, or
// invoke generic platform APIs. A platform restart invalidates the registry;
// recovery terminalizes or retries the durable run rather than trusting an
// orphan model process.

const planContract = require('./visual-evidence-plan');

const controls = new Map();
const FINISH_STATUSES = new Set(['verified', 'not_relevant', 'failed']);

class EvidenceControlError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'EvidenceControlError';
    this.code = code;
    this.status = status;
  }
}

function boundedReason(value) {
  const reason = typeof value === 'string' ? value.trim().slice(0, 1000) : '';
  if (!reason) throw new EvidenceControlError('evidence_reason_required', 'A concise user-visible reason is required.', 400);
  return reason;
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

class RunControl {
  constructor({ runId, sessionId, intent, context, resetSide, runPlan, expiresAt }) {
    this.runId = runId;
    this.sessionId = Number(sessionId);
    this.intent = planContract.parseIntent(intent);
    this.context = cloneJson(context);
    this.resetSideCallback = resetSide;
    this.runPlanCallback = runPlan;
    this.expiresAt = Number(expiresAt || Date.now() + 4 * 60_000);
    this.planCalls = 0;
    this.maxPlanCalls = 1;
    this.latestHard = null;
    // Tool errors also need to survive a successful model process exit. A
    // rejected plan never reaches the replay callback, but is just as useful
    // when diagnosing a turn that submitted no passing replay.
    this.lastToolFailure = null;
    // A model may call run-plan again after a failed replay. The second call
    // only reports the attempt limit; it must not replace the browser failure
    // from the replay that actually ran.
    this.lastReplayFailure = null;
    this.finished = null;
    this.repairReason = null;
    this.repairFailure = null;
    this.rejectedPlan = null;
    this.lastSubmittedPlan = null;
    this.waiters = new Set();
    this.busy = null;
  }

  assertLive() {
    if (Date.now() > this.expiresAt) {
      throw new EvidenceControlError('evidence_control_expired', 'This evidence turn has expired.', 410);
    }
  }

  getContext() {
    this.assertLive();
    return cloneJson({
      ...this.context,
      attempt: this.planCalls + 1,
      repairReason: this.repairReason,
      ...(this.repairFailure ? {
        repair: { failure: this.repairFailure, rejectedPlan: this.rejectedPlan },
      } : {}),
    });
  }

  async resetSide(side) {
    try {
      this.assertLive();
      if (!['base', 'head'].includes(side)) throw new EvidenceControlError('invalid_evidence_side', 'Side must be base or head.', 400);
      if (this.finished) throw new EvidenceControlError('evidence_turn_finished', 'This evidence turn is already finished.');
      if (typeof this.resetSideCallback !== 'function') {
        throw new EvidenceControlError('evidence_reset_unavailable', 'Side reset is unavailable for this run.', 503);
      }
      if (this.busy) throw new EvidenceControlError('evidence_control_busy', `Evidence is already ${this.busy}.`, 409);
      this.busy = 'resetting paired state';
      try { return await this.resetSideCallback(side); }
      finally { this.busy = null; }
    } catch (error) {
      if (this.lastToolFailure?.operation !== 'run-plan') {
        this.lastToolFailure = { operation: 'reset-side', error };
      }
      throw error;
    }
  }

  async runPlan(rawPlan) {
    try {
      this.assertLive();
      if (this.finished) throw new EvidenceControlError('evidence_turn_finished', 'This evidence turn is already finished.');
      if (this.planCalls >= this.maxPlanCalls) {
        throw new EvidenceControlError('evidence_plan_attempt_exhausted', 'No additional replay-plan attempt is available.');
      }
      if (this.busy) throw new EvidenceControlError('evidence_control_busy', `Evidence is already ${this.busy}.`, 409);
      const plan = planContract.parseReplayPlan(rawPlan);
      const projected = planContract.semanticIntentFromPlan(plan);
      if (planContract.canonicalJson(projected) !== planContract.canonicalJson(this.intent)) {
        throw new EvidenceControlError(
          'evidence_intent_mismatch',
          'The executable plan must preserve the accepted claims, personas, viewports, flow summary, focus, and animation intent.',
          400
        );
      }
      if (this.planCalls === 1 && this.maxPlanCalls === 2
          && planContract.planHash(plan) === planContract.planHash(this.rejectedPlan)) {
        throw new EvidenceControlError(
          'evidence_repair_unchanged',
          'The corrected replay plan must differ from the rejected plan.',
          400
        );
      }
      // Reserve the attempt before awaiting so concurrent calls cannot execute
      // multiple expensive paired replays.
      this.lastSubmittedPlan = cloneJson(plan);
      this.planCalls += 1;
      this.busy = 'replaying the submitted plan';
      const replayStartedAt = Date.now();
      try {
        const result = await this.runPlanCallback(plan, { attempt: this.planCalls });
        this.lastToolFailure = null;
        this.lastReplayFailure = null;
        this.latestHard = result?.hardVerdict?.passed === true
          ? { passed: true, planHash: result.planHash, attempt: this.planCalls }
          : null;
        return result;
      } catch (error) {
        // A corrected replay may supersede an earlier failed replay. Keep the
        // latest execution failure, separate from validation/quota errors.
        this.lastReplayFailure = { operation: 'run-plan', error };
        throw error;
      } finally {
        // Each deterministic replay pass has its own container deadline. Do
        // not expire the agent's control window while that bounded platform
        // work is running; it still needs to inspect the media and finish.
        this.expiresAt += Date.now() - replayStartedAt;
        this.busy = null;
      }
    } catch (error) {
      this.lastToolFailure = { operation: 'run-plan', error };
      throw error;
    }
  }

  finish({ status, reason, planHash = null }) {
    this.assertLive();
    if (this.busy) throw new EvidenceControlError('evidence_control_busy', `Evidence is already ${this.busy}.`, 409);
    if (!FINISH_STATUSES.has(status)) {
      throw new EvidenceControlError('invalid_evidence_finish', 'Status must be verified, not_relevant, or failed.', 400);
    }
    if (this.finished) throw new EvidenceControlError('evidence_turn_finished', 'This evidence turn is already finished.');
    const visibleReason = boundedReason(reason);
    if (status === 'verified') {
      if (!this.latestHard?.passed || !planHash || planHash !== this.latestHard.planHash) {
        throw new EvidenceControlError(
          'evidence_hard_verdict_required',
          'Verified may only finish the most recent passing replay plan.',
          400
        );
      }
    }
    this.finished = { status, reason: visibleReason, planHash: planHash || null, at: new Date().toISOString() };
    for (const resolve of this.waiters) resolve(cloneJson(this.finished));
    this.waiters.clear();
    return cloneJson(this.finished);
  }

  allowRepair(reason, failure) {
    if (this.busy) throw new EvidenceControlError('evidence_control_busy', `Evidence is already ${this.busy}.`, 409);
    if (this.planCalls !== 1 || this.maxPlanCalls !== 1
        || !this.lastReplayFailure || !this.lastSubmittedPlan) {
      throw new EvidenceControlError('evidence_repair_unavailable', 'The single repair attempt is not available.');
    }
    this.maxPlanCalls = 2;
    this.repairReason = boundedReason(reason);
    this.repairFailure = cloneJson(failure);
    this.rejectedPlan = cloneJson(this.lastSubmittedPlan);
    this.finished = null;
    this.latestHard = null;
  }

  waitForFinish({ signal = null, timeoutMs = 240_000 } = {}) {
    if (this.finished) return Promise.resolve(cloneJson(this.finished));
    return new Promise((resolve, reject) => {
      let timer = null;
      const done = (value) => {
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', aborted);
        this.waiters.delete(done);
        resolve(value);
      };
      const aborted = () => {
        if (timer) clearTimeout(timer);
        this.waiters.delete(done);
        reject(new EvidenceControlError('evidence_agent_cancelled', 'The evidence agent turn was cancelled.', 499));
      };
      this.waiters.add(done);
      timer = setTimeout(() => {
        this.waiters.delete(done);
        reject(new EvidenceControlError('evidence_agent_timeout', 'The evidence agent did not finish within its time budget.', 408));
      }, timeoutMs);
      timer.unref?.();
      if (signal) {
        if (signal.aborted) aborted();
        else signal.addEventListener('abort', aborted, { once: true });
      }
    });
  }
}

function registerRun(options) {
  if (!/^[0-9a-f]{32}$/.test(String(options?.runId || ''))) {
    throw new EvidenceControlError('invalid_evidence_run', 'A valid evidence run id is required.', 400);
  }
  if (controls.has(options.runId)) throw new EvidenceControlError('evidence_control_exists', 'This evidence run is already registered.');
  const control = new RunControl(options);
  controls.set(options.runId, control);
  return {
    control,
    unregister() {
      if (controls.get(options.runId) === control) controls.delete(options.runId);
    },
  };
}

function forRequest({ runId, sessionId }) {
  const control = controls.get(String(runId || ''));
  if (!control) throw new EvidenceControlError('evidence_control_not_found', 'This evidence run is no longer active.', 410);
  if (control.sessionId !== Number(sessionId)) {
    throw new EvidenceControlError('evidence_scope_mismatch', 'Evidence token does not own this run.', 403);
  }
  control.assertLive();
  return control;
}

function clearForTests() {
  controls.clear();
}

module.exports = {
  EvidenceControlError,
  RunControl,
  registerRun,
  forRequest,
  _clearForTests: clearForTests,
};
