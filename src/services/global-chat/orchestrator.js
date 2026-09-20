'use strict';

const {
  MORE_SUGGESTIONS_PROMPT,
  PROMPT_VERSION,
  RESULT_FOLLOWUP_PROMPT,
  SYSTEM_PROMPT,
  buildRuntimeMetadata,
  serializeRuntimeMetadata,
} = require('./prompt');
const {
  MAX_RESULT_REFS,
  automaticPresentation,
  enrichPresentation,
  validatePresentation,
} = require('./presentation');
const { validateJsonSchema, JsonSchemaValidationError } = require('./json-schema');
const {
  BASE_TOOL_NAMES,
  BASE_TOOLS,
  capabilityToolName,
  toolSet,
} = require('./tool-protocol');
const defaultStore = require('./store');
const defaultAccounting = require('./accounting');
const defaultActions = require('./actions');

const MAX_ITERATIONS = 4;
const MAX_PARALLEL_READS = 4;
const MAX_EXPOSED_CAPABILITIES = 60;
const MAX_HISTORY_MESSAGES = 30;
const MAX_TOOL_CONTENT_BYTES = 64 * 1024;
const TURN_TIMEOUT_MS = 35_000;
// OpenRouter now owns provider failover inside one latency-routed request.
// Keep the application deadline short and never repeat the same model request
// blindly: that old 15s + 15s retry was the source of the observed 30s turns.
const PROVIDER_TIMEOUT_MS = 8_000;
// OpenRouter uses session_id as a sticky provider key. Bump this routing-only
// suffix whenever the routing policy changes so existing chats adopt it
// automatically instead of remaining pinned to a previously slow endpoint.
const PROVIDER_SESSION_REVISION = 'latency-v1';
const SYNTHESIS_REQUEST_RE = /\b(?:analyse|analyze|compare|contrast|difference|explain|recommend|summari[sz]e|why|which\s+(?:is|are|should)|best)\b/i;
const WRITE_REQUEST_RE = /\b(?:add|change|close|configure|continue|create|delete|edit|fork|install|merge|remove|rename|reply|redeploy|send|set|start|update|vote)\b/i;
const MULTI_CLAUSE_REQUEST_RE = /\b(?:also|and|plus|then)\b|,/i;

class GlobalChatOrchestrationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GlobalChatOrchestrationError';
    this.code = code;
    this.details = details;
  }
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function userText(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > defaultStore.MAX_MESSAGE_CHARS) {
    throw new GlobalChatOrchestrationError(
      'invalid_message',
      `Message must contain at most ${defaultStore.MAX_MESSAGE_CHARS} characters.`,
    );
  }
  return value.trim();
}

function parseArguments(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 256 * 1024) {
    throw new GlobalChatOrchestrationError('invalid_tool_call', 'Tool arguments are invalid.');
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  if (!plainObject(parsed)) {
    throw new GlobalChatOrchestrationError('invalid_tool_call', 'Tool arguments must be an object.');
  }
  return parsed;
}

function safeCode(error) {
  if (!error?.code && /^global-chat metadata:/.test(String(error?.message || ''))) {
    return 'invalid_metadata';
  }
  const code = String(error?.code || 'tool_failed');
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(code) ? code : 'tool_failed';
}

function toolFailure(error) {
  const code = safeCode(error);
  const messages = {
    invalid_tool_call: 'The tool request was invalid.',
    schema_validation_failed: 'The tool inputs were invalid.',
    invalid_capability_input: 'The capability inputs were invalid.',
    capability_not_found: 'That capability is not available.',
    capability_required: 'I need to check Homeroom before answering that request.',
    turn_in_progress: 'Another Global Chat turn is already running.',
    turn_timeout: 'Global Chat took too long. Please try again.',
    timeout: 'The chat model took too long. Please try again.',
    rate_limited: 'The chat model is busy right now. Please try again.',
    provider_unavailable: 'The chat model is temporarily unavailable. Please try again.',
    provider_error: 'The chat model could not complete that request. Please try again.',
    invalid_metadata: 'Global Chat could not prepare that request. Please try again.',
    presentation_required: 'The chat model returned an incomplete response. Please try again.',
    iteration_limit: 'The chat model could not finish that request. Please try again.',
  };
  return {
    ok: false,
    error: {
      code,
      message: messages[code] || 'Global Chat could not complete that request. Please try again.',
    },
  };
}

function boundedToolContent(value) {
  let json;
  try { json = JSON.stringify(value); } catch { json = null; }
  if (typeof json !== 'string') {
    return JSON.stringify({ ok: false, error: { code: 'invalid_tool_result', message: 'Tool result was unavailable.' } });
  }
  if (Buffer.byteLength(json, 'utf8') <= MAX_TOOL_CONTENT_BYTES) return json;
  const compact = {
    ok: value?.ok !== false,
    truncated: true,
    resultId: value?.resultId || null,
    capabilityId: value?.capabilityId || null,
    message: 'The authoritative result is available to the interface but was too large for model context.',
  };
  return JSON.stringify(compact);
}

function toolMessage(callId, value) {
  return { role: 'tool', tool_call_id: callId, content: boundedToolContent(value) };
}

function confirmationPreview(definition, input, executionContext) {
  if (typeof definition.confirmationPreview !== 'function') return null;
  const preview = definition.confirmationPreview(structuredClone(input), executionContext);
  if (!plainObject(preview)) {
    throw new GlobalChatOrchestrationError(
      'invalid_confirmation_preview',
      'The confirmation preview is unavailable.',
    );
  }
  let json;
  try { json = JSON.stringify(preview); } catch { json = null; }
  if (!json || Buffer.byteLength(json, 'utf8') > 8 * 1024) {
    throw new GlobalChatOrchestrationError(
      'invalid_confirmation_preview',
      'The confirmation preview is unavailable.',
    );
  }
  return JSON.parse(json);
}

function historyForModel(messages) {
  return messages.map((message) => {
    if (message.role === 'user') return { role: 'user', content: message.text };
    const presentation = message.payload?.presentation;
    const modelPresentation = presentation ? {
      message: presentation.message || '',
      resultRefs: Array.isArray(presentation.resultRefs) ? presentation.resultRefs : [],
      suggestions: Array.isArray(presentation.suggestions)
        ? presentation.suggestions.map((suggestion) => ({
          id: suggestion.id,
          label: suggestion.label,
          prompt: suggestion.prompt,
          capabilityHint: suggestion.capabilityHint || null,
        }))
        : [],
    } : null;
    return {
      role: 'assistant',
      content: JSON.stringify(modelPresentation || { message: message.text, resultRefs: [], suggestions: [] }),
    };
  });
}

function transcriptState(messages) {
  const resultIds = [];
  const suggestionIds = [];
  for (const message of messages) {
    const presentation = message.payload?.presentation;
    if (!plainObject(presentation)) continue;
    if (Array.isArray(presentation.resultRefs)) resultIds.push(...presentation.resultRefs);
    if (Array.isArray(presentation.suggestions)) {
      suggestionIds.push(...presentation.suggestions.map((item) => item?.id).filter(Boolean));
    }
  }
  return {
    resultIds: [...new Set(resultIds)].slice(-50),
    suggestionIds: [...new Set(suggestionIds)].slice(-500),
  };
}

function baseToolByName(name) {
  return BASE_TOOLS.find((tool) => tool.function.name === name) || null;
}

function validateBaseArguments(name, args) {
  const tool = baseToolByName(name);
  if (!tool) return;
  validateJsonSchema(tool.function.parameters, args, { path: name });
}

function providerCall(call, index) {
  if (!plainObject(call) || call.type !== 'function' || !plainObject(call.function)) {
    throw new GlobalChatOrchestrationError('invalid_tool_call', 'Provider returned an invalid tool call.');
  }
  const id = typeof call.id === 'string' && /^[A-Za-z0-9._:-]{1,180}$/.test(call.id)
    ? call.id
    : `invalid_${index}`;
  const name = typeof call.function.name === 'string' ? call.function.name : '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    throw new GlobalChatOrchestrationError('invalid_tool_call', 'Provider returned an invalid tool name.');
  }
  return { id, name, args: parseArguments(call.function.arguments), raw: call };
}

async function inBatches(items, size, worker) {
  const output = [];
  for (let index = 0; index < items.length; index += size) {
    const batch = items.slice(index, index + size);
    output.push(...await Promise.all(batch.map(worker)));
  }
  return output;
}

function invocationMessages(workflowPrompt, metadata, transcript, loop) {
  return [
    // OpenRouter Chat Completions is stateless. Re-send the same complete,
    // versioned operating manual as the stable first message on every model
    // invocation so even a weak model never has to infer the platform rules
    // from an earlier request. A short workflow prompt may narrow the current
    // stage, but it never replaces the manual.
    { role: 'system', content: SYSTEM_PROMPT },
    ...(workflowPrompt ? [{ role: 'system', content: workflowPrompt }] : []),
    { role: 'system', content: serializeRuntimeMetadata(metadata) },
    ...transcript,
    ...loop,
  ];
}

function canFastCompleteReads(messageText, capabilityCalls, outcomes) {
  if (!capabilityCalls.length
      || SYNTHESIS_REQUEST_RE.test(messageText)
      || (capabilityCalls.length === 1 && MULTI_CLAUSE_REQUEST_RE.test(messageText))
      || (WRITE_REQUEST_RE.test(messageText)
        && capabilityCalls.every((entry) => entry.definition?.risk === 'read'))) return false;
  return capabilityCalls.every((entry) => {
    if (entry.definition?.risk !== 'read') return false;
    const outcome = outcomes.get(entry.call.id);
    const classic = outcome?.data;
    return outcome?.ok === true
      && classic?.ok !== false
      && (!Number.isInteger(classic?.status)
        || (classic.status >= 200 && classic.status < 300));
  });
}

// Backward-compatible export name for tests and integrations that imported
// the original single-read predicate. It now accepts one or more independent
// reads selected by the model.
const canFastCompleteRead = canFastCompleteReads;

function completedSuggestionActionIds(capabilityCalls) {
  const aliases = new Set();
  for (const { capabilityId } of capabilityCalls) {
    if (/^apps\.get\.apps\.[a-f0-9]+$/.test(capabilityId)) aliases.add('apps.list');
    if (/^development\.get\.me\.active\.sessions\./.test(capabilityId)) {
      aliases.add('development.active');
    }
    if (/^notifications\.get\.notifications\./.test(capabilityId)) {
      aliases.add('notifications.list');
    }
    if (/^messages\.get\.conversations\./.test(capabilityId)) aliases.add('messages.recent');
    aliases.add(capabilityId);
  }
  return [...aliases];
}

function createGlobalChatOrchestrator({
  pool,
  config,
  registry,
  store = defaultStore,
  accounting = defaultAccounting,
  actions = defaultActions,
  maxIterations = MAX_ITERATIONS,
} = {}) {
  if (!pool || !registry || typeof registry.search !== 'function') {
    throw new Error('global-chat orchestrator: pool and registry are required');
  }
  const iterationLimit = Math.max(1, Math.min(MAX_ITERATIONS, Number(maxIterations) || MAX_ITERATIONS));

  async function runTurn({
    threadId,
    text,
    kind = 'user_turn',
    actor,
    client = {},
    context = {},
    globalChatProfile,
    developmentProfile,
    budget = {},
    providerAllowance,
    model,
    apiKey,
    executionContext,
    excludedSuggestionIds: requestedSuggestionIds = [],
    suggestionContext = 'general',
    signal,
    emit: rawEmit,
  }) {
    const emit = async (event) => {
      if (typeof rawEmit !== 'function') return;
      try { await rawEmit(event); } catch {}
    };
    const messageText = userText(text);
    const turnStartedAt = Date.now();
    const deadlineAt = turnStartedAt + TURN_TIMEOUT_MS;
    const userId = Number(actor?.id);
    if (!Number.isSafeInteger(userId) || userId <= 0 || !actor?.username) {
      throw new GlobalChatOrchestrationError('invalid_actor', 'A signed-in user is required.');
    }
    if (!model?.id || globalChatProfile?.model !== model.id) {
      throw new GlobalChatOrchestrationError('invalid_model', 'The selected Global Chat model is unavailable.');
    }
    if (!apiKey) {
      throw new GlobalChatOrchestrationError('model_unavailable', 'Add an OpenRouter key in Settings first.');
    }

    let turnId;
    let userMessage;
    let providerInvocationCount = 0;
    const turnResultIds = [];
    const emitProgress = (phase, message, details = {}) => emit({
      type: 'turn.progress',
      phase,
      message,
      elapsedMs: Date.now() - turnStartedAt,
      model: model?.id || null,
      reasoningEffort: globalChatProfile?.reasoningEffort || null,
      ...details,
    });
    try {
      turnId = await store.claimTurn(pool, { userId, threadId });
      await emit({ type: 'turn.started', turnId, threadId, kind });
      await emitProgress('understanding', 'Understanding your request…');

      const page = await store.listMessages(pool, {
        userId, threadId, limit: MAX_HISTORY_MESSAGES,
      });
      const priorMessages = page.messages || [];
      let ownedThread = typeof store.threadForUser === 'function'
        ? await store.threadForUser(pool, userId, threadId)
        : null;
      if (page.hasMore && page.before && typeof store.compactThread === 'function') {
        ownedThread = await store.compactThread(pool, {
          userId,
          threadId,
          before: page.before,
        });
      }
      const priorState = transcriptState(priorMessages);
      const priorResults = await store.loadToolResults(pool, {
        userId,
        threadId,
        resultIds: priorState.resultIds,
        dataKey: config.dataEncryptionKey,
      });
      const knownResultIds = new Set(priorResults.map((result) => result.id));
      const excludedSuggestionIds = new Set([
        ...priorState.suggestionIds,
        ...requestedSuggestionIds,
      ]);

      userMessage = await store.insertMessage(pool, {
        userId,
        threadId,
        role: 'user',
        text: messageText,
        payload: {
          kind,
          client: {
            surface: client.surface || 'web',
            viewport: client.viewport || 'regular',
          },
        },
      });

      const transcript = [
        ...historyForModel(priorMessages),
        { role: 'user', content: messageText },
      ];
      const loopMessages = [];
      const exposed = new Map();
      const confirmationEvents = [];
      let capabilityAttempted = false;
      let servedModel = model.id;

      async function exposeCapability(capabilityId) {
        if (exposed.has(capabilityId)) return exposed.get(capabilityId);
        if (exposed.size >= MAX_EXPOSED_CAPABILITIES) {
          throw new GlobalChatOrchestrationError(
            'capability_limit',
            'Too many capabilities were requested in one turn.',
          );
        }
        const definition = registry.get(capabilityId);
        if (!definition || definition.access(executionContext) !== true) {
          throw new GlobalChatOrchestrationError(
            'capability_not_found',
            'That capability is not available.',
          );
        }
        exposed.set(capabilityId, definition);
        return definition;
      }

      async function executeCapability(call, capabilityId) {
        const definition = exposed.get(capabilityId);
        const started = Date.now();
        let toolRunId;
        await emit({
          type: 'tool.started',
          toolCallId: call.id,
          capabilityId,
          title: definition.title,
          elapsedMs: Date.now() - turnStartedAt,
        });
        try {
          validateJsonSchema(definition.inputSchema, call.args, { path: 'input' });
          toolRunId = await store.startToolRun(pool, {
            userId,
            threadId,
            messageId: userMessage.id,
            capabilityId,
            input: call.args,
            dataKey: config.dataEncryptionKey,
          });

          if (definition.confirmation === 'required') {
            const objectRevision = typeof executionContext?.resolveObjectRevision === 'function'
              ? await executionContext.resolveObjectRevision({ capabilityId, input: structuredClone(call.args) })
              : null;
            const prepared = await actions.prepareAction(pool, {
              userId,
              threadId,
              capabilityId,
              input: call.args,
              objectRevision,
              dataKey: config.dataEncryptionKey,
            });
            const authoritativeResult = {
              status: 'confirmation_required',
              capabilityId,
              // Server-owned copy for the browser confirmation card. The
              // model cannot rename a protected action into something more
              // reassuring than the capability the registry actually sealed.
              title: definition.title,
              preview: confirmationPreview(definition, call.args, executionContext),
              confirmationToken: prepared.token,
              expiresAt: prepared.expiresAt,
              objectRevision: prepared.objectRevision,
            };
            const preparedClassicPath = registry.classicPath(
              capabilityId,
              call.args,
              executionContext,
            );
            const modelResult = {
              ok: true,
              status: 202,
              confirmationRequired: true,
              capabilityId,
              resultId: toolRunId,
            };
            await store.finishToolRun(pool, {
              userId,
              toolRunId,
              modelResult,
              authoritativeResult,
              renderer: 'confirmation',
              classicPath: preparedClassicPath,
              durationMs: Date.now() - started,
              dataKey: config.dataEncryptionKey,
            });
            knownResultIds.add(toolRunId);
            turnResultIds.push(toolRunId);
            const event = {
              type: 'confirmation.required',
              resultId: toolRunId,
              capabilityId,
              token: prepared.token,
              expiresAt: prepared.expiresAt,
            };
            confirmationEvents.push(event);
            await emit(event);
            await emit({
              type: 'tool.completed', toolCallId: call.id, capabilityId,
              title: definition.title,
              resultId: toolRunId, status: 'confirmation_required',
              durationMs: Date.now() - started,
              elapsedMs: Date.now() - turnStartedAt,
            });
            return { ok: true, ...modelResult };
          }

          const result = await registry.execute(capabilityId, call.args, executionContext);
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
          knownResultIds.add(toolRunId);
          turnResultIds.push(toolRunId);
          await emit({
            type: 'tool.completed', toolCallId: call.id, capabilityId,
            title: definition.title,
            resultId: toolRunId, status: 'completed',
            durationMs: Date.now() - started,
            elapsedMs: Date.now() - turnStartedAt,
          });
          return {
            ok: true,
            capabilityId,
            resultId: toolRunId,
            renderer: result.renderer,
            data: result.modelResult,
          };
        } catch (error) {
          if (toolRunId) {
            await store.finishToolRun(pool, {
              userId,
              toolRunId,
              modelResult: toolFailure(error),
              status: 'failed',
              durationMs: Date.now() - started,
              dataKey: config.dataEncryptionKey,
            }).catch(() => {});
          }
          await emit({
            type: 'tool.completed', toolCallId: call.id, capabilityId,
            title: definition.title,
            resultId: null, status: 'failed', errorCode: safeCode(error),
            durationMs: Date.now() - started,
            elapsedMs: Date.now() - turnStartedAt,
          });
          return toolFailure(error);
        }
      }

      // Seed the first provider request with deterministic, authorized matches.
      // This removes an entire model round-trip for ordinary requests while
      // retaining search_capabilities for ambiguous or multi-step work.
      if (kind === 'user_turn') {
        const initialMatches = registry.search(messageText, executionContext, { limit: 8 });
        for (const match of initialMatches) await exposeCapability(match.id);
      }
      for (let iteration = 1; iteration <= iterationLimit; iteration += 1) {
        if (Date.now() >= deadlineAt) {
          throw new GlobalChatOrchestrationError(
            'turn_timeout',
            'Global Chat exceeded the turn deadline.',
          );
        }
        const suggestionOnly = kind === 'more_suggestions';
        const mustUseCapability = kind === 'user_turn'
          && exposed.size > 0
          && turnResultIds.length === 0
          && !capabilityAttempted;
        const currentToolSet = toolSet(suggestionOnly ? [] : [...exposed.values()], {
          includeSearch: !suggestionOnly,
          includeDescribe: !suggestionOnly,
          // When a selected capability requires a value the user did not
          // provide and no read can discover, the model needs one safe escape
          // from forced tool use instead of looping with guessed arguments.
          includeAsk: mustUseCapability,
          // For a platform-data request, do not let the model skip straight to
          // a plausible-sounding answer. At least one authoritative capability
          // must finish before presentation becomes an available tool.
          includePresent: !mustUseCapability,
        });
        const metadata = buildRuntimeMetadata({
          request: {
            id: turnId,
            kind,
            locale: context.locale,
            timezone: context.timezone,
          },
          client,
          actor: {
            id: userId,
            username: actor.username,
            roles: actor.roles,
            capabilityRegistryVersion: registry.version,
          },
          context: {
            activeAppSlug: context.activeAppSlug,
            activeObject: context.activeObject,
            // Summary text is derived and bounded by the owned server-side
            // transcript store. A caller-provided summary must never enter a
            // system message, even though its underlying conversation text
            // remains untrusted data under rule 2 of the system prompt.
            threadSummary: ownedThread?.summary || null,
            excludedSuggestionIds: [...excludedSuggestionIds],
          },
          globalChatProfile,
          developmentProfile,
          budget,
          availableCapabilityIds: [...exposed.keys()],
          availableCapabilities: [...exposed.values()].map((definition) => ({
            id: definition.id,
            domain: definition.domain,
            title: definition.title,
            summary: definition.summary,
            risk: definition.risk,
            confirmation: definition.confirmation,
            requiredInputs: definition.inputSchema.required || [],
          })),
        });
        const workflowPrompt = suggestionOnly
          ? MORE_SUGGESTIONS_PROMPT
          : (loopMessages.some((message) => message.role === 'tool')
            ? RESULT_FOLLOWUP_PROMPT
            : null);
        const messages = invocationMessages(workflowPrompt, metadata, transcript, loopMessages);

        await emitProgress(
          'planning',
          iteration === 1 ? 'Planning the fastest safe path…' : 'Planning the next step…',
          { attempt: 1, iteration },
        );
        const waitingTimer = setTimeout(() => {
          void emitProgress(
            'waiting_model',
            `Waiting for ${model.name || model.id}…`,
            { attempt: 1, iteration },
          );
        }, 4_000);
        let response;
        try {
          providerInvocationCount += 1;
          response = await accounting.invokeAccounted({
            pool,
            config,
            apiKey,
            userId,
            threadId,
            messageId: userMessage.id,
            model,
            reasoningEffort: globalChatProfile.reasoningEffort,
            spendCapUsd: globalChatProfile.spendCapUsd,
            providerAllowance,
            attemptNumber: 1,
            messages,
            tools: currentToolSet.tools,
            sessionId: `${threadId}:${PROVIDER_SESSION_REVISION}`,
            // Five or six compact suggestions plus a strict tool envelope fit
            // comfortably inside the transport default. Keeping the full
            // 800-token allowance avoids turning a provider-side length
            // cutoff into an incomplete turn; the one-call read fast path
            // is what removes latency, not an unsafe output cap.
            maxOutputTokens: 800,
            temperature: model.supportsTemperature === false ? null : 0.1,
            parallelToolCalls: model.supportsParallelToolCalls === true ? true : null,
            toolChoice: suggestionOnly
              ? { type: 'function', function: { name: BASE_TOOL_NAMES.PRESENT } }
              : (mustUseCapability ? 'required' : 'auto'),
            timeoutMs: Math.max(1_000, Math.min(
              PROVIDER_TIMEOUT_MS,
              deadlineAt - Date.now(),
            )),
            signal,
          });
        } catch (error) {
          if (Date.now() >= deadlineAt) {
            throw new GlobalChatOrchestrationError(
              'turn_timeout',
              'Global Chat exceeded the turn deadline.',
            );
          }
          throw error;
        } finally {
          clearTimeout(waitingTimer);
        }
        servedModel = response.servedModel || servedModel;
        const rawCalls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
        if (!rawCalls.length) {
          throw new GlobalChatOrchestrationError(
            'presentation_required',
            'The model did not finish with a validated presentation.',
          );
        }
        if (rawCalls.length > MAX_PARALLEL_READS + 4) {
          throw new GlobalChatOrchestrationError('too_many_tool_calls', 'The model requested too many tools at once.');
        }
        const calls = rawCalls.map(providerCall);
        if (new Set(calls.map((call) => call.id)).size !== calls.length) {
          throw new GlobalChatOrchestrationError('invalid_tool_call', 'Provider repeated a tool-call id.');
        }
        loopMessages.push(response.assistantMessage || {
          role: 'assistant', content: null, tool_calls: rawCalls,
        });

        const outcomes = new Map();
        const capabilityCalls = [];
        const presentationCalls = [];
        const availableToolNames = new Set(
          currentToolSet.tools.map((tool) => tool.function.name),
        );
        for (const call of calls) {
          try {
            if (!availableToolNames.has(call.name)) {
              throw new GlobalChatOrchestrationError(
                'invalid_tool_call',
                'The model selected a tool that was not available in this step.',
              );
            } else if (call.name === BASE_TOOL_NAMES.PRESENT) {
              validateBaseArguments(call.name, call.args);
              presentationCalls.push({ call, args: call.args, clarification: false });
            } else if (call.name === BASE_TOOL_NAMES.ASK) {
              validateBaseArguments(call.name, call.args);
              if (!call.args.question.trim().endsWith('?')) {
                throw new GlobalChatOrchestrationError(
                  'invalid_presentation',
                  'A clarification must be one specific question.',
                );
              }
              presentationCalls.push({
                call,
                args: {
                  message: call.args.question,
                  resultRefs: [],
                  suggestions: call.args.suggestions,
                },
                clarification: true,
              });
            } else if (call.name === BASE_TOOL_NAMES.SEARCH) {
              validateBaseArguments(call.name, call.args);
              const matches = registry.search(
                `${call.args.query} ${call.args.context || ''}`,
                executionContext,
                { limit: 8 },
              );
              for (const match of matches) await exposeCapability(match.id);
              outcomes.set(call.id, {
                ok: true,
                capabilities: matches.map((match) => ({
                  ...match,
                  toolName: capabilityToolName(match.id),
                })),
              });
            } else if (call.name === BASE_TOOL_NAMES.DESCRIBE) {
              validateBaseArguments(call.name, call.args);
              const detail = registry.describe(call.args.capabilityId, executionContext);
              await exposeCapability(detail.id);
              outcomes.set(call.id, {
                ok: true,
                capability: {
                  ...detail,
                  toolName: capabilityToolName(detail.id),
                },
              });
            } else {
              const capabilityId = currentToolSet.capabilityByToolName.get(call.name);
              if (!capabilityId) throw new GlobalChatOrchestrationError(
                'invalid_tool_call',
                'The model selected a tool that was not exposed.',
              );
              capabilityCalls.push({ call, capabilityId, definition: exposed.get(capabilityId) });
            }
          } catch (error) {
            outcomes.set(call.id, toolFailure(error));
          }
        }

        const reads = capabilityCalls.filter(({ definition }) => definition.risk === 'read');
        const writes = capabilityCalls.filter(({ definition }) => definition.risk !== 'read');
        if (capabilityCalls.length) capabilityAttempted = true;
        if (capabilityCalls.length) {
          const titles = capabilityCalls.map(({ definition }) => definition.title);
          const summary = titles.length === 1
            ? titles[0]
            : `${titles.slice(0, -1).join(', ')} and ${titles.at(-1)}`;
          await emitProgress(
            'running_tools',
            `${reads.length === capabilityCalls.length ? 'Fetching' : 'Running'} ${summary}…`,
            {
              parallel: reads.length > 1,
              operations: capabilityCalls.map(({ call, capabilityId, definition }) => ({
                toolCallId: call.id,
                capabilityId,
                title: definition.title,
                risk: definition.risk,
              })),
            },
          );
        }
        const readResults = await inBatches(reads, MAX_PARALLEL_READS, async (entry) => ({
          id: entry.call.id,
          result: await executeCapability(entry.call, entry.capabilityId),
        }));
        for (const entry of readResults) outcomes.set(entry.id, entry.result);
        for (const entry of writes) {
          outcomes.set(entry.call.id, await executeCapability(entry.call, entry.capabilityId));
        }

        let presentation = null;
        if (presentationCalls.length === 1) {
          try {
            const presentationCall = presentationCalls[0];
            const requestedPresentation = presentationCall.args;
            const presentationInput = requestedPresentation.resultRefs.length === 0
              && turnResultIds.length > 0
              ? {
                ...requestedPresentation,
                resultRefs: turnResultIds.slice(-MAX_RESULT_REFS),
              }
              : requestedPresentation;
            if (!presentationCall.clarification
                && kind === 'user_turn'
                && exposed.size > 0
                && turnResultIds.length === 0
                && !capabilityAttempted) {
              throw new GlobalChatOrchestrationError(
                'capability_required',
                'Use an authoritative Homeroom capability before presenting platform facts.',
              );
            }
            presentation = enrichPresentation(validatePresentation(presentationInput, {
              availableResultIds: knownResultIds,
              excludedSuggestionIds,
            }), {
              context: capabilityCalls.at(-1)?.definition?.domain || suggestionContext,
            });
            outcomes.set(presentationCall.call.id, { ok: true, accepted: true });
          } catch (error) {
            outcomes.set(presentationCalls[0].call.id, toolFailure(error));
          }
        } else if (presentationCalls.length > 1) {
          for (const entry of presentationCalls) {
            outcomes.set(entry.call.id, toolFailure(new GlobalChatOrchestrationError(
              'invalid_presentation',
              'Only one presentation may finish a turn.',
            )));
          }
        }

        // Successful independent reads already have everything the interface
        // needs: authoritative results and item-level actions. The model chose
        // every operation, so the server can render all results without a
        // second model round trip. Requests that need synthesis, writes, or a
        // failed read stay in the full agent loop.
        if (!presentation && presentationCalls.length === 0
            && canFastCompleteReads(messageText, capabilityCalls, outcomes)) {
          try {
            const completedDomains = new Set(
              capabilityCalls.map(({ definition }) => definition.domain),
            );
            presentation = automaticPresentation({
              domain: completedDomains.size === 1
                ? capabilityCalls[0].definition.domain
                : 'general',
              resultRefs: turnResultIds.slice(-MAX_RESULT_REFS),
              excludedSuggestionIds,
              excludedActionIds: completedSuggestionActionIds(capabilityCalls),
            });
          } catch {
            // A long-lived thread can exhaust the deterministic option pool.
            // In that rare case the normal model presentation loop remains the
            // safe fallback and can generate genuinely new suggestions.
          }
        }

        for (const call of calls) {
          loopMessages.push(toolMessage(call.id, outcomes.get(call.id) || toolFailure(
            new GlobalChatOrchestrationError('invalid_tool_call', 'Tool call was not handled.'),
          )));
        }

        if (presentation) {
          await emitProgress('rendering', 'Rendering the results…');
          const attached = await store.loadToolResults(pool, {
            userId,
            threadId,
            resultIds: presentation.resultRefs,
            dataKey: config.dataEncryptionKey,
          });
          if (attached.length !== presentation.resultRefs.length) {
            throw new GlobalChatOrchestrationError(
              'unknown_result_reference',
              'One or more results are no longer available.',
            );
          }
          for (const suggestion of presentation.suggestions) excludedSuggestionIds.add(suggestion.id);
          const assistantMessage = await store.insertMessage(pool, {
            userId,
            threadId,
            role: 'assistant',
            text: presentation.message,
            payload: { kind, presentation },
            promptVersion: PROMPT_VERSION,
            model: servedModel,
            reasoningEffort: globalChatProfile.reasoningEffort,
          });
          for (const result of attached) await emit({ type: 'result.attached', result });
          await emit({
            type: 'turn.completed',
            turnId,
            message: assistantMessage,
            presentation,
          });
          if (typeof accounting.recordTurnOutcome === 'function') {
            await accounting.recordTurnOutcome(pool, {
              userId,
              threadId,
              messageId: userMessage.id,
              outcome: 'success',
              durationMs: Date.now() - turnStartedAt,
              invocationCount: providerInvocationCount,
              resultCount: turnResultIds.length,
            }).catch(() => {});
          }
          return {
            turnId,
            message: assistantMessage,
            presentation,
            results: attached,
            confirmations: confirmationEvents,
          };
        }
      }

      throw new GlobalChatOrchestrationError(
        'iteration_limit',
        'Global Chat could not complete that request within the tool limit.',
      );
    } catch (error) {
      let assistantMessage = null;
      if (userMessage && error?.code !== 'cancelled') {
        const failure = toolFailure(error);
        assistantMessage = await store.insertMessage(pool, {
          userId,
          threadId,
          role: 'assistant',
          text: failure.error.message,
          payload: {
            kind: 'turn_error',
            errorCode: failure.error.code,
          },
          promptVersion: PROMPT_VERSION,
          model: model?.id || null,
          reasoningEffort: globalChatProfile?.reasoningEffort || null,
        }).catch(() => null);
      }
      if (userMessage && typeof accounting.recordTurnOutcome === 'function') {
        await accounting.recordTurnOutcome(pool, {
          userId,
          threadId,
          messageId: userMessage.id,
          outcome: error?.code === 'cancelled' ? 'cancelled' : 'error',
          errorCode: safeCode(error),
          durationMs: Date.now() - turnStartedAt,
          invocationCount: providerInvocationCount,
          resultCount: turnResultIds.length,
        }).catch(() => {});
      }
      if (turnId) {
        await emit({
          type: 'turn.failed',
          turnId,
          code: safeCode(error),
          message: toolFailure(error).error.message,
          assistantMessage,
        }).catch(() => {});
      }
      throw error;
    } finally {
      if (turnId) {
        await store.releaseTurn(pool, { userId, threadId, turnId }).catch(() => {});
      }
    }
  }

  return { runTurn };
}

module.exports = {
  MAX_EXPOSED_CAPABILITIES,
  MAX_HISTORY_MESSAGES,
  MAX_ITERATIONS,
  MAX_PARALLEL_READS,
  PROVIDER_TIMEOUT_MS,
  TURN_TIMEOUT_MS,
  GlobalChatOrchestrationError,
  boundedToolContent,
  createGlobalChatOrchestrator,
  canFastCompleteRead,
  canFastCompleteReads,
  historyForModel,
  parseArguments,
  transcriptState,
};
