'use strict';

// Keep the dedicated process-group leader alive while npm/shell wrappers
// exit. The launcher's IPC channel is not inherited by app descendants.
// On launcher death, this still-live owner cleans its own group. Never adopt
// an orphan group from a PID saved by an earlier launch.
const { spawn } = require('node:child_process');
const { readProcess, processGroup, stopOwned } = require('./process-ownership');

if (typeof process.send !== 'function' || !process.connected || !process.argv[2]) process.exit(2);
const identity = readProcess(process.pid);
let app;
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const members = processGroup(identity).filter((p) => p.pid !== process.pid);
  // The direct child handle remains safe even when inspection is unavailable.
  try { app?.kill('SIGTERM'); } catch { /* failed spawn or already exited */ }
  await stopOwned(members, { waitMs: 3000 });
  try { app?.kill('SIGKILL'); } catch { /* already exited */ }
  process.exit();
}
function notify(message) {
  if (!process.connected) { void shutdown(); return; }
  try { process.send(message, (err) => { if (err) void shutdown(); }); }
  catch { void shutdown(); }
}
process.on('disconnect', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
notify({ type: 'ready' });
app = spawn(process.argv[2], process.argv.slice(3), { stdio: 'inherit' });
app.once('error', (err) => {
  notify({ type: 'app-error', message: err.message });
  setTimeout(() => { void shutdown(); }, 6000).unref();
});
app.once('exit', (code, signal) => {
  notify({ type: 'app-exit', code: code == null ? (signal ? 128 : 2) : code });
  // Stay alive as an ownership witness until the launcher has stopped every
  // member. Bound recovery if the launcher cannot process the notification.
  setTimeout(() => { void shutdown(); }, 6000).unref();
});
