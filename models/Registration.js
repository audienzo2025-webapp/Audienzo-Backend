// Updated models/Registration.js
const mongoose = require('mongoose');

const RegistrationSchema = new mongoose.Schema({
    conferenceId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Conference',
        required: true
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    email: {
        type: String,
        required: true
    },
    formData: {
        type: mongoose.Schema.Types.Mixed,
        required: true
    },
    numberOfTickets: {
        type: Number,
        default: 1
    },
    feeCategoryBreakdown: [{
        categoryIndex: Number,
        categoryName: String,
        unitAmount: Number,
        quantity: Number,
        subtotal: Number
    }],
    attendeeDetails: [{
        categoryIndex: Number,
        attendees: [mongoose.Schema.Types.Mixed]
    }],
    qrCodeUrl: String,
    attended: {
        type: Boolean,
        default: false
    },
    registeredAt: {
        type: Date,
        default: Date.now
    },
    attendedAt: {
        type: Date,
        default: null
    },
    // Signature functionality commented out for now
    // signature: {
    //     mode: { type: String, default: 'drawn' },
    //     dataUrl: String,
    //     signedAt: Date,
    //     signedByEmail: String,
    //     userAgent: String,
    //     ip: String
    // },
    paymentInfo: {
        transactionId: String,
        transactionDate: Date,
        transactionProofUrl: String,
        paymentStatus: {
            type: String,
            enum: ['pending', 'completed', 'failed', 'rejected'],
            default: 'pending'
        },
        amount: Number,
        originalAmount: Number,
        discountAmount: Number,
        couponCode: String,
        feeCategoryName: String,
        feeCategoryAmount: Number,
        feeCategoryBreakdown: [{
            categoryIndex: Number,
            categoryName: String,
            unitAmount: Number,
            quantity: Number,
            subtotal: Number
        }],
        paymentMethod: String,
        notes: String,
        /** Set only when organizer approves payment via event management */
        paymentApprovedAt: Date
    },
    /** Field names added to the form after this person registered — still need answers */
    pendingRequiredFieldNames: {
        type: [String],
        default: []
    },
    formFieldsUpdateNotifiedAt: {
        type: Date,
        default: null
    },
    /** Event became paid after this person registered — payment details still needed */
    needsPaymentCompletion: {
        type: Boolean,
        default: false
    },
    paymentUpdateNotifiedAt: {
        type: Date,
        default: null
    },
    /** Free events: coordinator approval before confirmation email / QR */
    registrationStatus: {
        type: String,
        enum: ['pending', 'completed', 'rejected'],
        default: 'completed'
    },
    registrationApprovedAt: {
        type: Date,
        default: null
    },
    /** Last self-service edit by registrant (My Registrations → Edit details) */
    lastEditedAt: {
        type: Date,
        default: null
    },
    lastEditedByEmail: {
        type: String,
        default: null
    },
    registrantEditHistory: [{
        editedAt: { type: Date, default: Date.now },
        editedByEmail: { type: String, default: '' }
    }]
});

RegistrationSchema.index({ userId: 1 });
RegistrationSchema.index({ email: 1 });

module.exports = mongoose.model('Registration', RegistrationSchema);
