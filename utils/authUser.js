/**
 * Unified auth: Bearer JWT (SPA / cross-origin) or express-session cookie.
 * Prefer JWT when present so token stays authoritative after hybrid login.
 */
function getAuthUser(req) {
  if (req.authUser) return req.authUser;
  if (req.session && req.session.user) return req.session.user;
  return null;
}

module.exports = { getAuthUser };
