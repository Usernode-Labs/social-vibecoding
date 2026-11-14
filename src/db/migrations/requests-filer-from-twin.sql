-- #6606: a request filed through the connector was saved without its filer
-- (`requests.created_by` null), so its change's "not confirmed by its
-- requester" could never clear. Its GitHub twin has the person who filed it
-- (`issues.created_by`), written by the same route. Where an app has several
-- twins for one number, the earliest one speaks, as github-move.js does.
-- Forward only, and idempotent: a row that already has a filer is left alone.
UPDATE requests r
   SET created_by = t.created_by
  FROM (SELECT DISTINCT ON (i.app_id, i.github_issue_number)
               i.app_id, i.github_issue_number, i.created_by
          FROM issues i
          JOIN users u ON u.id = i.created_by
         WHERE i.kind = 'general' AND i.github_issue_number > 0 AND i.created_by > 0
         ORDER BY i.app_id, i.github_issue_number, i.id) t
 WHERE r.created_by IS NULL
   AND t.app_id = r.app_id
   AND t.github_issue_number = r.number;
