import { createRoot } from 'react-dom/client';
import { DatabaseMigrations } from './database-migrations';
import { AdminUI } from './admin-console.js';
const host = document.getElementById('database-maintenance-root');
if (host) createRoot(host).render(<main className={`${AdminUI.card} mx-auto max-w-6xl p-6 space-y-6`}><h1 className={AdminUI.cardTitle}>Database maintenance</h1><p className={AdminUI.muted}><a href="/#admin/databases">Back to SV admin</a></p><DatabaseMigrations standalone /></main>);
