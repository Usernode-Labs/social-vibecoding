import { useRef, useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { DialogCard, DialogRoot } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { RichMessage, useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';
import { useHiddenClass } from '../../lib/legacy-dom';
import { useDialog } from './use-dialog';

// `delete_block` is the server's reason can_delete is false (routes/apps.js
// deleteBlockReason): 'core' for the platform's own app, 'shared' for a
// creator whose app has other contributors, 'not_owner' otherwise.
type AppSettings = {
  slug: string;
  name: string;
  repo_url?: string | null;
  self_hosted?: boolean;
  can_manage?: boolean;
  collab_visibility?: 'public' | 'private';
  view_visibility?: 'public' | 'private';
  can_delete: boolean;
  delete_block?: 'core' | 'shared' | 'not_owner' | null;
  contributor_count?: number;
  // Demo mode (routes/demo-mode.js): the creator has switched this app into
  // a recording mode where a synthetic partner proposes and votes. Marked
  // here so nobody who opens the settings mistakes those for a person's.
  demo_mode?: boolean;
  demo_partner?: string | null;
};

type AccessMode = 'public' | 'public-invite' | 'private';

function currentAccessMode(app: AppSettings): AccessMode {
  if (app.collab_visibility === 'public') return 'public';
  return app.view_visibility === 'private' ? 'private' : 'public-invite';
}

// #4666: who can see it, in the Who can see & change it sheet's words.
const ACCESS_NAMES: Record<AccessMode, string> = {
  public: 'dialogs:whoDecides.see.public',
  'public-invite': 'dialogs:whoDecides.see.limitedName',
  private: 'dialogs:whoDecides.see.private',
};

// Copy for the blocked state, keyed by the server's reason. Plain text, no
// dashes: it is read aloud as the dialog's status line.
function blockedCopy(app: AppSettings) {
  if (app.delete_block === 'core') {
    return translate('dialogs:appSettings.delete.blocked.core');
  }
  if (app.delete_block === 'shared') {
    const others = Math.max(0, (app.contributor_count || 0) - 1);
    return translate('dialogs:appSettings.delete.blocked.shared', { count: others });
  }
  return translate('dialogs:appSettings.delete.blocked.notOwner');
}

export function AppSettingsDialog() {
  const t = useMessages('dialogs');
  const [app, setApp] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState('');
  // #2161: a full admin deleting an app that has other contributors must
  // also tick the acknowledgement; the server refuses the request without it.
  const [sharedAck, setSharedAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const generation = useRef(0);
  const slug = useRef('');
  const dangerRef = useRef<HTMLElement>(null);
  useHiddenClass(dangerRef, !app?.can_delete);

  async function load(target: string) {
    const current = ++generation.current;
    setApp(null);
    setConfirmation('');
    setSharedAck(false);
    setError('');
    setLoading(true);
    try {
      const response = await fetch(`/api/apps/${encodeURIComponent(target)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t('dialogs:appSettings.error.load'));
      if (current === generation.current) setApp(data.app);
    } catch (err) {
      if (current === generation.current) setError(err instanceof Error ? err.message : t('dialogs:appSettings.error.load'));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }

  const dialog = useDialog<{ slug: string }>('appSettings', {
    onOpen: (payload) => {
      slug.current = payload?.slug || '';
      if (slug.current) void load(slug.current);
    },
    onClose: () => {
      ++generation.current;
      setApp(null);
      setConfirmation('');
      setSharedAck(false);
    },
    canClose: () => !pending.current,
  });

  // Other contributors exist: the server will refuse a plain delete, so the
  // dialog asks for the acknowledgement up front and sends it along.
  const shared = !!app && (app.contributor_count || 0) > 1;
  const others = app ? Math.max(0, (app.contributor_count || 0) - 1) : 0;
  const armed = !!app?.can_delete && !!app?.name && confirmation === app.name && (!shared || sharedAck);
  const currentAccess = app ? currentAccessMode(app) : 'public';

  async function remove(event: FormEvent) {
    event.preventDefault();
    if (pending.current || !app?.can_delete || !app.name || confirmation !== app.name) return;
    const isShared = (app.contributor_count || 0) > 1;
    if (isShared && !sharedAck) return;
    const target = app.slug;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/apps/${encodeURIComponent(target)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm_name: confirmation, acknowledge_shared: isShared && sharedAck }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || t('dialogs:appSettings.danger.error'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('dialogs:appSettings.danger.error'));
      return;
    } finally {
      pending.current = false;
      setBusy(false);
    }
    // The app is gone, so this goes Home, an address written in the same
    // task: a plain close would queue a history.back() that lands after it
    // and returns the viewer to the deleted app's page (#3683).
    dialog.closeForNavigation();
    window.App?.navigateHome?.();
    window.PlatformUI?.toast?.(t('dialogs:appSettings.danger.deleted'));
    // Refresh failure must not imply the completed deletion failed.
    Promise.resolve().then(() => window.Home?.load?.()).catch(() => {});
  }

  return <DialogRoot id="app-settings-modal" ref={dialog.rootRef} {...dialog.backdropProps}>
    <DialogCard size="sm">
      <h2 className="text-lg font-bold mb-1">{t('dialogs:appSettings.title')}</h2>
      <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">{app?.name}</p>
      {app?.demo_mode ? <Alert
        id="app-demo-mode-notice"
        role="status"
        variant="notice"
        density="compact"
        className="mb-4"
      >
        {/* One whole message per case: with or without the partner's name,
            with or without the approval rule. */}
        <RichMessage
          id={app.approvals_required != null
            ? (app.demo_partner ? 'dialogs:appSettings.demo.noticeApprovals' : 'dialogs:appSettings.demo.noticeUnnamedApprovals')
            : (app.demo_partner ? 'dialogs:appSettings.demo.notice' : 'dialogs:appSettings.demo.noticeUnnamed')}
          values={{ partner: app.demo_partner, count: app.approvals_required ?? undefined }}
          components={[<b />]}
        />
      </Alert> : null}
      {loading ? <p role="status" className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">{t('dialogs:appSettings.loading')}</p> : null}
      {error ? <p role="alert" className="text-sm text-red-700 dark:text-red-400 mb-4">{error}</p> : null}
      {!loading && !app && error ? <Button onClick={() => void load(slug.current)}>{t('core:common.retry')}</Button> : null}
      <section
        id="app-access-section"
        className={`mb-4 ${app?.can_manage && !app.self_hosted ? '' : 'hidden'}`}
      >
        <h3 className="font-semibold mb-1">{t('dialogs:appSettings.access.heading')}</h3>
        {/* #4666: who can see it and how its changes are approved are one
            sheet now (./who-decides.tsx), and one proposal. This says what
            it is today and opens it. */}
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-1">
          {t('dialogs:appSettings.access.now', { access: t(ACCESS_NAMES[currentAccess]) })}
        </p>
        {/* Private decides who can open it; every repository is public on
            GitHub (services/github.js createRepo), whichever is chosen. */}
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-3">
          {t('dialogs:appSettings.access.codePublic')}
        </p>
        <Button
          id="app-access-open"
          type="button"
          size="sm"
          onClick={() => {
            const target = app?.slug || slug.current;
            dialog.close();
            window.UsernodeReact?.dialogs?.whoDecides?.open({ slug: target });
          }}
        >
          {t('dialogs:appSettings.access.open')}
        </Button>
      </section>
      {app && !app.can_delete ? <p id="app-delete-blocked" role="status" className="text-sm mb-4">{blockedCopy(app)}</p> : null}
      <section ref={dangerRef} className="hidden border border-red-300 dark:border-red-800 rounded-lg p-4 mb-4">
        <h3 className="font-semibold text-red-700 dark:text-red-400 mb-2">{t('dialogs:appSettings.danger.heading')}</h3>
        <p className="text-sm mb-4">{app?.name ? t('dialogs:appSettings.danger.explanation.named', { app: app.name }) : t('dialogs:appSettings.danger.explanation.unnamed')}</p>
        <form onSubmit={remove} className="space-y-3">
          <label htmlFor="app-delete-name" className="block text-sm"><RichMessage id="dialogs:appSettings.danger.confirmLabel" values={{ app: app?.name }} components={[<strong />]} /></label>
          <Input id="app-delete-name" autoComplete="off" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} disabled={busy || !app?.can_delete} />
          {shared ? <label htmlFor="app-delete-shared-ack" className="flex items-start gap-2 cursor-pointer select-none text-sm">
            <input
              id="app-delete-shared-ack"
              type="checkbox"
              className="accent-red-600 w-4 h-4 mt-0.5"
              checked={sharedAck}
              onChange={(e) => setSharedAck(e.target.checked)}
              disabled={busy}
            />
            <span>
              {t('dialogs:appSettings.danger.sharedAck', { count: others })}
            </span>
          </label> : null}
          <Button type="submit" variant="destructive" ink="danger" disabled={busy || !armed}>
            {busy ? t('dialogs:appSettings.danger.deleting') : t('dialogs:appSettings.danger.submit')}
          </Button>
        </form>
      </section>
      {/* Close is a dismissal, not this dialog's primary act — the widget
          language's filled NEUTRAL pill, the same one #app-notifications-done
          and #members-close wear (#2442). */}
      <Button
        type="button"
        variant="neutral"
        ink="neutral"
        disabled={busy}
        onClick={() => dialog.close()}
      >{t('core:common.close')}</Button>
    </DialogCard>
  </DialogRoot>;
}
