/**
 * "How voting & merges work" — the read-only popover the `?` button and the
 * inline "How voting works" link open — as the only React writer below
 * `#voting-help-popover`.
 *
 * ── Props, not a store ────────────────────────────────────────────────
 *
 * The live line is computed once, from the proposal in view, at the moment the
 * popover opens; the rules below it never change at all. There is nothing to
 * publish into, so the props ARE the publish and the whole thing arrives on the
 * portal node.
 *
 * ── The host is the module's ──────────────────────────────────────────
 *
 * app-view.js creates the element, measures the anchor, picks a side by
 * whichever has more room, caps the height to that side's space so the body
 * scrolls internally rather than spilling past the viewport, and removes the
 * node on close. All geometry, none of it markup.
 *
 * ── The rules are prose, and that is why they are here ────────────────
 *
 * They were an HTML string constant (`_VOTING_HELP_RULES_HTML`) with `<strong>`
 * runs inside it. Prose with emphasis is exactly what JSX is better at than a
 * concatenated string, and it is the one part of this popover a reader is
 * likely to edit — so it lives where the emphasis is legible rather than
 * escaped. Every wording is carried over verbatim. The sentences are catalog
 * entries now (`project:votingHelp.rule.*`), each whole, with its emphasis as
 * numbered tags.
 */

import { RichMessage, useMessages } from '../../lib/i18n/react';

export interface VotingHelpProps {
  /**
   * `AppView._votingHelpText(pr)` — the "This proposal, right now" sentence,
   * or '' when there is no row. It stays in the module: it reads the
   * serialized gate fields so the wording never contradicts the tally pill
   * beside it, and tests/explicit-approval-vote-panel.test.js pins it.
   */
  live: string;
}

export function VotingHelp({ live }: VotingHelpProps) {
  const t = useMessages('project');
  return (
    <>
      <div className="attr-pop-head">{t('project:votingHelp.title')}</div>
      {live ? (
        <div className="vh-live">
          <div className="vh-live-title">{t('project:votingHelp.liveTitle')}</div>
          <div className="vh-live-body">{live}</div>
        </div>
      ) : null}
      <div className="vh-rules">
        <ul className="voting-help-rules">
          <li>{t('project:votingHelp.rule.voters')}</li>
          <li><RichMessage id="project:votingHelp.rule.quiet" components={[<strong />]} /></li>
          <li>{t('project:votingHelp.rule.support')}</li>
          <li><RichMessage id="project:votingHelp.rule.no" components={[<strong />]} /></li>
          <li><RichMessage id="project:votingHelp.rule.conversation" components={[<strong />]} /></li>
          <li>{t('project:votingHelp.rule.setAside')}</li>
          <li><RichMessage id="project:votingHelp.rule.checks" components={[<strong />, <strong />]} /></li>
          <li><RichMessage id="project:votingHelp.rule.custom" components={[<strong />, <strong />]} /></li>
        </ul>
      </div>
    </>
  );
}
