/**
 * The pending-upload strip above a composer — the thumbnails and file cards
 * for files that are staged but not yet sent.
 *
 * ── What the caller keeps ─────────────────────────────────────────────
 *
 * It is drawn by the group chat's composer (`#gc-attachments` /
 * `#gc-thread-attachments`) and by Messages' own box, in the `dc-attach-*`
 * styles. Two things stay with the caller, and neither reaches the markup:
 *
 *   * WHICH badge a kind gets. The group chat has `markdown` and `html`; it
 *     computes the label in its own module and hands it over as a string,
 *     so the card does not know the kinds.
 *   * HOW a row is removed. The module holds its own pending list — with the
 *     File and the object URL that must be revoked — so the row reports an
 *     INDEX and the module does the rest.
 *
 * ── An upload in flight offers no remove control ──────────────────────
 *
 * Deliberately: cancelling mid-PUT would leave a half-written row
 * for the 24h orphan sweep to find anyway, and a control that sometimes works
 * is worse than an honest dimmed thumbnail with a progress ring.
 *
 * ── An image is the picture (#6862) ───────────────────────────────────
 *
 * A staged image used to be a light-blue chip carrying a cut-off filename:
 * two screenshots looked the same until they were sent. It is now a square
 * thumbnail of the picture, cropped to fill, with the filename in its tooltip
 * and its alt. A tap opens the app's own viewer, with the name and size. A
 * file that is not a picture keeps a card the same height.
 */

import { useState } from 'react';

import { DescriptionIcon } from '@/components/ui/icons';
import { ProgressRing } from '@/components/ui/progress-ring';

import { useMessages } from '../../lib/i18n/react';
import { ImageViewer, openInViewer } from '../image-viewer/image-viewer';

export interface PendingAttachmentView {
  /** Stable per row — the module's own key, not the filename. */
  key: string;
  name: string;
  /** The file has no name; `name` is a stand-in label. */
  unnamed?: boolean;
  kind: string;
  /** MD / HTML / BIN, or null where the kind carries no tag. */
  badge: string | null;
  /** Pre-formatted by the module: "2 KB", "3.0 MB". */
  size: string;
  /** An image's preview: local before the upload finishes, then its file. */
  thumbUrl: string | null;
  uploading: boolean;
}

export interface PendingStripProps {
  items: PendingAttachmentView[];
  /** Called with the row's position in the module's own pending list. */
  onRemove: (index: number) => void;
}

function Row({
  item, index, onRemove,
}: { item: PendingAttachmentView; index: number; onRemove: (index: number) => void }) {
  const t = useMessages('messages');
  // A tap on a thumbnail opens the picture in the app's own viewer, as a
  // sent image does (#3286).
  const [viewing, setViewing] = useState(false);
  const remove = item.uploading ? (
    <span className="dc-attach-uploading">…</span>
  ) : (
    <button
      type="button"
      className="dc-attach-remove"
      title={t('messages:attachments.remove')}
      aria-label={item.unnamed ? t('messages:attachments.removeUnnamed') : t('messages:attachments.removeNamed', { file: item.name })}
      onClick={() => onRemove(index)}
    >
      ×
    </button>
  );
  if (item.kind === 'image' && item.thumbUrl) {
    const src = item.thumbUrl;
    return (
      <div className={`dc-attach-item dc-attach-image${item.uploading ? ' dc-attach-image-uploading' : ''}`}>
        <a
          className="dc-attach-thumb-link"
          href={src}
          data-image-open=""
          title={item.name}
          aria-label={item.unnamed ? t('messages:attachments.previewUnnamed') : t('messages:attachments.previewNamed', { file: item.name })}
          onClick={(event) => openInViewer(event, () => setViewing(true))}
        >
          <img className="dc-attach-thumb" src={src} alt={item.name} />
          {item.uploading ? (
            <span className="dc-attach-progress">
              <ProgressRing
                pct={0}
                spinning
                title={item.unnamed ? t('messages:attachments.uploadingUnnamed') : t('messages:attachments.uploadingNamed', { file: item.name })}
              />
            </span>
          ) : null}
        </a>
        {item.uploading ? null : remove}
        {viewing ? <ImageViewer src={src} alt={item.name} detail={item.size} onClose={() => setViewing(false)} /> : null}
      </div>
    );
  }
  return (
    <div className="dc-attach-item dc-attach-file" title={item.name}>
      <span className="dc-attach-file-icon" aria-hidden="true"><DescriptionIcon className="h-4 w-4" /></span>
      <span className="dc-attach-file-text">
        <span className="dc-attach-name">{item.name}</span>
        {item.badge ? <span className="dc-attach-kind">{item.badge}</span> : null}
      </span>
      {remove}
    </div>
  );
}

/** The rows alone; `<PendingStrip>` below wraps them in the strip's element. */
export function PendingStripRows({ items, onRemove }: PendingStripProps) {
  return (
    <>
      {items.map((item, i) => (
        <Row key={item.key} item={item} index={i} onRemove={onRemove} />
      ))}
    </>
  );
}

export function PendingStrip({ id, ...rest }: PendingStripProps & { id: string }) {
  // `dc-attach-strip-active` is what gives the strip its height and border; an
  // empty strip keeps the node (the module finds it by id) and no class.
  return (
    <div
      id={id}
      className={rest.items.length ? 'dc-attach-strip dc-attach-strip-active' : 'dc-attach-strip'}
    >
      <PendingStripRows {...rest} />
    </div>
  );
}
