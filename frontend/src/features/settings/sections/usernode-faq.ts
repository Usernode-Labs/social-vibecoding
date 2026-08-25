/**
 * The Help & Info tiles — a static port of the native FaqSection copy.
 *
 * Data, not markup: these were four `addTile(title, paragraphs)` calls inside
 * `_renderUsernodeFaq`, and the only thing that varied between them was the
 * strings. The platform tile is the one that branches, so it is a function of
 * the platform rather than a constant.
 */

export interface FaqTile {
  title: string;
  paragraphs: string[];
}

const ABOUT: FaqTile = {
  title: 'About',
  paragraphs: [
    'Your device is part of a new network. It verifies, executes, and '
    + 'contributes compute directly to the network, passively in the '
    + 'background - with no central servers, no hidden infra. As long as '
    + 'users keep the app running, the network will continue to operate, '
    + 'peer to peer, with no external dependencies.',
    "We're doing this to enable networks that can be hosted end-to-end "
    + 'by their own communities - both for decentralization, and to '
    + 'enable a natural coordination point around participation, where '
    + 'users who help operate and contribute to systems directly realize '
    + 'the benefits from it.',
    'Right now we are in testnet as we validate the core layer: block '
    + "production, consensus behavior, and network reliability. As these "
    + "stabilize, we'll build upon the unique features of the platform - "
    + 'its decentralization, zero knowledge proofs, and sybil-resistant '
    + 'identity - to introduce new activities, coordination mechanisms, '
    + 'and tools for self-hosted, sybil-resistant communities.',
    'Thanks for helping test at this early stage. The app right now is '
    + 'simple, but as we prove out the core functionality, we hope to '
    + 'make possible a new kind of community-owned network, where users '
    + 'can directly run and benefit from the networks they use.',
  ],
};

const BLOCK_PRODUCTION: FaqTile = {
  title: 'What is Block Production?',
  paragraphs: [
    'This feature automatically wakes your device to produce '
    + "blockchain blocks when your node wins a slot. Here's how it works:",
    '1. VRF Selection — Each epoch, the network randomly selects which '
    + 'validators will produce blocks using Verifiable Random Function '
    + '(VRF).',
    '2. Slot Scheduling — When you win slots, the app schedules alarms '
    + 'to wake your device ~1 minute before each slot.',
    '3. Block Production — At slot time, the app monitors your node '
    + 'and ensures the block is produced.',
    '4. Success Tracking — Results are recorded to track your '
    + 'reliability over time.',
  ],
};

const VRF: FaqTile = {
  title: 'Understanding VRF & Slots',
  paragraphs: [
    'VRF (Verifiable Random Function) is how the network fairly '
    + 'selects block producers. At the start of each epoch, the network '
    + 'runs VRF calculations to determine which validators will produce '
    + 'blocks in upcoming slots.',
    'Status meanings — Pending: waiting for epoch transition to start '
    + 'calculations. Calculating: VRF evaluation in progress (takes a '
    + 'few hours). Complete: slot assignments are finalized and '
    + 'scheduled.',
    'When VRF selects your node to produce a block at a specific time, '
    + 'you\'ve "won" that slot. Your responsibility is to have your '
    + 'device awake and connected so the block can be produced.',
    "Why timing matters: each slot has a ~5-seconds window. If your "
    + "device doesn't wake up in time or loses network connectivity, the "
    + 'slot is missed and counted as "failed."',
  ],
};

export function faqTiles(isAndroid: boolean, deviceManufacturer?: string | null): FaqTile[] {
  const platform = isAndroid
    ? [
      "Uses Android's exact alarm system (AlarmManager) to wake your "
      + 'device precisely when needed for block production.',
      'Reliability by mode: Default (Event-Driven) 90-95% — '
      + 'battery-efficient, wakes only during slot windows. Keep-Alive '
      + 'Mode 100% — persistent service, higher battery (~5-10%/hr).',
    ]
    : [
      'Uses a combination of background tasks and keep-alive mode to '
      + 'wake your device for block production.',
      'Reliability by mode: Keep-Alive Mode 99% — app stays awake in '
      + 'foreground, requires charger. Background Only 40-60% — iOS '
      + 'controls execution, not guaranteed.',
    ];
  if (isAndroid && deviceManufacturer) platform.push(`Device: ${deviceManufacturer}`);
  return [
    ABOUT,
    BLOCK_PRODUCTION,
    { title: 'Platform & Reliability', paragraphs: platform },
    VRF,
  ];
}
