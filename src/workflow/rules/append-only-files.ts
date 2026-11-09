// The files the merge sync combines on its own: a shared file that is only
// ever appended to, so two changes touching it never truly conflict (the
// sync keeps both sides' rows). A build whose only overlap with another
// open change is one of these goes ahead in parallel (#6423).
//
// This is the ONE list; the sync's behaviour does not change with it.

export const APPEND_ONLY_FILES: readonly string[] = Object.freeze([
  'tests/baselines/test-durations.json',
  'src/db/migrations/manifest.json',
]);

const SET = new Set(APPEND_ONLY_FILES);

export function isAppendOnly(path: unknown): boolean {
  const p = String(path ?? '').trim().replace(/^\.\//, '');
  return SET.has(p);
}
