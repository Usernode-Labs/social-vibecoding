-- #6605: a change keeps the thread of the first request it was ever linked
-- to. `session_thread_id` picks the first linked request's thread, but the
-- attach triggers run only while `thread_id` is NULL, so relinking a change
-- (PR 6581 was linked to #6407, then to #6581–#6583) left it in the old
-- request's thread. A change that is still a draft, being built or up for a
-- vote now follows its links to where it would be attached today, and its
-- replies go with it through the existing carry trigger. A change people
-- have already voted on, or one that is merging or merged, stays put.
--
-- The same file fixes the changes already in the wrong thread (the request
-- names PR 6581) once, and carries their replies too.

-- True when the change's current thread is the one its links give it: a
-- linked request's thread, else the thread of the request it was made from,
-- else a thread no request leads (its own, or a decision thread).
CREATE OR REPLACE FUNCTION session_thread_is_home(p_session chat_sessions) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE AS $$
DECLARE
  linked INTEGER[] := COALESCE(p_session.linked_issues, '{}'::int[]);
BEGIN
  IF p_session.thread_id IS NULL THEN
    RETURN FALSE;
  END IF;
  IF cardinality(linked) > 0 THEN
    RETURN EXISTS (
      SELECT 1 FROM requests r
       WHERE r.app_id = p_session.app_id
         AND r.number = ANY(linked)
         AND r.thread_id = p_session.thread_id
    );
  END IF;
  IF p_session.created_from_issue_number IS NOT NULL AND p_session.created_from_issue_number > 0 THEN
    RETURN EXISTS (
      SELECT 1 FROM requests r
       WHERE r.app_id = p_session.app_id
         AND r.number = p_session.created_from_issue_number
         AND r.thread_id = p_session.thread_id
    );
  END IF;
  -- Its own thread: no request leads it (a request leads a thread when its
  -- number is the thread's number, wherever a merge took that thread).
  RETURN NOT EXISTS (
    SELECT 1 FROM requests r
      JOIN threads t ON t.id = r.thread_id
     WHERE r.thread_id = p_session.thread_id
       AND r.number = t.number
  );
END;
$$;

-- A change may move only while it is still in play and nobody has voted on
-- it, and only while a thread move for it is not being gathered.
CREATE OR REPLACE FUNCTION session_may_move(p_session chat_sessions) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF p_session.status NOT IN ('active', 'paused', 'promoted') THEN
    RETURN FALSE;
  END IF;
  IF EXISTS (SELECT 1 FROM pr_votes v WHERE v.session_id = p_session.id) THEN
    RETURN FALSE;
  END IF;
  IF EXISTS (
    SELECT 1 FROM thread_moves m
     WHERE m.for_session_id = p_session.id
       AND m.state IN ('pending', 'voting')
  ) THEN
    RETURN FALSE;
  END IF;
  RETURN TRUE;
END;
$$;

-- AFTER the relink: move the change to the thread its new links give it.
-- Inside its own exception block, so a failure here never fails the write it
-- rides on. The UPDATE it issues is what makes the carry and state triggers
-- move the replies and refresh both threads.
CREATE OR REPLACE FUNCTION threads_follow_session_links() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  tid BIGINT;
BEGIN
  BEGIN
    IF NOT session_thread_is_home(NEW) AND session_may_move(NEW) THEN
      tid := session_thread_id(NEW.app_id, NEW.linked_issues, NEW.created_from_issue_number,
                               NEW.pr_number, NEW.branch_name, NEW.pr_title);
      IF tid IS NOT NULL AND tid <> NEW.thread_id THEN
        UPDATE chat_sessions SET thread_id = tid WHERE id = NEW.id;
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'threads: change % did not follow its links: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'chat_sessions_follow_links'
                  AND tgrelid = 'chat_sessions'::regclass AND NOT tgisinternal) THEN
    CREATE TRIGGER chat_sessions_follow_links
      AFTER UPDATE OF linked_issues, created_from_issue_number, pr_number ON chat_sessions
      FOR EACH ROW WHEN (
        OLD.thread_id IS NOT NULL
        AND (OLD.linked_issues IS DISTINCT FROM NEW.linked_issues
             OR OLD.created_from_issue_number IS DISTINCT FROM NEW.created_from_issue_number
             OR OLD.pr_number IS DISTINCT FROM NEW.pr_number)
      )
      EXECUTE FUNCTION threads_follow_session_links();
  END IF;
END $$;

-- A one-time fix for the changes already left behind. Each UPDATE names its
-- row, so the carry trigger takes its replies and the state trigger refreshes
-- both threads.
DO $$
DECLARE
  cs chat_sessions;
  tid BIGINT;
BEGIN
  FOR cs IN
    SELECT * FROM chat_sessions s
     WHERE s.thread_id IS NOT NULL
       AND s.is_headless = FALSE
  LOOP
    BEGIN
      IF NOT session_thread_is_home(cs) AND session_may_move(cs) THEN
        tid := session_thread_id(cs.app_id, cs.linked_issues, cs.created_from_issue_number,
                                 cs.pr_number, cs.branch_name, cs.pr_title);
        IF tid IS NOT NULL AND tid <> cs.thread_id THEN
          UPDATE chat_sessions SET thread_id = tid WHERE id = cs.id;
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'threads: change % not moved by the backfill: %', cs.id, SQLERRM;
    END;
  END LOOP;

  -- PR 6581 (change 13356) was linked to #6407 first and to #6581–#6583
  -- later, so it sat in #6407's thread. The request asks for this one fix
  -- whatever votes it has.
  SELECT * INTO cs FROM chat_sessions s WHERE s.id = 13356 AND s.pr_number = 6581;
  IF FOUND THEN
    BEGIN
      tid := session_thread_id(cs.app_id, cs.linked_issues, cs.created_from_issue_number,
                               cs.pr_number, cs.branch_name, cs.pr_title);
      IF tid IS NOT NULL AND cs.thread_id IS DISTINCT FROM tid THEN
        UPDATE chat_sessions SET thread_id = tid WHERE id = cs.id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'threads: PR 6581 not moved to its first request''s thread: %', SQLERRM;
    END;
  END IF;
END $$;
