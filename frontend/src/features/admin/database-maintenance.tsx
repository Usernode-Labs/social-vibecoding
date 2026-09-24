import { createRoot } from 'react-dom/client';
import { DatabaseMigrations } from './database-migrations';
import { AdminUI } from './admin-console.js';
const host = document.getElementById('database-maintenance-root');
if (host) createRoot(host).render(<main className={AdminUI.card}><h1 className={AdminUI.cardTitle}>Database maintenance</h1><p className={AdminUI.muted}><a href="/#admin/databases">Back to SV admin</a></p><DatabaseMigrations /></main>);
