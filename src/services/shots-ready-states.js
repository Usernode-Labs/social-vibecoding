'use strict';

// What the author of a visible change is told, when they declare it, about
// the data the before & after copies hold. The largest group of changes
// that ended with no shots (7 of 24 in about 125 merged proposals) were
// declared for a state the copies did not have: a request waiting for
// approval, standings players with activities, an answered plan, an invited
// account. The shots agent found that out on the copies, after the author
// had finished, so it is said here instead, while the author can still seed
// the data or say how to make it.
//
// Every visible declaration's answer lists the ready-made states (the demo
// states of shots-demo-states.js, which only Homeroom's own copies get) and
// where anything else must come from. A WARNING is added only for a declared
// change whose own words name a state from NEEDS that no ready-made state
// holds, and whose author gave no hints.setup: the steps the shots agent
// takes through the UI on both copies are the author saying how it is made.
// Advisory, like shots-identities.personaWarnings: a declaration is never
// refused for it.
//
// Pure: the declare route reads the app once and passes `selfApp`.

// Each demo state in a few words, with who it is for (its persona and
// alsoFor), in shots-demo-states.js's order. tests/shots-ready-states.test.js
// keeps the two lists the same.
const READY_STATES = Object.freeze([
  ['shots-demo-member-agent-runs-v1', 'an agent run in progress, and one whose Stop is taking long', ['member']],
  ['shots-demo-member-change-preview-v1', 'a change with a deployed preview (Propose to group)', ['member']],
  ['shots-demo-member-agent-list-v1', 'enough agent sessions for the menu\'s Show more', ['member']],
  ['shots-demo-proposal-vote-states-v1', 'a proposal voted on at an earlier version, its threshold moved', ['member']],
  ['shots-demo-member-visibility-proposal-v1', 'a proposal of yours to make the app private', ['member']],
  ['shots-demo-homeroom-bot-verdict-v1', 'a live Homeroom bot verdict with its build', ['read_only_admin', 'full_admin']],
  ['shots-demo-challenge-groups-v1', 'finished First challenges and an Always open challenge',
    ['member', 'read_only_admin', 'full_admin']],
  ['shots-demo-member-challenge-standing-v1', 'your standing in the season and a challenge you finished', ['member']],
  ['shots-demo-member-friend-request-v1', 'a friend request waiting for you', ['member']],
  ['shots-demo-weekly-challenges-v1', 'a "This week" group of weekly challenges', ['member', 'read_only_admin', 'full_admin']],
  ['shots-demo-proposal-challenge-v1', 'a weekly challenge scored on sending a proposal, with its page',
    ['member', 'read_only_admin', 'full_admin']],
  ['shots-demo-member-remix-v1', 'a remix of yours that offers Suggest this back', ['member']],
  ['shots-demo-member-bot-run-card-v1', 'your chat with Homeroom bot, with a working activity card', ['member']],
  ['shots-demo-member-request-awaiting-approval-v1', 'a request whose change (yours) waits for approval',
    ['member', 'read_only_admin', 'full_admin']],
  ['shots-demo-standings-activities-v1', 'standings players with recorded point activities',
    ['member', 'read_only_admin', 'full_admin']],
  ['shots-demo-member-first-version-thanks-v1', 'an answered first-version plan with Homeroom bot\'s thanks under it',
    ['member']],
].map(([id, name, personas]) => Object.freeze({ id, name, personas: Object.freeze(personas) })));

// The states a declared change can need that a copy holds only when
// something wrote them, in the words authors use for them, and the ready-
// made states that hold each on Homeroom's copies (none: no ready-made state
// does). Phrases, not single words: "plan" or "invite" alone name a screen
// far more often than a state.
const NEEDS = Object.freeze([
  {
    needs: 'a change waiting for approval',
    test: /\b(?:wait(?:s|ing)? (?:for|on) (?:\w+ )?approval|awaits? (?:\w+ )?approval|awaiting (?:\w+ )?approval|up for (?:a |the )?vote)\b/i,
    states: ['shots-demo-member-request-awaiting-approval-v1', 'shots-demo-proposal-vote-states-v1',
      'shots-demo-member-visibility-proposal-v1'],
  },
  {
    needs: 'standings rows with recorded activities',
    test: /\b(?:standings?|leaderboard)\b[\s\S]*\bactivit(?:y|ies)\b|\bactivit(?:y|ies)\b[\s\S]*\b(?:standings?|leaderboard)\b/i,
    states: ['shots-demo-standings-activities-v1'],
  },
  {
    needs: 'an answered first-version plan',
    test: /\b(?:answered (?:the |its |their |a )?plan|plan (?:was |is )?answered|thanks? (?:you )?for answering|first[- ]version'?s? plan)\b/i,
    states: ['shots-demo-member-first-version-thanks-v1'],
  },
  {
    needs: 'an agent run in progress',
    test: /\b(?:agent (?:run|turn)s? (?:in progress|running|under ?way)|while (?:the |an )?agent (?:is )?(?:runs|running|working)|retry stop)\b/i,
    states: ['shots-demo-member-agent-runs-v1'],
  },
  { needs: 'a friend request', test: /\bfriend requests?\b/i, states: ['shots-demo-member-friend-request-v1'] },
  { needs: 'a remix', test: /\b(?:remix(?:ed|es)?|suggest (?:this|it) back)\b/i, states: ['shots-demo-member-remix-v1'] },
  {
    needs: 'a member in their first session (its tour)',
    test: /\b(?:first[- ]session|onboarding tour|the tour|tour(?:'s)? (?:last |first )?card)\b/i,
    states: [],
  },
  {
    needs: 'an account somebody invited',
    test: /\b(?:invited (?:\w+ )?(?:member|person|people|user|account|friend)s?|(?:member|person|user|account)s? (?:who|that) (?:was|were|has been|have been) invited|accept(?:ed|s|ing)? (?:an|the|their) invit(?:e|ation))\b/i,
    states: [],
  },
  { needs: 'an account on the waitlist', test: /\bwait[- ]?list(?:ed)?\b/i, states: [] },
  {
    needs: 'an empty state, or an account with nothing of its own yet',
    test: /\b(?:new (?:user|member|account|player)s?|brand[- ]new (?:user|member|account)s?|first[- ]time (?:user|member|visitor)s?|(?:has|have)(?:n't| not| never) (?:\w+ ){0,2}yet|no \w+ (?:\w+ )?yet|empty state)\b/i,
    states: [],
    // The guest browser IS a visitor with nothing yet.
    skipPersonas: ['guest'],
  },
]);

const SEEDS = Object.freeze({
  self: 'the staging seeds in src/db/migrate.js',
  child: 'the app\'s own staging seed (its IS_STAGING seed)',
});

/** Pure: a declared change's own words, as one line. */
function wordsOf(story) {
  const intent = story && typeof story.intent === 'object' ? story.intent : {};
  const steps = Array.isArray(intent.steps) ? intent.steps : [];
  return [story?.claim, intent.checkpoint, ...steps].filter((part) => typeof part === 'string').join(' ');
}

function hasSetup(story) {
  const setup = story?.intent?.hints?.setup;
  return typeof setup === 'string' && setup.trim().length > 0;
}

/**
 * What a declaration's answer says about the copies' data, or null for one
 * with nothing to shoot: `availableStates` (each ready-made state, by name,
 * with its personas: none for a child app), `dataNote` (where everything
 * else comes from) and `warnings` (see the top of this file).
 */
function declarationAdvice(intent, { selfApp = false } = {}) {
  const stories = Array.isArray(intent?.stories) ? intent.stories.filter((s) => s && typeof s === 'object') : [];
  if (intent?.impact === 'none' || !stories.length) return null;
  const available = selfApp ? READY_STATES : [];
  const held = new Set(available.map((state) => state.id));
  const seeds = selfApp ? SEEDS.self : SEEDS.child;
  const lacking = new Map();
  for (const story of stories) {
    if (hasSetup(story)) continue;
    const words = wordsOf(story);
    for (const need of NEEDS) {
      if ((need.skipPersonas || []).includes(story.persona)) continue;
      if (!need.test.test(words) || need.states.some((id) => held.has(id))) continue;
      if (!lacking.has(need.needs)) lacking.set(need.needs, []);
      lacking.get(need.needs).push(String(story.id || 'A declared change'));
    }
  }
  const warnings = [...lacking].map(([needs, ids]) => `${ids.join(', ')} ${ids.length > 1 ? 'seem' : 'seems'} to `
    + `need ${needs}, and ${selfApp ? 'no ready-made state on these copies holds it (see availableStates)'
      : 'this app\'s copies have no ready-made states'}. Add hints.setup with the steps that make it through `
    + `the UI, which the shots agent takes on both copies, or seed it in ${seeds} in a change merged before this `
    + 'one: a seed this proposal adds reaches only the after copy.');
  return {
    availableStates: available.map(({ name, personas }) => ({ name, personas: [...personas] })),
    dataNote: `${selfApp ? 'Homeroom\'s before & after copies hold its staging seeds and the ready-made states in '
      + 'availableStates, on both sides' : `This app's before & after copies hold what ${seeds} writes, and no `
      + 'ready-made states'}. Anything else a change needs comes from hints.setup steps the shots agent takes `
      + `through the UI on both copies, or from ${seeds}; a seed this proposal adds reaches only the after copy.`,
    warnings,
  };
}

module.exports = { READY_STATES, NEEDS, declarationAdvice };
