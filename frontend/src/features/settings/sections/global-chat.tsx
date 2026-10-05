import { useMessages as useUiLanguage } from "../../../lib/i18n/react";
import { RichMessage } from "../../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../../lib/i18n/react";
import { t as tr } from "../../../lib/i18n/runtime";
import { Message, Localized, message as catalogText } from "../../../lib/i18n/react";
import { useEffect, useId, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { SectionHeading } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

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
  if (Number.isFinite(average)) return money(average) + '/M avg';
  const input = Number(model.inputPricePerMillion);
  const output = Number(model.outputPricePerMillion);
  if (Number.isFinite(input) && Number.isFinite(output)) {
    return money(input) + ' in · ' + money(output) + ' out /M';
  }
  return '';
}

export function GlobalChatSettingsEditor({ embedded = false }: { embedded?: boolean } = {}) {
  useUiLanguage();
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
      setError(reason instanceof Error ? reason.message : tr("settings:global_chat_settings_could_not_be_loaded_b1ed417a"));
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
      setError(reason instanceof Error ? reason.message : tr("settings:compatible_models_could_not_be_loaded_e7d3d9ee"));
    }
  }

  async function save() {
    if (!model) { setError(tr("settings:choose_a_compatible_model_first_83918e8c")); return; }
    setSaving(true);
    setStatus(tr("settings:saving_23e39291"));
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
      setStatus(tr("settings:global_chat_settings_saved_3fb24140"));
    } catch (reason) {
      setStatus('');
      setError(reason instanceof Error ? reason.message : tr("settings:global_chat_settings_could_not_be_saved_269bb313"));
    } finally {
      setSaving(false);
    }
  }

  async function changeEnabled(nextEnabled: boolean) {
    const previous = enabled;
    setEnabled(nextEnabled);
    setSavingEnabled(true);
    setStatus(tr("settings:saving_23e39291"));
    setError('');
    try {
      const next = await api.saveProfile({ enabled: nextEnabled });
      setProfile(next.profile);
      setUsage(next.usage);
      setEnabled(next.profile.enabled === true);
      await initializeGlobalChat({ force: true });
      setStatus(next.profile.enabled
        ? tr("settings:experimental_global_chat_enabled_48d8e666")
        : tr("settings:experimental_global_chat_disabled_f7df9614"));
    } catch (reason) {
      setEnabled(previous);
      setStatus('');
      setError(reason instanceof Error ? reason.message : tr("settings:global_chat_could_not_be_updated_b4b1a660"));
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
        <SectionHeading title={<><RichMessage id="settings:sentence_abba10de894a" components={[<span className="text-sm font-normal text-zinc-500" />]} /></>}><Message id="settings:fast_low_cost_ai_for_navigating_and_using_homero_6284220e" /></SectionHeading>
      ) : null}

      {loading ? <p className="text-sm text-zinc-500 dark:text-zinc-400 py-2"><Message id="settings:loading_ba3bbbe1" /></p> : null}
      {error ? <p role="alert" className="mb-3 text-sm text-red-700 dark:text-red-400">{error}</p> : null}

      {!loading && profile ? (
        <div className="mb-4 rounded-2xl bg-white dark:bg-zinc-900 px-4 py-3">
          <label className="flex items-start justify-between gap-4 cursor-pointer select-none" htmlFor={`${idPrefix}-enabled`}>
            <span>
              <span className="block text-sm font-medium text-zinc-900 dark:text-zinc-100"><Message id="settings:enable_experimental_global_chat_f6baece4" /></span>
              <span id={`${idPrefix}-enabled-description`} className="mt-1 block text-sm text-zinc-600 dark:text-zinc-400"><Message id="settings:show_your_global_chat_conversations_in_messages__147d8909" /></span>
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
          <p className="text-sm text-zinc-700 dark:text-zinc-300"><Message id="settings:add_or_claim_an_openrouter_key_before_choosing_a_f9534947" /></p>
          <Button
            className="mt-3"
            variant="pillNeutral"
            size="pill"
            ink="muted"
            onClick={() => { window.location.hash = '#settings/openrouter'; }}
          ><Message id="settings:open_openrouter_settings_43a49afc" /></Button>
        </div>
      ) : null}

      {!loading && catalog?.configured ? (
        <div className="space-y-4">
          <div>
            <Label className="mb-1" htmlFor={`${idPrefix}-model`}><Message id="settings:global_chat_model_0f65a60c" /></Label>
            <div className="flex items-stretch gap-2">
              <Select
                id={`${idPrefix}-model`}
                className="min-w-0 flex-1"
                value={model}
                onChange={(event) => setModel(event.target.value)}
              >
                {catalog.models.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name || item.id}<LocalizedValue render={() => (item.isGlobalChatRecommended ? tr("settings:recommended_a71fecca") : '')} />{price(item) ? ' · ' + price(item) : ''}
                  </option>
                ))}
              </Select>
              <button
                type="button"
                className="shrink-0 rounded-lg bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 px-3 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 disabled:opacity-50"
                disabled={loading}
                onClick={() => void load(true)}
              ><Message id="settings:refresh_0e916101" /></button>
            </div>
            {selected ? <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">{selected.id}{price(selected) ? ' · ' + price(selected) : ''}</p> : null}
          </div>

          <div>
            <Label className="mb-1" htmlFor={`${idPrefix}-reasoning`}><Message id="settings:reasoning_effort_3236aeec" /></Label>
            <Select
              id={`${idPrefix}-reasoning`}
              value={effort}
              onChange={(event) => void changeEffort(event.target.value)}
            >
              <option value="low"><Message id="settings:low_recommended_for_glm_flash_0ff85ed6" /></option>
              <option value="minimal"><Message id="settings:minimal_only_for_supported_models_a81c4df1" /></option>
              <option value="medium"><Message id="settings:medium_8e588cd1" /></option>
              <option value="high"><Message id="settings:high_c4ebc6d4" /></option>
              <option value="xhigh"><Message id="settings:extra_high_70eb321d" /></option>
            </Select>
          </div>

          <div>
            <Label className="mb-1" htmlFor={`${idPrefix}-cap`}><Message id="settings:monthly_chat_cap_in_usd_optional_9b91ea19" /></Label>
            <Localized element={<Input
              id={`${idPrefix}-cap`}
              inputMode="decimal" placeholder={catalogText("settings:no_separate_cap_7f5111c6")}
              value={cap}
              onChange={(event) => setCap(event.target.value)}
            />} messages={{"placeholder":"settings:no_separate_cap_7f5111c6"}} />
          </div>

          <div className="rounded-2xl bg-white dark:bg-zinc-900 px-4 py-3 text-sm">
            <div className="flex items-center justify-between gap-4">
              <span><Message id="settings:global_chat_this_month_1fe52400" /></span>
              <strong>{money(usage?.spentUsd)}{usage?.capUsd ? ' / ' + money(usage.capUsd) : ''}</strong>
            </div>
            <div className="mt-2 flex items-center justify-between gap-4 text-zinc-500 dark:text-zinc-400">
              <span><Message id="settings:overall_openrouter_remaining_11be62ab" /></span>
              <span><LocalizedValue render={() => (overall?.configured ? money(overall.remainingUsd) : tr("settings:unavailable_ca184496"))} /></span>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="pillAccent" size="pill" disabled={saving || savingEnabled} onClick={() => void save()}>
              <LocalizedValue render={() => (saving ? tr("settings:saving_23e39291") : tr("settings:save_global_chat_settings_604bc432"))} />
            </Button>
            <Button
              variant="pillNeutral"
              size="pill"
              ink="muted"
              onClick={() => { window.location.hash = '#settings/openrouter'; }}
            ><Message id="settings:development_ai_settings_f0ae8065" /></Button>
          </div>
        </div>
      ) : null}

      {status ? <p role="status" className="mt-3 text-sm text-emerald-700 dark:text-emerald-400">{status}</p> : null}

      {profile ? (
        <p className="mt-4 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400"><Message id="settings:classic_is_always_the_startup_mode_this_profile__221f905c" /></p>
      ) : null}
    </div>
  );
}

export function GlobalChatSettingsSection() {
  return <GlobalChatSettingsEditor />;
}
