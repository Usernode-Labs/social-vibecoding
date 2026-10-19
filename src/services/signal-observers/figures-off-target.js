'use strict';

// figure_off_target: a topic figure that stays off its target.
//
// A figure's target only coloured its cell (services/topic-figures.js): the
// strip turned a number the attention ink, and nothing else happened until
// somebody reading the topic noticed. This reads the platform's own topics'
// strips as the topic page does and returns every figure that is off its
// target now. The kind waits a day before it files (platform-signals.js
// KINDS.figure_off_target), so only a figure that stayed off for a whole
// day becomes a request, and most of these are a person's to weigh: a
// figure is a measure of the product, and the fix is rarely one file.
//
// The figures read the same cached sources the topic page does (10 minutes
// for the rolling ones, a day for the daily ones), so this costs no more
// queries than somebody opening the four topics.

const SELF_TOPICS_SQL = `
  SELECT r.category_key, r.label, r.topic_figures
    FROM app_category_registry r
    JOIN apps a ON a.id = r.app_id
   WHERE a.self_hosted = TRUE AND r.origin = 'topic'
     AND COALESCE(r.topic_state, 'live') = 'live'
   ORDER BY r.topic_order NULLS LAST, r.id`;

/** Pure: whether one figure as the strip draws it is off its target. */
function isOff(figure) {
  if (!figure) return false;
  if (figure.state === 'warn') return true;
  return Array.isArray(figure.sides) && figure.sides.some((s) => s && s.state === 'warn');
}

async function run(pool, { figures = require('../topic-figures') } = {}) {
  const { rows } = await pool.query(SELF_TOPICS_SQL);
  const items = [];
  for (const topic of rows) {
    const ids = figures.knownFigureIds(topic.topic_figures);
    if (!ids.length) continue;
    const strip = await figures.figuresFor(pool, ids);
    for (const f of strip.figures || []) {
      if (!isOff(f)) continue;
      const sides = Array.isArray(f.sides)
        ? f.sides.filter((s) => s && s.state === 'warn').map((s) => `${s.name}: ${s.value}${s.detail ? ` (${s.detail})` : ''}`)
        : [];
      items.push({
        kind: 'figure_off_target',
        key: `${topic.category_key}/${f.id}`,
        topic: topic.category_key,
        subject: { topic: topic.category_key, figure: f.id },
        title: `Off target: ${f.label} (${topic.label || topic.category_key})`,
        summary: `The ${topic.label || topic.category_key} topic's figure "${f.label}" has been off its target for a day. `
          + 'It is a measure of how the platform is doing, so the change it needs is usually a decision, not one file.',
        evidence: {
          lines: [
            `Now: ${f.value}${f.sub ? ` (${f.sub})` : ''}.`,
            ...sides.map((s) => `Off target: ${s}.`),
            f.tip ? `What it measures: ${f.tip}` : null,
          ].filter(Boolean),
          where: ['src/services/topic-figures.js'],
        },
      });
    }
  }
  return items;
}

module.exports = { run, isOff, SELF_TOPICS_SQL };
