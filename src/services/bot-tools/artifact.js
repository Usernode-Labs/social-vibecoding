'use strict';

// Artifacts, stage 2 (docs/plans/artifacts.md): the tools every kind of
// artifact is written and changed with, defined once. An artifact is a page
// Homeroom bot writes with a person, kept in a thread of their chat with it
// (services/artifacts.js) and changed in place, one version a turn.
//
//   write_artifact     the whole page, once
//   edit_artifact      exact find-and-replace edits on the version shown
//   show_artifact      put a version's card under the reply again
//   compare_artifacts  two or three versions side by side, as a card
//
// Private threads with the bot only: none of these is offered in a
// project's thread, and nothing here publishes a page to anyone.
//
// Scopes: `main` is the chat's own turn, where write_artifact is the way a
// thread comes to hold a page (the turn then loads the artifact capability,
// services/artifact-session.js). `artifact` is a turn in a thread that holds
// one, or that just started one: the session there holds the page being
// made, and each tool is the session's handler (`ctx.artifact`).
//
// A step writes about 16,000 output tokens, so a page is written once and
// then changed with edits, never rewritten whole to move one line.

const registry = require('./registry');
const { ARTIFACT_LIMITS } = require('../bot-profiles');

const handled = (name) => async (args, ctx) => {
  if (!ctx?.artifact || typeof ctx.artifact.handle !== 'function') return { ok: false, error: `${name} is not offered here.` };
  return ctx.artifact.handle(name, args);
};

registry.define({
  name: 'write_artifact',
  scopes: ['main', 'artifact'],
  schemaFor: (scope) => ({
    description: scope === 'main'
      ? 'Write a page for them and keep it in this thread: one self-contained HTML page, with its own <style> and, when it '
        + 'needs to do something, its own inline <script>. Use it when what they ask for is better shown as a page than '
        + 'said in words: a comparison laid out as a table, a calculator, a chart, a checklist they can tick, a one-page '
        + 'summary. It is shown small under your reply, and they open it beside the chat. Never for a screen of an app or '
        + 'how one could look: that is start_design. Nothing in the page may load from the network (no external src, '
        + 'href, @import, fetch or font): it is blocked. It is saved as version 1 when you reply, and you change it '
        + 'afterwards with exact edits, so write it once, whole.'
      : 'Write the whole page again: one self-contained HTML page, with its own <style> and inline <script>. Only when '
        + 'they ask for a different page altogether, or there is none yet: to change the page that is here, use '
        + 'edit_artifact. One write_artifact a turn. It is saved as this turn\'s version when you reply.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The page\'s name, in a few words ("Trip budget", "Plan comparison").' },
        size: { type: 'string', enum: ['phone', 'desktop'], description: 'phone: 390 pixels wide; desktop: 1280. Desktop when they do not say.' },
        html: { type: 'string', description: 'The whole page: a full HTML document, or the body\'s markup.' },
      },
      required: ['title', 'html'],
      additionalProperties: false,
    },
  }),
  run: handled('write_artifact'),
});

registry.define({
  name: 'edit_artifact',
  scopes: ['artifact'],
  schemaFor: () => ({
    description: 'Change the page: exact find-and-replace edits on the current version\'s HTML, applied in order. Each '
      + '`find` must be copied exactly from the HTML and occur in it exactly once; `replace` takes its place (empty '
      + 'deletes it). Every call\'s edits together make this turn\'s one version (the result says which), and the '
      + 'reply\'s summary says once what that version changed.',
    parameters: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          minItems: 1,
          maxItems: ARTIFACT_LIMITS.editsPerCall,
          items: {
            type: 'object',
            properties: { find: { type: 'string' }, replace: { type: 'string' } },
            required: ['find', 'replace'],
            additionalProperties: false,
          },
        },
      },
      required: ['edits'],
      additionalProperties: false,
    },
  }),
  run: handled('edit_artifact'),
});

registry.define({
  name: 'show_artifact',
  scopes: ['artifact'],
  schemaFor: () => ({
    description: 'Put the page under your reply again, small, with Open preview: when they ask to see it, or an earlier '
      + 'version of it, and you are not changing it this turn. Leave version out for the newest.',
    parameters: {
      type: 'object',
      properties: { version: { type: 'integer', description: 'The version to show, by this thread\'s numbers.' } },
      additionalProperties: false,
    },
  }),
  run: handled('show_artifact'),
});

registry.define({
  name: 'compare_artifacts',
  scopes: ['artifact'],
  schemaFor: () => ({
    description: 'Show versions of this page side by side, as a card under your reply where they pick one: when they ask '
      + 'to compare versions or to see them next to each other. 2 or 3 in all. The versions are this thread\'s numbers; '
      + 'one you wrote this turn is the next number.',
    parameters: {
      type: 'object',
      properties: {
        versions: { type: 'array', items: { type: 'integer' }, description: 'The version numbers to show, in order.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'A short name for each of those versions, in the same order.' },
      },
      required: ['versions'],
      additionalProperties: false,
    },
  }),
  run: handled('compare_artifacts'),
});

module.exports = { NAMES: Object.freeze(['write_artifact', 'edit_artifact', 'show_artifact', 'compare_artifacts']) };
