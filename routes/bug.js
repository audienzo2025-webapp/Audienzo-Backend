const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

// Define feedback schema and model (you can move this to a separate file if needed)
const feedbackSchema = new mongoose.Schema({
  description: { type: String, required: true },
  email: { type: String },
  createdAt: { type: Date, default: Date.now }
});

const Feedback = mongoose.model('Feedback', feedbackSchema);

// POST /api/submit-feedback
router.post('/submit-feedback', async (req, res) => {
  try {
    const { description, email } = req.body;

    if (!description || description.trim() === '') {
      return res.status(400).json({ success: false, message: 'Description is required.' });
    }

    const feedback = new Feedback({
      description,
      email: email || null
    });

    await feedback.save();

    res.json({ success: true, message: 'Feedback submitted successfully.' });
  } catch (error) {
    console.error('Error saving feedback:', error);
    res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

module.exports = router;
