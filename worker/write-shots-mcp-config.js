#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { browserAllowedOrigins } = require('./shots-hosted-origins');

const output = process.argv[2];
const stateDir = process.env.SHOTS_BROWSER_STATE_DIR;
const proxy = process.env.SHOTS_PROXY_SERVER;
const hostedFile = process.env.SHOTS_HOSTED_ORIGINS_FILE;
if (!output || !stateDir || !proxy || !hostedFile) {
  throw new Error('Shots MCP config inputs are incomplete.');
}
const baseOrigin = new URL(process.env.SHOTS_BASE_ORIGIN).origin;
const headOrigin = new URL(process.env.SHOTS_HEAD_ORIGIN).origin;
// The browsers carry no origin allowlist of their own: they may load the
// public internet (a CDN script, map tiles), and the shots proxy is the
// boundary that keeps them off every non-public address (shots-boundary.js).
// The pair and the hosted-app catalog are still checked here, so a run whose
// catalog does not match its pair fails before any browser starts.
browserAllowedOrigins(baseOrigin, headOrigin, hostedFile);
// Each persona's browser saves the shots agent's named screenshots, and
// its clips when a browser session closes, into its own directory, where the
// shots bridge (and nothing else) reads them back. Video is recorded only
// when a declared change is motion a still cannot show.
const shotsDir = process.env.SHOTS_DIR;
if (!shotsDir) throw new Error('Shots MCP config inputs are incomplete.');
const recordClips = process.env.SHOTS_RECORD_CLIPS === '1';
// Clips are recorded at the motion screens' own size (a phone clip at a
// desktop size is mostly grey); 1280x800 when the platform names none.
const clipSize = /^[1-9][0-9]{2,3}x[1-9][0-9]{2,3}$/.test(process.env.SHOTS_CLIP_SIZE || '')
  ? process.env.SHOTS_CLIP_SIZE : '1280x800';
// Personas beyond the four base browsers, only those a declared change
// names (SHOTS_PERSONAS, a JSON array). Each gets its own browser; without
// the env (the image-build verifiers) the config stays exactly the four
// base browsers. These browsers pose as the phone their persona is on.
let extraPersonas = [];
try { extraPersonas = JSON.parse(process.env.SHOTS_PERSONAS || '[]'); } catch { extraPersonas = []; }
if (!Array.isArray(extraPersonas)) extraPersonas = [];
const EXTRA_BROWSERS = Object.freeze({
  invited_member: { persona: 'invited_member', tool: 'browser_invited' },
  invited_member_listed: { persona: 'invited_member_listed', tool: 'browser_invited_listed' },
});
const PHONE_DEVICE = 'Pixel 7';
const extraBrowserSpecs = extraPersonas
  .map((persona) => EXTRA_BROWSERS[persona])
  .filter(Boolean);
for (const persona of ['member', 'admin', 'full_admin', 'guest', ...extraBrowserSpecs.map((spec) => spec.persona)]) {
  fs.mkdirSync(path.join(shotsDir, persona), { recursive: true, mode: 0o700 });
}
// Each persona's browser reaches its own proxy listener, which is how the
// proxy knows whose identity a hosted app's page load should carry. Without
// the ports (the image-build verifiers) every browser shares one listener
// and nothing is attached, as before.
let personaPorts = {};
try { personaPorts = JSON.parse(process.env.SHOTS_PROXY_PERSONA_PORTS || '{}') || {}; } catch { personaPorts = {}; }
const proxyFor = (persona) => {
  const personaPort = personaPorts[persona];
  if (!Number.isSafeInteger(personaPort) || personaPort <= 0 || personaPort > 65535) return proxy;
  const shared = new URL(proxy);
  return `${shared.protocol}//${shared.hostname}:${personaPort}`;
};
const browserArgs = (persona, { device = null } = {}) => {
  const observed = persona === 'read_only_admin' ? 'admin' : persona;
  return [
    '/usr/local/bin/shots-browser-observer.js',
    observed,
    '--browser', 'chromium', '--headless', '--isolated', '--no-sandbox', '--caps', 'vision',
    '--storage-state', path.join(stateDir, `${persona}.json`),
    '--block-service-workers', '--image-responses', 'allow',
    '--proxy-server', proxyFor(persona),
    // Chromium sends loopback addresses past a proxy unless told not to.
    // Playwright adds this rule by default; naming it here keeps the worker's
    // own loopback services behind the proxy's refusal if that default goes.
    '--proxy-bypass', '<-loopback>',
    '--timeout-action', '10000', '--timeout-navigation', '30000',
    '--output-dir', path.join(shotsDir, observed),
    ...(device ? ['--device', device] : []),
    ...(recordClips ? [`--save-video=${clipSize}`] : []),
  ];
};
const browserEnv = {
  SHOTS_ALLOWED_ORIGINS: JSON.stringify([baseOrigin, headOrigin]),
  SHOTS_BROWSER_DIAGNOSTIC_FILE: process.env.SHOTS_BROWSER_DIAGNOSTIC_FILE || '',
  SHOTS_NAVIGATION_HINTS: process.env.SHOTS_NAVIGATION_HINTS || '{}',
};
const config = {
  mcpServers: {
    shots: { command: 'node', args: ['/usr/local/bin/shots-mcp.js'] },
    browser_member: { command: 'node', args: browserArgs('member'), env: browserEnv },
    browser_admin: { command: 'node', args: browserArgs('read_only_admin'), env: browserEnv },
    browser_full_admin: { command: 'node', args: browserArgs('full_admin'), env: browserEnv },
    // Not signed in: its storage state is empty (shots-browser-bootstrap.js).
    browser_guest: { command: 'node', args: browserArgs('guest'), env: browserEnv },
    ...Object.fromEntries(extraBrowserSpecs.map((spec) => [
      spec.tool, { command: 'node', args: browserArgs(spec.persona, { device: PHONE_DEVICE }), env: browserEnv },
    ])),
  },
};
fs.writeFileSync(output, `${JSON.stringify(config)}\n`, { mode: 0o600 });
