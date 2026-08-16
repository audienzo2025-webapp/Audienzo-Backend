const express = require('express');
const router = express.Router();
const SupportTicket = require('../models/SupportTicket');
const { getAuthUser } = require('../utils/authUser');

/**
 * POST /api/support
 * Create a support ticket (event manager / organizer). Requires logged-in session.
 */
router.post('/', async (req, res) => {
  try {
    const authed = getAuthUser(req);
    if (!authed) {
      return res.status(401).json({ success: false, message: 'Please log in to submit a support request.' });
    }
    const { subject, message, priority } = req.body;
    if (!subject || !message || !subject.trim() || !message.trim()) {
      return res.status(400).json({ success: false, message: 'Subject and message are required.' });
    }
    const ticket = new SupportTicket({
      userId: authed._id,
      subject: subject.trim(),
      message: message.trim(),
      priority: ['low', 'medium', 'high', 'urgent'].includes(priority) ? priority : 'medium'
    });
    await ticket.save();
    const obj = ticket.toObject();
    res.status(201).json({
      success: true,
      message: 'Support request submitted. We will get back to you soon.',
      data: obj
    });
  } catch (error) {
    console.error('Support ticket create error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to submit support request',
      error: error.message
    });
  }
});

/**
 * GET /api/support/my
 * List current user's own tickets (for organizer dashboard).
 */
router.get('/my', async (req, res) => {
  try {
    const authed = getAuthUser(req);
    if (!authed) {
      return res.status(401).json({ success: false, message: 'Please log in.' });
    }
    const tickets = await SupportTicket.find({ userId: authed._id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json({ success: true, data: tickets });
  } catch (error) {
    console.error('Support my tickets error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch tickets', error: error.message });
  }
});

module.exports = router;
