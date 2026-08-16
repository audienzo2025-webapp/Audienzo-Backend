const express = require('express');
const router = express.Router();
const multer = require('multer');
const csvParser = require('csv-parser');
const mongoose = require('mongoose');
const { sendBulkEmail } = require('../services/emailService');
const UsageAlertService = require('../services/usageAlertService');
const { validateEmailLimits } = require('../middleware/planLimitsMiddleware');
const PlanLimitsService = require('../services/planLimitsService');
const { getAuthUser } = require('../utils/authUser');
const { canModifyConference } = require('../utils/conferenceOrganizerAccess');
const { uploadImage } = require('../config/cloudinary');
const Conference = require('../models/Conference');

async function findRegistrationsForConference(conferenceId) {
  const eventObjectId = new mongoose.Types.ObjectId(conferenceId);
  const Registration = require('../models/Registration');
  return Registration.find({
    $or: [
      { conferenceId: eventObjectId },
      { conferenceId: String(conferenceId) },
    ],
  }).lean();
}

// 🔹 Multer Memory Storage
const multerStorage = multer.memoryStorage();

const MAX_ATTACHMENT_COUNT = 10;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

// 🔹 Allowed attachment types (email) + CSV for recipient list
const allowedMimeTypes = new Set([
  'text/csv',
  'text/plain',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/png',
  'image/jpg',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/octet-stream'
]);

const allowedAttachmentExt = /\.(pdf|doc|docx|png|jpe?g|gif|webp|csv)$/i;

const fileFilter = (req, file, cb) => {
  const name = (file.originalname || '').toLowerCase();
  if (file.fieldname === 'csvUpload') {
    return name.endsWith('.csv') || file.mimetype === 'text/csv'
      ? cb(null, true)
      : cb(new Error('Recipient CSV must be a .csv file.'), false);
  }
  if (allowedMimeTypes.has(file.mimetype) || allowedAttachmentExt.test(name)) {
    return cb(null, true);
  }
  cb(new Error(`Invalid attachment "${file.originalname}". Allowed: PDF, DOC, DOCX, PNG, JPG, GIF, WEBP, CSV.`), false);
};

/** Build attachment array from multer files for emailService */
function collectEmailAttachments(files) {
  const list = [];
  if (files && files.attachment) {
    for (const file of files.attachment) {
      list.push({
        filename: file.originalname,
        content: file.buffer,
        type: file.mimetype
      });
    }
  }
  return list;
}

// 🔹 Multer Middleware
const uploadFiles = multer({
  storage: multerStorage,
  fileFilter,
  limits: { fileSize: MAX_ATTACHMENT_BYTES }
}).fields([
  { name: 'attachment', maxCount: MAX_ATTACHMENT_COUNT },
  { name: 'csvUpload', maxCount: 1 }
]);

function handleUpload(req, res, next) {
  uploadFiles(req, res, (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? 'Each attachment must be 10MB or smaller.'
        : (err.message || 'File upload failed.');
      return res.status(400).json({ success: false, message });
    }
    next();
  });
}

router.post('/upload-communication-image', uploadImage.single('image'), async (req, res) => {
  try {
    if (!getAuthUser(req)) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    if (!req.file?.path) {
      return res.status(400).json({ success: false, message: 'No image file provided' });
    }
    res.json({
      success: true,
      data: {
        url: req.file.path,
        publicId: req.file.filename,
      },
    });
  } catch (error) {
    console.error('Communication image upload error:', error);
    res.status(500).json({ success: false, message: 'Failed to upload image' });
  }
});

router.post('/send-bulk-mail', handleUpload, validateEmailLimits, async (req, res) => {
  try {
    if (!getAuthUser(req)) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    let recipients = [];
    let eventRegistrantRecipients = [];
    let scopedToEvent = false;
    let eventTitle = (req.body.conferenceTitle || '').toString().trim();
    const { recipientGroups, conferenceId } = req.body;
    const groupIds = (recipientGroups || '')
      .split(',')
      .map((g) => g.trim())
      .filter(Boolean);
    const wantsAllRegistrants = groupIds.includes('all-registrants');

    if (wantsAllRegistrants) {
      if (!conferenceId) {
        return res.status(400).json({
          success: false,
          message: 'Event ID is required when sending to all registrants.',
        });
      }
      if (!mongoose.Types.ObjectId.isValid(conferenceId)) {
        return res.status(400).json({ success: false, message: 'Invalid event ID.' });
      }
      if (!(await canModifyConference(req, conferenceId))) {
        return res.status(403).json({ success: false, message: 'Not authorized to email registrants for this event.' });
      }

      const conference = await Conference.findById(conferenceId).select('_id title').lean();
      if (!conference) {
        return res.status(404).json({ success: false, message: 'Event not found.' });
      }
      if (!eventTitle) {
        eventTitle = (conference.title || '').toString();
      }

      const registrations = await findRegistrationsForConference(conferenceId);
      scopedToEvent = true;

      registrations.forEach((reg) => {
        const email = (reg.email || '').toString().trim().toLowerCase();
        if (email && /\S+@\S+\.\S+/.test(email) && !eventRegistrantRecipients.includes(email)) {
          eventRegistrantRecipients.push(email);
        }
      });

      recipients = recipients.concat(eventRegistrantRecipients);

      const expectedCount = Number(req.body.expectedEventRegistrantCount);
      if (
        Number.isFinite(expectedCount) &&
        expectedCount >= 0 &&
        eventRegistrantRecipients.length !== expectedCount
      ) {
        console.warn(
          `[bulk-mail] Registrant count mismatch for event ${conferenceId}: expected ${expectedCount}, got ${eventRegistrantRecipients.length}`
        );
      }
    } else if (recipientGroups && conferenceId) {
      if (!mongoose.Types.ObjectId.isValid(conferenceId)) {
        return res.status(400).json({ success: false, message: 'Invalid event ID.' });
      }
      if (!(await canModifyConference(req, conferenceId))) {
        return res.status(403).json({ success: false, message: 'Not authorized to email registrants for this event.' });
      }
    }

    // Legacy path: other recipient group ids (none today besides all-registrants)
    if (recipientGroups && conferenceId && !wantsAllRegistrants) {
      for (const groupId of groupIds) {
        if (groupId === 'all-registrants') {
          const registrations = await findRegistrationsForConference(conferenceId);
          registrations.forEach((reg) => {
            const email = (reg.email || '').toString().trim().toLowerCase();
            if (email && /\S+@\S+\.\S+/.test(email) && !recipients.includes(email)) {
              recipients.push(email);
            }
          });
        }
      }
    }

    // 🔹 Parse CSV File
    if (req.files && req.files['csvUpload']) {
      const csvBuffer = req.files['csvUpload'][0].buffer;
      const stream = require('stream');
      const readable = new stream.Readable();
      readable.push(csvBuffer);
      readable.push(null);

      await new Promise((resolve, reject) => {
        readable
          .pipe(csvParser())
          .on('data', (row) => {
            const email = Object.values(row)[0]?.trim();
            if (email && /\S+@\S+\.\S+/.test(email)) recipients.push(email);
          })
          .on('end', resolve)
          .on('error', reject);
      });
    }

    // 🔹 Manual Emails
    if (req.body.recipients) {
      const manualEmails = req.body.recipients
        .split(',')
        .map(e => e.trim())
        .filter(e => /\S+@\S+\.\S+/.test(e));
      recipients = recipients.concat(manualEmails);
    }

    if (recipients.length === 0) {
      return res.status(400).json({ success: false, message: "No valid email addresses provided." });
    }

    // Dedupe recipients (case-insensitive)
    recipients = [...new Set(recipients.map((e) => String(e).trim().toLowerCase()).filter(Boolean))];

    const attachments = collectEmailAttachments(req.files);

    const sendResult = await sendBulkEmail(
      recipients, 
      req.body.subject || "No Subject", 
      req.body.message || "No Message Content", 
      req.body.htmlMessage || req.body.message || "No Message Content",
      null, // No scheduled time for bulk emails
      attachments
    );
    
    // Update email count after successful sending
    const authed = getAuthUser(req);
    if (authed) {
      await PlanLimitsService.updateEmailCount(authed._id, recipients.length);
      
      // Check usage limits and send alert if needed
      try {
        const userId = authed._id;
        const user = await require('../models/User').findById(userId);
        if (user && user.usageStats) {
          const currentCount = user.usageStats.emailsSent || 0;
          const planLimits = PlanLimitsService.getPlanLimits(user.selectedPlan || 'free');
          const limit = planLimits.emails;
          
          if (limit > 0) { // Only check if there's a limit
            await UsageAlertService.checkEmailLimits(userId, currentCount, limit);
          }
        }
      } catch (alertError) {
        console.error('Error checking usage alerts after email sending:', alertError);
        // Don't fail the email sending if alert fails
      }
    }
    
    res.json({
      success: true,
      message: sendResult.failed
        ? `Emails sent to ${sendResult.sent} recipient(s). ${sendResult.failed} failed.`
        : 'Emails sent successfully via ZeptoMail!',
      recipientCount: sendResult.sent,
      failedCount: sendResult.failed || 0,
      eventId: scopedToEvent ? conferenceId : undefined,
      eventTitle: scopedToEvent ? eventTitle : undefined,
      eventRegistrantCount: scopedToEvent ? eventRegistrantRecipients.length : undefined,
      scopedToEvent,
    });

  } catch (error) {
    console.error("❌ Error sending emails:", error);
    res.status(500).json({ success: false, message: error.message || "Error sending emails" });
  }
});

// 🔹 POST Individual Mail
router.post('/send-individual-mail', handleUpload, validateEmailLimits, async (req, res) => {
  try {
    if (!getAuthUser(req)) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const { recipient, subject, message, htmlMessage } = req.body;

    if (!recipient || !/\S+@\S+\.\S+/.test(recipient)) {
      return res.status(400).json({ success: false, message: 'A valid recipient email is required.' });
    }
    if (!subject || !subject.trim()) {
      return res.status(400).json({ success: false, message: 'Subject is required.' });
    }
    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, message: 'Message is required.' });
    }

    const attachments = collectEmailAttachments(req.files);

    await sendBulkEmail(
      [recipient], 
      subject, 
      message, 
      htmlMessage || message,
      null, // No scheduled time for individual emails
      attachments
    );
    
    // Update email count after successful sending
    const authed = getAuthUser(req);
    if (authed) {
      await PlanLimitsService.updateEmailCount(authed._id, 1);
      
      // Check usage limits and send alert if needed
      try {
        const userId = authed._id;
        const user = await require('../models/User').findById(userId);
        if (user && user.usageStats) {
          const currentCount = user.usageStats.emailsSent || 0;
          const planLimits = PlanLimitsService.getPlanLimits(user.selectedPlan || 'free');
          const limit = planLimits.emails;
          
          if (limit > 0) { // Only check if there's a limit
            await UsageAlertService.checkEmailLimits(userId, currentCount, limit);
          }
        }
      } catch (alertError) {
        console.error('Error checking usage alerts after individual email sending:', alertError);
        // Don't fail the email sending if alert fails
      }
    }
    
    res.json({ success: true, message: 'Email sent successfully via ZeptoMail!' });

  } catch (error) {
    console.error('❌ Error sending individual email:', error);
    res.status(500).json({ success: false, message: error.message || 'Error sending email' });
  }
});

module.exports = router;
