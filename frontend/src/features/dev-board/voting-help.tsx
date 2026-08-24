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
 * escaped. Every wording is carried over verbatim.
 */

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
  return (
    <>
      <div className="attr-pop-head">How voting &amp; merges work</div>
      {live ? (
        <div className="vh-live">
          <div className="vh-live-title">This proposal, right now</div>
          <div className="vh-live-body">{live}</div>
        </div>
      ) : null}
      <div className="vh-rules">
        <ul className="voting-help-rules">
          <li>
            Only people who’ve actually used the app recently count as voters. The
            number of Yes votes needed scales with how many active testers there are.
          </li>
          <li>
            {'A proposal with clear support and no objections merges on its own after a '
              + 'short visibility window (a few days), so everyone has a chance to look — '}
            <strong>silence counts as agreement</strong>
            .
          </li>
          <li>
            The more support a proposal has, the shorter the wait. A clear majority
            merges almost immediately; thin, unopposed support waits longer.
          </li>
          <li>
            <strong>No</strong>
            {' votes make a proposal harder to pass: they raise the number of Yes votes '
              + 'needed and lengthen the wait.'}
          </li>
          <li>
            {'If enough people vote No, the proposal becomes '}
            <strong>Contested</strong>
            {' — the time-based path turns off and it needs a straight majority of Yes '
              + 'votes to merge.'}
          </li>
          <li>
            A proposal that’s being voted down with little support is closed
            automatically after a countdown (“Rejecting in …”).
          </li>
          <li>
            {'Even after winning the vote, a proposal only merges once its '}
            <strong>automated checks pass</strong>
            {' and it’s '}
            <strong>up to date with the main app</strong>
            . Locked apps also need an admin’s Yes.
          </li>
          <li>
            {'Apps can customize these rules: restricting approvals to '}
            <strong>invited approvers</strong>
            {' (everyone else’s votes stay visible but advisory) and/or requiring a fixed '}
            <strong>“at least N approvals”</strong>
            {' instead of the timed majority system.'}
          </li>
        </ul>
      </div>
    </>
  );
}
