const User = require('../models/User');
const { getAuthUser } = require('../utils/authUser');

/**
 * Middleware to verify blog editor access
 * Checks if user is authenticated and has blogEditor role
 */
const blogEditorAuthMiddleware = async (req, res, next) => {
  try {
    const authed = getAuthUser(req);
    if (!authed) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized: Please log in'
      });
    }

    // Fetch user from database to check role
    const user = await User.findById(authed._id);
    
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check if user is blog editor, admin (Super Admin), or audienzoTeam (Resource Posting)
    const allowedRoles = ['blogEditor', 'admin', 'audienzoTeam'];
    const hasRole = allowedRoles.includes(user.role) || user.isBlogEditor || user.isAdmin;
    if (!hasRole) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: Resource posting access required'
      });
    }

    // Deactivated team members cannot access
    if (user.isActive === false) {
      return res.status(403).json({
        success: false,
        message: 'Account is deactivated'
      });
    }

    // Attach user to request for use in routes
    req.blogEditorUser = user;
    next();
  } catch (error) {
    console.error('Blog editor auth middleware error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

module.exports = blogEditorAuthMiddleware;
