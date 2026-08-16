const express = require("express");
const router = express.Router();
const Conference = require("../models/Conference");
const Reminder = require("../models/Reminder");
const Registration = require("../models/Registration");
const User = require("../models/User");
const { sendBulkEmail, sendExpiryReminderEmail, sendUpgradeReminderEmail } = require("../services/emailService");
const UsageAlertService = require("../services/usageAlertService");
const cron = require("node-cron");
const { getAuthUser } = require("../utils/authUser");
const { canModifyConference } = require("../utils/conferenceOrganizerAccess");

// ✅ Handle reminder submission (store in database, don't send immediately)
router.post("/", async (req, res) => {
  try {
    const { conferenceId, recipients, scheduledTime, subject, message, htmlMessage, emailTemplate } = req.body;

    if (!getAuthUser(req)) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    if (!conferenceId || !(await canModifyConference(req, conferenceId))) {
      return res.status(403).json({ success: false, message: "Not authorized to manage reminders for this event." });
    }

    // Validate conference exists
    const conference = await Conference.findById(conferenceId);
    if (!conference) {
      return res.status(404).json({ success: false, message: "Conference not found." });
    }

    const reminderScheduledTime = new Date(scheduledTime);

    // Validate future time
    if (reminderScheduledTime <= new Date()) {
      return res.status(400).json({ success: false, message: "Scheduled time must be in the future." });
    }

    // Determine recipients for this event only
    let recipientEmails = [];
    const mongoose = require('mongoose');
    if (!mongoose.Types.ObjectId.isValid(conferenceId)) {
      return res.status(400).json({ success: false, message: 'Invalid event ID.' });
    }
    const eventObjectId = new mongoose.Types.ObjectId(conferenceId);
    const registrations = await Registration.find({ conferenceId: eventObjectId }).lean();

    if (recipients === "all-registrants") {
      registrations.forEach((reg) => {
        const email = (reg.email || '').toString().trim().toLowerCase();
        if (email && /\S+@\S+\.\S+/.test(email)) {
          recipientEmails.push(email);
        }
      });
    } else if (recipients === "confirmed-attendees") {
      registrations
        .filter((reg) => reg.status === "confirmed" || reg.attended)
        .forEach((reg) => {
          const email = (reg.email || '').toString().trim().toLowerCase();
          if (email && /\S+@\S+\.\S+/.test(email)) {
            recipientEmails.push(email);
          }
        });
    }

    recipientEmails = [...new Set(recipientEmails)];

    if (recipientEmails.length === 0) {
      return res.status(400).json({ success: false, message: "No recipients found for the selected group." });
    }

    // Store reminder in database as scheduled
    const newReminder = new Reminder({
      conferenceId,
      scheduledTime: reminderScheduledTime,
      subject,
      message,
      htmlMessage: htmlMessage || '',
      emailTemplate: emailTemplate || 'announcement',
      recipients: recipientEmails,
      status: "scheduled" // ⬅️ Only store as scheduled; no sending here
    });

    await newReminder.save();

    res.json({
      success: true,
      message: `Reminder scheduled successfully for ${recipientEmails.length} recipients!`,
      recipientCount: recipientEmails.length
    });

  } catch (err) {
    console.error("Error scheduling reminder:", err);
    res.status(500).json({ success: false, message: "Failed to schedule reminder." });
  }
});

// ✅ Function to send reminders when due (used by cron job)
async function sendReminders() {
  try {
    const now = new Date();
    // Find all reminders whose time has passed but are still scheduled
    const reminders = await Reminder.find({
      scheduledTime: { $lte: now },
      status: "scheduled"
    });

    for (const reminder of reminders) {
      try {
        const conference = await Conference.findById(reminder.conferenceId);

        if (!conference) {
          console.warn(`⚠️ Conference not found for reminder ${reminder._id}`);
          continue;
        }

        // Send one email per recipient so addresses stay private
        await sendBulkEmail(
          reminder.recipients,
          reminder.subject,
          reminder.message,
          reminder.htmlMessage || reminder.message
        );

        // Mark as sent
        reminder.status = "sent";
        await reminder.save();
      } catch (emailErr) {
        console.error(`❌ Failed to send reminder ${reminder._id}:`, emailErr);
      }
    }
  } catch (err) {
    console.error("Error processing reminders:", err);
  }
}

// ✅ Function to send plan reminder emails (used by cron job)
async function sendPlanReminders() {
  try {
    const now = new Date();
    let emailsSent = 0;
    let errors = [];

    // Get all users with active subscriptions
    const users = await User.find({
      $or: [
        { selectedPlan: { $in: ['entry', 'business', 'enterprise', 'custom'] } },
        { selectedPlan: 'free' }
      ]
    });

    for (const user of users) {
      try {
        // Check if user has renewal reminders enabled
        const renewalRemindersEnabled = user.notificationSettings?.emailRenewal !== false; // Default to true if not set
        
        if (!renewalRemindersEnabled) {
          continue;
        }

        user.reminderTracking = user.reminderTracking || {};
        const reminderTracking = user.reminderTracking;

        if (user.selectedPlan === 'free') {
          // Check if free plan user should get upgrade reminder (2 days before plan selection date + 30 days)
          if (user.planSelectedAt) {
            const thirtyDaysFromSelection = new Date(user.planSelectedAt.getTime() + (30 * 24 * 60 * 60 * 1000));
            const twoDaysBeforeUpgrade = new Date(thirtyDaysFromSelection.getTime() - (2 * 24 * 60 * 60 * 1000));
            
            // Check if today is 2 days before the upgrade reminder date
            if (
              now.toDateString() === twoDaysBeforeUpgrade.toDateString() &&
              !isSameDay(reminderTracking.lastUpgradeTargetDate, twoDaysBeforeUpgrade)
            ) {
              await sendUpgradeReminderEmail(
                {
                  fullName: user.fullName,
                  email: user.email
                },
                user.planSelectedAt
              );
              emailsSent++;
              reminderTracking.lastUpgradeSentOn = now;
              reminderTracking.lastUpgradeTargetDate = twoDaysBeforeUpgrade;
              await user.save();
            }
          }
        } else {
          // Check if paid plan user should get expiry reminder (7 days before expiry)
          if (user.subscriptionEndDate) {
            const sevenDaysBeforeExpiry = new Date(user.subscriptionEndDate.getTime() - (7 * 24 * 60 * 60 * 1000));
            
            // Check if today is 7 days before expiry
            if (
              now.toDateString() === sevenDaysBeforeExpiry.toDateString() &&
              !isSameDay(reminderTracking.lastExpiryTargetDate, sevenDaysBeforeExpiry)
            ) {
              const planName = getPlanDisplayName(user.selectedPlan);
              const remainingDays = Math.ceil((user.subscriptionEndDate - now) / (1000 * 60 * 60 * 24));
              
              await sendExpiryReminderEmail(
                {
                  fullName: user.fullName,
                  email: user.email
                },
                user.selectedPlan,
                planName,
                user.subscriptionEndDate,
                remainingDays
              );
              emailsSent++;
              reminderTracking.lastExpirySentOn = now;
              reminderTracking.lastExpiryTargetDate = sevenDaysBeforeExpiry;
              await user.save();
            }
          }
        }
      } catch (error) {
        console.error(`❌ Error sending plan reminder email to ${user.email}:`, error);
        errors.push({
          email: user.email,
          error: error.message
        });
      }
    }

    if (emailsSent > 0) {
    }
  } catch (error) {
    console.error('Error processing plan reminder emails:', error);
  }
}

// Helper function to get plan display name
function getPlanDisplayName(planId) {
  const planNames = {
    'free': 'Free',
    'entry': 'Entry',
    'business': 'Business',
    'enterprise': 'Enterprise',
    'custom': 'Custom'
  };
  return planNames[planId] || 'Unknown Plan';
}

// Helper to compare only date parts
function isSameDay(dateA, dateB) {
  if (!dateA || !dateB) return false;
  return (
    dateA.getFullYear() === dateB.getFullYear() &&
    dateA.getMonth() === dateB.getMonth() &&
    dateA.getDate() === dateB.getDate()
  );
}

// ✅ Function to check usage alerts for all users (used by cron job)
async function checkUsageAlerts() {
  try {
    const now = new Date();
    let alertsSent = 0;
    let errors = [];

    // Get all users with active subscriptions
    const users = await User.find({
      $or: [
        { selectedPlan: { $in: ['free', 'entry', 'business', 'enterprise', 'custom'] } }
      ]
    });

    for (const user of users) {
      try {
        // Check if user has usage alerts enabled
        const usageAlertsEnabled = user.notificationSettings?.emailUsage !== false; // Default to true if not set
        
        if (!usageAlertsEnabled) {
          continue;
        }

        const planId = user.selectedPlan || 'free';
        const planLimits = require('../services/planLimitsService').getPlanLimits(planId);
        
        // Get real-time usage stats instead of stale user.usageStats
        const realTimeUsageStats = await require('../services/planLimitsService').getUserUsageStats(user._id);
        if (!realTimeUsageStats) {
          continue; // Skip if we can't get usage stats
        }

        // Check event limits
        if (planLimits.inPersonEvents > 0) {
          const currentEvents = realTimeUsageStats.usage.inPersonEvents || 0;
          if (currentEvents >= planLimits.inPersonEvents) {
            await UsageAlertService.checkEventLimits(user._id, currentEvents, planLimits.inPersonEvents);
            alertsSent++;
          }
        }

        // Check contact limits
        if (planLimits.contacts > 0) {
          const currentContacts = realTimeUsageStats.usage.contacts || 0;
          if (currentContacts >= planLimits.contacts) {
            await UsageAlertService.checkContactLimits(user._id, currentContacts, planLimits.contacts);
            alertsSent++;
          }
        }

        // Check email limits
        if (planLimits.emails > 0) {
          const currentEmails = realTimeUsageStats.usage.emailsSent || 0;
          if (currentEmails >= planLimits.emails) {
            await UsageAlertService.checkEmailLimits(user._id, currentEmails, planLimits.emails);
            alertsSent++;
          }
        }
      } catch (error) {
        console.error(`❌ Error checking usage alerts for ${user.email}:`, error);
        errors.push({
          email: user.email,
          error: error.message
        });
      }
    } 
  } catch (error) {
    console.error('Error processing usage alerts:', error);
  }
}

// ✅ Schedule cron job to check every minute
// Format: "* * * * *" = every minute
cron.schedule("* * * * *", async () => {
  console.log("⏰ Running scheduled reminder check...");
  await sendReminders(); // Conference reminders
  await sendPlanReminders(); // Plan reminder emails
  await checkUsageAlerts(); // Usage limit alerts
});

// ✅ Get reminders for a specific conference
router.get("/conference/:conferenceId", async (req, res) => {
  try {
    const { conferenceId } = req.params;
    if (!getAuthUser(req)) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    if (!(await canModifyConference(req, conferenceId))) {
      return res.status(403).json({ success: false, message: "Not authorized to view reminders for this event." });
    }
    const reminders = await Reminder.find({ conferenceId }).sort({ scheduledTime: 1 });
    res.json({ success: true, reminders });
  } catch (err) {
    console.error("Error fetching reminders:", err);
    res.status(500).json({ success: false, message: "Failed to fetch reminders." });
  }
});


// ✅ Delete reminder
router.delete("/:reminderId", async (req, res) => {
  try {
    const reminderId = req.params.reminderId;
    const existing = await Reminder.findById(reminderId);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Reminder not found." });
    }
    if (!getAuthUser(req)) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    if (!(await canModifyConference(req, existing.conferenceId))) {
      return res.status(403).json({ success: false, message: "Not authorized to delete this reminder." });
    }
    const reminder = await Reminder.findByIdAndDelete(reminderId);

    if (reminder) {
      res.json({ success: true, message: "Reminder deleted successfully!" });
    } else {
      res.status(404).json({ success: false, message: "Reminder not found." });
    }
  } catch (err) {
    console.error("Error deleting reminder:", err);
    res.status(500).json({ success: false, message: "Failed to delete reminder." });
  }
});

module.exports = router;
