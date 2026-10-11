/**
 * #4666: WHO SAYS YES, AS YOU INVITE PEOPLE.
 *
 * A new project starts on You or the group (src/services/create-options.js),
 * and while it is just its maker every preset behaves the same, so making a
 * project asks nothing. What it is worth knowing is said where it starts to
 * matter: the invite sheet (features/first-session/made.tsx) carries one line
 * above its buttons, in the words of the rule in force,
 *
 *   "People you invite can suggest changes to Swim Spots. A change goes live
 *    when you say yes, or when most of the group does."   Change
 *
 * and Change opens the four presets alone, with how each plays out, and the
 * reminder that it can be changed later on the project's page. Picking
 * another opens the change as a proposal, which goes live on its maker's yes
 * once its checks pass (a change to who decides; src/services/governance-rules.js).
 *
 * The sheet is drawn over the invite sheet through a portal on <body>: the
 * invite sheet slides on a transform, which would trap a fixed overlay inside
 * it.
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@/components/ui/button';
import { SectionHeader } from '@/components/ui/grouped-list';
import { ShieldCheckIcon, XIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';
import { reloadCommunity, useCommunity } from '../dev-board/workshop/community-card';
import { currentValue, presetName, presetOf, presetValue, type PresetKey } from './model';
import { PlaysOut, PresetTiles, type Viewer } from './parts';
import { proposeWhoDecides } from './propose';

const LINE_IDS: Record<PresetKey | 'own', string> = {
  you_or_the_group: 'onboarding:firstSession.invite.rule.you_or_the_group',
  two_yeses: 'onboarding:firstSession.invite.rule.two_yeses',
  open_floor: 'onboarding:firstSession.invite.rule.open_floor',
  group_vote: 'onboarding:firstSession.invite.rule.group_vote',
  own: 'onboarding:firstSession.invite.rule.own',
};

/** The invite sheet's line for a project's rule, as its maker reads it. */
export function inviteRuleLine(preset: PresetKey | null, name: string): string {
  return translate(LINE_IDS[preset || 'own'], { name });
}

function PresetsSheet({ name, now, viewer, onPick, onClose, busy, error }: {
  name: string;
  now: PresetKey | null;
  viewer: Viewer;
  onPick: (key: PresetKey) => void;
  onClose: () => void;
  busy: boolean;
  error: string;
}) {
  const t = useMessages('onboarding');
  const [picked, setPicked] = useState<PresetKey>(now || 'you_or_the_group');
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(r);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy]);
  const changed = picked !== now;
  return (
    <div className="fixed inset-0 z-[9002]" data-who-invite-presets="">
      <div aria-hidden="true" onClick={busy ? undefined : onClose}
        className={`absolute inset-0 bg-[color:var(--pane-scrim)] transition-opacity duration-200 ${shown ? 'opacity-100' : 'opacity-0'}`} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="who-invite-presets-title"
        className={`absolute inset-x-0 bottom-0 mx-auto max-h-[92%] max-w-lg overflow-y-auto rounded-t-[20px] bg-[color:var(--dc-sheet-solid)] px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-2 text-left transition-transform duration-200 ease-out ${shown ? 'translate-y-0' : 'translate-y-full'}`}
      >
        <div className="mx-auto h-1.5 w-10 rounded-full bg-zinc-300 dark:bg-zinc-700" aria-hidden="true" />
        <div className="mt-3 flex items-center gap-3">
          <h2 id="who-invite-presets-title" className="min-w-0 flex-1 text-[17px] font-semibold">{t('onboarding:firstSession.invite.rule.title')}</h2>
          <button type="button" onClick={onClose} disabled={busy} aria-label={t('onboarding:firstSession.invite.rule.close')}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            <XIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <p className="mt-1 text-[14px] text-zinc-500 dark:text-zinc-400">{t('onboarding:firstSession.invite.rule.intro', { name })}</p>
        <div className="mt-4">
          <PresetTiles picked={picked} now={now} viewer={viewer} onPick={setPicked} labelId="who-invite-presets-title" />
        </div>
        <SectionHeader className="px-1 pb-1.5 pt-4">{t('onboarding:firstSession.invite.rule.plays')}</SectionHeader>
        <PlaysOut preset={picked} viewer={viewer} />
        {error ? <p className="mt-3 px-1 text-[13px] text-red-700 dark:text-red-400" role="alert">{error}</p> : null}
        <Button type="button" layout="full" variant="pillAccent" size="pillLg" ink="solidLate" className="mt-4 flex items-center justify-center"
          data-who-invite-done="" disabled={busy}
          onClick={() => (changed ? onPick(picked) : onClose())}>
          {busy ? t('onboarding:firstSession.invite.rule.busy')
            : changed ? t('onboarding:firstSession.invite.rule.use', { preset: presetName(picked, viewer) })
              : t('onboarding:firstSession.invite.rule.done')}
        </Button>
        {changed ? <p className="mt-2 text-center text-[12.5px] text-zinc-500 dark:text-zinc-400">{t('onboarding:firstSession.invite.rule.useNote')}</p> : null}
      </div>
    </div>
  );
}

/**
 * The invite sheet's line and its Change. `me` is the maker's username (the
 * made screen is only ever its maker's). Draws nothing until the project's
 * rule is read.
 */
export function InviteRuleLine({ slug, name, me }: { slug: string; name: string; me: string }) {
  const t = useMessages('onboarding');
  const community = useCommunity(slug);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [proposed, setProposed] = useState<PresetKey | null>(null);
  if (!community || !community.approval) return null;
  const current = currentValue(community.approval);
  const now = presetOf(current);
  const viewer: Viewer = {
    isCreator: true,
    creator: me || community.approval.creator?.username || null,
    other: (community.members || []).map((m) => m.username).find((u) => u && u !== me) || translate('dialogs:whoDecides.someone'),
  };
  async function pick(key: PresetKey) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await proposeWhoDecides(slug, { governance: presetValue(key) });
      if (result.state === 'waiting') {
        setError(t('onboarding:firstSession.invite.rule.waiting'));
        return;
      }
      setProposed(key);
      setOpen(false);
      void reloadCommunity(slug);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('onboarding:firstSession.invite.rule.error'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <p data-who-invite-rule="" className="mt-3 flex items-start gap-2 px-1 text-[13px] leading-[1.4] text-zinc-600 dark:text-zinc-300">
        <ShieldCheckIcon className="mt-px h-4 w-4 shrink-0 text-zinc-500 dark:text-zinc-400" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          {inviteRuleLine(now, name)}
          {proposed ? (
            <span className="mt-1 block text-zinc-500 dark:text-zinc-400" data-who-invite-proposed="">
              {t('onboarding:firstSession.invite.rule.proposed', { preset: presetName(proposed, viewer) })}
            </span>
          ) : null}
        </span>
        <button type="button" onClick={() => { setError(''); setOpen(true); }} data-who-invite-change=""
          className="shrink-0 font-semibold text-violet-700 dark:text-violet-400">
          {t('onboarding:firstSession.invite.rule.change')}
        </button>
      </p>
      {open && typeof document !== 'undefined'
        ? createPortal(
          <PresetsSheet name={name} now={proposed || now} viewer={viewer} onPick={(key) => void pick(key)}
            onClose={() => setOpen(false)} busy={busy} error={error} />,
          document.body,
        )
        : null}
    </>
  );
}
