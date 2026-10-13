'use strict';

// How much memory the shots worker is using, sampled through a shots turn.
//
// A shots agent that dies mid-run leaves no exit marker, and the platform can
// tell only that its process is gone. Several Chromium browsers (one per
// persona the agent uses, and a phone browser beside it for a persona with a
// phone screen) and the agent share the worker's memory limit, so the turn
// reports, every few seconds: the container's use, limit and lifetime peak,
// its out-of-memory kill count, and how the resident memory splits between
// the browsers, the agent, the browser tool servers, the shots proxy and
// everything else. The last sample before a death says whether memory ran
// out, and the kill count rising during the turn says the kernel killed
// something for it.
//
// Numbers and fixed class names only: never a command line, a path or a page.
// The shots proxy runs for the whole turn and carries this sampler rather
// than a process of its own, which would add to the memory it measures.

const fs = require('node:fs');
const path = require('node:path');

const MB = 1024 * 1024;

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function bytes(text) {
  const value = String(text ?? '').trim();
  if (!/^\d{1,20}$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

const toMb = (value) => (value == null ? null : Math.round(value / MB));

// `name value` lines (memory.events, memory.oom_control).
function field(text, name) {
  const match = new RegExp(`^${name} (\\d+)$`, 'm').exec(String(text || ''));
  return match ? Number(match[1]) : null;
}

/**
 * The container's memory, from cgroup v2 (memory.current, memory.max,
 * memory.peak, memory.events) or cgroup v1 (memory/memory.usage_in_bytes,
 * limit, max usage, oom_control). A value the kernel does not offer is null;
 * an unlimited limit is null.
 */
function readCgroup(root = '/sys/fs/cgroup') {
  const current = bytes(readText(path.join(root, 'memory.current')));
  if (current != null) {
    const limitText = readText(path.join(root, 'memory.max'));
    return {
      usedMb: toMb(current),
      limitMb: String(limitText || '').trim() === 'max' ? null : toMb(bytes(limitText)),
      peakMb: toMb(bytes(readText(path.join(root, 'memory.peak')))),
      oomKills: field(readText(path.join(root, 'memory.events')), 'oom_kill'),
    };
  }
  const v1 = path.join(root, 'memory');
  const used = bytes(readText(path.join(v1, 'memory.usage_in_bytes')));
  if (used == null) return { usedMb: null, limitMb: null, peakMb: null, oomKills: null };
  const limit = bytes(readText(path.join(v1, 'memory.limit_in_bytes')));
  return {
    usedMb: toMb(used),
    // cgroup v1 writes "unlimited" as a page-rounded maximum.
    limitMb: limit == null || limit >= 2 ** 60 ? null : toMb(limit),
    peakMb: toMb(bytes(readText(path.join(v1, 'memory.max_usage_in_bytes')))),
    oomKills: field(readText(path.join(v1, 'memory.oom_control')), 'oom_kill'),
  };
}

// Which part of the shots turn a process is, from its command line.
function processClass(cmdline) {
  const text = String(cmdline || '');
  if (/(?:^|\/)(?:chrome|chromium|headless_shell)(?:\s|$)|chrome-linux|chromium-\d+|--type=(?:renderer|gpu-process|utility|zygote)/.test(text)) {
    return 'browser';
  }
  if (/shots-origin-proxy\.js/.test(text)) return 'proxy';
  if (/mcp-server-playwright|@playwright\/mcp|shots-browser-observer\.js|shots-mcp\.js|visible-changes-mcp\.js/.test(text)) {
    return 'mcp';
  }
  if (/(?:^|[\s/])claude(?:\s|$)|@anthropic-ai\/claude-code/.test(text)) return 'agent';
  return 'other';
}

/** Resident memory by class, in MB, and how many browser processes there are. */
function processMemory(procRoot = '/proc') {
  const rssMb = { browser: 0, agent: 0, mcp: 0, proxy: 0, other: 0 };
  let browserProcesses = 0;
  let entries = [];
  try { entries = fs.readdirSync(procRoot); } catch { return { rssMb: null, browserProcesses: null }; }
  const kb = { browser: 0, agent: 0, mcp: 0, proxy: 0, other: 0 };
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const status = readText(path.join(procRoot, entry, 'status'));
    const rss = /^VmRSS:\s+(\d+) kB$/m.exec(String(status || ''));
    if (!rss) continue;
    const cmdline = String(readText(path.join(procRoot, entry, 'cmdline')) || '').replace(/\0/g, ' ');
    const kind = processClass(cmdline);
    kb[kind] += Number(rss[1]);
    if (kind === 'browser') browserProcesses += 1;
  }
  for (const kind of Object.keys(kb)) rssMb[kind] = Math.round(kb[kind] / 1024);
  return { rssMb, browserProcesses };
}

function sample({ cgroupRoot, procRoot } = {}) {
  return { kind: 'worker_memory', ...readCgroup(cgroupRoot), ...processMemory(procRoot) };
}

/**
 * Emit a sample now and every `intervalMs` until stopped. A sample that
 * cannot be taken is skipped: memory reporting must never affect the turn.
 */
function startSampler(emit, { intervalMs = 5000, cgroupRoot, procRoot } = {}) {
  const tick = () => {
    try { emit(sample({ cgroupRoot, procRoot })); } catch { /* skip this sample */ }
  };
  tick();
  const timer = setInterval(tick, Math.max(1000, Number(intervalMs) || 5000));
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { readCgroup, processClass, processMemory, sample, startSampler };
