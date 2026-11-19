'use strict';

// A stored work state as the server sends it to a screen (19 Nov 2026).
//
// A client surface is tested with the row it will really be handed: the
// stored row's shape and its words from the server's own code
// (src/services/work-state.js shapeOf, which words it with phrasesOf), as one
// viewer reads it (forViewer), and through JSON, as the wire carries it.
// tests/lib/work-words.js gives a fixture the same words from a table kept by
// hand; this asks the server, so a fixture cannot say words the server would
// not have sent with that stage and line.
//
//   storedRow({ stage: 'stopped', reason: 'fix_stopped', change })
//   storedRow({ stage: 'checking', line: { code: 'shots' } }, { kind: 'change', myVote: 'yes' })
//
// `state` is what the derive stores (stage, why, reason, line, whoseMove,
// since) plus what the row's `standing` holds (change, asks, said, cause,
// causeNames, runId). `viewer` is forViewer's (mine, voteOwed, viewerId,
// myVote) and `kind`.

const workState = require('../../src/services/work-state');

const STANDING_KEYS = ['change', 'asks', 'said', 'cause', 'causeNames', 'runId', 'tries', 'tryStarts', 'doneBy'];

function storedRow(state, viewer = {}) {
  const { kind = 'request', ...reader } = viewer;
  const standing = {};
  for (const key of STANDING_KEYS) if (state[key] !== undefined) standing[key] = state[key];
  const change = kind === 'change';
  const shaped = workState.shapeOf({
    appId: 1,
    app: { slug: 'garden', name: 'Garden' },
    kind: change ? 'change' : 'request',
    ref: change ? 51 : 7,
    issueNumber: change ? null : 7,
    sessionId: change ? 51 : null,
    stage: state.stage,
    why: state.why || null,
    reason: state.reason || null,
    line: state.line || null,
    whoseMove: state.whoseMove || null,
    requesterId: state.requesterId == null ? 42 : state.requesterId,
    since: state.since || '2026-11-08T12:00:00Z',
    updatedAt: state.since || '2026-11-08T12:00:00Z',
    voteOpen: !!(state.change && state.change.voteOpen),
    leadChangeId: state.change ? state.change.id : null,
    standing,
  });
  // A request is read by its requester unless the test says who reads it.
  const asker = reader.mine === false ? null : shaped.requesterId;
  return JSON.parse(JSON.stringify(workState.forViewer(shaped, { mine: !change, viewerId: change ? null : asker, ...reader })));
}

/** The change a request's row draws (its `standing.change`), in the shape the row stores it. */
function storedChange(over = {}) {
  return {
    id: 51, number: 8, status: 'promoted', checks: { state: 'passing', phase: 'done', failing: null }, votes: { yes: 0, no: 0 },
    voteOpen: false, firstVersion: false, githubHold: false, shotsHeld: false, conflict: false, update: null, ...over,
  };
}

module.exports = { storedRow, storedChange };
