-- 20 Nov 2026: a private thread filed from a draft's card knows its project.
--
-- A thread started on no project ("Any project") has no app of its own. When
-- Homeroom bot drafted a request inside it and the person pressed File it on
-- the draft's card, the thread was marked filed with the request's number
-- and no project (homeroom-bot-mayor.js notePrivateDraft, which now passes
-- the project in the same change), so its head read "Filed as request #6861
-- on ." with no way to the request. The card it was filed by names the
-- project: take it from there, for the threads that have none.
UPDATE private_threads p
   SET app_id = c.app_id
  FROM bot_cards c
  JOIN conversation_messages m ON m.id = c.message_id
 WHERE p.app_id IS NULL
   AND p.state IN ('filed', 'posted', 'done')
   AND p.result_ref IS NOT NULL
   AND m.thread_root_id = p.root_message_id
   AND c.issue_number = p.result_ref;
