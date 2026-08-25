function normalizeIssue(raw) {
  const body = raw.body;
  const labels = (raw.labels && raw.labels.map(l => l.name)) || [];
  return {
    number: raw.number,
    title: raw.title || '',
    body,
    labels,
    createdAt: raw.created_at || null,
    updatedAt: raw.updated_at || null,
    htmlUrl: raw.html_url || null,
    user: (raw.user && raw.user.login) || null,
  };
}

module.exports = { normalizeIssue };