'use strict';

function activityTimePrecision(row) {
  const metadata = row.metadata || {};
  if (metadata.timestamp_precision === 'day' || metadata.timestamp_precision === 'instant') {
    return metadata.timestamp_precision;
  }
  // Credits written by the old date-grained app-use scorer are identifiable
  // by their measure, rather than by guessing from the hour of a timestamp.
  return ['TRY_APPS', 'USE_APPS_MINUTES'].includes(metadata.measure) ? 'day' : 'instant';
}

module.exports = { activityTimePrecision };
