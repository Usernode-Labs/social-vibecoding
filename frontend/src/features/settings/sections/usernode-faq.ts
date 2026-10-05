import { t as tr } from "../../../lib/i18n/runtime";
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
  get title() { return tr("settings:about_4efca0d1"); },
  get paragraphs() { return [
    tr("settings:your_device_is_part_of_a_new_network_it_verifies_b8d3b822"),
    tr("settings:we_re_doing_this_to_enable_networks_that_can_be__2b47c4a3"),
    tr("settings:right_now_we_are_in_testnet_as_we_validate_the_c_2441305b"),
    tr("settings:thanks_for_helping_test_at_this_early_stage_the__61912025")
  ]; },
};

const BLOCK_PRODUCTION: FaqTile = {
  get title() { return tr("settings:what_is_block_production_f3cd476e"); },
  get paragraphs() { return [
    tr("settings:this_feature_automatically_wakes_your_device_to__b0370683"),
    tr("settings:1_vrf_selection_each_epoch_the_network_randomly__2fd9c56c"),
    tr("settings:2_slot_scheduling_when_you_win_slots_the_app_sch_578d8de2"),
    tr("settings:3_block_production_at_slot_time_the_app_monitors_41d069d1"),
    tr("settings:4_success_tracking_results_are_recorded_to_track_4eb22c2b")
  ]; },
};

const VRF: FaqTile = {
  get title() { return tr("settings:understanding_vrf_slots_9336e3ea"); },
  get paragraphs() { return [
    tr("settings:vrf_verifiable_random_function_is_how_the_networ_bbd1f44f"),
    tr("settings:status_meanings_pending_waiting_for_epoch_transi_64334c4a"),
    tr("settings:when_vrf_selects_your_node_to_produce_a_block_at_df71f91f"),
    tr("settings:why_timing_matters_each_slot_has_a_5_seconds_win_9c4572e5")
  ]; },
};

export function faqTiles(isAndroid: boolean, deviceManufacturer?: string | null): FaqTile[] {
  const platform = isAndroid
    ? [
      tr("settings:uses_android_s_exact_alarm_system_alarmmanager_t_70d4cead"),
      'Reliability by mode: Default (Event-Driven) 90-95%, '
      + 'battery-efficient, wakes only during slot windows. Keep-Alive '
      + 'Mode 100%, persistent service, higher battery (~5-10%/hr).',
    ]
    : [
      tr("settings:uses_a_combination_of_background_tasks_and_keep__f14325b4"),
      tr("settings:reliability_by_mode_keep_alive_mode_99_app_stays_bc702c39"),
    ];
  if (isAndroid && deviceManufacturer) platform.push(tr("settings:device_value1_2f4b7f85", { value1: deviceManufacturer }));
  return [
    ABOUT,
    BLOCK_PRODUCTION,
    { get title() { return tr("settings:platform_reliability_01eb3d81"); }, paragraphs: platform },
    VRF,
  ];
}
