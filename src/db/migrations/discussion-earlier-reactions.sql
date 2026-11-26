-- The Discussion's "Earlier discussion" post (hub-discussion, 26 Nov 2026):
-- its own reactions.
--
-- That post is not a message: it gathers what a project's #general held
-- before the Discussion had posts (services/discussion.js), so there is no
-- chat_messages row for message_reactions to hang its reactions on, and
-- hanging them on one of the old messages would put them on that message
-- too. This is its anchor: one set of reactions per project, the project
-- whose Discussion it is (Homeroom's own #general included, under the
-- platform project's row). The messages inside it keep their own, as
-- every message does.
--
-- Not staging:private: it says only which emoji a person put on a public
-- post, as message_reactions does.
CREATE TABLE IF NOT EXISTS discussion_earlier_reactions (
  app_id     INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      VARCHAR(32) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (app_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_discussion_earlier_reactions_app ON discussion_earlier_reactions (app_id, created_at);
