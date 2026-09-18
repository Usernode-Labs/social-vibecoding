import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { SectionHeading } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

import * as api from '../../global-chat/api';
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

export function GlobalChatSettingsSection() {
  const [profile, setProfile] = useState<GlobalChatProfile | null>(null);
  const [usage, setUsage] = useState<GlobalChatUsage | null>(null);
  const [overall, setOverall] = useState<OverallAllowance | null>(null);
  const [catalog, setCatalog] = useState<GlobalChatModelCatalog | null>(null);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('low');
  const [cap, setCap] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

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
      setError(reason instanceof Error ? reason.message : 'Global Chat settings could not be loaded.');
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
      setError(reason instanceof Error ? reason.message : 'Compatible models could not be loaded.');
    }
  }

  async function save() {
    if (!model) { setError('Choose a compatible model first.'); return; }
    setSaving(true);
    setStatus('Saving…');
    setError('');
    try {
      const next = await api.saveProfile({
        model,
        reasoningEffort: effort,
        spendCapUsd: cap.trim() || null,
      });
      setProfile(next.profile);
      setUsage(next.usage);
      setCap(next.profile.spendCapUsd || '');
      setStatus('Global Chat settings saved.');
    } catch (reason) {
      setStatus('');
      setError(reason instanceof Error ? reason.message : 'Global Chat settings could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div data-settings-section="global-chat" className="hidden">
      <SectionHeading title={<>Global Chat <span className="text-sm font-normal text-zinc-500">(experimental)</span></>}>
        Fast, low-cost AI for navigating and using Homeroom. Development work keeps its own model and reasoning setting.
      </SectionHeading>

      {loading ? <p className="text-sm text-zinc-500 dark:text-zinc-400 py-2">Loading…</p> : null}
      {error ? <p role="alert" className="mb-3 text-sm text-red-700 dark:text-red-400">{error}</p> : null}

      {!loading && catalog && !catalog.configured ? (
        <div className="rounded-2xl bg-white dark:bg-zinc-900 px-4 py-3">
          <p className="text-sm text-zinc-700 dark:text-zinc-300">Add or claim an OpenRouter key before choosing a Global Chat model.</p>
          <Button
            className="mt-3"
            variant="pillNeutral"
            size="pill"
            ink="muted"
            onClick={() => { window.location.hash = '#settings/openrouter'; }}
          >
            Open OpenRouter settings
          </Button>
        </div>
      ) : null}

      {!loading && catalog?.configured ? (
        <div className="space-y-4">
          <div>
            <Label className="mb-1" htmlFor="settings-global-chat-model">Global Chat model</Label>
            <div className="flex items-stretch gap-2">
              <Select
                id="settings-global-chat-model"
                className="min-w-0 flex-1"
                value={model}
                onChange={(event) => setModel(event.target.value)}
              >
                {catalog.models.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name || item.id}{item.isGlobalChatRecommended ? ' · Recommended' : ''}{price(item) ? ' · ' + price(item) : ''}
                  </option>
                ))}
              </Select>
              <button
                type="button"
                className="shrink-0 rounded-lg bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 px-3 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 disabled:opacity-50"
                disabled={loading}
                onClick={() => void load(true)}
              >
                Refresh
              </button>
            </div>
            {selected ? <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">{selected.id}{price(selected) ? ' · ' + price(selected) : ''}</p> : null}
          </div>

          <div>
            <Label className="mb-1" htmlFor="settings-global-chat-reasoning">Reasoning effort</Label>
            <Select
              id="settings-global-chat-reasoning"
              value={effort}
              onChange={(event) => void changeEffort(event.target.value)}
            >
              <option value="low">Low · recommended for GLM Flash</option>
              <option value="minimal">Minimal · only for supported models</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="xhigh">Extra high</option>
            </Select>
          </div>

          <div>
            <Label className="mb-1" htmlFor="settings-global-chat-cap">Monthly Chat cap in USD · optional</Label>
            <Input
              id="settings-global-chat-cap"
              inputMode="decimal"
              placeholder="No separate cap"
              value={cap}
              onChange={(event) => setCap(event.target.value)}
            />
          </div>

          <div className="rounded-2xl bg-white dark:bg-zinc-900 px-4 py-3 text-sm">
            <div className="flex items-center justify-between gap-4">
              <span>Global Chat this month</span>
              <strong>{money(usage?.spentUsd)}{usage?.capUsd ? ' / ' + money(usage.capUsd) : ''}</strong>
            </div>
            <div className="mt-2 flex items-center justify-between gap-4 text-zinc-500 dark:text-zinc-400">
              <span>Overall OpenRouter remaining</span>
              <span>{overall?.configured ? money(overall.remainingUsd) : 'Unavailable'}</span>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="pillAccent" size="pill" disabled={saving} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save Global Chat settings'}
            </Button>
            <Button
              variant="pillNeutral"
              size="pill"
              ink="muted"
              onClick={() => { window.location.hash = '#settings/openrouter'; }}
            >
              Development AI settings
            </Button>
          </div>
          {status ? <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">{status}</p> : null}
        </div>
      ) : null}

      {profile ? (
        <p className="mt-4 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
          Classic is always the startup mode. This profile only controls Global Chat; development sessions keep their separate defaults.
        </p>
      ) : null}
    </div>
  );
}
