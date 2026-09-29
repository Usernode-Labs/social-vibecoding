// A LIST payload's copy of each proposal's check results: the checks that did
// not pass, and a count of the ones that did.
//
// Why this exists: `test_results` holds one row per declared check, and the
// platform's own dapp.json declares 800+. Every proposal row in the
// Workshop's lists carried all of them — measured on production, GET
// /api/apps/:slug/promoted was 1.9 MB for 8 open proposals and /merged 5.1 MB
// for its first 20, 97% of it passing rows, and /shared-sessions and the
// imported rows of /api/me/active-sessions carried the same. Opening the
// Workshop, or any item in it, downloaded all of that before the page could
// settle, for cards whose only use of the list is to count and name the
// failures ("Checks failing · 3", the merge-status line, the requirements
// detail).
//
// The one reader of the passing rows is the checks verdict on an item's own
// page (AppView._checksVerdictView), and that page always reads the item's
// own row (GET /api/apps/:slug/proposals/:id, /api/sessions/:id/details),
// which keeps every result. Until it lands, the verdict counts the passes it
// was told about in `test_results_omitted`, so its summary and fold read the
// same; only the folded list of passing names waits for the item's row.
//
// Opt-in, by `?results=failing`, so every other reader of these endpoints —
// the CLI, the connector, an agent reading /promoted — still gets the whole
// list exactly as before. The shell asks for the list form.
function wantsFailingResults(req) {
  return !!(req && req.query && req.query.results === 'failing');
}

// A shallow copy of `row` with its passing results dropped and counted.
// A row with no results, or none passing, comes back unchanged.
function failingResultsOnly(row) {
  if (!row || typeof row !== 'object' || !Array.isArray(row.test_results)) return row;
  const kept = row.test_results.filter((r) => !(r && r.status === 'pass'));
  const omitted = row.test_results.length - kept.length;
  if (!omitted) return row;
  return { ...row, test_results: kept, test_results_omitted: omitted };
}

// The rows as this request asked for them.
function forListing(req, rows) {
  if (!wantsFailingResults(req) || !Array.isArray(rows)) return rows;
  return rows.map(failingResultsOnly);
}

module.exports = {
  wantsFailingResults,
  failingResultsOnly,
  forListing,
};
