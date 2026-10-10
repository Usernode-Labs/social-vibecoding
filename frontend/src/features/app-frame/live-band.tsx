/**
 * #4449: LIVE, the new app itself taking shape while its first version is
 * built, in the thumbnail's colour band, in the same phone-shaped frame as
 * the first look (./first-version-screens.tsx). Loaded only when somebody
 * opens Live (./app-status.tsx), so nobody else pays for rrweb.
 *
 * The recording is the build worker's (services/first-version-live.js),
 * already sanitised on the server: it names nothing to fetch. It is played
 * by rrweb's Replayer in live mode, in its default sandbox (no scripts),
 * with pointer events off, scaled into the frame. While Live is open and the
 * page is visible it asks for what is new about every 2 seconds
 * (GET /api/apps/:slug/first-version/live?since=<seq>). What is genuinely
 * new glows briefly (./live-glow.ts).
 *
 * The pill says where it is: "Starting the app…" (the first look stays under
 * it), "Live · just updated" / "Live · updated N s ago", or "A restart
 * failed · showing the last good screen".
 *
 * Measured (events.js): Live opened, and the time watched, sent when it is
 * closed or the page is hidden.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Replayer } from 'rrweb';

import { useMessages } from '../../lib/i18n/react';
import type { FirstVersionScreens } from './first-version-screens';
import { GLOW_RULES, GlowTracker } from './live-glow';
import { type FirstVersionLive, type LivePhase, livePill } from './live-switch';

const POLL_MS = 2000;
const RETRY_MS = 6000;
// The recording's own size (the watcher's viewport) and the frame's.
const REC = { width: 390, height: 760 };
const FRAME = { width: 125, height: 270 };
const SCALE = FRAME.height / REC.height;
const OFFSET_X = Math.round((FRAME.width - REC.width * SCALE) / 2);
// Every event is played as it arrives: a baseline far ahead makes each one
// "behind" and so applied at once, in order (rrweb's live mode).
const FAR_AHEAD = 10 * 365 * 86400000;

interface LiveAnswer {
  runId: number;
  state: LivePhase | 'stopped';
  seq: number;
  reset: boolean;
  events: unknown[];
  age: number | null;
}

/** The pill's phase from the server's state and whether a frame was drawn. Pure. */
export function phaseOf(state: LiveAnswer['state'] | null, drawn: boolean): LivePhase {
  if (!drawn) return 'starting';
  return state === 'failed' ? 'failed' : 'live';
}

function post(slug: string, body: Record<string, unknown>): void {
  void fetch(`/api/apps/${encodeURIComponent(slug)}/first-version/live/seen`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    keepalive: true,
    body: JSON.stringify(body),
  }).catch(() => {});
}

export default function LiveBand({ live, firstLook, name }: {
  live: FirstVersionLive;
  firstLook: FirstVersionScreens | null;
  name: string;
}): ReactNode {
  // Subscribed: the pill's words (livePill) are read in the language on screen.
  const t = useMessages('agent');
  const host = useRef<HTMLDivElement | null>(null);
  const [drawn, setDrawn] = useState(false);
  const [state, setState] = useState<LiveAnswer['state'] | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const root = host.current;
    if (!root) return undefined;
    let disposed = false;
    let replayer: Replayer | null = null;
    const glow = new GlowTracker();
    let seq = 0;
    let runId: number | null = null;
    let timer: number | null = null;
    let goodFrame = false;
    // Watch time: counted while the page is visible, sent on hide and close.
    let visibleSince: number | null = document.visibilityState === 'visible' ? Date.now() : null;
    let watchedMs = 0;
    const sendWatched = () => {
      if (visibleSince != null) { watchedMs += Date.now() - visibleSince; visibleSince = null; }
      if (live.sample || runId == null || watchedMs < 1000) return;
      post(live.slug, { kind: 'watched', runId, seconds: Math.round(watchedMs / 1000), goodFrame });
      watchedMs = 0;
    };

    const play = (events: unknown[]) => {
      if (!events.length) return;
      if (!replayer) {
        replayer = new Replayer([], {
          root,
          liveMode: true,
          useVirtualDom: false,
          showWarning: false,
          showDebug: false,
          mouseTail: false,
          triggerFocus: false,
          pauseAnimation: false,
          UNSAFE_replayCanvas: false,
          insertStyleRules: GLOW_RULES,
        });
        replayer.on('fullsnapshot-rebuilded', () => {
          goodFrame = true;
          setDrawn(true);
          glow.rebuilt(replayer?.iframe?.contentDocument || null);
        });
        replayer.startLive(Date.now() + FAR_AHEAD);
      }
      for (const e of events) replayer.addEvent(e as Parameters<Replayer['addEvent']>[0]);
    };

    const poll = async () => {
      timer = null;
      if (disposed) return;
      if (document.visibilityState !== 'visible') { timer = window.setTimeout(poll, POLL_MS); return; }
      let wait = POLL_MS;
      try {
        const res = await fetch(`/api/apps/${encodeURIComponent(live.slug)}/first-version/live?since=${seq}`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(String(res.status));
        const answer = await res.json() as LiveAnswer;
        if (disposed) return;
        if (runId == null && Number.isInteger(answer.runId)) {
          runId = answer.runId;
          post(live.slug, { kind: 'opened', runId });
        }
        seq = Number.isInteger(answer.seq) ? answer.seq : seq;
        setState(answer.state);
        if (answer.age != null) setUpdatedAt(Date.now() - answer.age * 1000);
        play(Array.isArray(answer.events) ? answer.events : []);
      } catch {
        wait = RETRY_MS;
      }
      if (!disposed) timer = window.setTimeout(poll, wait);
    };

    if (live.sample) {
      // A screenshot state: the made-up recording, then a change to it.
      const [first, later] = sampleRecording();
      setState('live');
      setUpdatedAt(Date.now());
      play(first);
      timer = window.setTimeout(() => { if (!disposed) { play(later); setUpdatedAt(Date.now()); } }, 1500);
    } else {
      void poll();
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (visibleSince == null) visibleSince = Date.now();
      } else {
        sendWatched();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', sendWatched);
    return () => {
      disposed = true;
      if (timer != null) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', sendWatched);
      sendWatched();
      glow.dispose();
      try { replayer?.destroy(); } catch { /* already gone */ }
      replayer = null;
    };
  }, [live.slug, live.sample]);

  const phase = phaseOf(state, drawn);
  const age = updatedAt == null ? null : (now - updatedAt) / 1000;
  const look = firstLook && firstLook.kind === 'first_look' ? firstLook.images[0] : null;
  return (
    <div className="absolute inset-0" data-first-version-live={phase}>
      <div className="flex h-full w-full items-end justify-center pb-6">
        <div
          className="relative h-[270px] w-[125px] shrink-0 overflow-hidden rounded-[22px] bg-white shadow-[0_10px_28px_rgba(0,0,0,0.22),0_0_0_4px_rgba(17,17,20,0.9)]"
          aria-label={phase === 'starting'
            ? t('agent:appFrame.live.frame.starting', { project: name })
            : t('agent:appFrame.live.frame.live', { project: name })}
          role="img"
        >
          {look && !drawn ? (
            <img src={look} alt="" className="absolute inset-0 h-full w-full object-cover object-top" draggable={false} />
          ) : null}
          <div
            ref={host}
            aria-hidden="true"
            className={`pointer-events-none absolute top-0 origin-top-left [&_.replayer-mouse]:hidden [&_.replayer-mouse-tail]:hidden [&_iframe]:border-0 ${drawn ? '' : 'opacity-0'}`}
            style={{ left: OFFSET_X, width: REC.width, height: REC.height, transform: `scale(${SCALE})` }}
          />
        </div>
      </div>
      <span
        data-first-version-pill=""
        className="pointer-events-none absolute left-3 top-3 max-w-[calc(100%-9.5rem)] rounded-full bg-black/55 px-2.5 py-1 text-[12px] font-semibold leading-4 text-white"
      >
        {livePill(phase, age)}
      </span>
    </div>
  );
}

// ── The screenshot state's recording ────────────────────────────────────

let nextId = 1;
type Node = Record<string, unknown>;
const el = (tagName: string, attributes: Record<string, string>, childNodes: Node[] = []): Node => ({ type: 2, tagName, attributes, childNodes, id: nextId++ });
const text = (textContent: string): Node => ({ type: 3, textContent, id: nextId++ });

/**
 * A plainly made-up recording for `?shot=first-version-live`: a sample page
 * that says so, then one row added to it (which glows). Never a real app,
 * and nothing in it names anything to fetch.
 */
export function sampleRecording(): [unknown[], unknown[]] {
  nextId = 1;
  const t0 = Date.now() - 4000;
  const css = 'body{margin:0;font:15px system-ui,sans-serif;background:#f1f2f5;color:#16161a}'
    + '.top{background:#2f6fdf;color:#fff;padding:28px 20px 22px}.top h1{margin:0;font-size:26px}.top p{margin:6px 0 0;opacity:.85}'
    + '.list{padding:14px}.row{background:#fff;border-radius:16px;padding:16px;margin-bottom:10px;display:flex;gap:12px;align-items:center}'
    + '.dot{width:40px;height:40px;border-radius:12px;background:#c9dafa;flex:none}';
  const rows = ['Sample row one', 'Sample row two', 'Sample row three'];
  const list = el('div', { class: 'list' }, rows.map((r) => el('div', { class: 'row' }, [el('span', { class: 'dot' }), el('span', {}, [text(r)])])));
  const doc: Node = {
    type: 0, id: nextId++, childNodes: [
      { type: 1, name: 'html', publicId: '', systemId: '', id: nextId++ },
      el('html', {}, [
        el('head', {}, [el('style', {}, [{ type: 3, textContent: css, isStyle: true, id: nextId++ }])]),
        el('body', {}, [
          el('div', { class: 'top' }, [el('h1', {}, [text('Sample live stream')]), el('p', {}, [text('Not a real app')])]),
          list,
        ]),
      ]),
    ],
  };
  const first = [
    { type: 4, timestamp: t0, data: { href: '', width: REC.width, height: REC.height } },
    { type: 2, timestamp: t0 + 1, data: { node: doc, initialOffset: { top: 0, left: 0 } } },
  ];
  // A mutation adds each node on its own, children after their parent.
  const added = el('div', { class: 'row' });
  const dot = el('span', { class: 'dot' });
  const label = el('span', {});
  const words = text('Just added: a new row');
  const adds = [
    { parentId: list.id, nextId: null, node: added },
    { parentId: added.id, nextId: null, node: dot },
    { parentId: added.id, nextId: null, node: label },
    { parentId: label.id, nextId: null, node: words },
  ];
  const later = [
    { type: 3, timestamp: t0 + 2000, data: { source: 0, texts: [], attributes: [], removes: [], adds } },
  ];
  return [first, later];
}
