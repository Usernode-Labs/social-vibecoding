'use strict';

// One source for reference rows used by fresh initialization and every boot.
// Sanitized previews discard production copies; insert-only defaults restore
// required rows without overwriting operator-set values or channel edits.
const GENERAL_CHANNEL_SQL = `
INSERT INTO conversations (kind, title, channel_key)
VALUES ('channel', 'general', 'general')
ON CONFLICT (channel_key) WHERE channel_key IS NOT NULL DO NOTHING;
  `;

const DEFAULT_SETTINGS_SQL = `
INSERT INTO platform_settings (key, value) VALUES
('user_daily_limit_cents',   '2500'),
  ('global_daily_limit_cents', '20000'),
  ('system_tokens_daily_limit_cents', '2500'),
('user_weekly_limit_cents', '5000'),
('app_outages_tracked_since', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
('homeroom_bot_mode', 'off'),
  ('homeroom_bot_concurrency', '1'),
  ('homeroom_bot_batch_size', '10'),
  ('homeroom_bot_paused_apps', '[]'),
  ('homeroom_bot_shadow_builds', 'off'),
  ('homeroom_bot_build_concurrency', '2'),
  ('homeroom_bot_shadow_build_platform', 'off'),
  ('homeroom_bot_user_weekly_cents', '5000'),
  ('homeroom_bot_admin_weekly_cents', '10000'),
  ('homeroom_bot_live_at_once', '12'),
  ('homeroom_bot_per_person', '3'),
  ('homeroom_bot_dm_chat', 'on'),
('homeroom_bot_audience_since', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
('platform_live_tracked_since', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
ON CONFLICT (key) DO NOTHING;
  `;

const DESCRIBED_SETTINGS_SQL = `
INSERT INTO platform_settings (key, value, description) VALUES
('topochain_first_block_points',              '250',
    'Points awarded for producing a season event''s first block.'),
  ('topochain_produced_half_blocks_points',     '0',
    'Points awarded for producing at least half of the expected blocks.'),
  ('topochain_top_1_points',                    '1500',
    'Points awarded for finishing rank 1 on the leaderboard.'),
  ('topochain_top_2_points',                    '1000',
    'Points awarded for finishing rank 2 on the leaderboard.'),
  ('topochain_top_3_points',                    '500',
    'Points awarded for finishing rank 3 on the leaderboard.'),
  ('topochain_success_50_percent_points',       '1000',
    'Points awarded for a block-production success rate of at least 50%.'),
  ('topochain_inviting_new_participant_points', '0',
    'Points awarded for inviting a new participant into the competition.'),
('model_cost_observed_since', NOW()::text,
    'Marker: the instant the platform began recording coding-agent spend per model (#2592). The Model costs console counts only changes created at or after it. Do not delete — deleting re-stamps it at the next boot and discards every clean change recorded so far.')
ON CONFLICT (key) DO NOTHING;
  `;

const REFERENCE_STATEMENTS = Object.freeze([GENERAL_CHANNEL_SQL, DEFAULT_SETTINGS_SQL, DESCRIBED_SETTINGS_SQL]);

async function seedReferenceData(pool) {
  await pool.query(GENERAL_CHANNEL_SQL);
  await pool.query(DEFAULT_SETTINGS_SQL);
  await pool.query(DESCRIBED_SETTINGS_SQL);
}

module.exports = { seedReferenceData, REFERENCE_STATEMENTS };
