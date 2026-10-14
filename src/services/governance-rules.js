'use strict';

// WHO SAYS YES (#4666): a project's approval rule as named presets, or as
// groups and rules of its own. The rules are the workflow's
// (src/workflow/rules/governance-rules.ts, whose header describes the block,
// the groups and how each rule counts): the governance machine decides with
// them inside its transaction, and this module re-exports them for every
// other reader.

module.exports = { ...require('../workflow/rules/governance-rules.ts') };
