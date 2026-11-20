'use strict';

// Artifacts (docs/plans/artifacts.md): the tools every kind of artifact is
// written and changed with, defined once. An artifact is a page Homeroom bot
// writes with a person, kept in a thread of their chat with it
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
// thread comes to hold a plain page (the turn then loads the artifact
// capability, services/artifact-session.js). `artifact` is a turn in a
// thread that holds a plain page, or that just started one: each tool is the
// session's handler (`ctx.artifact`). `design` is a turn in a thread that
// holds a design (stage 3): write and edit are the design kind's, with its
// description (a screen in the project's own look), and its session
// (design-bot.js openSession) runs them itself; the names they had while
// design was a mode (write_screen, edit_design) still run there for one
// release.
//
// A step writes about 16,000 output tokens, so a page is written once and
// then changed with edits, never rewritten whole to move one line.

const registry = require('./registry');
const { ARTIFACT_LIMITS, DESIGN_LIMITS } = require('../bot-profiles');

// 20 Nov 2026 (live-draft review, K): a thread holds several artifacts,
// numbered in the order they were made. A call names one by its number; the
// turn opens it first (homeroom-bot-mayor.js artifactMove).
const ARTIFACT_PARAM = Object.freeze({
  write: Object.freeze({
    type: 'integer',
    minimum: 1,
    description: 'The number of the artifact in this thread to write again whole. Leave it out for a new artifact.',
  }),
  open: Object.freeze({
    type: 'integer',
    minimum: 1,
    description: 'The number of the artifact in this thread, when it is not the one open. Leave it out for the open one.',
  }),
});

const handled = (name) => async (args, ctx) => {
  if (!ctx?.artifact || typeof ctx.artifact.handle !== 'function') return { ok: false, error: `${name} is not offered here.` };
  return ctx.artifact.handle(name, args);
};

const DESCRIPTIONS = Object.freeze({
  write: {
    main: 'Write a page for them and keep it in this thread: one self-contained HTML page, with its own <style> and, when it '
      + 'needs to do something, its own inline <script>. Use it when what they ask for is better shown as a page than '
      + 'said in words: a comparison laid out as a table, a calculator, a chart, a checklist they can tick, a one-page '
      + 'summary. It is shown small under your reply, and they open it beside the chat. Never for a screen of an app or '
      + 'how one could look: that is start_design. Nothing in the page may load from the network (no external src, '
      + 'href, @import, fetch or font): it is blocked. It is saved as version 1 when you reply, and you change it '
      + 'afterwards with exact edits, so write it once, whole.',
    // 20 Nov 2026 (live-draft review, K, F): with no `artifact` number it
    // writes a NEW artifact, the thread's next; with one, a whole new
    // version of that one. A different subject is never written over another.
    artifact: 'Write a whole page: one self-contained HTML page, with its own <style> and inline <script>. With no artifact '
      + 'number it is a NEW artifact in this thread: for a different subject, or when they ask for a new one, or when '
      + 'there is none yet. With an artifact\'s number it writes that one again whole, as its next version. To change '
      + 'what a page shows, use edit_artifact instead. Never write one subject over another; when unsure, make a new '
      + 'one. One write_artifact a turn. It is saved when you reply.',
    design: 'Draw a whole screen: self-contained HTML for one screen (its markup, and a <style> block of its own for '
      + 'anything the project\'s stylesheets do not cover), at the size it is for. Homeroom puts the project\'s own '
      + 'stylesheets in, so use their classes and never copy CSS from them. A plan shows the screen without its '
      + 'scripts, so write every row, label and state it must show into the markup; use a script only for an '
      + 'interactive state the plan does not need. One write_artifact a turn: grow it with edit_artifact. It is saved as '
      + 'this turn\'s version when you reply (the result says which version). When you draw versions side by side, give '
      + 'each column data-variant="its label", and put data-chosen on the one they picked. To draw a screen this '
      + 'thread already holds again whole, give its artifact number; with no number, when one is open, it is a NEW '
      + 'artifact (a different screen).',
  },
  edit: {
    artifact: 'Change the page: exact find-and-replace edits on the current version\'s HTML, applied in order. Each '
      + '`find` must be copied exactly from the HTML and occur in it exactly once; `replace` takes its place (empty '
      + 'deletes it). Every call\'s edits together make this turn\'s one version (the result says which), and the '
      + 'reply\'s summary says once what that version changed.',
    design: 'Change the design: exact find-and-replace edits on the current version\'s HTML, applied in order. '
      + 'The way to change or extend this turn\'s screen: write rows and words into the markup, not a script that '
      + 'builds them. Each `find` must be copied exactly from the HTML and occur in it exactly once; `replace` takes '
      + 'its place (empty deletes it). Every call\'s edits together make this turn\'s one version (the result says '
      + 'which), and the reply\'s summary says once what that version changed.',
  },
});

registry.define({
  name: 'write_artifact',
  scopes: ['main', 'artifact', 'design'],
  schemaFor: (scope) => {
    const design = scope === 'design';
    return {
      description: DESCRIPTIONS.write[scope] || DESCRIPTIONS.write.artifact,
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: design ? 'The screen\'s name, in a few words ("Settings", "Order history").'
              : 'The page\'s name, in a few words ("Trip budget", "Plan comparison").',
          },
          size: {
            type: 'string',
            enum: ['phone', 'desktop'],
            description: design ? 'phone: 390 pixels wide; desktop: 1280.' : 'phone: 390 pixels wide; desktop: 1280. Desktop when they do not say.',
          },
          html: {
            type: 'string',
            description: design ? 'The whole screen: a full HTML document, or the body\'s markup.'
              : 'The whole page: a full HTML document, or the body\'s markup.',
          },
          // K: only where an artifact is open; the chat's own turn has none.
          ...(scope === 'main' ? {} : { artifact: ARTIFACT_PARAM.write }),
        },
        // A screen is drawn for a size; a page is desktop unless they say.
        required: design ? ['title', 'size', 'html'] : ['title', 'html'],
        additionalProperties: false,
      },
    };
  },
  run: handled('write_artifact'),
});

registry.define({
  name: 'edit_artifact',
  scopes: ['artifact', 'design'],
  schemaFor: (scope) => ({
    description: DESCRIPTIONS.edit[scope] || DESCRIPTIONS.edit.artifact,
    parameters: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          minItems: 1,
          maxItems: scope === 'design' ? DESIGN_LIMITS.editsPerCall : ARTIFACT_LIMITS.editsPerCall,
          items: {
            type: 'object',
            properties: { find: { type: 'string' }, replace: { type: 'string' } },
            required: ['find', 'replace'],
            additionalProperties: false,
          },
        },
        artifact: ARTIFACT_PARAM.open,
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
      properties: {
        version: { type: 'integer', description: 'The version to show, by its artifact\'s numbers.' },
        artifact: ARTIFACT_PARAM.open,
      },
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
