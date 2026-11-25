/** The projects the viewer has a live change in, one card each. */
import { useState } from 'react';
import { useMessages } from '../../lib/i18n/react';

type Project = { sessionId: number; title: string; appSlug: string; appName: string; appIconEmoji?: string | null; appIconUrl?: string | null; mergedAt?: string | null };

/** The card's square: the project's own logo (#7153), else its emoji, else its
 *  first letter. A picture that fails to load falls back the same way, so the
 *  card never shows a broken image. Decorative — the name is in the heading. */
function ProjectIcon({ project }: { project: Project }) {
  const [failed, setFailed] = useState<string | null>(null);
  const picture = project.appIconUrl && failed !== project.appIconUrl ? project.appIconUrl : null;
  return (
    <span className="profile-project-icon" aria-hidden="true">
      {picture
        ? <img src={picture} alt="" loading="lazy" onError={() => setFailed(picture)} />
        : project.appIconEmoji || project.appName.slice(0, 1)}
    </span>
  );
}

export function ProfileLiveProjects({ projects }: { projects: Project[] }) {
  const t = useMessages('profile');
  return (
    <section id="profile-live-projects">
      <h2>{t('profile:projects.title')}</h2>
      <p>{t('profile:projects.intro')}</p>
      {projects.length ? <div className="profile-project-grid">
        {projects.map((project) => (
          <a key={project.appSlug} href={`#app/${encodeURIComponent(project.appSlug)}`} className="profile-project-card">
            <ProjectIcon project={project} />
            <h3>{project.appName}</h3>
            <p>{t('profile:projects.latest', { title: project.title })}</p>
          </a>
        ))}
      </div> : <p className="profile-project-empty">{t('profile:projects.empty')}</p>}
    </section>
  );
}
