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
// page (AppView._checksVerdictView), and it lists them only inside the
// "N passing" fold. So the item's own row (GET /api/apps/:slug/proposals/:id,
// /api/sessions/:id/details) comes in the same form (`forItem`) — on
// production a proposal's row was 265 KB, 255 KB of it the names of checks
// that passed — and the verdict counts the passes in `test_results_omitted`.
// Opening the fold reads the row once more without the flag
// (AppView._loadCheckNames), so the names arrive when someone asks for them.
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

// #3978: a failing unit-suite row carries its per-test excerpts (up to
// ~20 KB). The item's own row keeps them — the verdict's "Why it failed"
// fold and the connector read them there — but a LIST payload is counted
// and named only, so a board of failing proposals does not grow by every
// excerpt again. Stripped here, in the list projection, not inside
// failingResultsOnly: forItem reuses that to shed passing rows and must
// keep the failing ones intact.
const DETAIL_FIELDS = ['failureDetails', 'failureDetailsTruncated'];
function withoutFailureDetails(row) {
  if (!row || typeof row !== 'object' || !Array.isArray(row.test_results)) return row;
  if (!row.test_results.some((r) => r && (r.failureDetails || r.failureDetailsTruncated))) return row;
  return {
    ...row,
    test_results: row.test_results.map((r) => {
      if (!r || !(r.failureDetails || r.failureDetailsTruncated)) return r;
      const copy = { ...r };
      delete copy.failureDetails;
      delete copy.failureDetailsTruncated;
      return copy;
    }),
  };
}

// The rows as this request asked for them.
function forListing(req, rows) {
  if (!wantsFailingResults(req) || !Array.isArray(rows)) return rows;
  return rows.map((row) => withoutFailureDetails(failingResultsOnly(row)));
}

// One item's row as this request asked for it. A row with only a few passing
// checks keeps them: the verdict lists up to this many without a fold
// (AppView.PASS_FOLD_AT), so there is no fold to open for the names.
const ITEM_PASSES_LISTED = 8;
function forItem(req, row) {
  if (!wantsFailingResults(req) || !row || !Array.isArray(row.test_results)) return row;
  const passing = row.test_results.filter((r) => r && r.status === 'pass').length;
  return passing > ITEM_PASSES_LISTED ? failingResultsOnly(row) : row;
}

module.exports = {
  wantsFailingResults,
  failingResultsOnly,
  withoutFailureDetails,
  forListing,
  forItem,
  ITEM_PASSES_LISTED,
};
