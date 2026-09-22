'use strict';

// #2380 — one versioned contract for semantic evidence intent and the
// executable replay plan derived from it. This module is deliberately pure:
// routes, MCP tools, workers and the replay runtime all call the same parser,
// so a plan cannot become more permissive as it crosses a process boundary.

const crypto = require('crypto');
const { z } = require('zod');

const PLAN_VERSION = 1;
const MAX_STORIES = 3;
const MAX_VIEWPORTS = 2;
const MAX_ACTIONS_PER_SIDE = 40;
const MAX_WAIT_MS = 10_000;
const MAX_SIDE_MS = 45_000;
const MAX_TEXT = 1_000;
const MAX_TYPED_VALUE = 100;
const MAX_LOCATOR_VALUE = 256;
const MAX_PATH = 512;

const IMPACTS = Object.freeze(['ui', 'motion', 'none']);
const PERSONAS = Object.freeze(['member', 'read_only_admin']);
const ANIMATIONS = Object.freeze(['none', 'steps', 'motion']);
const LOCATOR_KINDS = Object.freeze(['testId', 'role', 'label', 'placeholder', 'text', 'css']);
const ACTION_TYPES = Object.freeze([
  'navigate', 'click', 'fill', 'press', 'select', 'check', 'uncheck',
  'hover', 'drag', 'clickPoint', 'dragPoints', 'scrollIntoView', 'scrollBy',
  'waitFor',
]);
const ASSERTION_TYPES = Object.freeze([
  'visible', 'hidden', 'attached', 'detached', 'text', 'count', 'value',
  'checked', 'url', 'focusWithin',
]);

const ID_RE = /^[a-z0-9](?:[a-z0-9_-]{0,94}[a-z0-9])?$/;
const STAGE_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const VIEWPORT_RE = /^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const ABSOLUTE_URL_RE = /^[a-z][a-z0-9+.-]*:/i;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/ig;
const CREDENTIAL_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/i,
  /\b(?:sk|gh[pousr]|github_pat|glpat|xox[baprs]|AIza)[-_][A-Za-z0-9_-]{12,}\b/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
]);

class VisualEvidenceValidationError extends Error {
  constructor(issues) {
    const normalized = Array.isArray(issues) ? issues : [{ path: [], message: String(issues) }];
    super(normalized.map((issue) => {
      const path = Array.isArray(issue.path) && issue.path.length ? issue.path.join('.') : 'visualEvidence';
      return `${path}: ${issue.message}`;
    }).join('; '));
    this.name = 'VisualEvidenceValidationError';
    this.code = 'invalid_visual_evidence';
    this.issues = normalized.map((issue) => ({
      path: Array.isArray(issue.path) ? issue.path.map(String) : [],
      message: String(issue.message || 'Invalid value'),
    }));
  }
}

function singleLine(value) {
  return typeof value === 'string' && value.trim() === value
    && !CONTROL_RE.test(value) && !/[\r\n]/.test(value);
}

function textField(max = MAX_TEXT, min = 1) {
  return z.string().min(min).max(max).refine(singleLine, 'Must be a trimmed single line without control characters');
}

function validRelativePath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_PATH) return false;
  if (!singleLine(value) || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return false;
  if (ABSOLUTE_URL_RE.test(value) || /%2f%2f/i.test(value)) return false;
  try {
    const parsed = new URL(value, 'https://evidence.invalid');
    return parsed.origin === 'https://evidence.invalid'
      && !parsed.username && !parsed.password
      && ![...parsed.searchParams.keys()].some((key) => /^(?:token|access_token|auth|authorization|password|passwd|secret|api[_-]?key)$/i.test(key))
      && parsed.pathname.startsWith('/');
  } catch {
    return false;
  }
}

const relativePathSchema = z.string().max(MAX_PATH)
  .refine(validRelativePath, 'Must be one relative in-app path beginning with a single "/"')
  .refine((value) => {
    let decoded = value;
    try { decoded = decodeURIComponent(value); } catch { /* malformed escapes are rejected by validRelativePath */ }
    return !credentialLike(value) && !credentialLike(decoded);
  }, 'Must not contain credentials, tokens, or non-fixture email addresses');

function credentialLike(value, fixtureDomains = ['example.test', 'example.invalid', 'test.invalid']) {
  const text = String(value || '');
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text))) return true;
  EMAIL_RE.lastIndex = 0;
  let match;
  while ((match = EMAIL_RE.exec(text))) {
    if (!fixtureDomains.includes(String(match[1]).toLowerCase())) return true;
  }
  return false;
}

function literalSchema(max = MAX_TYPED_VALUE) {
  return z.string().max(max)
    .refine((value) => !CONTROL_RE.test(value), 'Must not contain control characters')
    .refine((value) => !credentialLike(value), 'Must not contain credentials, tokens, or non-fixture email addresses');
}

const locatorSchema = z.union([
  z.object({ by: z.literal('testId'), value: textField(MAX_LOCATOR_VALUE) }).strict(),
  z.object({
    by: z.literal('role'),
    role: textField(64),
    name: textField(MAX_LOCATOR_VALUE).optional(),
    exact: z.boolean().optional().default(true),
  }).strict(),
  z.object({ by: z.literal('label'), value: textField(MAX_LOCATOR_VALUE), exact: z.boolean().optional().default(true) }).strict(),
  z.object({ by: z.literal('placeholder'), value: textField(MAX_LOCATOR_VALUE), exact: z.boolean().optional().default(true) }).strict(),
  z.object({ by: z.literal('text'), value: textField(MAX_LOCATOR_VALUE), exact: z.boolean().optional().default(true) }).strict(),
  z.object({ by: z.literal('css'), value: textField(MAX_LOCATOR_VALUE) }).strict()
    .refine(({ value }) => !/^\s*(?:html|body|\*)\s*$/i.test(value), 'Unbounded root selectors are not allowed'),
]);

const viewportSchema = z.object({
  name: z.string().min(1).max(32).regex(VIEWPORT_RE),
  width: z.number().int().min(320).max(1920),
  height: z.number().int().min(480).max(1440),
}).strict();

const intentSchema = z.object({
  startPath: relativePathSchema,
  steps: z.array(textField(200)).min(1).max(MAX_ACTIONS_PER_SIDE),
  checkpoint: textField(500),
  focus: textField(200),
  // An explicit author declaration for a genuinely new screen/control. The
  // replay still has to capture and assert an honest stable parent on base;
  // this field only controls the reviewer-facing absence label. Missing
  // media is never inferred to mean absence.
  baseState: z.enum(['present', 'not_present']).default('present'),
  animation: z.enum(ANIMATIONS).default('none'),
}).strict();

const storyIntentObject = z.object({
  id: z.string().min(1).max(96).regex(ID_RE),
  claim: textField(MAX_TEXT),
  persona: z.enum(PERSONAS),
  viewports: z.array(viewportSchema).min(1).max(MAX_VIEWPORTS),
  intent: intentSchema,
}).strict();

const storyIntentSchema = storyIntentObject.superRefine((story, ctx) => {
  const names = new Set();
  story.viewports.forEach((viewport, index) => {
    if (names.has(viewport.name)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['viewports', index, 'name'], message: 'Viewport names must be unique within a story' });
    }
    names.add(viewport.name);
  });
});

const semanticIntentSchema = z.object({
  version: z.literal(PLAN_VERSION),
  impact: z.enum(IMPACTS),
  rationale: textField(MAX_TEXT),
  stories: z.array(storyIntentSchema).max(MAX_STORIES).default([]),
}).strict().superRefine((intent, ctx) => {
  if (intent.impact === 'none' && intent.stories.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stories'], message: 'No stories are allowed when impact is "none"' });
  }
  if (intent.impact !== 'none' && intent.stories.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stories'], message: 'At least one evidence story is required for a visible change' });
  }
  const ids = new Set();
  intent.stories.forEach((story, index) => {
    if (ids.has(story.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stories', index, 'id'], message: 'Story ids must be unique' });
    }
    ids.add(story.id);
    if (intent.impact === 'ui' && story.intent.animation === 'motion') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stories', index, 'intent', 'animation'], message: 'The motion profile requires impact "motion"' });
    }
  });
});

const actionBase = {
  id: z.string().min(1).max(96).regex(ID_RE),
  stage: z.string().min(1).max(64).regex(STAGE_RE),
};

const pointerRatio = z.number().min(0).max(1);
const actionSchema = z.union([
  z.object({ ...actionBase, type: z.literal('navigate'), path: relativePathSchema }).strict(),
  z.object({ ...actionBase, type: z.literal('click'), target: locatorSchema }).strict(),
  z.object({ ...actionBase, type: z.literal('fill'), target: locatorSchema, value: literalSchema() }).strict(),
  z.object({ ...actionBase, type: z.literal('press'), target: locatorSchema.optional(), key: textField(40) }).strict()
    .refine(({ key }) => /^(?:(?:Control|Meta|Alt|Shift)\+)?(?:Enter|Escape|Tab|Space|Backspace|Delete|Home|End|PageUp|PageDown|Arrow(?:Up|Down|Left|Right))$/.test(key), 'Unsupported key'),
  z.object({ ...actionBase, type: z.literal('select'), target: locatorSchema, value: literalSchema() }).strict(),
  z.object({ ...actionBase, type: z.literal('check'), target: locatorSchema }).strict(),
  z.object({ ...actionBase, type: z.literal('uncheck'), target: locatorSchema }).strict(),
  z.object({ ...actionBase, type: z.literal('hover'), target: locatorSchema }).strict(),
  z.object({ ...actionBase, type: z.literal('drag'), from: locatorSchema, to: locatorSchema }).strict(),
  z.object({ ...actionBase, type: z.literal('clickPoint'), surface: locatorSchema, xRatio: pointerRatio, yRatio: pointerRatio }).strict(),
  z.object({
    ...actionBase,
    type: z.literal('dragPoints'),
    surface: locatorSchema,
    from: z.object({ xRatio: pointerRatio, yRatio: pointerRatio }).strict(),
    to: z.object({ xRatio: pointerRatio, yRatio: pointerRatio }).strict(),
  }).strict(),
  z.object({ ...actionBase, type: z.literal('scrollIntoView'), target: locatorSchema }).strict(),
  z.object({
    ...actionBase,
    type: z.literal('scrollBy'),
    x: z.number().int().min(-2000).max(2000).default(0),
    y: z.number().int().min(-2000).max(2000).default(0),
  }).strict().refine(({ x, y }) => x !== 0 || y !== 0, 'scrollBy must move on at least one axis'),
  z.object({
    ...actionBase,
    type: z.literal('waitFor'),
    target: locatorSchema.optional(),
    text: textField(MAX_LOCATOR_VALUE).optional(),
    path: relativePathSchema.optional(),
    quietNetwork: z.boolean().optional(),
    timeoutMs: z.number().int().min(100).max(MAX_WAIT_MS).default(MAX_WAIT_MS),
  }).strict().refine((value) => [value.target, value.text, value.path, value.quietNetwork === true].filter(Boolean).length === 1,
    'waitFor requires exactly one of target, text, path, or quietNetwork'),
]);

const assertionSchema = z.discriminatedUnion('type', [
  ...['visible', 'hidden', 'attached', 'detached', 'checked', 'focusWithin'].map((type) =>
    z.object({ type: z.literal(type), target: locatorSchema }).strict()),
  z.object({ type: z.literal('text'), target: locatorSchema, value: literalSchema(MAX_LOCATOR_VALUE), exact: z.boolean().default(false) }).strict(),
  z.object({ type: z.literal('count'), target: locatorSchema, count: z.number().int().min(0).max(1000) }).strict(),
  z.object({ type: z.literal('value'), target: locatorSchema, value: literalSchema() }).strict(),
  z.object({ type: z.literal('url'), path: relativePathSchema }).strict(),
]);

const sideSchema = z.object({
  startPath: relativePathSchema,
  actions: z.array(actionSchema).max(MAX_ACTIONS_PER_SIDE),
}).strict().superRefine((side, ctx) => {
  const ids = new Set();
  side.actions.forEach((action, index) => {
    if (ids.has(action.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['actions', index, 'id'], message: 'Action ids must be unique within a side' });
    }
    ids.add(action.id);
  });
});

const checkpointSchema = z.object({
  id: z.string().min(1).max(96).regex(ID_RE),
  label: textField(200),
  focus: z.object({ before: locatorSchema, after: locatorSchema }).strict(),
  assertions: z.object({
    before: z.array(assertionSchema).min(1).max(30),
    after: z.array(assertionSchema).min(1).max(30),
  }).strict(),
  animation: z.enum(ANIMATIONS).default('none'),
}).strict();

const replaySchema = z.object({
  before: sideSchema,
  after: sideSchema,
  checkpoint: checkpointSchema,
}).strict();

const executableStorySchema = storyIntentObject.extend({ replay: replaySchema }).strict()
  .superRefine((story, ctx) => {
    const names = new Set();
    story.viewports.forEach((viewport, index) => {
      if (names.has(viewport.name)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['viewports', index, 'name'], message: 'Viewport names must be unique within a story' });
      }
      names.add(viewport.name);
    });
  });

const replayPlanSchema = z.object({
  version: z.literal(PLAN_VERSION),
  impact: z.enum(['ui', 'motion']),
  rationale: textField(MAX_TEXT),
  stories: z.array(executableStorySchema).min(1).max(MAX_STORIES),
}).strict().superRefine((plan, ctx) => {
  const ids = new Set();
  plan.stories.forEach((story, index) => {
    if (ids.has(story.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stories', index, 'id'], message: 'Story ids must be unique' });
    }
    ids.add(story.id);
    if (story.intent.animation !== story.replay.checkpoint.animation) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stories', index, 'replay', 'checkpoint', 'animation'], message: 'Replay animation must match the accepted intent' });
    }
    if (plan.impact === 'ui' && story.replay.checkpoint.animation === 'motion') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stories', index, 'replay', 'checkpoint', 'animation'], message: 'The motion profile requires impact "motion"' });
    }
    if (story.replay.checkpoint.animation === 'steps'
        && [story.replay.before, story.replay.after].some((side) =>
          side.actions.every((action) => action.type === 'waitFor'))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stories', index, 'replay', 'checkpoint', 'animation'],
        message: 'Steps video requires a visible interaction on both revisions; wait-only flows use screenshots',
      });
    }
  });
});

function normalizeZodIssues(error) {
  return error.issues.map((issue) => ({ path: issue.path.map(String), message: issue.message }));
}

function parseWith(schema, value) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new VisualEvidenceValidationError(normalizeZodIssues(parsed.error));
  return parsed.data;
}

function parseIntent(value) {
  return parseWith(semanticIntentSchema, value);
}

function parseReplayPlan(value) {
  return parseWith(replayPlanSchema, value);
}

function safeParseIntent(value) {
  try { return { ok: true, value: parseIntent(value), errors: [] }; }
  catch (err) {
    if (!(err instanceof VisualEvidenceValidationError)) throw err;
    return { ok: false, value: null, errors: err.issues };
  }
}

function safeParseReplayPlan(value) {
  try { return { ok: true, value: parseReplayPlan(value), errors: [] }; }
  catch (err) {
    if (!(err instanceof VisualEvidenceValidationError)) throw err;
    return { ok: false, value: null, errors: err.issues };
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = canonicalize(value[key]);
      return out;
    }, {});
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function planHash(value) {
  const plan = parseReplayPlan(value);
  return crypto.createHash('sha256').update(canonicalJson(plan)).digest('hex');
}

function semanticIntentFromPlan(value) {
  const plan = parseReplayPlan(value);
  return parseIntent({
    version: plan.version,
    impact: plan.impact,
    rationale: plan.rationale,
    stories: plan.stories.map(({ replay: _replay, ...story }) => story),
  });
}

function containsRelativePointer(plan) {
  const parsed = parseReplayPlan(plan);
  return parsed.stories.some((story) => ['before', 'after'].some((side) =>
    story.replay[side].actions.some((action) => action.type === 'clickPoint' || action.type === 'dragPoints')));
}

module.exports = {
  PLAN_VERSION,
  MAX_STORIES,
  MAX_VIEWPORTS,
  MAX_ACTIONS_PER_SIDE,
  MAX_WAIT_MS,
  MAX_SIDE_MS,
  MAX_TEXT,
  MAX_TYPED_VALUE,
  MAX_LOCATOR_VALUE,
  MAX_PATH,
  IMPACTS,
  PERSONAS,
  ANIMATIONS,
  LOCATOR_KINDS,
  ACTION_TYPES,
  ASSERTION_TYPES,
  VisualEvidenceValidationError,
  validRelativePath,
  credentialLike,
  parseIntent,
  parseReplayPlan,
  safeParseIntent,
  safeParseReplayPlan,
  canonicalJson,
  planHash,
  semanticIntentFromPlan,
  containsRelativePointer,
};
