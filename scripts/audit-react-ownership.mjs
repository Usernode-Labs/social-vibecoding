#!/usr/bin/env node

/**
 * Does any legacy module still write into a subtree a React island owns?
 *
 * WHY THIS EXISTS
 *
 * The step-3 shell migration's central rule (AGENTS.md, and the
 * `react-shell-migration` skill) is ONE OWNER PER SUBTREE: a region may become
 * a React island only when no `public/js/**` module writes into it. Breaking
 * that does not throw, does not fail a unit test, and usually does not even
 * look wrong on the day it lands — the legacy write paints, and it keeps
 * painting until the next store update repaints the row from a model that
 * never heard about it.
 *
 * Two shipped bugs of exactly that shape are what prompted this:
 *
 *   * the group chat's save button had its icon, three attributes and a class
 *     written straight onto a node transcript.tsx renders. It worked, and
 *     would have silently reverted on the next reaction.
 *   * the same transcript's edit paths assigned `.gc-msg-content.innerHTML`.
 *     `Body` memoises its `{__html}` wrapper on the string, so React kept
 *     believing the old content and repainted the row from it the next time
 *     anything else about the message changed — an edit followed by a
 *     reaction reverted the text on screen.
 *
 * Neither is visible to a static check: the write is in a classic script and
 * the node is React's. So this instruments the DOM in a real browser instead.
 *
 * WHAT IT DOES
 *
 * Patches the `innerHTML` setter, `insertAdjacentHTML` and `appendChild`
 * before any app code runs, walks a list of routes, and reports every write
 * whose target sits INSIDE one of the hosts below.
 *
 * WHY A LIST OF HOSTS RATHER THAN "ANY REACT ROOT"
 *
 * `main.tsx` hydrates the whole `<body>`, so "is this node inside a React
 * root" is true of every node in the document and flags nothing useful. Almost
 * everything under it is a DOCUMENTED legacy host — rendered once by React
 * with constant props and never looked inside again, which is the sanctioned
 * pattern (see the header of features/dev-board/board-frame.tsx). The hosts
 * below are the other kind: React renders and RECONCILES every descendant, so
 * a legacy write there is a second author.
 *
 * ADD A HOST HERE whenever a conversion makes one — that is the point.
 *
 * USAGE
 *
 *   node scripts/audit-react-ownership.mjs            # needs a dev server on :3000
 *   AUDIT_BASE=http://localhost:3000 AUTH=/path/auth.json node scripts/audit-react-ownership.mjs
 *
 * Exits non-zero when it finds anything, so it can gate a branch.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';

/*
 * Playwright is NOT a repository dependency and this script does not make it
 * one. The test suite is node:test over vm sandboxes with no browser in it,
 * and adding ~300MB of browser tooling to install a dev-only audit would be a
 * poor trade. Resolve it from wherever it happens to live — a global install,
 * an `npm i -g playwright`, or PLAYWRIGHT_PATH — and say so clearly when it
 * is absent, rather than failing with a bare module-not-found.
 */
const require_ = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require_(process.env.PLAYWRIGHT_PATH || 'playwright'));
} catch {
  try {
    ({ chromium } = require_('/opt/node22/lib/node_modules/playwright'));
  } catch {
    console.error(
      'This audit drives a real browser and needs Playwright, which is not a\n'
      + 'dependency of this repo. Install it globally (`npm i -g playwright`)\n'
      + 'or point PLAYWRIGHT_PATH at an existing copy.',
    );
    process.exit(2);
  }
}

const BASE = process.env.AUDIT_BASE || 'http://localhost:3000';
const AUTH = process.env.AUTH || '';
const CHROME = process.env.CHROME_PATH
  || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/**
 * Hosts whose ENTIRE subtree a React island renders and reconciles.
 *
 * `when` scopes an entry to one address, for a host that is React's on some
 * routes and a legacy module's on others. `#admin-section-content` is the
 * only one so far and it is a whole class of them: the admin console has one
 * content host and thirty sections take turns in it, so it is owned exactly
 * while the section occupying it is a converted one. Without the scope every
 * un-converted section's own `innerHTML` would report as a violation.
 */
const OWNED = [
  { sel: '#app-list' },                      // features/home/app-grid.tsx
  { sel: '#gc-messages' },                   // features/group-chat/transcript.tsx
  { sel: '#gc-thread-messages' },            // ditto, mounted with the 'thread' key
  { sel: '#llm-grants-list' },               // features/settings/grants-list.tsx
  { sel: '#agent-files-instructions-list' }, // features/settings/agent-files-list.tsx
  { sel: '#agent-files-skills-list' },
  { sel: '#browse-list' },                   // features/apps/browse-list.tsx
  { sel: '#standings-tabs' },                // @/components/ui/tabs, via the leaderboard
  { sel: '#admin-section-content', when: '#admin/e2e' },     // features/admin/admin-e2e.tsx
  { sel: '#admin-section-content', when: '#admin/gallery' }, // features/admin/admin-gallery.tsx
  { sel: '#admin-section-content', when: '#admin/node' },    // features/admin/admin-node.tsx
  { sel: '#admin-section-content', when: '#admin/merges' },  // features/admin/admin-merges.tsx
  { sel: '#admin-section-content', when: '#admin/push' },    // features/admin/admin-push.tsx
  { sel: '#admin-section-content', when: '#admin/campaigns' }, // features/admin/admin-campaigns.tsx
  { sel: '#admin-section-content', when: '#admin/mail' },    // features/admin/admin-mail.tsx
  { sel: '#admin-section-content', when: '#admin/status' },  // features/admin/admin-status.tsx
  { sel: '#admin-section-content', when: '#admin/estimator' }, // features/admin/admin-estimator.tsx
  { sel: '#admin-section-content', when: '#admin/analytics' }, // features/admin/admin-analytics.tsx
];

const ROUTES = [
  '#home', '#apps', '#apps/recipebot', '#settings', '#settings/app-ai',
  '#settings/agent-files', '#profile', '#leaderboard', '#messages',
  '#app/recipebot', '#app/recipebot/dev', '#app/recipebot/dev/chat',
  '#app/recipebot/dev/sessions/1',
  '#admin/e2e', '#admin/gallery', '#admin/node', '#admin/merges', '#admin/push', '#admin/campaigns', '#admin/mail', '#admin/estimator', '#admin/analytics', '#admin/status',
];

function instrument(owned) {
  window.__ownHits = [];
  const inside = (node) => {
    if (!node || node.nodeType !== 1) return null;
    for (const { sel, when } of owned) {
      // A scoped host is only React's while that address is on screen.
      if (when && !String(location.hash || '').startsWith(when)) continue;
      const host = document.querySelector(sel);
      // The host ITSELF counts, not just its descendants: appending a row
      // straight into `#gc-messages` is one of the two bugs this exists for.
      // That used to be excluded because mounting writes the host — but the
      // React filter above is what handles mounting now, precisely, so the
      // exclusion would only be hiding findings. (`mountLegacyPortal` clears
      // its host with `replaceChildren`, which is not one of the three
      // patched APIs.)
      if (host && host.contains(node)) return sel;
    }
    return null;
  };
  const where = (el) => {
    const bits = [];
    let n = el;
    for (let i = 0; n && n.nodeType === 1 && i < 3; i += 1, n = n.parentElement) {
      bits.unshift(n.id ? `#${n.id}` : n.tagName.toLowerCase()
        + (n.className ? `.${String(n.className).split(/\s+/).filter(Boolean).slice(0, 2).join('.')}` : ''));
    }
    return bits.join(' > ');
  };
  /*
   * React writes to the DOM with the same three APIs, so the patch has to
   * tell React's own commits apart from a legacy module's. Both parts below
   * are statements about what React CANNOT have done, not heuristics over
   * stack text — the bundle is minified, so its frame names say nothing.
   *
   * A portal mount made this necessary: a hydrated island's initial tree
   * arrives in the prerendered document, so React does no appending for it
   * and the audit never saw React at all. A section mounted at runtime
   * appends its whole subtree, and every one of those appends looked like a
   * violation.
   */
  const own = (node, prefix) => {
    if (!node || node.nodeType !== 1) return null;
    for (const k of Object.keys(node)) if (k.startsWith(prefix)) return node[k];
    return null;
  };
  // React attaches the fiber to a host instance in createInstance, BEFORE it
  // is ever appended anywhere — so a child with no fiber was created by
  // something that is not React, which is the whole finding.
  const reactMade = (node) => own(node, '__reactFiber$') != null;
  // Props are written by updateFiberProps ahead of the DOM update in both the
  // mount and the update path, so during React's own write the node's props
  // already hold the exact string being assigned. A legacy write into the
  // same node is a DIFFERENT string — which is precisely the shape of the bug
  // that prompted this script: `.gc-msg-content` is a dangerouslySetInnerHTML
  // sink AND was being assigned by group-chat.js. Comparing the value rather
  // than merely asking "is this a sink" is what keeps that catchable.
  const reactWroteHtml = (el, value) => {
    const props = own(el, '__reactProps$');
    const html = props && props.dangerouslySetInnerHTML && props.dangerouslySetInnerHTML.__html;
    return html != null && String(html) === String(value);
  };
  const note = (kind, el, value) => {
    const host = inside(el);
    if (!host) return;
    if (kind === 'appendChild' ? reactMade(value) : reactWroteHtml(el, value)) return;
    const stack = (String(new Error().stack || '')).split('\n').slice(2, 7)
      .map((l) => l.trim()).filter((l) => !/\bnote\b|<anonymous>:/.test(l));
    window.__ownHits.push({ kind, host, target: where(el), stack });
  };
  const proto = Element.prototype;
  const ih = Object.getOwnPropertyDescriptor(proto, 'innerHTML');
  Object.defineProperty(proto, 'innerHTML', {
    ...ih, set(v) { note('innerHTML', this, v); return ih.set.call(this, v); },
  });
  // React never reaches for insertAdjacentHTML, so every call is a finding.
  const iah = proto.insertAdjacentHTML;
  proto.insertAdjacentHTML = function patched(...a) {
    note('insertAdjacentHTML', this, null); return iah.apply(this, a);
  };
  const ap = Node.prototype.appendChild;
  Node.prototype.appendChild = function patched(...a) {
    note('appendChild', this, a[0]); return ap.apply(this, a);
  };
}

const browser = await chromium.launch({ executablePath: CHROME });
const context = await browser.newContext({
  viewport: { width: 440, height: 950 },
  serviceWorkers: 'block',
  ...(AUTH && fs.existsSync(AUTH) ? { storageState: AUTH } : {}),
});
const page = await context.newPage();
await page.addInitScript(instrument, OWNED);

const found = new Map();
for (const route of ROUTES) {
  await page.goto(BASE + '/' + route, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2600);
  const hits = await page.evaluate(() => {
    const out = window.__ownHits || [];
    window.__ownHits = [];
    return out;
  });
  for (const hit of hits) {
    const key = `${hit.kind} into ${hit.host} @ ${hit.target}`;
    if (!found.has(key)) found.set(key, { route, stack: hit.stack });
  }
}
await browser.close();

for (const [key, v] of found) {
  console.log(`${v.route}\n  ${key}`);
  (v.stack || []).slice(0, 2).forEach((s) => console.log(`      ${s.slice(0, 120)}`));
}
console.log(`\n${found.size} legacy write(s) into React-owned subtrees`);
process.exit(found.size ? 1 : 0);
