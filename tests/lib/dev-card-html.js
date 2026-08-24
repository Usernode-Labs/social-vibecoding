'use strict';

// Render a Dev board card — or a whole card surface — to static HTML.
//
// ── Why the tests need this ────────────────────────────────────────────
//
// The card family used to be seven `_render*Card` string builders in
// public/js/app-view.js, and ~30 test files asserted on the strings they
// returned. #1367's chunk split that in two: app-view.js builds a plain
// view MODEL (frontend/src/features/dev-board/card/model.ts) and
// frontend/src/features/dev-board/card/dev-card.tsx renders it.
//
// So a test that used to say
//
//     const html = AppView._renderProposalCard(pr);
//
// says
//
//     const html = proposalCardHtml(AppView, pr);
//
// and keeps every assertion it already had. Both halves are the real
// production code — the model builder from the vm-loaded module, the markup
// from the bundled component — so this composes them exactly as the store
// does at runtime; it is a call-shape convenience, not a stand-in.
//
// ── The honest limits ──────────────────────────────────────────────────
//
// - Effects do not run (renderToStaticMarkup). Nothing in the card tree
//   uses one; the two stores it reads are read through
//   `useSyncExternalStore`'s server snapshot, which is the same value.
// - React ESCAPES text children, and the vm sandboxes these tests build
//   stub `escapeHtml`/`escapeAttr` as identity. So a string that arrives
//   already-escaped from the module would double-escape — which is the
//   point: the model carries RAW text and only the component escapes.
// - Attribute ORDER is React's, not the template literal's. Assertions
//   that pinned a whole tag were rewritten to pin the parts.

const { loadTsx, renderToHtml, createElement } = require('./render-tsx');

let api = null;
function mod() {
  if (!api) api = loadTsx('tests/fixtures/dev-card-api.ts');
  return api;
}

/** Render a DevCardModel. */
function cardHtml(model) {
  return renderToHtml(createElement(mod().DevCard, { model }));
}

const issueCardHtml = (AppView, issue, opts) => cardHtml(AppView._issueCardModel(issue, opts));
const proposalCardHtml = (AppView, pr, opts) => cardHtml(AppView._proposalCardModel(pr, opts));
const govCardHtml = (AppView, issue, opts) => cardHtml(AppView._govCardModel(issue, opts));
const mySessionCardHtml = (AppView, s) => cardHtml(AppView._mySessionCardModel(s));
const sharedSessionCardHtml = (AppView, s, opts) => cardHtml(AppView._sharedSessionCardModel(s, opts));
const mergedCardHtml = (AppView, pr, majority) => cardHtml(AppView._mergedCardModel(pr, majority));
const closeIssueCardHtml = (AppView, row) => cardHtml(AppView._completedCloseIssueCardModel(row));
const mergedRowHtml = (AppView, row) => {
  const m = AppView._mergedRowModel(row);
  return m ? cardHtml(m) : '';
};

/** Render the whole list feed from `AppView._feedView()`. */
function feedHtml(AppView) {
  const m = mod();
  m.devFeedStore.set(AppView._feedView());
  return renderToHtml(createElement(m.DevFeed));
}

/** Render the whole kanban board from `AppView._kanbanView()`. */
function kanbanHtml(AppView) {
  const m = mod();
  m.devKanbanStore.set(AppView._kanbanView());
  return renderToHtml(createElement(m.DevKanban));
}

// ── The topic head's body blocks ────────────────────────────────────────
//
// `_detailActionsHtml`, `_proposalDetailsHtml`, `_checksDetailHtml`,
// `_platformEnvDetailHtml`, `_consoleCheckDetailHtml` and
// `_mergeConflictDetailHtml` all built strings. #1367's topic chunk split
// each into a view builder (still in app-view.js, still where the decisions
// are) and topic/topic-head.tsx, which draws them. These compose the two so
// the assertions that were written against the strings keep working.

// A card model with nothing in it, so a body-block helper renders its block
// and nothing else. The head always draws a card; these are about what is
// UNDER it.
const BLANK_CARD = {
  key: 'k', cls: '', attrs: {}, icon: null, title: { text: '', title: '' }, meta: [],
  pill: null, linked: [], badges: [], chatCount: null, actions: [],
  rail: { chevron: false }, extra: [], dense: false, uncapped: true,
};

/** The proposal detail block: the meta line, its notes and its boxes. */
function detailsHtml(AppView, pr) {
  return topicHeadHtml(BLANK_CARD, { actions: null, details: AppView._proposalDetailsView(pr) });
}

/** The detail ACTION block alone — the pills, the reasons, the visuals. */
function detailActionsHtml(AppView, kind, item) {
  return topicHeadHtml(BLANK_CARD, { actions: AppView._detailActionsView(kind, item) });
}

/** The Preview affordance, from `AppView._cardPreviewSpec`'s truth table. */
function previewHtml(AppView, item, opts) {
  const spec = AppView._cardPreviewSpec(item, opts);
  return spec ? renderToHtml(createElement(mod().Preview, { spec })) : '';
}

/** One action pill — the Re-run checks button, a note box's fix button. */
function actionHtml(a) {
  return a ? renderToHtml(createElement(mod().ActionButton, { a })) : '';
}

/** One note box (conflict / platform variables / console errors). */
function noteBoxHtml(box) {
  return box ? renderToHtml(createElement(mod().NoteBoxView, { box })) : '';
}

/** One conflict / platform-variables / console-errors box. */
const platformEnvHtml = (AppView, pr) => noteBoxHtml(AppView._platformEnvNote(pr));
const consoleCheckHtml = (AppView, pr) => noteBoxHtml(AppView._consoleCheckNote(pr));
const mergeConflictHtml = (AppView, pr) => noteBoxHtml(AppView._mergeConflictNote(pr));

/** The checks block: the verdict when there is one, else its status note. */
function checksHtml(AppView, pr) {
  const v = AppView._checksVerdictView(pr);
  if (v) return renderToHtml(createElement(mod().ChecksVerdictView, { v }));
  return AppView._checksStatusNotes(pr).map(noteBoxHtml).join('');
}

/** #1370's "Full proposal details" disclosure alone. */
function proposalBodyHtml(AppView, pr) {
  const b = AppView._proposalBodyView(pr);
  return b ? renderToHtml(createElement(mod().ProposalBody, { b })) : '';
}

/** The shared-chat disclosure alone. */
function transcriptHtml(AppView, item) {
  const t = AppView._transcriptSectionView(item);
  return t ? topicHeadHtml(BLANK_CARD, { actions: null, transcript: t }) : '';
}

/** Render the opened topic's whole head from `AppView._renderTopicHead`'s two halves. */
function topicHeadHtml(card, body) {
  const m = mod();
  m.topicHeadStore.set({ card, body });
  return renderToHtml(createElement(m.TopicHead));
}

/** Render one ListRow (a divider, the filter note, the archived block). */
function listRowHtml(row) {
  return renderToHtml(createElement(mod().ListRowView, { row }));
}

/** Render the rows of one kanban column by key, without the column chrome. */
function columnHtml(AppView, key) {
  const view = AppView._kanbanView();
  const col = view.cols.find((c) => c.key === key);
  if (!col) return '';
  return col.rows.map((row) => listRowHtml(row)).join('');
}

/**
 * The 30s countdown tick. `AppView._startMergeCountdownTimer` publishes
 * `Date.now()`; a test that wants a specific instant sets it here.
 */
function setCardNow(now) {
  mod().cardNowStore.set({ now });
}

/** `/api/budget`'s aiEnabled answer, which the Explore pills read. */
function setAiEnabled(enabled) {
  mod().aiEnabledStore.set({ enabled });
}

/**
 * Every `ActionRef` a model dispatches, anywhere in it.
 *
 * The cards used to carry their wiring in the markup —
 * `onclick="AppView.castVote(12, 'yes')"` — because an innerHTML card had
 * nowhere else to put a handler, and the tests asserted on those strings.
 * A React card holds the closure instead, so the wiring is in the MODEL and
 * this is where a test reads it. Strictly more precise than the string
 * match was: `/markIssueInProgress\(5\)/` also matched a tooltip that
 * happened to mention it.
 */
function actionRefs(model) {
  const out = [];
  const push = (ref) => { if (ref && ref.fn) out.push(ref); };
  for (const a of model.actions || []) push(a.act);
  for (const b of [...(model.badges || []), ...(model.linked || [])]) push(b.act);
  for (const x of model.extra || []) {
    if (x.t === 'claims') for (const c of x.claims) push({ fn: 'clearIssueClaim', args: [c.issue, c.userId] });
  }
  for (const p of [model.rail && model.rail.preview, model.actionPreview]) {
    if (p && p.state === 'live') push({ fn: 'swapToStagingForSession', args: [p.sessionId, p.url] });
  }
  for (const b of [...(model.badges || []), ...(model.linked || [])]) {
    if (b.t === 'issueChip') push({ fn: 'openTopic', args: ['issue', b.n] });
  }
  if (model.title && model.title.edit) push({ fn: 'beginIssueTitleEdit', args: [model.title.edit.issue] });
  return out;
}

/** True when the model dispatches `fn`, with `args` as a leading prefix. */
function hasAction(model, fn, ...args) {
  return actionRefs(model).some((r) => r.fn === fn
    && args.every((v, i) => (r.args || [])[i] === v));
}

/** The two budgets, which live in the component now. */
const budgets = () => ({ ACTION_PRIMARY_MAX: mod().ACTION_PRIMARY_MAX, BADGE_MAX: mod().BADGE_MAX });

module.exports = {
  actionHtml,
  proposalBodyHtml,
  previewHtml,
  topicHeadHtml,
  transcriptHtml,
  detailsHtml,
  detailActionsHtml,
  noteBoxHtml,
  platformEnvHtml,
  consoleCheckHtml,
  mergeConflictHtml,
  checksHtml,
  budgets,
  actionRefs,
  hasAction,
  cardHtml,
  issueCardHtml,
  proposalCardHtml,
  govCardHtml,
  mySessionCardHtml,
  sharedSessionCardHtml,
  mergedCardHtml,
  closeIssueCardHtml,
  mergedRowHtml,
  feedHtml,
  kanbanHtml,
  listRowHtml,
  columnHtml,
  setCardNow,
  setAiEnabled,
  api: mod,
};
