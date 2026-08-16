const User = require('../models/User');
const { getAuthUser } = require('../utils/authUser');

/**
 * Middleware to verify admin access
 * Checks if user is authenticated and has admin role
 */
const adminAuthMiddleware = async (req, res, next) => {
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

    // Check if user is admin
    if (user.role !== 'admin' && !user.isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: Admin access required'
      });
    }

    // Attach user to request for use in routes
    req.adminUser = user;
    next();
  } catch (error) {
    console.error('Admin auth middleware error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

module.exports = adminAuthMiddleware;

