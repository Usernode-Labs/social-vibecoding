/**
 * THE THREAD'S ARTIFACTS BUTTON (20 Nov 2026, live-draft review I).
 *
 * A private thread with Homeroom bot can hold artifacts (a design, a page:
 * several since K) and a live draft of a project, each shown in the column
 * beside the thread (../ai/detail.ts), whose picker switches between them
 * (../detail/detail-card.tsx). Its head had "Preview" for a design alone,
 * and a live draft had a bar of its own (gone: ./live-draft-bar.tsx). Now
 * one button, "Artifacts", shows whenever the thread has any of them, and
 * toggles the column: a press opens it on what this thread showed last (else
 * its first artifact, else its live preview), a second press closes it.
 *
 * Where the thread's head is narrow (the column open beside it), the word
 * gives way first: app.css draws the button as its glyph alone there, so
 * the title keeps its room (H).
 */

import type { ReactNode } from 'react';

import { AppWindowIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { closeDetail, lastDetail, reopenDetail, takeHeldDetail, useDetail } from '../ai/detail';
import { openPreview } from '../ai/preview';
import { openLivePreview, type LiveDraft } from './live-draft-bar';

/** Pure: whether the thread's column shows something of this thread's now. */
export function artifactsOpen(entry: { owner: string | null } | null, rootId: number): boolean {
  return !!entry && entry.owner === `private:${rootId}`;
}

export function ArtifactsButton({ conversationId, rootId, hasArtifact, liveDraft, className }: {
  conversationId: number;
  rootId: number;
  /** The thread holds an artifact (a version was said in it, or it was opened on one). */
  hasArtifact: boolean;
  /** Its live draft while one runs (open, or up for a vote and still edited). */
  liveDraft: LiveDraft | null;
  className: string;
}): ReactNode {
  const t = useMessages('messages');
  const entry = useDetail();
  if (!hasArtifact && !liveDraft) return null;
  const owner = `private:${rootId}`;
  const open = artifactsOpen(entry, rootId);
  const toggle = () => {
    if (open) {
      closeDetail();
      return;
    }
    const again = takeHeldDetail(owner) || lastDetail(owner);
    if (again && (again.kind !== 'preview' || liveDraft)) {
      reopenDetail(again);
      return;
    }
    if (hasArtifact) openPreview({ conversationId, rootId, version: null });
    else if (liveDraft) openLivePreview(liveDraft);
  };
  const label = open ? t('messages:artifacts.hide') : t('messages:artifacts.show');
  return (
    <button type="button" className={className} data-reply-preview="" data-reply-artifacts=""
      aria-pressed={open} aria-label={label} title={label} onClick={toggle}>
      <AppWindowIcon className="messages-thread-artifacts-glyph" aria-hidden="true" />
      <span className="messages-thread-artifacts-word">{t('messages:artifacts.button')}</span>
    </button>
  );
}
