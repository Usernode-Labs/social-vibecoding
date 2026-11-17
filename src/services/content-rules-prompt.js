'use strict';

// The platform's content rules, read once and shared by every prompt that
// draws or answers by them: the picture tool (services/bot-pictures.js), its
// thread tool (homeroom-bot-thread-tools/pictures.js) and Homeroom bot's
// replies in a project's thread (homeroom-bot-voice.js).
//
// #6675 changed what the rules allow (cartoon combat, weapons in games, and
// pretend-currency betting are "Allowed, never a reason to refuse"), and three
// prompts kept their own copy of the old list and went on refusing them
// (#6767). They read this instead, so the next change to the section reaches
// all three at once.
//
// The section itself is the source (prompts.getConventionSection, by the same
// slug homeroom-bot-live.js and content-review.js read). A missing section
// falls back to a built-in copy of the same bullets, so a prompt is never left
// without the rules.

const log = require('./logger');

const SLUG = 'content-rules-what-no-app-may-show';
const FORBIDDEN_MARKER = '**Never build, generate, seed or ship:**';
const ALLOWED_MARKER = '**Allowed, never a reason to refuse:**';

// What the section says today, used only when it cannot be read.
const FALLBACK = Object.freeze({
  forbidden: Object.freeze([
    'Sexual content or nudity. Sexual behaviour, explicit or not, and nudity, including suggestive images, avatars and emoji-art.',
    'Realistic or graphic violence. Gore, torture, and violence against real people or groups.',
    'Real tragedy, self-harm or drug use as entertainment.',
    'Real-money gambling. Wagering real money or anything that can be cashed out, and loot boxes (paid randomized rewards).',
  ]),
  allowed: Object.freeze([
    'Cartoon and fantasy violence in games: combat, and weapons as objects, icons and mechanics (a spaceship that shoots, a sword fight).',
    'Pretend-currency games: cards, poker, slots and bets for points with no cash value. Contests, leaderboards and rankings.',
    'Mysteries and crime stories, told without graphic detail.',
    'Meeting and matching people, with nothing sexual in it.',
  ]),
});

let cached = null;
let warned = false;

/** A bullet's short lead when it carries no bold: up to its first colon or full stop. */
function deriveHead(text) {
  const cut = text.search(/[:.] /);
  return (cut > 0 ? text.slice(0, cut) : text).replace(/[.,:;]+$/, '');
}

/**
 * The bullets under `marker`, as { head, text }: the bold lead each bullet
 * opens with (for a short sentence), and the whole bullet without its `**`.
 * A bullet's wrapped lines are joined into one line.
 */
function bulletsUnder(content, marker) {
  const lines = String(content || '').split('\n');
  const start = lines.findIndex((line) => line.trim() === marker);
  if (start < 0) return [];
  const out = [];
  let raw = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) {
      if (raw) { out.push(raw); raw = null; }
      if (out.length) break;
      continue;
    }
    if (/^\s*-\s+/.test(line)) {
      if (raw) out.push(raw);
      raw = line.replace(/^\s*-\s+/, '');
      continue;
    }
    if (/^\s+\S/.test(line) && raw) { raw = `${raw} ${line.trim()}`; continue; }
    if (raw) { out.push(raw); raw = null; }
    break;
  }
  if (raw) out.push(raw);
  return out
    .filter(Boolean)
    .map((bullet) => {
      const bold = /^\*\*(.+?)\*\*/.exec(bullet);
      const text = bullet.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
      const head = bold ? bold[1].replace(/\s+/g, ' ').trim() : deriveHead(text);
      return { head: head.replace(/[.,:;]+$/, ''), text };
    });
}

function read() {
  if (cached) return cached;
  let forbidden = [];
  let allowed = [];
  try {
    const { getConventionSection } = require('./prompts');
    const section = getConventionSection(SLUG);
    if (section?.content) {
      forbidden = bulletsUnder(section.content, FORBIDDEN_MARKER);
      allowed = bulletsUnder(section.content, ALLOWED_MARKER);
    }
  } catch (err) {
    log.warn('content-rules', 'Could not read the content rules section', { err: err.message });
  }
  if (!forbidden.length || !allowed.length) {
    if (!warned) {
      warned = true;
      log.warn('content-rules', 'The content rules section is missing or unreadable; using the built-in copy');
    }
    forbidden = FALLBACK.forbidden.map((text) => ({ head: deriveHead(text), text }));
    allowed = FALLBACK.allowed.map((text) => ({ head: deriveHead(text), text }));
  }
  cached = { forbidden, allowed };
  return cached;
}

/** The forbidden bullets, one plain line each. */
function forbidden() {
  return read().forbidden.map((b) => b.text);
}

/** The allowed bullets, one plain line each. */
function allowed() {
  return read().allowed.map((b) => b.text);
}

/** The short bold lead of each bullet in `list`, trailing punctuation dropped. */
function heads(list) {
  const byText = new Map([...read().forbidden, ...read().allowed].map((b) => [b.text, b.head]));
  return (Array.isArray(list) ? list : []).map((text) => {
    if (byText.has(text)) return byText.get(text);
    return deriveHead(String(text));
  });
}

/** The two lists as one sentence a prompt carries. */
function declineSentence() {
  return `Content rules: never ${heads(forbidden()).join(', ')}. Allowed, never a reason to refuse: ${heads(allowed()).join(', ')}.`;
}

module.exports = { SLUG, FALLBACK, forbidden, allowed, heads, declineSentence };
