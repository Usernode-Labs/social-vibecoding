const MAX_BODY_CHARS = 2000;

const clip = (text) => {
  if (text.length <= MAX_BODY_CHARS) return text;
  return text.slice(0, MAX_BODY_CHARS) + "… [truncated]";
};

const shapeRequest = (request) => ({
  ..request,
  body: clip(request.body || ""),
});

export { MAX_BODY_CHARS, clip, shapeRequest };