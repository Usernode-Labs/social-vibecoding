import { useMemo, useState } from 'react';

import { ChevronDownIcon } from '@/components/ui/icons';
import { useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';
import { AppIconContent, AppIconLink, appIconKind } from '../apps/app-card-view';
import { GlobalChatSettingsEditor } from '../settings/sections/global-chat';
import { DevelopmentAISettingsEditor } from './development-settings-editor';
// Publishes window.Notifications, whose rowView words each notification row.
import '../notifications/notifications.js';

import {
  clientAction,
  closeGlobalChat,
  confirmGlobalChatAction,
  dismissConfirmation,
  executeGlobalChatResultAction,
  loadGlobalChatInlineResults,
  runGlobalChatClientAction,
  sendGlobalChatMessage,
  useGlobalChatState,
} from './store';
import type { GlobalChatItemSelection, GlobalChatResult } from './types';

type JsonObject = Record<string, unknown>;

const ARRAY_KEYS = [
  'items', 'issues', 'proposals', 'apps', 'sessions', 'conversations',
  'notifications', 'results', 'rows', 'challenges', 'users', 'messages',
];
const OBJECT_KEYS = ['app', 'issue', 'proposal', 'session', 'conversation', 'profile', 'notification'];
const TITLE_KEYS = [
  'title', 'name', 'label', 'subject', 'displayName', 'appName', 'app_name',
  'sessionTitle', 'session_title', 'prTitle', 'pr_title', 'conversationTitle',
  'conversation_title', 'username',
];
const SUMMARY_KEYS = [
  'summary', 'description', 'body', 'content', 'message', 'statusText',
  'latestSummary', 'latest_summary', 'messageContent', 'message_content',
];
const ID_KEYS = [
  'number', 'issueNumber', 'issue_number', 'github_issue_number', 'sessionId', 'session_id',
  'conversationId', 'conversation_id', 'proposalId', 'proposal_id',
  'challengeId', 'challenge_id', 'id', 'slug', 'username',
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
  for (const key of OBJECT_KEYS) if (object(root[key])) return [root[key]];
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

// What each kind of result is called: message ids, read when a result renders.
const RENDERER_LABELS: Record<string, string> = {
  app: 'chat:global.kind.app',
  issue: 'chat:global.kind.issue',
  proposal: 'chat:global.kind.proposal',
  session: 'chat:global.kind.session',
  conversation: 'chat:global.kind.conversation',
  notification: 'chat:global.kind.notification',
  profile: 'chat:global.kind.profile',
  leaderboard: 'chat:global.kind.leaderboard',
  challenge: 'chat:global.kind.challenge',
  wallet: 'chat:global.kind.wallet',
  staking: 'chat:global.kind.staking',
  setting: 'chat:global.kind.setting',
  admin_record: 'chat:global.kind.adminRecord',
  status: 'chat:global.kind.result',
  error: 'chat:global.kind.error',
  form: 'chat:global.kind.form',
  grouped_list: 'chat:global.kind.results',
  confirmation: 'chat:global.kind.confirmation',
};

function rendererLabel(renderer: string) {
  return translate(Object.hasOwn(RENDERER_LABELS, renderer) ? RENDERER_LABELS[renderer] : 'chat:global.kind.result');
}

function humanize(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[._-]+/g, ' ')
    .replace(/\bpr\b/gi, 'PR')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formattedDate(value: unknown) {
  const raw = text(value, 100);
  if (!raw) return '';
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toLocaleString([], {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function displayValue(key: string, value: unknown) {
  if (typeof value === 'boolean') return value ? translate('chat:global.value.yes') : translate('chat:global.value.no');
  if (/activitySecondsLast7Days/.test(key)) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
      if (seconds < 60) return translate('chat:global.value.seconds', { count: Math.round(seconds) });
      if (seconds < 3600) return translate('chat:global.value.minutes', { count: Math.round(seconds / 60) });
      return translate('chat:global.value.hours', { hours: (seconds / 3600).toFixed(seconds < 36_000 ? 1 : 0) });
    }
  }
  if (/(?:^|\.)(?:spent|cap|remaining).*usd$/i.test(key)) {
    const amount = Number(value);
    if (Number.isFinite(amount)) return `$${amount.toFixed(amount > 0 && amount < 0.01 ? 4 : 2)}`;
  }
  if (/(?:At|_at)$/.test(key)) return formattedDate(value);
  return text(value, 80);
}

// #3233: a notification is worded the way the notification sheet words it,
// not as its raw `kind` and `detail` ("App Quota Changed", "0:2"). Null when
// the row is not one the sheet can read, so the generic fields still show.
interface NotificationCopy { label: string; subject: string }
function notificationCopy(item: JsonObject): NotificationCopy | null {
  const rowView = typeof window === 'undefined' ? null : window.Notifications?._rowView;
  if (!rowView || !text(item.kind, 80)) return null;
  try {
    const view = rowView(item) as {
      label?: unknown;
      segments?: Array<{ t?: unknown; v?: unknown }>;
    };
    const label = text(view?.label, 120);
    if (!label) return null;
    const subject = text((view.segments || [])
      .map((segment) => (segment.t === 'who' ? `@${String(segment.v ?? '')}` : String(segment.v ?? '')))
      .join(' '), 180);
    return { label, subject };
  } catch {
    return null;
  }
}

function itemTitle(result: GlobalChatResult, item: JsonObject) {
  if (result.renderer === 'notification') {
    const kind = text(item.kind, 80);
    const place = first(item, ['appName', 'app_name', 'conversationTitle', 'conversation_title'], 100);
    const label = notificationCopy(item)?.label || (kind ? humanize(kind) : translate('chat:global.kind.notification'));
    return place ? `${label} · ${place}` : label;
  }
  const rendererKeys: Record<string, string[]> = {
    app: ['name', 'title'],
    issue: ['title', 'name'],
    proposal: ['prTitle', 'pr_title', 'title', 'sessionTitle', 'session_title', 'name'],
    session: ['sessionTitle', 'session_title', 'prTitle', 'pr_title', 'title', 'name'],
    conversation: [
      'title', 'conversationTitle', 'conversation_title', 'name',
      'senderUsername', 'sender_username', 'username',
    ],
    profile: ['displayName', 'username', 'name'],
    leaderboard: ['username', 'displayName', 'name'],
    setting: ['name', 'label'],
  };
  const explicit = first(item, rendererKeys[result.renderer] || TITLE_KEYS, 120);
  if (explicit) return explicit;
  const id = identifier(item)?.value;
  return id ? translate('chat:global.item.kindWithId', { kind: rendererLabel(result.renderer), id }) : rendererLabel(result.renderer);
}

function itemSummary(result: GlobalChatResult, item: JsonObject, title: string) {
  if (result.renderer === 'notification') {
    const copy = notificationCopy(item);
    if (copy) return copy.subject && copy.subject !== title ? copy.subject : '';
  }
  const rendererKeys: Record<string, string[]> = {
    notification: [
      'messageContent', 'message_content', 'voteReason', 'vote_reason', 'detail',
      'prTitle', 'pr_title', 'sessionTitle', 'session_title',
    ],
    conversation: ['latestSummary', 'latest_summary', ...SUMMARY_KEYS],
    session: ['checkErrorDetail', 'check_error_detail', ...SUMMARY_KEYS],
  };
  const summary = first(item, rendererKeys[result.renderer] || SUMMARY_KEYS, 180);
  return summary && summary !== title ? summary : '';
}

function resultLabel(result: GlobalChatResult) {
  if (result.renderer === 'issue') {
    return /(?:^|\.)github\.issues(?:\.|$)/.test(result.capabilityId)
      ? translate('chat:global.result.githubIssues')
      : translate('chat:global.result.platformIssues');
  }
  if (result.capabilityId === 'apps.activity') return translate('chat:global.result.appActivity');
  if (result.capabilityId === 'messages.for_app') return translate('chat:global.result.appDiscussions');
  return rendererLabel(result.renderer);
}

function emptyResultMessage(result: GlobalChatResult) {
  // Message ids, read when the empty result renders.
  const messages: Record<string, string> = {
    app: 'chat:global.empty.app',
    issue: 'chat:global.empty.issue',
    proposal: 'chat:global.empty.proposal',
    session: 'chat:global.empty.session',
    conversation: 'chat:global.empty.conversation',
    notification: 'chat:global.empty.notification',
    leaderboard: 'chat:global.empty.leaderboard',
    setting: 'chat:global.empty.setting',
  };
  return translate(Object.hasOwn(messages, result.renderer) ? messages[result.renderer] : 'chat:global.empty.other');
}

function humanizeCapability(value: string) {
  return value
    .replace(/\.[a-f0-9]{8}$/i, '')
    .split(/[._-]+/)
    .filter((part) => !['get', 'post', 'put', 'patch', 'delete', 'item'].includes(part))
    .slice(1)
    .join(' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase()) || translate('chat:global.confirm.thisAction');
}

function identifier(item: JsonObject) {
  for (const key of ID_KEYS) {
    const value = text(item[key], 80);
    if (value) return { key, value };
  }
  return null;
}

interface DirectItemAction {
  label: string;
  requestLabel: string;
  actionId: string;
  parameters: Record<string, string>;
  mode: 'inline' | 'turn';
}

function itemAction(
  label: string,
  requestLabel: string,
  actionId: string,
  parameters: Record<string, string>,
  mode: 'inline' | 'turn',
): DirectItemAction {
  return { label, requestLabel, actionId, parameters, mode };
}

function resultAppSlug(result: GlobalChatResult, item: JsonObject) {
  const direct = text(item.appSlug || item.app_slug || item.slug, 128);
  if (direct) return direct;
  const encoded = /^#app\/([^/]+)/.exec(result.classicPath || '')?.[1];
  if (!encoded) return '';
  try { return decodeURIComponent(encoded); } catch { return encoded; }
}

function directItemActions(
  result: GlobalChatResult,
  item: JsonObject,
  targetLabel: string,
): DirectItemAction[] {
  const slug = resultAppSlug(result, item);
  const payload = object(item.payload);
  if (result.renderer === 'app' && slug) {
    return [
      itemAction(translate('chat:global.action.details'), translate('chat:global.request.about', { target: targetLabel }), 'apps.detail', { appSlug: slug }, 'inline'),
      itemAction(translate('chat:global.action.issues'), translate('chat:global.request.issuesFor', { target: targetLabel }), 'issues.for_app', { appSlug: slug }, 'turn'),
      itemAction(translate('chat:global.action.discussions'), translate('chat:global.request.discussionsIn', { target: targetLabel }), 'messages.for_app', { appSlug: slug }, 'turn'),
    ];
  }
  if (result.renderer === 'issue' && slug) {
    const explicitGithubIssueNumber = text(
      item.github_issue_number || payload?.github_issue_number,
      80,
    );
    const issueNumber = text(
      item.number || item.issueNumber || item.issue_number || item.github_issue_number
        || payload?.issueNumber || payload?.issue_number || payload?.github_issue_number,
      80,
    );
    const governanceId = text(item.id, 80);
    const githubIssueCapability = /(?:^|\.)github\.issues(?:\.|$)/.test(result.capabilityId);
    if (issueNumber && (explicitGithubIssueNumber || githubIssueCapability || !text(item.kind, 80))) {
      return [
        itemAction(translate('chat:global.action.details'), translate('chat:global.request.open', { target: targetLabel }), 'issue.detail', { appSlug: slug, issueNumber }, 'inline'),
        itemAction(translate('chat:global.action.comments'), translate('chat:global.request.commentsOn', { target: targetLabel }), 'issue.comments', { appSlug: slug, issueNumber }, 'inline'),
      ];
    }
    if (governanceId) {
      return [itemAction(
        translate('chat:global.action.details'), translate('chat:global.request.open', { target: targetLabel }), 'governance.detail',
        { appSlug: slug, governanceId }, 'inline',
      )];
    }
  }
  if (result.renderer === 'proposal' && slug) {
    const governanceId = text(item.governanceId || item.governance_id || item.id, 80);
    if (item.proposalType === 'governance' && governanceId) {
      return [itemAction(
        translate('chat:global.action.details'), translate('chat:global.request.open', { target: targetLabel }), 'governance.detail',
        { appSlug: slug, governanceId }, 'inline',
      )];
    }
    const proposalId = first(item, ['proposalId', 'proposal_id', 'id', 'sessionId', 'session_id'], 80);
    if (proposalId) return [
      itemAction(translate('chat:global.action.details'), translate('chat:global.request.open', { target: targetLabel }), 'proposal.detail', { appSlug: slug, proposalId }, 'inline'),
      itemAction(translate('chat:global.action.beforeAfter'), translate('chat:global.request.beforeAfterFor', { target: targetLabel }), 'proposal.shots', { appSlug: slug, proposalId }, 'inline'),
    ];
  }
  if (result.renderer === 'session') {
    const sessionId = first(item, ['sessionId', 'session_id', 'id'], 80);
    if (sessionId) return [
      itemAction(translate('chat:global.action.details'), translate('chat:global.request.detailsFor', { target: targetLabel }), 'session.detail', { sessionId }, 'inline'),
      itemAction(translate('chat:global.action.checks'), translate('chat:global.request.checksFor', { target: targetLabel }), 'session.checks', { sessionId }, 'inline'),
    ];
  }
  if (result.renderer === 'conversation') {
    if (result.capabilityId === 'messages.for_app') return [];
    const conversationId = first(item, ['conversationId', 'conversation_id', 'id'], 80);
    if (conversationId) return [itemAction(
      translate('chat:global.action.details'), translate('chat:global.request.open', { target: targetLabel }), 'conversation.detail', { conversationId }, 'inline',
    )];
  }
  if (result.renderer === 'notification') {
    const notificationId = first(item, ['notificationId', 'notification_id', 'id'], 80);
    if (notificationId) return [itemAction(
      translate('chat:global.action.details'), translate('chat:global.request.open', { target: targetLabel }), 'notification.detail', { notificationId }, 'inline',
    )];
  }
  if (result.renderer === 'leaderboard') {
    const userId = first(item, ['userId', 'user_id', 'id'], 80);
    const username = text(item.username, 80);
    return [
      ...(userId ? [itemAction(
        translate('chat:global.action.profile'), translate('chat:global.request.profileFor', { target: targetLabel }), 'leaderboard.profile', { userId }, 'inline',
      )] : []),
      ...(username ? [itemAction(
        translate('chat:global.action.mergedWork'), translate('chat:global.request.mergedWorkBy', { target: targetLabel }), 'leaderboard.prs', { username }, 'inline',
      )] : []),
    ];
  }
  if (result.renderer === 'setting' && result.capabilityId === 'settings.catalog') {
    const group = text(item.id || item.group, 80);
    if (group && text(item.classicPath, 300)) return [itemAction(
      translate('chat:global.action.view'), translate('chat:global.request.open', { target: targetLabel }), 'settings.inspect', { group }, 'inline',
    )];
  }
  return [];
}

function itemClassicPath(result: GlobalChatResult, item: JsonObject) {
  const base = result.classicPath;
  if (!base) return null;
  const exactTopic = /\/dev\/(?:issues|proposals|changes|sessions)\/[A-Za-z0-9%-]+$/.test(base)
    || /\/dev\/chat$/.test(base)
    || /^#messages\/[1-9]\d*$/.test(base);
  if (exactTopic) return base;

  const slug = text(item.appSlug || item.app_slug || item.slug, 255)
    || (/^#app\/([^/]+)/.exec(base)?.[1] || '');
  const payload = object(item.payload);
  const segment = (value: string) => {
    try { return encodeURIComponent(decodeURIComponent(value)); }
    catch { return encodeURIComponent(value); }
  };
  if (result.renderer === 'app' && slug) {
    return `#apps/${segment(slug)}`;
  }
  if (result.renderer === 'issue' && slug) {
    const governanceId = text(item.id, 80);
    const governanceKind = text(item.kind, 80);
    const githubIssueCapability = /(?:^|\.)github\.issues(?:\.|$)/.test(result.capabilityId);
    const explicitGithubIssueNumber = text(
      item.github_issue_number || payload?.github_issue_number,
      80,
    );
    const issueNumber = text(
      item.number || item.issueNumber || item.issue_number || item.github_issue_number
        || payload?.issueNumber || payload?.issue_number || payload?.github_issue_number,
      80,
    );
    if (explicitGithubIssueNumber || (issueNumber && githubIssueCapability)) {
      return `#app/${segment(slug)}/dev/issues/${segment(issueNumber)}`;
    }
    if (governanceId && governanceKind && !githubIssueCapability) {
      return `#app/${segment(slug)}/dev/governance/${segment(governanceId)}`;
    }
    if (issueNumber) return `#app/${segment(slug)}/dev/issues/${segment(issueNumber)}`;
    if (governanceId) return `#app/${segment(slug)}/dev/governance/${segment(governanceId)}`;
  }
  if (result.renderer === 'proposal' && slug) {
    const governanceId = text(item.governanceId || item.governance_id || item.id, 80);
    if (item.proposalType === 'governance' && governanceId) {
      return `#app/${segment(slug)}/dev/governance/${segment(governanceId)}`;
    }
    const proposalId = first(item, ['proposalId', 'proposal_id', 'id', 'sessionId', 'session_id'], 80);
    // #4367: a change with a pull request is addressed by its number.
    const prNumber = first(item, ['prNumber', 'pr_number'], 80);
    if (proposalId && /^[1-9]\d*$/.test(prNumber)) return `#app/${segment(slug)}/dev/changes/${prNumber}`;
    if (proposalId) return `#app/${segment(slug)}/dev/proposals/${segment(proposalId)}`;
  }
  if (result.renderer === 'session' && slug) {
    const sessionId = first(item, ['sessionId', 'session_id', 'id'], 80);
    if (sessionId) return `#app/${segment(slug)}/dev/sessions/${segment(sessionId)}`;
  }
  if (result.renderer === 'conversation' && /^#messages/.test(base)) {
    const conversationId = first(item, ['conversationId', 'conversation_id', 'id'], 80);
    if (conversationId) return `#messages/${segment(conversationId)}`;
  }
  if (result.renderer === 'setting' && /^#settings(?:\/|$)/.test(base)) {
    const group = first(item, ['id', 'group'], 80);
    if (group && /^[a-z][a-z0-9-]{0,63}$/.test(group)) {
      return `#settings/${segment(group)}`;
    }
  }
  if (result.renderer === 'profile') {
    const username = text(item.username, 80);
    if (username) return `#profile/${encodeURIComponent(username)}`;
  }
  return base;
}

function compactMetadata(result: GlobalChatResult, item: JsonObject, title: string) {
  const parts: string[] = [];
  const id = identifier(item);
  if (id && ['issue', 'proposal', 'session'].includes(result.renderer)
      && !title.includes(id.value)) {
    parts.push(`#${id.value}`);
  }
  for (const key of ['status', 'state', 'visibility']) {
    const value = text(item[key], 50);
    if (value && !parts.includes(value)) parts.push(humanize(value));
    if (parts.length === 3) break;
  }
  if (result.renderer === 'notification') {
    parts.push(item.readAt || item.read_at ? translate('chat:global.meta.read') : translate('chat:global.meta.unread'));
  }
  const date = first(item, ['lastActivityAt', 'last_activity_at', 'updatedAt', 'updated_at', 'createdAt', 'created_at'], 100);
  const renderedDate = formattedDate(date);
  if (renderedDate && parts.length < 3) parts.push(renderedDate);
  return parts.join(' · ');
}

interface DisplayField {
  label: string;
  value: string;
}

function displayFields(result: GlobalChatResult, item: JsonObject): DisplayField[] {
  const fields: DisplayField[] = [];
  const seen = new Set<string>();
  const add = (label: string, keys: string[]) => {
    if (seen.has(label)) return;
    for (const key of keys) {
      if (!Object.hasOwn(item, key) || item[key] == null || item[key] === '') continue;
      const value = displayValue(key, item[key]);
      if (!value) continue;
      fields.push({ label, value });
      seen.add(label);
      return;
    }
  };

  if (result.renderer === 'app') {
    if (result.capabilityId === 'apps.activity') {
      add(translate('chat:global.field.messages7d'), ['messagesLast7Days']);
      add(translate('chat:global.field.activeTime7d'), ['activitySecondsLast7Days']);
      add(translate('chat:global.field.activeUsers'), ['activeUsers', 'active_users']);
      add(translate('chat:global.field.development'), ['activeDevelopment', 'active_development', 'active_sessions']);
    } else {
      add(translate('chat:global.field.openIssues'), ['openIssues', 'open_issues']);
      add(translate('chat:global.field.openProposals'), ['openProposals', 'open_proposals', 'open_prs']);
      add(translate('chat:global.field.activeDevelopment'), ['activeDevelopment', 'active_development', 'active_sessions']);
    }
  } else if (result.renderer === 'proposal') {
    add(translate('chat:global.field.app'), ['appName', 'app_name']);
    add(translate('chat:global.field.yesVotes'), ['yesCount', 'yes_count', 'upCount', 'up_count']);
    add(translate('chat:global.field.noVotes'), ['noCount', 'no_count', 'downCount', 'down_count']);
    add(translate('chat:global.field.checks'), ['checkState', 'check_state']);
  } else if (result.renderer === 'session') {
    add(translate('chat:global.field.app'), ['appName', 'app_name']);
    add(translate('chat:global.field.checks'), ['checkState', 'check_state']);
    add(translate('chat:global.field.phase'), ['checkPhase', 'check_phase']);
  } else if (result.renderer === 'conversation') {
    add(translate('chat:global.field.unread'), ['unreadCount', 'unread_count']);
    add(translate('chat:global.field.members'), ['memberCount', 'member_count']);
  } else if (result.renderer === 'notification') {
    add(translate('chat:global.field.from'), ['sourceUsername', 'source_username']);
    add(translate('chat:global.field.pr'), ['prNumber', 'pr_number']);
  } else if (result.renderer === 'leaderboard') {
    add(translate('chat:global.field.kudos'), ['kudosReceived', 'kudos_received']);
    add(translate('chat:global.field.prsRecognized'), ['prsKudosed', 'prs_kudosed']);
    add(translate('chat:global.field.merged'), ['kudosReceivedPrsMerged', 'kudos_received_prs_merged']);
  } else if (result.renderer === 'setting') {
    const spending = text(item.name, 100) === 'Global Chat usage';
    if (spending) {
      add(translate('chat:global.field.spentThisMonth'), ['spentUsd']);
      add(translate('chat:global.field.monthlyCap'), ['capUsd']);
      add(translate('chat:global.field.capRemaining'), ['remainingUsd']);
      add(translate('chat:global.field.openRouterRemaining'), ['overallRemainingUsd']);
    } else {
      add(translate('chat:global.field.model'), ['profile.model', 'backends.codex_openrouter.model', 'model']);
      add(translate('chat:global.field.reasoning'), ['profile.reasoningEffort', 'reasoningEffort', 'reasoning_effort']);
      add(translate('chat:global.field.enabled'), ['profile.enabled', 'enabled']);
      add(translate('chat:global.field.spentThisMonth'), ['usage.spentUsd', 'spentUsd']);
      add(translate('chat:global.field.monthlyCap'), ['usage.capUsd', 'profile.spendCapUsd', 'capUsd']);
      add(translate('chat:global.field.openRouterRemaining'), ['overallRemaining', 'overallRemainingUsd']);
      add(translate('chat:global.field.backend'), ['backend', 'profile.backend']);
    }
    if (fields.length < 4) {
      for (const [key, raw] of Object.entries(item)) {
        if (fields.length >= 4) break;
        if (PRIVATE_KEY.test(key)
            || [...TITLE_KEYS, ...SUMMARY_KEYS, ...ID_KEYS, 'group', 'classicPath'].includes(key)
            || !['string', 'number', 'boolean'].includes(typeof raw)) continue;
        const label = humanize(key.split('.').at(-1) || key);
        const value = displayValue(key, raw);
        if (!value || seen.has(label)) continue;
        fields.push({ label, value });
        seen.add(label);
      }
    }
  }
  return fields.slice(0, 4);
}

function actionTargetLabel(result: GlobalChatResult, item: JsonObject, title: string) {
  const id = identifier(item)?.value;
  if (!id || title.includes(id)) return title;
  if (result.renderer === 'issue') return `${title} (#${id})`;
  if (result.renderer === 'proposal') return translate('chat:global.target.proposal', { title, id });
  if (result.renderer === 'session') return translate('chat:global.target.session', { title, id });
  return title;
}

function SettingInstruction({ item, title }: { item: JsonObject; title: string }) {
  const t = useMessages('chat');
  const [editing, setEditing] = useState(false);
  const [instruction, setInstruction] = useState('');
  const group = text(item.group || item.id, 80);
  if (!group || group === 'global-chat') return null;

  function submit() {
    const requested = instruction.trim();
    if (!requested) return;
    setInstruction('');
    setEditing(false);
    void sendGlobalChatMessage(
      `In the "${title}" settings group (key: ${group}), ${requested}. `
      + 'Preserve every value I did not ask to change, use only capabilities for this settings group, '
      + 'and show the exact confirmation before saving.',
    );
  }

  return editing ? (
    <form
      className="global-chat-setting-instruction"
      onSubmit={(event) => { event.preventDefault(); submit(); }}
    >
      <input
        value={instruction}
        maxLength={500}
        autoFocus
        aria-label={t('chat:global.setting.changeLabel', { setting: title })}
        placeholder={t('chat:global.setting.changePlaceholder', { setting: title })}
        onChange={(event) => setInstruction(event.target.value)}
      />
      <button type="submit" disabled={!instruction.trim()}>{t('chat:global.setting.continue')}</button>
      <button type="button" onClick={() => setEditing(false)}>{t('core:common.cancel')}</button>
    </form>
  ) : (
    <button type="button" className="global-chat-setting-edit" onClick={() => setEditing(true)}>
      {t('chat:global.setting.changeThese')}
    </button>
  );
}

const LOCAL_SETTING_EDITORS: Record<string, {
  setting: string;
  valueKey: string;
  /** `label` is a message id, read when the buttons render. */
  options: Array<{ label: string; value: string }>;
}> = {
  theme: {
    setting: 'theme', valueKey: 'theme',
    options: [
      { label: 'chat:global.setting.theme.system', value: 'system' },
      { label: 'chat:global.setting.theme.light', value: 'light' },
      { label: 'chat:global.setting.theme.dark', value: 'dark' },
    ],
  },
  alerts: {
    setting: 'devAlerts', valueKey: 'devAlerts',
    options: [{ label: 'chat:global.setting.alerts.on', value: 'true' }, { label: 'chat:global.setting.alerts.off', value: 'false' }],
  },
  'dev-console': {
    setting: 'devConsoleMode', valueKey: 'devConsoleMode',
    options: [
      { label: 'chat:global.setting.devConsole.always', value: 'always' },
      { label: 'chat:global.setting.devConsole.errorsOnly', value: 'errors-only' },
    ],
  },
  'admin-preview': {
    setting: 'adminPreview', valueKey: 'adminPreview',
    options: [{ label: 'chat:global.setting.adminPreview.on', value: 'true' }, { label: 'chat:global.setting.adminPreview.off', value: 'false' }],
  },
};

function LocalSettingEditor({ item, title }: { item: JsonObject; title: string }) {
  const t = useMessages('chat');
  const group = text(item.group || item.id, 80);
  const editor = LOCAL_SETTING_EDITORS[group];
  const initial = editor ? text(item[editor.valueKey], 40) : '';
  const [saved, setSaved] = useState(initial);
  const [selected, setSelected] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  if (!editor) return null;

  async function save() {
    if (!selected || selected === saved || saving) return;
    setSaving(true);
    setError('');
    try {
      const results = await loadGlobalChatInlineResults(
        'settings.local.update',
        { setting: editor.setting, value: selected },
        title,
      );
      const pending = results.find((result) => clientAction(result));
      if (!pending) throw new Error(t('chat:global.setting.notReturned'));
      const applied = await runGlobalChatClientAction(pending);
      if (!applied) throw new Error(t('chat:global.setting.applyFailed'));
      setSaved(selected);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('chat:global.setting.saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="global-chat-setting-controls" aria-label={t('chat:global.setting.controlsLabel', { setting: title })}>
      <div className="global-chat-inline-actions">
        {editor.options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={selected === option.value ? 'global-chat-action-primary' : ''}
            aria-pressed={selected === option.value}
            onClick={() => setSelected(option.value)}
          >
            {t(option.label)}
          </button>
        ))}
        <button
          type="button"
          disabled={!selected || selected === saved || saving}
          onClick={() => void save()}
        >
          {saving ? t('chat:global.setting.saving') : selected === saved ? t('chat:global.setting.saved') : t('chat:global.setting.save')}
        </button>
      </div>
      {error ? <div className="global-chat-inline-error" role="alert">{error}</div> : null}
    </div>
  );
}

function ItemRow({
  result,
  value,
  nested = false,
  itemSelection,
}: {
  result: GlobalChatResult;
  value: unknown;
  nested?: boolean;
  itemSelection?: GlobalChatItemSelection;
}) {
  // Subscribed: the row's labels are read in the language on screen.
  const t = useMessages('chat');
  const [expanded, setExpanded] = useState(nested);
  const [inlineResults, setInlineResults] = useState<Record<string, GlobalChatResult[]>>({});
  const [inlineLoading, setInlineLoading] = useState<string | null>(null);
  const [inlineError, setInlineError] = useState('');
  const item = object(value) || { value };
  const title = itemTitle(result, item);
  const targetLabel = actionTargetLabel(result, item, title);
  const summary = itemSummary(result, item, title);
  const meta = compactMetadata(result, item, title);
  const classicPath = itemClassicPath(result, item);
  const fields = displayFields(result, item);
  const showAppIcon = result.renderer === 'app' && !!text(item.slug || item.app_slug, 255);
  const selectedValue = itemSelection?.parameter === 'appSlug'
    ? resultAppSlug(result, item)
    : '';
  const selectionAction = itemSelection?.renderer === result.renderer && selectedValue
    ? itemAction(
      itemSelection.label,
      t('chat:global.item.selectRequest', { action: itemSelection.label, target: targetLabel }),
      itemSelection.actionId,
      { [itemSelection.parameter]: selectedValue },
      'turn',
    )
    : null;
  const directActions = nested ? [] : directItemActions(result, item, targetLabel);
  const catalogView = directActions.find((action) => action.actionId === 'settings.inspect');

  async function loadInline(action: DirectItemAction) {
    if (inlineLoading || inlineResults[action.actionId]) return;
    setInlineLoading(action.actionId);
    setInlineError('');
    try {
      const loaded = await loadGlobalChatInlineResults(
        action.actionId,
        action.parameters,
        targetLabel,
      );
      setInlineResults((current) => ({ ...current, [action.actionId]: loaded }));
    } catch (reason) {
      setInlineError(reason instanceof Error ? reason.message : t('chat:global.item.detailsFailed'));
    } finally {
      setInlineLoading(null);
    }
  }

  function toggleExpanded() {
    if (selectionAction) {
      void executeGlobalChatResultAction(
        selectionAction.requestLabel,
        selectionAction.actionId,
        selectionAction.parameters,
        targetLabel,
      );
      return;
    }
    const next = !expanded;
    setExpanded(next);
    if (next && catalogView) void loadInline(catalogView);
  }

  return (
    <article
      className={`global-chat-item${selectionAction ? ' global-chat-item-selector' : ''}`}
      data-expanded={selectionAction ? undefined : expanded || undefined}
    >
      {showAppIcon ? (
        <AppIconLink
          slug={text(item.slug || item.app_slug, 255)}
          name={text(item.name, 255)}
          className="app-icon-tile global-chat-app-icon shrink-0 overflow-hidden flex items-center justify-center text-lg font-bold"
          data-icon={appIconKind(item)}
        >
          <AppIconContent app={item} />
        </AppIconLink>
      ) : null}
      <div className="min-w-0 flex-1">
        <button
          type="button"
          className="global-chat-item-toggle"
          aria-expanded={selectionAction ? undefined : expanded}
          aria-label={selectionAction?.requestLabel}
          onClick={toggleExpanded}
        >
          <span className="min-w-0 flex-1 text-left">
            <span className="global-chat-item-title">{title}</span>
            {meta ? <span className="global-chat-item-meta">{meta}</span> : null}
          </span>
          {!selectionAction ? <ChevronDownIcon className="global-chat-item-chevron" aria-hidden="true" /> : null}
        </button>
        {!selectionAction && expanded ? (
          <div className="global-chat-item-details">
            {summary && summary !== title ? <p className="global-chat-item-summary">{summary}</p> : null}
            {fields.length ? (
              <dl className="global-chat-item-fields">
                {fields.map(({ label, value: fieldValue }) => (
                  <div key={label}><dt>{label}</dt><dd>{fieldValue}</dd></div>
                ))}
              </dl>
            ) : null}
            {!nested ? (
              <div className="global-chat-inline-actions">
                {directActions.filter((action) => action.actionId !== 'settings.inspect').map((action) => (
                  <button
                    key={action.actionId}
                    type="button"
                    disabled={inlineLoading === action.actionId}
                    onClick={() => action.mode === 'inline'
                      ? void loadInline(action)
                      : void executeGlobalChatResultAction(
                        action.requestLabel,
                        action.actionId,
                        action.parameters,
                        targetLabel,
                      )}
                  >
                    {inlineLoading === action.actionId ? t('chat:global.item.actionLoading') : action.label}
                  </button>
                ))}
                {classicPath ? <button type="button" onClick={() => closeGlobalChat(classicPath)}>{t('chat:global.openInClassic')}</button> : null}
              </div>
            ) : classicPath ? (
              <div className="global-chat-inline-actions">
                <button type="button" onClick={() => closeGlobalChat(classicPath)}>{t('chat:global.openInClassic')}</button>
              </div>
            ) : null}
            {inlineLoading === 'settings.inspect' ? (
              <div className="global-chat-inline-loading">{t('chat:global.item.loadingSettings')}</div>
            ) : null}
            {inlineError ? <div className="global-chat-inline-error" role="alert">{inlineError}</div> : null}
            {Object.values(inlineResults).flat().map((loaded) => (
              <GlobalChatResultBlock key={loaded.id} result={loaded} nested />
            ))}
            {result.renderer === 'setting' && result.capabilityId === 'settings.inspect'
              ? (LOCAL_SETTING_EDITORS[text(item.group || item.id, 80)]
                ? <LocalSettingEditor item={item} title={title} />
                : <SettingInstruction item={item} title={title} />)
              : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function ConfirmationResult({ result, payload }: { result: GlobalChatResult; payload: JsonObject }) {
  const t = useMessages('chat');
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
    return <div className="global-chat-confirmation global-chat-confirmation-muted">{t('chat:global.confirm.cancelled')}</div>;
  }
  return (
    <section className="global-chat-confirmation" aria-label={t('chat:global.confirm.label')}>
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
        {expiresAt ? <p>{t('chat:global.confirm.before', { time: new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}</p> : null}
      </div>
      <div className="global-chat-inline-actions">
        <button
          type="button"
          className="global-chat-action-primary"
          disabled={!token || consumed}
          onClick={() => void confirmGlobalChatAction(result, token)}
        >
          {consumed ? t('chat:global.confirm.confirmed') : t('chat:global.confirm.confirm')}
        </button>
        {!consumed ? <button type="button" onClick={() => dismissConfirmation(result.id)}>{t('core:common.cancel')}</button> : null}
        {result.classicPath ? <button type="button" onClick={() => closeGlobalChat(result.classicPath)}>{t('chat:global.openInClassic')}</button> : null}
      </div>
    </section>
  );
}

function ClientActionResult({ result }: { result: GlobalChatResult }) {
  const t = useMessages('chat');
  const snapshot = useGlobalChatState();
  const action = clientAction(result);
  if (!action) return null;
  const actionState = snapshot.clientActionStates[result.id];
  const navigation = action.transport === 'navigation';
  const localSetting = action.transport === 'local_setting';
  // #2779: development work opens an agent session with the task in its box;
  // the bare address would open one without them, so it is not offered.
  const agentHandoff = action.transport === 'agent_session_handoff';
  return (
    <div className="global-chat-inline-actions global-chat-client-action">
      <button
        type="button"
        className="global-chat-action-primary"
        disabled={actionState === 'running' || actionState === 'done'}
        onClick={() => void runGlobalChatClientAction(result)}
      >
        {actionState === 'running' ? t('chat:global.clientAction.applying')
          : actionState === 'done' ? t('chat:global.clientAction.done')
            : navigation ? t('chat:global.clientAction.openInClassic')
              : localSetting ? t('chat:global.clientAction.apply')
                : agentHandoff ? t('chat:global.clientAction.openAgentSession')
                  : t('chat:global.clientAction.open')}
      </button>
      {!navigation && !agentHandoff && result.classicPath ? <button type="button" onClick={() => closeGlobalChat(result.classicPath)}>{t('chat:global.openInClassic')}</button> : null}
    </div>
  );
}

export function GlobalChatResultBlock({
  result,
  nested = false,
  itemSelection,
}: {
  result: GlobalChatResult;
  nested?: boolean;
  itemSelection?: GlobalChatItemSelection;
}) {
  const t = useMessages('chat');
  const payload = unwrapped(result);
  const confirmation = object(payload)?.status === 'confirmation_required';
  const action = clientAction(result);
  const items = useMemo(() => action ? [] : findItems(payload), [action, payload]);
  const pageSize = result.renderer === 'app' ? 6 : 3;
  const [visibleCount, setVisibleCount] = useState(pageSize);
  if (confirmation) return <ConfirmationResult result={result} payload={object(payload) || {}} />;
  if (action) {
    return (
      <section
        className={`global-chat-result${nested ? ' global-chat-result-nested' : ''}`}
        data-renderer={result.renderer}
      >
        <header className="global-chat-result-head">
          <span>{action.transport === 'navigation' ? t('chat:global.result.openInClassic') : t('chat:global.result.readyToApply')}</span>
        </header>
        <ClientActionResult result={result} />
      </section>
    );
  }
  if (result.renderer === 'setting'
      && result.capabilityId === 'settings.inspect'
      && object(payload)?.group === 'global-chat') {
    return (
      <section
        className={`global-chat-result global-chat-result-settings${nested ? ' global-chat-result-nested' : ''}`}
        data-renderer="setting"
      >
        <header className="global-chat-result-head"><span>{t('chat:global.result.globalChatSettings')}</span></header>
        <GlobalChatSettingsEditor embedded />
        {result.classicPath ? (
          <div className="global-chat-inline-actions global-chat-client-action">
            <button type="button" onClick={() => closeGlobalChat(result.classicPath)}>{t('chat:global.openInClassic')}</button>
          </div>
        ) : null}
      </section>
    );
  }
  if (result.renderer === 'setting'
      && result.capabilityId === 'settings.inspect'
      && object(payload)?.group === 'openrouter') {
    return (
      <section
        className={`global-chat-result global-chat-result-settings${nested ? ' global-chat-result-nested' : ''}`}
        data-renderer="setting"
      >
        <header className="global-chat-result-head"><span>{t('chat:global.result.developmentSettings')}</span></header>
        <DevelopmentAISettingsEditor />
        {result.classicPath ? (
          <div className="global-chat-inline-actions global-chat-client-action">
            <button type="button" onClick={() => closeGlobalChat(result.classicPath)}>{t('chat:global.openInClassic')}</button>
          </div>
        ) : null}
      </section>
    );
  }

  const visible = items.slice(0, visibleCount);
  return (
    <section
      className={`global-chat-result${nested ? ' global-chat-result-nested' : ''}${itemSelection ? ' global-chat-result-selector' : ''}`}
      data-renderer={result.renderer}
    >
      <header className="global-chat-result-head">
        <span>{resultLabel(result)}</span>
      </header>
      {visible.length ? (
        <div className="global-chat-result-items">
          {visible.map((item, index) => (
            <ItemRow
              key={`${result.id}-${index}`}
              result={result}
              value={item}
              nested={nested}
              itemSelection={itemSelection}
            />
          ))}
        </div>
      ) : null}
      {items.length > visible.length ? (
        <button
          type="button"
          className="global-chat-expand"
          onClick={() => setVisibleCount((count) => Math.min(count + pageSize, items.length))}
        >
          {`${t('chat:global.result.showMore')} `}<ChevronDownIcon className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      ) : null}
      {!items.length ? (
        <div className="global-chat-result-done">{emptyResultMessage(result)}</div>
      ) : null}
    </section>
  );
}
