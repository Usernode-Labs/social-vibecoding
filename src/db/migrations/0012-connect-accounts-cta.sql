-- #6080 (2 Nov 2026): the "Connect X and GitHub" challenge opened Connectors.
--
-- Settings › Connectors is where MCP servers and the AI tools (Claude,
-- ChatGPT, Codex) are set up; it has no X or GitHub row. Those two accounts
-- are linked on Settings › Linked accounts (frontend/src/features/settings/
-- sections/connectors.tsx). The challenge's button, its link and its
-- instruction line are organiser data, so this corrects the rows themselves:
-- every challenge bound to a CONNECT_ACCOUNTS scoring rule, and this season's
-- "Connect X and GitHub" row. The app also redirects a Connectors link on
-- such a challenge (topochain-challenges.js ctaView), so a future copy that
-- still points there opens the right page too.
--
-- Only the deliberate phrases are replaced — a link to `#settings/connectors`,
-- the label "Open Connectors", and the words "Settings › Connectors" (or
-- "Settings > Connectors") in the challenge's own text. The measure, target,
-- points, OAuth scopes, credentials and the authorization flow are untouched.
--
-- Every replacement's target no longer contains its source, so a second run
-- changes nothing. updated_at moves only on rows one of these clauses hits.

WITH connect_accounts AS (
  SELECT r.challenge_template_id AS template_id, r.challenge_id AS challenge_id
  FROM challenge_scoring_rules r
  WHERE r.measure = 'CONNECT_ACCOUNTS'
),
bound_templates AS (
  SELECT DISTINCT template_id AS id
  FROM connect_accounts
  WHERE template_id IS NOT NULL
  UNION
  SELECT DISTINCT c.challenge_template_id
  FROM connect_accounts r
  JOIN challenges c ON c.id = r.challenge_id
)
UPDATE challenge_templates t
SET cta_link = REPLACE(REPLACE(t.cta_link,
      '#settings/connectors/', '#settings/linked-accounts'),
      '#settings/connectors', '#settings/linked-accounts'),
    mobile_cta_link = REPLACE(REPLACE(t.mobile_cta_link,
      '#settings/connectors/', '#settings/linked-accounts'),
      '#settings/connectors', '#settings/linked-accounts'),
    cta_label = CASE WHEN LOWER(BTRIM(t.cta_label)) = 'open connectors'
      THEN 'Open linked accounts' ELSE t.cta_label END,
    mobile_cta_label = CASE WHEN LOWER(BTRIM(t.mobile_cta_label)) = 'open connectors'
      THEN 'Open linked accounts' ELSE t.mobile_cta_label END,
    cta_button = CASE WHEN LOWER(BTRIM(t.cta_button)) = 'open connectors'
      THEN 'Open linked accounts' ELSE t.cta_button END,
    requirements = REPLACE(REPLACE(t.requirements,
      'Settings › Connectors', 'Settings › Linked accounts'),
      'Settings > Connectors', 'Settings › Linked accounts'),
    description = REPLACE(REPLACE(t.description,
      'Settings › Connectors', 'Settings › Linked accounts'),
      'Settings > Connectors', 'Settings › Linked accounts'),
    task = REPLACE(REPLACE(t.task,
      'Settings › Connectors', 'Settings › Linked accounts'),
      'Settings > Connectors', 'Settings › Linked accounts'),
    updated_at = NOW()
WHERE (t.id IN (SELECT id FROM bound_templates) OR t.goal = 'Connect X and GitHub')
  AND (t.cta_link LIKE '%#settings/connectors%'
    OR t.mobile_cta_link LIKE '%#settings/connectors%'
    OR LOWER(BTRIM(t.cta_label)) = 'open connectors'
    OR LOWER(BTRIM(t.mobile_cta_label)) = 'open connectors'
    OR LOWER(BTRIM(t.cta_button)) = 'open connectors'
    OR t.requirements LIKE '%Settings › Connectors%'
    OR t.requirements LIKE '%Settings > Connectors%'
    OR t.description LIKE '%Settings › Connectors%'
    OR t.description LIKE '%Settings > Connectors%'
    OR t.task LIKE '%Settings › Connectors%'
    OR t.task LIKE '%Settings > Connectors%');

WITH connect_accounts AS (
  SELECT r.challenge_template_id AS template_id, r.challenge_id AS challenge_id
  FROM challenge_scoring_rules r
  WHERE r.measure = 'CONNECT_ACCOUNTS'
),
bound_challenges AS (
  SELECT DISTINCT challenge_id AS id
  FROM connect_accounts
  WHERE challenge_id IS NOT NULL
  UNION
  SELECT c.id
  FROM challenges c
  JOIN connect_accounts r ON r.template_id = c.challenge_template_id
)
UPDATE challenges c
SET cta_link = REPLACE(REPLACE(c.cta_link,
      '#settings/connectors/', '#settings/linked-accounts'),
      '#settings/connectors', '#settings/linked-accounts'),
    mobile_cta_link = REPLACE(REPLACE(c.mobile_cta_link,
      '#settings/connectors/', '#settings/linked-accounts'),
      '#settings/connectors', '#settings/linked-accounts'),
    cta_label = CASE WHEN LOWER(BTRIM(c.cta_label)) = 'open connectors'
      THEN 'Open linked accounts' ELSE c.cta_label END,
    mobile_cta_label = CASE WHEN LOWER(BTRIM(c.mobile_cta_label)) = 'open connectors'
      THEN 'Open linked accounts' ELSE c.mobile_cta_label END,
    cta_button = CASE WHEN LOWER(BTRIM(c.cta_button)) = 'open connectors'
      THEN 'Open linked accounts' ELSE c.cta_button END,
    requirements = REPLACE(REPLACE(c.requirements,
      'Settings › Connectors', 'Settings › Linked accounts'),
      'Settings > Connectors', 'Settings › Linked accounts'),
    description = REPLACE(REPLACE(c.description,
      'Settings › Connectors', 'Settings › Linked accounts'),
      'Settings > Connectors', 'Settings › Linked accounts'),
    task = REPLACE(REPLACE(c.task,
      'Settings › Connectors', 'Settings › Linked accounts'),
      'Settings > Connectors', 'Settings › Linked accounts'),
    updated_at = NOW()
FROM challenge_templates t
WHERE t.id = c.challenge_template_id
  AND (c.id IN (SELECT id FROM bound_challenges)
    OR COALESCE(c.goal, t.goal) = 'Connect X and GitHub')
  AND (c.cta_link LIKE '%#settings/connectors%'
    OR c.mobile_cta_link LIKE '%#settings/connectors%'
    OR LOWER(BTRIM(c.cta_label)) = 'open connectors'
    OR LOWER(BTRIM(c.mobile_cta_label)) = 'open connectors'
    OR LOWER(BTRIM(c.cta_button)) = 'open connectors'
    OR c.requirements LIKE '%Settings › Connectors%'
    OR c.requirements LIKE '%Settings > Connectors%'
    OR c.description LIKE '%Settings › Connectors%'
    OR c.description LIKE '%Settings > Connectors%'
    OR c.task LIKE '%Settings › Connectors%'
    OR c.task LIKE '%Settings > Connectors%');
