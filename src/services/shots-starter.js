'use strict';

// A project's first version, on before & after shots.
//
// A new app's repository starts as Homeroom's starter template
// (services/template.js): one placeholder screen, a "Starter template" hero
// wrapped in the usernode-starter-notice@1 sentinel comments, which the
// app's first real version deletes (src/prompts/app-conventions.md,
// "Starter-template notice"). A proposal that builds those first screens is
// compared with that placeholder, so every "before" shot of it was the
// placeholder, and the shots agent spent half its time taking it. From
// 2026-10-09 to 10-12 at least six changes carried a note saying so
// (find-a-playmate PR 3, smart-cashier PR 2 and mountain-trail PR 4, the
// proposals 7608, 7871 and 7610, among them).
//
// So when the before revision still carries the sentinel and the after
// revision no longer does, the run takes and publishes the after side only
// (shots-orchestrator.executeRun): the brief tells the agent so, the run
// control refuses a before shot, and the card says "New app: nothing
// before". The sentinel is read from each side's own checkout, never from
// what a page shows. A ready-made or game starter (services/app-templates.js)
// is a working app with no sentinel, so its first version keeps a real
// before, and so does a change that leaves the placeholder in place (a new
// name on the starter screen is a real before and after).

const fs = require('node:fs/promises');
const path = require('node:path');

const STARTER_PAGE = path.join('public', 'index.html');
// The opening sentinel, as the template writes it. The closing one starts
// with a slash, so it never matches on its own.
const STARTER_MARKER = /<!--\s*usernode-starter-notice@1\b/;
// The starter's page is a few kilobytes; a page this large is not it.
const MAX_PAGE_BYTES = 512 * 1024;

// Whether one side's checkout still ships the starter's placeholder screen.
// Only a regular file is read: a symlink in the repository under test never
// takes the platform anywhere else. Any failure reads as no.
async function carriesStarter(checkoutDir) {
  if (typeof checkoutDir !== 'string' || !checkoutDir) return false;
  try {
    const file = path.join(checkoutDir, STARTER_PAGE);
    const info = await fs.lstat(file);
    if (!info.isFile() || info.size > MAX_PAGE_BYTES) return false;
    return STARTER_MARKER.test(await fs.readFile(file, 'utf8'));
  } catch {
    return false;
  }
}

// Whether this pair's before side is the starter's placeholder that its
// after side replaces: the before checkout carries the sentinel and the
// after checkout no longer does.
async function beforeIsStarter(pair) {
  const base = pair?.sides?.base?.checkout;
  const head = pair?.sides?.head?.checkout;
  if (!base || !head) return false;
  const [before, after] = await Promise.all([carriesStarter(base), carriesStarter(head)]);
  return before && !after;
}

module.exports = {
  STARTER_PAGE,
  STARTER_MARKER,
  carriesStarter,
  beforeIsStarter,
};
