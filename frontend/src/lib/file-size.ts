/**
 * A byte count as a person reads it: "9 B", "1 KB", "4.2 MB". The empty
 * string for nothing, so a caller can leave the size off a row that has none.
 *
 * It lives here, apart from the chat's own formatting, because a file's size
 * is shown in more than one surface: an attachment under a message, and the
 * list of files a request draft carries onto its request (#7136).
 */
export function fileSize(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
