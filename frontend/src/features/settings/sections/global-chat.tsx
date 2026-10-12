import { useEffect, useId, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { SectionHeading } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

import { RichMessage, useMessages } from '../../../lib/i18n/react';
import { t as translate } from '../../../lib/i18n/runtime';
import * as api from '../../global-chat/api';
import { initializeGlobalChat } from '../../global-chat/store';
import type {
  GlobalChatModel,
  GlobalChatModelCatalog,
  GlobalChatProfile,
  GlobalChatUsage,
} from '../../global-chat/types';

type OverallAllowance = {
  configured: boolean;
  limitUsd?: number | null;
  remainingUsd?: number | null;
  spentUsd?: number | null;
  reset?: string | null;
};

function money(value: string | number | null | undefined) {
  if (value == null || value === '') return '—';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  return '$' + (amount < 0.01 && amount > 0 ? amount.toFixed(4) : amount.toFixed(2));
}

function price(model: GlobalChatModel) {
  const average = Number(model.averagePricePerMillion);
  if (Number.isFinite(average)) return translate('settings:globalChat.model.priceAverage', { price: money(average) });
  const input = Number(model.inputPricePerMillion);
  const output = Number(model.outputPricePerMillion);
  if (Number.isFinite(input) && Number.isFinite(output)) {
    return translate('settings:globalChat.model.priceInOut', { input: money(input), output: money(output) });
  }
  return '';
}

/** A model's line in the list: its name, whether it is the recommended one,
 *  and its price when one is known. Each combination is a whole message. */
function optionLabel(item: GlobalChatModel) {
  const model = item.name || item.id;
  const cost = price(item);
  if (item.isGlobalChatRecommended) {
    return cost
      ? translate('settings:globalChat.model.optionRecommendedPriced', { model, price: cost })
      : translate('settings:globalChat.model.optionRecommended', { model });
  }
  return cost ? translate('settings:globalChat.model.optionPriced', { model, price: cost }) : model;
}

export function GlobalChatSettingsEditor({ embedded = false }: { embedded?: boolean } = {}) {
  // Subscribed: the helpers above read the runtime's text, and this is the
  // component that shows it.
  const t = useMessages('settings');
  const instanceId = useId();
  const [profile, setProfile] = useState<GlobalChatProfile | null>(null);
  const [usage, setUsage] = useState<GlobalChatUsage | null>(null);
  const [overall, setOverall] = useState<OverallAllowance | null>(null);
  const [catalog, setCatalog] = useState<GlobalChatModelCatalog | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('low');
  const [cap, setCap] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingEnabled, setSavingEnabled] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const idPrefix = embedded ? `chat-global-chat-${instanceId}` : 'settings-global-chat';

  async function loadModels(nextEffort: string, refresh = false) {
    const next = await api.models(nextEffort, { refresh });
    setCatalog(next);
    setModel((current) => next.models.some((item) => item.id === current)
      ? current
      : next.recommendedModelId || next.models[0]?.id || '');
    return next;
  }

  async function load(refresh = false) {
    setLoading(true);
    setError('');
    try {
      const current = await api.profile();
      setProfile(current.profile);
      setUsage(current.usage);
      setEnabled(current.profile.enabled === true);
      setModel(current.profile.model);
      setEffort(current.profile.reasoningEffort || 'low');
      setCap(current.profile.spendCapUsd || '');
      const [nextCatalog, nextUsage] = await Promise.all([
        loadModels(current.profile.reasoningEffort || 'low', refresh),
        api.usage(),
      ]);
      setOverall(nextUsage.overallAllowance);
      setUsage(nextUsage.globalChat);
      if (!nextCatalog.models.some((item) => item.id === current.profile.model)) {
        setModel(nextCatalog.recommendedModelId || nextCatalog.models[0]?.id || '');
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('settings:globalChat.loadFailed'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const selected = useMemo(
    () => catalog?.models.find((item) => item.id === model) || null,
    [catalog, model],
  );

  async function changeEffort(next: string) {
    setEffort(next);
    setStatus('');
    setError('');
    try {
      await loadModels(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('settings:globalChat.modelsLoadFailed'));
    }
  }

  async function save() {
    if (!model) { setError(t('settings:globalChat.chooseModelFirst')); return; }
    setSaving(true);
    setStatus(t('settings:globalChat.saving'));
    setError('');
    try {
      const next = await api.saveProfile({
        model,
        reasoningEffort: effort,
        spendCapUsd: cap.trim() || null,
      });
      setProfile(next.profile);
      setUsage(next.usage);
      setEnabled(next.profile.enabled === true);
      setCap(next.profile.spendCapUsd || '');
      await initializeGlobalChat({ force: true });
      setStatus(t('settings:globalChat.saved'));
    } catch (reason) {
      setStatus('');
      setError(reason instanceof Error ? reason.message : t('settings:globalChat.saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function changeEnabled(nextEnabled: boolean) {
    const previous = enabled;
    setEnabled(nextEnabled);
    setSavingEnabled(true);
    setStatus(t('settings:globalChat.saving'));
    setError('');
    try {
      const next = await api.saveProfile({ enabled: nextEnabled });
      setProfile(next.profile);
      setUsage(next.usage);
      setEnabled(next.profile.enabled === true);
      await initializeGlobalChat({ force: true });
      setStatus(next.profile.enabled
        ? t('settings:globalChat.enabledNotice')
        : t('settings:globalChat.disabledNotice'));
    } catch (reason) {
      setEnabled(previous);
      setStatus('');
      setError(reason instanceof Error ? reason.message : t('settings:globalChat.toggleFailed'));
    } finally {
      setSavingEnabled(false);
    }
  }

  return (
    <div
      {...(embedded
        ? { 'data-global-chat-settings-editor': 'true' }
        : { 'data-settings-section': 'global-chat' })}
      className={embedded ? 'global-chat-settings-editor' : 'hidden'}
    >
      {!embedded ? (
        <SectionHeading title={<RichMessage id="settings:globalChat.title" components={[<span className="text-sm font-normal text-zinc-500" />]} />}>
          {t('settings:globalChat.intro')}
        </SectionHeading>
      ) : null}

      {loading ? <p className="text-sm text-zinc-500 dark:text-zinc-400 py-2">{t('core:common.loading')}</p> : null}
      {error ? <p role="alert" className="mb-3 text-sm text-red-700 dark:text-red-400">{error}</p> : null}

      {!loading && profile ? (
        <div className="mb-4 rounded-2xl bg-white dark:bg-zinc-900 px-4 py-3">
          <label className="flex items-start justify-between gap-4 cursor-pointer select-none" htmlFor={`${idPrefix}-enabled`}>
            <span>
              <span className="block text-sm font-medium text-zinc-900 dark:text-zinc-100">
                {t('settings:globalChat.enable.label')}
              </span>
              <span id={`${idPrefix}-enabled-description`} className="mt-1 block text-sm text-zinc-600 dark:text-zinc-400">
                {t('settings:globalChat.enable.description')}
              </span>
            </span>
            <Switch
              id={`${idPrefix}-enabled`}
              className="mt-0.5 shrink-0"
              checked={enabled}
              disabled={savingEnabled || saving}
              aria-describedby={`${idPrefix}-enabled-description`}
              onChange={(event) => void changeEnabled(event.target.checked)}
            />
          </label>
        </div>
      ) : null}

      {!loading && catalog && !catalog.configured ? (
        <div className="rounded-2xl bg-white dark:bg-zinc-900 px-4 py-3">
          <p className="text-sm text-zinc-700 dark:text-zinc-300">{t('settings:globalChat.needsKey.text')}</p>
          <Button
            className="mt-3"
            variant="pillNeutral"
            size="pill"
            ink="muted"
            onClick={() => { window.location.hash = '#settings/openrouter'; }}
          >
            {t('settings:globalChat.needsKey.open')}
          </Button>
        </div>
      ) : null}

      {!loading && catalog?.configured ? (
        <div className="space-y-4">
          <div>
            <Label className="mb-1" htmlFor={`${idPrefix}-model`}>{t('settings:globalChat.model.label')}</Label>
            <div className="flex items-stretch gap-2">
              <Select
                id={`${idPrefix}-model`}
                className="min-w-0 flex-1"
                value={model}
                onChange={(event) => setModel(event.target.value)}
              >
                {catalog.models.map((item) => (
                  <option key={item.id} value={item.id}>
                    {optionLabel(item)}
                  </option>
                ))}
              </Select>
              <button
                type="button"
                className="shrink-0 rounded-lg bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 px-3 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 disabled:opacity-50"
                disabled={loading}
                onClick={() => void load(true)}
              >
                {t('settings:globalChat.model.refresh')}
              </button>
            </div>
            {selected ? <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">{price(selected) ? t('settings:globalChat.model.selectedPriced', { modelId: selected.id, price: price(selected) }) : selected.id}</p> : null}
          </div>

          <div>
            <Label className="mb-1" htmlFor={`${idPrefix}-reasoning`}>{t('settings:globalChat.effort.label')}</Label>
            <Select
              id={`${idPrefix}-reasoning`}
              value={effort}
              onChange={(event) => void changeEffort(event.target.value)}
            >
              <option value="low">{t('settings:globalChat.effort.low')}</option>
              <option value="minimal">{t('settings:globalChat.effort.minimal')}</option>
              <option value="medium">{t('settings:globalChat.effort.medium')}</option>
              <option value="high">{t('settings:globalChat.effort.high')}</option>
              <option value="xhigh">{t('settings:globalChat.effort.xhigh')}</option>
            </Select>
          </div>

          <div>
            <Label className="mb-1" htmlFor={`${idPrefix}-cap`}>{t('settings:globalChat.cap.label')}</Label>
            <Input
              id={`${idPrefix}-cap`}
              inputMode="decimal"
              placeholder={t('settings:globalChat.cap.placeholder')}
              value={cap}
              onChange={(event) => setCap(event.target.value)}
            />
          </div>

          <div className="rounded-2xl bg-white dark:bg-zinc-900 px-4 py-3 text-sm">
            <div className="flex items-center justify-between gap-4">
              <span>{t('settings:globalChat.usage.thisMonth')}</span>
              <strong>{usage?.capUsd ? t('settings:globalChat.usage.spentOfCap', { spent: money(usage.spentUsd), cap: money(usage.capUsd) }) : money(usage?.spentUsd)}</strong>
            </div>
            <div className="mt-2 flex items-center justify-between gap-4 text-zinc-500 dark:text-zinc-400">
              <span>{t('settings:globalChat.usage.overallRemaining')}</span>
              <span>{overall?.configured ? money(overall.remainingUsd) : t('settings:globalChat.usage.unavailable')}</span>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="pillAccent" size="pill" disabled={saving || savingEnabled} onClick={() => void save()}>
              {saving ? t('settings:globalChat.saveBusy') : t('settings:globalChat.save')}
            </Button>
            <Button
              variant="pillNeutral"
              size="pill"
              ink="muted"
              onClick={() => { window.location.hash = '#settings/openrouter'; }}
            >
              {t('settings:globalChat.developmentSettings')}
            </Button>
          </div>
        </div>
      ) : null}

      {status ? <p role="status" className="mt-3 text-sm text-emerald-700 dark:text-emerald-400">{status}</p> : null}

      {profile ? (
        <p className="mt-4 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
          {t('settings:globalChat.footnote')}
        </p>
      ) : null}
    </div>
  );
}

export function GlobalChatSettingsSection() {
  return <GlobalChatSettingsEditor />;
}
