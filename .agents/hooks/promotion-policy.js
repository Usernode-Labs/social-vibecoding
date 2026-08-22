'use strict';

const OPENCODE_MCP_SERVER = 'social_vibecoding';
const OPENCODE_REVIEWED_TOOL_SUFFIXES = Object.freeze([
  'login_status',
  'whoami',
  'api_read',
  'api_write',
  'proposal_start',
  'proposal_append_context',
  'proposal_upload_image',
  'proposal_push_commit',
  'proposal_submit_build',
  'proposal_status',
  'proposal_promote',
]);

function sanitizeOpenCodeToolName(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function openCodeToolName(suffix) {
  return `${sanitizeOpenCodeToolName(OPENCODE_MCP_SERVER)}_${sanitizeOpenCodeToolName(`social_vibecoding.${suffix}`)}`;
}

const OPENCODE_REVIEWED_TOOLS = Object.freeze(
  Object.fromEntries(OPENCODE_REVIEWED_TOOL_SUFFIXES.map((suffix) => [
    suffix,
    openCodeToolName(suffix),
  ]))
);

function promotionSessionId(target) {
  if (typeof target !== 'string' || !target.startsWith('/') || target.includes('%')) return null;
  let parsed;
  try {
    parsed = new URL(target, 'https://usernode.invalid');
  } catch {
    return null;
  }
  // Express routes are case-insensitive and trailing-slash tolerant unless
  // the application explicitly enables stricter settings.
  const match = parsed.pathname.match(/^\/api\/sessions\/([1-9]\d*)\/promote\/?$/i);
  return match ? match[1] : null;
}

function isTool(toolName, suffix) {
  return typeof toolName === 'string' && toolName.endsWith(suffix);
}

function commandMentionsPromotionRoute(command) {
  return typeof command === 'string'
    && /\/api\/sessions\//i.test(command)
    && /\/promote\/?(?:[?'"\s]|$)/i.test(command);
}

function parseSimpleCommand(command, platform = process.platform) {
  if (typeof command !== 'string' || !command.length) return null;
  const windows = platform === 'win32';
  const source = windows ? command.replace(/^\s*&\s+/, '') : command;
  const tokens = [];
  let token = '';
  let state = 'bare';
  let started = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (state === 'single') {
      if (char === "'") state = 'bare';
      else token += char;
      started = true;
      continue;
    }
    if (state === 'double') {
      if (char === '"') {
        state = 'bare';
      } else if (char === '\\') {
        if (windows) {
          token += char;
        } else {
          i += 1;
          if (i >= source.length) return null;
          token += source[i];
        }
      } else if (char === '$' || char === '`') {
        return null;
      } else {
        token += char;
      }
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(token);
        token = '';
        started = false;
      }
      continue;
    }
    if (char === "'") {
      state = 'single';
      started = true;
      continue;
    }
    if (char === '"') {
      state = 'double';
      started = true;
      continue;
    }
    if (char === '\\') {
      if (windows) {
        token += char;
      } else {
        i += 1;
        if (i >= source.length) return null;
        token += source[i];
      }
      started = true;
      continue;
    }
    if (';&|<>`$()'.includes(char)) return null;
    token += char;
    started = true;
  }
  if (state !== 'bare') return null;
  if (started) tokens.push(token);
  return tokens;
}

module.exports = {
  OPENCODE_MCP_SERVER,
  OPENCODE_REVIEWED_TOOL_SUFFIXES,
  OPENCODE_REVIEWED_TOOLS,
  commandMentionsPromotionRoute,
  isTool,
  openCodeToolName,
  parseSimpleCommand,
  promotionSessionId,
  sanitizeOpenCodeToolName,
};
