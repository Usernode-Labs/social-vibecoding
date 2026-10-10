import { useEffect, useId, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

import { useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';

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
  if (!response.ok) throw new Error(body.error || translate('chat:global.devSettings.requestFailedStatus', { status: response.status }));
  return body;
}

/**
 * A deliberately small Global-Chat-only editor for the separate development
 * agent preference. It reuses the same authenticated preference APIs as the
 * Classic settings screen without cloning key management or changing any
 * existing development-chat component.
 */
export function DevelopmentAISettingsEditor() {
  const t = useMessages('chat');
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
      setError(reason instanceof Error ? reason.message : t('chat:global.devSettings.loadFailed'));
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
      setError(t('chat:global.devSettings.chooseModel'));
      return;
    }
    setSaving(true);
    setStatus(t('chat:global.devSettings.savingStatus'));
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
        ? t('chat:global.devSettings.saved')
        : t('chat:global.devSettings.claudeDefault'));
    } catch (reason) {
      setStatus('');
      setError(reason instanceof Error ? reason.message : t('chat:global.devSettings.saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="global-chat-inline-loading">{t('chat:global.devSettings.loading')}</p>;

  return (
    <div className="global-chat-settings-editor global-chat-development-editor">
      {error ? <p role="alert" className="global-chat-inline-error">{error}</p> : null}
      <div>
        <Label className="mb-1" htmlFor={`${idPrefix}-backend`}>{t('chat:global.devSettings.backendLabel')}</Label>
        <Select
          id={`${idPrefix}-backend`}
          value={backend}
          onChange={(event) => setBackend(event.target.value)}
        >
          {available ? <option value="codex_openrouter">OpenRouter</option> : null}
          <option value="claude_code">Claude Code</option>
        </Select>
      </div>

      {backend === 'codex_openrouter' && available ? (
        <>
          <div>
            <Label className="mb-1" htmlFor={`${idPrefix}-model`}>{t('chat:global.devSettings.modelLabel')}</Label>
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
                  {item.isRecommended
                    ? (item.isFavorite
                      ? t('chat:global.devSettings.modelRecommendedFavorite', { model: item.name || item.id })
                      : t('chat:global.devSettings.modelRecommended', { model: item.name || item.id }))
                    : `${item.name || item.id}${item.isFavorite ? ' · ★' : ''}`}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label className="mb-1" htmlFor={`${idPrefix}-reasoning`}>{t('chat:global.devSettings.effortLabel')}</Label>
            <Select
              id={`${idPrefix}-reasoning`}
              value={effort}
              disabled={selected?.supportsReasoning !== true}
              onChange={(event) => setEffort(event.target.value)}
            >
              <option value="">{t('chat:global.devSettings.effort.default')}</option>
              <option value="minimal">{t('chat:global.devSettings.effort.minimal')}</option>
              <option value="low">{t('chat:global.devSettings.effort.low')}</option>
              <option value="medium">{t('chat:global.devSettings.effort.medium')}</option>
              <option value="high">{t('chat:global.devSettings.effort.high')}</option>
              <option value="xhigh">{t('chat:global.devSettings.effort.xhigh')}</option>
            </Select>
          </div>
        </>
      ) : null}

      {!available ? (
        <p className="global-chat-inline-loading">{t('chat:global.devSettings.unavailable')}</p>
      ) : null}
      <Button variant="pillAccent" size="pill" disabled={saving} onClick={() => void save()}>
        {saving ? t('chat:global.devSettings.saving') : t('chat:global.devSettings.save')}
      </Button>
      {status ? <p role="status" className="global-chat-setting-status">{status}</p> : null}
      <p className="global-chat-setting-note">{t('chat:global.devSettings.note')}</p>
    </div>
  );
}
