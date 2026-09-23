'use strict';
// Idempotent import preserves every legacy submission and original timestamp.
// Conflict keys make deployment restarts safe; existing moderation decisions
// are never overwritten by the older queues.
async function importLegacyReports(db) {
  await db.query(`INSERT INTO moderation_cases (target_type,target_id,target_label,target_user_id,status,created_at,closed_at)
    SELECT 'conversation_message', message_id, 'Private message #' || message_id,
           MAX(reported_user_id), CASE WHEN BOOL_OR(status = 'pending') THEN 'new' WHEN BOOL_AND(status = 'dismissed') THEN 'dismissed' ELSE 'resolved' END,
           MIN(created_at), CASE WHEN BOOL_OR(status = 'pending') THEN NULL ELSE MAX(resolved_at) END
      FROM conversation_message_reports GROUP BY message_id
    ON CONFLICT (target_type,target_id) DO NOTHING`);
  await db.query(`INSERT INTO moderation_cases (target_type,target_id,target_label,target_user_id,status,created_at,closed_at)
    SELECT 'user', r.profile_user_id, '@' || MAX(u.username), r.profile_user_id,
           CASE WHEN BOOL_OR(r.status = 'pending') THEN 'new' WHEN BOOL_AND(r.status = 'dismissed') THEN 'dismissed' ELSE 'resolved' END,
           MIN(r.created_at), CASE WHEN BOOL_OR(r.status = 'pending') THEN NULL ELSE MAX(r.resolved_at) END
      FROM profile_reports r JOIN users u ON u.id = r.profile_user_id GROUP BY r.profile_user_id
    ON CONFLICT (target_type,target_id) DO NOTHING`);
  await db.query(`INSERT INTO moderation_reports (case_id,cycle,reporter_user_id,reason,detail,evidence,created_at,legacy_type,legacy_id)
    SELECT c.id, 0, r.reporter_user_id, r.reason, r.detail,
           r.evidence_snapshot || jsonb_build_object('content',r.content_snapshot,'conversationId',r.conversation_id,'legacyStatus',r.status,'resolvedAt',r.resolved_at,'resolvedBy',r.resolved_by),
           r.created_at, 'conversation', r.id
      FROM conversation_message_reports r JOIN moderation_cases c ON c.target_type = 'conversation_message' AND c.target_id = r.message_id
    ON CONFLICT (legacy_type,legacy_id) DO NOTHING`);
  await db.query(`INSERT INTO moderation_reports (case_id,cycle,reporter_user_id,reason,detail,evidence,created_at,legacy_type,legacy_id)
    SELECT c.id, 0, r.reporter_user_id, r.reason, r.detail,
           jsonb_build_object('username',u.username,'legacyStatus',r.status,'legacySnapshotUnavailable',true,'resolvedAt',r.resolved_at,'resolvedBy',r.resolved_by),
           r.created_at, 'profile', r.id
      FROM profile_reports r JOIN users u ON u.id = r.profile_user_id
      JOIN moderation_cases c ON c.target_type = 'user' AND c.target_id = r.profile_user_id
    ON CONFLICT (legacy_type,legacy_id) DO NOTHING`);
  // #2895 introduced app/discussion queues while this proposal was being
  // built. Preserve their original snapshots, including deleted targets.
  // Negative legacy ids represent missing targets and never match a live row.
  await db.query(`INSERT INTO moderation_cases (target_type,target_id,target_label,target_user_id,status,created_at,closed_at)
    SELECT 'app',COALESCE(r.app_id,-r.id),MAX(r.app_name_snapshot),MAX(a.created_by),
           CASE WHEN BOOL_OR(r.status = 'pending') THEN 'new' WHEN BOOL_AND(r.status = 'dismissed') THEN 'dismissed' ELSE 'resolved' END,
           MIN(r.created_at),CASE WHEN BOOL_OR(r.status = 'pending') THEN NULL ELSE MAX(r.resolved_at) END
      FROM app_reports r LEFT JOIN apps a ON a.id = r.app_id GROUP BY COALESCE(r.app_id,-r.id)
    ON CONFLICT (target_type,target_id) DO NOTHING`);
  await db.query(`INSERT INTO moderation_cases (target_type,target_id,target_label,target_user_id,status,created_at,closed_at)
    SELECT 'app_message',COALESCE(message_id,-id),'App message in ' || MAX(app_slug_snapshot),MAX(reported_user_id),
           CASE WHEN BOOL_OR(status = 'pending') THEN 'new' WHEN BOOL_AND(status = 'dismissed') THEN 'dismissed' ELSE 'resolved' END,
           MIN(created_at),CASE WHEN BOOL_OR(status = 'pending') THEN NULL ELSE MAX(resolved_at) END
      FROM chat_message_reports GROUP BY COALESCE(message_id,-id)
    ON CONFLICT (target_type,target_id) DO NOTHING`);
  await db.query(`INSERT INTO moderation_reports (case_id,cycle,reporter_user_id,reason,detail,evidence,created_at,legacy_type,legacy_id)
    SELECT c.id,0,r.reporter_user_id,r.reason,r.detail,
           jsonb_build_object('name',r.app_name_snapshot,'slug',r.app_slug_snapshot,'legacyStatus',r.status,'resolvedAt',r.resolved_at,'resolvedBy',r.resolved_by),
           r.created_at,'app',r.id
      FROM app_reports r JOIN moderation_cases c ON c.target_type = 'app' AND c.target_id = COALESCE(r.app_id,-r.id)
    ON CONFLICT (legacy_type,legacy_id) DO NOTHING`);
  await db.query(`INSERT INTO moderation_reports (case_id,cycle,reporter_user_id,reason,detail,evidence,created_at,legacy_type,legacy_id)
    SELECT c.id,0,r.reporter_user_id,r.reason,r.detail,
           r.evidence_snapshot || jsonb_build_object('content',r.content_snapshot,'location',r.app_slug_snapshot,'legacyStatus',r.status,'resolvedAt',r.resolved_at,'resolvedBy',r.resolved_by),
           r.created_at,'app_message',r.id
      FROM chat_message_reports r JOIN moderation_cases c ON c.target_type = 'app_message' AND c.target_id = COALESCE(r.message_id,-r.id)
    ON CONFLICT (legacy_type,legacy_id) DO NOTHING`);
  await db.query(`INSERT INTO moderation_evidence_files (source_type,source_id,filename,content_type,data)
    SELECT DISTINCT 'app_message',a.id,a.filename,a.content_type,a.data
      FROM chat_message_attachments a JOIN chat_message_reports r ON r.message_id = a.message_id
      JOIN moderation_reports mr ON mr.legacy_type = 'app_message' AND mr.legacy_id = r.id AND mr.evidence IS NOT NULL
    ON CONFLICT (source_type,source_id) DO NOTHING`);
  await db.query(`INSERT INTO moderation_report_files (report_id,file_id)
    SELECT mr.id,f.id FROM moderation_reports mr JOIN chat_message_reports r ON mr.legacy_type = 'app_message' AND mr.legacy_id = r.id
      JOIN chat_message_attachments a ON a.message_id = r.message_id
      JOIN moderation_evidence_files f ON f.source_type = 'app_message' AND f.source_id = a.id
    WHERE mr.evidence IS NOT NULL ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO moderation_evidence_files (source_type,source_id,filename,content_type,data)
    SELECT DISTINCT 'conversation_message', a.id, a.filename, a.content_type, a.data
      FROM conversation_message_attachments a JOIN conversation_message_reports r ON r.message_id = a.message_id
      JOIN moderation_reports mr ON mr.legacy_type = 'conversation' AND mr.legacy_id = r.id AND mr.evidence IS NOT NULL
    ON CONFLICT (source_type,source_id) DO NOTHING`);
  await db.query(`INSERT INTO moderation_report_files (report_id,file_id)
    SELECT mr.id, f.id FROM moderation_reports mr JOIN conversation_message_reports r ON mr.legacy_type = 'conversation' AND mr.legacy_id = r.id
    JOIN conversation_message_attachments a ON a.message_id = r.message_id
    JOIN moderation_evidence_files f ON f.source_type = 'conversation_message' AND f.source_id = a.id
    WHERE mr.evidence IS NOT NULL ON CONFLICT DO NOTHING`);
}
module.exports = { importLegacyReports };
