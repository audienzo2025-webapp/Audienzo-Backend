const User = require('../models/User');
const { sendUsageAlertEmail } = require('./emailService');

class UsageAlertService {
  /**
   * Check if user has hit usage limits and send alert if needed
   * @param {string} userId - User ID
   * @param {string} limitType - Type of limit to check (events, contacts, emails)
   * @param {Object} usageInfo - Current usage information
   * @returns {Promise<boolean>} Whether an alert was sent
   */
  static async checkAndSendUsageAlert(userId, limitType, usageInfo) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        console.error('User not found for usage alert:', userId);
        return false;
      }

      // Check if user has usage alerts enabled
      const usageAlertsEnabled = user.notificationSettings?.emailUsage !== false; // Default to true if not set
      
      if (!usageAlertsEnabled) {
        return false;
      }

      // Check if user has already been notified about this limit recently
      const alertKey = `usageAlert_${limitType}`;
      const countKey = `usageAlertCount_${limitType}`;
      const lastAlertTime = user[alertKey] || null;
      const alertCount = user[countKey] || 0;
      const now = new Date();
      
      // Maximum 2 emails per limit type
      if (alertCount >= 2) {
        return false;
      }
      
      // Only send alert if not sent in the last 48 hours
      if (lastAlertTime && (now - lastAlertTime) < 48 * 60 * 60 * 1000) {
        return false;
      }

      // Check if limit is reached or exceeded
      if (usageInfo.current < usageInfo.limit) {
        return false;
      }

      // Send usage alert email
      await sendUsageAlertEmail(
        {
          fullName: user.fullName,
          email: user.email
        },
        limitType,
        usageInfo,
        user.selectedPlan || 'free'
      );

      // Update last alert time and increment count
      user[alertKey] = now;
      user[countKey] = alertCount + 1;
      await user.save();

      return true;
    } catch (error) {
      console.error('Error checking and sending usage alert:', error);
      return false;
    }
  }

  /**
   * Check event creation limits
   * @param {string} userId - User ID
   * @param {number} currentCount - Current event count
   * @param {number} limit - Event limit
   * @returns {Promise<boolean>} Whether an alert was sent
   */
  static async checkEventLimits(userId, currentCount, limit) {
    return await this.checkAndSendUsageAlert(userId, 'events', {
      current: currentCount,
      limit: limit
    });
  }

  /**
   * Check contact limits
   * @param {string} userId - User ID
   * @param {number} currentCount - Current contact count
   * @param {number} limit - Contact limit
   * @returns {Promise<boolean>} Whether an alert was sent
   */
  static async checkContactLimits(userId, currentCount, limit) {
    return await this.checkAndSendUsageAlert(userId, 'contacts', {
      current: currentCount,
      limit: limit
    });
  }

  /**
   * Check email limits
   * @param {string} userId - User ID
   * @param {number} currentCount - Current email count
   * @param {number} limit - Email limit
   * @returns {Promise<boolean>} Whether an alert was sent
   */
  static async checkEmailLimits(userId, currentCount, limit) {
    return await this.checkAndSendUsageAlert(userId, 'emails', {
      current: currentCount,
      limit: limit
    });
  }

  /**
   * Reset usage alert counts for a user (admin/testing purposes)
   * @param {string} userId - User ID
   * @param {string} limitType - Type of limit to reset (optional, resets all if not provided)
   * @returns {Promise<boolean>} Success status
   */
  static async resetAlertCounts(userId, limitType = null) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        console.error('User not found for resetting alert counts:', userId);
        return false;
      }

      if (limitType) {
        // Reset specific limit type
        user[`usageAlert_${limitType}`] = null;
        user[`usageAlertCount_${limitType}`] = 0;
      } else {
        // Reset all limit types
        user.usageAlert_events = null;
        user.usageAlertCount_events = 0;
        user.usageAlert_contacts = null;
        user.usageAlertCount_contacts = 0;
        user.usageAlert_emails = null;
        user.usageAlertCount_emails = 0;
      }

      await user.save();
      return true;
    } catch (error) {
      console.error('Error resetting alert counts:', error);
      return false;
    }
  }
}

module.exports = UsageAlertService;
