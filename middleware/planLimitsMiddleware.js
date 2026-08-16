const PlanLimitsService = require('../services/planLimitsService');
const Conference = require('../models/Conference');
const { getAuthUser } = require('../utils/authUser');

/**
 * Middleware to validate event creation limits based on user's plan
 */
const validateEventCreationLimits = async (req, res, next) => {
  try {
    if (!getAuthUser(req)) {
      return res.status(401).json({ 
        success: false, 
        message: 'Unauthorized' 
      });
    }

    const userId = getAuthUser(req)._id;
    const isVirtual = req.body.isVirtual === 'true' || req.body.isVirtual === true;
    const eventType = req.body.eventType;

    // Check if user can create this type of event
    const canCreate = await PlanLimitsService.canCreateEvent(userId, eventType, isVirtual);
    
    if (!canCreate.allowed) {
      return res.status(403).json({
        success: false,
        message: canCreate.reason,
        errorCode: 'PLAN_LIMIT_EXCEEDED',
        currentCount: canCreate.currentCount,
        limit: canCreate.limit,
        upgradeRequired: true
      });
    }

    // Check paid event limits if applicable
    const paymentType = req.body.eventPayment || req.body.paymentType;
    if (paymentType === 'paid') {
      const canCreatePaid = await PlanLimitsService.canCreatePaidEvent(userId);
      if (!canCreatePaid.allowed) {
        return res.status(403).json({
          success: false,
          message: canCreatePaid.reason,
          errorCode: 'PAID_EVENTS_NOT_ALLOWED',
          upgradeRequired: true
        });
      }
    }

    // Check private event limits if applicable
    const isPublic = req.body.eventPrivacy;
    if (isPublic === 'private') {
      const canCreatePrivate = await PlanLimitsService.canCreatePrivateEvent(userId);
      if (!canCreatePrivate.allowed) {
        return res.status(403).json({
          success: false,
          message: canCreatePrivate.reason,
          errorCode: 'PRIVATE_EVENTS_NOT_ALLOWED',
          upgradeRequired: true
        });
      }
    }

    // Check QR code check-in limits if applicable
    if (req.files && req.files['qrCode']) {
      const canUseQr = await PlanLimitsService.canUseQrCodeCheckins(userId);
      if (!canUseQr.allowed) {
        return res.status(403).json({
          success: false,
          message: canUseQr.reason,
          errorCode: 'QR_CODE_CHECKINS_NOT_ALLOWED',
          upgradeRequired: true
        });
      }
    }

    // Add usage info to request for potential frontend display
    req.planLimits = {
      currentCount: canCreate.currentCount,
      limit: canCreate.limit,
      canCreatePaid: paymentType !== 'paid' || (await PlanLimitsService.canCreatePaidEvent(userId)).allowed,
      canCreatePrivate: isPublic !== 'private' || (await PlanLimitsService.canCreatePrivateEvent(userId)).allowed,
      canUseQr: !req.files || !req.files['qrCode'] || (await PlanLimitsService.canUseQrCodeCheckins(userId)).allowed
    };

    next();
  } catch (error) {
    console.error('Error validating plan limits:', error);
    res.status(500).json({
      success: false,
      message: 'Error validating plan limits',
      errorCode: 'VALIDATION_ERROR'
    });
  }
};

/**
 * Middleware to get user's current usage statistics
 */
const getUserUsageStats = async (req, res, next) => {
  try {
    if (!getAuthUser(req)) {
      return res.status(401).json({ 
        success: false, 
        message: 'Unauthorized' 
      });
    }

    const userId = getAuthUser(req)._id;
    
    const usageStats = await PlanLimitsService.getUserUsageStats(userId);
    
    if (!usageStats) {
      return res.status(404).json({
        success: false,
        message: 'Unable to retrieve usage statistics'
      });
    }

    req.usageStats = usageStats;
    next();
  } catch (error) {
    console.error('Error getting user usage stats:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving usage statistics'
    });
  }
};

/**
 * Middleware to validate contact limits before registration
 * This checks the conference creator's contact limits, not the registrant's
 */
const validateContactLimits = async (req, res, next) => {
  try {
    // Get conference ID from route params
    const conferenceId = req.params.id;
    if (!conferenceId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Conference ID is required' 
      });
    }

    // Fetch the conference to get the creator's ID
    const conference = await Conference.findById(conferenceId);
    
    if (!conference) {
      return res.status(404).json({ 
        success: false, 
        message: 'Conference not found' 
      });
    }

    // Check the conference creator's contact limits
    const creatorId = conference.createdBy;
    if (!creatorId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Conference creator information is missing' 
      });
    }
    
    // Check if conference creator can add more contacts
    const canAddContact = await PlanLimitsService.canAddContact(creatorId);
    
    if (!canAddContact.allowed) {
      return res.status(403).json({
        success: false,
        message: canAddContact.reason || 'Registration limit exceeded. The event organizer has reached their contact limit.',
        errorCode: 'CONTACT_LIMIT_EXCEEDED',
        currentCount: canAddContact.currentCount,
        limit: canAddContact.limit,
        upgradeRequired: true
      });
    }

    // Store conference in request to avoid refetching in route handler
    req.conference = conference;

    next();
  } catch (error) {
    console.error('Error validating contact limits:', error);
    res.status(500).json({
      success: false,
      message: 'Error validating contact limits'
    });
  }
};

/**
 * Middleware to validate email limits before sending emails
 */
const validateEmailLimits = async (req, res, next) => {
  try {
    if (!getAuthUser(req)) {
      return res.status(401).json({ 
        success: false, 
        message: 'Unauthorized' 
      });
    }

    const userId = getAuthUser(req)._id;
    
    // Calculate number of emails to be sent
    let emailCount = 1; // Default for individual emails
    
    // For bulk emails, count recipients
    if (req.body.recipientGroups || req.files?.csvUpload) {
      // This will be calculated in the route handler
      // For now, we'll validate with a reasonable estimate
      emailCount = 100; // Conservative estimate for bulk emails
    }
    
    // Check if user can send emails
    const canSendEmails = await PlanLimitsService.canSendEmails(userId, emailCount);
    
    if (!canSendEmails.allowed) {
      return res.status(403).json({
        success: false,
        message: canSendEmails.reason,
        errorCode: 'EMAIL_LIMIT_EXCEEDED',
        currentCount: canSendEmails.currentCount,
        limit: canSendEmails.limit,
        requestedCount: canSendEmails.requestedCount,
        upgradeRequired: true
      });
    }

    // Store email count for later use in route handler
    req.emailCount = emailCount;
    next();
  } catch (error) {
    console.error('Error validating email limits:', error);
    res.status(500).json({
      success: false,
      message: 'Error validating email limits'
    });
  }
};

module.exports = {
  validateEventCreationLimits,
  validateContactLimits,
  validateEmailLimits,
  getUserUsageStats
};
