const { verifyUserToken } = require('../utils/jwtTokens');

/**
 * Parses Authorization: Bearer <jwt> and sets req.authUser (minimal session-like shape).
 */
function attachJwtUser(req, res, next) {
  req.authUser = null;
  const authHeader = req.headers.authorization;
  if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    return next();
  }
  const raw = authHeader.slice(7).trim();
  if (!raw) return next();
  try {
    const payload = verifyUserToken(raw);
    req.authUser = {
      _id: payload.sub,
      email: payload.email,
      role: payload.role,
      isAdmin: payload.isAdmin,
    };
  } catch (err) {
    // expired or invalid — leave req.authUser null; session may still apply
  }
  next();
}

module.exports = { attachJwtUser };
