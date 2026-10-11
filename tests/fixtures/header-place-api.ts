// Bundle the place bar and its store together so render tests drive the same
// store instances the real components subscribe to, not separate bundles.
export { HeaderPlace, HeaderPlaceName, PlacesButton, PlaceBar, waitingPhrase, usePhoneHeader } from '../../frontend/src/features/dev-board/workshop/place-bar';
export {
  placeStore, publishPlace, publishSide, clearPlace,
  registerPlaceOpener, registerTrayToggle, toggleTray, trayButton,
} from '../../frontend/src/features/dev-board/workshop/place-store';
