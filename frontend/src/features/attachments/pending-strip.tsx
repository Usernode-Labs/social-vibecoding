/**
 * The pending-upload strip above a composer — the chips and thumbnails for
 * files that are staged but not yet sent.
 *
 * ── Why this is its own feature ───────────────────────────────────────
 *
 * It is drawn in TWO places, and it always was: the dev chat's composer
 * (`#dc-attachments`) and the group chat's (`#gc-attachments` /
 * `#gc-thread-attachments`). The group chat's own comment said so — "reuses
 * the dev-chat dc-attach-* styles" — and the two renderers were the same
 * markup written out twice, in modules that cannot import each other.
 *
 * They differ in exactly two ways, and neither reaches the markup:
 *
 *   * WHICH badge a kind gets. The dev chat has a `zip` kind that carries an
 *     entry count ("ZIP · 214 files"); the group chat has `markdown` and
 *     `html`. Both compute the label in their own module and hand it over as
 *     a string, so the chip does not know the difference.
 *   * HOW a row is removed. Each module holds its own pending list — with the
 *     File and the object URL that must be revoked — so the row reports an
 *     INDEX and the module does the rest.
 *
 * ── An upload in flight offers no remove control ──────────────────────
 *
 * Deliberately, in both: cancelling mid-PUT would leave a half-written row
 * for the 24h orphan sweep to find anyway, and a control that sometimes works
 * is worse than an honest "…".
 */

export interface PendingAttachmentView {
  /** Stable per row — the module's own key, not the filename. */
  key: string;
  name: string;
  kind: string;
  /** MD / HTML / BIN / ZIP · N files, or null where the kind carries no tag. */
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
  const remove = item.uploading ? (
    <span className="dc-attach-uploading">…</span>
  ) : (
    <button
      type="button"
      className="dc-attach-remove"
      title="Remove"
      aria-label={`Remove ${item.name}`}
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

/**
 * The rows alone, for a caller whose strip ELEMENT is not React's.
 *
 * The dev chat's `#dc-attachments` is written by `renderChatView`'s template
 * and portalled into, so the element and its `dc-attach-strip-active` class
 * stay that module's — the same host-is-mine, children-are-React's split the
 * group chat's floating menus use. The group chat's own strip is part of a
 * React tree, so it takes `<PendingStrip>` below and gets the element too.
 */
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
