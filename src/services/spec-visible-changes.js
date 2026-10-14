'use strict';

// #4487: a Homeroom bot proposal's visible changes, for its before/after
// shots. The bot's build declares them itself with `declare_visible_changes`
// (homeroom-bot-live.js buildPrompt), exactly as a dev chat's build does.
// When it did not, they are derived here from the HTML spec the bot wrote
// before building: its `<ol data-changes>` lists each visible change in plain
// words with `data-steps` to reach it (prompts.js specHtmlContract), which is
// what a person's declaration says too. Without one the shots run stops at
// "no declared change recorded" and voters see only the spec's drawn screens.
//
// The derivation is pure and validated by the same parser submit_work and the
// declare route use (visible-changes.js). Anything it cannot turn into a
// valid declaration gives null: no declaration is better than a broken one.
// It never derives impact "none": a spec without a changes list may just be
// a markdown spec, and "none" would also switch off the changed-file backstop
// (shots-state.requireIntentForUiChange) that marks a UI change as owing shots.

const contract = require('./visible-changes');
const specHtml = require('./spec-html');

const VIEWPORTS = Object.freeze([
  Object.freeze({ name: 'desktop', ...specHtml.SCREEN_SIZES.desktop }),
  Object.freeze({ name: 'phone', ...specHtml.SCREEN_SIZES.phone }),
]);
// "Dev board → Up for vote → open a proposal", as the spec contract shows it,
// or "Settings > Profile".
const STEP_SPLIT = /\s*(?:→|->|⇒|=>|›|»)\s*|\s+>\s+/;

function oneLine(value, max) {
  const text = String(value || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Pure: the spec's numbered changes and the personas its screens are drawn
 * for. `[{ n, claim, steps }]`, in document order; changes with no words are
 * left out.
 */
function readSpecChanges(html) {
  const tokens = specHtml.tokenize(specHtml.stripHtmlWrapperFence(String(html || '')).trim());
  const changes = [];
  const personas = [];
  let inChanges = 0;
  let change = null;
  for (const tok of tokens) {
    if (tok.type === 'raw') {
      if (tok.name === 'template' && tok.attrs && 'data-screen' in tok.attrs) {
        personas.push(String(tok.attrs['data-persona'] || 'member').trim().toLowerCase());
      }
      continue;
    }
    if (tok.type === 'open') {
      if (tok.name === 'ol' && tok.attrs && 'data-changes' in tok.attrs) { inChanges += 1; continue; }
      if (tok.name === 'li' && inChanges && !change) {
        change = { n: tok.attrs['data-change'] || '', steps: tok.attrs['data-steps'] || '', text: '' };
      }
      continue;
    }
    if (tok.type === 'text') {
      if (change) change.text += specHtml.decodeEntities(tok.text);
      continue;
    }
    if (tok.type === 'close') {
      if (tok.name === 'li' && change) {
        const claim = oneLine(change.text, 1000);
        if (claim) {
          changes.push({
            n: oneLine(change.n, 20),
            claim,
            steps: oneLine(change.steps, 2000),
          });
        }
        change = null;
      } else if (tok.name === 'ol' && inChanges && !change) {
        inChanges -= 1;
      }
    }
  }
  return { changes, personas };
}

// Who is signed in: member, unless every screen the spec drew says the same
// other persona.
function personaFor(personas) {
  const distinct = [...new Set(personas)];
  return distinct.length === 1 && contract.PERSONAS.includes(distinct[0]) ? distinct[0] : 'member';
}

// The steps of `data-steps`, and an in-app path when the first one is one.
function routeFor(stepsText, claim) {
  const parts = String(stepsText || '').split(STEP_SPLIT).map((s) => oneLine(s, 200)).filter(Boolean);
  let startPath = '/';
  if (parts.length && contract.validRelativePath(parts[0])) startPath = parts.shift();
  const steps = parts.length ? parts : [oneLine(`Find where this shows: ${claim}`, 200)];
  return { startPath, steps: steps.slice(0, 40) };
}

function storyId(n, index, used) {
  const slug = String(n || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  let id = `change-${slug || index + 1}`;
  while (used.has(id)) id = `${id}-${index + 1}`;
  used.add(id);
  return id;
}

/**
 * Pure: a version-1 visible-changes declaration derived from an HTML spec,
 * already validated (visible-changes.parseIntent), or null when the spec
 * lists no visible change or the result would not be valid.
 */
function declarationFromSpec(html) {
  if (typeof html !== 'string' || !html.trim()) return null;
  let read;
  try { read = readSpecChanges(html); } catch { return null; }
  const changes = read.changes.slice(0, 3);
  if (!changes.length) return null;
  const persona = personaFor(read.personas);
  const used = new Set();
  const stories = changes.map((change, index) => {
    const { startPath, steps } = routeFor(change.steps, change.claim);
    return {
      id: storyId(change.n, index, used),
      claim: change.claim,
      persona,
      viewports: VIEWPORTS.map((v) => ({ ...v })),
      intent: {
        startPath,
        steps,
        checkpoint: oneLine(change.claim, 500),
        focus: oneLine(change.claim, 200),
      },
    };
  });
  const rationale = oneLine(changes.map((c) => c.claim).join(' · '), 1000);
  const parsed = contract.safeParseIntent({ version: 1, impact: 'ui', rationale, stories });
  return parsed.ok ? parsed.value : null;
}

/**
 * Record a bot proposal's visible changes before it is proposed: the build's
 * own declaration when it made one (already on the session, through the
 * declare route), else the one derived from its spec, through the same
 * shots-state.recordIntent every declaration goes through. Resolves
 * `{ source: 'build' | 'spec' | null, reason? }`; never throws.
 */
async function recordForBotProposal({ pool, config, sessionId, specHtml: html = null, shotsState = null } = {}) {
  if (!config?.shots?.collect) return { source: null, reason: 'collect_disabled' };
  const state = shotsState || require('./shots-state');
  try {
    const { rows } = await pool.query('SELECT shots_detail FROM chat_sessions WHERE id = $1', [sessionId]);
    const detail = rows[0]?.shots_detail;
    if (detail && typeof detail === 'object' && detail.intent) return { source: 'build' };
    const derived = declarationFromSpec(html);
    if (!derived) return { source: null, reason: 'no_changes_in_spec' };
    await state.recordIntent(pool, sessionId, derived);
    return { source: 'spec', intent: derived };
  } catch (err) {
    return { source: null, reason: 'error', error: err.message };
  }
}

module.exports = {
  VIEWPORTS,
  readSpecChanges,
  declarationFromSpec,
  recordForBotProposal,
};
