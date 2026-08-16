require('dotenv').config();
const express = require('express');
const router = express.Router();

const Conference = require('../models/Conference');
const CouponCode = require('../models/CouponCode');
const User = require('../models/User');
const { getAuthUser } = require('../utils/authUser');

function trimmed(value) {
  return (value == null ? '' : String(value)).trim();
}

async function isAdminUser(req) {
  const authed = getAuthUser(req);
  if (!authed) return false;
  const user = await User.findById(authed._id).select('role isAdmin').lean();
  return user && (user.role === 'admin' || user.isAdmin === true);
}

async function canModifyConference(req, conferenceId) {
  const authed = getAuthUser(req);
  if (!authed) return false;
  if (await isAdminUser(req)) return true;
  const conference = await Conference.findById(conferenceId).select('createdBy collaborators').lean();
  if (!conference) return false;
  const userId = authed._id.toString();
  if (conference.createdBy && conference.createdBy.toString() === userId) return true;
  if (conference.collaborators && conference.collaborators.some(c => c && c.toString() === userId)) return true;
  return false;
}

function normalizeCode(code) {
  return trimmed(code).toUpperCase();
}

function isWithinWindow(now, from, until) {
  if (from && now < from) return false;
  if (until && now > until) return false;
  return true;
}

function countEmailUses(coupon, email) {
  if (!coupon || !Array.isArray(coupon.usageByEmail)) return 0;
  const target = trimmed(email).toLowerCase();
  return coupon.usageByEmail.reduce((sum, u) => sum + (trimmed(u?.email).toLowerCase() === target ? 1 : 0), 0);
}

function breakdownCategoryIndexes(breakdown) {
  if (!Array.isArray(breakdown)) return [];
  const out = [];
  for (const item of breakdown) {
    const idx = parseInt(item?.categoryIndex, 10);
    const qty = parseInt(item?.quantity, 10);
    if (!isNaN(idx) && qty > 0) out.push(idx);
  }
  return out;
}

function roundMoney2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function computeOriginalAmount(conference, breakdown) {
  const cats = Array.isArray(conference?.feeCategories) ? conference.feeCategories : [];
  if (cats.length > 0) {
    let total = 0;
    for (const item of Array.isArray(breakdown) ? breakdown : []) {
      const idx = parseInt(item?.categoryIndex, 10);
      const qty = parseInt(item?.quantity, 10);
      if (isNaN(idx) || idx < 0 || idx >= cats.length) continue;
      if (isNaN(qty) || qty < 1) continue;
      const unit = Number(cats[idx]?.amount) || 0;
      total += unit * qty;
    }
    return total;
  }
  // Single-price events
  const unit = Number(conference?.ticketPrice) || 0;
  const qty = 1;
  return unit * qty;
}

async function validateCouponForPreview({ conference, coupon, email, breakdown }) {
  if (!coupon || !coupon.isActive) {
    return { ok: false, message: 'Invalid coupon code.' };
  }
  const now = new Date();
  if (!isWithinWindow(now, coupon.validFrom, coupon.validUntil)) {
    return { ok: false, message: 'Coupon code is expired or not active yet.' };
  }

  if (coupon.maxUses && coupon.maxUses > 0 && coupon.usedCount >= coupon.maxUses) {
    return { ok: false, message: 'Coupon usage limit reached.' };
  }

  if (email) {
    const usedByEmail = countEmailUses(coupon, email);
    if (coupon.maxUsesPerEmail && coupon.maxUsesPerEmail > 0 && usedByEmail >= coupon.maxUsesPerEmail) {
      return { ok: false, message: 'This coupon has already been used for this email.' };
    }
  }

  const allowed = Array.isArray(coupon.allowedCategoryIndexes) ? coupon.allowedCategoryIndexes : [];
  const selectedIdxs = breakdownCategoryIndexes(breakdown);
  const discountPercentRaw = Math.min(
    100,
    Math.max(0, Number(coupon.discountPercent) || 0)
  );

  if (allowed.length > 0) {
    if (selectedIdxs.length === 0) {
      // Allow preview before picking categories for access-only or %-off coupons.
      if (!(coupon.accessOnly || discountPercentRaw > 0)) {
        return {
          ok: false,
          message: 'Please select at least one registration category before applying this coupon.'
        };
      }
    } else if (!selectedIdxs.every((i) => allowed.includes(i))) {
      return { ok: false, message: 'This coupon is not valid for the selected registration category.' };
    }
  }

  const originalAmount = computeOriginalAmount(conference, breakdown);
  const feeCats = Array.isArray(conference?.feeCategories) ? conference.feeCategories : [];

  if (coupon.accessOnly) {
    return {
      ok: true,
      accessOnly: true,
      originalAmount,
      // Access-only members should be able to complete registration without payment.
      // We intentionally do NOT show discount math in the UI for accessOnly, but backend
      // treats it like a full waiver to bypass payment steps.
      discountAmount: originalAmount,
      payableAmount: 0
    };
  }

  if (discountPercentRaw > 0) {
    // Multi-category events: preview %-off on catalog before any ticket quantity is chosen.
    if (feeCats.length > 0 && !(originalAmount > 0)) {
      return {
        ok: true,
        accessOnly: false,
        originalAmount: 0,
        discountAmount: 0,
        payableAmount: 0,
        discountPercent: discountPercentRaw,
        catalogPreview: true
      };
    }
    if (!(originalAmount > 0)) {
      return { ok: false, message: 'Coupon cannot be applied to a free registration.' };
    }
    const discountAmount = roundMoney2((originalAmount * discountPercentRaw) / 100);
    let payableAmount = roundMoney2(originalAmount - discountAmount);
    if (payableAmount < 0) payableAmount = 0;
    return {
      ok: true,
      accessOnly: false,
      originalAmount,
      discountAmount,
      payableAmount,
      discountPercent: discountPercentRaw
    };
  }

  // Full waive and other modes need a positive-priced selection (or single ticket price).
  if (!(originalAmount > 0)) {
    return { ok: false, message: 'Coupon cannot be applied to a free registration.' };
  }

  if (coupon.waiveFee) {
    return {
      ok: true,
      accessOnly: false,
      originalAmount,
      discountAmount: originalAmount,
      payableAmount: 0
    };
  }

  return { ok: false, message: 'This coupon is not configured to waive fees.' };
}

// Public: preview coupon effect for registration UI
router.post('/preview', async (req, res) => {
  try {
    const conferenceId = req.body?.conferenceId;
    const code = normalizeCode(req.body?.code);
    const breakdown = req.body?.feeCategoryBreakdown;
    const email = trimmed(req.body?.email).toLowerCase() || null;

    if (!conferenceId || !code) {
      return res.status(400).json({ success: false, message: 'Missing conferenceId or coupon code.' });
    }
    const conference = await Conference.findById(conferenceId).lean();
    if (!conference) {
      return res.status(404).json({ success: false, message: 'Conference not found.' });
    }

    const coupon = await CouponCode.findOne({ conferenceId, code }).lean();
    if (!coupon) {
      return res.json({ success: false, message: 'Invalid coupon code.' });
    }

    const result = await validateCouponForPreview({ conference, coupon, email, breakdown });
    if (!result.ok) {
      return res.json({ success: false, message: result.message });
    }

    return res.json({
      success: true,
      coupon: {
        id: coupon._id,
        code: coupon.code,
        waiveFee: coupon.waiveFee,
        accessOnly: coupon.accessOnly,
        discountPercent: Number(coupon.discountPercent) || 0,
        allowedCategoryIndexes: Array.isArray(coupon.allowedCategoryIndexes)
          ? coupon.allowedCategoryIndexes
          : []
      },
      pricing: {
        originalAmount: result.originalAmount,
        discountAmount: result.discountAmount,
        payableAmount: result.payableAmount,
        ...(typeof result.discountPercent === 'number'
          ? { discountPercent: result.discountPercent }
          : {}),
        ...(result.catalogPreview ? { catalogPreview: true } : {})
      }
    });
  } catch (err) {
    console.error('Coupon preview error:', err);
    return res.status(500).json({ success: false, message: 'Server error. Please try again later.' });
  }
});

// Organizer/admin: list coupons for an event
router.get('/conference/:conferenceId', async (req, res) => {
  try {
    const conferenceId = req.params.conferenceId;
    if (!(await canModifyConference(req, conferenceId))) {
      return res.status(403).json({ success: false, message: 'Not allowed.' });
    }
    const coupons = await CouponCode.find({ conferenceId }).sort({ createdAt: -1 }).lean();
    return res.json({ success: true, coupons });
  } catch (err) {
    console.error('List coupons error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// Organizer/admin: create coupon for an event
router.post('/conference/:conferenceId', async (req, res) => {
  try {
    const conferenceId = req.params.conferenceId;
    if (!(await canModifyConference(req, conferenceId))) {
      return res.status(403).json({ success: false, message: 'Not allowed.' });
    }

    const code = normalizeCode(req.body?.code);
    const accessOnly = req.body?.accessOnly === true;
    let discountPercent =
      req.body?.discountPercent != null ? parseFloat(String(req.body.discountPercent)) : 0;
    if (isNaN(discountPercent) || discountPercent < 0) discountPercent = 0;
    if (discountPercent > 100) {
      return res.status(400).json({ success: false, message: 'discountPercent must be between 0 and 100.' });
    }
    if (accessOnly && discountPercent > 0) {
      return res.status(400).json({
        success: false,
        message: 'Access-only coupons cannot use a percentage discount.'
      });
    }
    const waiveFee =
      discountPercent > 0 ? false : accessOnly ? false : req.body?.waiveFee !== false; // default true unless accessOnly
    const allowedCategoryIndexesRaw = req.body?.allowedCategoryIndexes;
    const allowedCategoryIndexes = Array.isArray(allowedCategoryIndexesRaw)
      ? allowedCategoryIndexesRaw.map((n) => parseInt(n, 10)).filter((n) => !isNaN(n) && n >= 0)
      : [];

    const maxUses = req.body?.maxUses != null ? parseInt(req.body.maxUses, 10) : 0;
    const maxUsesPerEmail = req.body?.maxUsesPerEmail != null ? parseInt(req.body.maxUsesPerEmail, 10) : 1;
    const validFrom = req.body?.validFrom ? new Date(req.body.validFrom) : null;
    const validUntil = req.body?.validUntil ? new Date(req.body.validUntil) : null;

    if (!code || code.length < 3) {
      return res.status(400).json({ success: false, message: 'Coupon code must be at least 3 characters.' });
    }
    if (maxUses && maxUses < 0) {
      return res.status(400).json({ success: false, message: 'maxUses must be 0 or greater.' });
    }
    if (maxUsesPerEmail && maxUsesPerEmail < 0) {
      return res.status(400).json({ success: false, message: 'maxUsesPerEmail must be 0 or greater.' });
    }
    if (validFrom && isNaN(validFrom.getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid validFrom date.' });
    }
    if (validUntil && isNaN(validUntil.getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid validUntil date.' });
    }
    if (validFrom && validUntil && validFrom > validUntil) {
      return res.status(400).json({ success: false, message: 'validFrom must be before validUntil.' });
    }

    const coupon = await CouponCode.create({
      conferenceId,
      code,
      allowedCategoryIndexes,
      waiveFee,
      accessOnly,
      discountPercent: discountPercent > 0 ? discountPercent : 0,
      maxUses: maxUses || 0,
      maxUsesPerEmail: maxUsesPerEmail == null ? 1 : maxUsesPerEmail,
      validFrom,
      validUntil,
      isActive: true,
      createdBy: getAuthUser(req)._id
    });

    return res.json({ success: true, coupon });
  } catch (err) {
    if (err && String(err.message || '').includes('E11000')) {
      return res.status(409).json({ success: false, message: 'Coupon code already exists for this event.' });
    }
    console.error('Create coupon error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// Organizer/admin: delete coupon
router.delete('/conference/:conferenceId/:couponId', async (req, res) => {
  try {
    const { conferenceId, couponId } = req.params;
    if (!(await canModifyConference(req, conferenceId))) {
      return res.status(403).json({ success: false, message: 'Not allowed.' });
    }
    const deleted = await CouponCode.findOneAndDelete({ _id: couponId, conferenceId }).lean();
    if (!deleted) {
      return res.status(404).json({ success: false, message: 'Coupon not found.' });
    }
    return res.json({ success: true, message: 'Coupon deleted.' });
  } catch (err) {
    console.error('Delete coupon error:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

module.exports = {
  router,
  // Export helpers so registration flow can reuse exact validation rules
  normalizeCode,
  validateCouponForPreview
};

