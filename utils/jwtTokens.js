const jwt = require('jsonwebtoken');

function getSecret() {
  const secret = process.env.JWT_SECRET || process.env.SESSION_SECRET;
  if (!secret) {
    console.warn('⚠️ JWT_SECRET / SESSION_SECRET missing — tokens will be insecure.');
  }
  return secret || 'default_secret';
}

/**
 * @param {import('mongoose').Document | object} user — must have _id, email, role, isAdmin
 */
function signUserToken(user) {
  const payload = {
    sub: String(user._id),
    email: user.email,
    role: user.role || 'user',
    isAdmin: !!user.isAdmin,
  };
  const expiresIn = process.env.JWT_EXPIRES_IN || '7d';
  return jwt.sign(payload, getSecret(), { expiresIn });
}

function verifyUserToken(token) {
  return jwt.verify(token, getSecret());
}

module.exports = { signUserToken, verifyUserToken, getSecret };
