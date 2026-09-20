'use strict';

const defaultStore = require('./store');
const defaultActions = require('./actions');

class GlobalChatActionExecutionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GlobalChatActionExecutionError';
    this.code = code;
  }
}

function createActionExecutor({ pool, config, registry, store = defaultStore, actions = defaultActions }) {
  if (!pool || !registry) throw new Error('global-chat action executor: pool and registry are required');

  async function executeConfirmedAction({ userId, threadId, token, executionContext, emit: rawEmit }) {
    const emit = async (event) => {
      if (typeof rawEmit !== 'function') return;
      try { await rawEmit(event); } catch {}
    };
    const turnId = await store.claimTurn(pool, { userId, threadId });
    try {
      const consumed = await actions.consumeAction(pool, {
        token,
        userId,
        threadId,
        dataKey: config.dataEncryptionKey,
        resolveObjectRevision: typeof executionContext?.resolveObjectRevision === 'function'
          ? ({ client, capabilityId, input }) => executionContext.resolveObjectRevision({
            client, capabilityId, input,
          })
          : null,
      });
      const definition = registry.get(consumed.capabilityId);
      if (!definition || definition.confirmation !== 'required'
          || definition.access(executionContext) !== true) {
        throw new GlobalChatActionExecutionError(
          'capability_not_found',
          'That confirmed action is no longer available.',
        );
      }

      const started = Date.now();
      const toolRunId = await store.startToolRun(pool, {
        userId,
        threadId,
        capabilityId: consumed.capabilityId,
        input: consumed.input,
        dataKey: config.dataEncryptionKey,
      });
      await emit({
        type: 'tool.started',
        toolCallId: null,
        capabilityId: consumed.capabilityId,
        confirmed: true,
      });
      try {
        const result = await registry.execute(
          consumed.capabilityId,
          consumed.input,
          executionContext,
        );
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
        const stored = await store.loadToolResults(pool, {
          userId,
          threadId,
          resultIds: [toolRunId],
          dataKey: config.dataEncryptionKey,
        });
        if (stored.length !== 1) {
          throw new GlobalChatActionExecutionError(
            'result_unavailable',
            'The confirmed action completed but its result could not be loaded.',
          );
        }
        await emit({
          type: 'tool.completed',
          toolCallId: null,
          capabilityId: consumed.capabilityId,
          resultId: toolRunId,
          status: 'completed',
          confirmed: true,
        });
        await emit({ type: 'result.attached', result: stored[0] });
        return { result: stored[0], consumed };
      } catch (error) {
        await store.finishToolRun(pool, {
          userId,
          toolRunId,
          modelResult: {
            ok: false,
            error: { code: String(error?.code || 'tool_failed').slice(0, 64) },
          },
          status: 'failed',
          durationMs: Date.now() - started,
          dataKey: config.dataEncryptionKey,
        }).catch(() => {});
        await emit({
          type: 'tool.completed',
          toolCallId: null,
          capabilityId: consumed.capabilityId,
          resultId: null,
          status: 'failed',
          confirmed: true,
        });
        throw error;
      }
    } finally {
      await store.releaseTurn(pool, { userId, threadId, turnId }).catch(() => {});
    }
  }

  return { executeConfirmedAction };
}

module.exports = {
  GlobalChatActionExecutionError,
  createActionExecutor,
};
