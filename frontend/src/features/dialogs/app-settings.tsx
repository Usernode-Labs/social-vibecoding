import { useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { DialogCard, DialogRoot } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useHiddenClass } from '../../lib/legacy-dom';
import { useDialog } from './use-dialog';

// `delete_block` is the server's reason can_delete is false (routes/apps.js
// deleteBlockReason): 'core' for the platform's own app, 'shared' for a
// creator whose app has other contributors, 'not_owner' otherwise.
type AppSettings = {
  slug: string;
  name: string;
  can_delete: boolean;
  delete_block?: 'core' | 'shared' | 'not_owner' | null;
  contributor_count?: number;
};

// Copy for the blocked state, keyed by the server's reason. Plain text, no
// dashes: it is read aloud as the dialog's status line.
function blockedCopy(app: AppSettings) {
  if (app.delete_block === 'core') {
    return 'This is a core platform app. It cannot be deleted from the UI.';
  }
  if (app.delete_block === 'shared') {
    const others = Math.max(0, (app.contributor_count || 0) - 1);
    return `This app has ${others} other ${others === 1 ? 'contributor' : 'contributors'}, `
      + 'so no one person can delete it. Deleting a shared app needs the group\'s agreement.';
  }
  return 'You do not have permission to delete this app.';
}

export function AppSettingsDialog() {
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
      if (!response.ok) throw new Error(data.error || 'Could not load app settings.');
      if (current === generation.current) setApp(data.app);
    } catch (err) {
      if (current === generation.current) setError(err instanceof Error ? err.message : 'Could not load app settings.');
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }

  const dialog = useDialog<{ slug: string }>('appSettings', {
    onOpen: (payload) => {
      slug.current = payload?.slug || '';
      if (slug.current) void load(slug.current);
    },
    onClose: () => { ++generation.current; setApp(null); setConfirmation(''); setSharedAck(false); },
    canClose: () => !pending.current,
  });

  // Other contributors exist: the server will refuse a plain delete, so the
  // dialog asks for the acknowledgement up front and sends it along.
  const shared = !!app && (app.contributor_count || 0) > 1;
  const others = app ? Math.max(0, (app.contributor_count || 0) - 1) : 0;
  const armed = !!app?.can_delete && !!app?.name && confirmation === app.name && (!shared || sharedAck);

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
        throw new Error(data.error || 'Could not delete the app. Try again.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the app. Try again.');
      return;
    } finally {
      pending.current = false;
      setBusy(false);
    }
    dialog.close();
    window.App?.navigateHome?.();
    window.PlatformUI?.toast?.('App deleted for everyone.');
    // Refresh failure must not imply the completed deletion failed.
    Promise.resolve().then(() => window.Home?.load?.()).catch(() => {});
  }

  return <DialogRoot id="app-settings-modal" ref={dialog.rootRef} {...dialog.backdropProps}>
    <DialogCard size="sm">
      <h2 className="text-lg font-bold mb-2">App settings</h2>
      <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">{app?.name}</p>
      {loading ? <p role="status">Loading app settings…</p> : null}
      {error ? <p role="alert" className="text-sm text-red-600 dark:text-red-400 mb-4">{error}</p> : null}
      {!loading && !app && error ? <Button onClick={() => void load(slug.current)}>Retry</Button> : null}
      {app && !app.can_delete ? <p id="app-delete-blocked" role="status" className="text-sm mb-4">{blockedCopy(app)}</p> : null}
      <section ref={dangerRef} className="hidden border border-red-300 dark:border-red-800 rounded-lg p-4 mb-4">
        <h3 className="font-semibold text-red-700 dark:text-red-400 mb-2">Danger zone</h3>
        <p className="text-sm mb-4">{`Deleting ${app?.name || 'this app'} removes it for everyone, including its app data. This cannot be undone. It does not just remove the icon from your home page.`}</p>
        <form onSubmit={remove} className="space-y-3">
          <label htmlFor="app-delete-name" className="block text-sm">Type <strong>{app?.name}</strong> to confirm deletion.</label>
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
              {`This app has ${others} other ${others === 1 ? 'contributor' : 'contributors'} who have not agreed to this. `}
              Delete it anyway as a platform admin. They will be notified.
            </span>
          </label> : null}
          <Button type="submit" variant="destructive" ink="danger" disabled={busy || !armed}>
            {busy ? 'Deleting…' : 'Delete app for everyone'}
          </Button>
        </form>
      </section>
      <Button type="button" disabled={busy} onClick={() => dialog.close()}>Close</Button>
    </DialogCard>
  </DialogRoot>;
}
