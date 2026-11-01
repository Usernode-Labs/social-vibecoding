/**
 * #5987: "Build it with your own Claude Code". Opened, it says what
 * happens, gives the "Open in Claude Code" link
 * (../../../lib/claude-code-link.ts: a prompt naming only this app and this
 * request, never the request's own words) and what the person needs for it
 * to work.
 *
 * Out of the way on purpose: the card's own button stays the page's one
 * primary action, and the request's discussion asked for this not to be
 * prominent. 31 Oct 2026: it is a row of the request's ⋯
 * (./request-head.tsx), which draws this under the request already open
 * (`startOpen`); folding it puts it away again (`onClose`).
 *
 * The hand-off status (GET /api/apps/:slug/dev-flow/status, the "Build with"
 * sheet's own) is read only once it is opened, never on load: it says
 * whether Homeroom can see the person's connector, and which fork to
 * preselect in Claude Code. Until it answers, or if it fails, the link
 * still works and leaves the repository to the person.
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { buttonVariants } from '@/components/ui/button';
import { CheckIcon } from '@/components/ui/icons';
import { useMessages } from '../../../lib/i18n/react';
import { claudeCodeLink, forkRepository } from '../../../lib/claude-code-link';
import { handoffStatus, type HandoffStatus } from '../../agent-session/api';

export function OwnAgentLink({ slug, number, initialStatus = null, startOpen = false, onClose }: {
  slug: string;
  number: number;
  /** Tests only: render as though the status had answered. */
  initialStatus?: HandoffStatus | null;
  /** Drawn open: the ⋯ row asked for it. */
  startOpen?: boolean;
  /** Folded again: the page puts it away. */
  onClose?: () => void;
}): ReactNode {
  const t = useMessages('project');
  const [open, setOpen] = useState(startOpen);
  const summary = useRef<HTMLElement | null>(null);
  // Opened from the ⋯, the keyboard follows it here.
  useEffect(() => { if (startOpen) summary.current?.focus({ preventScroll: false }); }, [startOpen]);
  const [status, setStatus] = useState<HandoffStatus | null>(initialStatus);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!open || !slug) return undefined;
    let live = true;
    handoffStatus(slug, null)
      .then((next) => { if (live) setStatus(next); })
      .catch(() => { /* the link works without it */ });
    return () => { live = false; };
  }, [open, slug, revision]);

  // Back from adding the connector in another tab: look again.
  useEffect(() => {
    if (!open) return undefined;
    const again = () => setRevision((n) => n + 1);
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [open]);

  const url = claudeCodeLink({ slug, number, repository: forkRepository(status) });
  if (!url) return null;
  const known = !!status;
  const connected = !!(status && status.connectors && Number(status.connectors.count) > 0);

  return (
    <details
      className="dev-request-own-agent"
      data-request-own-agent=""
      open={startOpen || undefined}
      onToggle={(event) => {
        const now = (event.currentTarget as HTMLDetailsElement).open;
        setOpen(now);
        if (!now && onClose) onClose();
      }}
    >
      <summary ref={summary} className="dev-request-own-agent-summary">{t('project:topic.request.ownAgent.summary')}</summary>
      <p className="dev-request-own-agent-lead">{t('project:topic.request.ownAgent.lead')}</p>
      <div className="dev-request-actions">
        <a
          className={buttonVariants({ layout: 'inlineBlock', variant: 'pillOnCard', size: 'sm', ink: 'neutral' })}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          data-request-claude-code=""
        >
          {t('project:topic.request.ownAgent.open')}
        </a>
      </div>
      <p className="dev-request-own-agent-needs-heading">{t('project:topic.request.ownAgent.needsHeading')}</p>
      <ul className="dev-request-own-agent-needs">
        <li>{t('project:topic.request.ownAgent.needs.plan')}</li>
        <li>{t('project:topic.request.ownAgent.needs.github')}</li>
        <li data-request-own-agent-connector={known ? (connected ? 'done' : 'todo') : 'unknown'}>
          {t('project:topic.request.ownAgent.needs.connector')}
          {connected ? (
            <>
              <CheckIcon className="dev-request-own-agent-check" aria-hidden="true" />
              <span className="sr-only">{t('project:topic.request.ownAgent.needs.done')}</span>
            </>
          ) : known ? (
            <a className="dev-request-own-agent-add" href="#settings/connectors">
              {t('project:topic.request.ownAgent.needs.connectorAdd')}
            </a>
          ) : null}
        </li>
      </ul>
    </details>
  );
}
