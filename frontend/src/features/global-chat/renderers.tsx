import { useMemo, useState } from 'react';

import { ArrowRightShortIcon, CheckIcon, ChevronDownIcon } from '@/components/ui/icons';

import {
  clientAction,
  closeGlobalChat,
  confirmGlobalChatAction,
  dismissConfirmation,
  runGlobalChatClientAction,
  sendGlobalChatMessage,
  useGlobalChatState,
} from './store';
import type { GlobalChatResult } from './types';

type JsonObject = Record<string, unknown>;

const ARRAY_KEYS = [
  'items', 'issues', 'proposals', 'apps', 'sessions', 'conversations',
  'notifications', 'results', 'rows', 'challenges', 'users', 'messages',
];
const TITLE_KEYS = ['title', 'name', 'label', 'username', 'subject', 'displayName', 'appName'];
const SUMMARY_KEYS = ['summary', 'description', 'body', 'content', 'message', 'statusText'];
const ID_KEYS = [
  'number', 'issueNumber', 'sessionId', 'conversationId', 'proposalId',
  'challengeId', 'id', 'slug', 'username',
];
const PRIVATE_KEY = /(?:secret|password|token|credential|cookie|authorization|signature|private|cipher)/i;

function object(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function text(value: unknown, max = 180): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1).trimEnd()}…` : normalized;
}

function unwrapped(result: GlobalChatResult): unknown {
  const authoritative = object(result.authoritativeResult);
  if (!authoritative) return result.authoritativeResult;
  if (authoritative.status === 'confirmation_required') return authoritative;
  return Object.hasOwn(authoritative, 'data') ? authoritative.data : authoritative;
}

function findItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const root = object(value);
  if (!root) return [];
  for (const key of ARRAY_KEYS) if (Array.isArray(root[key])) return root[key] as unknown[];
  for (const nested of Object.values(root)) {
    const child = object(nested);
    if (!child) continue;
    for (const key of ARRAY_KEYS) if (Array.isArray(child[key])) return child[key] as unknown[];
  }
  return [root];
}

function first(item: JsonObject, keys: string[], max?: number) {
  for (const key of keys) {
    const value = text(item[key], max);
    if (value) return value;
  }
  return '';
}

function rendererLabel(renderer: string) {
  const labels: Record<string, string> = {
    app: 'App', issue: 'Issue', proposal: 'Proposal', session: 'Development',
    conversation: 'Conversation', notification: 'Notification', profile: 'Profile',
    leaderboard: 'Leaderboard', challenge: 'Challenge', wallet: 'Wallet',
    staking: 'Staking', setting: 'Setting', admin_record: 'Admin', status: 'Result',
    error: 'Error', form: 'Form', grouped_list: 'Results', confirmation: 'Confirmation',
  };
  return labels[renderer] || 'Result';
}

function humanizeCapability(value: string) {
  return value
    .replace(/\.[a-f0-9]{8}$/i, '')
    .split(/[._-]+/)
    .filter((part) => !['get', 'post', 'put', 'patch', 'delete', 'item'].includes(part))
    .slice(1)
    .join(' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase()) || 'this action';
}

function identifier(item: JsonObject) {
  for (const key of ID_KEYS) {
    const value = text(item[key], 80);
    if (value) return { key, value };
  }
  return null;
}

function promptTarget(renderer: string, item: JsonObject) {
  const id = identifier(item);
  const noun = rendererLabel(renderer).toLowerCase();
  if (!id) return `this ${noun}`;
  const prefix = id.key === 'number' || /number$/i.test(id.key) ? '#' : '';
  return `${noun} ${prefix}${id.value}`;
}

function itemClassicPath(result: GlobalChatResult, item: JsonObject) {
  const base = result.classicPath;
  if (!base) return null;
  const exactTopic = /\/dev\/(?:issues|proposals|sessions)\/[A-Za-z0-9%-]+$/.test(base)
    || /^#messages\/[1-9]\d*$/.test(base);
  if (exactTopic) return base;

  const slug = text(item.appSlug || item.app_slug || item.slug, 255)
    || (/^#app\/([^/]+)/.exec(base)?.[1] || '');
  const id = identifier(item)?.value;
  const segment = (value: string) => {
    try { return encodeURIComponent(decodeURIComponent(value)); }
    catch { return encodeURIComponent(value); }
  };
  if (result.renderer === 'issue' && slug && id) {
    return `#app/${segment(slug)}/dev/issues/${encodeURIComponent(id)}`;
  }
  if (result.renderer === 'proposal' && slug && id) {
    return `#app/${segment(slug)}/dev/proposals/${encodeURIComponent(id)}`;
  }
  if (result.renderer === 'session' && slug && id) {
    return `#app/${segment(slug)}/dev/sessions/${encodeURIComponent(id)}`;
  }
  if (result.renderer === 'conversation' && id && /^#messages/.test(base)) {
    return `#messages/${encodeURIComponent(id)}`;
  }
  if (result.renderer === 'profile') {
    const username = text(item.username, 80);
    if (username) return `#profile/${encodeURIComponent(username)}`;
  }
  return base;
}

function compactMetadata(item: JsonObject) {
  const parts: string[] = [];
  const id = identifier(item);
  if (id && !TITLE_KEYS.includes(id.key)) {
    parts.push(id.key === 'number' || /number$/i.test(id.key) ? `#${id.value}` : id.value);
  }
  for (const key of ['status', 'state', 'role', 'visibility', 'kind', 'updatedAt', 'createdAt']) {
    const value = text(item[key], 50);
    if (value && !parts.includes(value)) parts.push(value);
    if (parts.length === 3) break;
  }
  return parts.join(' · ');
}

function safeFields(item: JsonObject) {
  return Object.entries(item).filter(([key, value]) => (
    !PRIVATE_KEY.test(key)
    && !TITLE_KEYS.includes(key)
    && !SUMMARY_KEYS.includes(key)
    && !ID_KEYS.includes(key)
    && ['string', 'number', 'boolean'].includes(typeof value)
    && text(value, 80)
  )).slice(0, 4);
}

function nextAction(renderer: string) {
  const actions: Record<string, string> = {
    app: 'Open', issue: 'Edit', proposal: 'Review', session: 'Continue',
    conversation: 'Reply', notification: 'Open', profile: 'View',
    leaderboard: 'Explore', challenge: 'View', wallet: 'Manage', staking: 'Manage',
    setting: 'Change', admin_record: 'Inspect', form: 'Fill in', grouped_list: 'Refine',
    status: 'What next?', error: 'Fix it',
  };
  return actions[renderer] || 'Use this';
}

function ItemRow({ result, value }: { result: GlobalChatResult; value: unknown }) {
  const item = object(value) || { value };
  const target = promptTarget(result.renderer, item);
  const title = first(item, TITLE_KEYS, 120)
    || (identifier(item)?.value ? `${rendererLabel(result.renderer)} ${identifier(item)?.value}` : rendererLabel(result.renderer));
  const summary = first(item, SUMMARY_KEYS, 150);
  const meta = compactMetadata(item);
  const classicPath = itemClassicPath(result, item);
  const fields = safeFields(item);
  return (
    <article className="global-chat-item">
      <div className="min-w-0 flex-1">
        <div className="global-chat-item-title">{title}</div>
        {meta ? <div className="global-chat-item-meta">{meta}</div> : null}
        {summary && summary !== title ? <p className="global-chat-item-summary">{summary}</p> : null}
        {!summary && fields.length ? (
          <div className="global-chat-item-meta">
            {fields.map(([key, value]) => `${key.replace(/([a-z])([A-Z])/g, '$1 $2')}: ${text(value, 80)}`).join(' · ')}
          </div>
        ) : null}
        <div className="global-chat-inline-actions">
          <button type="button" onClick={() => void sendGlobalChatMessage(`Show details for ${target}.`)}>Details</button>
          <button type="button" onClick={() => void sendGlobalChatMessage(`${nextAction(result.renderer)} ${target}.`)}>{nextAction(result.renderer)}</button>
          {classicPath ? <button type="button" onClick={() => closeGlobalChat(classicPath)}>Open in Classic</button> : null}
        </div>
      </div>
    </article>
  );
}

function ConfirmationResult({ result, payload }: { result: GlobalChatResult; payload: JsonObject }) {
  const snapshot = useGlobalChatState();
  const token = text(payload.confirmationToken, 500);
  const consumed = !!snapshot.consumedConfirmations[result.id];
  const dismissed = !!snapshot.dismissedConfirmations[result.id];
  const expiresAt = text(payload.expiresAt, 80);
  const preview = object(payload.preview);
  const previewRows = preview ? Object.entries(preview).filter(([, value]) => (
    ['string', 'number', 'boolean'].includes(typeof value) && text(value, 500)
  )).slice(0, 6) : [];
  if (dismissed) {
    return <div className="global-chat-confirmation global-chat-confirmation-muted">Cancelled.</div>;
  }
  return (
    <section className="global-chat-confirmation" aria-label="Confirm action">
      <div className="min-w-0">
        <strong>{text(payload.title, 100) || humanizeCapability(result.capabilityId)}</strong>
        {previewRows.length ? (
          <dl className="global-chat-confirmation-details">
            {previewRows.map(([key, value]) => (
              <div key={key}>
                <dt>{key.replace(/([a-z])([A-Z])/g, '$1 $2')}</dt>
                <dd>{text(value, key === 'task' ? 500 : 160)}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {expiresAt ? <p>Confirm before {new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.</p> : null}
      </div>
      <div className="global-chat-inline-actions">
        <button
          type="button"
          className="global-chat-action-primary"
          disabled={!token || consumed}
          onClick={() => void confirmGlobalChatAction(result, token)}
        >
          {consumed ? 'Confirmed' : 'Confirm'}
        </button>
        {!consumed ? <button type="button" onClick={() => dismissConfirmation(result.id)}>Cancel</button> : null}
        {result.classicPath ? <button type="button" onClick={() => closeGlobalChat(result.classicPath)}>Open in Classic</button> : null}
      </div>
    </section>
  );
}

function ClientActionResult({ result }: { result: GlobalChatResult }) {
  const snapshot = useGlobalChatState();
  const action = clientAction(result);
  if (!action) return null;
  const actionState = snapshot.clientActionStates[result.id];
  const navigation = action.transport === 'navigation';
  const localSetting = action.transport === 'local_setting';
  return (
    <div className="global-chat-inline-actions global-chat-client-action">
      <button
        type="button"
        className="global-chat-action-primary"
        disabled={actionState === 'running' || actionState === 'done'}
        onClick={() => void runGlobalChatClientAction(result)}
      >
        {actionState === 'running' ? 'Applying…' : actionState === 'done' ? 'Done' : navigation ? 'Open in Classic' : localSetting ? 'Apply' : 'Open'}
      </button>
      {!navigation && result.classicPath ? <button type="button" onClick={() => closeGlobalChat(result.classicPath)}>Open in Classic</button> : null}
    </div>
  );
}

export function GlobalChatResultBlock({ result }: { result: GlobalChatResult }) {
  const [expanded, setExpanded] = useState(false);
  const payload = unwrapped(result);
  const confirmation = object(payload)?.status === 'confirmation_required';
  const items = useMemo(() => findItems(payload), [payload]);
  if (confirmation) return <ConfirmationResult result={result} payload={object(payload) || {}} />;

  const visible = expanded ? items : items.slice(0, 3);
  const action = clientAction(result);
  return (
    <section className="global-chat-result" data-renderer={result.renderer}>
      <header className="global-chat-result-head">
        <span>{rendererLabel(result.renderer)}</span>
        {result.classicPath ? (
          <button type="button" onClick={() => closeGlobalChat(result.classicPath)}>
            Open in Classic <ArrowRightShortIcon className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </header>
      {visible.length ? <div className="global-chat-result-items">{visible.map((item, index) => <ItemRow key={`${result.id}-${index}`} result={result} value={item} />)}</div> : null}
      {items.length > visible.length ? (
        <button type="button" className="global-chat-expand" onClick={() => setExpanded(true)}>
          Show {items.length - visible.length} more <ChevronDownIcon className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      ) : null}
      {action ? <ClientActionResult result={result} /> : null}
      {!items.length && !action ? (
        <div className="global-chat-result-done"><CheckIcon className="w-4 h-4" aria-hidden="true" /> Done</div>
      ) : null}
    </section>
  );
}
