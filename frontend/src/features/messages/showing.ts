/**
 * WHAT THE COLUMN SHOWS, SAID WITH A MESSAGE (20 Nov 2026, live-draft review C and I).
 *
 * A private thread with Homeroom bot can hold several artifacts and a live
 * draft, and "make this darker" means the one the person is looking at. So a
 * message sent in that thread says what the column beside it shows when it
 * is sent (`showing`: an artifact by its id, or the live draft), and the bot's
 * turn reads it as a hint (services/homeroom-bot-dm.js capabilityDeps). The
 * server stores it as metadata.showing; nothing else reads it.
 */

import { stagingStore } from '../staging/staging-store.js';
import type { DetailEntry } from '../ai/detail';
import type { LiveDraft } from './live-draft-bar';
import type { ShowingRef } from './types';

// Read off the two stores' shared holders (../ai/detail.ts, ./live-draft-bar.tsx
// keep theirs on the global object), not by importing them: the message
// store imports this, and those modules bind document listeners on load.
function detailEntry(): DetailEntry | null {
  return ((globalThis as any).__usernodeDetail?.state?.entry as DetailEntry | null) || null;
}
function draftForSession(sessionId: number | null | undefined): LiveDraft | null {
  const drafts = (globalThis as any).__usernodeLiveDrafts?.drafts as Map<number, LiveDraft> | undefined;
  return sessionId && drafts ? drafts.get(Number(sessionId)) || null : null;
}

// The artifact each thread's design pane drew last, by the thread: the
// column's entry names none for the thread's first artifact (an address or a
// card from before), and the pane learns its id once it reads it.
const panes: { artifacts: Map<number, number> } = ((globalThis as any).__usernodeShowing ||= { artifacts: new Map() });

/** The design pane read its artifact: its id, for a message sent beside it. */
export function noteShownArtifact(rootId: number, artifactId: number | null | undefined): void {
  if (rootId > 0 && Number(artifactId) > 0) panes.artifacts.set(rootId, Number(artifactId));
}

/** What the column beside thread `rootId` shows now, or null when it shows nothing of the thread's. */
export function showingFor(rootId: number | null | undefined): ShowingRef | null {
  if (!rootId) return null;
  const entry = detailEntry();
  if (entry && entry.owner === `private:${rootId}`) {
    if (entry.kind === 'design') {
      const id = entry.ref.artifactId || panes.artifacts.get(rootId) || 0;
      return id ? { artifactId: id } : null;
    }
    if (entry.kind === 'preview') {
      const draft = draftForSession(entry.ref.sessionId);
      return draft && draft.rootId === rootId ? { liveDraftId: draft.id } : null;
    }
    return null;
  }
  // A phone: the preview takes the whole screen and the column holds nothing.
  const staging = stagingStore.get();
  const draft = staging.open ? draftForSession(staging.sessionId) : null;
  return draft && draft.rootId === rootId ? { liveDraftId: draft.id } : null;
}
