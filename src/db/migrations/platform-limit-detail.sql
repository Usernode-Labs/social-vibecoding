-- What a measured platform limit's figure was about, beside the figure
-- (services/platform-capacity.js): the database volume that is fullest, the
-- resource that is tightest in a namespace's quota and its own used and hard
-- values, or the node whose volume pool is fullest. Those figures come from
-- Prometheus and the Kubernetes API, read by the platform-limits sweep; the
-- limits area at the top of Notifications reads them back from here, so
-- opening it makes no outside call. NULL for the counted limits, whose
-- figures say everything.

ALTER TABLE platform_limit_alerts ADD COLUMN IF NOT EXISTS detail JSONB;
