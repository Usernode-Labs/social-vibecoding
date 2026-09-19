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
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}

/**
 * A deliberately small Global-Chat-only editor for the separate development
 * agent preference. It reuses the same authenticated preference APIs as the
 * Classic settings screen without cloning key management or changing any
 * existing development-chat component.
 */
export function DevelopmentAISettingsEditor() {
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
      setError(reason instanceof Error ? reason.message : 'Development AI settings could not be loaded.');
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
      setError('Choose an OpenRouter model first.');
      return;
    }
    setSaving(true);
    setStatus('Saving…');
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
        ? 'Development AI settings saved.'
        : 'Claude Code is now the default development AI.');
    } catch (reason) {
      setStatus('');
      setError(reason instanceof Error ? reason.message : 'Development AI settings could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="global-chat-inline-loading">Loading current settings…</p>;

  return (
    <div className="global-chat-settings-editor global-chat-development-editor">
      {error ? <p role="alert" className="global-chat-inline-error">{error}</p> : null}
      <div>
        <Label className="mb-1" htmlFor={`${idPrefix}-backend`}>Development AI</Label>
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
            <Label className="mb-1" htmlFor={`${idPrefix}-model`}>Model</Label>
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
                  {item.name || item.id}{item.isRecommended ? ' · Recommended' : ''}{item.isFavorite ? ' · ★' : ''}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label className="mb-1" htmlFor={`${idPrefix}-reasoning`}>Reasoning effort</Label>
            <Select
              id={`${idPrefix}-reasoning`}
              value={effort}
              disabled={selected?.supportsReasoning !== true}
              onChange={(event) => setEffort(event.target.value)}
            >
              <option value="">Default</option>
              <option value="minimal">Minimal</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="xhigh">Extra high</option>
            </Select>
          </div>
        </>
      ) : null}

      {!available ? (
        <p className="global-chat-inline-loading">OpenRouter development AI is unavailable for this account.</p>
      ) : null}
      <Button variant="pillAccent" size="pill" disabled={saving} onClick={() => void save()}>
        {saving ? 'Saving…' : 'Save development AI'}
      </Button>
      {status ? <p role="status" className="global-chat-setting-status">{status}</p> : null}
      <p className="global-chat-setting-note">This changes development work only. It does not change the Global Chat model.</p>
    </div>
  );
}
