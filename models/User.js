const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    email: { 
        type: String, 
        required: true, 
        unique: true, 
        lowercase: true,  
        match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Please enter a valid email address']  
    },
    password: { 
        type: String, 
        required: true 
    },
    fullName: {
        type: String,
        default: ''
    },
    organization: {
        type: String,
        default: ''
    },
    phone: {
        type: String,
        default: ''
    },
    image: {
        type: String,
        default: ''
    },
    // Roles: user (organizer), visitor (event attendee), admin, audienzoTeam, blogEditor (legacy)
    role: {
        type: String,
        enum: ['user', 'visitor', 'admin', 'blogEditor', 'audienzoTeam'],
        default: 'user'
    },
    // Visitor profile (interests, location, engagement)
    interests: {
        type: [String],
        default: []
    },
    location: {
        city: { type: String, default: '' },
        state: { type: String, default: '' },
        country: { type: String, default: '' }
    },
    savedEventIds: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Conference'
    }],
    followedOrganizers: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    visitorOnboardingCompleted: {
        type: Boolean,
        default: false
    },
    eventReminderEnabled: {
        type: Boolean,
        default: true
    },
    isAdmin: {
        type: Boolean,
        default: false
    },
    isBlogEditor: {
        type: Boolean,
        default: false
    },
    // For Audienzo Team: only Super Admin can activate/deactivate
    isActive: {
        type: Boolean,
        default: true
    },
    // Billing address for invoices
    billingAddress: {
        line1: {
            type: String,
            default: ''
        },
        line2: {
            type: String,
            default: ''
        },
        city: {
            type: String,
            default: ''
        },
        state: {
            type: String,
            default: ''
        },
        zipcode: {
            type: String,
            default: ''
        },
        country: {
            type: String,
            default: 'IN'
        }
    },
    // For password reset
    resetPasswordToken: {
        type: String,
        default: null
    },
    resetPasswordExpires: {
        type: Date,
        default: null
    },
    // Plan selection fields
    selectedPlan: {
        type: String,
        default: null,
        enum: ['free', 'entry', 'business', 'enterprise', 'custom', null]
    },
    planCurrency: {
        type: String,
        default: 'INR',
        enum: ['INR', 'USD']
    },
    planSelectedAt: {
        type: Date,
        default: null
    },
    // Payment fields
    paymentId: {
        type: String,
        default: null
    },
    paymentStatus: {
        type: String,
        default: null,
        enum: ['pending', 'completed', 'failed', 'refunded', null]
    },
    lastPaymentDate: {
        type: Date,
        default: null
    },
    // Invoice tracking
    invoiceId: {
        type: String,
        default: null
    },
    lastInvoiceId: {
        type: String,
        default: null
    },
    // Auto-renewal settings
    autoRenewal: {
        type: Boolean,
        default: true
    },
    // Subscription management
    subscriptionStatus: {
        type: String,
        default: 'active',
        enum: ['active', 'cancelled', 'expired', 'suspended']
    },
    subscriptionEndDate: {
        type: Date,
        default: null
    },
    cancelledAt: {
        type: Date,
        default: null
    },
    cancellationReason: {
        type: String,
        default: null
    },
    // Usage tracking fields
    usageStats: {
        inPersonEvents: {
            type: Number,
            default: 0
        },
        webinars: {
            type: Number,
            default: 0
        },
        totalEvents: {
            type: Number,
            default: 0
        },
        contacts: {
            type: Number,
            default: 0
        },
        emailsSent: {
            type: Number,
            default: 0
        },
        lastUpdated: {
            type: Date,
            default: Date.now
        }
    },
    // Notification settings
    notificationSettings: {
        emailBilling: {
            type: Boolean,
            default: true
        },
        emailUsage: {
            type: Boolean,
            default: true
        },
        emailRenewal: {
            type: Boolean,
            default: true
        },
        emailPayment: {
            type: Boolean,
            default: true
        }
    },
    // Plan reminder tracking
    reminderTracking: {
        lastUpgradeSentOn: {
            type: Date,
            default: null
        },
        lastUpgradeTargetDate: {
            type: Date,
            default: null
        },
        lastExpirySentOn: {
            type: Date,
            default: null
        },
        lastExpiryTargetDate: {
            type: Date,
            default: null
        }
    },
    // Usage alert tracking fields
    usageAlert_events: {
        type: Date,
        default: null
    },
    usageAlertCount_events: {
        type: Number,
        default: 0,
        min: 0,
        max: 2
    },
    usageAlert_contacts: {
        type: Date,
        default: null
    },
    usageAlertCount_contacts: {
        type: Number,
        default: 0,
        min: 0,
        max: 2
    },
    usageAlert_emails: {
        type: Date,
        default: null
    },
    usageAlertCount_emails: {
        type: Number,
        default: 0,
        min: 0,
        max: 2
    },
    // Last successful login (for admin dashboard recent logins)
    lastLoginAt: {
        type: Date,
        default: null
    },
    // Entry plan per-event tracking
    purchasedEventCount: {
        type: Number,
        default: 0
    },
    eventBundleType: {
        type: String,
        enum: ['single', '3-events', '5-events', null],
        default: null
    },
    // Upcoming plan for existing subscribers
    upcomingPlan: {
        planId: {
            type: String,
            enum: ['free', 'entry', 'business', 'enterprise', 'custom']
        },
        currency: {
            type: String,
            enum: ['INR', 'USD']
        },
        validityPeriod: {
            type: String
        },
        amount: {
            type: Number,
            default: 0
        },
        scheduledAt: {
            type: Date,
            default: Date.now
        },
        status: {
            type: String,
            enum: ['scheduled', 'applied', 'cancelled'],
            default: 'scheduled'
        },
        paymentId: {
            type: String,
            default: null
        }
    }
}, { timestamps: true }); 

module.exports = mongoose.model('User', userSchema);
