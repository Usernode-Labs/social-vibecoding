// How a work handler says a failure will not get better by retrying.

export const permanent = (message: string) => Object.assign(new Error(message), { permanent: true });
// A production rebuild refused for a required secret with no value
// (staging.js MissingSecretsError, known by its name): it fails the same way
// every time, so it is permanent.
export const missingSecrets = (err: any) => err?.name === 'MissingSecretsError';
