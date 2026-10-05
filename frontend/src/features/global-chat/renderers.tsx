import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
import { Message, Localized, message as catalogText } from "../../lib/i18n/react";
import { useMemo, useState } from 'react';

import { ChevronDownIcon } from '@/components/ui/icons';
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

function rendererLabel(renderer: string) {
  const labels: Record<string, string> = {
    get app() { return tr("community:app_0d04bfeb"); }, get issue() { return tr("community:request_59f03d64"); }, get proposal() { return tr("community:proposal_5d42766c"); }, get session() { return tr("community:development_21b6a798"); },
    get conversation() { return tr("community:conversation_ccca1817"); }, get notification() { return tr("community:notification_7d31b833"); }, get profile() { return tr("community:profile_d696a35b"); },
    get leaderboard() { return tr("community:leaderboard_31b47121"); }, get challenge() { return tr("community:challenge_27cf1792"); }, get wallet() { return tr("community:wallet_d1c9a01d"); },
    get staking() { return tr("community:staking_5190ff48"); }, get setting() { return tr("community:setting_818cd8d9"); }, get admin_record() { return tr("community:admin_c1c224b0"); }, get status() { return tr("community:result_6e7d50e8"); },
    get error() { return tr("community:error_54a0e8c1"); }, get form() { return tr("community:form_2e0e960a"); }, get grouped_list() { return tr("community:results_219c4a6c"); }, get confirmation() { return tr("community:confirmation_d7430705"); },
  };
  return labels[renderer] || tr("community:result_6e7d50e8");
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
  if (typeof value === 'boolean') return value ? tr("community:yes_85a39ab3") : tr("community:no_1ea442a1");
  if (/activitySecondsLast7Days/.test(key)) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
      if (seconds < 60) return tr("community:value1_sec_984d1397", { value1: Math.round(seconds) });
      if (seconds < 3600) return tr("community:value1_min_af34cffe", { value1: Math.round(seconds / 60) });
      return tr("community:value1_hr_0bb6d2b1", { value1: (seconds / 3600).toFixed(seconds < 36_000 ? 1 : 0) });
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
    const label = notificationCopy(item)?.label || (kind ? humanize(kind) : tr("community:notification_7d31b833"));
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
  return id ? `${rendererLabel(result.renderer)} ${id}` : rendererLabel(result.renderer);
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
      ? tr("community:github_issues_b1f5866f")
      : tr("community:platform_issues_35216768");
  }
  if (result.capabilityId === 'apps.activity') return tr("community:recent_app_activity_548cacca");
  if (result.capabilityId === 'messages.for_app') return tr("community:app_discussions_396aa1f9");
  return rendererLabel(result.renderer);
}

function emptyResultMessage(result: GlobalChatResult) {
  const messages: Record<string, string> = {
    get app() { return tr("community:no_apps_found_4a081d54"); },
    get issue() { return tr("community:no_issues_found_050dc004"); },
    get proposal() { return tr("community:no_current_proposals_ea84049a"); },
    get session() { return tr("community:no_active_development_found_0bf8f648"); },
    get conversation() { return tr("community:no_conversations_found_d444e99d"); },
    get notification() { return tr("community:no_notifications_found_9dd3c8fb"); },
    get leaderboard() { return tr("community:no_leaderboard_entries_found_7dfdebc2"); },
    get setting() { return tr("community:no_settings_found_6e42a971"); },
  };
  return messages[result.renderer] || tr("community:no_results_found_7ecdbfee");
}

function humanizeCapability(value: string) {
  return value
    .replace(/\.[a-f0-9]{8}$/i, '')
    .split(/[._-]+/)
    .filter((part) => !['get', 'post', 'put', 'patch', 'delete', 'item'].includes(part))
    .slice(1)
    .join(' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase()) || tr("community:this_action_1aa2b739");
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
      itemAction(tr("community:details_45989de4"), tr("community:about_value1_fd098734", { value1: targetLabel }), 'apps.detail', { appSlug: slug }, 'inline'),
      itemAction(tr("community:issues_666067dd"), tr("community:issues_for_value1_a827d432", { value1: targetLabel }), 'issues.for_app', { appSlug: slug }, 'turn'),
      itemAction(tr("community:discussions_60157cfc"), tr("community:discussions_in_value1_6df01c46", { value1: targetLabel }), 'messages.for_app', { appSlug: slug }, 'turn'),
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
        itemAction(tr("community:details_45989de4"), tr("community:open_value1_839d6dee", { value1: targetLabel }), 'issue.detail', { appSlug: slug, issueNumber }, 'inline'),
        itemAction(tr("community:comments_355f79f2"), tr("community:comments_on_value1_3f7fe57d", { value1: targetLabel }), 'issue.comments', { appSlug: slug, issueNumber }, 'inline'),
      ];
    }
    if (governanceId) {
      return [itemAction(
        tr("community:details_45989de4"), tr("community:open_value1_839d6dee", { value1: targetLabel }), 'governance.detail',
        { appSlug: slug, governanceId }, 'inline',
      )];
    }
  }
  if (result.renderer === 'proposal' && slug) {
    const governanceId = text(item.governanceId || item.governance_id || item.id, 80);
    if (item.proposalType === 'governance' && governanceId) {
      return [itemAction(
        tr("community:details_45989de4"), tr("community:open_value1_839d6dee", { value1: targetLabel }), 'governance.detail',
        { appSlug: slug, governanceId }, 'inline',
      )];
    }
    const proposalId = first(item, ['proposalId', 'proposal_id', 'id', 'sessionId', 'session_id'], 80);
    if (proposalId) return [
      itemAction(tr("community:details_45989de4"), tr("community:open_value1_839d6dee", { value1: targetLabel }), 'proposal.detail', { appSlug: slug, proposalId }, 'inline'),
      itemAction('Before & after', tr("community:before_after_for_value1_4ba43dff", { value1: targetLabel }), 'proposal.shots', { appSlug: slug, proposalId }, 'inline'),
    ];
  }
  if (result.renderer === 'session') {
    const sessionId = first(item, ['sessionId', 'session_id', 'id'], 80);
    if (sessionId) return [
      itemAction(tr("community:details_45989de4"), tr("community:details_for_value1_5d2ce814", { value1: targetLabel }), 'session.detail', { sessionId }, 'inline'),
      itemAction(tr("community:checks_de07d072"), tr("community:checks_for_value1_e09fee46", { value1: targetLabel }), 'session.checks', { sessionId }, 'inline'),
    ];
  }
  if (result.renderer === 'conversation') {
    if (result.capabilityId === 'messages.for_app') return [];
    const conversationId = first(item, ['conversationId', 'conversation_id', 'id'], 80);
    if (conversationId) return [itemAction(
      tr("community:details_45989de4"), tr("community:open_value1_839d6dee", { value1: targetLabel }), 'conversation.detail', { conversationId }, 'inline',
    )];
  }
  if (result.renderer === 'notification') {
    const notificationId = first(item, ['notificationId', 'notification_id', 'id'], 80);
    if (notificationId) return [itemAction(
      tr("community:details_45989de4"), tr("community:open_value1_839d6dee", { value1: targetLabel }), 'notification.detail', { notificationId }, 'inline',
    )];
  }
  if (result.renderer === 'leaderboard') {
    const userId = first(item, ['userId', 'user_id', 'id'], 80);
    const username = text(item.username, 80);
    return [
      ...(userId ? [itemAction(
        tr("community:profile_d696a35b"), tr("community:profile_for_value1_d58c2634", { value1: targetLabel }), 'leaderboard.profile', { userId }, 'inline',
      )] : []),
      ...(username ? [itemAction(
        tr("community:merged_work_e49b606e"), tr("community:merged_work_by_value1_b36948e5", { value1: targetLabel }), 'leaderboard.prs', { username }, 'inline',
      )] : []),
    ];
  }
  if (result.renderer === 'setting' && result.capabilityId === 'settings.catalog') {
    const group = text(item.id || item.group, 80);
    if (group && text(item.classicPath, 300)) return [itemAction(
      tr("community:view_dcc839a4"), tr("community:open_value1_839d6dee", { value1: targetLabel }), 'settings.inspect', { group }, 'inline',
    )];
  }
  return [];
}

function itemClassicPath(result: GlobalChatResult, item: JsonObject) {
  const base = result.classicPath;
  if (!base) return null;
  const exactTopic = /\/dev\/(?:issues|proposals|sessions)\/[A-Za-z0-9%-]+$/.test(base)
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
    parts.push(item.readAt || item.read_at ? tr("community:read_9b9a8d05") : tr("community:unread_1b9f384c"));
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
      add('Messages (7d)', ['messagesLast7Days']);
      add(tr("community:active_time_7d_a454349f"), ['activitySecondsLast7Days']);
      add(tr("community:active_users_d8fc11b0"), ['activeUsers', 'active_users']);
      add(tr("community:development_21b6a798"), ['activeDevelopment', 'active_development', 'active_sessions']);
    } else {
      add(tr("community:open_issues_28aa0023"), ['openIssues', 'open_issues']);
      add(tr("community:open_proposals_23caaccd"), ['openProposals', 'open_proposals', 'open_prs']);
      add(tr("community:active_development_6e3c9235"), ['activeDevelopment', 'active_development', 'active_sessions']);
    }
  } else if (result.renderer === 'proposal') {
    add(tr("community:app_0d04bfeb"), ['appName', 'app_name']);
    add(tr("community:yes_85a39ab3"), ['yesCount', 'yes_count', 'upCount', 'up_count']);
    add(tr("community:no_1ea442a1"), ['noCount', 'no_count', 'downCount', 'down_count']);
    add(tr("community:checks_de07d072"), ['checkState', 'check_state']);
  } else if (result.renderer === 'session') {
    add(tr("community:app_0d04bfeb"), ['appName', 'app_name']);
    add(tr("community:checks_de07d072"), ['checkState', 'check_state']);
    add(tr("community:phase_46342ec1"), ['checkPhase', 'check_phase']);
  } else if (result.renderer === 'conversation') {
    add(tr("community:unread_1b9f384c"), ['unreadCount', 'unread_count']);
    add(tr("community:members_1044a4c0"), ['memberCount', 'member_count']);
  } else if (result.renderer === 'notification') {
    add(tr("community:from_21819769"), ['sourceUsername', 'source_username']);
    add('PR', ['prNumber', 'pr_number']);
  } else if (result.renderer === 'leaderboard') {
    add(tr("community:kudos_51483eb0"), ['kudosReceived', 'kudos_received']);
    add(tr("community:prs_recognized_512a9981"), ['prsKudosed', 'prs_kudosed']);
    add(tr("community:merged_bd0a0620"), ['kudosReceivedPrsMerged', 'kudos_received_prs_merged']);
  } else if (result.renderer === 'setting') {
    const spending = text(item.name, 100) === 'Global Chat usage';
    if (spending) {
      add(tr("community:spent_this_month_26bbf64a"), ['spentUsd']);
      add(tr("community:monthly_cap_013025a3"), ['capUsd']);
      add(tr("community:cap_remaining_d6a2ad28"), ['remainingUsd']);
      add(tr("community:openrouter_remaining_83f16d33"), ['overallRemainingUsd']);
    } else {
      add(tr("community:model_5e2c614c"), ['profile.model', 'backends.codex_openrouter.model', 'model']);
      add(tr("community:reasoning_d8211e24"), ['profile.reasoningEffort', 'reasoningEffort', 'reasoning_effort']);
      add(tr("community:enabled_92c1cdfd"), ['profile.enabled', 'enabled']);
      add(tr("community:spent_this_month_26bbf64a"), ['usage.spentUsd', 'spentUsd']);
      add(tr("community:monthly_cap_013025a3"), ['usage.capUsd', 'profile.spendCapUsd', 'capUsd']);
      add(tr("community:openrouter_remaining_83f16d33"), ['overallRemaining', 'overallRemainingUsd']);
      add(tr("community:backend_2fb4019a"), ['backend', 'profile.backend']);
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
  if (result.renderer === 'proposal') return tr("community:value1_proposal_value2_172b0788", { value1: title, value2: id });
  if (result.renderer === 'session') return tr("community:value1_development_value2_42e043b3", { value1: title, value2: id });
  return title;
}

function SettingInstruction({ item, title }: { item: JsonObject; title: string }) {
  useUiLanguage();
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
      tr("community:in_the_value1_settings_group_key_value2_value3_e57efdab", { value1: title, value2: group, value3: requested })
      + tr("community:preserve_every_value_i_did_not_ask_to_change_use_8d4e97f9")
      + tr("community:and_show_the_exact_confirmation_before_saving_d933434d"),
    );
  }

  return editing ? (
    <form
      className="global-chat-setting-instruction"
      onSubmit={(event) => { event.preventDefault(); submit(); }}
    >
      <LocalizedDynamic element={<input
        value={instruction}
        maxLength={500}
        autoFocus
        aria-label={tr("community:change_value1_2c7346eb", { value1: title })}
        placeholder={tr("community:what_should_change_in_value1_915dc563", { value1: title })}
        onChange={(event) => setInstruction(event.target.value)}
      />} resolve={() => ({ get "aria-label"() { return tr("community:change_value1_2c7346eb", { value1: title }); }, get "placeholder"() { return tr("community:what_should_change_in_value1_915dc563", { value1: title }); } })} />
      <button type="submit" disabled={!instruction.trim()}><Message id="community:continue_31fbef16" /></button>
      <button type="button" onClick={() => setEditing(false)}><Message id="community:cancel_19766ed6" /></button>
    </form>
  ) : (
    <button type="button" className="global-chat-setting-edit" onClick={() => setEditing(true)}><Message id="community:change_these_settings_47a0b043" /></button>
  );
}

const LOCAL_SETTING_EDITORS: Record<string, {
  setting: string;
  valueKey: string;
  options: Array<{ label: string; value: string }>;
}> = {
  theme: {
    setting: 'theme', valueKey: 'theme',
    options: [
      { get label() { return tr("community:system_6725e7bb"); }, value: 'system' },
      { get label() { return tr("community:light_dbcd5e7b"); }, value: 'light' },
      { get label() { return tr("community:dark_60acc53f"); }, value: 'dark' },
    ],
  },
  alerts: {
    setting: 'devAlerts', valueKey: 'devAlerts',
    options: [{ get label() { return tr("community:on_13001175"); }, value: 'true' }, { get label() { return tr("community:off_ca7981b4"); }, value: 'false' }],
  },
  'dev-console': {
    setting: 'devConsoleMode', valueKey: 'devConsoleMode',
    options: [
      { get label() { return tr("community:always_de9f057a"); }, value: 'always' },
      { get label() { return tr("community:errors_only_30767c16"); }, value: 'errors-only' },
    ],
  },
  'admin-preview': {
    setting: 'adminPreview', valueKey: 'adminPreview',
    options: [{ get label() { return tr("community:on_13001175"); }, value: 'true' }, { get label() { return tr("community:off_ca7981b4"); }, value: 'false' }],
  },
};

function LocalSettingEditor({ item, title }: { item: JsonObject; title: string }) {
  useUiLanguage();
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
      if (!pending) throw new Error(tr("community:the_setting_update_was_not_returned_4df3fa3d"));
      const applied = await runGlobalChatClientAction(pending);
      if (!applied) throw new Error(tr("community:could_not_apply_this_setting_46944d3a"));
      setSaved(selected);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : tr("community:could_not_save_this_setting_9159403b"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <LocalizedDynamic element={<div className="global-chat-setting-controls" aria-label={tr("community:change_value1_2c7346eb", { value1: title })}>
      <div className="global-chat-inline-actions">
        {editor.options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={selected === option.value ? 'global-chat-action-primary' : ''}
            aria-pressed={selected === option.value}
            onClick={() => setSelected(option.value)}
          >
            {option.label}
          </button>
        ))}
        <button
          type="button"
          disabled={!selected || selected === saved || saving}
          onClick={() => void save()}
        >
          <LocalizedValue render={() => (saving ? tr("community:saving_23e39291") : selected === saved ? tr("community:saved_b5c120b3") : tr("community:save_1509f561"))} />
        </button>
      </div>
      {error ? <div className="global-chat-inline-error" role="alert">{error}</div> : null}
    </div>} resolve={() => ({ get "aria-label"() { return tr("community:change_value1_2c7346eb", { value1: title }); } })} />
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
  useUiLanguage();
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
      `${itemSelection.label} ${targetLabel}`,
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
      setInlineError(reason instanceof Error ? reason.message : tr("community:could_not_load_those_details_bb039255"));
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
                {fields.map(({ label, value: fieldValue }, index) => (
                  <div key={index}><dt>{label}</dt><dd>{fieldValue}</dd></div>
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
                    <LocalizedValue render={() => (inlineLoading === action.actionId ? tr("community:loading_ba3bbbe1") : action.label)} />
                  </button>
                ))}
                {classicPath ? <button type="button" onClick={() => closeGlobalChat(classicPath)}><Message id="community:open_in_classic_58aad219" /></button> : null}
              </div>
            ) : classicPath ? (
              <div className="global-chat-inline-actions">
                <button type="button" onClick={() => closeGlobalChat(classicPath)}><Message id="community:open_in_classic_58aad219" /></button>
              </div>
            ) : null}
            {inlineLoading === 'settings.inspect' ? (
              <div className="global-chat-inline-loading"><Message id="community:loading_current_settings_81c719a7" /></div>
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
    return <div className="global-chat-confirmation global-chat-confirmation-muted"><Message id="community:cancelled_4b5ea033" /></div>;
  }
  return (
    <Localized element={<section className="global-chat-confirmation" aria-label={catalogText("community:confirm_action_b49a9604")}>
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
        {expiresAt ? <p><Message after={" "} id="community:confirm_before_dc4ff380" />{new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.</p> : null}
      </div>
      <div className="global-chat-inline-actions">
        <button
          type="button"
          className="global-chat-action-primary"
          disabled={!token || consumed}
          onClick={() => void confirmGlobalChatAction(result, token)}
        >
          <LocalizedValue render={() => (consumed ? tr("community:confirmed_fe00b67b") : tr("community:confirm_eebdd24a"))} />
        </button>
        {!consumed ? <button type="button" onClick={() => dismissConfirmation(result.id)}><Message id="community:cancel_19766ed6" /></button> : null}
        {result.classicPath ? <button type="button" onClick={() => closeGlobalChat(result.classicPath)}><Message id="community:open_in_classic_58aad219" /></button> : null}
      </div>
    </section>} messages={{"aria-label":"community:confirm_action_b49a9604"}} />
  );
}

function ClientActionResult({ result }: { result: GlobalChatResult }) {
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
        <LocalizedValue render={() => (actionState === 'running' ? tr("community:applying_3329a9bb") : actionState === 'done' ? tr("community:done_11a6767d") : navigation ? tr("community:open_in_classic_58aad219") : localSetting ? tr("community:apply_31e392d1") : agentHandoff ? tr("community:open_agent_session_912e7429") : tr("community:open_ed077f3d"))} />
      </button>
      {!navigation && !agentHandoff && result.classicPath ? <button type="button" onClick={() => closeGlobalChat(result.classicPath)}><Message id="community:open_in_classic_58aad219" /></button> : null}
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
  useUiLanguage();
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
          <span><LocalizedValue render={() => (action.transport === 'navigation' ? tr("community:open_in_classic_58aad219") : tr("community:ready_to_apply_8a325d63"))} /></span>
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
        <header className="global-chat-result-head"><span><Message id="community:global_chat_settings_458c75ca" /></span></header>
        <GlobalChatSettingsEditor embedded />
        {result.classicPath ? (
          <div className="global-chat-inline-actions global-chat-client-action">
            <button type="button" onClick={() => closeGlobalChat(result.classicPath)}><Message id="community:open_in_classic_58aad219" /></button>
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
        <header className="global-chat-result-head"><span><Message id="community:development_ai_settings_f0ae8065" /></span></header>
        <DevelopmentAISettingsEditor />
        {result.classicPath ? (
          <div className="global-chat-inline-actions global-chat-client-action">
            <button type="button" onClick={() => closeGlobalChat(result.classicPath)}><Message id="community:open_in_classic_58aad219" /></button>
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
        ><Message after={" "} id="community:show_more_f5c9bd13" /><ChevronDownIcon className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      ) : null}
      {!items.length ? (
        <div className="global-chat-result-done">{emptyResultMessage(result)}</div>
      ) : null}
    </section>
  );
}
