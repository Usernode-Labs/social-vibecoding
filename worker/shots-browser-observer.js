#!/usr/bin/env node
'use strict';

// Transparent stdio wrapper around Playwright MCP in shots turns. The
// agent's own stream records when a tool call was issued and answered, not
// how long the browser spent on it. This wrapper observes the JSON-RPC
// boundary itself and writes only bounded, content-free diagnostics to a
// worker-local file. The runner tails that file into the shots trace.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Transform } = require('node:stream');
const { performance } = require('node:perf_hooks');
const crypto = require('node:crypto');
const boundary = require('./shots-boundary');

const MARKER = '__USERNODE_SHOTS_BROWSER__ ';
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const ID_TAIL_BYTES = 4096;
const PENDING_INTERVAL_MS = 15_000;
const TOOLS = new Set([
  'browser_navigate', 'browser_navigate_back', 'browser_snapshot',
  'browser_take_screenshot', 'browser_click', 'browser_type',
  'browser_fill_form', 'browser_press_key', 'browser_select_option',
  'browser_hover', 'browser_mouse_move_xy', 'browser_drag', 'browser_resize', 'browser_wait_for',
  'browser_console_messages', 'browser_network_requests', 'browser_tabs',
  'browser_close',
]);

function lineTap(onLine) {
  let parts = [];
  let capturedBytes = 0;
  let lineBytes = 0;
  let tail = Buffer.alloc(0);
  const append = (part) => {
    lineBytes += part.length;
    tail = part.length >= ID_TAIL_BYTES
      ? part.subarray(-ID_TAIL_BYTES)
      : Buffer.concat([tail, part]).subarray(-ID_TAIL_BYTES);
    if (capturedBytes >= MAX_LINE_BYTES) return;
    const bounded = part.subarray(0, MAX_LINE_BYTES - capturedBytes);
    parts.push(bounded);
    capturedBytes += bounded.length;
  };
  return new Transform({
    transform(chunk, _encoding, callback) {
      let offset = 0;
      for (;;) {
        const end = chunk.indexOf(10, offset);
        if (end < 0) { append(chunk.subarray(offset)); break; }
        append(chunk.subarray(offset, end));
        try {
          onLine(Buffer.concat(parts, capturedBytes).toString('utf8'), {
            bytes: lineBytes, truncated: lineBytes > capturedBytes,
            tail: tail.toString('utf8'),
          });
        } catch { /* Observation must never break MCP transport. */ }
        parts = [];
        capturedBytes = 0;
        lineBytes = 0;
        tail = Buffer.alloc(0);
        offset = end + 1;
      }
      callback(null, chunk);
    },
  });
}

function responseId(line, parsed, tail = '') {
  if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'id')) return parsed.id;
  // A screenshot result can exceed MAX_LINE_BYTES. JSON-RPC normally places
  // the id before or after the content. Read only bounded ends in this case.
  const pattern = /"id"\s*:\s*(?:"([^"\\]{1,80})"|(\d{1,16}))/;
  const match = /"id"\s*:\s*(?:"([^"\\]{1,80})"|(\d{1,16}))\s*}\s*$/.exec(tail)
    || pattern.exec(line.slice(0, 4096));
  return match ? (match[1] === undefined ? Number(match[2]) : match[1]) : null;
}

function errorClass(value) {
  const text = String(value || '');
  if (/timeout|timed out/i.test(text)) return 'timeout';
  if (/net::ERR_|ERR_CONNECTION|ECONN|ENOTFOUND/i.test(text)) return 'network';
  if (/target.*closed|browser.*closed|page.*closed/i.test(text)) return 'browser_closed';
  if (/strict mode violation|resolved to \d+ elements/i.test(text)) return 'locator_ambiguous';
  return 'other';
}

function resultShape(message, bytes, truncated) {
  if (!message) return { outcome: 'unparsed', responseBytes: Math.min(bytes, 10_000_000) };
  const result = message.result;
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const texts = blocks.filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text);
  const content = texts.join('\n');
  const failed = !!message.error || result?.isError === true;
  return {
    outcome: message.error ? 'rpc_error' : result?.isError === true ? 'tool_error' : 'ok',
    responseBytes: Math.min(bytes, 10_000_000),
    textChars: Math.min(content.length, 10_000_000),
    imageBlocks: Math.min(blocks.filter((block) => block?.type === 'image').length, 1000),
    headingCount: Math.min((content.match(/^\s*- heading\b/gm) || []).length, 1000),
    buttonCount: Math.min((content.match(/^\s*- button\b/gm) || []).length, 1000),
    linkCount: Math.min((content.match(/^\s*- link\b/gm) || []).length, 1000),
    ...(failed ? { errorClass: errorClass(message.error?.message || content) } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

// The page Playwright says the browser is on. Most tool results end with a
// "### Page state" block naming it; a tab list marks the current tab. A
// screenshot's own result names neither, so the observer keeps the last one.
function reportedPageUrl(text) {
  const pages = [...String(text || '').matchAll(/^- Page URL: (\S+)$/gm)];
  if (pages.length) return pages[pages.length - 1][1];
  const current = /^- \d+: \(current\) \[.*\] \((\S+)\)$/m.exec(String(text || ''));
  return current ? current[1] : null;
}

// Where browser_take_screenshot wrote its file. Read from the raw line too:
// a result over the capture limit still begins with this text.
function savedScreenshotPath(text) {
  const match = /saved it as ([^"\\\n]+?\.(?:png|jpeg))(?:\\n|\n|"|$)/.exec(String(text || ''));
  return match ? match[1] : null;
}

function createObserver({
  persona, origins, hints = {}, emit, now = () => performance.now(),
  outputDir = null, provenance = boundary,
}) {
  // What the shots bridge needs to publish only shots of the app: the site
  // each screenshot was taken on, and every site a recorded session showed.
  let pageUrl = null;
  const sessionOrigins = new Set();
  const notePage = (url) => {
    if (!url) return;
    pageUrl = url;
    const origin = provenance.webOrigin(url);
    if (origin) sessionOrigins.add(origin);
  };
  const insideOutput = (file) => {
    if (!outputDir || !file) return false;
    const resolved = path.resolve(file);
    return path.dirname(resolved) === path.resolve(outputDir);
  };
  const active = new Map();
  const routes = new Map();
  let callOrdinal = 0;
  const safePersona = ['admin', 'full_admin', 'guest'].includes(persona) ? persona : 'member';
  const originList = Array.isArray(origins) ? origins.map((value) => {
    try { return new URL(value).origin; } catch { return null; }
  }) : [];
  const navigation = (args) => {
    let url;
    try { url = new URL(args?.url); } catch { return {}; }
    const side = url.origin === originList[0] ? 'base'
      : url.origin === originList[1] ? 'head' : 'outside';
    if (side === 'outside') return { side };
    const key = `${url.pathname}${url.search}${url.hash}`;
    if (!routes.has(key) && routes.size < 1000) routes.set(key, routes.size + 1);
    const checkRank = Array.isArray(hints.declaredPaths) ? hints.declaredPaths.indexOf(key) + 1 : 0;
    const intentStart = Array.isArray(hints.intentPaths) && hints.intentPaths.includes(key);
    return {
      side,
      ...(routes.has(key) ? { routeOrdinal: routes.get(key) } : {}),
      routeHint: checkRank > 0 ? 'declared_check' : intentStart ? 'intent_start' : 'other',
      ...(checkRank > 0 ? { checkRank } : {}),
    };
  };
  return {
    request(line, { truncated } = {}) {
      if (truncated) return;
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const tool = message?.params?.name;
      if (message?.method !== 'tools/call' || message.id == null) return;
      const safeTool = TOOLS.has(tool) ? tool : 'other';
      const call = {
        persona: safePersona, tool: safeTool, callOrdinal: ++callOrdinal,
        ...(safeTool === 'browser_navigate' ? navigation(message.params.arguments) : {}),
        startedAt: now(),
      };
      active.set(JSON.stringify(message.id), call);
      const { startedAt: _privateTime, ...event } = call;
      emit({ kind: 'browser_call_start', ...event });
    },
    response(line, { bytes = 0, truncated = false, tail = '' } = {}) {
      let message = null;
      if (!truncated) { try { message = JSON.parse(line); } catch {} }
      const id = responseId(line, message, tail);
      if (id == null) return;
      const key = JSON.stringify(id);
      const call = active.get(key);
      if (!call) return;
      active.delete(key);
      const { startedAt, ...event } = call;
      const shape = resultShape(message, bytes, truncated);
      emit({ kind: 'browser_call_end', ...event,
        durationMs: Math.max(0, Math.round(now() - startedAt)),
        ...shape,
      });
      try {
        const text = message
          ? (Array.isArray(message.result?.content) ? message.result.content : [])
            .filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
          : line;
        if (message) notePage(reportedPageUrl(text));
        const succeeded = shape.outcome === 'ok' || (!message && truncated);
        if (call.tool === 'browser_take_screenshot' && succeeded) {
          const file = savedScreenshotPath(text);
          if (insideOutput(file)) provenance.stampScreenshot(outputDir, path.resolve(file), pageUrl);
        }
        if (call.tool === 'browser_close' && shape.outcome === 'ok') {
          // The session's clip is written as it closes: these are its pages.
          // A close with no page since the last one (a second close) ended no
          // session, and leaves the last record as it was.
          if (outputDir && sessionOrigins.size) provenance.recordSession(outputDir, sessionOrigins);
          sessionOrigins.clear();
          pageUrl = null;
        }
      } catch { /* Provenance that cannot be written is provenance that is missing: the bridge refuses the shot. */ }
    },
    pending() {
      for (const call of active.values()) {
        const { startedAt, ...event } = call;
        emit({ kind: 'browser_call_pending', ...event,
          durationMs: Math.max(0, Math.round(now() - startedAt)) });
      }
    },
    exit(code, signal) {
      for (const call of active.values()) {
        const { startedAt, ...event } = call;
        emit({ kind: 'browser_call_end', ...event, outcome: 'server_exit',
          durationMs: Math.max(0, Math.round(now() - startedAt)) });
      }
      active.clear();
      emit({ kind: 'browser_server_exit', persona: safePersona,
        outcome: code === 0 ? 'ok' : 'error',
        ...(Number.isInteger(code) ? { exitCode: code } : {}),
        ...(signal === 'SIGTERM' || signal === 'SIGINT' ? { signal } : {}),
      });
    },
  };
}

// A button the pointer was left on is shot in its hover colour: the agent
// clicks "Send code", the page moves on, and the next screenshot shows the
// button pale. Before each browser_take_screenshot that follows a click, the
// observer moves the pointer off the page itself and holds the screenshot
// (and every call after it, in order) until that move is answered; the
// move's answer never reaches the agent. (-1, -1) is outside the viewport,
// so nothing is under the pointer, and it stays so when an element
// screenshot scrolls the page; (0, 0) is a pixel of the page and hovers
// whatever is drawn there. A pointer the agent placed itself (browser_hover,
// browser_mouse_move_xy) is left where it is: the hover may be the very
// change being shown. When clips are recorded, the pointer is parked before
// browser_close too, so a clip's last frames are not hovered either.
const PARK_TIMEOUT_MS = 12_000;
const PARK_TOMBSTONE_MS = 60_000;
const PARK_TOMBSTONE_MAX = 32;
const PARK_HELD_LINE_MAX_BYTES = 64 * 1024 * 1024;
const POINTER_LEFT_ON_PAGE = new Set([
  'browser_click', 'browser_drag', 'browser_mouse_click_xy', 'browser_mouse_drag_xy',
]);
const POINTER_PLACED = new Set(['browser_hover', 'browser_mouse_move_xy', 'browser_close']);
const STRING_ID = /"id"\s*:\s*"([^"\\]{1,120})"/g;

function parkRequest(id) {
  return Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: {
    name: 'browser_mouse_move_xy',
    arguments: { element: 'Pointer off the page before a screenshot', x: -1, y: -1 },
  } })}\n`);
}

// Splits a byte stream into complete newline-terminated lines without
// decoding it: a character split across two chunks stays whole.
function lineSplitter() {
  let parts = [];
  return {
    push(chunk, onLine) {
      let offset = 0;
      for (;;) {
        const end = chunk.indexOf(10, offset);
        if (end < 0) { if (offset < chunk.length) parts.push(chunk.subarray(offset)); return; }
        parts.push(chunk.subarray(offset, end + 1));
        const line = Buffer.concat(parts);
        parts = [];
        onLine(line);
        offset = end + 1;
      }
    },
    rest() { const line = Buffer.concat(parts); parts = []; return line; },
  };
}

function createPointerParker({
  timeoutMs = PARK_TIMEOUT_MS, parkBeforeClose = false, emit = () => {}, persona = 'member',
  now = () => performance.now(), nonce = crypto.randomBytes(6).toString('hex'),
} = {}) {
  let leftOnPage = false;
  let parks = 0;
  let waiting = null; // { id, startedAt, timer }
  const tombstones = new Map(); // id -> expiry timer: late answers still dropped
  let flushed = null;
  let closed = false;
  const queue = []; // { line: Buffer, tool, parked }
  const input = new Transform({
    transform(chunk, _encoding, callback) {
      inSplit.push(chunk, enqueue);
      drain();
      callback();
    },
    flush(callback) {
      const rest = inSplit.rest();
      if (rest.length) enqueue(rest);
      flushed = callback;
      drain();
    },
  });
  const inSplit = lineSplitter();
  const enqueue = (line) => {
    let tool = null;
    try {
      const message = JSON.parse(line.toString('utf8'));
      if (message?.method === 'tools/call') tool = message.params?.name || null;
    } catch { /* forwarded unchanged */ }
    queue.push({ line, tool, parked: false });
  };
  const bury = (id) => {
    if (tombstones.size >= PARK_TOMBSTONE_MAX) {
      const [oldest, timer] = tombstones.entries().next().value;
      clearTimeout(timer);
      tombstones.delete(oldest);
    }
    const timer = setTimeout(() => tombstones.delete(id), PARK_TOMBSTONE_MS);
    timer.unref?.();
    tombstones.set(id, timer);
  };
  const settle = (id, outcome) => {
    if (!waiting || waiting.id !== id) return;
    clearTimeout(waiting.timer);
    const durationMs = Math.max(0, Math.round(now() - waiting.startedAt));
    waiting = null;
    // A move that failed leaves the pointer where it was: the next
    // screenshot tries again. The held screenshot goes ahead either way.
    if (outcome !== 'ok') leftOnPage = true;
    emit({ kind: 'browser_pointer_park', persona, outcome, durationMs });
    drain();
  };
  const drain = () => {
    if (closed) return;
    while (!waiting && queue.length) {
      const item = queue[0];
      const parksHere = item.tool === 'browser_take_screenshot'
        || (parkBeforeClose && item.tool === 'browser_close');
      if (parksHere && leftOnPage && !item.parked) {
        item.parked = true;
        leftOnPage = false;
        const id = `usernode-shots-park-${nonce}-${++parks}`;
        const timer = setTimeout(() => { bury(id); settle(id, 'timeout'); }, timeoutMs);
        timer.unref?.();
        waiting = { id, startedAt: now(), timer };
        input.push(parkRequest(id));
        continue;
      }
      queue.shift();
      if (POINTER_LEFT_ON_PAGE.has(item.tool)) leftOnPage = true;
      else if (POINTER_PLACED.has(item.tool)) leftOnPage = false;
      input.push(item.line);
    }
    if (!waiting && !queue.length && flushed) { const done = flushed; flushed = null; done(); }
  };
  const ours = (id) => (waiting && waiting.id === id) || tombstones.has(id);
  // Which of the parker's moves a whole answer line belongs to, if any. The
  // SDK writes the id after the result, so both ends are read.
  const parkIdOf = (line) => {
    const ends = line.length > 16384
      ? `${line.subarray(0, 8192).toString('utf8')}\n${line.subarray(-8192).toString('utf8')}`
      : line.toString('utf8');
    for (const match of ends.matchAll(STRING_ID)) if (ours(match[1])) return match[1];
    return null;
  };
  // While a move is outstanding (or answered late), every answer line is
  // held whole until its id is known; otherwise lines stream through.
  let held = [];
  let heldBytes = 0;
  let passing = false;
  const output = new Transform({
    transform(chunk, _encoding, callback) {
      let offset = 0;
      while (offset < chunk.length) {
        const end = chunk.indexOf(10, offset);
        const part = chunk.subarray(offset, end < 0 ? chunk.length : end + 1);
        offset += part.length;
        if (!passing && !held.length && !waiting && !tombstones.size) passing = true;
        if (passing) {
          this.push(part);
          if (end >= 0) passing = false;
          continue;
        }
        held.push(part);
        heldBytes += part.length;
        if (end < 0) {
          if (heldBytes > PARK_HELD_LINE_MAX_BYTES) {
            this.push(Buffer.concat(held)); held = []; heldBytes = 0; passing = true;
          }
          continue;
        }
        const line = Buffer.concat(held);
        held = []; heldBytes = 0;
        const id = parkIdOf(line);
        if (!id) { this.push(line); continue; }
        let message = null;
        try { message = JSON.parse(line.toString('utf8')); } catch { /* unparsed */ }
        const outcome = !message ? 'unparsed' : message.error ? 'rpc_error'
          : message.result?.isError === true ? 'tool_error' : 'ok';
        if (tombstones.has(id)) { clearTimeout(tombstones.get(id)); tombstones.delete(id); }
        settle(id, outcome);
      }
      callback();
    },
    flush(callback) {
      if (held.length) this.push(Buffer.concat(held));
      callback();
    },
  });
  return {
    input, output,
    // The browser is gone: stop waiting, and send nothing more.
    close() {
      closed = true;
      if (waiting) clearTimeout(waiting.timer);
      waiting = null;
      queue.length = 0;
      for (const timer of tombstones.values()) clearTimeout(timer);
      tombstones.clear();
    },
  };
}

// The Playwright MCP command. The worker image's own install unless the
// local dry run names another (scripts/shots-dry-run.js), as a JSON array.
function browserCommand(value = process.env.SHOTS_BROWSER_MCP_COMMAND) {
  try {
    const parsed = JSON.parse(value || 'null');
    if (Array.isArray(parsed) && parsed.length && parsed.every((part) => typeof part === 'string' && part)) {
      return parsed;
    }
  } catch { /* fall through to the installed server */ }
  return ['mcp-server-playwright'];
}

function start({ persona, args, binary = null,
  stdin = process.stdin, stdout = process.stdout, stderr = process.stderr,
  diagnosticFile = process.env.SHOTS_BROWSER_DIAGNOSTIC_FILE,
  origins = JSON.parse(process.env.SHOTS_ALLOWED_ORIGINS || '[]'),
  hints = JSON.parse(process.env.SHOTS_NAVIGATION_HINTS || '{}'),
} = {}) {
  const emit = (event) => {
    if (!diagnosticFile) return;
    try { fs.appendFileSync(diagnosticFile, `${MARKER}${JSON.stringify(event)}\n`); }
    catch { /* Diagnostics must never prevent shots navigation. */ }
  };
  const list = args || [];
  const outputAt = list.indexOf('--output-dir');
  const outputDir = outputAt >= 0 ? list[outputAt + 1] || null : null;
  const observer = createObserver({ persona, origins, hints, emit, outputDir });
  const [command, ...prefix] = binary ? [binary] : browserCommand();
  const child = spawn(command, [...prefix, ...list], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => { /* Child exit is reported by the close handler. */ });
  const inputTap = lineTap((line, meta) => observer.request(line, meta));
  const parker = createPointerParker({
    emit, persona: ['admin', 'full_admin', 'guest'].includes(persona) ? persona : 'member',
    parkBeforeClose: list.some((arg) => /^--save-video(=|$)/.test(arg)),
  });
  stdin.pipe(inputTap).pipe(parker.input).pipe(child.stdin);
  child.stdout.pipe(parker.output)
    .pipe(lineTap((line, meta) => observer.response(line, meta))).pipe(stdout);
  child.stderr.pipe(stderr);
  const pending = setInterval(() => observer.pending(), PENDING_INTERVAL_MS);
  pending.unref?.();
  const signalHandlers = new Map();
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const handler = () => child.kill(signal);
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
  child.on('error', () => { /* close also follows a spawn error. */ });
  child.on('close', (code, signal) => {
    clearInterval(pending);
    for (const [name, handler] of signalHandlers) process.off(name, handler);
    // MCP clients may keep our stdin pipe open after stopping Playwright.
    // Release that handle so the observer exits with its child.
    stdin.unpipe(inputTap);
    inputTap.destroy();
    parker.close();
    stdin.pause();
    observer.exit(code, signal);
    process.exitCode = Number.isInteger(code) ? code : 1;
  });
  return child;
}

if (require.main === module) {
  const persona = process.argv[2];
  if (!['member', 'admin', 'full_admin', 'guest'].includes(persona)) process.exit(2);
  start({ persona, args: process.argv.slice(3) });
}

module.exports = {
  MARKER, lineTap, createObserver, createPointerParker, start, reportedPageUrl, savedScreenshotPath, browserCommand,
};
