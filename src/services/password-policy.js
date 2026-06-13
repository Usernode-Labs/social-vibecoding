// Shared password-policy validation (issue #282).
//
// One place for the "what counts as an acceptable password" rule so the
// register, change-password, wallet-reset, and admin-reset paths all agree.
// Deliberately minimal: non-empty + a length floor, with an optional
// "must not equal" guard used when a user replaces a temporary password
// with the same string. Kept dependency-free so it's trivial to unit test.

const MIN_LENGTH = 8;

// Validate a candidate password. Returns { ok: true } or
// { ok: false, error } with a user-facing message.
//
// opts.notEqualTo — when provided, reject a new password identical to it
// (e.g. re-using the temporary password being replaced).
function validatePassword(password, opts = {}) {
  if (typeof password !== 'string' || password.length === 0) {
    return { ok: false, error: 'Password is required' };
  }
  if (password.length < MIN_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_LENGTH} characters` };
  }
  if (opts.notEqualTo != null && password === opts.notEqualTo) {
    return { ok: false, error: 'Choose a password different from the one you were given' };
  }
  return { ok: true };
}

module.exports = { validatePassword, MIN_LENGTH };
