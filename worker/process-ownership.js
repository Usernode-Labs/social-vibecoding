'use strict';

// Fail closed when process metadata is unavailable. A PID alone is never
// ownership: compare the user, start time and command again before EACH
// signal, including escalation. ps/lsof are the macOS equivalent of /proc.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const options = { encoding: 'utf8', timeout: 1500, maxBuffer: 4 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } };
const validPid = (pid) => Number.isInteger(pid) && pid > 1;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function parsePs(text) {
  return String(text || '').split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d{4})\s+(\S+)\s+(.+)$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), pgid: Number(m[4]),
      start: m[5].replace(/\s+/g, ' '), state: m[6], cmd: m[7] }] : [];
  });
}

function readProcess(pid, { platform = process.platform, fsImpl = fs, procRoot = '/proc', exec = execFileSync } = {}) {
  if (!validPid(pid)) return null;
  try {
    if (platform === 'darwin') {
      return parsePs(exec('/bin/ps', ['-p', String(pid), '-o', 'pid=,ppid=,uid=,pgid=,lstart=,stat=,command='], options))[0] || null;
    }
    if (platform !== 'linux') return null;
    const stat = fsImpl.readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
    const cols = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (!/^\d+$/.test(cols[19] || '')) return null;
    return { pid, ppid: Number(cols[1]), uid: fsImpl.statSync(`${procRoot}/${pid}`).uid,
      pgid: Number(cols[2]), start: cols[19], state: cols[0],
      cmd: fsImpl.readFileSync(`${procRoot}/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim() };
  } catch { return null; }
}

function sameProcess(expected, actual) {
  return !!expected && !!actual && validPid(expected.pid) && expected.pid === actual.pid
    && Number.isInteger(expected.uid) && expected.uid === actual.uid
    && typeof expected.start === 'string' && expected.start !== '' && expected.start === actual.start
    && typeof expected.cmd === 'string' && expected.cmd !== '' && expected.cmd === actual.cmd
    && !/^[ZX]/.test(actual.state || '');
}

function processTable(opts = {}) {
  const { platform = process.platform, fsImpl = fs, procRoot = '/proc', exec = execFileSync } = opts;
  try {
    if (platform === 'darwin') return parsePs(exec('/bin/ps', ['-axo', 'pid=,ppid=,uid=,pgid=,lstart=,stat=,command='], options));
    if (platform !== 'linux') return [];
    return fsImpl.readdirSync(procRoot).filter((n) => /^\d+$/.test(n))
      .map((n) => readProcess(Number(n), opts)).filter(Boolean);
  } catch { return []; }
}

function processTree(root, opts = {}) {
  const table = processTable(opts);
  const pids = new Set([root.pid]);
  for (let more = true; more;) {
    more = false;
    for (const p of table) if (!pids.has(p.pid) && pids.has(p.ppid) && p.uid === root.uid) {
      pids.add(p.pid); more = true;
    }
  }
  // The root must still be the one we captured; never follow a reused PID.
  if (!sameProcess(root, readProcess(root.pid, opts))) return [];
  return table.filter((p) => pids.has(p.pid) && p.uid === root.uid);
}

// A persistent supervisor owns each dedicated app group. Require that live
// original identity both before and after enumeration: an orphan PGID alone
// can be reused and is never authority to adopt its current members.
function processGroup(root, opts = {}) {
  if (!root || root.pgid !== root.pid) return [];
  const liveRoot = () => {
    const current = readProcess(root.pid, opts);
    return sameProcess(root, current) && current.pgid === root.pgid;
  };
  if (!liveRoot()) return [];
  const table = processTable(opts);
  if (!liveRoot()) return [];
  return table.filter((p) => p.pgid === root.pid && p.uid === root.uid);
}

function listeningInodes(texts) {
  const out = new Set();
  for (const text of texts) for (const line of String(text || '').split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length > 9 && cols[3] === '0A' && /^\d+$/.test(cols[9]) && cols[9] !== '0') out.add(cols[9]);
  }
  return out;
}

function listeningProcesses(opts = {}) {
  const { platform = process.platform, fsImpl = fs, procRoot = '/proc', exec = execFileSync, selfPid = process.pid } = opts;
  const read = (f) => { try { return fsImpl.readFileSync(f, 'utf8'); } catch { return null; } };
  const link = (f) => { try { return fsImpl.readlinkSync(f); } catch { return null; } };
  const table = processTable(opts);
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const spare = new Set();
  for (let pid = selfPid, hops = 0; pid > 0 && hops < 64; hops += 1) {
    spare.add(pid); pid = byPid.get(pid)?.ppid || 0;
  }
  const ownUid = typeof process.getuid === 'function' ? process.getuid() : null;
  let listening = new Set();
  const procs = [];
  if (platform === 'darwin') {
    let text;
    try { text = exec('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'p'], options); }
    catch (err) { text = err.stdout || ''; }
    const pids = new Set(String(text).split('\n').filter((s) => /^p\d+$/.test(s)).map((s) => Number(s.slice(1))));
    const candidates = table.filter((p) => pids.has(p.pid) && p.uid === ownUid && !spare.has(p.pid));
    if (candidates.length) {
      let cwdText;
      try { cwdText = exec('/usr/sbin/lsof', ['-a', '-p', candidates.map((p) => p.pid).join(','), '-d', 'cwd', '-F', 'pn'], options); }
      catch (err) { cwdText = err.stdout || ''; }
      const cwds = new Map();
      let pid;
      for (const line of String(cwdText).split('\n')) {
        if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
        else if (line.startsWith('n') && pid) cwds.set(pid, line.slice(1));
      }
      for (const p of candidates) {
        const socket = `pid:${p.pid}`;
        listening.add(socket); procs.push({ ...p, cwd: cwds.get(p.pid) || null, sockets: [socket] });
      }
    }
  } else if (platform === 'linux') {
    listening = listeningInodes([read(`${procRoot}/net/tcp`), read(`${procRoot}/net/tcp6`)]);
    for (const p of table) {
      if (p.uid !== ownUid || spare.has(p.pid)) continue;
      let fds;
      try { fds = fsImpl.readdirSync(`${procRoot}/${p.pid}/fd`); } catch { continue; }
      const sockets = fds.flatMap((fd) => {
        const m = /^socket:\[(\d+)\]$/.exec(link(`${procRoot}/${p.pid}/fd/${fd}`) || '');
        return m ? [m[1]] : [];
      });
      if (sockets.length) procs.push({ ...p, cwd: link(`${procRoot}/${p.pid}/cwd`), sockets });
    }
  }
  return { spare, listening, procs };
}

function signalOwned(record, signal, { read = readProcess, kill = process.kill.bind(process) } = {}) {
  if (record.uid !== process.getuid() || !sameProcess(record, read(record.pid))) return false;
  try { kill(record.pid, signal); return true; } catch { return false; }
}

function stopOwnedSync(records, { waitMs = 2000, read = readProcess, kill = process.kill.bind(process), pause = sleep } = {}) {
  const opts = { read, kill };
  const sent = records.filter((r) => signalOwned(r, 'SIGTERM', opts));
  const deadline = Date.now() + Math.min(Math.max(waitMs, 0), 5000);
  while (Date.now() < deadline && sent.some((r) => sameProcess(r, read(r.pid)))) {
    pause(Math.max(0, Math.min(100, deadline - Date.now())));
  }
  for (const r of sent) signalOwned(r, 'SIGKILL', opts);
  return sent.length;
}

async function stopOwned(records, { waitMs = 2000, read = readProcess, kill = process.kill.bind(process) } = {}) {
  const opts = { read, kill };
  const sent = records.filter((r) => signalOwned(r, 'SIGTERM', opts));
  const deadline = Date.now() + Math.min(Math.max(waitMs, 0), 5000);
  while (Date.now() < deadline && sent.some((r) => sameProcess(r, read(r.pid)))) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(100, deadline - Date.now()))));
  }
  for (const r of sent) signalOwned(r, 'SIGKILL', opts);
  // Let the kernel close descriptors and the parent reap its children.
  const killedDeadline = Date.now() + 500;
  while (Date.now() < killedDeadline && sent.some((r) => sameProcess(r, read(r.pid)))) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return sent.length;
}

module.exports = { parsePs, readProcess, sameProcess, processTable, processTree, processGroup, listeningInodes, listeningProcesses,
  signalOwned, stopOwnedSync, stopOwned };
