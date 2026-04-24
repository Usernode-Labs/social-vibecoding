const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

let currentLevel = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.INFO;

// #30: patterns scrubbed from every log line + every ring-buffer entry
// before they're persisted. These are defense in depth — callers
// SHOULD avoid passing secrets in the first place, but a single
// `log.warn('docker', err.message)` where `err.cmd` happens to contain
// a key shouldn't be a security incident. Order matters: more
// specific patterns first so generic ones don't pre-scrub them.
const SENSITIVE_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]+/g,              // Anthropic API keys (user + admin)
  /ghp_[A-Za-z0-9]{20,}/g,                // GitHub personal access tokens
  /ghs_[A-Za-z0-9]{20,}/g,                // GitHub app installation tokens
  /x-access-token:[^@\s]+@/g,             // credentialed git URLs
  /password["']?\s*[:=]\s*["']?\S+/gi,
];

// Ring buffer of recent events, consumed by the /status dashboard.
const RING_SIZE = 200;
const ring = [];

function redactString(str) {
  if (typeof str !== 'string' || !str) return str;
  for (const pattern of SENSITIVE_PATTERNS) {
    str = str.replace(pattern, '****');
  }
  return str;
}

// Recursively redact any string values inside an object/array so the
// ring buffer (served over the /status dashboard) never holds raw
// credentials even if a caller passes a whole error object.
function redactDeep(value) {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out;
  }
  return value;
}

function redact(obj) {
  if (!obj) return obj;
  const str = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return redactString(str);
}

function formatData(data) {
  if (data === undefined) return '';
  if (typeof data === 'string') return ' ' + redactString(data);
  return ' ' + redactString(JSON.stringify(data));
}

function log(level, category, message, data) {
  if (LEVELS[level] < currentLevel) return;
  const ts = new Date().toISOString();
  const padded = level.padEnd(5);
  // Redact the message itself — callers frequently pass err.message
  // directly as the message, which for execFile failures can contain
  // argv (and thus any inlined secret).
  const safeMessage = redactString(message);
  const line = `[${ts}] ${padded} [${category}] ${safeMessage}${formatData(data)}`;

  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else console.log(line);

  ring.push({
    ts, level, category,
    message: safeMessage,
    data: data === undefined ? null : redactDeep(data),
  });
  if (ring.length > RING_SIZE) ring.shift();
}

function tail(n = 50) {
  return ring.slice(-n).reverse();
}

function setLevel(level) {
  if (LEVELS[level] !== undefined) currentLevel = LEVELS[level];
}

module.exports = {
  debug: (cat, msg, data) => log('DEBUG', cat, msg, data),
  info: (cat, msg, data) => log('INFO', cat, msg, data),
  warn: (cat, msg, data) => log('WARN', cat, msg, data),
  error: (cat, msg, data) => log('ERROR', cat, msg, data),
  setLevel,
  redact,
  tail,
};
