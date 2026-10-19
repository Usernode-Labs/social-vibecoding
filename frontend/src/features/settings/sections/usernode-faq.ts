/**
 * The Help & Info tiles — a static port of the native FaqSection copy.
 *
 * Data, not markup: these were four `addTile(title, paragraphs)` calls inside
 * `_renderUsernodeFaq`, and the only thing that varied between them was the
 * strings. The platform tile is the one that branches, so it is a function of
 * the platform rather than a constant.
 */

import { t } from '../../../lib/i18n/runtime';

export interface FaqTile {
  title: string;
  paragraphs: string[];
}

/** A tile as the catalog holds it: message ids, read when the tile is drawn. */
interface FaqTileIds {
  title: string;
  paragraphs: string[];
}

const ABOUT: FaqTileIds = {
  title: 'settings:usernode.faq.about.title',
  paragraphs: [
    'settings:usernode.faq.about.network',
    'settings:usernode.faq.about.why',
    'settings:usernode.faq.about.testnet',
    'settings:usernode.faq.about.thanks',
  ],
};

const BLOCK_PRODUCTION: FaqTileIds = {
  title: 'settings:usernode.faq.blockProduction.title',
  paragraphs: [
    'settings:usernode.faq.blockProduction.lead',
    'settings:usernode.faq.blockProduction.selection',
    'settings:usernode.faq.blockProduction.scheduling',
    'settings:usernode.faq.blockProduction.production',
    'settings:usernode.faq.blockProduction.tracking',
  ],
};

const VRF: FaqTileIds = {
  title: 'settings:usernode.faq.vrf.title',
  paragraphs: [
    'settings:usernode.faq.vrf.what',
    'settings:usernode.faq.vrf.statuses',
    'settings:usernode.faq.vrf.winning',
    'settings:usernode.faq.vrf.timing',
  ],
};

const read = (tile: FaqTileIds): FaqTile => ({
  title: t(tile.title),
  paragraphs: tile.paragraphs.map((id) => t(id)),
});

/** The tiles in the language on screen. Called while <Faq/> renders, which is
 *  the component subscribed to the language. */
export function faqTiles(isAndroid: boolean, deviceManufacturer?: string | null): FaqTile[] {
  const platform = isAndroid
    ? [
      t('settings:usernode.faq.platform.androidHow'),
      t('settings:usernode.faq.platform.androidModes'),
    ]
    : [
      t('settings:usernode.faq.platform.iosHow'),
      t('settings:usernode.faq.platform.iosModes'),
    ];
  if (isAndroid && deviceManufacturer) {
    platform.push(t('settings:usernode.faq.platform.device', { manufacturer: deviceManufacturer }));
  }
  return [
    read(ABOUT),
    read(BLOCK_PRODUCTION),
    { title: t('settings:usernode.faq.platform.title'), paragraphs: platform },
    read(VRF),
  ];
}
