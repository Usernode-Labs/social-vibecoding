'use strict';

// Homeroom bot's tool registry (docs/plans/bot-one-model.md, step 2): every
// module that defines tools, loaded once, so a profile can name any of them.

const registry = require('./registry');

require('./source');
require('./platform');

module.exports = registry;
