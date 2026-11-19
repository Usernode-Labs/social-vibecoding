/**
 * HOMEROOM BOT'S PLAN, ON ITS REQUEST'S PAGE, FOR EVERYONE (3 Nov 2026,
 * #6207/#6210; Evan: the plan card is shown to everyone reading the request,
 * and any member may start the build).
 *
 * A request's page is its thread: a ▷ Build it row on the Homeroom bot page
 * opens it, as a Vote or Decide row does, and the plan is decided here. The
 * card is the chat's plan card (../../messages/bot-plan-view.tsx
 * PlanCardView), in the layout of #6221: the plan's title once, who it
 * waits for under it, the plan's own summary and numbered lines (#6220),
 * Read the whole plan, then Build it and Change something with no note above
 * them.
 *
 *   - Build it (POST …/bot-plan/build): any member; a non-member's press
 *     meets the Join prompt (../../../lib/join-required.ts), and the
 *     presser's own week pays. It is off, and says why, while a change to
 *     the plan is on its way.
 *   - Change something: a public reply on the request, quoting the bot's post
 *     of this plan; the bot reads it as a change and posts the next plan here.
 *
 * The first render is empty (the prerender's, and a hydration's): the plan
 * is read in an effect.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { RichMessage, useMessages } from '../../../lib/i18n/react';
import { changeHref } from '../../../lib/change-href';
import { PlanCardView, type PlanCardState } from '../../messages/bot-plan-view';
import { WORK_CHANGED_EVENT } from '../../messages/bot-shared';
import { PlanCrops } from '../../messages/plan-crops';
import type { HomeroomBotPlan } from '../../messages/types';
import { openRequestSpec, type RequestSpecCard } from './request-model';

/** What GET /api/apps/:slug/issues/:number/bot-plan answers (services/homeroom-bot-public-plan.js). */
/** #6860: waiting for Build it, its build under way, or what became of it. */
export type RequestPlanState = 'waiting' | 'building' | 'built' | 'live' | 'stopped';
const PLAN_STATES: readonly string[] = ['waiting', 'building', 'built', 'live', 'stopped'];
/** What a stopped plan stopped by, in the words the page and the bot's page say (core:work.reason.*). */
export type RequestPlanReason = 'build_failed' | 'change_closed';

export interface RequestBotPlan {
  runId: number;
  state: RequestPlanState;
  /** For 'stopped': why it stopped, which is the line it draws. */
  reason: RequestPlanReason | null;
  /** For 'built' and 'live': the change it made, which the card names and opens. */
  change: { id: number; number: number | null } | null;
  title: string | null;
  summary: string;
  lines: Array<{ n: number | null; text: string }>;
  choices: Array<{ question: string; answers: string[] }>;
  spec: { sessionId: number; version: number | null; chars?: number | null } | null;
  postId: number | null;
  requester: string | null;
  mine: boolean;
  changing: boolean;
}

/** Pure: the plan as the read answered it, or null for anything else. */
export function planFromRead(body: unknown): RequestBotPlan | null {
  const plan = (body as { plan?: unknown } | null)?.plan as RequestBotPlan | null | undefined;
  if (!plan || typeof plan !== 'object' || !(Number(plan.runId) > 0)) return null;
  if (!PLAN_STATES.includes(plan.state)) return null;
  const change = plan.change && Number(plan.change.id) > 0
    ? { id: Number(plan.change.id), number: Number(plan.change.number) > 0 ? Number(plan.change.number) : null }
    : null;
  return {
    ...plan,
    change,
    reason: plan.reason === 'change_closed' ? 'change_closed' : plan.reason === 'build_failed' ? 'build_failed' : null,
    lines: Array.isArray(plan.lines) ? plan.lines.filter((l) => l && typeof l.text === 'string') : [],
    choices: Array.isArray(plan.choices) ? plan.choices : [],
  };
}

/** Pure: the card's state, from what the plan waits for. */
export function planCardState(plan: RequestBotPlan): PlanCardState {
  if (plan.state === 'building') return 'built';
  // #6860: a settled plan is drawn with its lines and what became of it,
  // and no Build it: the change was made, or the build stopped.
  if (plan.state !== 'waiting') return 'closed';
  return plan.changing ? 'changing' : 'open';
}

/**
 * Pure (#6860, 19 Nov 2026): the line a settled plan's card draws inside it,
 * once its build is over: the same words the rest of the request's page says
 * for it under the title ("Up for a vote", "Live", or why it stopped), and
 * never "Building it". It wraps, where the line under the title does not.
 * Null while the plan waits or builds, and when it has no line to draw.
 */
export function planSettledLineOf(plan: RequestBotPlan): { id: string } | null {
  if (plan.state === 'built') return { id: 'project:topic.request.botPlan.settled.vote' };
  if (plan.state === 'live') return { id: 'project:topic.request.botPlan.settled.live' };
  if (plan.state === 'stopped') {
    return { id: plan.reason === 'change_closed'
      ? 'project:topic.request.botPlan.settled.changeClosed'
      : 'project:topic.request.botPlan.settled.buildFailed' };
  }
  return null;
}

/**
 * Pure (#6280, 4 Nov 2026): the line under the plan's title, by what the
 * plan waits for. While it waits: who it waits for ("Plan for #N · waiting
 * for you"). Once Build it is pressed: "Plan for #N · building", never
 * "waiting for you". A settled plan says what became of it inside its card
 * (planSettledLineOf), so it has no line here.
 */
export function planSubOf(plan: RequestBotPlan, number: number): { id: string; values: Record<string, string> } | null {
  const values = { number: String(number) };
  if (plan.state === 'building') return { id: 'project:topic.request.botPlan.subBuilding', values };
  if (plan.state !== 'waiting') return null;
  if (plan.mine) return { id: 'project:topic.request.botPlan.subYours', values };
  if (plan.requester) return { id: 'project:topic.request.botPlan.subTheirs', values: { ...values, requester: plan.requester } };
  return { id: 'project:topic.request.botPlan.subAnyone', values };
}

/** What a refused Build it says, by the server's code. */
const REFUSALS: Record<string, string> = {
  plan_changing: 'project:topic.request.botPlan.refused.changing',
  allowance: 'project:topic.request.botPlan.refused.allowance',
  plan_gone: 'project:topic.request.botPlan.refused.gone',
};

export function RequestPlan({ slug, number, specs = [] }: { slug: string; number: number; specs?: readonly RequestSpecCard[] }): ReactNode {
  const t = useMessages('project');
  const [plan, setPlan] = useState<RequestBotPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const read = useCallback(async () => {
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/issues/${number}/bot-plan`, { credentials: 'same-origin' });
      setPlan(res.ok ? planFromRead(await res.json()) : null);
    } catch {
      /* offline: the page says what it can without it */
    }
  }, [slug, number]);
  useEffect(() => {
    if (!slug || !number) return undefined;
    void read();
    // A plan decided, replaced or changed elsewhere: read again.
    const again = () => { void read(); };
    window.addEventListener(WORK_CHANGED_EVENT, again);
    return () => window.removeEventListener(WORK_CHANGED_EVENT, again);
  }, [slug, number, read]);
  // #6221: the plan's HTML, for its fold-out of before-and-after crops.
  const specKey = plan?.spec?.version ? `${plan.spec.sessionId}/${plan.spec.version}` : '';
  const [specHtml, setSpecHtml] = useState<string | null>(null);
  useEffect(() => {
    setSpecHtml(null);
    if (!specKey) return undefined;
    let live = true;
    fetch(`/api/sessions/${specKey.split('/')[0]}/specs/${specKey.split('/')[1]}`, { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        const html = body?.spec?.content_html;
        if (live && typeof html === 'string' && html.trim()) setSpecHtml(html);
      })
      .catch(() => {});
    return () => { live = false; };
  }, [specKey]);
  if (!plan) return null;

  const build = async (answers: Array<string | null>) => {
    setBusy(true);
    setRefused(null);
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/issues/${number}/bot-plan/build`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: plan.runId, answers }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        setRefused(REFUSALS[body?.error || ''] || 'project:topic.request.botPlan.refused.other');
      }
    } catch {
      setRefused('project:topic.request.botPlan.refused.other');
    } finally {
      setBusy(false);
      await read();
    }
  };
  // Change something: a public reply on the request, quoting the bot's post
  // of this plan (public/js/group-chat.js setQuote), in the request's own
  // reply box. Without that post, the box alone.
  const change = () => {
    const chat = (window as any).GroupChat;
    if (plan.postId && chat?.setQuote) {
      chat.setQuote({ source: 'message', refMsgId: plan.postId, author: 'homeroom_bot', snippet: plan.title || t('project:topic.request.botPlan.quote') }, 'thread');
    }
    const input = document.getElementById('gc-thread-input') as HTMLTextAreaElement | null;
    input?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    input?.focus?.({ preventScroll: true });
  };
  const spec = plan.spec ? specs.find((card) => card.read.kind === 'shared'
    && card.read.sessionId === plan.spec!.sessionId && (!plan.spec!.version || card.read.version === plan.spec!.version)) || null : null;
  const view: HomeroomBotPlan = {
    bullets: plan.lines.map((line) => line.text),
    questions: plan.choices,
    complicated: true,
  } as HomeroomBotPlan;
  const sub = planSubOf(plan, number);
  const settled = planSettledLineOf(plan);
  return (
    <div className="dev-request-plan" data-request-plan={planCardState(plan)}>
      <PlanCardView
        appName=""
        plan={view}
        state={planCardState(plan)}
        busy={busy}
        building={plan.state === 'building'}
        // #6860: a settled card says what became of it, in the page's own words.
        settledLine={settled ? (
          <p className="messages-bot-answered" role="status" data-request-plan-settled="">{t(settled.id)}</p>
        ) : undefined}
        onBuild={(answers) => { void build(answers); }}
        onChange={change}
        surface="request"
        request={plan.title || ''}
        sub={sub ? t(sub.id, sub.values) : null}
        card={{ summary: plan.summary, lines: plan.lines }}
        planSpec={<PlanCrops html={specHtml} lines={plan.lines} />}
        readWhole={spec ? (
          <button type="button" className="dev-request-plan-read" data-request-plan-read="" onClick={() => { void openRequestSpec(spec); }}>
            {plan.spec?.chars ? (
              <RichMessage
                id="project:topic.request.botPlan.readWholeLength"
                values={{ chars: (Math.max(1, Math.round(plan.spec.chars / 1000)) * 1000).toLocaleString() }}
                components={[<span />, <small />]}
              />
            ) : <span>{t('project:topic.request.botPlan.readWhole')}</span>}
          </button>
        ) : null}
        footer={plan.change || refused ? (
          <>
            {plan.change ? (
              <a
                className="mt-1 inline-flex h-9 items-center text-[0.9375rem] font-medium text-violet-700 hover:underline dark:text-violet-300"
                href={changeHref(slug, plan.change.id, plan.change.number)}
                data-request-plan-change=""
              >
                {plan.change.number
                  ? t('project:topic.request.botPlan.change', { number: String(plan.change.number) })
                  : t('project:topic.request.botPlan.changeUnnumbered')}
              </a>
            ) : null}
            {refused ? <p className="messages-bot-answered" role="status" data-request-plan-refused="">{t(refused)}</p> : null}
          </>
        ) : null}
      />
    </div>
  );
}
