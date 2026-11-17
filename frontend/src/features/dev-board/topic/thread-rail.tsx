/**
 * "How it got here", drawn: a thread's big events down a line, the last of
 * them where it stands now (./rail-model.ts). A request's page and a
 * change's own page portal it into `#gc-thread-rail`, the empty host the
 * thread's shell renders between the root post and the replies
 * (group-chat/thread-shell.tsx); app.css stands that host beside the card on
 * a wide page and leaves it between the card and the replies on a narrow
 * one ("THE THREAD'S RAIL").
 *
 * On a narrow page the earlier steps fold into a pile of their markers on
 * the line, the newest on top, with one link that opens them. Whether the
 * pile shows is app.css's decision (the page's width); whether it is open is
 * this component's state.
 *
 * A step's link opens what the page already has: the request's words and a
 * plan in the reader beside the thread, a change's failed tests in its
 * details, a competing change's own section. The page passes `onOpen`.
 */

import { useState, type ReactNode } from 'react';

import {
  ArrowPathIcon, BallotIcon, BoltIcon, CameraIcon, ChatIcon, CheckIcon, CheckLongIcon, ChevronUpIcon,
  ClockIcon, CodeIcon, DescriptionIcon, NoSymbolIcon, WarningTriangleIcon, XIcon,
} from '@/components/ui/icons';

import { useMessages } from '../../../lib/i18n/react';
import { messageStamp, shortDate } from '../../../lib/timestamp';
import type { Phrase } from '../../../lib/work-state';
import { earlierSteps, railFolds, type RailIcon, type RailOpen, type RailStep } from './rail-model';

/** How far each marker in the folded pile sits below the one before it. */
const PILE_PITCH = 8;
const MARK = 26;

const ICONS: Record<RailIcon, (props: { className?: string; 'aria-hidden'?: boolean | 'true' }) => ReactNode> = {
  asked: ChatIcon,
  plan: DescriptionIcon,
  built: CodeIcon,
  tested: CheckIcon,
  failed: XIcon,
  vote: BallotIcon,
  approved: CheckLongIcon,
  live: BoltIcon,
  closed: NoSymbolIcon,
  stopped: WarningTriangleIcon,
  working: ArrowPathIcon,
  waiting: ClockIcon,
  shots: CameraIcon,
};

function Mark({ step, bare = false }: { step: RailStep; bare?: boolean }): ReactNode {
  const Icon = ICONS[step.icon] || CheckIcon;
  return (
    <span className="dev-rail-mark" data-rail-tone={step.tone || undefined} data-rail-busy={step.busy ? '' : undefined} aria-hidden="true">
      {bare ? null : <Icon className="dev-rail-glyph" aria-hidden="true" />}
    </span>
  );
}

export function ThreadRail({ steps, onOpen }: { steps: RailStep[]; onOpen: (open: RailOpen) => void }): ReactNode {
  const t = useMessages('project');
  const [open, setOpen] = useState(false);
  const say = (p: Phrase | string) => (typeof p === 'string' ? p : t(p.id, p.values));
  if (!steps.length) return null;
  const early = earlierSteps(steps);
  const folds = railFolds(steps);
  return (
    <section className="dev-rail" data-thread-rail={steps.length} data-rail-fold={folds ? (open ? 'open' : 'shut') : undefined} aria-label={t('project:topic.rail.title')}>
      <div className="dev-rail-head">
        <h2 className="dev-rail-title">{t('project:topic.rail.title')}</h2>
        {folds ? (
          <button type="button" className="dev-rail-less" aria-expanded="true" onClick={() => setOpen(false)}>
            {t('project:topic.rail.showLess')}
            <ChevronUpIcon className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {folds ? (
        <button type="button" className="dev-rail-pile" data-rail-pile={early.length} aria-expanded="false" onClick={() => setOpen(true)}>
          <span className="dev-rail-pile-marks" style={{ height: `${MARK + (early.length - 1) * PILE_PITCH}px` }}>
            {early.map((s, i) => (
              <span key={s.key} className="dev-rail-pile-mark" style={{ top: `${i * PILE_PITCH}px`, zIndex: i + 1 }}>
                <Mark step={s} bare={i < early.length - 1} />
              </span>
            ))}
          </span>
          <span className="dev-rail-pile-more">{t('project:topic.rail.showEarlier', { count: early.length })}</span>
        </button>
      ) : null}
      <ol className="dev-rail-steps">
        {steps.map((s) => {
          const stamp = s.at ? messageStamp(s.at) : null;
          const when = !stamp ? '' : s.since ? t('project:topic.rail.since', { when: shortDate(s.at) }) : stamp.text;
          return (
            <li key={s.key} className="dev-rail-step" data-rail-step={s.key} data-rail-now={s.now ? '' : undefined} data-rail-tone={s.tone || undefined}>
              <Mark step={s} />
              <div className="dev-rail-body">
                <div className="dev-rail-line">
                  <span className="dev-rail-name">{say(s.title)}</span>
                  {when ? <time className="dev-rail-time" dateTime={s.at || undefined} title={stamp?.title}>{when}</time> : null}
                </div>
                {s.desc || s.link ? (
                  <p className="dev-rail-desc">
                    {s.desc ? <span>{say(s.desc)}</span> : null}
                    {s.desc && s.link ? ' ' : null}
                    {s.link ? (
                      <button type="button" className="dev-rail-link" data-rail-open={s.link.open.kind} onClick={() => onOpen(s.link!.open)}>
                        {say(s.link.label)}
                      </button>
                    ) : null}
                  </p>
                ) : null}
                {s.note ? <p className="dev-rail-note">{say(s.note)}</p> : null}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
