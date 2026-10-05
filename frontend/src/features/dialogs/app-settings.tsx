import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { RichMessage } from "../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
import { Message, Localized, message as catalogText } from "../../lib/i18n/react";
import { useRef, useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
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

const ACCESS_MODES: Array<{
  id: AccessMode;
  title: string;
  description: string;
  collabVisibility: 'public' | 'private';
  viewVisibility: 'public' | 'private';
}> = [
  {
    id: 'public',
    get title() { return tr("core:public_591935b1"); },
    get description() { return tr("core:everyone_can_use_and_build_this_app_f4adc90d"); },
    collabVisibility: 'public',
    viewVisibility: 'public',
  },
  {
    id: 'public-invite',
    get title() { return tr("core:public_invite_only_building_44efa122"); },
    get description() { return tr("core:everyone_can_use_it_only_collaborators_can_build_33372f28"); },
    collabVisibility: 'private',
    viewVisibility: 'public',
  },
  {
    id: 'private',
    get title() { return tr("core:private_c63eb672"); },
    get description() { return tr("core:only_collaborators_can_use_or_build_this_app_3601d476"); },
    collabVisibility: 'private',
    viewVisibility: 'private',
  },
];

function currentAccessMode(app: AppSettings): AccessMode {
  if (app.collab_visibility === 'public') return 'public';
  return app.view_visibility === 'private' ? 'private' : 'public-invite';
}

function visibilityForAccess(mode: AccessMode) {
  return ACCESS_MODES.find((item) => item.id === mode) || ACCESS_MODES[0];
}

// Copy for the blocked state, keyed by the server's reason. Plain text, no
// dashes: it is read aloud as the dialog's status line.
function blockedCopy(app: AppSettings) {
  if (app.delete_block === 'core') {
    return tr("core:this_is_a_core_platform_app_it_cannot_be_deleted_ddb27a0d");
  }
  if (app.delete_block === 'shared') {
    const others = Math.max(0, (app.contributor_count || 0) - 1);
    return tr("core:this_app_has_count_other_contributors_6c8bb438", { count: others })
      + tr("core:so_no_one_person_can_delete_it_deleting_a_shared_6a25cea5");
  }
  return tr("core:you_do_not_have_permission_to_delete_this_app_2963ba42");
}

export function AppSettingsDialog() {
  useUiLanguage();
  const [app, setApp] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [accessDraft, setAccessDraft] = useState<AccessMode>('public');
  const [accessMessage, setAccessMessage] = useState('');
  const [accessMessageIsError, setAccessMessageIsError] = useState(false);
  const [accessBusy, setAccessBusy] = useState(false);
  const [accessProposalOpen, setAccessProposalOpen] = useState(false);
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
    setAccessMessage('');
    setAccessMessageIsError(false);
    setAccessProposalOpen(false);
    setLoading(true);
    try {
      const response = await fetch(`/api/apps/${encodeURIComponent(target)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || tr("core:could_not_load_app_settings_a80c5033"));
      if (current === generation.current) {
        setApp(data.app);
        setAccessDraft(currentAccessMode(data.app));
      }
    } catch (err) {
      if (current === generation.current) setError(err instanceof Error ? err.message : tr("core:could_not_load_app_settings_a80c5033"));
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
      setAccessDraft('public');
      setAccessMessage('');
      setAccessMessageIsError(false);
      setAccessProposalOpen(false);
    },
    canClose: () => !pending.current,
  });

  // Other contributors exist: the server will refuse a plain delete, so the
  // dialog asks for the acknowledgement up front and sends it along.
  const shared = !!app && (app.contributor_count || 0) > 1;
  const others = app ? Math.max(0, (app.contributor_count || 0) - 1) : 0;
  const armed = !!app?.can_delete && !!app?.name && confirmation === app.name && (!shared || sharedAck);
  const currentAccess = app ? currentAccessMode(app) : 'public';
  const accessChanged = !!app && accessDraft !== currentAccess;

  async function proposeAccess() {
    if (pending.current || !app?.can_manage || app.self_hosted || !app.repo_url
        || !accessChanged || accessProposalOpen) return;
    const target = visibilityForAccess(accessDraft);
    pending.current = true;
    setAccessBusy(true);
    setAccessMessage('');
    setAccessMessageIsError(false);
    try {
      const response = await fetch(`/api/apps/${encodeURIComponent(app.slug)}/visibility-pr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          collabVisibility: target.collabVisibility,
          viewVisibility: target.viewVisibility,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 409) {
        setAccessProposalOpen(true);
        setAccessMessage(tr("core:a_visibility_change_is_already_waiting_for_appro_2be9fbc7"));
        return;
      }
      if (!response.ok) throw new Error(data.error || tr("core:could_not_open_the_visibility_proposal_858d929c"));
      setAccessProposalOpen(true);
      setAccessMessage(tr("core:proposal_opened_pr_value1_it_needs_the_group_s_v_3bc7798c", { value1: data.prNumber }));
    } catch (err) {
      setAccessMessageIsError(true);
      setAccessMessage(err instanceof Error ? err.message : tr("core:could_not_open_the_visibility_proposal_858d929c"));
    } finally {
      pending.current = false;
      setAccessBusy(false);
    }
  }

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
        throw new Error(data.error || tr("core:could_not_delete_the_app_try_again_71ccefce"));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : tr("core:could_not_delete_the_app_try_again_71ccefce"));
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
    window.PlatformUI?.toast?.(tr("core:app_deleted_for_everyone_3253a651"));
    // Refresh failure must not imply the completed deletion failed.
    Promise.resolve().then(() => window.Home?.load?.()).catch(() => {});
  }

  return <DialogRoot id="app-settings-modal" ref={dialog.rootRef} {...dialog.backdropProps}>
    <DialogCard size="sm">
      <h2 className="text-lg font-bold mb-1"><Message id="core:app_settings_d43fb8a9" /></h2>
      <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">{app?.name}</p>
      {app?.demo_mode ? <Alert
        id="app-demo-mode-notice"
        role="status"
        variant="notice"
        density="compact"
        className="mb-4"
      ><Message after={" "} id="core:this_app_is_in_demo_mode_proposals_and_votes_fro_47ec4b55" /><b>@<LocalizedValue render={() => (app.demo_partner || tr("core:its_demo_partner_3ced5b4b"))} /></b><Message before={" "} id="core:are_synthetic_the_app_s_creator_made_them_to_rec_dba4162f" />{app.approvals_required != null ? <Message id="core:demo_approval_rule" values={{ count: app.approvals_required }} /> : null}
      </Alert> : null}
      {loading ? <p role="status" className="text-sm text-zinc-500 dark:text-zinc-400 mb-4"><Message id="core:loading_app_settings_09f65a5f" /></p> : null}
      {error ? <p role="alert" className="text-sm text-red-700 dark:text-red-400 mb-4">{error}</p> : null}
      {!loading && !app && error ? <Button onClick={() => void load(slug.current)}><Message id="core:retry_942087cc" /></Button> : null}
      <section
        id="app-access-section"
        className={`mb-4 ${app?.can_manage && !app.self_hosted ? '' : 'hidden'}`}
      >
        <h3 className="font-semibold mb-1"><Message id="core:access_ec5ba0ab" /></h3>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-1"><Message id="core:choose_who_can_use_this_app_and_who_can_build_ch_147d2344" /></p>
        {/* Private decides who can open it; every repository is public on
            GitHub (services/github.js createRepo), whichever is chosen. */}
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-3"><Message id="core:the_code_is_public_on_github_either_way_0a8f9781" /></p>
        <Localized element={<div role="radiogroup" aria-label={catalogText("core:app_access_869903a4")} className="space-y-2">
          {ACCESS_MODES.map((mode) => {
            const selected = accessDraft === mode.id;
            const current = currentAccess === mode.id;
            return <button
              key={mode.id}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={accessBusy || accessProposalOpen || !app?.repo_url}
              onClick={() => {
                setAccessDraft(mode.id);
                setAccessMessage('');
                setAccessMessageIsError(false);
              }}
              className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${selected
                ? 'border-violet-600 bg-violet-50 dark:border-violet-500 dark:bg-violet-950/30'
                : 'border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800'}`}
            >
              <span className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium">{mode.title}</span>
                {current ? <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"><Message id="core:current_e0d1b682" /></span> : null}
              </span>
              <span className="mt-0.5 block text-xs text-zinc-500 dark:text-zinc-400">{mode.description}</span>
            </button>;
          })}
        </div>} messages={{"aria-label":"core:app_access_869903a4"}} />
        {!app?.repo_url ? <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400"><Message id="core:this_app_has_no_github_repository_so_its_access__dafbd77d" /></p> : <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400"><Message id="core:changing_access_opens_a_proposal_the_new_setting_a8d41738" /></p>}
        <p
          id="app-access-status"
          role={accessMessageIsError ? 'alert' : 'status'}
          className={`${accessMessage ? '' : 'hidden'} mt-3 text-sm ${accessMessageIsError ? 'text-red-700 dark:text-red-400' : 'text-zinc-600 dark:text-zinc-300'}`}
        >{accessMessage}</p>
        <Button
          id="app-access-propose"
          type="button"
          size="sm"
          className="mt-3"
          disabled={accessBusy || accessProposalOpen || !app?.repo_url || !accessChanged}
          onClick={() => void proposeAccess()}
        >
          <LocalizedValue render={() => (accessBusy ? tr("core:opening_proposal_d0be2372") : (accessProposalOpen ? tr("core:proposal_open_253ce65d") : tr("core:propose_access_change_8f98e342")))} />
        </Button>
      </section>
      {app && !app.can_delete ? <p id="app-delete-blocked" role="status" className="text-sm mb-4">{blockedCopy(app)}</p> : null}
      <section ref={dangerRef} className="hidden border border-red-300 dark:border-red-800 rounded-lg p-4 mb-4">
        <h3 className="font-semibold text-red-700 dark:text-red-400 mb-2"><Message id="core:danger_zone_fd8b8dae" /></h3>
        <p className="text-sm mb-4"><LocalizedValue render={() => (tr("core:deleting_value1_removes_it_for_everyone_includin_dc8a8c80", { value1: app?.name || tr("core:message_d2c823cf6649") }))} /></p>
        <form onSubmit={remove} className="space-y-3">
          <label htmlFor="app-delete-name" className="block text-sm"><RichMessage id="core:sentence_ffa48c7c9657" values={{ value1: app?.name }} components={[<strong />]} /></label>
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
              <LocalizedValue render={() => (tr("core:message_b5d60a191c03", { value1: others, count: others }))} /><Message id="core:delete_it_anyway_as_a_platform_admin_they_will_b_6cbf8e7a" /></span>
          </label> : null}
          <Button type="submit" variant="destructive" ink="danger" disabled={busy || !armed}>
            <LocalizedValue render={() => (busy ? tr("core:deleting_43b5894c") : tr("core:delete_app_for_everyone_69c1cc64"))} />
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
      ><Message id="core:close_7d9eb7ac" /></Button>
    </DialogCard>
  </DialogRoot>;
}
