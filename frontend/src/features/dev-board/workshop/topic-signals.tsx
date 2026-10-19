/**
 * A TOPIC'S OPEN PROBLEMS, under its figures.
 *
 * The platform watches itself (services/platform-signals.js): a release that
 * stalled, a bot that keeps failing, a limit that keeps filling. What it
 * finds it files as a request on the project's board, under the topic it
 * belongs to, and keeps until it has stopped and stayed stopped. This is
 * where a member reading the topic sees them: one row each, saying what is
 * wrong and who has it, so nobody files the same thing again or wonders
 * whether anyone knows.
 *
 *   OPEN PROBLEMS
 *   ┌──────────────────────────────────────────────────────┐
 *   │ Release stalled: the deploy workflow failed        › │
 *   │ Homeroom bot is on it · first seen 3h ago · 4 times  │
 *   ├──────────────────────────────────────────────────────┤
 *   │ Checks could not start                     Details   │
 *   │ Waiting on infra · Stopped, waiting to be sure       │
 *   └──────────────────────────────────────────────────────┘
 *
 * The server words every row (GET /api/apps/:slug/topics/:key/signals), and
 * this draws what it is sent. A row whose problem has a request opens it,
 * by its title's link stretched over the row (as the Workshop's own rows
 * do, work-row.tsx), so a modified click and "Open in new tab" are the
 * browser's. A full admin is also sent the admin console section that shows
 * more, and gets a "Details" link to it, above the stretched link. No
 * status dot and no pill: the row's words say where it stands, and a
 * problem already in hand is not made the loudest thing on the page
 * (AGENTS.md, "Type and colour").
 *
 * Nothing renders until the list arrives, and an empty list, an error or a
 * retired topic draws nothing at all: zero says nothing. While a reply
 * thread is open beside the room the section steps aside, so the room and
 * the thread keep the space under the topic's line and figures.
 */

import { useEffect, useState, type ReactNode } from 'react';

import { GroupedList, ListRow, SectionHeader } from '@/components/ui/grouped-list';

import { useMessages } from '../../../lib/i18n/react';
import { agoStamp } from '../../../lib/timestamp';
import { issueRefHref } from '../../messages/channels';
import type { PlaceChannel } from './community-card';

/** One open problem, as the route sends it. Every word is the server's. */
export interface TopicSignal {
  id: number;
  kind: string;
  /** One line: "Release stalled: the deploy workflow failed". */
  title: string;
  /** Who has it: "Homeroom bot is on it", "Waiting for a person", "Waiting on infra". */
  whoText: string;
  who: 'bot' | 'person' | 'infra';
  /** `clearing`: it has stopped and is waiting out its quiet window. */
  state: 'open' | 'clearing';
  since: string;
  lastSeen: string;
  occurrences: number;
  /** The request on this project's board, once filed. */
  issueNumber: number | null;
  /** A full admin only: the admin console section that shows more. */
  adminSection: string | null;
}

export interface TopicSignalsPayload {
  topic: string;
  signals: TopicSignal[];
}

/** Where a topic's open problems are read from. Pure. */
export function signalsUrl(slug: string, key: string): string {
  return `/api/apps/${encodeURIComponent(slug)}/topics/${encodeURIComponent(key)}/signals`;
}

/** Where a full admin's "Details" goes. Pure. */
export function adminHref(section: string): string {
  return `#admin/${encodeURIComponent(section)}`;
}

/** One problem's row: its title, who has it, and how long and how often. */
function SignalRow({ slug, signal }: { slug: string; signal: TopicSignal }): ReactNode {
  const t = useMessages('project');
  const issue = Number(signal.issueNumber) > 0 ? Number(signal.issueNumber) : null;
  const href = issue ? issueRefHref(slug, String(issue)) : null;
  const section = signal.adminSection ? String(signal.adminSection) : null;
  const clearing = signal.state === 'clearing';
  const when = agoStamp(signal.since);
  const count = Number(signal.occurrences) || 0;
  return (
    <ListRow
      chevron={!!href && !section}
      data-topic-signal={signal.id}
      data-topic-signal-kind={signal.kind}
      data-topic-signal-state={signal.state}
      title={href ? (
        // The row's link, stretched over it; Details sits above it.
        <a href={href} className="text-inherit no-underline after:absolute after:inset-0 after:content-['']" data-topic-signal-issue={issue}>
          {signal.title}
        </a>
      ) : signal.title}
      subtitle={(
        <>
          {signal.whoText}
          {clearing ? <>{' · '}{t('project:places.topicSignals.clearing')}</> : null}
          {!clearing && when.text ? (
            <>{' · '}<time dateTime={signal.since} title={when.title}>{t('project:places.topicSignals.since', { when: when.text })}</time></>
          ) : null}
          {count > 1 ? <>{' · '}{t('project:places.topicSignals.times', { count })}</> : null}
        </>
      )}
      trailing={section ? (
        <a
          href={adminHref(section)}
          className="relative z-[1] shrink-0 text-[0.8125rem] font-semibold text-violet-700 no-underline hover:text-violet-800 dark:text-violet-300 dark:hover:text-violet-200"
          aria-label={t('project:places.topicSignals.detailsLabel', { title: signal.title })}
          data-topic-signal-admin={section}
        >
          {t('project:places.topicSignals.details')}
        </a>
      ) : null}
    />
  );
}

/**
 * The section itself, from a payload's list: the label over the card and a
 * row per problem. Nothing for an empty list. Pure.
 */
export function TopicSignalsView({ slug, handle, signals }: {
  slug: string;
  handle: string;
  signals: TopicSignal[];
}): ReactNode {
  const t = useMessages('project');
  if (!signals.length) return null;
  return (
    <section
      className="mb-2.5 flex-none [.dev-ws-discussion-threaded>&]:hidden"
      data-topic-signals={handle}
      aria-label={t('project:places.topicSignals.label')}
    >
      <SectionHeader className="flex min-h-8 items-center px-1 pb-0.5 pt-0">{t('project:places.topicSignals.label')}</SectionHeader>
      <GroupedList tone="plane" className="mx-0">
        {signals.map((signal) => <SignalRow key={signal.id} slug={slug} signal={signal} />)}
      </GroupedList>
    </section>
  );
}

export function TopicSignals({ slug, topic }: {
  slug: string;
  topic: PlaceChannel & { figures?: string[] | null };
}): ReactNode {
  const [signals, setSignals] = useState<TopicSignal[] | null>(null);
  const key = topic.key || '';
  const live = topic.state === 'live';

  // Another topic starts over: nothing until its own list arrives.
  useEffect(() => {
    setSignals(null);
  }, [slug, key]);

  useEffect(() => {
    if (!slug || !key || !live) return undefined;
    let current = true;
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    fetch(signalsUrl(slug, key), ctl ? { signal: ctl.signal } : undefined)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        // A late answer for a topic no longer on show is dropped.
        if (!current || !body || body.topic !== key || !Array.isArray(body.signals)) return;
        setSignals(body.signals as TopicSignal[]);
      })
      .catch(() => { /* nothing drawn: the channel reads the same without it */ });
    return () => {
      current = false;
      ctl?.abort();
    };
  }, [slug, key, live]);

  if (!live || !signals || !signals.length) return null;
  return <TopicSignalsView slug={slug} handle={topic.handle} signals={signals} />;
}
