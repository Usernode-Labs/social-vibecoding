'use strict';

// Render the build prompt a replayed case is given, for either variant:
//
//   legacy   — what a GLM build turn got before the shared build contract:
//              the dispatched block from the platform's first commit, the
//              "helper NOT available" note, and the handbook inline in the
//              user message (the transport followed the backend, not the CLI).
//   contract — what the same turn gets now: the new dispatched block, the
//              shared build contract, the PLATFORM ISSUE escalation, and the
//              handbook as system context when the CLI is Claude Code.
//
// Built from the production building blocks, so the contract variant cannot
// drift from what the platform sends. Left out, identically in both variants:
// the spec block, the repo CLAUDE.md note, and the helper notes for services
// a replay has no platform behind (usernode-issues, the Homeroom read tools).

const sessions = require('../../src/routes/sessions');
const { getAppConventions, getDesignGuidance } = require('../../src/services/prompts');
const buildContract = require('../../src/services/build-contract');
const legacy = require('./legacy');

const VARIANTS = Object.freeze(['legacy', 'contract']);

function renderReplayPrompt(caseDef, {
  variant,
  harness = 'claude',
  conventions = getAppConventions(),
} = {}) {
  if (!VARIANTS.includes(variant)) throw new Error(`unknown variant: ${variant}`);
  const isLegacy = variant === 'legacy';
  const context = sessions.buildCodingAgentConventionsContext({
    isCodexSession: true,
    // Before the contract the handbook's transport followed the backend, so
    // an OpenRouter turn got it inline whatever CLI ran it.
    harness: isLegacy ? null : harness,
    conventions,
    designGuidance: getDesignGuidance({ readsImages: false }),
  });
  const guidance = sessions.buildCodingAgentBuildGuidance({
    authoritativeSystemContext: Boolean(context.systemPrompt),
  });
  const turnInstructions = isLegacy
    ? legacy.LEGACY_DISPATCHED_TURN_INSTRUCTIONS
    : sessions.DISPATCHED_TURN_INSTRUCTIONS;
  const contractBlock = isLegacy
    ? ''
    : `${buildContract.buildContractBlock({ commits: 'agent', summary: false })}\n${sessions.DEV_CHAT_SUMMARY_RULE}\n`;
  const escalation = isLegacy
    ? legacy.LEGACY_OPENROUTER_ISSUE_NOTE
    : sessions.OPENROUTER_PLATFORM_ISSUE_GUIDANCE;

  const prompt = `USER REQUEST: "${caseDef.userMessage}"

CODING TASK (from the Mayor):
${caseDef.request}

${context.promptBlock}

${escalation}

INSTRUCTIONS:
${sessions.buildHostedCodingWorkflowGuidance()}
${turnInstructions}
${contractBlock}${guidance.browserGuidance}
${sessions.OPENROUTER_PROPOSAL_DESCRIPTION_GUIDANCE}
${guidance.testingGuidance}`;
  return { prompt, systemPrompt: context.systemPrompt };
}

module.exports = { VARIANTS, renderReplayPrompt };
