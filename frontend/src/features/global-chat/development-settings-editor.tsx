import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
import { Message } from "../../lib/i18n/react";
import { useEffect, useId, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

type CodingAgentPreferences = {
  defaultBackend?: string | null;
  codexAvailable?: boolean;
  backends?: Record<string, {
    model?: string | null;
    reasoningEffort?: string | null;
  }>;
};

type CodingAgentModel = {
  id: string;
  name?: string | null;
  supportsReasoning?: boolean;
  isRecommended?: boolean;
  isFavorite?: boolean;
};

type CodingAgentCatalog = {
  models?: CodingAgentModel[];
  recommendedModelId?: string | null;
};

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || tr("community:request_failed_value1_966aa748", { value1: response.status }));
  return body;
}

/**
 * A deliberately small Global-Chat-only editor for the separate development
 * agent preference. It reuses the same authenticated preference APIs as the
 * Classic settings screen without cloning key management or changing any
 * existing development-chat component.
 */
export function DevelopmentAISettingsEditor() {
  useUiLanguage();
  const instanceId = useId();
  const idPrefix = `chat-development-${instanceId}`;
  const [backend, setBackend] = useState('codex_openrouter');
  const [models, setModels] = useState<CodingAgentModel[]>([]);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const preferences = await responseJson<CodingAgentPreferences>(await fetch('/api/me/coding-agent', {
        credentials: 'same-origin', cache: 'no-store',
      }));
      const nextAvailable = preferences.codexAvailable === true;
      const currentBackend = preferences.defaultBackend === 'codex_openrouter' && nextAvailable
        ? 'codex_openrouter'
        : 'claude_code';
      const saved = preferences.backends?.codex_openrouter;
      setAvailable(nextAvailable);
      setBackend(currentBackend);
      setEffort(saved?.reasoningEffort || '');
      if (!nextAvailable) return;

      const catalog = await responseJson<CodingAgentCatalog>(await fetch(
        '/api/me/coding-agent/models?backend=codex_openrouter',
        { credentials: 'same-origin', cache: 'no-store' },
      ));
      const nextModels = Array.isArray(catalog.models) ? catalog.models : [];
      setModels(nextModels);
      setModel(nextModels.some((item) => item.id === saved?.model)
        ? String(saved?.model)
        : (catalog.recommendedModelId || nextModels[0]?.id || ''));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : tr("community:development_ai_settings_could_not_be_loaded_0392e478"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const selected = useMemo(
    () => models.find((item) => item.id === model) || null,
    [models, model],
  );

  async function save() {
    if (backend === 'codex_openrouter' && !model) {
      setError(tr("community:choose_an_openrouter_model_first_eb5ba7eb"));
      return;
    }
    setSaving(true);
    setStatus(tr("community:saving_23e39291"));
    setError('');
    try {
      await responseJson(await fetch('/api/me/coding-agent', {
        method: 'PATCH',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(backend === 'codex_openrouter'
          ? { defaultBackend: backend, model, reasoningEffort: effort || null }
          : { defaultBackend: 'claude_code' }),
      }));
      setStatus(backend === 'codex_openrouter'
        ? tr("community:development_ai_settings_saved_380f9a9e")
        : tr("community:claude_code_is_now_the_default_development_ai_49bf5516"));
    } catch (reason) {
      setStatus('');
      setError(reason instanceof Error ? reason.message : tr("community:development_ai_settings_could_not_be_saved_e502d14c"));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="global-chat-inline-loading"><Message id="community:loading_current_settings_81c719a7" /></p>;

  return (
    <div className="global-chat-settings-editor global-chat-development-editor">
      {error ? <p role="alert" className="global-chat-inline-error">{error}</p> : null}
      <div>
        <Label className="mb-1" htmlFor={`${idPrefix}-backend`}><Message id="community:development_ai_4e0671b0" /></Label>
        <Select
          id={`${idPrefix}-backend`}
          value={backend}
          onChange={(event) => setBackend(event.target.value)}
        >
          {available ? <option value="codex_openrouter"><Message id="community:openrouter_eb70c3bc" /></option> : null}
          <option value="claude_code"><Message id="community:claude_code_246ef8c1" /></option>
        </Select>
      </div>

      {backend === 'codex_openrouter' && available ? (
        <>
          <div>
            <Label className="mb-1" htmlFor={`${idPrefix}-model`}><Message id="community:model_5e2c614c" /></Label>
            <Select
              id={`${idPrefix}-model`}
              value={model}
              onChange={(event) => {
                const next = event.target.value;
                setModel(next);
                if (models.find((item) => item.id === next)?.supportsReasoning !== true) setEffort('');
              }}
            >
              {models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name || item.id}<LocalizedValue render={() => (item.isRecommended ? tr("community:recommended_a71fecca") : '')} />{item.isFavorite ? ' · ★' : ''}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label className="mb-1" htmlFor={`${idPrefix}-reasoning`}><Message id="community:reasoning_effort_3236aeec" /></Label>
            <Select
              id={`${idPrefix}-reasoning`}
              value={effort}
              disabled={selected?.supportsReasoning !== true}
              onChange={(event) => setEffort(event.target.value)}
            >
              <option value=""><Message id="community:default_21b111cb" /></option>
              <option value="minimal"><Message id="community:minimal_057b5de4" /></option>
              <option value="low"><Message id="community:low_f793de20" /></option>
              <option value="medium"><Message id="community:medium_8e588cd1" /></option>
              <option value="high"><Message id="community:high_c4ebc6d4" /></option>
              <option value="xhigh"><Message id="community:extra_high_70eb321d" /></option>
            </Select>
          </div>
        </>
      ) : null}

      {!available ? (
        <p className="global-chat-inline-loading"><Message id="community:openrouter_development_ai_is_unavailable_for_thi_6a3d38c8" /></p>
      ) : null}
      <Button variant="pillAccent" size="pill" disabled={saving} onClick={() => void save()}>
        <LocalizedValue render={() => (saving ? tr("community:saving_23e39291") : tr("community:save_development_ai_d1bd84e5"))} />
      </Button>
      {status ? <p role="status" className="global-chat-setting-status">{status}</p> : null}
      <p className="global-chat-setting-note"><Message id="community:this_changes_development_work_only_it_does_not_c_f122ec9d" /></p>
    </div>
  );
}
