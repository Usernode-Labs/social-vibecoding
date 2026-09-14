import { useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { DialogCard, DialogRoot } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useHiddenClass } from '../../lib/legacy-dom';
import { useDialog } from './use-dialog';

type AppSettings = { slug: string; name: string; can_delete: boolean };

export function AppSettingsDialog() {
  const [app, setApp] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState('');
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
    onClose: () => { ++generation.current; setApp(null); setConfirmation(''); },
    canClose: () => !pending.current,
  });

  async function remove(event: FormEvent) {
    event.preventDefault();
    if (pending.current || !app?.can_delete || !app.name || confirmation !== app.name) return;
    const target = app.slug;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/apps/${encodeURIComponent(target)}`, { method: 'DELETE' });
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
      {app && !app.can_delete ? <p className="text-sm mb-4">You do not have permission to delete this app.</p> : null}
      <section ref={dangerRef} className="hidden border border-red-300 dark:border-red-800 rounded-lg p-4 mb-4">
        <h3 className="font-semibold text-red-700 dark:text-red-400 mb-2">Danger zone</h3>
        <p className="text-sm mb-4">{`Deleting ${app?.name || 'this app'} removes it for everyone, including its app data. This cannot be undone. It does not just remove the icon from your home page.`}</p>
        <form onSubmit={remove} className="space-y-3">
          <label htmlFor="app-delete-name" className="block text-sm">Type <strong>{app?.name}</strong> to confirm deletion.</label>
          <Input id="app-delete-name" autoComplete="off" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} disabled={busy || !app?.can_delete} />
          <Button type="submit" variant="destructive" ink="danger" disabled={busy || !app?.can_delete || !app.name || confirmation !== app.name}>
            {busy ? 'Deleting…' : 'Delete app for everyone'}
          </Button>
        </form>
      </section>
      <Button type="button" disabled={busy} onClick={() => dialog.close()}>Close</Button>
    </DialogCard>
  </DialogRoot>;
}
