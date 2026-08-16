const User = require('../models/User');
const Conference = require('../models/Conference');
const Registration = require('../models/Registration');
const UsageAlertService = require('./usageAlertService');

// Plan limits configuration
const PLAN_LIMITS = {
  free: {
    inPersonEvents: 1,
    webinars: -1, // -1 means unlimited
    contacts: 500,
    paidEvents: false,
    qrCodeCheckins: false,
    customUrl: false,
    websiteIntegration: false,
    whiteLabelBranding: false,
    emails: 1000,
    analytics: 'basic',
    privacy: 'public' // 'public' or 'both'
  },
  entry: {
    inPersonEvents: -1, // -1 means unlimited (per-event model - tracked separately)
    webinars: -1, // -1 means unlimited
    contacts: 1000,
    paidEvents: true,
    qrCodeCheckins: true,
    customUrl: false,
    websiteIntegration: false,
    whiteLabelBranding: false,
    emails: 10000,
    analytics: 'basic',
    privacy: 'both'
  },
  business: {
    inPersonEvents: 25,
    webinars: -1, // -1 means unlimited
    contacts: 3000,
    paidEvents: true,
    qrCodeCheckins: true,
    customUrl: false,
    websiteIntegration: false,
    whiteLabelBranding: false,
    emails: 25000,
    analytics: 'basic',
    privacy: 'both'
  },
  enterprise: {
    inPersonEvents: -1, // -1 means unlimited
    webinars: -1, // -1 means unlimited
    contacts: 5000,
    paidEvents: true,
    qrCodeCheckins: true,
    customUrl: false,
    websiteIntegration: false,
    whiteLabelBranding: false,
    emails: 100000,
    analytics: 'advanced',
    privacy: 'both'
  },
  custom: {
    inPersonEvents: -1, // -1 means unlimited
    webinars: -1, // -1 means unlimited
    contacts: -1, // -1 means unlimited
    paidEvents: true,
    qrCodeCheckins: true,
    customUrl: true,
    websiteIntegration: true,
    whiteLabelBranding: true,
    emails: -1, // -1 means unlimited
    analytics: 'advanced',
    privacy: 'both'
  }
};

class PlanLimitsService {
  /**
   * Get plan limits for a specific plan
   * @param {string} planId - The plan ID (free, entry, business, enterprise, custom)
   * @returns {Object} Plan limits object
   */
  static getPlanLimits(planId) {
    return PLAN_LIMITS[planId] || PLAN_LIMITS.free;
  }

  /**
   * Get contact limit for a specific plan
   * @param {string} planId - The plan ID
   * @returns {number} Contact limit
   */
  static getContactLimit(planId) {
    const limits = {
      free: 500,
      entry: 1000,
      business: 3000,
      enterprise: 5000,
      custom: 9999 // Unlimited
    };
    return limits[planId] || limits.free;
  }

  /**
   * Get email limit for a specific plan
   * @param {string} planId - The plan ID
   * @returns {number} Email limit
   */
  static getEmailLimit(planId) {
    const limits = {
      free: 1000,
      entry: 10000,
      business: 25000,
      enterprise: 100000,
      custom: 999999 // Unlimited
    };
    return limits[planId] || limits.free;
  }

  /**
   * Check if user can create a specific type of event
   * @param {string} userId - User ID
   * @param {string} eventType - Type of event ('webinar' or 'in-person')
   * @param {boolean} isVirtual - Whether the event is virtual
   * @returns {Promise<Object>} { allowed: boolean, reason?: string, currentCount?: number, limit?: number }
   */
  static async canCreateEvent(userId, eventType, isVirtual = false) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        return { allowed: false, reason: 'User not found' };
      }

      const planId = user.selectedPlan || 'free';
      const limits = this.getPlanLimits(planId);

      // Determine if this is an in-person event or webinar
      const isInPersonEvent = !isVirtual;
      const isWebinar = isVirtual;

      if (isInPersonEvent) {
        // Check in-person event limits
        if (limits.inPersonEvents === 0) {
          return { 
            allowed: false, 
            reason: 'In-person events are not available in your current plan. Please upgrade to create in-person events.',
            currentCount: 0,
            limit: 0
          };
        }

        // Entry plan uses per-event tracking (purchasedEventCount)
        if (planId === 'entry') {
          const purchasedCount = user.purchasedEventCount || 0;
          const usedCount = await Conference.countDocuments({
            createdBy: userId,
            isVirtual: false,
            status: { $in: ['draft', 'published'] }
          });

          if (usedCount >= purchasedCount) {
            return {
              allowed: false,
              reason: 'You have used all your purchased events. Please purchase more events to create additional in-person events.',
              currentCount: usedCount,
              limit: purchasedCount
            };
          }

          return {
            allowed: true,
            currentCount: usedCount,
            limit: purchasedCount
          };
        }

        if (limits.inPersonEvents > 0) {
          // Count existing in-person events (for Business plan with 25 events limit)
          const currentCount = await Conference.countDocuments({
            createdBy: userId,
            isVirtual: false,
            status: { $in: ['draft', 'published'] }
          });

          if (currentCount >= limits.inPersonEvents) {
            return {
              allowed: false,
              reason: `You have reached the limit of ${limits.inPersonEvents} in-person events for your current plan. Please upgrade to create more in-person events.`,
              currentCount,
              limit: limits.inPersonEvents
            };
          }

          return {
            allowed: true,
            currentCount,
            limit: limits.inPersonEvents
          };
        }

        // Handle unlimited in-person events (Enterprise and Custom plans)
        if (limits.inPersonEvents === -1) {
          const currentCount = await Conference.countDocuments({
            createdBy: userId,
            isVirtual: false,
            status: { $in: ['draft', 'published'] }
          });

          return {
            allowed: true,
            currentCount,
            limit: 'unlimited'
          };
        }
      }

      if (isWebinar) {
        // Webinars are unlimited for all paid plans, but let's track them
        if (limits.webinars === 0) {
          return {
            allowed: false,
            reason: 'Webinars are not available in your current plan.',
            currentCount: 0,
            limit: 0
          };
        }

        // Count existing webinars
        const currentCount = await Conference.countDocuments({
          createdBy: userId,
          isVirtual: true,
          status: { $in: ['draft', 'published'] }
        });

        return {
          allowed: true,
          currentCount,
          limit: limits.webinars === -1 ? 'unlimited' : limits.webinars
        };
      }

      return { allowed: true };
    } catch (error) {
      console.error('Error checking event creation limits:', error);
      return { allowed: false, reason: 'Error checking limits' };
    }
  }

  /**
   * Check if user can create paid events
   * @param {string} userId - User ID
   * @returns {Promise<Object>} { allowed: boolean, reason?: string }
   */
  static async canCreatePaidEvent(userId) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        return { allowed: false, reason: 'User not found' };
      }

      const planId = user.selectedPlan || 'free';
      const limits = this.getPlanLimits(planId);

      if (!limits.paidEvents) {
        return {
          allowed: false,
          reason: 'Paid events are not available in your current plan. Please upgrade to create paid events.'
        };
      }

      return { allowed: true };
    } catch (error) {
      console.error('Error checking paid event limits:', error);
      return { allowed: false, reason: 'Error checking limits' };
    }
  }

  /**
   * Check if user can use QR code check-ins
   * @param {string} userId - User ID
   * @returns {Promise<Object>} { allowed: boolean, reason?: string }
   */
  static async canUseQrCodeCheckins(userId) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        return { allowed: false, reason: 'User not found' };
      }

      const planId = user.selectedPlan || 'free';
      const limits = this.getPlanLimits(planId);

      if (!limits.qrCodeCheckins) {
        return {
          allowed: false,
          reason: 'QR code check-ins are not available in your current plan. Please upgrade to use this feature.'
        };
      }

      return { allowed: true };
    } catch (error) {
      console.error('Error checking QR code limits:', error);
      return { allowed: false, reason: 'Error checking limits' };
    }
  }

  /**
   * Check if user can create private events
   * @param {string} userId - User ID
   * @returns {Promise<Object>} { allowed: boolean, reason?: string }
   */
  static async canCreatePrivateEvent(userId) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        return { allowed: false, reason: 'User not found' };
      }

      const planId = user.selectedPlan || 'free';
      const limits = this.getPlanLimits(planId);

      if (limits.privacy === 'public') {
        return {
          allowed: false,
          reason: 'Private events are not available in your current plan. Please upgrade to create private events.'
        };
      }

      return { allowed: true };
    } catch (error) {
      console.error('Error checking private event limits:', error);
      return { allowed: false, reason: 'Error checking limits' };
    }
  }

  /**
   * Get user's current usage statistics
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Usage statistics
   */
  static async getUserUsageStats(userId) {
    try {
      if (!userId) {
        return null;
      }

      const user = await User.findById(userId);
      if (!user) {
        return null;
      }

      const planId = user.selectedPlan || 'free';
      const limits = this.getPlanLimits(planId);

      const [inPersonEvents, webinars, totalEvents, contactsUsed, emailsSent] = await Promise.all([
        Conference.countDocuments({
          createdBy: userId,
          isVirtual: false,
          status: { $in: ['draft', 'published'] }
        }),
        Conference.countDocuments({
          createdBy: userId,
          isVirtual: true,
          status: { $in: ['draft', 'published'] }
        }),
        Conference.countDocuments({
          createdBy: userId,
          status: { $in: ['draft', 'published'] }
        }),
        // Count unique contacts across all user's events
        Registration.distinct('email', {
          conferenceId: { $in: await Conference.find({ createdBy: userId }).distinct('_id') }
        }).then(emails => emails.length),
        // Get emails sent from user's usage stats
        Promise.resolve(user.usageStats?.emailsSent || 0)
      ]);

      // For Entry plan, use purchasedEventCount as the limit
      let inPersonEventLimit = limits.inPersonEvents === -1 ? 'unlimited' : limits.inPersonEvents;
      if (planId === 'entry') {
        inPersonEventLimit = user.purchasedEventCount || 0;
      }

      const result = {
        planId,
        limits,
        usage: {
          inPersonEvents: {
            current: inPersonEvents,
            limit: inPersonEventLimit
          },
          webinars: {
            current: webinars,
            limit: limits.webinars === -1 ? 'unlimited' : limits.webinars
          },
          totalEvents: {
            current: totalEvents,
            limit: 'unlimited'
          },
          contactsUsed: {
            current: contactsUsed,
            limit: this.getContactLimit(planId)
          },
          emailsSent: {
            current: emailsSent,
            limit: this.getEmailLimit(planId)
          }
        }
      };
      
      return result;
    } catch (error) {
      console.error('Error getting user usage stats:', error);
      return null;
    }
  }

  /**
   * Check if user can add more contacts
   * @param {string} userId - User ID
   * @returns {Promise<Object>} { allowed: boolean, reason?: string, currentCount?: number, limit?: number }
   */
  static async canAddContact(userId) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        return { allowed: false, reason: 'User not found' };
      }

      const planId = user.selectedPlan || 'free';
      const contactLimit = this.getContactLimit(planId);

      // Count unique contacts across all user's events
      const userConferences = await Conference.find({ createdBy: userId }).distinct('_id');
      const contactsUsed = await Registration.distinct('email', {
        conferenceId: { $in: userConferences }
      }).then(emails => emails.length);

      if (contactsUsed >= contactLimit) {
        return {
          allowed: false,
          reason: `You have reached your contact limit of ${contactLimit} for your current plan. Please upgrade to add more contacts.`,
          currentCount: contactsUsed,
          limit: contactLimit
        };
      }

      return {
        allowed: true,
        currentCount: contactsUsed,
        limit: contactLimit
      };
    } catch (error) {
      console.error('Error checking contact limits:', error);
      return { allowed: false, reason: 'Error checking contact limits' };
    }
  }

  /**
   * Check if user can send emails
   * @param {string} userId - User ID
   * @param {number} emailCount - Number of emails to send
   * @returns {Promise<Object>} { allowed: boolean, reason?: string, currentCount?: number, limit?: number }
   */
  static async canSendEmails(userId, emailCount = 1) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        return { allowed: false, reason: 'User not found' };
      }

      const planId = user.selectedPlan || 'free';
      const emailLimit = this.getEmailLimit(planId);
      const emailsSent = user.usageStats?.emailsSent || 0;

      if (emailsSent + emailCount > emailLimit) {
        return {
          allowed: false,
          reason: `You have reached your email limit of ${emailLimit} for your current plan. Please upgrade to send more emails.`,
          currentCount: emailsSent,
          limit: emailLimit,
          requestedCount: emailCount
        };
      }

      return {
        allowed: true,
        currentCount: emailsSent,
        limit: emailLimit
      };
    } catch (error) {
      console.error('Error checking email limits:', error);
      return { allowed: false, reason: 'Error checking email limits' };
    }
  }

  /**
   * Update user's email count after sending emails
   * @param {string} userId - User ID
   * @param {number} emailCount - Number of emails sent
   * @returns {Promise<boolean>} Success status
   */
  static async updateEmailCount(userId, emailCount) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        return false;
      }

      // Initialize usageStats if it doesn't exist
      if (!user.usageStats) {
        user.usageStats = {
          emailsSent: 0,
          lastUpdated: new Date()
        };
      }

      // Update email count
      user.usageStats.emailsSent = (user.usageStats.emailsSent || 0) + emailCount;
      user.usageStats.lastUpdated = new Date();

      await user.save();
      return true;
    } catch (error) {
      console.error('Error updating email count:', error);
      return false;
    }
  }

  /**
   * Update event count for a user
   * @param {string} userId - User ID
   * @param {boolean} isInPerson - Whether it's an in-person event
   * @returns {Promise<boolean>} Success status
   */
  static async updateEventCount(userId, isInPerson = true) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        return false;
      }

      // Initialize usageStats if it doesn't exist
      if (!user.usageStats) {
        user.usageStats = {
          inPersonEvents: 0,
          webinars: 0,
          totalEvents: 0,
          lastUpdated: new Date()
        };
      }

      // Update event counts
      if (isInPerson) {
        user.usageStats.inPersonEvents = (user.usageStats.inPersonEvents || 0) + 1;
      } else {
        user.usageStats.webinars = (user.usageStats.webinars || 0) + 1;
      }
      user.usageStats.totalEvents = (user.usageStats.totalEvents || 0) + 1;
      user.usageStats.lastUpdated = new Date();

      await user.save();
      return true;
    } catch (error) {
      console.error('Error updating event count:', error);
      return false;
    }
  }

  /**
   * Update contact count for a user
   * @param {string} userId - User ID
   * @param {number} contactCount - Number of new contacts (usually 1)
   * @returns {Promise<boolean>} Success status
   */
  static async updateContactCount(userId, contactCount = 1) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        return false;
      }

      // Initialize usageStats if it doesn't exist
      if (!user.usageStats) {
        user.usageStats = {
          contacts: 0,
          lastUpdated: new Date()
        };
      }

      // Update contact count
      user.usageStats.contacts = (user.usageStats.contacts || 0) + contactCount;
      user.usageStats.lastUpdated = new Date();

      await user.save();
      return true;
    } catch (error) {
      console.error('Error updating contact count:', error);
      return false;
    }
  }

  /**
   * Decrease event count for a user (only for incomplete events)
   * @param {string} userId - User ID
   * @param {boolean} isInPerson - Whether it's an in-person event
   * @returns {Promise<boolean>} Success status
   */
  static async decreaseEventCount(userId, isInPerson = true) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        return false;
      }

      // Initialize usageStats if it doesn't exist
      if (!user.usageStats) {
        user.usageStats = {
          inPersonEvents: 0,
          webinars: 0,
          totalEvents: 0,
          lastUpdated: new Date()
        };
      }

      // Decrease event counts (ensure they don't go below 0)
      if (isInPerson) {
        user.usageStats.inPersonEvents = Math.max(0, (user.usageStats.inPersonEvents || 0) - 1);
      } else {
        user.usageStats.webinars = Math.max(0, (user.usageStats.webinars || 0) - 1);
      }
      user.usageStats.totalEvents = Math.max(0, (user.usageStats.totalEvents || 0) - 1);
      user.usageStats.lastUpdated = new Date();

      await user.save();
      return true;
    } catch (error) {
      console.error('Error decreasing event count:', error);
      return false;
    }
  }

  /**
   * Decrease contact count for a user
   * @param {string} userId - User ID
   * @param {number} contactCount - Number of contacts to decrease (usually 1)
   * @returns {Promise<boolean>} Success status
   */
  static async decreaseContactCount(userId, contactCount = 1) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        return false;
      }

      // Initialize usageStats if it doesn't exist
      if (!user.usageStats) {
        user.usageStats = {
          contacts: 0,
          lastUpdated: new Date()
        };
      }

      // Decrease contact count (ensure it doesn't go below 0)
      user.usageStats.contacts = Math.max(0, (user.usageStats.contacts || 0) - contactCount);
      user.usageStats.lastUpdated = new Date();

      await user.save();
      return true;
    } catch (error) {
      console.error('Error decreasing contact count:', error);
      return false;
    }
  }
}

module.exports = PlanLimitsService;
