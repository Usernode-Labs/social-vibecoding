'use strict';

// Historical assertions exercise the standalone archive, never live dispatch.
const { openArchive } = require('../../archives/experimental-replay-c01dc0687/replay.cjs');
const archive = openArchive();
module.exports = { replayHistorical: archive.replay };
