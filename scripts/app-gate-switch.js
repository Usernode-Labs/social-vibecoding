#!/usr/bin/env node
'use strict';

// Incident switch for the Kubernetes app-host gate (scripts/app-gate.js).
//
//   node scripts/app-gate-switch.js off   # every app Ingress straight to its own Service
//   node scripts/app-gate-switch.js on    # bring the gate up, then route through it
//
// Run it inside a platform pod, which has the cluster credentials:
//
//   kubectl -n social-platform exec deploy/social-vibecoding -- node scripts/app-gate-switch.js off
//
// It applies the mode at once, whatever APP_GATE says. The platform
// reconciles to APP_GATE again on its next boot and on every app deploy, so
// set APP_GATE (helm `config.appGate`) to the same value afterwards, or the
// next deploy undoes the switch.

require('dotenv').config({ quiet: true });
const { load } = require('../src/config');
const kubernetes = require('../src/services/kubernetes');

async function main() {
  const mode = String(process.argv[2] || '').toLowerCase();
  if (!['on', 'off'].includes(mode)) {
    console.error('Usage: node scripts/app-gate-switch.js on|off');
    process.exit(2);
  }
  const config = load();
  if (config.appRuntime !== 'kubernetes') throw new Error('APP_RUNTIME must be kubernetes');
  const result = await kubernetes.reconcileAppGateIngresses(config, { force: mode });
  console.log(JSON.stringify(result));
  if (mode === 'on' && result.skipped) process.exit(1);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
