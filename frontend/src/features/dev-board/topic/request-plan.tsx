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

import { useMessages } from '../../../lib/i18n/react';
import { PlanCardView, type PlanCardState } from '../../messages/bot-plan-view';
import { WORK_CHANGED_EVENT } from '../../messages/bot-shared';
import type { HomeroomBotPlan } from '../../messages/types';
import { openRequestSpec, type RequestSpecCard } from './request-model';

/** What GET /api/apps/:slug/issues/:number/bot-plan answers (services/homeroom-bot-public-plan.js). */
export interface RequestBotPlan {
  runId: number;
  state: 'waiting' | 'building';
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
  if (plan.state !== 'waiting' && plan.state !== 'building') return null;
  return {
    ...plan,
    lines: Array.isArray(plan.lines) ? plan.lines.filter((l) => l && typeof l.text === 'string') : [],
    choices: Array.isArray(plan.choices) ? plan.choices : [],
  };
}

/** Pure: the card's state, from what the plan waits for. */
export function planCardState(plan: RequestBotPlan): PlanCardState {
  if (plan.state === 'building') return 'built';
  return plan.changing ? 'changing' : 'open';
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
  const sub = plan.mine
    ? t('project:topic.request.botPlan.subYours', { number: String(number) })
    : plan.requester
      ? t('project:topic.request.botPlan.subTheirs', { number: String(number), requester: plan.requester })
      : t('project:topic.request.botPlan.subAnyone', { number: String(number) });
  return (
    <div className="dev-request-plan" data-request-plan={planCardState(plan)}>
      <PlanCardView
        appName=""
        plan={view}
        state={planCardState(plan)}
        busy={busy}
        building={plan.state === 'building'}
        onBuild={(answers) => { void build(answers); }}
        onChange={change}
        surface="request"
        request={plan.title || ''}
        sub={sub}
        card={{ summary: plan.summary, lines: plan.lines }}
        readWhole={spec ? (
          <button type="button" className="dev-request-plan-read" data-request-plan-read="" onClick={() => { void openRequestSpec(spec); }}>
            <span>{t('project:topic.request.botPlan.readWhole')}</span>
            {plan.spec?.chars ? <small>{t('project:topic.request.botPlan.readLength', { chars: (Math.max(1, Math.round(plan.spec.chars / 1000)) * 1000).toLocaleString() })}</small> : null}
          </button>
        ) : null}
        footer={refused ? <p className="messages-bot-answered" role="status" data-request-plan-refused="">{t(refused)}</p> : null}
      />
    </div>
  );
}
