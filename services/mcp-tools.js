function shapeRequest(issue) {
  return {
    number: issue.number,
    title: issue.title,
    createdAt: issue.createdAt || issue.created_at || null,
    updatedAt: issue.updatedAt || issue.updated_at || null,
    state: issue.state,
  };
}

module.exports = { shapeRequest };