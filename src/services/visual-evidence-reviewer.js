'use strict';

const llm = require('./llm');

class VisualEvidenceReviewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VisualEvidenceReviewError';
    this.code = code;
  }
}

function groupReviewImages(artifacts) {
  const groups = new Map();
  for (const artifact of artifacts || []) {
    if (artifact.media !== 'png' || !['focus', 'context'].includes(artifact.variant)
        || !['base', 'head'].includes(artifact.side)) continue;
    const key = `${artifact.storyId}\u0000${artifact.viewport}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({
      label: `${artifact.side} ${artifact.variant}`,
      contentType: artifact.contentType,
      data: artifact.data,
    });
  }
  return groups;
}

async function review({ intent, artifacts, telemetryContext = null, reviewStory = llm.reviewVisualEvidenceStory }) {
  const groups = groupReviewImages(artifacts);
  const verdicts = [];
  for (const story of intent?.stories || []) {
    for (const viewport of story.viewports || []) {
      const images = groups.get(`${story.id}\u0000${viewport.name}`) || [];
      if (images.length !== 4) {
        throw new VisualEvidenceReviewError(
          'incomplete_review_artifacts',
          `Semantic review requires focused and context pairs for ${story.id}/${viewport.name}.`
        );
      }
      verdicts.push(await reviewStory({
        claim: story.claim,
        flow: story.intent.steps.join(' -> '),
        persona: story.persona,
        viewport: viewport.name,
        images,
        telemetryContext,
      }));
    }
  }
  if (!verdicts.length) throw new VisualEvidenceReviewError('missing_review_artifacts', 'No evidence stories were available for semantic review.');
  const relevant = verdicts.every((item) => item.relevant === true);
  const focusAccurate = verdicts.every((item) => item.focusAccurate === true);
  const needsRepair = verdicts.some((item) => item.needsRepair === true) || !relevant || !focusAccurate;
  return {
    relevant,
    focusAccurate,
    needsRepair,
    reason: verdicts.map((item) => item.reason).join(' ').slice(0, 2000),
    reviewer: 'fallback_vision',
    storyVerdicts: verdicts,
  };
}

module.exports = { VisualEvidenceReviewError, groupReviewImages, review };
