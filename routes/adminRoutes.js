const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const adminAuthMiddleware = require('../middleware/adminAuthMiddleware');
const User = require('../models/User');
const Conference = require('../models/Conference');
const Registration = require('../models/Registration');
const SupportTicket = require('../models/SupportTicket');
const CollaboratorInvitation = require('../models/CollaboratorInvitation');
const bcrypt = require('bcryptjs');
const { sendEmail } = require('../services/emailService');
const { applySlugAliasesToLeanDoc } = require('../utils/conferenceSlug');

// Demo Booking Model
const demoBookingSchema = new mongoose.Schema({
  fullName: { type: String, required: true },
  email: { type: String, required: true },
  phoneNumber: { type: String, required: true },
  organization: { type: String, required: true },
  preferredDateTime: { type: String, required: true },
  message: { type: String },
  createdAt: { type: Date, default: Date.now }
});

const DemoBooking = mongoose.models.DemoBooking || mongoose.model('DemoBooking', demoBookingSchema);

// Apply admin middleware to all routes
router.use(adminAuthMiddleware);

/**
 * GET /api/admin/stats
 * Get overall statistics for the admin dashboard
 */
router.get('/stats', async (req, res) => {
  try {
    const now = new Date();
    const last7Days = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const last30Days = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const last90Days = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

    // User Statistics
    const totalUsers = await User.countDocuments();
    const activeUsers = await User.countDocuments({
      $or: [
        { 'usageStats.lastUpdated': { $gte: last30Days } },
        { createdAt: { $gte: last30Days } }
      ]
    });

    // Users by plan
    const usersByPlan = await User.aggregate([
      {
        $group: {
          _id: { $ifNull: ['$selectedPlan', 'no_plan'] },
          count: { $sum: 1 }
        }
      }
    ]);

    const planDistribution = {
      free: 0,
      entry: 0,
      business: 0,
      enterprise: 0,
      custom: 0,
      no_plan: 0
    };

    usersByPlan.forEach(item => {
      planDistribution[item._id] = item.count;
    });

    // Active and paid subscriptions (users with active paid plans)
    const activeSubscriptions = await User.countDocuments({
      selectedPlan: { $in: ['entry', 'business', 'enterprise', 'custom'] },
      subscriptionStatus: 'active',
      $or: [
        { subscriptionEndDate: { $gte: now } },
        { subscriptionEndDate: null }
      ]
    });

    const paidUsers = await User.countDocuments({
      selectedPlan: { $in: ['entry', 'enterprise', 'custom'] }
    });

    // Expiring subscriptions (next 30 days)
    const expiringSubscriptions = await User.countDocuments({
      selectedPlan: { $in: ['entry', 'business', 'enterprise', 'custom'] },
      subscriptionStatus: 'active',
      subscriptionEndDate: {
        $gte: now,
        $lte: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
      }
    });

    // Recent signups
    const recentSignups7Days = await User.countDocuments({
      createdAt: { $gte: last7Days }
    });

    const recentSignups30Days = await User.countDocuments({
      createdAt: { $gte: last30Days }
    });

    const recentSignups90Days = await User.countDocuments({
      createdAt: { $gte: last90Days }
    });

    // Signup trend (last 7 days - daily breakdown)
    const signupTrend = await User.aggregate([
      {
        $match: {
          createdAt: { $gte: last7Days }
        }
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$createdAt' }
          },
          count: { $sum: 1 }
        }
      },
      {
        $sort: { _id: 1 }
      }
    ]);

    // Payment status breakdown
    const paymentStatusBreakdown = await User.aggregate([
      {
        $group: {
          _id: { $ifNull: ['$paymentStatus', 'no_payment'] },
          count: { $sum: 1 }
        }
      }
    ]);

    // Event Statistics
    const totalEvents = await Conference.countDocuments();
    const eventsLast30Days = await Conference.countDocuments({
      createdAt: { $gte: last30Days }
    });
    const activeEvents = await Conference.countDocuments({
      status: 'published',
      endDate: { $gte: new Date().toISOString().split('T')[0] }
    });

    const activeOrganizers = (await Conference.distinct('createdBy', {
      updatedAt: { $gte: last30Days }
    })).length;

    const eventsByType = await Conference.aggregate([
      {
        $group: {
          _id: '$eventType',
          count: { $sum: 1 }
        }
      }
    ]);

    const eventsByStatus = await Conference.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ]);

    // Registration Statistics
    const totalRegistrations = await Registration.countDocuments();
    const registrationsLast30Days = await Registration.countDocuments({
      registeredAt: { $gte: last30Days }
    });
    const attendedRegistrations = await Registration.countDocuments({
      attended: true
    });

    // Usage Statistics
    const usageStats = await User.aggregate([
      {
        $group: {
          _id: null,
          avgEventsPerUser: { $avg: '$usageStats.totalEvents' },
          avgContactsPerUser: { $avg: '$usageStats.contacts' },
          avgEmailsPerUser: { $avg: '$usageStats.emailsSent' },
          totalEventsCreated: { $sum: '$usageStats.totalEvents' },
          totalContacts: { $sum: '$usageStats.contacts' },
          totalEmailsSent: { $sum: '$usageStats.emailsSent' }
        }
      }
    ]);

    const usage = usageStats[0] || {
      avgEventsPerUser: 0,
      avgContactsPerUser: 0,
      avgEmailsPerUser: 0,
      totalEventsCreated: 0,
      totalContacts: 0,
      totalEmailsSent: 0
    };

    res.json({
      success: true,
      data: {
        users: {
          total: totalUsers,
          active: activeUsers,
          byPlan: planDistribution,
          recentSignups: {
            last7Days: recentSignups7Days,
            last30Days: recentSignups30Days,
            last90Days: recentSignups90Days,
            trend: signupTrend.map(item => ({
              date: item._id,
              count: item.count
            }))
          }
        },
        subscriptions: {
          active: activeSubscriptions,
          paidUsers,
          expiring: expiringSubscriptions,
          byStatus: paymentStatusBreakdown.reduce((acc, item) => {
            acc[item._id] = item.count;
            return acc;
          }, {})
        },
        events: {
          total: totalEvents,
          last30Days: eventsLast30Days,
          active: activeEvents,
          byType: eventsByType.reduce((acc, item) => {
            acc[item._id] = item.count;
            return acc;
          }, {}),
          byStatus: eventsByStatus.reduce((acc, item) => {
            acc[item._id] = item.count;
            return acc;
          }, {})
        },
        registrations: {
          total: totalRegistrations,
          last30Days: registrationsLast30Days,
          attended: attendedRegistrations,
          attendanceRate: totalRegistrations > 0 
            ? ((attendedRegistrations / totalRegistrations) * 100).toFixed(2)
            : 0
        },
        usage: usage,
        reach: {
          activeOrganizers,
          eventsLast30Days,
          registrationsLast30Days,
          avgRegistrationsPerEvent: totalEvents > 0 ? Number((totalRegistrations / totalEvents).toFixed(1)) : 0
        }
      }
    });
  } catch (error) {
    console.error('Admin stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch statistics',
      error: error.message
    });
  }
});

/**
 * GET /api/admin/users
 * Get list of users with pagination and filters
 */
router.get('/users', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    
    const filter = {};
    
    // Filter by plan
    if (req.query.plan) {
      if (req.query.plan === 'no_plan') {
        filter.selectedPlan = null;
      } else {
        filter.selectedPlan = req.query.plan;
      }
    }
    
    // Filter by subscription status
    if (req.query.subscriptionStatus) {
      filter.subscriptionStatus = req.query.subscriptionStatus;
    }
    
    // Filter by date range
    if (req.query.startDate || req.query.endDate) {
      filter.createdAt = {};
      if (req.query.startDate) {
        filter.createdAt.$gte = new Date(req.query.startDate);
      }
      if (req.query.endDate) {
        filter.createdAt.$lte = new Date(req.query.endDate);
      }
    }

    // Filter by role (e.g. role=user for event managers only)
    if (req.query.role) {
      filter.role = req.query.role;
    }

    // Search by email or name
    if (req.query.search) {
      filter.$or = [
        { email: { $regex: req.query.search, $options: 'i' } },
        { fullName: { $regex: req.query.search, $options: 'i' } }
      ];
    }

    const users = await User.find(filter)
      .select('-password -resetPasswordToken')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await User.countDocuments(filter);

    res.json({
      success: true,
      data: {
        users,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    console.error('Admin users error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch users',
      error: error.message
    });
  }
});

/**
 * GET /api/admin/users/:id
 * Get detailed information about a specific user
 */
router.get('/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select('-password -resetPasswordToken');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Get user's events
    const events = await Conference.find({ createdBy: user._id })
      .select('_id title eventType status createdAt urlSlug slug startDate endDate')
      .sort({ createdAt: -1 })
      .limit(50);

    // Get user's registrations count
    const registrationsCount = await Registration.countDocuments({
      email: user.email
    });

    res.json({
      success: true,
      data: {
        user,
        events,
        registrationsCount
      }
    });
  } catch (error) {
    console.error('Admin user details error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch user details',
      error: error.message
    });
  }
});

/**
 * PUT /api/admin/users/:id
 * Update event manager (user) account. Super Admin only. Cannot change role to admin.
 */
router.put('/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }
    // Do not allow editing admin users (safety)
    if (user.role === 'admin' || user.isAdmin) {
      return res.status(403).json({ success: false, message: 'Cannot edit Super Admin account from this panel.' });
    }
    const {
      fullName,
      organization,
      phone,
      email,
      selectedPlan,
      subscriptionStatus,
      isActive
    } = req.body;
    if (fullName !== undefined) user.fullName = fullName || '';
    if (organization !== undefined) user.organization = organization || '';
    if (phone !== undefined) user.phone = phone || '';
    if (selectedPlan !== undefined) {
      if (['free', 'entry', 'business', 'enterprise', 'custom', null].includes(selectedPlan)) {
        user.selectedPlan = selectedPlan;
      }
    }
    if (subscriptionStatus !== undefined) {
      if (['active', 'expired', 'cancelled', null].includes(subscriptionStatus)) {
        user.subscriptionStatus = subscriptionStatus;
      }
    }
    if (typeof isActive === 'boolean') user.isActive = isActive;
    if (email !== undefined && email && email !== user.email) {
      const existing = await User.findOne({ email: email.toLowerCase() });
      if (existing) {
        return res.status(409).json({ success: false, message: 'Email already in use.' });
      }
      user.email = email.toLowerCase();
    }
    await user.save();
    const userObj = user.toObject();
    delete userObj.password;
    delete userObj.resetPasswordToken;
    res.json({
      success: true,
      message: 'User updated.',
      data: userObj
    });
  } catch (error) {
    console.error('Admin user update error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update user',
      error: error.message
    });
  }
});

/**
 * POST /api/admin/users/:id/reset-password
 * Set a new temporary password for an event manager. Super Admin only. Optionally emails the user.
 */
router.post('/users/:id/reset-password', async (req, res) => {
  try {
    const { newPassword, sendEmailToUser } = req.body;
    if (!newPassword || typeof newPassword !== 'string') {
      return res.status(400).json({ success: false, message: 'New password is required.' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }
    if (user.role === 'admin' || user.isAdmin) {
      return res.status(403).json({ success: false, message: 'Cannot reset Super Admin account.' });
    }
    user.password = await bcrypt.hash(newPassword, 10);
    user.resetPasswordToken = null;
    user.resetPasswordExpires = null;
    await user.save();

    if (sendEmailToUser && user.email) {
      const subject = 'Your Audienzo password was reset';
      const text = `Hello,\n\nYour Audienzo account password was reset by an administrator.\n\nYour new temporary password is: ${newPassword}\n\nPlease log in and change your password in account settings.\n\n— The Audienzo Team`;
      const html = `
        <div style="font-family:sans-serif;max-width:480px;margin:auto;">
          <h2>Password reset by administrator</h2>
          <p>Hello,</p>
          <p>Your Audienzo account password was reset by an administrator.</p>
          <p><strong>Your new temporary password is:</strong> <code style="background:#f0f0f0;padding:2px 6px;">${newPassword}</code></p>
          <p>Please log in and change your password in account settings.</p>
          <p>— The Audienzo Team</p>
        </div>
      `;
      try {
        await sendEmail(user.email, subject, text, html);
      } catch (e) {
        console.error('Admin reset-password email error:', e);
        return res.status(200).json({
          success: true,
          message: 'Password was updated. Failed to send email to user.'
        });
      }
    }

    res.json({
      success: true,
      message: sendEmailToUser ? 'Password updated and user has been emailed.' : 'Password updated.'
    });
  } catch (error) {
    console.error('Admin user reset-password error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reset password',
      error: error.message
    });
  }
});

/**
 * DELETE /api/admin/users/:id
 * Permanently delete event manager and their data (conferences, registrations, invitations). Super Admin only.
 */
router.delete('/users/:id', async (req, res) => {
  try {
    const userId = req.params.id;
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }
    if (user.role === 'admin' || user.isAdmin) {
      return res.status(403).json({ success: false, message: 'Cannot delete Super Admin account.' });
    }
    const conferenceIds = await Conference.find({ createdBy: userId }).distinct('_id');
    await Registration.deleteMany({ conferenceId: { $in: conferenceIds } });
    await Conference.deleteMany({ createdBy: userId });
    await CollaboratorInvitation.deleteMany({ eventOwner: userId });
    await SupportTicket.deleteMany({ userId });
    await User.findByIdAndDelete(userId);
    res.json({
      success: true,
      message: 'User and associated data deleted.'
    });
  } catch (error) {
    console.error('Admin user delete error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete user',
      error: error.message
    });
  }
});

/**
 * GET /api/admin/recent-signups
 * Get recent user signups
 */
router.get('/recent-signups', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const days = parseInt(req.query.days) || 7;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const users = await User.find({
      createdAt: { $gte: startDate }
    })
      .select('email fullName organization selectedPlan subscriptionStatus createdAt')
      .sort({ createdAt: -1 })
      .limit(limit);

    res.json({
      success: true,
      data: users
    });
  } catch (error) {
    console.error('Admin recent signups error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch recent signups',
      error: error.message
    });
  }
});

/**
 * GET /api/admin/recent-logins
 * Get recent user logins (users with lastLoginAt set, sorted by most recent)
 */
router.get('/recent-logins', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const users = await User.find({ lastLoginAt: { $ne: null } })
      .select('email fullName lastLoginAt')
      .sort({ lastLoginAt: -1 })
      .limit(limit)
      .lean();

    res.json({
      success: true,
      data: users
    });
  } catch (error) {
    console.error('Admin recent logins error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch recent logins',
      error: error.message
    });
  }
});

/**
 * GET /api/admin/plans
 * Get plan distribution statistics
 */
router.get('/plans', async (req, res) => {
  try {
    const planStats = await User.aggregate([
      {
        $group: {
          _id: { $ifNull: ['$selectedPlan', 'no_plan'] },
          count: { $sum: 1 },
          activeSubscriptions: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $in: ['$selectedPlan', ['entry', 'business', 'enterprise', 'custom']] },
                    { $eq: ['$subscriptionStatus', 'active'] }
                  ]
                },
                1,
                0
              ]
            }
          }
        }
      }
    ]);

    res.json({
      success: true,
      data: planStats
    });
  } catch (error) {
    console.error('Admin plans error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch plan statistics',
      error: error.message
    });
  }
});

/**
 * GET /api/admin/coordinator-events
 * All platform events with registrant/attendee counts for the super admin coordinator dashboard
 */
router.get('/coordinator-events', async (req, res) => {
  try {
    const parsedLimit = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 500) : 500;
    const conferences = await Conference.find()
      .populate('createdBy', 'email fullName')
      .sort({ createdAt: -1 })
      .limit(limit);

    const data = await Promise.all(
      conferences.map(async (conf) => {
        const registrants = await Registration.countDocuments({ conferenceId: conf._id });
        const attendees = await Registration.countDocuments({ conferenceId: conf._id, attended: true });
        return {
          ...applySlugAliasesToLeanDoc(conf.toObject()),
          registrants,
          attendees
        };
      })
    );

    res.json({ success: true, data });
  } catch (error) {
    console.error('Admin coordinator events error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch coordinator events',
      error: error.message
    });
  }
});

/**
 * GET /api/admin/events
 * Get event statistics
 */
router.get('/events', async (req, res) => {
  try {
    const parsedLimit = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 500) : 50;
    const events = await Conference.find()
      .select('_id title eventType status createdAt createdBy urlSlug slug startDate endDate')
      .populate('createdBy', 'email fullName')
      .sort({ createdAt: -1 })
      .limit(limit);

    res.json({
      success: true,
      data: events
    });
  } catch (error) {
    console.error('Admin events error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch events',
      error: error.message
    });
  }
});

/**
 * GET /api/admin/demo-bookings
 * Get all demo bookings for admin dashboard
 */
router.get('/demo-bookings', async (req, res) => {
  try {
    const { limit = 50, sort = 'desc' } = req.query;
    
    const sortOrder = sort === 'asc' ? 1 : -1;
    const bookings = await DemoBooking.find()
      .sort({ createdAt: sortOrder })
      .limit(parseInt(limit))
      .lean();

    res.json({
      success: true,
      data: bookings,
      count: bookings.length
    });
  } catch (error) {
    console.error('Error fetching demo bookings:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch demo bookings'
    });
  }
});

// ---------- Support tickets (Super Admin: list/update; event managers create via POST /api/support) ----------

/**
 * GET /api/admin/support
 * List all support tickets with optional filters.
 */
router.get('/support', async (req, res) => {
  try {
    const { limit = 50, status, userId } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (userId) filter.userId = userId;
    const tickets = await SupportTicket.find(filter)
      .populate('userId', 'email fullName organization')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit) || 50)
      .lean();
    res.json({ success: true, data: tickets, count: tickets.length });
  } catch (error) {
    console.error('Admin support list error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch support tickets', error: error.message });
  }
});

/**
 * GET /api/admin/support/:id
 * Get one support ticket.
 */
router.get('/support/:id', async (req, res) => {
  try {
    const ticket = await SupportTicket.findById(req.params.id)
      .populate('userId', 'email fullName organization phone');
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found.' });
    }
    res.json({ success: true, data: ticket });
  } catch (error) {
    console.error('Admin support get error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch ticket', error: error.message });
  }
});

/**
 * PUT /api/admin/support/:id
 * Update ticket status, priority, admin notes.
 */
router.put('/support/:id', async (req, res) => {
  try {
    const ticket = await SupportTicket.findById(req.params.id);
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found.' });
    }
    const { status, priority, adminNotes } = req.body;
    if (status && ['open', 'in_progress', 'resolved', 'closed'].includes(status)) {
      ticket.status = status;
      if (status === 'resolved' || status === 'closed') {
        ticket.resolvedAt = ticket.resolvedAt || new Date();
        ticket.resolvedBy = req.adminUser._id;
      }
    }
    if (priority && ['low', 'medium', 'high', 'urgent'].includes(priority)) ticket.priority = priority;
    if (adminNotes !== undefined) ticket.adminNotes = adminNotes;
    await ticket.save();
    const obj = ticket.toObject();
    res.json({ success: true, message: 'Ticket updated.', data: obj });
  } catch (error) {
    console.error('Admin support update error:', error);
    res.status(500).json({ success: false, message: 'Failed to update ticket', error: error.message });
  }
});

// ---------- Audienzo Team management (Super Admin only) ----------

/**
 * GET /api/admin/team
 * List Audienzo Team members (role audienzoTeam). Super Admin only.
 */
router.get('/team', async (req, res) => {
  try {
    const { limit = 50, active } = req.query;
    const filter = { role: 'audienzoTeam' };
    if (active !== undefined) {
      filter.isActive = active === 'true';
    }
    const team = await User.find(filter)
      .select('-password -resetPasswordToken -resetPasswordExpires')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit) || 50)
      .lean();

    res.json({
      success: true,
      data: team,
      count: team.length
    });
  } catch (error) {
    console.error('Admin team list error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch team',
      error: error.message
    });
  }
});

/**
 * POST /api/admin/team
 * Create Audienzo Team account. Super Admin only. Role is always audienzoTeam (never admin).
 */
router.post('/team', async (req, res) => {
  try {
    const { email, password, fullName } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ success: false, message: 'Email already exists.' });
    }
    const bcrypt = require('bcryptjs');
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({
      email: email.toLowerCase(),
      password: hashedPassword,
      fullName: fullName || '',
      role: 'audienzoTeam',
      isAdmin: false,
      isActive: true
    });
    await newUser.save();
    const userObj = newUser.toObject();
    delete userObj.password;
    res.status(201).json({
      success: true,
      message: 'Audienzo Team member created.',
      data: userObj
    });
  } catch (error) {
    console.error('Admin team create error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create team member',
      error: error.message
    });
  }
});

/**
 * PUT /api/admin/team/:id
 * Update Audienzo Team member (fullName, isActive). Cannot change role to admin. Super Admin only.
 */
router.put('/team/:id', async (req, res) => {
  try {
    const user = await User.findOne({ _id: req.params.id, role: 'audienzoTeam' });
    if (!user) {
      return res.status(404).json({ success: false, message: 'Team member not found.' });
    }
    const { fullName, isActive } = req.body;
    if (fullName !== undefined) user.fullName = fullName;
    if (typeof isActive === 'boolean') user.isActive = isActive;
    await user.save();
    const userObj = user.toObject();
    delete userObj.password;
    res.json({
      success: true,
      message: 'Team member updated.',
      data: userObj
    });
  } catch (error) {
    console.error('Admin team update error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update team member',
      error: error.message
    });
  }
});

/**
 * PATCH /api/admin/team/:id/activate
 * Activate Audienzo Team account. Super Admin only.
 */
router.patch('/team/:id/activate', async (req, res) => {
  try {
    const user = await User.findOne({ _id: req.params.id, role: 'audienzoTeam' });
    if (!user) {
      return res.status(404).json({ success: false, message: 'Team member not found.' });
    }
    user.isActive = true;
    await user.save();
    res.json({ success: true, message: 'Account activated.', data: { isActive: true } });
  } catch (error) {
    console.error('Admin team activate error:', error);
    res.status(500).json({ success: false, message: 'Failed to activate', error: error.message });
  }
});

/**
 * PATCH /api/admin/team/:id/deactivate
 * Deactivate Audienzo Team account. Super Admin only.
 */
router.patch('/team/:id/deactivate', async (req, res) => {
  try {
    const user = await User.findOne({ _id: req.params.id, role: 'audienzoTeam' });
    if (!user) {
      return res.status(404).json({ success: false, message: 'Team member not found.' });
    }
    user.isActive = false;
    await user.save();
    res.json({ success: true, message: 'Account deactivated.', data: { isActive: false } });
  } catch (error) {
    console.error('Admin team deactivate error:', error);
    res.status(500).json({ success: false, message: 'Failed to deactivate', error: error.message });
  }
});

module.exports = router;

