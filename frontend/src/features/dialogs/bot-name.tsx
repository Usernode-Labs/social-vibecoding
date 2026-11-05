/**
 * #4942: Bot's name dialog (#bot-name-modal), from Settings & rules.
 *
 * What Homeroom bot calls itself in this project. Built like rename-app.tsx:
 * an uncontrolled field, and a proposal that goes to the group's vote and
 * applies once it merges. The server holds the rule for what a name may be
 * (services/app-manifest.js, services/project-bot-name.js) and its sentences
 * are what the error line shows, so the rule has one copy.
 */

import { useRef, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { DialogCard, DialogRoot } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

import { RichMessage, useMessages } from '../../lib/i18n/react';
import { useHiddenClass } from '../../lib/legacy-dom';
import { useDialog } from './use-dialog';

const MAX_BOT_NAME_LENGTH = 40;

function votedInName(appData: Record<string, unknown> | null | undefined): string {
  const snapshot = appData?.manifest_snapshot as { bot_name?: unknown } | null | undefined;
  return typeof snapshot?.bot_name === 'string' ? snapshot.bot_name : '';
}

export function BotNameDialog() {
  const t = useMessages('dialogs');
  const inputRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const [project, setProject] = useState('');
  const [currentName, setCurrentName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const dialog = useDialog<{ slug?: string }>('botName', {
    onOpen: () => {
      const appData = window.AppView?.appData;
      const name = votedInName(appData);
      setProject((appData?.name as string) || (appData?.slug as string) || '');
      setCurrentName(name || t('dialogs:botName.placeholder'));
      setError('');
      if (inputRef.current) inputRef.current.value = name;
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
    },
    onClose: () => {
      setError('');
      if (inputRef.current) inputRef.current.value = '';
    },
  });

  useHiddenClass(errorRef, !error);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const appView = window.AppView;
    const appData = appView?.appData;
    if (!appData) return;
    const next = (inputRef.current?.value || '').trim();

    if (next.length > MAX_BOT_NAME_LENGTH) return setError(t('dialogs:botName.error.tooLong'));
    if (next.toLowerCase() === votedInName(appData).toLowerCase()) return setError(t('dialogs:botName.error.same'));

    setBusy(true);
    try {
      const res = await fetch(`/api/apps/${appData.slug}/bot-name-pr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || t('dialogs:botName.error.failed'));
        return;
      }
      dialog.close();
      (appView?.refreshDevData as ((reason: string) => void) | undefined)?.('vote');
    } catch {
      setError(t('dialogs:botName.error.network'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogRoot
      id="bot-name-modal"
      ref={dialog.rootRef}
      {...dialog.backdropProps}
    >
      <DialogCard size="sm">
        <h2 className="text-lg font-bold mb-1">
          {t('dialogs:botName.title')}
        </h2>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">
          <RichMessage
            id="dialogs:botName.current"
            values={{ project, name: currentName }}
            components={[<span id="bot-name-current" className="font-mono text-zinc-500 dark:text-zinc-400" />]}
          />
        </p>
        <form id="bot-name-form" className="space-y-4" onSubmit={submit}>
          <div>
            <label
              htmlFor="bot-name-input"
              className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1"
            >
              {t('dialogs:botName.label')}
            </label>
            <Input
              id="bot-name-input"
              ref={inputRef}
              type="text"
              maxLength={MAX_BOT_NAME_LENGTH}
              autoComplete="off"
              box="dialog"
              hint="muted"
              ring="seamless"
              placeholder={t('dialogs:botName.placeholder')}
            />
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
              {t('dialogs:botName.hint')}
            </p>
          </div>
          <div id="bot-name-error" ref={errorRef} className="text-red-700 dark:text-red-400 text-sm hidden">
            {error}
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              id="bot-name-cancel"
              className="flex-1 rounded-lg bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-900 dark:text-zinc-100 transition-colors"
              onClick={() => dialog.close()}
            >
              {t('core:common.cancel')}
            </button>
            <Button
              type="submit"
              id="bot-name-submit"
              layout="flex"
              disabled={busy}
            >
              {busy ? t('dialogs:botName.submitting') : t('dialogs:botName.submit')}
            </Button>
          </div>
        </form>
      </DialogCard>
    </DialogRoot>
  );
}
