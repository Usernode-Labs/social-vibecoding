#!/usr/bin/env node
'use strict';

const { ensureSchema } = require('../src/db/schema-source');
if (require.main === module) {
  try { ensureSchema(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
