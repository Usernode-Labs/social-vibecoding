/**
 * Reopen-issue dialog (#reopen-issue-modal).
 *
 * "Propose reopening issue #N" — opens a group vote; if it passes, the issue
 * is reopened here and on GitHub. The mirror of `close-issue.tsx`, and the
 * same shape: an optional reason box and a submit that POSTs a governance
 * proposal (#6000).
 *
 * The fields stay UNCONTROLLED (a ref, not `value`). React owns what the
 * shell left empty — the error line's text, the submit button's `disabled` —
 * and nothing else.
 */

import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

import { Button } from '@/components/ui/button';
import { DialogCard, DialogRoot } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';

import { RichMessage, useMessages } from '../../lib/i18n/react';
import { useHiddenClass } from '../../lib/legacy-dom';
import { useDialog } from './use-dialog';

export function ReopenIssueDialog() {
  const t = useMessages('dialogs');
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<number | string | null>(null);
  const [issueNumber, setIssueNumber] = useState<number | string>('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const dialog = useDialog<number | string>('reopenIssue', {
    onOpen: (payload) => {
      targetRef.current = payload ?? null;
      setIssueNumber(payload ?? '');
      setError('');
      if (reasonRef.current) reasonRef.current.value = '';
      setTimeout(() => reasonRef.current?.focus(), 0);
    },
    onClose: () => {
      targetRef.current = null;
      setError('');
      if (reasonRef.current) reasonRef.current.value = '';
    },
  });

  useHiddenClass(errorRef, !error);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const target = targetRef.current;
    const appView = window.AppView;
    const appData = appView?.appData;
    if (!target || !appData) return;
    const reason = (reasonRef.current?.value || '').trim();

    setBusy(true);
    try {
      const resp = await fetch(`/api/apps/${appData.slug}/issues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'reopen_issue',
          payload: { issueNumber: target, ...(reason ? { reason } : {}) },
        }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        setError(data.error || t('dialogs:reopenIssue.error.http', { status: resp.status }));
        return;
      }
    } catch (fetchErr) {
      setError(t('dialogs:reopenIssue.error.detail', { reason: (fetchErr as Error).message }));
      return;
    } finally {
      setBusy(false);
    }

    dialog.close();
    await (appView?._loadDevFeed as (() => Promise<void>) | undefined)?.();
    // Refresh the opened-topic card too (the issue row's button flips to
    // "Reopen proposed") — _loadDevFeed's repaint no-ops without #dev-feed.
    if (window.App?.currentSubTab === 'topic' && document.getElementById('gc-thread-head')) {
      (appView?._renderTopicHead as (() => void) | undefined)?.();
    }
  }

  // ⌘/Ctrl+Enter submits from the textarea, as the close dialog does.
  function onReasonKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    if (!busy) void submit();
  }

  return (
    <DialogRoot
      id="reopen-issue-modal"
      ref={dialog.rootRef}
      {...dialog.backdropProps}
    >
      <DialogCard size="sm">
        <h2 className="text-lg font-bold mb-1">
          <RichMessage
            id="dialogs:reopenIssue.title"
            values={{ number: issueNumber }}
            components={[<span id="reopen-issue-number" className="font-mono" />]}
          />
        </h2>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">
          {t('dialogs:reopenIssue.explanation')}
        </p>
        <form id="reopen-issue-form" className="space-y-4" onSubmit={submit}>
          <div>
            <label
              htmlFor="reopen-issue-reason"
              className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1"
            >
              <RichMessage id="dialogs:reopenIssue.reason.label" components={[<span className="font-normal" />]} />
            </label>
            <Textarea
              id="reopen-issue-reason"
              ref={reasonRef}
              rows={3}
              maxLength={2000}
              box="dialog"
              hint="muted"
              ring="seamless"
              placeholder={t('dialogs:reopenIssue.reason.placeholder')}
              onKeyDown={onReasonKeyDown}
            >
            </Textarea>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
              {t('dialogs:reopenIssue.reason.hint')}
            </p>
          </div>
          <div id="reopen-issue-error" ref={errorRef} className="text-red-700 dark:text-red-400 text-sm hidden">
            {error}
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              id="reopen-issue-cancel"
              className="flex-1 rounded-lg bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-900 dark:text-zinc-100 transition-colors"
              onClick={() => dialog.close()}
            >
              {t('core:common.cancel')}
            </button>
            <Button
              type="submit"
              id="reopen-issue-submit"
              layout="flex"
              disabled={busy}
            >
              {t('dialogs:reopenIssue.submit')}
            </Button>
          </div>
        </form>
      </DialogCard>
    </DialogRoot>
  );
}
