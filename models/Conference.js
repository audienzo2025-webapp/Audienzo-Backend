const mongoose = require('mongoose');

const ConferenceSchema = new mongoose.Schema({
    // Basic Event Information
    eventType: {
        type: String,
        enum: [
            'conference', 'workshop', 'webinar', 'seminar', 'alumni-meet', 'others'
        ],
        required: true
    },
    customEventType: {
        type: String,
        default: ''
    },
    title: { type: String, required: true },
    /** @deprecated Legacy mirror of urlSlug for older clients; use urlSlug */
    slug: { type: String, sparse: true },
    /** Canonical public path segment for /event-details/:urlSlug (independent of title) */
    urlSlug: { type: String, unique: true, sparse: true },
    /** Prior urlSlug (or legacy slug) values that should still resolve to this event */
    slugRedirects: { type: [String], default: [] },
    startDate: { type: String, required: true },
    endDate: { type: String, required: true },
    time: { type: String, required: true },
    startTime: { type: String, default: '' },
    endTime: { type: String, default: '' },
    description: { type: String, required: true },
    organizer: { type: String, required: true },
    location: { type: String, required: true },
    /** Optional https Google Maps share or embed URL for public event page */
    googleMapsUrl: { type: String, default: '' },
    /** Optional detailed venue line shown above the map (separate from short location field) */
    mapsVenueName: { type: String, default: '' },
    deadline: { type: String, required: true },
    imageUrl: { type: String, default: '' },
    agendaUrl: { type: String, default: '' },
    qrCodeUrl: { type: String, default: '' },
    paymentLink: { type: String, default: '' },
    /** Optional URL used when a %-off coupon is applied (charges less than list price); falls back to paymentLink */
    discountedPaymentLink: { type: String, default: '' },
    isPublic: {
        type: String,
        enum: ['yes', 'no'],
        default: 'yes'
    },
    isVirtual: { type: Boolean, default: false },
    paymentType: {
        type: String,
        enum: ['free', 'paid'],
        default: 'free'
    },
    ticketPrice: { type: Number, default: 0 },
    feeCategories: [{
        name: { type: String, default: '' },
        amount: { type: Number, default: 0 },
        /** Optional Razorpay/Paytm/etc. link for this tier; falls back to event `paymentLink` when empty */
        paymentLink: { type: String, default: '' },
        /** Used when registrant applies a percentage coupon; falls back to category paymentLink */
        discountedPaymentLink: { type: String, default: '' }
    }],
    attendeeFields: [{
        name: { type: String, default: '' },
        label: { type: String, default: '' },
        type: { type: String, default: 'text' },
        required: { type: Boolean, default: false },
        options: [{ type: String }],
        appliesToCategoryIndex: { type: Number, default: -1 } // -1 = all categories
    }],
    paymentQRCode: { type: String, default: '' },
    paymentAmount: { type: Number, default: 0 },
    paymentInstructions: { type: String, default: '' },
    organizerName: { type: String, default: '' },
    organizerEmail: { type: String, default: '' },
    organizerContact: { type: String, default: '' },
    externalRegistrationUrl: { type: String, default: '' },
    /** When true, public registration form skips email OTP (per event). */
    skipEmailOtp: { type: Boolean, default: false },
    /** When true, hide Audienzo submit; attendees use category payment links only. */
    hideRegistrationSubmit: { type: Boolean, default: false },
    /** When true, paid registration form shows "Do you have invite code?" (default on for existing events). */
    showInviteCodeOption: { type: Boolean, default: true },
    /** When true, organizer must approve/reject registrants. When false, registrations complete automatically. */
    requireRegistrantApproval: { type: Boolean, default: true },
    /** When true, the same email may register more than once for this event. */
    allowDuplicateRegistration: { type: Boolean, default: false },
    /** When true (default on paid events), registrants must submit transaction ID/date (and proof when QR is set). */
    requirePaymentDetails: { type: Boolean, default: true },
    /** When true, approved registrants are listed on the public event details page. */
    publishRegistrantList: { type: Boolean, default: false },
    registrantListPublishedAt: { type: Date, default: null },
    // Organizer-defined predefined share post text (supports placeholders like {title} and {url})
    sharePostText: { type: String, default: '' },
    allowMultipleTickets: { type: Boolean, default: false },
    maxTicketsPerRegistration: { type: Number, default: 1 },
    tags: { type: [String], default: []},
    // Nested tiers { categoryName, sponsors: [{ name, imageUrl }] } or legacy flat [{ name, imageUrl }].
    // Stored as Mixed so older documents are not stripped by Mongoose strict casting.
    sponsors: { type: mongoose.Schema.Types.Mixed, default: [] },
    speakers: [{
      name: { type: String, default: '' },
      designation: { type: String, default: '' },
      linkedin: { type: String, default: '' },
      imageUrl: { type: String, default: '' }
    }],
    status: {
      type: String,
      enum: ['draft', 'published', 'archived'],
      default: 'draft'
    },
    draftCreatedAt: { type: Date, default: Date.now },
    publishedAt: { type: Date },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    collaborators: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    // Alumni Meet specific fields
    alumniBannerUrl: { type: String, default: '' },
    alumniDescription: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

// Update the updatedAt field before saving
ConferenceSchema.pre('save', function (next) {
    this.updatedAt = Date.now();
    next();
});

ConferenceSchema.index({ slugRedirects: 1 });

module.exports = mongoose.model('Conference', ConferenceSchema);
