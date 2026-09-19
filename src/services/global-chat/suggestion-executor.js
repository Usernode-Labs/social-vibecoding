'use strict';

const defaultStore = require('./store');
const {
  automaticPresentation,
  nextPredeterminedPresentation,
  PresentationError,
} = require('./presentation');
const { PROMPT_VERSION } = require('./prompt');
const { resolveAction } = require('./suggestion-actions');

const DIRECT_PROMPT_VERSION = `${PROMPT_VERSION}:direct-v1`;

class SuggestionExecutionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SuggestionExecutionError';
    this.code = code;
  }
}

function safeResult(result) {
  const authoritative = result?.authoritativeResult;
  return result
    && authoritative?.ok !== false
    && (!Number.isInteger(authoritative?.status)
      || (authoritative.status >= 200 && authoritative.status < 300));
}

function createSuggestionExecutor({ pool, config, registry, store = defaultStore } = {}) {
  if (!pool || !config || !registry) {
    throw new Error('global-chat suggestion executor: pool, config, and registry are required');
  }

  async function insertAssistant({ userId, threadId, presentation, kind }) {
    return store.insertMessage(pool, {
      userId,
      threadId,
      role: 'assistant',
      text: presentation.message,
      payload: { kind, presentation, direct: true },
      promptVersion: DIRECT_PROMPT_VERSION,
      model: null,
      reasoningEffort: null,
    });
  }

  async function showSuggestionPage({
    userId,
    threadId,
    domain = 'general',
    excludedSuggestionIds = [],
    client = {},
    emit: rawEmit,
  }) {
    const presentation = nextPredeterminedPresentation({
      domain,
      excludedSuggestionIds,
    });
    if (!presentation) return null;
    const emit = async (event) => {
      if (typeof rawEmit !== 'function') return;
      try { await rawEmit(event); } catch {}
    };
    const turnId = await store.claimTurn(pool, { userId, threadId });
    try {
      await emit({ type: 'turn.started', turnId, threadId, kind: 'more_suggestions' });
      await store.insertMessage(pool, {
        userId,
        threadId,
        role: 'user',
        text: 'More suggestions',
        payload: {
          kind: 'more_suggestions',
          direct: true,
          client: {
            surface: client.surface || 'web',
            viewport: client.viewport || 'regular',
          },
        },
      });
      const message = await insertAssistant({
        userId,
        threadId,
        presentation,
        kind: 'more_suggestions',
      });
      await emit({ type: 'turn.completed', turnId, message, presentation });
      return { turnId, message, presentation, results: [] };
    } finally {
      await store.releaseTurn(pool, { userId, threadId, turnId }).catch(() => {});
    }
  }

  async function execute({
    userId,
    threadId,
    suggestionId = null,
    actionId = null,
    parameters = null,
    excludedSuggestionIds = [],
    client = {},
    executionContext,
  }) {
    const action = resolveAction({ suggestionId, actionId, parameters });
    const turnId = await store.claimTurn(pool, { userId, threadId });
    try {
      const userMessage = await store.insertMessage(pool, {
        userId,
        threadId,
        role: 'user',
        text: action.label,
        payload: {
          kind: 'direct_action',
          direct: true,
          actionId: action.id,
          ...(suggestionId ? { suggestionId } : {}),
          client: {
            surface: client.surface || 'web',
            viewport: client.viewport || 'regular',
          },
        },
      });

      const settled = await Promise.allSettled(action.steps.map(async (step) => {
        const definition = registry.get(step.capabilityId);
        if (!definition || definition.access(executionContext) !== true
            || definition.risk !== 'read' || definition.confirmation !== 'never') {
          throw new SuggestionExecutionError(
            'direct_action_not_found',
            'That direct action is no longer available.',
          );
        }
        const started = Date.now();
        const toolRunId = await store.startToolRun(pool, {
          userId,
          threadId,
          messageId: userMessage.id,
          capabilityId: step.capabilityId,
          input: step.input,
          dataKey: config.dataEncryptionKey,
        });
        try {
          const result = await registry.execute(step.capabilityId, step.input, executionContext);
          if (!safeResult(result)) {
            throw new SuggestionExecutionError(
              'direct_action_failed',
              'The platform could not complete that direct action.',
            );
          }
          await store.finishToolRun(pool, {
            userId,
            toolRunId,
            modelResult: result.modelResult,
            authoritativeResult: result.authoritativeResult,
            renderer: result.renderer,
            classicPath: result.classicPath,
            durationMs: Date.now() - started,
            dataKey: config.dataEncryptionKey,
          });
          return toolRunId;
        } catch (error) {
          await store.finishToolRun(pool, {
            userId,
            toolRunId,
            modelResult: {
              ok: false,
              error: { code: String(error?.code || 'direct_action_failed').slice(0, 64) },
            },
            status: 'failed',
            durationMs: Date.now() - started,
            dataKey: config.dataEncryptionKey,
          }).catch(() => {});
          throw error;
        }
      }));
      const rejected = settled.find((entry) => entry.status === 'rejected');
      if (rejected?.status === 'rejected') throw rejected.reason;
      const outcomes = settled.map((entry) => entry.value);

      let presentation;
      try {
        presentation = automaticPresentation({
          domain: action.domain,
          resultRefs: outcomes,
          excludedSuggestionIds,
          message: action.message,
        });
      } catch (error) {
        if (!(error instanceof PresentationError) || error.code !== 'suggestions_exhausted') {
          throw error;
        }
        // A very long conversation can consume the complete deterministic
        // catalog. The action itself must still stay zero-model, so reuse the
        // first contextual batch; the always-present More control can ask the
        // model for genuinely new options on the following turn.
        presentation = automaticPresentation({
          domain: action.domain,
          resultRefs: outcomes,
          message: action.message,
        });
      }
      const results = await store.loadToolResults(pool, {
        userId,
        threadId,
        resultIds: outcomes,
        dataKey: config.dataEncryptionKey,
      });
      if (results.length !== outcomes.length) {
        throw new SuggestionExecutionError(
          'result_unavailable',
          'The direct action completed but its result could not be loaded.',
        );
      }
      const message = await insertAssistant({
        userId,
        threadId,
        presentation,
        kind: 'direct_action',
      });
      return {
        turnId,
        userMessage,
        message,
        presentation,
        results,
        modelInvocations: 0,
      };
    } finally {
      await store.releaseTurn(pool, { userId, threadId, turnId }).catch(() => {});
    }
  }

  return { execute, showSuggestionPage };
}

module.exports = {
  DIRECT_PROMPT_VERSION,
  SuggestionExecutionError,
  createSuggestionExecutor,
};
