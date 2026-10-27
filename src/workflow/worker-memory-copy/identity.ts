export const COPY_LABEL = 'social.usernode.io/memory-copy';

export function copyIdentity(sourceId: number, sessionId: number, requestId: string) {
  if ([sourceId, sessionId].some(v => !Number.isSafeInteger(v) || v < 1 || v > 2147483647) || sourceId === sessionId
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId)) throw new Error('Invalid memory copy identity');
  return { sourceId, sessionId, requestId, sourceVolume: `usernode-cc-${sourceId}`, targetVolume: `usernode-cc-${sessionId}`,
    container: `usernode-memory-copy-${sessionId}-${requestId}`, job: `sv-worker-copy-${sessionId}-${requestId}` };
}
