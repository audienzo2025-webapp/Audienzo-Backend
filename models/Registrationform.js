const mongoose = require('mongoose');

const registrationFormSchema = new mongoose.Schema({
    conferenceId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Conference',
        unique: true,
        required: true
    },
    fields: {
        type: [Object],
        default: []
    },
    /** Shown at top of public registration form (Registration Details) */
    displayEventName: {
        type: String,
        default: ''
    },
    /** Poster/banner image URL for registration form header */
    posterUrl: {
        type: String,
        default: ''
    },
    schemaVersion: {
        type: Number,
        default: 1
    }
}, { timestamps: true });

module.exports = mongoose.model('RegistrationForm', registrationFormSchema);
