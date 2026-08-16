const mongoose = require('mongoose');

const emailVerificationProofSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    purpose: { type: String, required: true, enum: ['conference', 'signup'] },
    tokenHash: { type: String, required: true, unique: true },
    consumed: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

emailVerificationProofSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('EmailVerificationProof', emailVerificationProofSchema);
