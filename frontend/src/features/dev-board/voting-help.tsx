import { t as tr } from "../../lib/i18n/runtime";
import { RichMessage } from "../../lib/i18n/react";
import { Message } from "../../lib/i18n/react";
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
      <div className="attr-pop-head"><Message id="workshop:how_voting_merges_work_d4cc816d" /></div>
      {live ? (
        <div className="vh-live">
          <div className="vh-live-title"><Message id="workshop:this_proposal_right_now_0de6c6f8" /></div>
          <div className="vh-live-body">{live}</div>
        </div>
      ) : null}
      <div className="vh-rules">
        <ul className="voting-help-rules">
          <li><Message id="workshop:only_people_who_ve_actually_used_the_app_recentl_a7e043a1" /></li>
          <li>
            {tr("workshop:a_proposal_with_clear_support_and_no_objections__5551b6da")}
            <strong><Message id="workshop:quiet_is_taken_as_a_nod_a656745a" /></strong><Message id="workshop:so_speak_up_if_something_bothers_you_0fa50b4c" /></li>
          <li><Message id="workshop:the_more_support_a_proposal_has_the_shorter_the__34578a68" /></li>
          <li>
            <strong><Message id="workshop:no_1ea442a1" /></strong>
            {tr("workshop:votes_make_a_proposal_harder_to_pass_they_raise__54cfebd8")}
          </li>
          <li>
            <Message id="workshop:if_enough_people_vote_no_the_proposal_ac79c0de" />
            <strong><Message id="workshop:needs_a_conversation_27390ff5" /></strong>
            {tr("workshop:the_timer_turns_off_and_it_needs_a_straight_majo_850900b4")}
          </li>
          <li><Message id="workshop:a_proposal_with_more_no_than_yes_and_little_supp_3650e889" /></li>
          <li><RichMessage id="workshop:sentence_31913ee94403" components={[<strong />, <strong />]} /></li>
          <li><RichMessage id="workshop:sentence_ef713f900417" components={[<strong />, <strong />]} /></li>
        </ul>
      </div>
    </>
  );
}
