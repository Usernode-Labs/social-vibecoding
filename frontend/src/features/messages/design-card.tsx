/**
 * A VERSION OF A DESIGN, SMALL, WHERE THE BOT SAYS IT (1 Nov 2026, threads,
 * one loop C1). Any private thread of the chat with Homeroom bot can hold a
 * design (src/services/design-threads.js): the bot draws a screen from words
 * there, and says each version in the thread ("Version 2: a green Save
 * button."). Under its words the version is drawn small, in a frame like the
 * design pane's (../artifact/frame.tsx: its own origin, scripts and nothing
 * else, this site's stylesheets only), scaled to the card, and Open preview
 * opens the pane as the Homeroom bot tab's own column (../ai/preview.ts).
 *
 *   Version 2: a green Save button.
 *   ┌────────────┐
 *   │  (screen)  │
 *   └────────────┘
 *   Settings · version 2           [Open preview]
 *
 * The picture is not something to use: the frame takes no pointer or focus,
 * and pressing it opens the preview as the button does.
 *
 * The first render is a box of the card's size and nothing else: the design
 * and the version are read in effects, once per thread and version for every
 * card that shows them (`readDesign`, `readVersion`).
 */

import { useEffect, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';

import { useMessages } from '../../lib/i18n/react';
import { ArtifactFrame } from '../artifact/frame';
import { currentSheets } from '../artifact/frame-doc';
import { inlinePictures } from '../design/pictures';
import { openPreview } from '../ai/preview';
import * as api from './api';
import type { DesignThread } from './api';
import { paneWordIds } from './artifact-kind';

// The card's picture: a phone screen 180px wide, a desktop one 320px, at
// most 260px tall (the top of the screen, where its point usually is).
const PHONE_W = 180;
const DESKTOP_W = 320;
const MAX_H = 260;

/** Pure: the box a version is drawn small in, and the scale that fits it. */
export function cardBox(design: { width: number; height: number } | null): { width: number; height: number; scale: number } {
  if (!design || !(design.width > 0) || !(design.height > 0)) return { width: PHONE_W, height: 160, scale: 1 };
  const width = design.width < 768 ? PHONE_W : DESKTOP_W;
  const scale = Math.min(1, width / design.width);
  return { width, height: Math.min(MAX_H, Math.round(design.height * scale)), scale };
}

// One read of a thread's design and of each version, shared by its cards:
// a design read again once a card names a version newer than it knew.
// 20 Nov 2026 (live-draft review, K): keyed by the artifact too; 0 is the
// thread's first (a message from before names none).
const designs = new Map<string, { latest: number; read: Promise<DesignThread> }>();
const versions = new Map<string, Promise<{ version: number; html: string }>>();

export function readDesign(rootId: number, version: number, artifactId: number | null = null): Promise<DesignThread> {
  const key = `${rootId}:${artifactId || 0}`;
  const had = designs.get(key);
  if (had && had.latest >= version) return had.read;
  const read = api.getDesign(rootId, artifactId);
  const entry = { latest: version, read };
  designs.set(key, entry);
  read.then((d) => { entry.latest = Math.max(version, d.latest); }, () => { designs.delete(key); });
  return read;
}

export function readVersion(rootId: number, version: number, artifactId: number | null = null): Promise<{ version: number; html: string }> {
  const at = `${rootId}:${artifactId || 0}:${version}`;
  let read = versions.get(at);
  if (!read) {
    read = api.getDesignVersion(rootId, version, artifactId);
    versions.set(at, read);
    read.catch(() => { versions.delete(at); });
  }
  return read;
}

/** Pure: the version a bot message in a thread says, or null. */
export function designVersionOf(message: { sender?: { bot?: boolean }; metadata?: { homeroomBot?: { designVersion?: number } | null } | null }): number | null {
  const n = Number(message?.metadata?.homeroomBot?.designVersion);
  return message?.sender?.bot && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Pure (K): which of the thread's artifacts a bot message's version is of, or null for its first. */
export function designArtifactOf(message: { metadata?: { homeroomBot?: { artifactId?: number } | null } | null }): number | null {
  const n = Number(message?.metadata?.homeroomBot?.artifactId);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function DesignVersionCard({ conversationId, rootId, version, title = null, artifactId = null }: {
  conversationId: number;
  rootId: number;
  version: number;
  /** The design's name, as the message carries it. */
  title?: string | null;
  /** K: which of the thread's artifacts; none is its first. */
  artifactId?: number | null;
}): ReactNode {
  const t = useMessages('messages');
  const [design, setDesign] = useState<DesignThread | null>(null);
  const [doc, setDoc] = useState<{ html: string; sheets: string[]; site: boolean } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    readDesign(rootId, version, artifactId).then((found) => {
      if (!live) return;
      setDesign(found);
      // P8: the pictures it names, written in (../design/pictures.ts).
      return readVersion(rootId, version, artifactId).then((v) => inlinePictures(v.html)).then((html) => {
        if (!live) return;
        setDoc({ html, sheets: found.surface === 'platform' ? currentSheets() : [], site: found.kind !== 'page' });
      });
    }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [rootId, version, artifactId]);

  const box = cardBox(design);
  const named = title || design?.title || '';
  // I: the column opens on this artifact, at this version.
  const open = () => openPreview({ conversationId, rootId, version, artifactId });
  return (
    <div className="messages-design-card mt-2 flex w-fit max-w-full flex-col gap-2" data-design-card={version}>
      <div
        className="relative overflow-hidden rounded-xl bg-white shadow-[0_0_0_1px_var(--app-sheet-line)]"
        style={{ width: box.width, height: box.height }}
      >
        {doc && design ? (
          <ArtifactFrame
            mode="run"
            viewer="author"
            html={doc.html}
            sheets={doc.sheets}
            site={doc.site}
            pictured
            inert
            title={design.kind === 'page' ? t('messages:design.card.frameTitlePage', { version }) : t('messages:design.card.frameTitle', { version })}
            style={{
              width: design.width, height: design.height, transform: `scale(${box.scale})`, transformOrigin: '0 0',
              border: 0, background: '#fff',
            }}
          />
        ) : (
          <span className="absolute inset-0 flex items-center justify-center p-3 text-center text-[12px] text-zinc-500">
            {failed ? t('messages:design.card.failed') : t(paneWordIds(design?.kind).loading)}
          </span>
        )}
        <button
          type="button"
          className="absolute inset-0 h-full w-full cursor-pointer"
          onClick={open}
          aria-label={t('messages:design.card.openVersion', { version })}
          data-design-card-picture=""
        />
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] text-zinc-500 dark:text-zinc-400">
          {named ? t('messages:design.card.label', { title: named, version }) : t('messages:design.pane.versionOption', { version })}
        </span>
        <Button type="button" variant="pillNeutral" size="sm" ink="neutral" onClick={open} data-design-card-open="">
          {t('messages:design.card.open')}
        </Button>
      </div>
    </div>
  );
}
