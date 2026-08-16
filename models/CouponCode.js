const mongoose = require('mongoose');

const CouponCodeSchema = new mongoose.Schema(
  {
    conferenceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conference',
      required: true,
      index: true
    },
    /**
     * Stored as uppercase for case-insensitive matching.
     * Only accessible to event organizers/admins via authenticated endpoints.
     */
    code: {
      type: String,
      required: true,
      trim: true
    },
    /**
     * Restrict coupon usage to specific feeCategories indexes.
     * Empty array means "all categories" (including single-price events).
     */
    allowedCategoryIndexes: {
      type: [Number],
      default: []
    },
    /**
     * When true, payable amount becomes 0 for eligible registrations.
     * (Matches your organizer/delegation "free registration" requirement.)
     * Ignored when discountPercent > 0.
     */
    waiveFee: {
      type: Boolean,
      default: true
    },
    /**
     * Optional percentage off list price (e.g. 10 = 10% discount).
     * When set > 0, overrides waiveFee and reduces payable amount accordingly.
     */
    discountPercent: {
      type: Number,
      default: 0,
      min: 0,
      max: 100
    },
    /**
     * Access-code-only mode: does NOT change pricing, but gates registrations
     * for selected categories. Useful for ₹0 "Organizer" categories that should
     * require a secret code.
     */
    accessOnly: {
      type: Boolean,
      default: false
    },
    /**
     * Optional safety controls.
     */
    maxUses: { type: Number, default: 0 }, // 0 = unlimited
    maxUsesPerEmail: { type: Number, default: 1 }, // 0 = unlimited
    validFrom: { type: Date, default: null },
    validUntil: { type: Date, default: null },
    isActive: { type: Boolean, default: true },

    usedCount: { type: Number, default: 0 },
    usageByEmail: [
      {
        email: { type: String, required: true },
        usedAt: { type: Date, default: Date.now }
      }
    ],

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
  },
  { timestamps: true }
);

CouponCodeSchema.index({ conferenceId: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('CouponCode', CouponCodeSchema);

