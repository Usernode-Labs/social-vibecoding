/**
 * THE PLAN, FOR THE PEOPLE WHO JOINED (#4074, decision G): the plan Homeroom
 * bot wrote for a project's first version, read only, while it waits for
 * the person who started the project. Their hub card's "See the plan"
 * (./hub-cards.tsx FirstVersionCard) opens it, as a page under the Hub the
 * way All items is a page under the Workshop: the band stays, Hub lit, and
 * the disc goes back to it.
 *
 * Only the person who started it answers, in their chat with Homeroom bot,
 * so nothing here answers: what the first version will do, and each of the
 * bot's questions with its suggested answer as plain text. Under it, who
 * decides, and the way to say something about it: the Discussion tab.
 *
 * The plan is the server's (GET /api/apps/:slug/community
 * `first_version.plan`, routes/apps.js sharedPlan), sent to a member who
 * did not start the project while it waits and, once its maker chose it,
 * while it is built and tested (#4396). It is the current
 * one: after Change something there is none until Homeroom bot has written
 * the new one. With none to show (it was built, or the reader is not a
 * member, it is ready) the page goes back to the Hub.
 *
 * Drawn here rather than with the chat's plan card (../../messages/
 * bot-plan-view.tsx), whose open state is all answers and buttons.
 */

import { useEffect, type ReactNode } from 'react';

import { GroupedList } from '@/components/ui/grouped-list';

import { PageBackButton } from './page-back';
import type { CommunityPayload } from './community-card';

/** Homeroom bot's face, as Messages draws it (../../messages/format.tsx). */
const BOT_AVATAR = '/brand/homeroom-mark.png';

/** "Step 3 of 7", or null without a step. */
export function planStep(step: number | null | undefined, of: number | null | undefined): { text: string } | null {
  const at = Number(step) || 0;
  const all = Number(of) || 0;
  if (at <= 0 || all <= 0 || at > all) return null;
  return { text: `Step ${at} of ${all}` };
}

/** The build lines of a plan its maker already chose (#4396): it is being built or tested. */
const CHOSEN_LINES = new Set(['building', 'testing']);

/**
 * Who answers it, in a sentence. Once its maker chose it (#4396: the plan
 * is read on while it is built and tested), who chose it, and what comes
 * after.
 */
export function decidesLine(creator: string | null | undefined, line?: string | null): string {
  if (line && CHOSEN_LINES.has(line)) {
    return `${creator || 'The person who started it'} chose this plan. Once it’s live, anyone here can suggest changes.`;
  }
  return creator ? `${creator} decides on this plan.` : 'The person who started it decides on this plan.';
}

/** The plan as members read it: what the first version will do, and each question with its suggested answer. */
export interface MemberPlan {
  bullets: string[];
  questions: Array<{ question: string; suggested?: string | null }>;
}

/**
 * The plan's lines, each a row of its own, and each of Homeroom bot's
 * questions a row too, the question small over its suggested answer. This
 * page draws them, and so does the App tab's plan sheet
 * (../../app-frame/waiting-card.tsx).
 */
export function PlanLines({ name, plan }: { name: string; plan: MemberPlan }): ReactNode {
  return (
    <>
      <GroupedList tone="plane" className="mx-0" role="list" aria-label={`Plan for ${name}`} data-ws-plan-lines="">
        {plan.bullets.map((bullet) => <div key={bullet} role="listitem" className="dev-ws-plan-row">{bullet}</div>)}
      </GroupedList>
      {plan.questions.length ? (
        <GroupedList tone="plane" className="mx-0" data-ws-plan-questions="">
          {plan.questions.map((q) => (
            <div key={q.question} className="dev-ws-plan-row dev-ws-plan-q">
              <p className="dev-ws-plan-qq">{q.question}</p>
              {q.suggested ? <p className="dev-ws-plan-qa" data-ws-plan-suggested="">{q.suggested}</p> : null}
            </div>
          ))}
        </GroupedList>
      ) : null}
    </>
  );
}

export function PlanPage({ name, data, onBack, onDiscussion }: {
  name: string;
  data: CommunityPayload | null;
  onBack: () => void;
  onDiscussion: () => void;
}): ReactNode {
  const fv = data?.first_version || null;
  const plan = fv?.plan && fv.plan.bullets && fv.plan.bullets.length ? fv.plan : null;
  // Nothing to read once the read has answered: back to the Hub.
  const gone = !!data && !plan;
  useEffect(() => {
    if (gone) onBack();
  }, [gone]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!fv || !plan) return null;
  const step = planStep(fv.step, fv.of);
  return (
    <section className="dev-ws-plan" data-ws-plan-page="">
      <div className="dev-ws-planhead">
        <PageBackButton label="Hub" onBack={onBack} data-ws-page-back="" />
        <img src={BOT_AVATAR} alt="" className="dev-ws-plan-bot" />
        <span className="dev-ws-plan-bot-name">
          Homeroom bot <span className="dev-ws-plan-ai">AI</span>
        </span>
      </div>
      {/* The 7 Oct plan card ruling (PR 6): the title first, then the step
          as one line under it, with no progress bar. The owner, 7 Oct, on
          this page: no bullets; each line of the plan is a row of its own,
          the way a grouped list draws rows, so it reads designed rather than
          pasted. Each of Homeroom bot's questions is a row too, the question
          small over its suggested answer. */}
      <div className="dev-ws-plan-head" data-ws-plan-card="">
        <h2 className="dev-ws-plan-title">{`My plan for ${name}`}</h2>
        {step ? <p className="dev-ws-plan-step" data-ws-plan-step="">{step.text}</p> : null}
      </div>
      <PlanLines name={name} plan={plan} />
      <div className="dev-ws-plan-foot">
        <p className="dev-ws-plan-who" data-ws-plan-who="">{decidesLine(fv.creator, fv.line)}</p>
        <button type="button" className="dev-ws-plan-talk un-touch-target" data-ws-plan-discussion="" onClick={onDiscussion}>
          Talk about it in #general
        </button>
      </div>
    </section>
  );
}
