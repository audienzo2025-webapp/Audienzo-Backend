const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

// Define demo booking schema and model
const demoBookingSchema = new mongoose.Schema({
  fullName: { type: String, required: true },
  email: { type: String, required: true },
  phoneNumber: { type: String, required: true },
  organization: { type: String, required: true },
  preferredDateTime: { type: String, required: true },
  message: { type: String },
  createdAt: { type: Date, default: Date.now }
});

const DemoBooking = mongoose.model('DemoBooking', demoBookingSchema);

// POST /api/book-demo
router.post('/book-demo', async (req, res) => {
  try {
    const { fullName, email, phoneNumber, organization, preferredDateTime, message } = req.body;

    // Validate required fields
    if (!fullName || fullName.trim() === '') {
      return res.status(400).json({ success: false, message: 'Full Name is required.' });
    }

    if (!email || email.trim() === '') {
      return res.status(400).json({ success: false, message: 'Email is required.' });
    }

    if (!phoneNumber || phoneNumber.trim() === '') {
      return res.status(400).json({ success: false, message: 'Phone Number is required.' });
    }

    if (!organization || organization.trim() === '') {
      return res.status(400).json({ success: false, message: 'Organization / Company Name is required.' });
    }

    if (!preferredDateTime || preferredDateTime.trim() === '') {
      return res.status(400).json({ success: false, message: 'Preferred Demo Date & Time is required.' });
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
    }

    const demoBooking = new DemoBooking({
      fullName: fullName.trim(),
      email: email.trim(),
      phoneNumber: phoneNumber.trim(),
      organization: organization.trim(),
      preferredDateTime: preferredDateTime.trim(),
      message: message ? message.trim() : null
    });

    await demoBooking.save();

    res.json({ success: true, message: 'Demo booking request submitted successfully. We will contact you soon!' });
  } catch (error) {
    console.error('Error saving demo booking:', error);
    res.status(500).json({ success: false, message: 'Internal server error. Please try again later.' });
  }
});

module.exports = router;

