/**
 * One bundle holding both halves of the transcript's publish API.
 *
 * tests/lib/render-tsx.js bundles each entry on its own, so loading
 * `mount.ts` and `transcript-store.ts` separately would produce two DIFFERENT
 * store instances and a publish through one would be invisible to the other.
 * This entry exists so a test can hold the writer and the state it writes at
 * the same time — which is what it takes to assert that a patch saying nothing
 * new is not a state change.
 */
export { transcriptStore } from '../../frontend/src/features/group-chat/transcript-store';
export {
  appendTranscriptMessage,
  patchTranscriptMessage,
  publishTranscript,
} from '../../frontend/src/features/group-chat/mount';
