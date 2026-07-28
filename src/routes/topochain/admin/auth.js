// Topochain v4 admin API — the auth gate every /api/v4/admin/* route
// shares (Task 11; SPEC 2193-2197, admin auth + conventions).
//
// Global Constraints #2 / decision #2: the admin group reuses the
// PLATFORM's own admin auth (`adminMiddleware` gates every route on
// `is_admin`; `requireAdminWrite` additionally gates mutations on
// `canAdminWrite`) rather than building a parallel topochain admin auth
// stack. Task 3 already wired `adminMiddleware` in as-is (see
// ../admin.js's mount-order comment on the path-stripping workaround).
//
// RECONCILING THE ERROR BODY (SPEC vs the platform middleware): SPEC 2193
// is explicit that non-admins get
//   403 {"success": false, "error": "Unauthorized. Admin access required."}
// but src/middleware/admin.js's `adminMiddleware`/`requireAdminWrite` are
// shared with the pre-existing (non-v4) `/api/admin/*` surface and emit
// their OWN bodies instead:
//   adminMiddleware      -> 403 {"error": "Admin access required"}
//   requireAdminWrite    -> 403 {"error": "Full admin access required"}
// Neither is the v4 single error envelope (§4.8 item 3: every /api/v4
// response is `{"success": false, "error": "<message>"}`), and the first
// isn't even the SPEC-mandated wording. Editing src/middleware/admin.js
// itself would change behavior for the platform's OTHER admin routes
// (src/routes/admin.js) — out of scope and unwanted. Instead, this module
// WRAPS both middlewares for the topochain admin router only: it lets the
// platform middleware do 100% of the actual auth decision (nothing here
// re-derives `is_admin`/`canAdminWrite` itself), and intercepts ONLY the
// `res.json` call the middleware makes when it 403s, rewriting that one
// body into the v4 shape. `res.json` is restored before `next()` runs so
// every route handler downstream sees the normal, unwrapped response
// object — the interception is invisible past the auth gate itself.
'use strict';

const { adminMiddleware, requireAdminWrite } = require('../../../middleware/admin');

// Wraps `mw` (either platform middleware) so that IF it ends the request
// with `res.status(403).json(...)`, the JSON body sent is `replacement`
// instead of whatever `mw` itself would have sent. Any other status code
// (200 from a successful next(), or a redirect for the non-API path
// `adminMiddleware` also supports) passes through untouched.
function wrapping403Body(mw, replacement) {
  return function wrapped(req, res, next) {
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode === 403) return originalJson(replacement);
      return originalJson(body);
    };
    mw(req, res, (err) => {
      // Restore before continuing so downstream handlers (and any OTHER
      // wrapped gate further down the chain, e.g. adminWriteGate sitting
      // after adminReadGate) get an unpatched res.json to build on.
      res.json = originalJson;
      next(err);
    });
  };
}

// Read gate: mounted once via `router.use(adminReadGate)` at the top of
// the composed admin router (../admin.js) — gates every method on
// `is_admin` (a view-only admin may read everything). SPEC 2193's exact
// wording, verbatim.
const adminReadGate = wrapping403Body(adminMiddleware, {
  success: false,
  error: 'Unauthorized. Admin access required.',
});

// Write gate: applied per-route to every mutating handler (POST/PUT/
// PATCH/DELETE) across all three D-groups in this task, per Global
// Constraints #2 ("requireAdminWrite gates EVERY mutating handler").
// SPEC does not give this 403's exact wording (only the read gate's is
// specced at 2193); "Full admin access required." is the v4-enveloped
// form of the platform middleware's own message, kept as close to the
// source wording as the §4.8 envelope allows.
const adminWriteGate = wrapping403Body(requireAdminWrite, {
  success: false,
  error: 'Full admin access required.',
});

module.exports = { adminReadGate, adminWriteGate };
