'use strict';

// One definition of "which `issues` rows are governance proposals": the
// five governance kinds, and the predicate that keeps a query on them. The
// list and its reasons are the workflow's (src/workflow/rules/governance-kinds.ts),
// which the governance machine decides with; this module re-exports it for
// every other reader, and a NEW server-side reader should import from here.

const { GOVERNANCE_KINDS, governanceKindsSql, isGovernanceKind } = require('../workflow/rules/governance-kinds.ts');

module.exports = {
  GOVERNANCE_KINDS,
  governanceKindsSql,
  isGovernanceKind,
};
