/**
 * The group chat's composer form and the store it reads, from ONE entry, so
 * a test that sets a slot sets the store the component subscribes to — see
 * ./dev-composer-api.ts.
 */

export { ComposerForm } from '../../frontend/src/features/group-chat/composer';
export { composerStore, EMPTY_COMPOSER } from '../../frontend/src/features/group-chat/composer-store';
