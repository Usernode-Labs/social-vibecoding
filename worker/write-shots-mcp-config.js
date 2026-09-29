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
// A child-app pair may also load the legacy Tailwind CDN script, the one
// third-party host the shots proxy admits (and only for such a pair).
const origins = [
  ...browserAllowedOrigins(baseOrigin, headOrigin, hostedFile),
  ...(process.env.SHOTS_PLATFORM_ASSETS === '1' ? ['https://cdn.tailwindcss.com'] : []),
];
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
for (const persona of ['member', 'admin', 'full_admin']) {
  fs.mkdirSync(path.join(shotsDir, persona), { recursive: true, mode: 0o700 });
}
const browserArgs = (persona) => {
  const observed = persona === 'read_only_admin' ? 'admin' : persona;
  return [
    '/usr/local/bin/shots-browser-observer.js',
    observed,
    '--browser', 'chromium', '--headless', '--isolated', '--no-sandbox', '--caps', 'vision',
    '--storage-state', path.join(stateDir, `${persona}.json`),
    '--allowed-origins', origins.join(';'),
    '--block-service-workers', '--image-responses', 'allow',
    '--proxy-server', proxy,
    '--timeout-action', '10000', '--timeout-navigation', '30000',
    '--output-dir', path.join(shotsDir, observed),
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
  },
};
fs.writeFileSync(output, `${JSON.stringify(config)}\n`, { mode: 0o600 });
