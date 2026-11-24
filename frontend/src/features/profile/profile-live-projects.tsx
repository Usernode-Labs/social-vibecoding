/** Real projects from the profile's existing merged-change summary. */
import { useMessages } from '../../lib/i18n/react';

type Change = { sessionId: number; title: string; appSlug: string; appName: string; appIconEmoji?: string | null; mergedAt?: string | null };
export function ProfileLiveProjects({ changes }: { changes: Change[] }) {
  const t = useMessages('profile');
  const projects = changes.filter((change, index) => change.appSlug && changes.findIndex((other) => other.appSlug === change.appSlug) === index).slice(0, 3);
  return (
    <section id="profile-live-projects">
      <h2>{t('profile:projects.title')}</h2>
      <p>{t('profile:projects.intro')}</p>
      {projects.length ? <div className="profile-project-grid">
        {projects.map((project) => (
          <a key={project.appSlug} href={`#app/${encodeURIComponent(project.appSlug)}`} className="profile-project-card">
            <span className="profile-project-icon" aria-hidden="true">{project.appIconEmoji || project.appName.slice(0, 1)}</span>
            <h3>{project.appName}</h3>
            <p>{t('profile:projects.latest', { title: project.title })}</p>
          </a>
        ))}
      </div> : <p className="profile-project-empty">{t('profile:projects.empty')}</p>}
    </section>
  );
}
