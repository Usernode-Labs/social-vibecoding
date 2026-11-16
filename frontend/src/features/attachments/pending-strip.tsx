/**
 * The pending-upload strip above a composer — the chips and thumbnails for
 * files that are staged but not yet sent.
 *
 * ── What the caller keeps ─────────────────────────────────────────────
 *
 * It is drawn by the group chat's composer (`#gc-attachments` /
 * `#gc-thread-attachments`), in the `dc-attach-*` styles. Two things stay
 * with the caller, and neither reaches the markup:
 *
 *   * WHICH badge a kind gets. The group chat has `markdown` and `html`; it
 *     computes the label in its own module and hands it over as a string,
 *     so the chip does not know the kinds.
 *   * HOW a row is removed. The module holds its own pending list — with the
 *     File and the object URL that must be revoked — so the row reports an
 *     INDEX and the module does the rest.
 *
 * ── An upload in flight offers no remove control ──────────────────────
 *
 * Deliberately: cancelling mid-PUT would leave a half-written row
 * for the 24h orphan sweep to find anyway, and a control that sometimes works
 * is worse than an honest "…".
 */

import { useMessages } from '../../lib/i18n/react';

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
  /** An image's local preview, before the upload finishes. Null otherwise. */
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
    return (
      <div className="dc-attach-item">
        <img className="dc-attach-thumb" src={item.thumbUrl} alt={item.name} title={item.name} />
        {remove}
      </div>
    );
  }
  return (
    <div className="dc-attach-item dc-attach-chip" title={item.name}>
      {item.badge ? <span className="dc-attach-kind">{item.badge}</span> : null}
      <span className="dc-attach-name">{item.name}</span>
      <span className="dc-attach-size">{item.size}</span>
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
