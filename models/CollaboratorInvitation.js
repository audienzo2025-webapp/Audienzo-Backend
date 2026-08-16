const mongoose = require('mongoose');

const collaboratorInvitationSchema = new mongoose.Schema({
    eventOwner: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    collaboratorEmail: {
        type: String,
        required: true,
        lowercase: true
    },
    events: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Conference',
        required: true
    }],
    token: {
        type: String,
        required: true,
        unique: true
    },
    status: {
        type: String,
        enum: ['pending', 'accepted', 'rejected', 'expired'],
        default: 'pending'
    },
    acceptedAt: {
        type: Date,
        default: null
    },
    expiresAt: {
        type: Date,
        default: function() {
            // Token expires in 7 days
            return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        }
    }
}, { timestamps: true });

// Index for faster lookups
// Note: token index is automatically created by unique: true, so we don't need to define it explicitly
collaboratorInvitationSchema.index({ collaboratorEmail: 1, status: 1 });
collaboratorInvitationSchema.index({ eventOwner: 1 });

module.exports = mongoose.model('CollaboratorInvitation', collaboratorInvitationSchema);

