'use strict';

// Code-host writes belong to a workflow process. Check at the host boundary
// before reading a credential or starting any I/O, so an overlooked caller
// on web fails with a named, searchable error.
const { processRole, runsWorkflow } = require('./process-role');
function requireCodeHostWrite(operation) {
  if (!runsWorkflow(processRole())) {
    const error = Object.assign(new Error('Code-host writes require a conductor: ' + operation), {
      code: 'workflow_role_required',
    });
    require('./logger').error('code-host-write', error.message);
    throw error;
  }
}
module.exports = { requireCodeHostWrite };
