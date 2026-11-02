'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, send } from './api.ts';
import { BTN } from './tokens.ts';
import {
  Badge, EmptyState, ErrorState, Field, FormError, FormGrid, Panel, ScreenHeader, Select, Skeleton, Textarea,
} from './ui.tsx';

// Translations: text admins write in this console and phones show (#6152).
// An AI agent translates each message into Homeroom's languages in the
// background; here an admin reads the result, corrects it, or asks again.
// src/services/admin-text-translations.js holds the rules. The console itself
// stays in English, so the words here are written in place.

type LanguageRow = {
  language: string;
  name: string;
  state: 'waiting' | 'failed' | 'needs_review' | 'live';
  text: string | null;
  reviewed: boolean;
  problem: string | null;
};

type Message = {
  key: string;
  group: string;
  label: string;
  english: string;
  review_required: boolean;
  languages: LanguageRow[];
};

const GROUPS: Record<string, string> = {
  'update-prompts': 'Update prompts',
  programme: 'Challenges and seasons',
};

const topo = () => (window as any).AdminTopochain;
const canWrite = () => !!topo()?.canWrite();

const STATE: Record<LanguageRow['state'], { label: string; tone: string }> = {
  live: { label: 'Live', tone: 'green' },
  needs_review: { label: 'Needs review', tone: 'amber' },
  waiting: { label: 'Translating', tone: 'zinc' },
  failed: { label: 'Failed, showing English', tone: 'red' },
};

function LanguageLine({ messageKey, row, write, reload }: {
  messageKey: string;
  row: LanguageRow;
  write: boolean;
  reload: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.text || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = `admin-topo-tt-${messageKey.replace(/[^a-z0-9]/gi, '-')}-${row.language}`;
  const state = STATE[row.state];

  const act = async (action: 'correct' | 'approve' | 'retranslate', extra: Record<string, string> = {}) => {
    if (!canWrite()) return;
    setBusy(true);
    setError(null);
    const res = await send('POST', `/api/v4/admin/text-translations/${action}`, {
      key: messageKey, language: row.language, ...extra,
    });
    setBusy(false);
    if (res.ok && res.data?.success) {
      setEditing(false);
      reload();
      return;
    }
    setError((res.data && res.data.error) || 'That did not work. Try again.');
  };

  return (
    <li id={id} className="border-t border-zinc-200 dark:border-zinc-800 py-3" data-translation-state={row.state}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{row.name}</span>
        <Badge label={state.label} tone={state.tone} />
      </div>
      {editing ? (
        <Textarea
          id={`${id}-text`}
          aria-label={`${row.name} translation`}
          className="mt-2"
          rows={3}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      ) : (
        <p dir="auto" className="mt-1 text-sm whitespace-pre-wrap break-words">
          {row.text || <span className="text-zinc-500">People see the English for now.</span>}
        </p>
      )}
      {row.problem ? <p className="mt-1 text-xs text-zinc-500">{row.problem}</p> : null}
      <FormError message={error} />
      {write ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {editing ? (
            <>
              <button type="button" className={BTN.primarySm} disabled={busy} onClick={() => act('correct', { text: draft })}>Save</button>
              <button type="button" className={BTN.secondarySm} disabled={busy} onClick={() => { setDraft(row.text || ''); setEditing(false); }}>Cancel</button>
            </>
          ) : (
            <>
              {row.state === 'needs_review' ? (
                <button type="button" className={BTN.primarySm} disabled={busy} onClick={() => act('approve')}>Approve</button>
              ) : null}
              <button type="button" className={BTN.secondarySm} disabled={busy} onClick={() => { setDraft(row.text || ''); setEditing(true); }}>
                {row.text ? 'Correct' : 'Write it'}
              </button>
              {row.text || row.state === 'failed' ? (
                <button type="button" className={BTN.secondarySm} disabled={busy} onClick={() => act('retranslate')}>Translate again</button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </li>
  );
}

function TextTranslationsScreen() {
  const write = canWrite();
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [error, setError] = useState<{ status: number; message: string | null } | null>(null);
  const [group, setGroup] = useState('update-prompts');
  const [language, setLanguage] = useState('');
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    const { ok, data, status } = await fetchJson('/api/v4/admin/text-translations');
    if (!alive.current) return;
    if (ok && data?.success) { setMessages(data.data.messages); setError(null); return; }
    setMessages([]);
    setError({ status, message: (data && data.error) || null });
  }, []);

  useEffect(() => { load(); }, [load]);

  // One language at a time: a season's text in every language is thousands of lines.
  const languages = messages?.[0]?.languages || [];
  const chosen = language || languages[0]?.language || '';
  const shown = (error ? [] : messages || []).filter((message) => message.group === group);

  return (
    <>
      <ScreenHeader
        title="Translations"
        subtitle="What you write in English reaches people in their language. An AI agent translates it in the background, usually within minutes, and a whole season's text within a few hours. Until a translation is ready, people see the English."
      />
      {languages.length ? (
        <FormGrid cols={2}>
          <Field label="Text" htmlFor="admin-topo-tt-group">
            <Select id="admin-topo-tt-group" value={group} onChange={(event) => setGroup(event.target.value)}>
              {Object.entries(GROUPS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </Select>
          </Field>
          <Field label="Language" htmlFor="admin-topo-tt-language">
            <Select id="admin-topo-tt-language" value={chosen} onChange={(event) => setLanguage(event.target.value)}>
              {languages.map((row) => <option key={row.language} value={row.language}>{row.name}</option>)}
            </Select>
          </Field>
        </FormGrid>
      ) : null}
      <div id="admin-topo-tt-list" className="mt-4 space-y-4">
        {messages === null ? <Skeleton rows={4} /> : null}
        {error ? (
          <ErrorState title="Couldn't load translations" status={error.status} message={error.message} onRetry={load} />
        ) : null}
        {messages !== null && !error && !shown.length ? (
          <EmptyState title="Nothing to translate yet" body="Text appears here once it is written on the App version, Challenge templates or Season events screens." />
        ) : null}
        {shown.map((message) => (
          <Panel
            key={message.key}
            title={message.label}
            subtitle={message.review_required
              ? 'This message blocks the app, so each translation shows only after an admin approves it.'
              : undefined}
          >
            <p className="text-sm whitespace-pre-wrap break-words">{message.english}</p>
            <ul className="mt-3">
              {message.languages.filter((row) => row.language === chosen).map((row) => (
                <LanguageLine
                  key={`${row.language}:${row.state}:${row.text || ''}`}
                  messageKey={message.key}
                  row={row}
                  write={write}
                  reload={load}
                />
              ))}
            </ul>
          </Panel>
        ))}
      </div>
    </>
  );
}

export { TextTranslationsScreen };
