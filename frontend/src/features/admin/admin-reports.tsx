// Keep existing Admin → Reports links on the unified moderation queue.
export { AdminModeration as AdminReports, ModerationSection as ReportsSection } from './admin-moderation';
import { AdminModeration } from './admin-moderation';
if (typeof window !== 'undefined') (window as any).AdminReports = AdminModeration;
