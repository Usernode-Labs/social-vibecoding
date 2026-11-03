/**
 * #ai-screen — the AI tab's main view (#6019 follow-up; plan v3, "the
 * Homeroom bot tab: what needs you comes first, then your private threads,
 * with a lock on the tile, then Up next: what's moving without you, soonest
 * first. Ask Homeroom bot opens Main"). Needs you here is only the threads
 * you are in; Communities › Needs you has every decision you owe.
 *
 * 29 Oct 2026 (Evan): the first list is Needs you, since it holds other
 * people's threads too, and only what waits on you; In progress is what is
 * being worked on; what waits on someone else (other people's votes, a free
 * builder or slot) is Waiting. 30 Oct 2026, from his Task Assistant
 * prototype: one line a row, grouped by project, on three sheets, with a
 * chip for each project (./lists.tsx draws them):
 *
 *   [bot] Homeroom bot             Needs you: 2 · In progress: 1
 *   ( All ) ( Garden club ) ( Bread bot )
 *
 *   NEEDS YOU · 2
 *   [tile] Garden club
 *     ☑ #403  Dark mode                                     Vote
 *     ▶ #410  A reminder email                          Build it
 *   ─────────
 *   IN PROGRESS · 1
 *   ─────────
 *   WAITING · 2
 *
 *   LIVE THIS WEEK · 1
 *   ( Ask Homeroom bot )                  ← a phone: Main
 *
 * THE LIST AND ONE THREAD (1 Nov 2026). Main Chat, the private conversation
 * with the bot, is the list's first row, and this page is the only place it
 * is drawn: every way into it lands here (./door.ts), never on the Messages
 * screen. From 768px the column beside the list holds one thing at a time:
 * Main Chat, or one private thread, alone under its own head (its name and
 * "Only you can see this thread"; ReplyThreadPanel `inMain`), and the row
 * of whichever it is is drawn lit. Main Chat is a row, so a thread has no
 * way back to it of its own. On a phone the list and the column are one
 * drawer, as Messages' list and a conversation are (./phone-drawer.tsx):
 * the column peeks at the list's right, a row or the Ask bar slides it in,
 * and a thread's back arrow slides the list back.
 *
 * A REQUEST, A CHANGE OR A DECISION OPENS HERE TOO. On a wide window in the
 * column beside the list, in Main's place: the side panel, drawn as this
 * page's own column (‹ Main Chat and the page's own name over it, no
 * Expand, no Close; ../side-panel/side-panel.tsx), and Main's composer
 * takes it as the item a question is about. Anywhere else on its page,
 * whose back chip says ‹ Homeroom bot and comes back here, with the
 * project's Workshop beside it (Improve.enterTopicFrom), and the tab bar
 * keeps Homeroom bot lit (App._isBotTopic). The phone's drawer holds only
 * Main and its threads (Evan, 30 Oct: "the Messages approach").
 *
 * A DESIGN'S PREVIEW IS A COLUMN OF ITS OWN (1 Nov 2026, threads, one loop
 * C1). Any private thread can hold a design; a version said in it shows
 * small with Open preview (../messages/design-card.tsx), and the preview
 * (the design pane) opens beside the thread (./preview.ts): list | thread |
 * preview where the three fit, the thread and the preview in halves where
 * they do not (the list steps aside; the tab, or the preview's ×, brings it
 * back), the whole screen on a phone, with a back arrow to the thread. It
 * goes when the column shows anything else.
 *
 * THE FIRST RENDER IS THE PRERENDER: the screen hidden, the bot's name and
 * no rows. The lists load in effects once the screen is shown to somebody
 * signed in, and the docked pane and the drawer exist only after mount.
 * While the screen is up they are read again whenever a thread they list
 * moves (./live.ts), not only when it is shown again.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { LockIcon, MicrophoneIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { KEPT_DRAW_MS, keepCopy, keptCopy } from '../../lib/kept-copies';
import { FRESH } from '../../lib/live-reads';
import { useStoreState } from '../../lib/use-store-state';
import { useVisibility, useVisibilityHiddenClass } from '../../lib/visibility-store';
import { EmbeddedConversation } from '../messages';
import { DesignPane } from '../messages/design-pane';
import { closeNewThread, NewThreadButton, useNewThread } from '../messages/new-thread';
import { keptConversations, openBotConversation } from '../messages/api';
import { BOT_AVATAR } from '../messages/format';
import { closeThread, useMessagesSnapshot } from '../messages/store';
import { SidePanelDivider } from '../side-panel/side-panel';
import { AI_MAIN_WIDTH_KEY } from '../side-panel/resize';
import { sidePanelStore } from '../side-panel/store.js';
import { attachmentFor, columnAddress, columnKey, routeOf, type Column, type ColumnHow } from './column';
import {
  BOT_TAB, botItemFromRoute, botItemRoute, botTabAddress, knownBotConversation, noteBotConversation, useBotTabAsk,
  type BotAt, type BotItem,
} from './door';
import { useLiveLists } from './live';
import { AiLists } from './lists';
import { publishBotDrawer, registerBotBack } from '../nav-drawer/bot-drawer';
import { AiDrawer, MainPane, usePhone } from './phone-drawer';
import { closePreview, previewLayout, THREE_COLUMNS, usePreview } from './preview';
import {
  heroWords, inProgress, isTopicHref, liveThisWeek, needsYou, owedCount, rankProjects, upNext,
  type AiApp, type AiThread, type AiWork, type NeedItem, type Phrase, type WorkRow,
} from './model';

// 1 Nov 2026: the column is docked from 768px, where a phone's drawer ends.
const WIDE = '(min-width: 768px)';
/** This page's address: where a thread opened from it comes back to. */
const BOT_PAGE = BOT_TAB;

function demoQuery(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('demo') === '1' ? '?demo=1' : '';
}

/** A read of the lists: its answer when it was one, and whether the server answered at all. */
interface ListRead<T> {
  data: T | null;
  reached: boolean;
}

async function readJson<T>(path: string, init?: RequestInit): Promise<ListRead<T>> {
  try {
    const res = await fetch(path, { ...init, credentials: 'same-origin' });
    return { data: res.ok ? ((await res.json()) as T) : null, reached: true };
  } catch {
    return { data: null, reached: false };
  }
}

/**
 * Why the lists show less than they should: nothing read and nothing kept
 * for one of them, with no answer from the server ('unreachable') or with
 * an error ('failed'). Null when every list has something to draw.
 */
export type ListsFailure = 'unreachable' | 'failed' | null;

function useWide(at: string = WIDE): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const query = window.matchMedia(at);
    const sync = () => setWide(query.matches);
    sync();
    query.addEventListener?.('change', sync);
    return () => query.removeEventListener?.('change', sync);
  }, [at]);
  return wide;
}

function go(href: string | null): void {
  if (href && typeof window !== 'undefined') window.location.hash = href.replace(/^#/, '');
}

/**
 * The address says what the column shows, in place: a row pressed here is
 * no step for Back to take (as it was not before), but a reload reopens it.
 * Only while the address is this page's.
 */
function showAddress(href: string): void {
  if (typeof window === 'undefined' || !/^#(homeroom-bot|ai)(\/|$)/.test(window.location.hash)) return;
  if (window.location.hash === href) return;
  try {
    history.replaceState(history.state, '', `${window.location.pathname}${window.location.search}${href}`);
  } catch { /* the column still shows it */ }
}

/** The side panel's controller (features/side-panel/), when the shell has one. */
function sidePanel(): {
  take?: (route: string, hint?: { place?: AiApp | null; label?: string | null } | null) => boolean;
  close?: () => void;
} | null {
  return typeof window === 'undefined' ? null : (window as any).UsernodeReact?.sidePanel || null;
}

/**
 * What a row opens, as the item Main's composer can carry (the ◆ chip a
 * shared item gets): a request by its number, a change by its session, a
 * decision by its id. Null for a page that is none of those (a Workshop).
 */
export interface AboutItem {
  type: 'issue' | 'proposal' | 'governance';
  appSlug: string;
  issueNumber?: number;
  sessionId?: number;
  proposalId?: number;
  title: string | null;
}
export function aboutRow(row: { key?: string; href: string | null; title?: string | null; app: AiApp | null; change?: { id: number } | null }): AboutItem | null {
  const slug = row.app?.slug;
  if (!slug) return null;
  const title = row.title || null;
  const issue = String(row.href || '').match(/^#?app\/[^/]+\/dev\/issues\/(\d+)$/);
  if (issue) return { type: 'issue', appSlug: slug, issueNumber: Number(issue[1]), title };
  const need = String(row.key || '').match(/^need:(proposal|governance):(\d+)$/);
  if (need?.[1] === 'proposal') return { type: 'proposal', appSlug: slug, sessionId: Number(need[2]), title };
  if (need?.[1] === 'governance') return { type: 'governance', appSlug: slug, proposalId: Number(need[2]), title };
  if (row.change?.id) return { type: 'proposal', appSlug: slug, sessionId: row.change.id, title };
  return null;
}

/** The Improve controller, which records where a topic page was opened from. */
function improve(): { enterTopicFrom?: (href: string) => void } | null {
  return typeof window === 'undefined' ? null : (window as any).Improve || null;
}

/**
 * A request, a change or a decision, opened from the list. On a wide
 * window in the column beside the list, in Main's place (the side panel,
 * drawn as this page's column: ‹ Main Chat and the page's name over it);
 * anywhere else, and whenever the panel does not take it, its page, which
 * goes back here.
 */
function openPublic(href: string | null, app: AiApp | null, label: string | null): boolean {
  if (!href) return false;
  try {
    // Main's composer takes what was opened (./column.ts attachmentFor),
    // once the column says it is this page.
    if (sidePanel()?.take?.(href.replace(/^#/, ''), { place: app, label })) return true;
  } catch {
    /* the page instead */
  }
  if (isTopicHref(href)) improve()?.enterTopicFrom?.(BOT_PAGE);
  go(href);
  return false;
}

/** Pure: the item a page's route is, for Main's composer, when no row named it (a reload). */
export function aboutRoute(route: string | null): AboutItem | null {
  const item = botItemFromRoute(route);
  if (!item || item.kind !== 'request') return null;
  return { type: 'issue', appSlug: item.slug, issueNumber: item.number, title: null };
}

export function AiScreen(): ReactNode {
  const t = useMessages('messages');
  const say = (p: Phrase) => t(p.id, p.values);
  const screenRef = useRef<HTMLElement | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  useVisibilityHiddenClass(screenRef, 'ai-screen', false);
  const visible = useVisibility('ai-screen', false);
  const wide = useWide();
  const [work, setWork] = useState<AiWork | null>(null);
  const [needs, setNeeds] = useState<NeedItem[] | null>(null);
  const [botId, setBotId] = useState<number | null>(null);
  const [at, setAt] = useState<{ threadRootId: number | null; focusMessageId: number | null } | null>(null);
  // A phone: the list and Main are one drawer (./phone-drawer.tsx); level 1 is Main.
  const phone = usePhone();
  const [level, setLevel] = useState<0 | 1>(0);
  // A boot from the saved session draws this page before the server has
  // confirmed who you are, and a read made in that window can come back
  // with nothing; so could the chat docked beside it. `sv:session` (app.js)
  // is the shell saying who is signed in, so both are asked again then,
  // rather than staying empty until a reload (29 Oct 2026).
  const [session, setSession] = useState(0);
  useEffect(() => {
    const again = () => setSession((n) => n + 1);
    document.addEventListener('sv:session', again);
    return () => document.removeEventListener('sv:session', again);
  }, []);

  // Read on every showing: what is yours changes while you are elsewhere.
  // And again while the page is up, each time a thread it lists moves
  // (./live.ts counts those in `moved`). Every read after the first asks
  // past the service worker's saved copy, since it is for what changed
  // since; one that fails keeps the lists as they were.
  //
  // Offline (offline test, 2 Nov 2026), a list with nothing drawn yet draws
  // the copy this device kept of it (../../lib/kept-copies.ts: GET
  // /api/ai/work answers `no-store`, so the worker keeps none), and one with
  // no copy either says so over Needs you, with Try again (`failed`),
  // instead of leaving an empty card. A list with nothing drawn draws its
  // copy once its read has gone KEPT_DRAW_MS unanswered too, the read still
  // going: a network that carries nothing answers no read for 15 s.
  const [moved, setMoved] = useState(0);
  const [failed, setFailed] = useState<ListsFailure>(null);
  const readBefore = useRef(false);
  const drawn = useRef({ work, needs });
  drawn.current = { work, needs };
  useEffect(() => {
    if (!visible || typeof window === 'undefined' || !(window as any).App?.user) return undefined;
    let live = true;
    const qs = demoQuery();
    const again = readBefore.current;
    readBefore.current = true;
    const init = again ? FRESH : undefined;
    const early = setTimeout(() => {
      if (!live) return;
      const keptWork = drawn.current.work ? null : keptCopy<AiWork>('ai:work');
      const keptNeeds = drawn.current.needs ? null : keptCopy<NeedItem[]>('ai:needs');
      if (keptWork) setWork(keptWork);
      if (Array.isArray(keptNeeds)) setNeeds(keptNeeds);
    }, KEPT_DRAW_MS);
    // Each list as it lands; the read that left one with nothing to draw is handed on.
    const workDone = readJson<AiWork>(`/api/ai/work${qs}`, init).then((read) => {
      if (!live) return null;
      if (read.data) {
        setWork(read.data);
        keepCopy('ai:work', read.data);
        return null;
      }
      if (drawn.current.work) return null;
      const kept = keptCopy<AiWork>('ai:work');
      if (kept) setWork(kept);
      return kept ? null : read;
    });
    const needsDone = readJson<{ items?: NeedItem[] }>(`/api/workshop/needs-feed?in=threads${qs ? '&demo=1' : ''}`, init).then((read) => {
      if (!live) return null;
      if (read.data) {
        const items = Array.isArray(read.data.items) ? read.data.items : [];
        setNeeds(items);
        keepCopy('ai:needs', items);
        return null;
      }
      if (drawn.current.needs) return null;
      const kept = keptCopy<NeedItem[]>('ai:needs');
      if (Array.isArray(kept)) setNeeds(kept);
      return Array.isArray(kept) ? null : read;
    });
    void Promise.all([workDone, needsDone]).then((reads) => {
      clearTimeout(early);
      if (!live) return;
      const missing = reads.flatMap((read) => (read ? [read] : []));
      setFailed(!missing.length ? null : missing.some((read) => !read.reached) ? 'unreachable' : 'failed');
    });
    return () => { live = false; clearTimeout(early); };
  }, [visible, session, moved]);

  // Main beside the list, on a desktop, or peeking beside it in a phone's
  // drawer: the chat with the bot, opened once.
  useEffect(() => {
    if (!visible || !(wide || phone) || botId || typeof window === 'undefined' || !(window as any).App?.user) return;
    void openBotConversation().then((id) => {
      if (!id) return;
      noteBotConversation(id);
      setBotId(id);
    }).catch(() => {
      // Offline: the chat this device already knows, from Messages' list or
      // the copy of it kept here, so Main opens on what was kept of it.
      const known = knownBotConversation()
        || keptConversations()?.find((item) => item.homeroomBot && item.kind !== 'channel')?.id
        || null;
      if (!known) return;
      noteBotConversation(known);
      setBotId(known);
    });
  }, [visible, wide, phone, botId, session]);

  // What the column shows (1 Nov 2026): Main Chat, a thread of it, a blank
  // thread from "+", or a page the side panel holds in Main's place. Read
  // after mount: the first render is the prerender's.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const snap = useMessagesSnapshot();
  const blank = useNewThread(botId);
  const panel = useStoreState(sidePanelStore);
  const docked = wide && !!botId;
  const inMain = !!botId && snap.route.embedded && snap.route.conversationId === botId;
  const openRoot = inMain ? snap.route.threadRootId : null;
  const threadUp = !!openRoot || blank;
  // THE COLUMN (./column.ts, 3 Nov 2026): the one answer to what is open
  // beside the list. The lit row, the address and Main's attachment all read
  // it; nothing else keeps a copy.
  const panelRoute = panel.open ? routeOf(panel.route) : null;
  const column: Column = !mounted || !botId ? null
    : phone ? (level === 1 ? (openRoot ? { at: 'thread', rootId: openRoot } : blank ? { at: 'new' } : { at: 'main' }) : null)
    : !docked ? null
    : panelRoute ? { at: 'page', route: panelRoute }
    : blank ? { at: 'new' }
    : openRoot ? { at: 'thread', rootId: openRoot }
    : { at: 'main' };
  const shown = columnKey(column);
  const lit = shown === 'new' ? null : shown;
  // 1 Nov 2026 (C1): a design's preview beside the thread it is in, while
  // that thread is the column's (./preview.ts).
  const preview = usePreview();
  const three = useWide(THREE_COLUMNS);
  const layout = previewLayout({ phone, three });
  const previewUp = mounted && !!preview && !!botId && preview.conversationId === botId && openRoot === preview.rootId
    && (phone ? level === 1 : docked && !panel.open);
  // The column shows another thread: its preview goes.
  useEffect(() => {
    if (preview && openRoot && openRoot !== preview.rootId) closePreview();
  }, [preview, openRoot]);
  // The tab pressed (the page's own address, from a thread's): the list
  // comes back, and the preview goes.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const back = () => { if (window.location.hash === BOT_TAB) closePreview(); };
    window.addEventListener('hashchange', back);
    return () => window.removeEventListener('hashchange', back);
  }, []);
  const botRow = mounted ? snap.conversations.find((item) => item.homeroomBot && item.kind !== 'channel') : null;
  const unread = Math.max(0, Number(botRow?.unreadCount) || 0);

  // #6159: a thread marked done from its row's ⋯ leaves at once; the next
  // read of the lists confirms it.
  const [doneRoots, setDoneRoots] = useState<ReadonlySet<number>>(() => new Set());
  const allRows = useMemo(() => needsYou(needs, work), [needs, work]);
  const rows = useMemo(() => allRows.filter((row) => !row.rootId || !doneRoots.has(row.rootId)), [allRows, doneRoots]);
  const progress = useMemo(() => inProgress(needs, work), [needs, work]);
  const waiting = useMemo(() => upNext(needs, work), [needs, work]);
  const live: AiThread[] = useMemo(() => liveThisWeek(work), [work]);
  const owed = owedCount(rows);
  const projects = useMemo(
    () => new Set(rankProjects(rows, progress, waiting, live).map((p) => p.app.slug)),
    [rows, progress, waiting, live],
  );
  useLiveLists(() => setMoved((n) => n + 1), visible, { projects, botId });

  // A place in the chat, in the column (Main, or a thread of it, at a
  // message): a page the panel holds there gives Main its place back, and a
  // thread or a blank one open there gives way. On a phone the drawer slides
  // to it.
  // How the column came to change (./column.ts ColumnHow): this page's own
  // doors say 'row'; a change none of them made is the side panel's
  // ‹ Main Chat, 'back'. The item a row opened, for Main's composer.
  const how = useRef<ColumnHow>('back');
  const opened = useRef<{ route: string; about: AboutItem | null } | null>(null);
  const showAt = (next: BotAt) => {
    sidePanel()?.close?.();
    closeNewThread();
    if (!next.threadRootId || next.threadRootId !== preview?.rootId) closePreview();
    if (!next.threadRootId && openRoot) closeThread();
    setAt({ ...next });
    if (phone) setLevel(1);
  };
  // The router's ask (./door.ts): `#homeroom-bot/main`, `/thread/<id>`, a
  // message in either, from any door into the chat. Each once, once the page
  // knows whether it is a phone's.
  const ask = useBotTabAsk();
  const askTaken = useRef(0);
  useEffect(() => {
    if (!ask || ask.seq === askTaken.current || !visible || !(wide || phone)) return;
    askTaken.current = ask.seq;
    how.current = 'row';
    if (ask.item) openItem(ask.item);
    else if (ask.at) showAt(ask.at);
  }, [ask, visible, wide, phone]); // eslint-disable-line react-hooks/exhaustive-deps

  const openMain = () => {
    if (!(wide || phone)) { go(botTabAddress(null)); return; }
    how.current = 'row';
    showAt({ threadRootId: null, focusMessageId: null });
  };
  // A page the panel took is in the column, in Main's place, and its
  // ‹ Main Chat gives the column back to Main: a thread that was open there
  // gives way (1 Nov 2026). The address is the column's (below).
  const underPanel = () => {
    closeNewThread();
    if (openRoot) closeThread();
  };
  // A private thread is the column's, alone, in Main's place.
  const openPrivate = (rootId: number) => {
    const next = { threadRootId: rootId, focusMessageId: null };
    if (!(wide || phone)) { go(botTabAddress(next)); return; }
    how.current = 'row';
    showAt(next);
  };
  // A request, a change or a decision: its page, in the column on a wide
  // window, its own page anywhere else. Every row goes to its own place
  // (#6210): a ▷ plan row to its request's page, where its plan and Build
  // it are, the same place a Vote or Decide row for it opens.
  const openPage = (href: string | null, app: AiApp | null, title: string | null, about: AboutItem | null) => {
    how.current = 'row';
    const route = routeOf(href);
    opened.current = route ? { route, about } : null;
    if (openPublic(href, app, title)) underPanel();
  };
  const openRow = (row: WorkRow) => {
    if (row.rootId) {
      openPrivate(row.rootId);
      return;
    }
    openPage(row.href, row.app, row.title, aboutRow(row));
  };
  const openThread = (th: AiThread) => {
    // #6153: a request filed from a private thread opens that thread, where
    // its design and its story are, rather than the request's page.
    if (th.rootId) {
      openPrivate(th.rootId);
      return;
    }
    openPage(th.href, th.app, th.title, aboutRow(th));
  };
  // A project as the lists name it, for the column's heading when an item is
  // reopened from its address (the row that named it is not to hand).
  function appFromLists(slug: string): AiApp | null {
    for (const list of [rows, progress, waiting, live]) {
      const row = (list as Array<{ app: AiApp | null }>).find((item) => item.app?.slug === slug);
      if (row?.app) return row.app;
    }
    return (needs || []).find((item) => item.app?.slug === slug)?.app ?? null;
  }
  // An item the router asked for by its address (#6215,
  // `#homeroom-bot/request/<slug>/<n>`): in the column on a wide window, its
  // own page anywhere else, or when the column does not take it.
  function openItem(item: BotItem) {
    const route = botItemRoute(item);
    if (!route) { go(BOT_TAB); return; }
    opened.current = { route, about: null };
    if (wide) {
      try {
        if (sidePanel()?.take?.(route, { place: appFromLists(item.slug), label: null })) { underPanel(); return; }
      } catch { /* the page instead */ }
    }
    improve()?.enterTopicFrom?.(BOT_PAGE);
    window.location.replace(`#${route}`);
  }
  // THE ADDRESS IS THE COLUMN'S (#6215): Main, a thread, or the item in it,
  // so a reload reopens it; a phone's list, a blank thread and any other page
  // are the tab itself. Written in place: a row is no step for Back. Not on
  // the column's first showing, which the address itself asked for.
  const addressed = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!mounted || !visible || !botId) return;
    const before = addressed.current;
    addressed.current = shown;
    if (before === undefined || before === shown) return;
    showAddress(columnAddress(column));
  }, [mounted, visible, botId, shown]); // eslint-disable-line react-hooks/exhaustive-deps
  // MAIN'S ATTACHMENT FOLLOWS THE COLUMN (#6212, ./column.ts attachmentFor):
  // a page opened from the list is what a question is about; ‹ Main Chat back
  // from it keeps it; any other way into Main, or a thread, takes the list's
  // off. An item the person attached themselves stays (the composer's rule).
  const attachedFor = useRef<Column>(null);
  useEffect(() => {
    if (!botId || typeof window === 'undefined') return;
    const before = attachedFor.current;
    attachedFor.current = column;
    const was = how.current;
    how.current = 'back';
    const what = attachmentFor(before, column, was);
    if (what === 'attach' && column?.at === 'page') {
      const named = opened.current?.route === column.route ? opened.current.about : null;
      const about = named || aboutRoute(column.route);
      if (about) {
        window.dispatchEvent(new CustomEvent('usernode:messages-object-selected', {
          detail: { ...about, conversationId: botId, source: 'list' },
        }));
      } else {
        window.dispatchEvent(new CustomEvent('usernode:messages-object-cleared', { detail: { conversationId: botId } }));
      }
    } else if (what === 'clear') {
      window.dispatchEvent(new CustomEvent('usernode:messages-object-cleared', { detail: { conversationId: botId } }));
    }
  }, [shown, botId]); // eslint-disable-line react-hooks/exhaustive-deps
  // A page the side panel takes is the column's: no preview beside it.
  useEffect(() => { if (panel.open) closePreview(); }, [panel.open]);
  // On a phone the column slides back to the list; the address is the page's.
  const toList = () => {
    setLevel(0);
  };
  // THE HEADER IS MAIN CHAT'S on a phone (3 Nov 2026,
  // ../nav-drawer/bot-drawer.ts): "Homeroom bot" over the list, the arrow and
  // "Main Chat" over its line once it slides in. A private thread keeps its
  // own head, so the header is the tab's plain one while a thread is open.
  const toListRef = useRef(toList);
  toListRef.current = toList;
  useEffect(() => registerBotBack(() => toListRef.current()), []);
  const mainTitle = t('messages:store.header.main');
  const mainSub = t('messages:ai.main.sub');
  useEffect(() => {
    publishBotDrawer({ on: phone && visible && !threadUp, level, title: mainTitle, sub: mainSub });
  }, [phone, visible, threadUp, level, mainTitle, mainSub]);
  useEffect(() => () => publishBotDrawer({ on: false, level: 0, title: '', sub: '' }), []);

  // #6071 follow-up: "+" starts a new blank thread with the bot, in the
  // column (../messages/new-thread.tsx), slid in on a phone.
  const openBlank = () => {
    sidePanel()?.close?.();
    closePreview();
    how.current = 'row';
    if (phone) setLevel(1);
  };
  const heroLine = work ? heroWords(owed, progress.length) : null;
  const hero = (
    <section className="flex items-center gap-3 px-4 pt-3" data-ai-hero="">
      <img src={BOT_AVATAR} alt="" className="w-12 h-12 rounded-2xl object-cover shrink-0" />
      <span className="min-w-0 flex-1 flex flex-col">
        <h1 className="text-[1.375rem] font-bold leading-tight">{t('messages:ai.hero.name')}</h1>
        {heroLine ? (
          <span className="text-[13px] text-zinc-500 dark:text-zinc-400" data-ai-hero-sub="">
            {say(heroLine)}
          </span>
        ) : null}
      </span>
      <NewThreadButton
        conversationId={botId || null}
        onOpen={openBlank}
        className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-zinc-700 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800 [&>svg]:h-5 [&>svg]:w-5"
      />
    </section>
  );

  const listContent = (
    <>
      <div className="ai-screen-body max-w-2xl mx-auto pb-8">
        <AiLists
          hero={hero}
          main={{ lit: lit === 'main', unread, open: openMain }}
          lit={lit}
          ready={!!work && !!needs}
          failed={failed}
          onRetry={() => setMoved((n) => n + 1)}
          rows={rows}
          owed={owed}
          progress={progress}
          waiting={waiting}
          live={live}
          openRow={openRow}
          openThread={openThread}
          onDone={(rootId) => { setDoneRoots((had) => new Set([...had, rootId])); setMoved((n) => n + 1); }}
        />
        <div className="ai-askbar-gap" aria-hidden="true" />
      </div>

      {/* Ask Homeroom bot: Main. A bar over the tab bar; on a desktop Main
          is docked beside the list and this is not drawn. */}
      <div className="ai-askbar messages-composer" data-ai-askbar="">
        <a
          href="#homeroom-bot/main"
          className="messages-composer-card ai-askbar-card"
          aria-label={t('messages:ai.ask.label')}
          // On a phone's drawer Main is beside the list: in, not away.
          onClick={(e) => { if (phone) { e.preventDefault(); openMain(); } }}
        >
          <span className="ai-askbar-text">{t('messages:ai.ask.label')}</span>
          <span className="messages-composer-action" aria-hidden="true"><MicrophoneIcon className="h-5 w-5" /></span>
        </a>
      </div>
    </>
  );

  return (
    <main
      ref={screenRef}
      id="ai-screen"
      className="hidden flex-1 overflow-y-auto platform-safe-scroll"
      data-page-bounce=""
      data-ai-docked={docked ? '' : undefined}
      data-ai-drawer={phone ? level : undefined}
      data-ai-preview={previewUp ? layout : undefined}
      style={{ position: 'relative' }}
    >
      {phone ? (
        <AiDrawer
          level={level}
          onLevel={setLevel}
          list={listContent}
          pane={<MainPane botId={botId} active={visible} at={at} onBack={toList} />}
        />
      ) : listContent}

      {/* Main's left edge is the side panel's handle (30 Oct 2026): drag it,
          or use the arrow keys, to share the window between the list and
          Main; a page opened in Main's place keeps the width. */}
      {docked ? (
        <aside
          id="ai-main-pane"
          ref={mainRef}
          className="ai-main-pane"
          aria-labelledby={threadUp ? undefined : 'ai-main-title'}
          data-ai-main=""
          data-ai-column={threadUp ? 'thread' : 'main'}
        >
          <SidePanelDivider panelRef={mainRef} shown={docked} id="ai-main-divider" controls="ai-main-pane" widthKey={AI_MAIN_WIDTH_KEY} />
          {/* Main Chat's name over it. 1 Nov 2026: a thread in its place is
              alone under its own (ReplyThreadPanel `inMain`), with no bar of
              Main Chat's over it. */}
          {threadUp ? null : (
            <header className="ai-main-head" data-ai-main-head="">
              <img src={BOT_AVATAR} alt="" className="w-8 h-8 rounded-[10px] object-cover shrink-0" />
              <span className="min-w-0 flex flex-col">
                <span id="ai-main-title" className="truncate text-[0.9375rem] font-[650] leading-5 text-zinc-900 dark:text-zinc-100">
                  {t('messages:store.header.main')}
                </span>
                <span className="flex min-w-0 items-center gap-1 text-[13px] leading-[18px] text-zinc-500 dark:text-zinc-400">
                  <LockIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
                  <span className="truncate">{t('messages:ai.main.sub')}</span>
                </span>
              </span>
            </header>
          )}
          <EmbeddedConversation conversationId={botId!} active={visible} at={at} mainChat />
        </aside>
      ) : null}

      {/* The design's preview, the tab's own column (./preview.ts): beside
          the thread, or the whole screen on a phone. */}
      {previewUp && preview ? (
        <aside className="ai-preview-pane" data-ai-preview-pane={layout} aria-label={t('messages:design.pane.label')}>
          <DesignPane
            conversationId={preview.conversationId}
            rootId={preview.rootId}
            view="preview"
            onView={() => {}}
            version={preview.version}
            seq={preview.seq}
            onClose={closePreview}
            closeAs={layout === 'full' ? 'back' : 'close'}
          />
        </aside>
      ) : null}
    </main>
  );
}
