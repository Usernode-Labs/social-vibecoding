'use strict';

// #2377: authenticated settings, compatible-model catalog, and accounting
// surfaces for Global Chat. These routes never return the shared OpenRouter
// secret and are intentionally independent from development-agent settings.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const { chatLimiter } = require('../middleware/rate-limits');
const log = require('../services/logger');
const credentialStore = require('../services/credential-store');
const openrouterClient = require('../services/openrouter-client');
const agentModels = require('../services/agent-models');
const profileService = require('../services/global-chat/profile');
const globalChatStore = require('../services/global-chat/store');
const {
  directActionIdForSuggestion,
  enrichPresentation,
  firstUsePresentation,
  plainSuggestionsForContext,
  validatePresentation,
} = require('../services/global-chat/presentation');
const { CapabilityRegistry } = require('../services/global-chat/capability-registry');
const { classicCapabilityDefinitions } = require('../services/global-chat/classic-capabilities');
const { ClassicApiClient } = require('../services/global-chat/classic-api-client');
const { createGlobalChatOrchestrator } = require('../services/global-chat/orchestrator');
const { createActionExecutor } = require('../services/global-chat/action-executor');
const { queryUserHistory } = require('../services/global-chat/activity-history');
const {
  createSuggestionExecutor,
  directFailureMessage,
} = require('../services/global-chat/suggestion-executor');
const { PROMPT_VERSION } = require('../services/global-chat/prompt');
const classicInventory = require('../services/global-chat/classic-inventory.generated.json');

const OPENROUTER = Object.freeze({ provider: 'openrouter', purpose: 'coding_agent' });
const PATCH_FIELDS = new Set(['enabled', 'model', 'reasoningEffort', 'spendCapUsd']);
const CAPABILITY_REGISTRY = new CapabilityRegistry(classicCapabilityDefinitions());
const TURN_BODY_FIELDS = new Set(['text', 'client', 'context']);
const MORE_BODY_FIELDS = new Set(['topic', 'shownSuggestionIds', 'client', 'context']);
const DIRECT_BODY_FIELDS = new Set([
  'suggestionId', 'actionId', 'parameters', 'targetLabel',
  'shownSuggestionIds', 'client', 'context',
]);
const CONFIRM_BODY_FIELDS = new Set(['threadId', 'client']);
const CLIENT_FIELDS = new Set(['surface', 'viewport', 'classicReturnPath']);
const CONTEXT_FIELDS = new Set([
  'locale', 'timezone', 'activeAppSlug', 'activeObject', 'clientSettings',
]);
const CLIENT_SETTING_FIELDS = new Set([
  'theme', 'devAlerts', 'devConsoleMode', 'adminPreview',
]);
const ALLOWANCE_CACHE_MS = 30_000;
const TURN_CATALOG_CACHE_MS = 5 * 60_000;
const SUGGESTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const DIRECT_ACTION_ID_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/;
const SUGGESTION_DOMAINS = new Set([
  'general', 'apps', 'issues', 'governance', 'development', 'messages', 'settings',
]);

function noStore(res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Pragma', 'no-cache');
}

function cleanProviderNumber(value) {
  if (value == null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactObject(value, allowed, field) {
  const object = value == null ? {} : value;
  if (!plainObject(object)) throw new Error(`${field} must be an object.`);
  const unsupported = Object.keys(object).find((key) => !allowed.has(key));
  if (unsupported) throw new Error(`${field}.${unsupported} is not supported.`);
  return object;
}

function requestClientContext(body) {
  const client = exactObject(body.client, CLIENT_FIELDS, 'client');
  const context = exactObject(body.context, CONTEXT_FIELDS, 'context');
  const suppliedClientSettings = Object.hasOwn(context, 'clientSettings');
  const clientSettings = exactObject(
    context.clientSettings,
    CLIENT_SETTING_FIELDS,
    'context.clientSettings',
  );
  if (Object.hasOwn(clientSettings, 'theme')
      && !['system', 'light', 'dark'].includes(clientSettings.theme)) {
    throw new Error('context.clientSettings.theme is invalid.');
  }
  if (Object.hasOwn(clientSettings, 'devAlerts')
      && typeof clientSettings.devAlerts !== 'boolean') {
    throw new Error('context.clientSettings.devAlerts is invalid.');
  }
  if (Object.hasOwn(clientSettings, 'devConsoleMode')
      && !['always', 'errors-only'].includes(clientSettings.devConsoleMode)) {
    throw new Error('context.clientSettings.devConsoleMode is invalid.');
  }
  if (Object.hasOwn(clientSettings, 'adminPreview')
      && typeof clientSettings.adminPreview !== 'boolean') {
    throw new Error('context.clientSettings.adminPreview is invalid.');
  }
  return {
    client,
    context: {
      ...context,
      ...(suppliedClientSettings ? { clientSettings } : {}),
    },
  };
}

function suggestionIds(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 500) {
    throw new Error('shownSuggestionIds must contain at most 500 ids.');
  }
  const ids = [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== 'string' || !SUGGESTION_ID_RE.test(entry)) {
      throw new Error('shownSuggestionIds contains an invalid id.');
    }
    if (!seen.has(entry)) {
      seen.add(entry);
      ids.push(entry);
    }
  }
  return ids;
}

function turnRequestBody(value, { more = false } = {}) {
  const body = exactObject(value, more ? MORE_BODY_FIELDS : TURN_BODY_FIELDS, 'body');
  const envelope = requestClientContext(body);
  if (more) {
    if (body.topic != null && (typeof body.topic !== 'string' || body.topic.length > 240)) {
      throw new Error('topic must be a string up to 240 characters.');
    }
  } else if (typeof body.text !== 'string' || !body.text.trim()
      || body.text.length > globalChatStore.MAX_MESSAGE_CHARS) {
    throw new Error(`text must contain at most ${globalChatStore.MAX_MESSAGE_CHARS} characters.`);
  }
  return {
    text: more
      ? (body.topic?.trim()
        ? `Show more suggestions about ${body.topic.trim()}.`
        : 'Show more suggestions.')
      : body.text.trim(),
    ...envelope,
    suggestionContext: more && body.topic?.trim()
      ? body.topic.trim()
      : 'general',
    shownSuggestionIds: more ? suggestionIds(body.shownSuggestionIds) : [],
  };
}

function directRequestBody(value) {
  const body = exactObject(value, DIRECT_BODY_FIELDS, 'body');
  const hasSuggestion = body.suggestionId != null;
  const hasAction = body.actionId != null;
  if (hasSuggestion === hasAction) {
    throw new Error('Provide exactly one suggestionId or actionId.');
  }
  if (hasSuggestion && (typeof body.suggestionId !== 'string'
      || !SUGGESTION_ID_RE.test(body.suggestionId))) {
    throw new Error('suggestionId is invalid.');
  }
  if (hasAction && (typeof body.actionId !== 'string'
      || !DIRECT_ACTION_ID_RE.test(body.actionId))) {
    throw new Error('actionId is invalid.');
  }
  let parameters = body.parameters == null ? {} : body.parameters;
  if (!plainObject(parameters)) throw new Error('parameters must be an object.');
  let parametersJson;
  try { parametersJson = JSON.stringify(parameters); } catch { parametersJson = null; }
  if (!parametersJson || Buffer.byteLength(parametersJson, 'utf8') > 4 * 1024) {
    throw new Error('parameters are too large.');
  }
  parameters = JSON.parse(parametersJson);
  let targetLabel = null;
  if (body.targetLabel != null) {
    if (typeof body.targetLabel !== 'string' || !body.targetLabel.trim()
        || body.targetLabel.length > 160
        || /[\u0000-\u001f\u007f]/.test(body.targetLabel)) {
      throw new Error('targetLabel must be a short single-line label.');
    }
    targetLabel = body.targetLabel.trim();
  }
  return {
    ...(hasSuggestion ? { suggestionId: body.suggestionId } : { actionId: body.actionId }),
    parameters,
    ...(targetLabel ? { targetLabel } : {}),
    shownSuggestionIds: suggestionIds(body.shownSuggestionIds),
    ...requestClientContext(body),
  };
}

function confirmationRequestBody(value) {
  const body = exactObject(value, CONFIRM_BODY_FIELDS, 'body');
  if (typeof body.threadId !== 'string') throw new Error('threadId is required.');
  return {
    threadId: body.threadId,
    client: exactObject(body.client, CLIENT_FIELDS, 'client'),
  };
}

function sseHeaders(res) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write(': connected\n\n');
}

function sseWrite(res, event) {
  if (!event?.type || res.writableEnded || res.destroyed) return;
  const { type, ...data } = event;
  res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

function requestErrorStatus(error) {
  if ([
    'invalid_message', 'invalid_actor', 'invalid_model', 'invalid_reasoning',
    'invalid_spend_cap', 'credential_required', 'incompatible_model',
    'invalid_direct_action',
  ].includes(error?.code)) return 400;
  if (error?.code === 'direct_action_not_found') return 404;
  if (error?.code === 'turn_in_progress') return 409;
  if (['global_chat_cap_exceeded', 'overall_allowance_exhausted'].includes(error?.code)) return 402;
  if (['authentication', 'model_unavailable'].includes(error?.code)) return 503;
  if (['invalid_or_expired_action', 'stale_action'].includes(error?.code)) return 409;
  return 500;
}

function turnFailureEvent(error) {
  const code = typeof error?.code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(error.code)
    ? error.code
    : 'turn_failed';
  const messages = {
    turn_in_progress: 'Another Global Chat turn is already running.',
    invalid_id: 'This Global Chat thread is unavailable.',
    thread_not_found: 'This Global Chat thread is unavailable.',
    cancelled: 'Global Chat was stopped.',
  };
  return {
    type: 'turn.failed',
    code,
    message: messages[code] || 'Global Chat could not complete that request. Please try again.',
  };
}

function pendingClientAction(result) {
  const authoritative = plainObject(result?.authoritativeResult)
    ? result.authoritativeResult
    : {};
  const data = plainObject(authoritative.data) ? authoritative.data : authoritative;
  return data.state === 'client_action_required' && plainObject(data.action)
    ? data.action
    : null;
}

function globalChatRoutes(config) {
  const router = Router();
  const pool = getPool(config);
  // Several offline/server-source tests intentionally replace the DB pool
  // with no-op stubs and never call Global Chat. Construct the stateful
  // services only on their first endpoint request so merely mounting the
  // platform server keeps that established test/boot contract.
  let orchestrator = null;
  let actionExecutor = null;
  let suggestionExecutor = null;
  const allowanceCache = new Map();
  const turnCatalogCache = new Map();
  const activeTurnControllers = new Map();
  function getOrchestrator() {
    orchestrator ||= createGlobalChatOrchestrator({
      pool,
      config,
      registry: CAPABILITY_REGISTRY,
    });
    return orchestrator;
  }
  function getActionExecutor() {
    actionExecutor ||= createActionExecutor({
      pool,
      config,
      registry: CAPABILITY_REGISTRY,
    });
    return actionExecutor;
  }
  function getSuggestionExecutor() {
    suggestionExecutor ||= createSuggestionExecutor({
      pool,
      config,
      registry: CAPABILITY_REGISTRY,
    });
    return suggestionExecutor;
  }

  async function credentialForUser(userId) {
    const metadata = await credentialStore.readMetadata({ pool, userId, ...OPENROUTER });
    if (!metadata || metadata.status !== 'valid') {
      return { configured: false, metadata, apiKey: null };
    }
    const apiKey = await credentialStore.readSecret({
      pool,
      userId,
      ...OPENROUTER,
      dataKey: config.dataEncryptionKey,
    });
    return { configured: !!apiKey, metadata, apiKey: apiKey || null };
  }

  async function providerAllowance(userId, credential, { force = false } = {}) {
    const key = String(userId);
    const revision = credential.metadata?.revision ?? null;
    const cached = allowanceCache.get(key);
    if (!force && cached?.revision === revision && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    if (!force && cached?.revision === revision && cached.promise) return cached.promise;
    const promise = openrouterClient.validateKey(credential.apiKey, {
      baseUrl: config.openrouterApiBase,
      origin: config.openrouterOrigin,
    });
    allowanceCache.set(key, { revision, promise, value: null, expiresAt: 0 });
    try {
      const value = await promise;
      allowanceCache.set(key, {
        revision,
        promise: null,
        value,
        expiresAt: Date.now() + ALLOWANCE_CACHE_MS,
      });
      return value;
    } catch (error) {
      if (allowanceCache.get(key)?.promise === promise) allowanceCache.delete(key);
      throw error;
    }
  }

  async function catalogForUser(userId, { forceRefresh = false, effort } = {}) {
    const credential = await credentialForUser(userId);
    if (!credential.configured) {
      return {
        configured: false,
        catalog: profileService.globalChatCatalog({ models: [] }, config, effort),
      };
    }
    const catalog = await agentModels.listOpenRouterModels({
      pool,
      userId,
      credentialRevision: credential.metadata.revision,
      apiKey: credential.apiKey,
      config,
      forceRefresh,
    });
    return {
      configured: true,
      catalog: profileService.globalChatCatalog(catalog, config, effort),
    };
  }

  async function turnCatalogForUser(userId, credential) {
    const key = String(userId);
    const revision = credential.metadata?.revision ?? null;
    const cached = turnCatalogCache.get(key);
    if (cached?.revision === revision && cached.expiresAt > Date.now()) return cached.value;
    if (cached?.revision === revision && cached.promise) return cached.promise;
    const promise = agentModels.listOpenRouterModels({
      pool,
      userId,
      credentialRevision: revision,
      apiKey: credential.apiKey,
      config,
      forceRefresh: false,
    });
    turnCatalogCache.set(key, { revision, promise, value: null, expiresAt: 0 });
    try {
      const value = await promise;
      turnCatalogCache.set(key, {
        revision,
        promise: null,
        value,
        expiresAt: Date.now() + TURN_CATALOG_CACHE_MS,
      });
      return value;
    } catch (error) {
      if (turnCatalogCache.get(key)?.promise === promise) turnCatalogCache.delete(key);
      throw error;
    }
  }

  async function saveGlobalChatProfile(userId, patch) {
    const current = await profileService.readProfile(pool, userId, config);
    const next = {
      enabled: Object.hasOwn(patch, 'enabled')
        ? profileService.enabled(patch.enabled)
        : current.enabled,
      model: Object.hasOwn(patch, 'model')
        ? profileService.modelId(patch.model)
        : current.model,
      reasoningEffort: Object.hasOwn(patch, 'reasoningEffort')
        ? profileService.reasoningEffort(patch.reasoningEffort)
        : current.reasoningEffort,
      spendCapUsd: Object.hasOwn(patch, 'spendCapUsd')
        ? profileService.money(patch.spendCapUsd)
        : current.spendCapUsd,
    };

    // Opt-in and cap-only changes remain possible during a provider outage.
    // Model or effort changes are executable configuration, so fail closed
    // unless the exact pair is in this user's live, capability-filtered
    // catalog.
    if (Object.hasOwn(patch, 'model') || Object.hasOwn(patch, 'reasoningEffort')) {
      const { configured, catalog } = await catalogForUser(userId, {
        effort: next.reasoningEffort,
      });
      if (!configured) {
        const error = new profileService.GlobalChatProfileError(
          'credential_required',
          'Add your OpenRouter API key in Settings first.',
        );
        throw error;
      }
      if (!catalog.models.some((model) => model.id === next.model)) {
        const error = new profileService.GlobalChatProfileError(
          'incompatible_model',
          'That model does not support Global Chat tools and the selected reasoning effort.',
        );
        throw error;
      }
    }

    const profile = await profileService.writeProfile(pool, userId, next, config);
    if (Object.hasOwn(patch, 'model') || Object.hasOwn(patch, 'reasoningEffort')) {
      // A settings catalog refresh may have exposed a newly available model.
      // Do not let the turn-only speed cache retain the older catalog after
      // the user explicitly changes executable model configuration.
      turnCatalogCache.delete(String(userId));
    }
    const usage = await profileService.readMonthlyUsage(pool, userId, {
      spendCapUsd: profile.spendCapUsd,
    });
    return { profile, usage };
  }

  async function developmentProfile(userId) {
    const { rows } = await pool.query(
      `SELECT backend, model_id, reasoning_effort
         FROM user_agent_preferences
        WHERE user_id = $1 AND is_default = TRUE
        LIMIT 1`,
      [userId],
    );
    const row = rows[0] || {};
    return {
      backend: row.backend || 'claude_code',
      model: row.model_id || null,
      reasoningEffort: row.reasoning_effort || null,
    };
  }

  async function turnRuntime(userId) {
    const [profile, credential, development] = await Promise.all([
      profileService.readProfile(pool, userId, config),
      credentialForUser(userId),
      developmentProfile(userId),
    ]);
    if (!credential.configured) {
      const error = new Error('Add an OpenRouter API key in Settings first.');
      error.code = 'model_unavailable';
      throw error;
    }
    const [catalog, usage, allowance] = await Promise.all([
      turnCatalogForUser(userId, credential),
      profileService.readMonthlyUsage(pool, userId, {
        spendCapUsd: profile.spendCapUsd,
      }),
      providerAllowance(userId, credential),
    ]);
    const model = profileService.compatibleModels(catalog, profile.reasoningEffort)
      .find((candidate) => candidate.id === profile.model);
    if (!model) {
      const error = new Error('The configured Global Chat model is unavailable or incompatible.');
      error.code = 'model_unavailable';
      throw error;
    }
    return {
      profile,
      development,
      usage,
      credential,
      model,
      providerAllowance: allowance,
      budget: {
        overallRemaining: cleanProviderNumber(allowance.limitRemaining),
        globalChatSpent: usage.spentUsd,
        globalChatCap: usage.capUsd,
        resetAt: usage.resetAt,
      },
    };
  }

  async function directRuntime(userId, { includeAllowance = false } = {}) {
    const [profile, development, credential] = await Promise.all([
      profileService.readProfile(pool, userId, config),
      developmentProfile(userId),
      includeAllowance ? credentialForUser(userId) : Promise.resolve(null),
    ]);
    const usage = await profileService.readMonthlyUsage(pool, userId, {
      spendCapUsd: profile.spendCapUsd,
    });
    let allowance = null;
    if (includeAllowance && credential?.configured) {
      try {
        allowance = await providerAllowance(userId, credential);
      } catch {
        // Monthly Global Chat accounting remains useful when OpenRouter's
        // allowance endpoint is temporarily unavailable.
      }
    }
    return {
      profile,
      development,
      usage,
      budget: {
        overallRemaining: cleanProviderNumber(allowance?.limitRemaining),
        globalChatSpent: usage.spentUsd,
        globalChatCap: usage.capUsd,
        resetAt: usage.resetAt,
      },
    };
  }

  function rolesForRequest(req, surface) {
    const roles = ['member'];
    if (req.user.isAdmin) roles.push(req.user.adminReadonly ? 'admin_readonly' : 'admin');
    if (surface === 'native_ios' || surface === 'native_android') roles.push('native');
    return roles;
  }

  function executionContext(req, client, runtime = {}) {
    let classicApi = null;
    if (typeof req.cookies?.session === 'string') {
      try {
        classicApi = new ClassicApiClient({
          baseUrl: `http://127.0.0.1:${config.port || 3000}`,
          browserOrigin: config.cliAuthOrigin || config.openrouterOrigin || 'https://usernode.dev',
          sessionToken: req.cookies.session,
        });
      } catch {}
    }
    return {
      actor: {
        id: req.user.id,
        username: req.user.username,
        signedIn: true,
        admin: !!req.user.isAdmin,
        canAdminWrite: !!req.user.canAdminWrite,
      },
      client: { surface: client.surface || 'web' },
      clientSettings: runtime.clientSettings || {},
      globalChatProfile: runtime.profile || null,
      globalChatUsage: runtime.usage || null,
      developmentProfile: runtime.development || null,
      budget: runtime.budget || {},
      classicApi,
      queryUserHistory: (kind, options) => queryUserHistory(
        pool,
        req.user.id,
        kind,
        {
          ...options,
          isAdmin: !!req.user.isAdmin,
          showSelfHosted: !!req.user.isAdmin || !!config.selfAppPublicVoting,
        },
      ),
      updateGlobalChatProfile: (patch) => saveGlobalChatProfile(req.user.id, patch),
      // Browser/native-only capabilities become authoritative pending client
      // actions. Their result is rendered by the allowlisted component layer;
      // the model never receives or invents an executable URL or method.
      dispatchClientAction: async (action) => ({
        ok: true,
        status: 202,
        data: { state: 'client_action_required', action },
      }),
    };
  }

  async function streamTurn(req, res, kind) {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    let input;
    try {
      input = turnRequestBody(req.body, { more: kind === 'more_suggestions' });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    if (kind === 'more_suggestions' && SUGGESTION_DOMAINS.has(input.suggestionContext)) {
      try {
        const directPage = await getSuggestionExecutor().showSuggestionPage({
          userId: req.user.id,
          threadId: req.params.id,
          domain: input.suggestionContext,
          excludedSuggestionIds: input.shownSuggestionIds,
          client: input.client,
        });
        if (directPage) {
          sseHeaders(res);
          sseWrite(res, {
            type: 'turn.started',
            turnId: directPage.turnId,
            threadId: req.params.id,
            kind,
          });
          sseWrite(res, {
            type: 'turn.completed',
            turnId: directPage.turnId,
            message: directPage.message,
            presentation: directPage.presentation,
          });
          res.end();
          return undefined;
        }
      } catch (error) {
        log.warn('global-chat', 'predetermined suggestions failed', {
          userId: req.user.id,
          threadId: req.params.id,
          code: error.code,
          err: error.message,
        });
        const status = requestErrorStatus(error);
        return res.status(status).json({
          error: status === 500 ? 'Could not load more suggestions.' : error.message,
          ...(error.code ? { code: error.code } : {}),
        });
      }
    }

    let runtime;
    try {
      runtime = await turnRuntime(req.user.id);
    } catch (error) {
      log.warn('global-chat', 'turn setup failed', {
        userId: req.user.id,
        code: error.code,
        err: error.message,
      });
      return res.status(requestErrorStatus(error)).json({
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
      });
    }

    sseHeaders(res);
    const controller = new AbortController();
    const activeKey = `${req.user.id}:${req.params.id}`;
    const controllers = activeTurnControllers.get(activeKey) || new Set();
    controllers.add(controller);
    activeTurnControllers.set(activeKey, controllers);
    const heartbeat = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(': keep-alive\n\n');
    }, 15_000);
    let terminalSent = false;
    res.on('close', () => {
      // A proxy or mobile connection can disappear while the server is still
      // completing and persisting the answer. Keep that durable work alive;
      // the client resumes it through turn-status/messages. The explicit
      // cancel endpoint below remains the only user-requested cancellation.
      clearInterval(heartbeat);
    });
    try {
      await getOrchestrator().runTurn({
        threadId: req.params.id,
        text: input.text,
        kind,
        actor: {
          id: req.user.id,
          username: req.user.username,
          roles: rolesForRequest(req, input.client.surface),
        },
        client: input.client,
        context: input.context,
        globalChatProfile: runtime.profile,
        developmentProfile: runtime.development,
        budget: runtime.budget,
        providerAllowance: runtime.providerAllowance,
        model: runtime.model,
        apiKey: runtime.credential.apiKey,
        executionContext: executionContext(req, input.client, {
          ...runtime,
          clientSettings: input.context.clientSettings,
        }),
        excludedSuggestionIds: input.shownSuggestionIds,
        suggestionContext: input.suggestionContext,
        signal: controller.signal,
        emit: async (event) => {
          if (event?.type === 'turn.completed' || event?.type === 'turn.failed') {
            terminalSent = true;
          }
          sseWrite(res, event);
        },
      });
    } catch (error) {
      log.warn('global-chat', 'turn failed', {
        userId: req.user.id,
        threadId: req.params.id,
        code: error.code,
        err: error.message,
      });
      // Failures after claimTurn are normally emitted by the orchestrator.
      // Pre-claim failures (notably a durable turn already in progress) have
      // no turn id there, so finish this SSE with one typed terminal event
      // instead of making the browser interpret a clean EOF as truncation.
      if (!terminalSent) sseWrite(res, turnFailureEvent(error));
    } finally {
      controllers.delete(controller);
      if (!controllers.size) activeTurnControllers.delete(activeKey);
      clearInterval(heartbeat);
      if (!res.writableEnded && !res.destroyed) res.end();
    }
    return undefined;
  }

  router.get('/api/global-chat/bootstrap', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    noStore(res);
    try {
      const profile = await profileService.readProfile(pool, req.user.id, config);
      const [threads, development, credential, usage] = await Promise.all([
        profile.enabled ? globalChatStore.listThreads(pool, req.user.id) : [],
        developmentProfile(req.user.id),
        profile.enabled ? credentialForUser(req.user.id) : { configured: false },
        profileService.readMonthlyUsage(pool, req.user.id, {
          spendCapUsd: profile.spendCapUsd,
        }),
      ]);
      return res.json({
        experimental: true,
        label: 'Chat (experimental)',
        startupMode: 'classic',
        parityReady: classicInventory.parityReady,
        available: profile.enabled && credential.configured,
        unavailableReason: !profile.enabled
          ? 'global_chat_disabled'
          : (credential.configured ? null : 'openrouter_key_required'),
        capabilityRegistryVersion: CAPABILITY_REGISTRY.version,
        capabilityCount: CAPABILITY_REGISTRY.size,
        thread: threads[0] || null,
        threads,
        firstUse: firstUsePresentation(),
        profiles: { globalChat: profile, development },
        usage,
      });
    } catch (err) {
      log.error('global-chat', 'bootstrap failed', { userId: req.user.id, err: err.message });
      return res.status(500).json({ error: 'Failed to open Global Chat.' });
    }
  });

  // The bootstrap is deliberately readable while disabled: it supplies the
  // release + profile state that decides whether the entry point exists, but
  // it does not create a thread merely because the user opens Improve. Every
  // operational route below this line fails closed on the same persisted setting.
  router.use('/api/global-chat', async (req, res, next) => {
    if (!req.user) return next();
    try {
      const profile = await profileService.readProfile(pool, req.user.id, config);
      if (profile.enabled) return next();
      noStore(res);
      return res.status(403).json({
        error: 'Global Chat is disabled. Enable it in Settings first.',
        code: 'global_chat_disabled',
      });
    } catch (err) {
      log.warn('global-chat', 'opt-in check failed', { userId: req.user.id, err: err.message });
      return res.status(500).json({ error: 'Failed to verify Global Chat settings.' });
    }
  });

  router.get('/api/global-chat/threads/current', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    noStore(res);
    try {
      return res.json({ thread: await globalChatStore.currentThread(pool, req.user.id) });
    } catch (err) {
      log.warn('global-chat', 'current thread read failed', { userId: req.user.id, err: err.message });
      return res.status(500).json({ error: 'Failed to load the current Global Chat thread.' });
    }
  });

  router.get('/api/global-chat/threads', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    noStore(res);
    try {
      const threads = await globalChatStore.listThreads(pool, req.user.id, {
        limit: req.query.limit,
      });
      return res.json({ threads });
    } catch (err) {
      log.warn('global-chat', 'thread list failed', { userId: req.user.id, err: err.message });
      return res.status(500).json({ error: 'Failed to load Global Chat threads.' });
    }
  });

  router.post('/api/global-chat/threads', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    noStore(res);
    try {
      const thread = await globalChatStore.createThread(pool, req.user.id);
      return res.status(201).json({ thread, firstUse: firstUsePresentation() });
    } catch (err) {
      log.warn('global-chat', 'thread create failed', { userId: req.user.id, err: err.message });
      return res.status(500).json({ error: 'Failed to start a new Global Chat thread.' });
    }
  });

  router.get('/api/global-chat/threads/:id', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    noStore(res);
    try {
      const thread = await globalChatStore.threadForUser(pool, req.user.id, req.params.id);
      if (!thread) return res.status(404).json({ error: 'That Global Chat thread is unavailable.' });
      return res.json({ thread });
    } catch (err) {
      if (err instanceof globalChatStore.GlobalChatStoreError && err.code === 'invalid_id') {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      log.warn('global-chat', 'thread read failed', { userId: req.user.id, err: err.message });
      return res.status(500).json({ error: 'Failed to load that Global Chat thread.' });
    }
  });

  router.get('/api/global-chat/threads/:id/messages', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    noStore(res);
    try {
      const page = await globalChatStore.listMessages(pool, {
        userId: req.user.id,
        threadId: req.params.id,
        before: req.query.before,
        limit: req.query.limit,
      });
      // A persisted presentation stores opaque result references, while the
      // authoritative objects themselves live encrypted in tool runs. Return
      // the owned results for this page alongside its messages so a reload can
      // redraw the same cards and pending confirmations the live SSE turn did.
      // The model-facing bounded result is not used by the browser renderer.
      const resultIds = [...new Set(page.messages.flatMap((message) => {
        const refs = message?.payload?.presentation?.resultRefs;
        return Array.isArray(refs) ? refs : [];
      }))];
      const results = await globalChatStore.loadToolResults(pool, {
        userId: req.user.id,
        threadId: req.params.id,
        resultIds,
        dataKey: config.dataEncryptionKey,
      });
      return res.json({ ...page, results });
    } catch (err) {
      if (err instanceof globalChatStore.GlobalChatStoreError
          && ['invalid_id', 'invalid_cursor'].includes(err.code)) {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      log.warn('global-chat', 'message page failed', { userId: req.user.id, err: err.message });
      return res.status(500).json({ error: 'Failed to load Global Chat messages.' });
    }
  });

  router.get('/api/global-chat/threads/:id/turn-status', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    noStore(res);
    try {
      return res.json(await globalChatStore.turnState(pool, {
        userId: req.user.id,
        threadId: req.params.id,
      }));
    } catch (err) {
      if (err instanceof globalChatStore.GlobalChatStoreError
          && ['invalid_id', 'thread_not_found'].includes(err.code)) {
        return res.status(err.code === 'thread_not_found' ? 404 : 400).json({
          error: err.message,
          code: err.code,
        });
      }
      log.warn('global-chat', 'turn status failed', { userId: req.user.id, err: err.message });
      return res.status(500).json({ error: 'Failed to read Global Chat turn status.' });
    }
  });

  router.post('/api/global-chat/threads/:id/cancel', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    noStore(res);
    const key = `${req.user.id}:${req.params.id}`;
    const controllers = activeTurnControllers.get(key);
    for (const controller of controllers || []) controller.abort();
    return res.json({ ok: true, cancelled: !!controllers?.size });
  });

  router.post('/api/global-chat/threads/:id/direct-actions', chatLimiter, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    noStore(res);
    let input;
    try {
      input = directRequestBody(req.body);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    try {
      const directActionId = input.actionId
        || directActionIdForSuggestion(input.suggestionId);
      const runtime = await directRuntime(req.user.id, {
        includeAllowance: directActionId === 'settings.spending',
      });
      const completed = await getSuggestionExecutor().execute({
        userId: req.user.id,
        threadId: req.params.id,
        suggestionId: input.suggestionId,
        actionId: input.actionId,
        parameters: input.parameters,
        targetLabel: input.targetLabel,
        excludedSuggestionIds: input.shownSuggestionIds,
        client: input.client,
        executionContext: executionContext(req, input.client, {
          ...runtime,
          clientSettings: input.context.clientSettings,
        }),
      });
      return res.json({ ok: true, ...completed });
    } catch (error) {
      log.warn('global-chat', 'direct action failed', {
        userId: req.user.id,
        threadId: req.params.id,
        code: error.code,
        err: error.message,
      });
      const status = requestErrorStatus(error);
      return res.status(status).json({
        error: status === 500
          ? directFailureMessage(error)
          : error.message,
        ...(error.code ? { code: error.code } : {}),
      });
    }
  });

  router.post('/api/global-chat/threads/:id/inline-actions', chatLimiter, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    noStore(res);
    let input;
    try {
      input = directRequestBody(req.body);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    if (input.suggestionId) {
      return res.status(400).json({ error: 'Inline actions require an exact actionId.' });
    }
    try {
      const runtime = await directRuntime(req.user.id, {
        includeAllowance: input.actionId === 'settings.spending',
      });
      const completed = await getSuggestionExecutor().executeInline({
        userId: req.user.id,
        threadId: req.params.id,
        actionId: input.actionId,
        parameters: input.parameters,
        targetLabel: input.targetLabel,
        executionContext: executionContext(req, input.client, {
          ...runtime,
          clientSettings: input.context.clientSettings,
        }),
      });
      return res.json({ ok: true, ...completed });
    } catch (error) {
      log.warn('global-chat', 'inline action failed', {
        userId: req.user.id,
        threadId: req.params.id,
        code: error.code,
        err: error.message,
      });
      const status = requestErrorStatus(error);
      return res.status(status).json({
        error: status === 500 ? directFailureMessage(error) : error.message,
        ...(error.code ? { code: error.code } : {}),
      });
    }
  });

  router.post('/api/global-chat/threads/:id/turns', chatLimiter, (req, res) => (
    streamTurn(req, res, 'user_turn')
  ));

  router.post('/api/global-chat/threads/:id/more-suggestions', chatLimiter, (req, res) => (
    streamTurn(req, res, 'more_suggestions')
  ));

  router.post('/api/global-chat/actions/:token/confirm', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    noStore(res);
    let input;
    try {
      input = confirmationRequestBody(req.body);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    try {
      const completed = await getActionExecutor().executeConfirmedAction({
        userId: req.user.id,
        threadId: input.threadId,
        token: req.params.token,
        executionContext: executionContext(req, input.client),
      });
      const result = completed.result;
      const pendingAction = pendingClientAction(result);
      const prefix = `confirmed.${result.id}`;
      const domain = String(result.capabilityId || '').split('.')[0];
      const contextualSuggestions = plainSuggestionsForContext(domain).slice(0, 3);
      const presentation = enrichPresentation(validatePresentation({
        message: pendingAction?.transport === 'development_handoff'
          ? 'Development session ready. Opening it now.'
          : pendingAction
            ? 'Ready to apply.'
            : 'Done.',
        resultRefs: [result.id],
        suggestions: [
          {
            id: `${prefix}.view`,
            label: 'View result',
            prompt: 'Show the updated result.',
            capabilityHint: result.capabilityId,
          },
          {
            id: `${prefix}.next`,
            label: 'Related work',
            prompt: 'Show work related to this result.',
            capabilityHint: null,
          },
          ...contextualSuggestions,
        ],
      }, { availableResultIds: [result.id] }), { context: domain });
      const message = await globalChatStore.insertMessage(pool, {
        userId: req.user.id,
        threadId: input.threadId,
        role: 'assistant',
        text: presentation.message,
        payload: { kind: 'confirmed_action', presentation },
        promptVersion: PROMPT_VERSION,
      });
      return res.json({ ok: true, message, presentation, results: [result] });
    } catch (error) {
      log.warn('global-chat', 'confirmed action failed', {
        userId: req.user.id,
        threadId: input.threadId,
        code: error.code,
        err: error.message,
      });
      const status = requestErrorStatus(error);
      const publicMessage = status === 500
        ? 'The confirmed action could not be completed.'
        : error.message;
      return res.status(status).json({
        error: publicMessage,
        ...(error.code ? { code: error.code } : {}),
      });
    }
  });

  router.delete('/api/global-chat/threads/:id', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    noStore(res);
    try {
      const key = `${req.user.id}:${req.params.id}`;
      const controllers = activeTurnControllers.get(key);
      for (const controller of controllers || []) controller.abort();
      activeTurnControllers.delete(key);
      const deleted = await globalChatStore.deleteThread(pool, req.user.id, req.params.id);
      if (!deleted) return res.status(404).json({ error: 'Global Chat thread not found.' });
      return res.json({ ok: true });
    } catch (err) {
      if (err instanceof globalChatStore.GlobalChatStoreError && err.code === 'invalid_id') {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      log.warn('global-chat', 'thread delete failed', { userId: req.user.id, err: err.message });
      return res.status(500).json({ error: 'Failed to clear Global Chat.' });
    }
  });

  router.get('/api/me/global-chat', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    noStore(res);
    try {
      const profile = await profileService.readProfile(pool, req.user.id, config);
      const usage = await profileService.readMonthlyUsage(pool, req.user.id, {
        spendCapUsd: profile.spendCapUsd,
      });
      res.json({
        experimental: true,
        startupMode: 'classic',
        profile,
        defaults: profileService.defaults(config),
        usage,
      });
    } catch (err) {
      log.error('global-chat', 'profile read failed', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Failed to load Global Chat settings.' });
    }
  });

  router.patch('/api/me/global-chat', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    noStore(res);
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body
      : {};
    const keys = Object.keys(body);
    if (keys.length === 0 || keys.some((key) => !PATCH_FIELDS.has(key))) {
      return res.status(400).json({
        error: 'Provide only enabled, model, reasoningEffort, or spendCapUsd.',
      });
    }
    try {
      const { profile, usage } = await saveGlobalChatProfile(req.user.id, body);
      res.json({ ok: true, profile, usage });
    } catch (err) {
      if (err instanceof profileService.GlobalChatProfileError) {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      log.warn('global-chat', 'profile write failed', { userId: req.user.id, err: err.message });
      return res.status(500).json({ error: 'Failed to save Global Chat settings.' });
    }
  });

  router.get('/api/me/global-chat/models', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    noStore(res);
    try {
      const profile = await profileService.readProfile(pool, req.user.id, config);
      const effort = req.query.reasoningEffort == null
        ? profile.reasoningEffort
        : profileService.reasoningEffort(req.query.reasoningEffort);
      const result = await catalogForUser(req.user.id, {
        forceRefresh: req.query.refresh === '1',
        effort,
      });
      if (req.query.refresh === '1') turnCatalogCache.delete(String(req.user.id));
      res.json({ configured: result.configured, ...result.catalog });
    } catch (err) {
      if (err instanceof profileService.GlobalChatProfileError) {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      log.warn('global-chat', 'model catalog failed', { userId: req.user.id, err: err.message });
      return res.status(502).json({ error: 'Failed to load compatible Global Chat models.' });
    }
  });

  router.get('/api/me/global-chat/usage', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    noStore(res);
    try {
      const profile = await profileService.readProfile(pool, req.user.id, config);
      const globalChat = await profileService.readMonthlyUsage(pool, req.user.id, {
        spendCapUsd: profile.spendCapUsd,
      });
      const credential = await credentialForUser(req.user.id);
      if (!credential.configured) {
        return res.json({ globalChat, overallAllowance: { configured: false } });
      }
      const info = await providerAllowance(req.user.id, credential, { force: true });
      return res.json({
        globalChat,
        overallAllowance: {
          configured: true,
          limitUsd: cleanProviderNumber(info.limit),
          remainingUsd: cleanProviderNumber(info.limitRemaining),
          spentUsd: cleanProviderNumber(info.usage),
          reset: typeof info.limitReset === 'string' ? info.limitReset : null,
        },
      });
    } catch (err) {
      log.warn('global-chat', 'usage read failed', { userId: req.user.id, err: err.message });
      return res.status(502).json({ error: 'Failed to load Global Chat usage.' });
    }
  });

  return router;
}

module.exports = {
  ALLOWANCE_CACHE_MS,
  TURN_CATALOG_CACHE_MS,
  globalChatRoutes,
  cleanProviderNumber,
};
