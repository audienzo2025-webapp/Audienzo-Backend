require('dotenv').config();
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Registration = require("../models/Registration");
const Attendee = require("../models/Attendee");
const RegistrationForm = require("../models/Registrationform");
const Conference = require('../models/Conference');
const User = require('../models/User');
const { getAuthUser } = require('../utils/authUser');
const {
  isAdminUser,
  canOrganizerOrAdminManageRegistrants,
  canViewOrDownloadConferenceRegistrants,
  isRegistrationPaymentCompleted,
  isEligibleForAttendanceQrEmail,
  isInPersonConference,
  canModifyConference,
  isConferencePubliclyViewable,
} = require('../utils/conferenceOrganizerAccess');
const {
  isAlumniMeetEventType,
  stripAlumniGraduationBranchFields,
  stripAlumniGraduationBranchFromRegistrationForm,
} = require('../utils/alumniMeetRegistrationFields');
const {
  diffRegistrationFormFieldChanges,
  syncPendingFieldsAfterFormUpdate,
} = require('../utils/registrationFormDiff');
const { sendRegistrationFieldsUpdateEmail } = require('../services/sendRegistrationFieldsUpdateEmail');
const {
  syncPendingPaymentAfterEventPaid,
  syncRegistrationsAfterApprovalDisabled,
  reconcileRegistrationPayment,
  conferenceRequiresRegistrantApproval,
  isPaymentWaived,
} = require('../utils/registrationPaymentReconcile');
const {
  getFormFieldsForPublicList,
  buildPublicRegistrantListResponse,
} = require('../utils/publicRegistrantList');
const { sendRegistrationPaymentRequiredEmail } = require('../services/sendRegistrationPaymentRequiredEmail');
const { Parser } = require('json2csv');
const { cloudinary, uploadImage, uploadLocal } = require('../config/cloudinary');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { exec } = require('child_process');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { validateEventCreationLimits, getUserUsageStats } = require('../middleware/planLimitsMiddleware');
const PlanLimitsService = require('../services/planLimitsService');
const UsageAlertService = require('../services/usageAlertService');
const {
  generateSlugFromTitle,
  normalizeUrlSlugInput,
  allocateUniquePublicSlug,
  findConferenceByPublicSlug,
  applySlugAliasesToLeanDoc
} = require('../utils/conferenceSlug');
const QRCode = require('qrcode');
const { sendRegistrationConfirmationEmail } = require('../services/sendRegistrationConfirmationEmail');
const { sendAttendanceQrEmail } = require('../services/sendAttendanceQrEmail');
const {
  buildCompactAttendanceQrPayload,
  generateCompactAttendanceQrDataUrl,
} = require('../utils/attendanceQr');

/**
 * Ensure a registration has a persisted unique check-in QR URL (generates and uploads if missing).
 * Uses a compact payload so phone/laptop cameras can decode reliably.
 * @returns {Promise<string>} Cloudinary URL
 */
async function ensureRegistrationCheckInQrUrl(conference, registration, { forceRegenerate = false } = {}) {
  let qrCodeUrl = (registration.qrCodeUrl || '').trim();
  if (qrCodeUrl && !forceRegenerate) {
    return qrCodeUrl;
  }

  const qrCodeDataUrl = await generateCompactAttendanceQrDataUrl(registration);
  const uploadResult = await cloudinary.uploader.upload(qrCodeDataUrl, {
    folder: 'conference_qr_codes',
    public_id: `QR_${registration.conferenceId}_${registration._id}_${Date.now()}`
  });
  qrCodeUrl = uploadResult.secure_url;
  await Registration.updateOne({ _id: registration._id }, { $set: { qrCodeUrl } });
  registration.qrCodeUrl = qrCodeUrl;
  return qrCodeUrl;
}

function buildQrDownloadFilename(registration, conference) {
  const emailPart = (registration.email || 'registrant')
    .toString()
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 80) || 'registrant';
  const eventPart = (conference.title || conference._id || 'event')
    .toString()
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 40) || 'event';
  return `check-in-qr_${eventPart}_${emailPart}.png`;
}

async function sendRegistrantConfirmationWithQr(conference, registration) {
  const email = (registration.email || '').trim();
  if (!email) {
    throw new Error('Registration has no email address.');
  }

  if (!isEligibleForAttendanceQrEmail(conference, registration)) {
    throw new Error('Registration is not completed.');
  }

  const qrCodeUrl = await ensureRegistrationCheckInQrUrl(conference, registration, { forceRegenerate: true });
  if (!qrCodeUrl) {
    throw new Error('Could not produce a check-in QR for this registration.');
  }

  await sendAttendanceQrEmail(conference, registration, qrCodeUrl);
  return { registrationId: registration._id, email, qrCodeUrl };
}

const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
}

/** Speaker image slots; must match frontend */
const MAX_SPEAKER_IMAGE_SLOTS = 30;
/** Nested sponsor uploads: sponsorImage_{categoryIndex}_{sponsorIndex} */
const MAX_SPONSOR_CATEGORIES = 12;
const MAX_SPONSORS_PER_CATEGORY = 20;

const sponsorNestedImageFields = [];
for (let c = 0; c < MAX_SPONSOR_CATEGORIES; c++) {
  for (let s = 0; s < MAX_SPONSORS_PER_CATEGORY; s++) {
    sponsorNestedImageFields.push({ name: `sponsorImage_${c}_${s}`, maxCount: 1 });
  }
}

const eventFormUploadFields = [
  { name: 'image', maxCount: 1 },
  { name: 'agenda', maxCount: 1 },
  { name: 'qrCode', maxCount: 1 },
  { name: 'alumniBanner', maxCount: 1 },
  ...sponsorNestedImageFields,
  ...Array.from({ length: MAX_SPEAKER_IMAGE_SLOTS }, (_, i) => ({ name: `speakerImage_${i}`, maxCount: 1 }))
];

const ALLOWED_PERSON_IMAGE_MIMES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']);

function feeCategoryPaymentLinkTrimmed(c) {
  return c && String(c.paymentLink || '').trim();
}

function feeCategoryDiscountedPaymentLinkTrimmed(c) {
  return c && String(c.discountedPaymentLink || '').trim();
}

function anyFeeCategoryHasPaymentLink(arr) {
  return Array.isArray(arr) && arr.some(feeCategoryPaymentLinkTrimmed);
}

/**
 * Keep only safe https URLs for persisting imageUrl from multipart text fields
 */
const sanitizeExistingImageUrl = (u) => {
  const s = (u == null ? '' : String(u)).trim();
  if (!s || !/^https:\/\//i.test(s)) return '';
  return s.slice(0, 2048);
};

/** Allow only https links to Google Maps (share, embed, or short URLs) */
const sanitizeGoogleMapsUrl = (u) => {
  const raw = (u == null ? '' : String(u)).trim();
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'https:') return '';
  const h = parsed.hostname.toLowerCase();
  const allowed =
    h === 'www.google.com' ||
    h === 'google.com' ||
    h === 'maps.google.com' ||
    h === 'goo.gl' ||
    h === 'maps.app.goo.gl' ||
    h.endsWith('.google.com');
  if (!allowed) return '';
  return raw.slice(0, 2048);
};

/** Allow only http/https URLs for external registration */
const sanitizeExternalRegistrationUrl = (u) => {
  const raw = (u == null ? '' : String(u)).trim();
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  return raw.slice(0, 2048);
};

/**
 * Upload a local temp file to Cloudinary (sponsor/speaker avatar); validates MIME and size
 */
const uploadPersonImageFile = async (file, folder) => {
  if (!file || !file.path) return '';
  const mimetype = (file.mimetype || '').toLowerCase();
  if (!ALLOWED_PERSON_IMAGE_MIMES.has(mimetype)) {
    try { fs.unlinkSync(file.path); } catch (_) {}
    throw new Error('Sponsor/speaker images must be JPEG, PNG, WEBP, or GIF.');
  }
  let stat;
  try {
    stat = fs.statSync(file.path);
  } catch (e) {
    throw new Error('Could not read uploaded image file.');
  }
  const maxBytes = 3 * 1024 * 1024;
  if (stat.size > maxBytes) {
    try { fs.unlinkSync(file.path); } catch (_) {}
    throw new Error('Sponsor/speaker image must be 3MB or smaller.');
  }
  const upload = await cloudinary.uploader.upload(file.path, {
    folder,
    resource_type: 'image'
  });
  try { fs.unlinkSync(file.path); } catch (_) {}
  return upload.secure_url;
};

// ============================================================================
// SHARED UTILITY FUNCTIONS FOR EVENT PROCESSING
// ============================================================================

/**
 * Normalize form field values (handle arrays from FormData)
 * @param {any} val - The value to normalize
 * @returns {string} - Normalized string value
 */
const getString = (val) => {
  if (val == null) return '';
  if (Array.isArray(val)) return val.length ? String(val[0]) : '';
  if (typeof val === 'object') return '';
  return String(val);
};

/**
 * Multer uses append-field: bracket names like speakers[0][name] become nested objects
 * { "0": { name: "..." } } rather than flat keys or real Arrays. Coerce to sorted array of rows.
 */
const coerceFormArray = (val) => {
  if (val == null) return [];
  if (Array.isArray(val)) return val;
  if (typeof val !== 'object') return [];
  const keys = Object.keys(val).filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b));
  if (keys.length === 0) return [];
  return keys.map((k) => val[k]);
};

/**
 * Parse speakers from FormData (handles both array and indexed formats)
 * @param {Object} req - Express request object
 * @returns {Array} - Array of speaker objects
 */
const parseSpeakers = (req) => {
  let speakers = [];
  const rows = coerceFormArray(req.body.speakers);
  if (rows.length > 0) {
    speakers = rows.map((s) => {
      if (!s || typeof s !== 'object') {
        return { name: '', designation: '', linkedin: '', imageUrl: '' };
      }
      return {
        name: (getString(s.name) || '').trim(),
        designation: (getString(s.designation) || '').trim(),
        linkedin: (getString(s.linkedin) || '').trim(),
        imageUrl: sanitizeExistingImageUrl(getString(s.imageUrl))
      };
    });
  } else {
    let i = 0;
    while (true) {
      const kName = `speakers[${i}][name]`;
      const kDesig = `speakers[${i}][designation]`;
      const kLi = `speakers[${i}][linkedin]`;
      const kImg = `speakers[${i}][imageUrl]`;
      const hasBodyField =
        req.body[kName] !== undefined ||
        req.body[kDesig] !== undefined ||
        req.body[kLi] !== undefined ||
        req.body[kImg] !== undefined;
      const hasFile = req.files && req.files[`speakerImage_${i}`];
      if (!hasBodyField && !hasFile) {
        break;
      }
      const name = getString(req.body[kName]);
      const designation = getString(req.body[kDesig]) || '';
      const linkedin = getString(req.body[kLi]) || '';
      const imageUrl = sanitizeExistingImageUrl(getString(req.body[kImg]));
      speakers.push({
        name: (name || '').trim(),
        designation: designation.trim(),
        linkedin: linkedin.trim(),
        imageUrl
      });
      i++;
    }
  }

  return speakers.map(s => ({
    name: s.name,
    designation: s.designation,
    linkedin: s.linkedin,
    imageUrl: s.imageUrl || ''
  }));
};

/**
 * Legacy flat sponsors (pre–nested categories)
 */
const parseFlatSponsorsLegacy = (req) => {
  const rows = coerceFormArray(req.body.sponsors);
  if (rows.length > 0) {
    return rows.map((s) => {
      if (!s || typeof s !== 'object') return { name: '', imageUrl: '' };
      return {
        name: (getString(s.name) || '').trim(),
        imageUrl: sanitizeExistingImageUrl(getString(s.imageUrl))
      };
    });
  }
  const sponsors = [];
  let i = 0;
  while (
    req.body[`sponsors[${i}][name]`] !== undefined ||
    req.body[`sponsors[${i}][imageUrl]`] !== undefined
  ) {
    const name = (getString(req.body[`sponsors[${i}][name]`]) || '').trim();
    const imageUrl = sanitizeExistingImageUrl(getString(req.body[`sponsors[${i}][imageUrl]`]));
    sponsors.push({ name, imageUrl });
    i++;
  }
  return sponsors;
};

/**
 * Parse sponsor categories from FormData: sponsorCategories[c][categoryName], sponsorCategories[c][sponsors][s][name|imageUrl]
 * Falls back to legacy flat list as a single "Sponsors" category.
 */
const parseSponsorCategories = (req) => {
  /** Multer/append-field nests sponsorCategories[0][categoryName] under req.body.sponsorCategories */
  const categoryRows = coerceFormArray(req.body.sponsorCategories);
  if (categoryRows.length > 0) {
    return categoryRows.map((cat) => {
      if (!cat || typeof cat !== 'object') {
        return { categoryName: '', sponsors: [] };
      }
      const categoryName = (getString(cat.categoryName) || '').trim();
      const sponsorRows = coerceFormArray(cat.sponsors);
      const sponsors = sponsorRows.map((s) => {
        if (!s || typeof s !== 'object') return { name: '', imageUrl: '' };
        return {
          name: (getString(s.name) || '').trim(),
          imageUrl: sanitizeExistingImageUrl(getString(s.imageUrl))
        };
      });
      return { categoryName, sponsors };
    });
  }
  /** Legacy: flat keys (no append-field) */
  const nested = [];
  let c = 0;
  while (
    req.body[`sponsorCategories[${c}][categoryName]`] !== undefined ||
    req.body[`sponsorCategories[${c}][sponsors][0][name]`] !== undefined ||
    req.body[`sponsorCategories[${c}][sponsors][0][imageUrl]`] !== undefined
  ) {
    const categoryName = (getString(req.body[`sponsorCategories[${c}][categoryName]`]) || '').trim();
    const inner = [];
    let s = 0;
    while (
      req.body[`sponsorCategories[${c}][sponsors][${s}][name]`] !== undefined ||
      req.body[`sponsorCategories[${c}][sponsors][${s}][imageUrl]`] !== undefined
    ) {
      const name = (getString(req.body[`sponsorCategories[${c}][sponsors][${s}][name]`]) || '').trim();
      const imageUrl = sanitizeExistingImageUrl(
        getString(req.body[`sponsorCategories[${c}][sponsors][${s}][imageUrl]`])
      );
      inner.push({ name, imageUrl });
      s++;
    }
    nested.push({ categoryName, sponsors: inner });
    c++;
  }
  if (nested.length > 0) {
    return nested;
  }
  const flat = parseFlatSponsorsLegacy(req);
  if (flat.length === 0) return [];
  return [{ categoryName: 'Sponsors', sponsors: flat }];
};

/**
 * Handle image upload to Cloudinary
 * @param {Object} req - Express request object
 * @returns {Promise<string>} - Cloudinary URL or empty string
 */
const handleImageUpload = async (req) => {
  if (req.files['image']) {
    const imagePath = req.files['image'][0].path;
    const imageUpload = await cloudinary.uploader.upload(imagePath, {
      folder: 'conference_uploads',
      resource_type: 'image'
    });
    fs.unlinkSync(imagePath);
    return imageUpload.secure_url;
  }
  return '';
};

/**
 * Handle agenda upload to Cloudinary
 * @param {Object} req - Express request object
 * @returns {Promise<string>} - Cloudinary URL or empty string
 */
const handleAgendaUpload = async (req) => {
  if (req.files['agenda']) {
    const agendaPath = req.files['agenda'][0].path;
    const originalName = req.files['agenda'][0].originalname;

    const sanitizeFilename = (name) => 
        name.replace(/\.[^/.]+$/, '')           // remove extension
            .replace(/\s+/g, '_')               // spaces → _
            .replace(/[^a-zA-Z0-9_-]/g, ''); 

    const baseName = sanitizeFilename(originalName);
    const publicId = `${baseName}-${Date.now()}`;
    const agendaUpload = await cloudinary.uploader.upload(agendaPath, {
      folder: 'conference_agendas',
      resource_type: 'raw',
      public_id: publicId
    });
    fs.unlinkSync(agendaPath);
    return agendaUpload.secure_url;
  }
  return '';
};

/**
 * Handle QR code upload to Cloudinary
 * @param {Object} req - Express request object
 * @returns {Promise<string>} - Cloudinary URL or empty string
 */
const handleQrCodeUpload = async (req) => {
  if (req.files['qrCode']) {
    const qrCodePath = req.files['qrCode'][0].path;
    const qrCodeUpload = await cloudinary.uploader.upload(qrCodePath, {
      folder: 'conference_qrcodes',
      resource_type: 'image'
    });
    fs.unlinkSync(qrCodePath);
    return qrCodeUpload.secure_url;
  }
  return '';
};

/**
 * Handle Alumni banner upload to Cloudinary
 * @param {Object} req - Express request object
 * @returns {Promise<string>} - Cloudinary URL or empty string
 */
const handleAlumniBannerUpload = async (req) => {
  if (req.files['alumniBanner']) {
    const bannerPath = req.files['alumniBanner'][0].path;
    const bannerUpload = await cloudinary.uploader.upload(bannerPath, {
      folder: 'conference_alumni_banners',
      resource_type: 'image'
    });
    fs.unlinkSync(bannerPath);
    return bannerUpload.secure_url;
  }
  return '';
};

const handleRegistrationPosterUpload = async (file) => {
  if (!file || !file.path) return '';
  const posterUpload = await cloudinary.uploader.upload(file.path, {
    folder: 'registration_form_posters',
    resource_type: 'image'
  });
  fs.unlinkSync(file.path);
  return posterUpload.secure_url;
};

function parseRegistrationFormFields(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

const {
  toConferenceObjectId,
  findRegistrationFormForConference,
  saveRegistrationFormForConference,
  consolidateRegistrationFormDuplicates,
} = require('../utils/registrationFormStore');

/** Parse multipart only when Content-Type is multipart (JSON saves skip multer). */
function registrationFormUploadMiddleware(req, res, next) {
  const contentType = (req.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('multipart/form-data')) {
    return next();
  }
  return uploadLocal.single('poster')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'Invalid poster upload' });
    }
    next();
  });
}

/**
 * Detect if a form field represents a file upload
 * @param {Object} field - Field definition from registration form
 * @returns {boolean}
 */
const isFileUploadField = (field = {}) => {
  const type = (field.type || field.inputType || field.fieldType || '').toString().toLowerCase();
  return ['file', 'fileupload', 'file_upload', 'upload'].includes(type);
};

/**
 * Heuristic check for Cloudinary-backed uploads stored in form data
 * @param {any} value - Value stored for a field
 * @returns {boolean}
 */
const isUploadedFileValue = (value) => {
  if (typeof value !== 'string') return false;
  return value.startsWith('http') &&
    value.includes('res.cloudinary.com') &&
    value.includes('registration_uploads');
};

/**
 * Build field metadata from a registration form definition
 * @param {Array} fields - Registration form fields
 * @returns {{fieldOrder: string[], labelMap: Object, fileFieldNames: Set<string>}}
 */
const buildFieldMetadata = (fields = []) => {
  const fieldOrder = [];
  const labelMap = {};
  const fileFieldNames = new Set();

  fields.forEach(field => {
    const name = field?.name || field?.id;
    if (!name) return;

    if (isFileUploadField(field)) {
      fileFieldNames.add(name);
      return;
    }

    fieldOrder.push(name);
    labelMap[name] = field.label || name;
  });

  return { fieldOrder, labelMap, fileFieldNames };
};

function csvEscape(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function getRegistrationFormCellValue(reg, key) {
  if (key === 'email') {
    return reg.email || reg.formData?.email || '';
  }
  const val = reg.formData?.[key];
  if (val === null || val === undefined) return '';
  if (Array.isArray(val)) return val.join(', ');
  if (typeof val === 'boolean') return val ? 'Yes' : 'No';
  return String(val);
}

function getAttendeeCellFromRegistration(reg, ci, ti, fieldName) {
  const block = (reg.attendeeDetails || []).find((a) => Number(a?.categoryIndex) === ci);
  if (!block || !Array.isArray(block.attendees)) return '';
  const att = block.attendees[ti];
  if (!att || typeof att !== 'object') return '';
  const v = att[fieldName];
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}

function formatCsvMoney(value) {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  if (Number.isNaN(n)) return String(value);
  return n.toFixed(2);
}

function formatFeeCategoryBreakdownForCsv(reg) {
  const breakdown =
    (Array.isArray(reg?.paymentInfo?.feeCategoryBreakdown) && reg.paymentInfo.feeCategoryBreakdown.length
      ? reg.paymentInfo.feeCategoryBreakdown
      : null) ||
    (Array.isArray(reg?.feeCategoryBreakdown) && reg.feeCategoryBreakdown.length ? reg.feeCategoryBreakdown : null);
  if (!breakdown || !breakdown.length) return '';
  return breakdown
    .map((item) => {
      const name = (item?.categoryName || `Category ${(Number(item?.categoryIndex) || 0) + 1}`).toString().trim();
      const qty = Number(item?.quantity) || 1;
      const unit = Number(item?.unitAmount);
      const sub = Number(item?.subtotal);
      if (!Number.isNaN(sub)) {
        return `${name} x${qty} = ${sub.toFixed(2)}`;
      }
      if (!Number.isNaN(unit)) {
        return `${name} x${qty} @ ${unit.toFixed(2)}`;
      }
      return `${name} x${qty}`;
    })
    .join('; ');
}

function getPaymentCsvColumns() {
  return [
    { key: 'numberOfTickets', label: 'Number of tickets' },
    { key: 'couponCode', label: 'Coupon / Invite Code' },
    { key: 'paymentStatus', label: 'Payment Status' },
    { key: 'transactionId', label: 'Transaction ID' },
    { key: 'transactionDate', label: 'Transaction Date' },
    { key: 'paymentMethod', label: 'Payment Method' },
    { key: 'feeCategoryName', label: 'Ticket Category' },
    { key: 'originalAmount', label: 'Original Amount (INR)' },
    { key: 'discountAmount', label: 'Discount Amount (INR)' },
    { key: 'amount', label: 'Amount Paid (INR)' },
    { key: 'feeCategoryBreakdown', label: 'Ticket Breakdown' },
    { key: 'paymentApprovedAt', label: 'Payment Approved At' },
    { key: 'transactionProofUrl', label: 'Transaction Proof URL' },
    { key: 'paymentNotes', label: 'Payment Notes' },
  ];
}

function getPaymentCsvCellValue(reg, key) {
  const pi = reg?.paymentInfo || {};
  switch (key) {
    case 'numberOfTickets':
      return reg.numberOfTickets ?? '';
    case 'couponCode':
      return pi.couponCode ? String(pi.couponCode) : '';
    case 'paymentStatus':
      return pi.paymentStatus || '';
    case 'transactionId':
      return pi.transactionId || '';
    case 'transactionDate':
      return pi.transactionDate ? new Date(pi.transactionDate).toLocaleString() : '';
    case 'paymentMethod':
      return pi.paymentMethod || '';
    case 'feeCategoryName':
      return pi.feeCategoryName || '';
    case 'originalAmount':
      return formatCsvMoney(pi.originalAmount);
    case 'discountAmount':
      return formatCsvMoney(pi.discountAmount);
    case 'amount':
      return formatCsvMoney(pi.amount);
    case 'feeCategoryBreakdown':
      return formatFeeCategoryBreakdownForCsv(reg);
    case 'paymentApprovedAt':
      return pi.paymentApprovedAt ? new Date(pi.paymentApprovedAt).toLocaleString() : '';
    case 'transactionProofUrl':
      return pi.transactionProofUrl || '';
    case 'paymentNotes':
      return pi.notes || '';
    default:
      return '';
  }
}

/**
 * Build CSV export for registrants or attendees with all registration + ticket attendee fields.
 * @param {Array} registrations
 * @param {object|null} conference
 * @param {string} conferenceId
 * @param {{ includeRegisteredAt?: boolean, includeAttendedAt?: boolean }} options
 */
async function generateRegistrationCsvContent(registrations, conference, conferenceId, options = {}) {
  const { includeRegisteredAt = true, includeAttendedAt = false } = options;
  const feeCats = Array.isArray(conference?.feeCategories) ? conference.feeCategories : [];
  const attendeeFieldDefs = Array.isArray(conference?.attendeeFields) ? conference.attendeeFields : [];
  const maxTix = conference?.allowMultipleTickets
    ? Math.min(50, Math.max(1, Number(conference.maxTicketsPerRegistration) || 50))
    : 1;

  /** @type {{ key: string, label: string }[]} */
  let attendeeCsvColumns = [];
  if (feeCats.length > 0 && attendeeFieldDefs.length > 0) {
    for (let ci = 0; ci < feeCats.length; ci++) {
      const catName = (feeCats[ci]?.name || `Category ${ci + 1}`).toString().trim() || `Category ${ci + 1}`;
      const fieldsForCat = attendeeFieldDefs.filter((f) => {
        const applies = Number(f?.appliesToCategoryIndex);
        return applies === -1 || applies === ci;
      });
      for (let ti = 0; ti < maxTix; ti++) {
        for (const f of fieldsForCat) {
          const fname = (f.name || '').toString().trim();
          if (!fname) continue;
          attendeeCsvColumns.push({
            key: `att_ci${ci}_t${ti}_${fname}`,
            label: `${catName} | Attendee ${ti + 1} | ${(f.label || fname).toString()}`,
          });
        }
      }
    }
  }

  const regForm = await findRegistrationFormForConference(conferenceId);
  const hasFormDefinition = regForm && Array.isArray(regForm.fields) && regForm.fields.length > 0;

  let { fieldOrder: allKeys, labelMap, fileFieldNames } = hasFormDefinition
    ? buildFieldMetadata(regForm.fields)
    : { fieldOrder: [], labelMap: {}, fileFieldNames: new Set() };

  if (!allKeys.length) {
    const allKeysSet = new Set();
    registrations.forEach((reg) => {
      Object.keys(reg.formData || {}).forEach((key) => allKeysSet.add(key));
    });
    allKeys = Array.from(allKeysSet);
    allKeys.forEach((key) => {
      labelMap[key] = key;
    });
  }

  if (!allKeys.includes('email')) {
    allKeys.unshift('email');
    labelMap.email = 'Email';
  }

  const filteredKeys = allKeys.filter((key) => {
    if (fileFieldNames.has(key)) return false;
    if (!hasFormDefinition && registrations.some((reg) => isUploadedFileValue(reg.formData?.[key]))) {
      return false;
    }
    return true;
  });

  const headerRow = filteredKeys.map((key) => {
    const label = labelMap[key] || key;
    const cleaned = label.endsWith('_') ? label.slice(0, -1) : label;
    return csvEscape(cleaned);
  });
  attendeeCsvColumns.forEach((col) => {
    headerRow.push(csvEscape(col.label));
  });
  if (includeRegisteredAt) headerRow.push(csvEscape('Registered At'));
  if (includeAttendedAt) headerRow.push(csvEscape('Attended At'));

  const isPaidEvent = conference?.paymentType === 'paid';
  const paymentCsvColumns = isPaidEvent ? getPaymentCsvColumns() : [];
  paymentCsvColumns.forEach((col) => {
    headerRow.push(csvEscape(col.label));
  });

  const csvLines = [headerRow.join(',')];

  registrations.forEach((reg) => {
    const row = filteredKeys.map((key) => csvEscape(getRegistrationFormCellValue(reg, key)));
    attendeeCsvColumns.forEach((col) => {
      const m = /^att_ci(\d+)_t(\d+)_(.+)$/.exec(col.key);
      let cell = '';
      if (m) {
        cell = getAttendeeCellFromRegistration(reg, parseInt(m[1], 10), parseInt(m[2], 10), m[3]);
      }
      row.push(csvEscape(cell));
    });
    if (includeRegisteredAt) {
      const registeredAt = reg.registeredAt ? new Date(reg.registeredAt).toLocaleString() : '';
      row.push(csvEscape(registeredAt));
    }
    if (includeAttendedAt) {
      const attendedAt = reg.attendedAt ? new Date(reg.attendedAt).toLocaleString() : '';
      row.push(csvEscape(attendedAt));
    }
    paymentCsvColumns.forEach((col) => {
      row.push(csvEscape(getPaymentCsvCellValue(reg, col.key)));
    });
    csvLines.push(row.join(','));
  });

  return csvLines.join('\r\n');
};

/**
 * Process form data and return update object
 * @param {Object} req - Express request object
 * @param {string} status - Event status
 * @returns {Promise<Object>} - Processed update data
 */
const processEventFormData = async (req, status = 'draft', excludeEventId = null) => {
  const startDateStr = getString(req.body.startDate);
  const endDateStr = getString(req.body.endDate);
  let speakers = parseSpeakers(req);
  let sponsorCategories = parseSponsorCategories(req);

  for (let i = 0; i < speakers.length; i++) {
    const files = req.files && req.files[`speakerImage_${i}`];
    const file = files && files[0];
    if (file) {
      speakers[i].imageUrl = await uploadPersonImageFile(file, 'conference_speakers');
    }
  }

  for (let c = 0; c < sponsorCategories.length; c++) {
    const inner = sponsorCategories[c].sponsors;
    for (let s = 0; s < inner.length; s++) {
      const key = `sponsorImage_${c}_${s}`;
      const files = req.files && req.files[key];
      const file = files && files[0];
      if (file) {
        inner[s].imageUrl = await uploadPersonImageFile(file, 'conference_sponsors');
      }
    }
  }

  speakers = speakers.filter((s) =>
    (s.name && String(s.name).trim()) ||
    (s.designation && String(s.designation).trim()) ||
    (s.linkedin && String(s.linkedin).trim()) ||
    (s.imageUrl && String(s.imageUrl).trim())
  );

  sponsorCategories = sponsorCategories
    .map(cat => ({
      categoryName: (cat.categoryName || '').trim(),
      sponsors: (cat.sponsors || []).filter(
        (sp) =>
          (sp.name && String(sp.name).trim()) ||
          (sp.imageUrl && String(sp.imageUrl).trim())
      )
    }))
    .filter(cat => cat.sponsors.length > 0);

  for (const cat of sponsorCategories) {
    if (!cat.categoryName) {
      throw new Error('Each sponsor group must have a category name (e.g. Title Sponsor, Gold Sponsor).');
    }
    for (const sp of cat.sponsors) {
      if (!sp.imageUrl || !String(sp.imageUrl).trim()) {
        const label = (sp.name && String(sp.name).trim()) || 'Partner';
        throw new Error(`Sponsor "${label}" in "${cat.categoryName}" requires a logo image.`);
      }
    }
  }
  
  // Parse fee categories (JSON string or array)
  let feeCategories = [];
  if (req.body.feeCategories) {
    try {
      feeCategories = typeof req.body.feeCategories === 'string'
        ? JSON.parse(req.body.feeCategories)
        : req.body.feeCategories;
      if (!Array.isArray(feeCategories)) feeCategories = [];
    } catch (e) {
      feeCategories = [];
    }
  }

  // Parse attendee fields configured by organizer
  let attendeeFields = [];
  if (req.body.attendeeFields) {
    try {
      attendeeFields = typeof req.body.attendeeFields === 'string'
        ? JSON.parse(req.body.attendeeFields)
        : req.body.attendeeFields;
      if (!Array.isArray(attendeeFields)) attendeeFields = [];
    } catch (e) {
      attendeeFields = [];
    }
  }

  // Validate required fields for paid events (either feeCategories or legacy paymentAmount)
  if ((req.body.eventPayment === 'paid' || req.body.paymentType === 'paid')) {
    const validCategories = feeCategories.filter(c => c && (Number(c.amount) || 0) > 0);
    const hasLegacyPrice = req.body.paymentAmount && parseFloat(req.body.paymentAmount) > 0;
    if (validCategories.length === 0 && !hasLegacyPrice) {
      throw new Error('At least one registration fee category with amount is required for paid events');
    }
  }

  const eventType = getString(req.body.eventType).trim();

  const updateData = {
    eventType,
    title: req.body.eventName || req.body.title,
    startDate: startDateStr,
    endDate: endDateStr,
    time: (req.body.startTime && req.body.endTime)
      ? `${req.body.startTime} - ${req.body.endTime}`
      : (req.body.eventTime || req.body.time),
    startTime: req.body.startTime || '',
    endTime: req.body.endTime || '',
    organizer: req.body.organizer,
    location: req.body.eventLocation || req.body.location,
    googleMapsUrl: sanitizeGoogleMapsUrl(req.body.googleMapsUrl),
    mapsVenueName: (() => {
      const s = getString(req.body.mapsVenueName).trim();
      return s ? s.slice(0, 500) : '';
    })(),
    deadline: req.body.eventDeadline || req.body.deadline,
    description: getString(req.body.eventDescription) || getString(req.body.description) || '',
    isPublic: req.body.eventPrivacy === 'private' ? 'no' : (req.body.isPublic || 'yes'),
    isVirtual: req.body.isVirtual === 'true' || req.body.isVirtual === true,
    paymentType: req.body.eventPayment || req.body.paymentType || 'free',
    ticketPrice: (() => {
      if (feeCategories.length > 0 && (Number(feeCategories[0].amount) || 0) > 0) {
        return Number(feeCategories[0].amount);
      }
      return req.body.paymentAmount ? parseFloat(req.body.paymentAmount) : (req.body.ticketPrice ? parseFloat(req.body.ticketPrice) : 0);
    })(),
    feeCategories: feeCategories
      .map(c => ({
        name: (c && c.name != null) ? String(c.name).trim() : '',
        amount: (c && c.amount != null) ? Number(c.amount) : 0,
        paymentLink: feeCategoryPaymentLinkTrimmed(c) ? String(c.paymentLink).trim() : '',
        discountedPaymentLink: feeCategoryDiscountedPaymentLinkTrimmed(c)
          ? String(c.discountedPaymentLink).trim()
          : ''
      }))
      // Drop rows without a name. Keep ₹0 categories (used for access-code-gated tiers like Organizer).
      .filter(c => (c.name && c.name.trim())),
    attendeeFields: attendeeFields
      .filter(f => f && (f.name || f.label))
      .map(f => ({
        name: String(f.name || '').trim(),
        label: String(f.label || '').trim(),
        type: ['text', 'number', 'select', 'textarea'].includes(String(f.type || '').toLowerCase())
          ? String(f.type).toLowerCase()
          : 'text',
        required: !!f.required,
        options: Array.isArray(f.options) ? f.options.map(o => String(o || '').trim()).filter(Boolean) : [],
        appliesToCategoryIndex: Number.isInteger(Number(f.appliesToCategoryIndex)) ? Number(f.appliesToCategoryIndex) : -1
      }))
      .filter(f => f.name && f.label),
    organizerName: req.body.organizer || req.body.organizerName || '',
    organizerEmail: req.body.organizerEmail || '',
    organizerContact: req.body.organizerContact || '',
    paymentLink: (req.body.paymentLink != null && req.body.paymentLink !== '') ? String(req.body.paymentLink).trim() : '',
    discountedPaymentLink:
      req.body.discountedPaymentLink != null && req.body.discountedPaymentLink !== ''
        ? String(req.body.discountedPaymentLink).trim()
        : '',
    allowMultipleTickets: req.body.allowMultipleTickets === 'true' || req.body.allowMultipleTickets === true,
    maxTicketsPerRegistration: (() => {
      const raw = req.body.maxTicketsPerRegistration;
      const allow = req.body.allowMultipleTickets === 'true' || req.body.allowMultipleTickets === true;
      if (!allow) return 1;
      const num = parseInt(raw, 10);
      if (isNaN(num) || num < 1) return 1;
      return Math.min(Math.max(num, 1), 50);
    })(),
    tags: Array.isArray(req.body.tags) ? req.body.tags : (typeof req.body.tags === 'string' ? req.body.tags.split(',').map(t => t.trim()).filter(t => t) : []),
    sponsors: sponsorCategories.map(cat => ({
      categoryName: cat.categoryName,
      sponsors: cat.sponsors.map(s => ({ name: s.name.trim(), imageUrl: s.imageUrl || '' }))
    })),
    speakers: speakers.map(s => ({
      name: (s.name || '').trim(),
      designation: (s.designation || '').trim(),
      linkedin: (s.linkedin || '').trim(),
      imageUrl: s.imageUrl || ''
    })),
    status: status,
    externalRegistrationUrl: sanitizeExternalRegistrationUrl(req.body.externalRegistrationUrl),
    skipEmailOtp: req.body.skipEmailOtp === 'true' || req.body.skipEmailOtp === true,
    hideRegistrationSubmit: req.body.hideRegistrationSubmit === 'true' || req.body.hideRegistrationSubmit === true,
    showInviteCodeOption: req.body.showInviteCodeOption !== 'false' && req.body.showInviteCodeOption !== false,
    requireRegistrantApproval:
      req.body.requireRegistrantApproval !== 'false' && req.body.requireRegistrantApproval !== false,
    allowDuplicateRegistration:
      req.body.allowDuplicateRegistration === 'true' || req.body.allowDuplicateRegistration === true,
    requirePaymentDetails:
      req.body.requirePaymentDetails !== 'false' && req.body.requirePaymentDetails !== false,
    sharePostText: req.body.sharePostText ? String(req.body.sharePostText) : ''
  };
  
  // Add customEventType if eventType is 'others'
  const customEventType = getString(req.body.customEventType).trim();
  if (eventType === 'others' && customEventType) {
    updateData.customEventType = customEventType;
  } else if (eventType !== 'others') {
    updateData.customEventType = '';
  }

  // Add alumni meet specific fields
  if (eventType === 'alumni-meet') {
    if (req.body.alumniDescription) {
      updateData.alumniDescription = req.body.alumniDescription;
    }
  }

  // Add publishedAt timestamp if status is published
  if (status === 'published') {
    updateData.publishedAt = new Date();
  }

  // Handle file uploads
  const imageUrl = await handleImageUpload(req);
  if (imageUrl) {
    updateData.imageUrl = imageUrl;
  } else {
    const existingImageUrl = sanitizeExistingImageUrl(getString(req.body.existingImageUrl));
    if (existingImageUrl) {
      updateData.imageUrl = existingImageUrl;
    }
  }

  const agendaUrl = await handleAgendaUpload(req);
  if (agendaUrl) {
    updateData.agendaUrl = agendaUrl;
  } else {
    const existingAgendaUrl = sanitizeExistingImageUrl(getString(req.body.existingAgendaUrl));
    if (existingAgendaUrl) {
      updateData.agendaUrl = existingAgendaUrl;
    } else if (excludeEventId) {
      const existing = await Conference.findById(excludeEventId).select('agendaUrl').lean();
      if (existing?.agendaUrl) {
        updateData.agendaUrl = existing.agendaUrl;
      }
    }
  }

  const qrCodeUrl = await handleQrCodeUpload(req);
  if (qrCodeUrl) {
    updateData.qrCodeUrl = qrCodeUrl;
  } else {
    const existingQr = sanitizeExistingImageUrl(getString(req.body.existingQrCodeUrl));
    if (existingQr) {
      updateData.qrCodeUrl = existingQr;
    } else if (excludeEventId) {
      const existing = await Conference.findById(excludeEventId).select('qrCodeUrl').lean();
      if (existing?.qrCodeUrl) {
        updateData.qrCodeUrl = existing.qrCodeUrl;
      }
    }
  }

  // Handle alumni banner upload
  const alumniBannerUrl = await handleAlumniBannerUpload(req);
  if (alumniBannerUrl) {
    updateData.alumniBannerUrl = alumniBannerUrl;
  } else {
    const existingAlumniBanner = sanitizeExistingImageUrl(getString(req.body.existingAlumniBannerUrl));
    if (existingAlumniBanner) {
      updateData.alumniBannerUrl = existingAlumniBanner;
    } else if (excludeEventId) {
      const existing = await Conference.findById(excludeEventId).select('alumniBannerUrl').lean();
      if (existing?.alumniBannerUrl) {
        updateData.alumniBannerUrl = existing.alumniBannerUrl;
      }
    }
  }

  if (!updateData.imageUrl && excludeEventId) {
    const existing = await Conference.findById(excludeEventId).select('imageUrl').lean();
    if (existing?.imageUrl) {
      updateData.imageUrl = existing.imageUrl;
    }
  }

  // URL slug (urlSlug): independent of title; legacy `slug` kept in sync for older clients
  const title = getString(req.body.eventName || req.body.title);
  const slugFromBody = normalizeUrlSlugInput(getString(req.body.urlSlug));

  if (excludeEventId) {
    const existing = await Conference.findById(excludeEventId).select('urlSlug slug title').lean();
    if (!existing) {
      throw new Error('Event not found');
    }
    const legacySlug = String(existing.slug || '').trim();
    const existingUrlSlug = String(existing.urlSlug || '').trim();
    const currentPrimary = existingUrlSlug || legacySlug;

    if (slugFromBody && slugFromBody !== currentPrimary) {
      const unique = await allocateUniquePublicSlug(slugFromBody, excludeEventId);
      updateData.urlSlug = unique;
      updateData.slug = unique;
    } else if (!existingUrlSlug && legacySlug) {
      updateData.urlSlug = legacySlug;
      updateData.slug = legacySlug;
    }
  } else {
    const base = slugFromBody || generateSlugFromTitle(title) || 'event';
    const unique = await allocateUniquePublicSlug(base, null);
    updateData.urlSlug = unique;
    updateData.slug = unique;
  }

  return updateData;
};

// Helper function to get MIME type from file extension
const getMimeTypeFromExtension = (filename) => {
    const fileExtension = filename.toLowerCase().split('.').pop();
    const mimeTypes = {
        // Images
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'png': 'image/png',
        'gif': 'image/gif',
        'bmp': 'image/bmp',
        'webp': 'image/webp',
        'svg': 'image/svg+xml',
        // Documents
        'pdf': 'application/pdf',
        'ppt': 'application/vnd.ms-powerpoint',
        'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'doc': 'application/msword',
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'xls': 'application/vnd.ms-excel',
        'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'txt': 'text/plain',
        'csv': 'text/csv',
        // Archives
        'zip': 'application/zip',
        'rar': 'application/x-rar-compressed',
        '7z': 'application/x-7z-compressed'
    };
    return mimeTypes[fileExtension] || 'application/octet-stream';
};

// ============================================================================
// ROUTES
// ============================================================================

router.get('/convert-to-pdf/:folder/:filename', async (req, res) => {
    try {
        const { folder, filename } = req.params;

        // 🔐 Validate allowed folders
        const allowedFolders = ['conference_agendas', 'registration_uploads', 'payment_proofs'];
        if (!allowedFolders.includes(folder)) {
            console.error('Invalid folder requested:', folder);
            return res.status(400).send('Invalid folder path.');
        }

        // Try different Cloudinary URL structures
        let cloudinaryUrl;
        let contentType = 'application/octet-stream';
        
        // First, try as raw upload (for PDFs and other documents)
        cloudinaryUrl = `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/raw/upload/${folder}/${filename}`;

        try {
            const response = await axios({
                url: cloudinaryUrl,
                method: 'GET',
                responseType: 'arraybuffer',
            });

            // Detect content type from the actual file content
            if (response.data.length >= 4) {
                const header = response.data.slice(0, 4);
                if (header[0] === 0x25 && header[1] === 0x50 && header[2] === 0x44 && header[3] === 0x46) {
                    // PDF magic number: %PDF
                    contentType = 'application/pdf';
                } else if (header[0] === 0xFF && header[1] === 0xD8 && header[2] === 0xFF) {
                    // JPEG magic number
                    contentType = 'image/jpeg';
                } else if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47) {
                    // PNG magic number
                    contentType = 'image/png';
                } else if (header[0] === 0x47 && header[1] === 0x49 && header[2] === 0x46) {
                    // GIF magic number
                    contentType = 'image/gif';
                } else if (header[0] === 0x42 && header[1] === 0x4D) {
                    // BMP magic number
                    contentType = 'image/bmp';
                } else if (header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46) {
                    // WebP magic number (RIFF)
                    contentType = 'image/webp';
                } else {
                    // If magic number detection fails, use file extension for Office documents and other files
                    contentType = getMimeTypeFromExtension(filename);
                }
            } else {
                // For very small files, use file extension
                contentType = getMimeTypeFromExtension(filename);
            }

            // Set appropriate headers
            res.setHeader('Content-Type', contentType);
            res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
            res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
            
            // Send the file directly
            res.send(response.data);
            return;

        } catch (rawError) {
            
            // If raw upload fails, try as image upload
            cloudinaryUrl = `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload/${folder}/${filename}`;

            try {
                const response = await axios({
                    url: cloudinaryUrl,
                    method: 'GET',
                    responseType: 'arraybuffer',
                });

                // For images and other files, set appropriate content type based on filename
                contentType = getMimeTypeFromExtension(filename);
                // Set appropriate headers
                res.setHeader('Content-Type', contentType);
                res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
                res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
                
                // Send the file directly
                res.send(response.data);
                return;

            } catch (imageError) {
                console.error('Both raw and image uploads failed');
                throw imageError;
            }
        }

    } catch (error) {
        console.error('Error in convert-to-pdf route:', error);
        if (error.response) {
            console.error('Cloudinary response error:', error.response.status, error.response.data);
            res.status(500).send(`Error downloading the file: ${error.response.status}`);
        } else {
            res.status(500).send('Error downloading the file');
        }
    }
});

// New route for comprehensive event creation form
router.post('/create-event', uploadLocal.fields(eventFormUploadFields), validateEventCreationLimits, async (req, res) => {
    try {
        
        if (!getAuthUser(req)) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        // Get the status from the request body (sent by the frontend)
        const status = Array.isArray(req.body.status) ? req.body.status[0] : req.body.status;
        
        // Validate required fields for paid events in create mode
        if (status === 'published' && (req.body.eventPayment === 'paid' || req.body.paymentType === 'paid')) {
          let feeCategories = [];
          try {
            feeCategories = typeof req.body.feeCategories === 'string' ? JSON.parse(req.body.feeCategories || '[]') : (req.body.feeCategories || []);
          } catch (e) {}
          const validCategories = Array.isArray(feeCategories) ? feeCategories.filter(c => c && (Number(c.amount) || 0) > 0) : [];
          const hasLegacyPrice = req.body.paymentAmount && parseFloat(req.body.paymentAmount) > 0;
          if (validCategories.length === 0 && !hasLegacyPrice) {
            return res.status(400).json({ success: false, message: 'At least one registration fee category with amount is required for paid events' });
          }
          const hasPaymentLink = req.body.paymentLink && String(req.body.paymentLink).trim();
          const hasCategoryPaymentLink = anyFeeCategoryHasPaymentLink(feeCategories);
          const hasQrCode = req.files && req.files['qrCode'];
          if (!hasQrCode && !hasPaymentLink && !hasCategoryPaymentLink) {
            return res.status(400).json({ success: false, message: 'Please add a QR code image or a payment link (event-wide or per fee category) for paid events' });
          }
        }
        
        // Use the shared processEventFormData function with the correct status
        const conferenceData = await processEventFormData(req, status || 'draft');
        
        // Add the createdBy field for new events
        conferenceData.createdBy = getAuthUser(req)._id;
        
        const newConference = new Conference(conferenceData);

        await newConference.save();

        if (isAlumniMeetEventType(newConference.eventType, newConference.customEventType)) {
          await stripAlumniGraduationBranchFromRegistrationForm(newConference._id);
        }
        
        // Update usage stats and check limits
        try {
            const userId = getAuthUser(req)._id;
            const isInPersonEvent = !conferenceData.isVirtual;
            
            // Update event count in user.usageStats
            await PlanLimitsService.updateEventCount(userId, isInPersonEvent);
            
            // Check usage limits and send alert if needed
            const user = await User.findById(userId);
            if (user && user.usageStats) {
                if (isInPersonEvent) {
                    const currentCount = user.usageStats.inPersonEvents || 0;
                    const planLimits = require('../services/planLimitsService').getPlanLimits(user.selectedPlan || 'free');
                    const limit = planLimits.inPersonEvents;
                    
                    if (limit > 0) { // Only check if there's a limit
                        await UsageAlertService.checkEventLimits(userId, currentCount, limit);
                    }
                }
            }
        } catch (alertError) {
            console.error('Error updating usage stats or checking alerts after event creation:', alertError);
            // Don't fail the event creation if update/alert fails
        }
        
        res.json({ 
            success: true, 
            message: 'Event created successfully!',
            eventId: newConference._id
        });

    } catch (error) {
        console.error('❌ Error creating event:', error);
        console.error('Error details:', {
            message: error.message,
            stack: error.stack,
            body: req.body,
            files: req.files ? Object.keys(req.files) : 'No files'
        });
        res.status(500).json({ 
            success: false, 
            message: 'Error creating event: ' + (error.message || 'Unknown error'),
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// List your event (no login required) - find or create user by organizer email, then create event
router.post('/enlist-event', uploadLocal.fields([
    { name: 'image', maxCount: 1 }
]), async (req, res) => {
    try {
        const organizerEmail = getString(req.body.organizerEmail);
        const organizerName = getString(req.body.organizer) || getString(req.body.organizerName);
        if (!organizerEmail || !organizerName) {
            return res.status(400).json({ success: false, message: 'Organizer name and email are required.' });
        }

        let user = await User.findOne({ email: organizerEmail.toLowerCase() }).lean();
        if (!user) {
            const randomPassword = crypto.randomBytes(32).toString('hex');
            const hashedPassword = await bcrypt.hash(randomPassword, 10);
            const newUser = new User({
                email: organizerEmail.toLowerCase(),
                fullName: organizerName,
                password: hashedPassword,
                organization: organizerName
            });
            await newUser.save();
            user = { _id: newUser._id };
        }

        const status = 'published';
        const conferenceData = await processEventFormData(req, status);
        conferenceData.createdBy = user._id;

        const newConference = new Conference(conferenceData);
        await newConference.save();

        res.json({
            success: true,
            message: 'Event listed successfully!',
            eventId: newConference._id
        });
    } catch (error) {
        console.error('Error in enlist-event:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to list event.'
        });
    }
});

// REST API: Publish draft event (for Angular frontend)
router.put('/conferences/:id/publish', async (req, res) => {
  try {
    if (!getAuthUser(req)) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    const conferenceId = req.params.id;
    const conference = await Conference.findById(conferenceId);
    if (!conference) {
      return res.status(404).json({ success: false, message: 'Conference not found' });
    }
    const allowed = conference.createdBy && conference.createdBy.toString() === getAuthUser(req)._id.toString();
    if (!allowed && !(await isAdminUser(req))) {
      return res.status(403).json({ success: false, message: 'Not authorized to publish this event' });
    }
    // Simple status update for publishing from dashboard
    updateData = {
      status: 'published',
      publishedAt: new Date()
    };

    // Update the conference status
    const updatedConference = await Conference.findByIdAndUpdate(
      conferenceId,
      { $set: updateData },
      { new: true }
    );

    res.json({ 
      success: true, 
      message: 'Event published successfully!',
      event: updatedConference
    });
  } catch (err) {
    console.error("❌ Error publishing event:", err);
    res.status(500).json({ success: false, message: 'Server error while publishing event' });
  }
});

router.put('/conferences/:id', uploadLocal.fields(eventFormUploadFields), async (req, res) => {
    try {
      if (!getAuthUser(req)) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }
      if (!(await canModifyConference(req, req.params.id))) {
        return res.status(403).json({ success: false, message: 'Not authorized to edit this event' });
      }
      const existingDoc = await Conference.findById(req.params.id);
      if (!existingDoc) {
        return res.status(404).json({ success: false, message: 'Event not found.' });
      }
      // Handle status field - ensure it's a single string
      const status = Array.isArray(req.body.status) ? req.body.status[0] : req.body.status;
      
      // Validate required fields for paid events
      if (req.body.eventPayment === 'paid') {
        let feeCategories = [];
        try {
          feeCategories = typeof req.body.feeCategories === 'string' ? JSON.parse(req.body.feeCategories || '[]') : (req.body.feeCategories || []);
        } catch (e) {}
        const validCategories = Array.isArray(feeCategories) ? feeCategories.filter(c => c && (Number(c.amount) || 0) > 0) : [];
        const hasLegacyPrice = req.body.paymentAmount && parseFloat(req.body.paymentAmount) > 0;
        if (validCategories.length === 0 && !hasLegacyPrice) {
          return res.status(400).json({ success: false, message: 'At least one registration fee category with amount is required for paid events' });
        }
        // Require either QR code or payment link (new upload, existing QR, or payment link)
        const hasQrUpload = req.files && req.files['qrCode'];
        const hasExistingQr = existingDoc && existingDoc.qrCodeUrl;
        const hasPaymentLink = (req.body.paymentLink && String(req.body.paymentLink).trim()) || (existingDoc && existingDoc.paymentLink);
        const hasCategoryPaymentLink = anyFeeCategoryHasPaymentLink(feeCategories);
        if (!hasQrUpload && !hasExistingQr && !hasPaymentLink && !hasCategoryPaymentLink) {
          return res.status(400).json({ success: false, message: 'Please add a QR code image or a payment link (event-wide or per fee category) for paid events' });
        }
      }
      const oldPrimary = String((existingDoc.urlSlug || existingDoc.slug || '')).trim();
      // Process form data using shared function (exclude current event ID to prevent duplicate slug)
      const updatedData = await processEventFormData(req, status || 'draft', req.params.id);
      const newSlug = updatedData.urlSlug;
      const slugChanged = Boolean(newSlug && oldPrimary && newSlug !== oldPrimary);

      const updateOp = slugChanged
        ? { $set: updatedData, $addToSet: { slugRedirects: oldPrimary } }
        : { $set: updatedData };

      const updatedEvent = await Conference.findByIdAndUpdate(req.params.id, updateOp, { new: true });

      if (!updatedEvent) {
        return res.status(404).json({ success: false, message: 'Event not found.' });
      }
      if (isAlumniMeetEventType(updatedEvent.eventType, updatedEvent.customEventType)) {
        await stripAlumniGraduationBranchFromRegistrationForm(updatedEvent._id);
      }

      const wasFree = existingDoc.paymentType !== 'paid';
      const nowPaid = updatedEvent.paymentType === 'paid';
      if (nowPaid) {
        try {
          const payNotify = await syncPendingPaymentAfterEventPaid(updatedEvent._id, updatedEvent);
          if (wasFree && nowPaid) {
            const slug = updatedEvent.urlSlug || updatedEvent.slug || String(updatedEvent._id);
            for (const email of payNotify.emailsToNotify) {
              try {
                await sendRegistrationPaymentRequiredEmail(updatedEvent, email, slug);
              } catch (mailErr) {
                console.error('❌ Failed to send payment required email:', mailErr);
              }
            }
          }
        } catch (syncErr) {
          console.error('❌ Failed to sync pending payment for paid event:', syncErr);
        }
      }

      if (!conferenceRequiresRegistrantApproval(updatedEvent)) {
        try {
          await syncRegistrationsAfterApprovalDisabled(updatedEvent._id, updatedEvent);
        } catch (approvalSyncErr) {
          console.error('❌ Failed to sync registrations after disabling approval:', approvalSyncErr);
        }
      }

      const updatedPlain = typeof updatedEvent.toObject === 'function' ? updatedEvent.toObject() : updatedEvent;
      res.json({ success: true, message: 'Event updated successfully!', event: applySlugAliasesToLeanDoc(updatedPlain) });
    } catch (error) {
      console.error('❌ Error updating event:', error);
      console.error('Error details:', {
        message: error.message,
        stack: error.stack,
        body: req.body,
        files: req.files ? Object.keys(req.files) : 'No files'
      });
      res.status(500).json({ 
        success: false, 
        message: 'Error updating event: ' + (error.message || 'Unknown error'),
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  });

// Copy Conference Route
router.post('/copy-conference/:id', async (req, res) => {
    if (!getAuthUser(req)) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    try {
        if (!req.params.id || !mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ success: false, message: 'Invalid conference ID' });
        }
        const originalConference = await Conference.findById(req.params.id);
        if (!originalConference) {
            return res.status(404).json({ success: false, message: 'Conference not found' });
        }
        const canCopy = originalConference.createdBy && originalConference.createdBy.toString() === getAuthUser(req)._id.toString();
        if (!canCopy && !(await isAdminUser(req))) {
            return res.status(403).json({ success: false, message: 'Not authorized to copy this event' });
        }

        // Create a copy of the conference with draft status
        const copyData = {
            eventType: originalConference.eventType,
            title: `${originalConference.title} (Copy)`,
            startDate: originalConference.startDate,
            endDate: originalConference.endDate,
            time: originalConference.time,
            description: originalConference.description,
            organizer: originalConference.organizer,
            location: originalConference.location,
            googleMapsUrl: originalConference.googleMapsUrl || '',
            mapsVenueName: originalConference.mapsVenueName || '',
            deadline: originalConference.deadline,
            imageUrl: originalConference.imageUrl,
            agendaUrl: originalConference.agendaUrl,
            qrCodeUrl: originalConference.qrCodeUrl,
            paymentLink: originalConference.paymentLink || '',
            discountedPaymentLink: originalConference.discountedPaymentLink || '',
            allowMultipleTickets: originalConference.allowMultipleTickets || false,
            maxTicketsPerRegistration: originalConference.maxTicketsPerRegistration || 1,
            skipEmailOtp: !!originalConference.skipEmailOtp,
            hideRegistrationSubmit: !!originalConference.hideRegistrationSubmit,
            showInviteCodeOption: originalConference.showInviteCodeOption !== false,
            isPublic: 'no', // Always make copies private by default
            isVirtual: originalConference.isVirtual,
            paymentType: originalConference.paymentType,
            ticketPrice: originalConference.ticketPrice,
            feeCategories: originalConference.feeCategories && originalConference.feeCategories.length ? originalConference.feeCategories : [],
            attendeeFields: originalConference.attendeeFields && originalConference.attendeeFields.length ? originalConference.attendeeFields : [],
            organizerName: originalConference.organizerName,
            organizerEmail: originalConference.organizerEmail,
            sharePostText: originalConference.sharePostText || '',
            tags: originalConference.tags,
            sponsors: (() => {
              const raw = originalConference.sponsors;
              if (!Array.isArray(raw) || raw.length === 0) return [];
              if (raw[0].sponsors && Array.isArray(raw[0].sponsors)) {
                return raw.map(cat => ({
                  categoryName: cat.categoryName || 'Sponsors',
                  sponsors: (cat.sponsors || []).map(s => ({
                    name: s.name,
                    imageUrl: s.imageUrl || ''
                  }))
                }));
              }
              return [{
                categoryName: 'Sponsors',
                sponsors: raw.map(s => ({ name: s.name, imageUrl: s.imageUrl || '' }))
              }];
            })(),
            speakers: originalConference.speakers,
            status: 'draft', // Always create as draft
            createdBy: getAuthUser(req)._id,
            createdAt: new Date(),
            updatedAt: new Date()
        };
        
        // Copy customEventType if original has it and eventType is 'others'
        if (originalConference.eventType === 'others' && originalConference.customEventType) {
            copyData.customEventType = originalConference.customEventType;
        }
        
        const baseSlug = generateSlugFromTitle(copyData.title) || 'event';
        copyData.urlSlug = await allocateUniquePublicSlug(baseSlug, null);
        copyData.slug = copyData.urlSlug;
        copyData.slugRedirects = [];

        const conferenceCopy = new Conference(copyData);

        await conferenceCopy.save();

        const sourceForm = await findRegistrationFormForConference(req.params.id);
        if (sourceForm) {
            await saveRegistrationFormForConference(conferenceCopy._id, {
                fields: Array.isArray(sourceForm.fields) ? sourceForm.fields : [],
                displayEventName: sourceForm.displayEventName || '',
                posterUrl: sourceForm.posterUrl || '',
            });
        }

        res.json({ 
            success: true, 
            message: "Event copied successfully! The copy has been added to your drafts as a private event.",
            eventId: conferenceCopy._id
        });
    } catch (error) {
        console.error('❌ Error copying conference:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error while copying event. Please try again.' 
        });
    }
});

// Delete Conference Route
router.delete('/delete-conference/:id', async (req, res) => {
    if (!getAuthUser(req)) return res.status(401).json({ success: false, message: 'Unauthorized' });
    try {
        const conference = await Conference.findById(req.params.id);
        if (!conference) return res.status(404).json({ success: false, message: 'Conference not found' });
        const canDelete = conference.createdBy && conference.createdBy.toString() === getAuthUser(req)._id.toString();
        if (!canDelete && !(await isAdminUser(req))) {
            return res.status(403).json({ success: false, message: 'Not authorized to delete this event' });
        }
        await Conference.findByIdAndDelete(req.params.id);

        // Only decrease usage counts for incomplete events (draft/published)
        // This prevents users from cheating by deleting completed events to reset limits
        const isIncompleteEvent = conference.status === 'draft' || conference.status === 'published';
        
        if (isIncompleteEvent) {
            try {
                const userId = canDelete ? getAuthUser(req)._id : conference.createdBy;
                const isInPersonEvent = !conference.isVirtual;
                
                // Decrease event count in user.usageStats
                await PlanLimitsService.decreaseEventCount(userId, isInPersonEvent);
                
                // Decrease contact count for all registrations that were deleted with this conference
                const registrationCount = await Registration.countDocuments({ conferenceId: conference._id });
                if (registrationCount > 0) {
                    await PlanLimitsService.decreaseContactCount(userId, registrationCount);
                }
                
                console.log(`✅ Decreased usage counts for deleted ${conference.status} event: ${isInPersonEvent ? 'in-person' : 'webinar'} event, ${registrationCount} contacts`);
            } catch (usageError) {
                console.error('Error decreasing usage stats after conference deletion:', usageError);
                // Don't fail the deletion if usage stats update fails
            }
        } else {
            console.log(`⏭️ Skipped usage count decrease for completed event (status: ${conference.status})`);
        }

        res.json({ success: true, message: "Conference deleted successfully", redirect: "/dashboard" });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

router.get('/conference/:id/attendees/csv', async (req, res) => {
    try {
        const conferenceId = req.params.id;
        if (!getAuthUser(req)) {
            return res.status(401).send('Unauthorized');
        }
        if (!(await canViewOrDownloadConferenceRegistrants(req, conferenceId))) {
            return res.status(403).send('Forbidden');
        }

        const attendees = await Registration.find({ conferenceId, attended: true }).lean();
        if (!attendees || attendees.length === 0) {
            return res.status(404).send('No attendees marked as attended.');
        }

        const conference = await Conference.findById(conferenceId).lean();
        const csvContent = await generateRegistrationCsvContent(attendees, conference, conferenceId, {
            includeRegisteredAt: true,
            includeAttendedAt: true,
        });

        res.setHeader('Content-Type', 'text/csv; charset=UTF-8');
        res.setHeader('Content-Disposition', `attachment; filename="attendees_${conferenceId}.csv"`);
        return res.send(csvContent);
    } catch (error) {
        console.error('❌ Error generating attendee CSV:', error);
        res.status(500).send('Error generating attendee CSV');
    }
});


router.get('/attendees/:id', async (req, res) => {
    try {
        const conferenceId = req.params.id;

        const conference = await Conference.findById(conferenceId);
        if (!conference) {
            console.warn("⚠️ Conference not found for ID:", conferenceId);
            return res.status(404).send("Conference not found");
        }

        const attendees = await Registration.find({ conferenceId, attended: true }).lean();

        const regForm = await findRegistrationFormForConference(conferenceId);
        let formFields = [];

        if (regForm && Array.isArray(regForm.fields)) {
            formFields = regForm.fields.map(field => ({
                name: field.name || field.id,
                label: field.label || field.name || field.id
            }));
        } else {
            const fieldSet = new Set();
            attendees.forEach(reg => {
                if (reg.formData && typeof reg.formData === 'object') {
                    Object.keys(reg.formData).forEach(field => fieldSet.add(field));
                }
            });
            formFields = Array.from(fieldSet).map(name => ({ name, label: name }));
        }

        res.render('attendees', {
            conference,
            attendees,
            conferenceId,
            formFields
        });

    } catch (err) {
        console.error("❌ Error fetching attendees:", err);
        res.status(500).send("Server error");
    }
});

router.get('/conference/:id/registrants/csv', async (req, res) => {
    try {
        const conferenceId = req.params.id;
        if (!getAuthUser(req)) {
            return res.status(401).send('Unauthorized');
        }
        if (!(await canViewOrDownloadConferenceRegistrants(req, conferenceId))) {
            return res.status(403).send('Forbidden');
        }

        const registrations = await Registration.find({ conferenceId }).lean();
        if (!registrations.length) {
            return res.status(404).send('No registrants found.');
        }

        const conference = await Conference.findById(conferenceId).lean();
        const csvContent = await generateRegistrationCsvContent(registrations, conference, conferenceId, {
            includeRegisteredAt: true,
            includeAttendedAt: false,
        });

        res.setHeader('Content-Type', 'text/csv; charset=UTF-8');
        res.setHeader('Content-Disposition', `attachment; filename="registrants_${conferenceId}.csv"`);
        res.send(csvContent);

    } catch (err) {
        console.error('❌ Error generating CSV:', err);
        res.status(500).send('Server error while generating CSV');
    }
});

router.get('/registrants/:conferenceId', async (req, res) => {
    try {
        const conferenceId = req.params.conferenceId;
        if (!getAuthUser(req)) {
            return res.status(401).send('Unauthorized');
        }
        if (!(await canViewOrDownloadConferenceRegistrants(req, conferenceId))) {
            return res.status(403).send('Forbidden');
        }

        const conference = await Conference.findById(conferenceId);
        if (!conference) {
            console.warn("⚠️ Conference not found for ID:", conferenceId);
            return res.status(404).send("Conference not found");
        }

        const registrants = await Registration.find({ conferenceId }).lean();

        // Fetch the saved registration form structure
        const form = await findRegistrationFormForConference(conferenceId);
        let formFields = [];

        if (form && Array.isArray(form.fields)) {
            formFields = form.fields.map(field => ({
                name: field.name || field.id, // fallback
                label: field.label || field.name || field.id
            }));
        } else {
            // fallback to dynamic extraction
            const fieldSet = new Set();
            registrants.forEach(reg => {
                if (reg.formData && typeof reg.formData === 'object') {
                    Object.keys(reg.formData).forEach(field => fieldSet.add(field));
                }
            });
            formFields = Array.from(fieldSet).map(name => ({ name, label: name }));
        }

        res.json({
            conference,
            registrants,
            conferenceId,
            formFields
        });

    } catch (error) {
        console.error("❌ Error fetching registrants:", error);
        res.status(500).send("Server error while fetching registrants.");
    }
});

// GET route - Render form with saved fields (if any)
router.get('/createRegistrationForm/:id', async (req, res) => {
    try {
        const conferenceId = req.params.id;
        const conference = await Conference.findById(conferenceId);
        const savedForm = await findRegistrationFormForConference(conferenceId);

        const savedFields = savedForm ? JSON.stringify(savedForm.fields) : '[]';

        res.render('createRegistrationForm', {
            conferenceId,
            conference,
            savedFields
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error loading form.');
    }
});

// POST route - Save or update form fields
router.post('/createRegistrationForm/:id', async (req, res) => {
    try {
        if (!getAuthUser(req)) {
            return res.status(401).send('Unauthorized');
        }
        if (!(await canModifyConference(req, req.params.id))) {
            return res.status(403).send('Not authorized');
        }

        const { fields } = req.body;
        const parsedFields = parseRegistrationFormFields(fields);

        await saveRegistrationFormForConference(req.params.id, { fields: parsedFields });

        res.redirect(`/createRegistrationForm/${req.params.id}`);
    } catch (err) {
        console.error(err);
        res.status(500).send('Error saving form.');
    }
});

router.get('/conferences', async (req, res) => {
    try {
        // Only return published conferences that are not drafts
        const conferences = await Conference.find({ 
            status: { $ne: 'draft' }, // Exclude draft events
            isPublic: 'yes' // Only public events
        }).lean();
        res.json(conferences.map((c) => applySlugAliasesToLeanDoc(c)));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get conferences created by the logged-in user (MUST come before /:id route)
router.get('/conferences/my-conferences', async (req, res) => {
  if (!getAuthUser(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {   
    // Get events created by user AND events where user is a collaborator
    const conferences = await Conference.find({
      $or: [
        { createdBy: getAuthUser(req)._id },
        { collaborators: getAuthUser(req)._id }
      ]
    });
    // For each conference, count registrants and attendees
    const conferencesWithCounts = await Promise.all(
      conferences.map(async (conf) => {
        const registrants = await Registration.countDocuments({ conferenceId: conf._id });
        const attendees = await Registration.countDocuments({ conferenceId: conf._id, attended: true });
        const uid = String(getAuthUser(req)._id);
        return {
          ...applySlugAliasesToLeanDoc(conf.toObject()),
          registrants,
          attendees,
          isCollaborator:
            String(conf.createdBy) !== uid &&
            (conf.collaborators || []).some((c) => c && String(c) === uid)
        };
      })
    );
    res.json(conferencesWithCounts);
  } catch (err) {
    console.error('Error fetching user conferences:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's usage statistics and plan limits (MUST come before /:id route)
router.get('/conferences/usage-stats', getUserUsageStats, async (req, res) => {
  try {
    res.json({
      success: true,
      data: req.usageStats
    });
  } catch (error) {
    console.error('Error getting usage stats:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving usage statistics'
    });
  }
});

// Check whether the logged-in user may access coordinator tools for a conference
router.get('/conferences/:id/access', async (req, res) => {
  if (!getAuthUser(req)) {
    return res.status(401).json({ allowed: false, error: 'Unauthorized' });
  }
  try {
    const allowed = await canModifyConference(req, req.params.id);
    if (!allowed) {
      return res.status(403).json({ allowed: false });
    }
    return res.json({ allowed: true });
  } catch (err) {
    console.error('Error checking conference access:', err);
    return res.status(500).json({ allowed: false, error: 'Server error' });
  }
});

// Coordinator-only event payload (event management / edit event)
router.get('/conferences/:id/manage', async (req, res) => {
  if (!getAuthUser(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const conferenceId = req.params.id;
    if (!(await canModifyConference(req, conferenceId))) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const conference = await Conference.findById(conferenceId).lean();
    if (!conference) return res.status(404).json({ error: 'Conference not found' });
    return res.json(applySlugAliasesToLeanDoc(conference));
  } catch (err) {
    console.error('Error fetching conference for management:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// REST API: Get a single conference by ID (for Angular frontend)
router.get('/conferences/:id', async (req, res) => {
  try {
    const conference = await Conference.findById(req.params.id).lean();
    if (!conference) return res.status(404).json({ error: 'Conference not found' });
    if (!isConferencePubliclyViewable(conference)) {
      if (!getAuthUser(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      if (!(await canModifyConference(req, req.params.id))) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }
    res.json(applySlugAliasesToLeanDoc(conference));
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// REST API: Get a single conference by slug (for Angular frontend)
router.get('/conferences/slug/:slug', async (req, res) => {
  try {
    const conference = await findConferenceByPublicSlug(req.params.slug);
    if (!conference) return res.status(404).json({ error: 'Conference not found' });
    res.json(applySlugAliasesToLeanDoc(conference));
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/** Public approved registrant list for event details page (when organizer publishes it). */
router.get('/conferences/slug/:slug/public-registrants', async (req, res) => {
  try {
    const conference = await findConferenceByPublicSlug(req.params.slug);
    if (!conference) {
      return res.status(404).json({ success: false, message: 'Event not found.' });
    }
    if (!conference.publishRegistrantList) {
      return res.json({
        success: false,
        published: false,
        message: 'Registrant list is not published for this event.',
      });
    }

    const formFields = await getFormFieldsForPublicList(conference);
    const registrations = await Registration.find({ conferenceId: conference._id }).lean();
    const list = buildPublicRegistrantListResponse(conference, registrations, formFields);

    return res.json({
      success: true,
      published: true,
      eventTitle: conference.title || '',
      ...list,
    });
  } catch (err) {
    console.error('Error fetching public registrants:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

/** Coordinator toggles public registrant list on event details page. */
router.patch('/conferences/:id/publish-registrant-list', async (req, res) => {
  try {
    if (!getAuthUser(req)) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    const conferenceId = req.params.id;
    if (!(await canModifyConference(req, conferenceId))) {
      return res.status(403).json({ success: false, message: 'Not authorized to manage this event.' });
    }

    const raw = req.body?.publishRegistrantList;
    const publish = raw === true || raw === 'true' || raw === 1 || raw === '1';

    const updated = await Conference.findByIdAndUpdate(
      conferenceId,
      {
        $set: {
          publishRegistrantList: publish,
          registrantListPublishedAt: publish ? new Date() : null,
        },
      },
      { new: true }
    ).lean();

    if (!updated) {
      return res.status(404).json({ success: false, message: 'Event not found.' });
    }

    return res.json({
      success: true,
      message: publish
        ? 'Registrant list is now visible on the event page.'
        : 'Registrant list hidden from the event page.',
      event: applySlugAliasesToLeanDoc(updated),
    });
  } catch (err) {
    console.error('Error updating publish registrant list:', err);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// REST API: Get all registrants for a conference (for Angular frontend)
router.get('/conferences/:id/registrants', async (req, res) => {
  try {
    if (!getAuthUser(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const conferenceId = req.params.id;
    if (!(await canViewOrDownloadConferenceRegistrants(req, conferenceId))) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const conference = await Conference.findById(conferenceId).lean();
    const registrants = await Registration.find({ conferenceId });

    if (conference && conference.paymentType === 'paid') {
      for (const reg of registrants) {
        const payStatus = (reg.paymentInfo?.paymentStatus || '').toString().trim().toLowerCase();
        const regStatus = (reg.registrationStatus || '').toString().trim().toLowerCase();
        if (payStatus === 'rejected' || regStatus === 'rejected') {
          continue;
        }
        await reconcileRegistrationPayment(reg, conference, { persist: true });
      }
    }

    res.json(registrants.map((r) => (typeof r.toObject === 'function' ? r.toObject() : r)));
  } catch (err) {
    console.error("❌ Error fetching registrants:", err);
    res.status(500).json({ error: 'Server error' });
  }
});

function trimmedField(value) {
  return (value == null ? '' : String(value)).trim();
}

function computeRegistrationAmountForPayment(registration, conference) {
  const pi = registration.paymentInfo && typeof registration.paymentInfo === 'object'
    ? registration.paymentInfo
    : {};
  const amount = Number(pi.amount);
  if (!Number.isNaN(amount) && amount >= 0) {
    const original = Number(pi.originalAmount);
    return {
      amount,
      originalAmount: !Number.isNaN(original) && original >= 0 ? original : amount,
    };
  }

  const breakdown = Array.isArray(registration.feeCategoryBreakdown)
    ? registration.feeCategoryBreakdown
    : [];
  if (breakdown.length) {
    const total = breakdown.reduce((sum, item) => {
      const sub = Number(item?.subtotal);
      if (!Number.isNaN(sub)) return sum + sub;
      const unit = Number(item?.unitAmount) || 0;
      const qty = Number(item?.quantity) || 1;
      return sum + unit * qty;
    }, 0);
    return { amount: total, originalAmount: total };
  }

  const feeCats = Array.isArray(conference.feeCategories) ? conference.feeCategories : [];
  if (feeCats.length && registration.feeCategoryBreakdown == null) {
    const idx = feeCats.findIndex((c) => (Number(c.amount) || 0) > 0);
    const catIdx = idx >= 0 ? idx : 0;
    const unit = Number(feeCats[catIdx]?.amount) || 0;
    const qty = Number(registration.numberOfTickets) || 1;
    const total = unit * qty;
    return { amount: total, originalAmount: total };
  }

  if (conference.ticketPrice != null) {
    const qty = Number(registration.numberOfTickets) || 1;
    const total = (Number(conference.ticketPrice) || 0) * qty;
    return { amount: total, originalAmount: total };
  }

  return { amount: 0, originalAmount: 0 };
}

/**
 * PATCH /api/conferences/:conferenceId/registrants/:registrationId/payment-details
 * Event organizer, collaborator, or admin: add or update payment fields when registrant has not submitted them.
 */
router.patch(
  '/conferences/:conferenceId/registrants/:registrationId/payment-details',
  uploadLocal.any(),
  async (req, res) => {
    try {
      if (!getAuthUser(req)) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }

      const { conferenceId, registrationId } = req.params;
      if (!(await canViewOrDownloadConferenceRegistrants(req, conferenceId))) {
        return res.status(403).json({
          success: false,
          message: 'Only the event organizer, collaborator, or an administrator can update payment details.',
        });
      }

      const conference = await Conference.findById(conferenceId);
      if (!conference) {
        return res.status(404).json({ success: false, message: 'Conference not found.' });
      }
      if (conference.paymentType !== 'paid') {
        return res.status(400).json({ success: false, message: 'This event does not require payment.' });
      }

      const registration = await Registration.findById(registrationId);
      if (!registration) {
        return res.status(404).json({ success: false, message: 'Registration not found.' });
      }
      if (registration.conferenceId.toString() !== conferenceId.toString()) {
        return res.status(400).json({ success: false, message: 'Registration does not belong to this event.' });
      }

      const transactionId = trimmedField(req.body.transactionId);
      const transactionDateRaw = req.body.transactionDate;
      if (!transactionId) {
        return res.status(400).json({ success: false, message: 'Transaction ID is required.' });
      }

      const pi = { ...(registration.paymentInfo || {}) };
      pi.transactionId = transactionId;
      pi.paymentMethod = pi.paymentMethod || 'bank_transfer';

      if (transactionDateRaw) {
        const transactionDate = new Date(transactionDateRaw);
        if (Number.isNaN(transactionDate.getTime())) {
          return res.status(400).json({ success: false, message: 'Invalid transaction date.' });
        }
        pi.transactionDate = transactionDate;
      }

      const proofFile = (req.files || []).find((f) => f.fieldname === 'transactionProof');
      if (proofFile) {
        try {
          const uploadResult = await cloudinary.uploader.upload(proofFile.path, {
            folder: 'payment_proofs',
            resource_type: 'auto',
          });
          pi.transactionProofUrl = uploadResult.secure_url;
          if (fs.existsSync(proofFile.path)) {
            fs.unlinkSync(proofFile.path);
          }
        } catch (uploadErr) {
          console.error('Coordinator payment proof upload failed:', uploadErr);
          return res.status(500).json({ success: false, message: 'Failed to upload transaction proof.' });
        }
      }

      const { amount, originalAmount } = computeRegistrationAmountForPayment(registration, conference);
      if (pi.amount == null || Number.isNaN(Number(pi.amount))) {
        pi.amount = amount;
      }
      if (pi.originalAmount == null || Number.isNaN(Number(pi.originalAmount))) {
        pi.originalAmount = originalAmount;
      }

      if (!isPaymentWaived(pi)) {
        pi.paymentStatus = 'pending';
        pi.paymentApprovedAt = null;
      }

      registration.paymentInfo = pi;
      registration.markModified('paymentInfo');
      await reconcileRegistrationPayment(registration, conference, { persist: true });
      await registration.save();

      return res.json({
        success: true,
        message: 'Payment details saved. Approve when ready to confirm the registration.',
        data: {
          paymentInfo: registration.paymentInfo,
          paymentStatus: registration.paymentInfo.paymentStatus,
        },
      });
    } catch (err) {
      console.error('❌ Error updating registrant payment details:', err);
      return res.status(500).json({ success: false, message: 'Server error' });
    }
  }
);

/**
 * PATCH /api/conferences/:conferenceId/registrants/:registrationId/payment-status
 * Event organizer, collaborator, or admin can approve or reject paid registrations.
 * Paid registrations start as pending and require manual approval.
 */
router.patch('/conferences/:conferenceId/registrants/:registrationId/payment-status', async (req, res) => {
  try {
    if (!getAuthUser(req)) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const { conferenceId, registrationId } = req.params;
    const rawStatus = (req.body?.paymentStatus || '').toString().trim();
    const nextStatus = rawStatus === 'failed' ? 'rejected' : rawStatus;
    if (!['completed', 'pending', 'rejected'].includes(nextStatus)) {
      return res.status(400).json({
        success: false,
        message: 'paymentStatus must be "completed", "pending", or "rejected".',
      });
    }

    if (!(await canViewOrDownloadConferenceRegistrants(req, conferenceId))) {
      return res.status(403).json({
        success: false,
        message: 'Only the event organizer, collaborator, or an administrator can update registrant payment.'
      });
    }

    const conference = await Conference.findById(conferenceId).lean();
    if (!conference) {
      return res.status(404).json({ success: false, message: 'Conference not found.' });
    }

    if (conference.paymentType !== 'paid') {
      const registration = await Registration.findById(registrationId);
      if (!registration) {
        return res.status(404).json({ success: false, message: 'Registration not found.' });
      }
      if (registration.conferenceId.toString() !== conferenceId.toString()) {
        return res.status(400).json({ success: false, message: 'Registration does not belong to this event.' });
      }

      const { sendRegistrationConfirmationEmail } = require('../services/sendRegistrationConfirmationEmail');
      let updatedQrCodeUrl = registration.qrCodeUrl || '';
      const savedFormData = registration.formData && typeof registration.formData === 'object'
        ? registration.formData
        : {};

      if (nextStatus === 'completed') {
        if (!conference.isVirtual && !updatedQrCodeUrl) {
          const cloudinary = require('cloudinary').v2;
          const qrCodeDataUrl = await generateCompactAttendanceQrDataUrl(registration);
          const uploadResult = await cloudinary.uploader.upload(qrCodeDataUrl, {
            folder: 'conference_qr_codes',
            public_id: `QR_${conferenceId}_${registration._id}_${Date.now()}`
          });
          updatedQrCodeUrl = uploadResult.secure_url;
        }
        try {
          await sendRegistrationConfirmationEmail(
            conference,
            registration.email,
            savedFormData,
            updatedQrCodeUrl || ''
          );
        } catch (e) {
          console.error('❌ Registration approval email failed:', e);
        }
      }

      const updateSet = {
        registrationStatus: nextStatus,
        registrationApprovedAt: nextStatus === 'completed' ? new Date() : null,
      };
      if (updatedQrCodeUrl) {
        updateSet.qrCodeUrl = updatedQrCodeUrl;
      }
      await Registration.updateOne({ _id: registration._id }, { $set: updateSet });

      const statusMessage = nextStatus === 'completed'
        ? 'Registration approved. Confirmation email sent to the registrant.'
        : nextStatus === 'rejected'
          ? 'Registration rejected.'
          : 'Registration status updated.';

      return res.json({
        success: true,
        message: statusMessage,
        data: {
          registrationId: registration._id,
          registrationStatus: nextStatus,
          qrCodeUrl: updatedQrCodeUrl || '',
        },
      });
    }

    const registration = await Registration.findById(registrationId);
    if (!registration) {
      return res.status(404).json({ success: false, message: 'Registration not found.' });
    }
    if (registration.conferenceId.toString() !== conferenceId.toString()) {
      return res.status(400).json({ success: false, message: 'Registration does not belong to this event.' });
    }

    // Update status
    const nextPaymentInfo = {
      ...(registration.paymentInfo || {}),
      paymentStatus: nextStatus,
      paymentApprovedAt: nextStatus === 'completed' ? new Date() : null,
    };

    // Track updated QR code URL for response/persistence.
    let updatedQrCodeUrl = registration.qrCodeUrl || '';

    // If approved, generate attendee QR (offline only) and send confirmation email (virtual: send join link email).
    if (nextStatus === 'completed') {
      const { sendEmail } = require('../services/emailService');
      const cloudinary = require('cloudinary').v2;
      let qrCodeUrl = updatedQrCodeUrl || '';
      if (!conference.isVirtual && !qrCodeUrl) {
        const qrCodeDataUrl = await generateCompactAttendanceQrDataUrl(registration);
        const uploadResult = await cloudinary.uploader.upload(qrCodeDataUrl, {
          folder: 'conference_qr_codes',
          public_id: `QR_${conferenceId}_${registration._id}_${Date.now()}`
        });
        qrCodeUrl = uploadResult.secure_url;
      }
      updatedQrCodeUrl = qrCodeUrl || updatedQrCodeUrl;

      const nameField = registration.formData?.name || 'Participant';
      const subject = `Registration Confirmation - ${conference.title}`;

      let htmlContent;
      let textContent;

      if (conference.isVirtual) {
        const joinLink = conference.location;
        const eventDate = conference.startDate;
        const eventTime = conference.time;
        const organizerName = conference.organizer || 'Event Organizer';
        htmlContent = `
          <html>
          <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
          <body style="margin:0;padding:20px;background:#f8fafc;font-family:Arial,sans-serif;">
            <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;box-shadow:0 4px 6px rgba(0,0,0,.1);padding:40px;">
              <h1 style="color:#007bff;font-size:24px;margin:0 0 20px 0;text-align:center;">Registration Confirmation</h1>
              <p style="font-size:16px;line-height:1.6;color:#374151;margin:0 0 16px 0;">Dear ${nameField},</p>
              <p style="font-size:16px;line-height:1.6;color:#374151;margin:0 0 20px 0;">Your payment has been verified. You are confirmed for <strong style="color:#1F2937;">"${conference.title}"</strong>! 🎉</p>
              <div style="background:#F3F4F6;padding:24px;border-radius:8px;margin:24px 0;border-left:4px solid #4F46E5;">
                <h3 style="color:#374151;margin:0 0 16px 0;font-size:18px;">Your Event Details:</h3>
                <p style="margin:8px 0;font-size:16px;color:#374151;"><strong style="color:#1F2937;">Date:</strong> ${eventDate}</p>
                <p style="margin:8px 0;font-size:16px;color:#374151;"><strong style="color:#1F2937;">Time:</strong> ${eventTime}</p>
                <p style="margin:8px 0;font-size:16px;color:#374151;"><strong style="color:#1F2937;">Join Link:</strong> <a href="${joinLink}" style="color:#007bff;text-decoration:none;word-break:break-all;">${joinLink}</a></p>
              </div>
              <p style="font-size:16px;line-height:1.6;color:#374151;margin:20px 0 0 0;">Best regards,<br><strong style="color:#1F2937;">${organizerName}</strong></p>
            </div>
          </body>
          </html>
        `;
        textContent = `Dear ${nameField},\n\nYour payment has been verified. You are confirmed for "${conference.title}"!\n\nDate: ${eventDate}\nTime: ${eventTime}\nJoin Link: ${joinLink}\n\nBest regards,\n${organizerName}`;
      } else {
        htmlContent = `
          <html>
          <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
          <body style="margin:0;padding:20px;background:#f8fafc;font-family:Arial,sans-serif;">
            <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;box-shadow:0 4px 6px rgba(0,0,0,.1);padding:40px;">
              <h1 style="color:#007bff;font-size:24px;margin:0 0 20px 0;text-align:center;">Registration Confirmed</h1>
              <p style="font-size:16px;line-height:1.6;color:#374151;margin:0 0 16px 0;">Dear ${nameField},</p>
              <p style="font-size:16px;line-height:1.6;color:#374151;margin:0 0 20px 0;">Your payment has been verified and your registration for <strong style="color:#1F2937;">"${conference.title}"</strong> is confirmed.</p>
              <p style="font-size:16px;line-height:1.6;color:#374151;margin:0 0 20px 0;">Your QR code for event check-in is below:</p>
              <div style="text-align:center;margin:30px 0;padding:20px;background:#F9FAFB;border-radius:8px;">
                <img src="${qrCodeUrl}" alt="QR Code" style="max-width:250px;height:auto;border:2px solid #E5E7EB;border-radius:8px;display:block;margin:0 auto;">
              </div>
              <p style="font-size:16px;line-height:1.6;color:#374151;margin:20px 0;text-align:center;">Please bring this QR code with you to the event for easy check-in.</p>
            </div>
          </body>
          </html>
        `;
        textContent = `Dear ${nameField},\n\nYour payment has been verified and your registration for "${conference.title}" is confirmed.\n\nYour QR code is available in this email. Please bring it for check-in.`;
      }

      try {
        await sendEmail(registration.email, subject, textContent, htmlContent);
      } catch (e) {
        console.error('❌ Payment approval email failed:', e);
      }

      // Persist updates without re-validating the whole document (some legacy docs may miss required fields like formData).
      const updateSet = {
        'paymentInfo': nextPaymentInfo
      };
      if (updatedQrCodeUrl) {
        updateSet['qrCodeUrl'] = updatedQrCodeUrl;
      }
      await Registration.updateOne({ _id: registration._id }, { $set: updateSet });
      registration.paymentInfo = nextPaymentInfo;
      if (updatedQrCodeUrl) registration.qrCodeUrl = updatedQrCodeUrl;
      await reconcileRegistrationPayment(registration, conference, { persist: true });
    }
    if (nextStatus !== 'completed') {
      registration.paymentInfo = nextPaymentInfo;
      registration.markModified('paymentInfo');
      if (updatedQrCodeUrl) {
        registration.qrCodeUrl = updatedQrCodeUrl;
      }
      await registration.save();
      if (nextStatus !== 'rejected') {
        await reconcileRegistrationPayment(registration, conference, { persist: true });
      }
    }

    const statusMessage = nextStatus === 'completed'
      ? 'Payment approved. Confirmation email sent to the registrant.'
      : nextStatus === 'rejected'
        ? 'Payment rejected.'
        : 'Payment status updated.';

    return res.json({
      success: true,
      message: statusMessage,
      data: {
        registrationId: registration._id,
        paymentStatus: nextPaymentInfo?.paymentStatus,
        qrCodeUrl: updatedQrCodeUrl || ''
      }
    });
  } catch (error) {
    console.error('Error updating payment status:', error);
    return res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
});

/**
 * GET /api/conferences/:conferenceId/registrants/:registrationId/qr-code
 * Event organizer or super admin: download check-in QR image for manual sharing.
 */
router.get('/conferences/:conferenceId/registrants/:registrationId/qr-code', async (req, res) => {
  try {
    if (!getAuthUser(req)) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const { conferenceId, registrationId } = req.params;
    if (!(await canViewOrDownloadConferenceRegistrants(req, conferenceId))) {
      return res.status(403).json({
        success: false,
        message: 'Only the event organizer, a collaborator, or an administrator can download check-in QR codes.'
      });
    }

    const conference = await Conference.findById(conferenceId).lean();
    if (!conference) {
      return res.status(404).json({ success: false, message: 'Conference not found.' });
    }

    if (!isInPersonConference(conference)) {
      return res.status(400).json({
        success: false,
        message: 'Virtual events do not use check-in QR codes.'
      });
    }

    const registration = await Registration.findById(registrationId);
    if (!registration) {
      return res.status(404).json({ success: false, message: 'Registration not found.' });
    }
    if (registration.conferenceId.toString() !== conferenceId.toString()) {
      return res.status(400).json({ success: false, message: 'Registration does not belong to this event.' });
    }

    const email = (registration.email || '').trim();
    if (!email) {
      return res.status(400).json({ success: false, message: 'Registration has no email address.' });
    }

    const existingQr = (registration.qrCodeUrl || '').trim();
    if (!existingQr && !isRegistrationPaymentCompleted(conference, registration)) {
      return res.status(400).json({
        success: false,
        message: 'Check-in QR is available after payment is approved (completed).'
      });
    }

    const qrCodeUrl = await ensureRegistrationCheckInQrUrl(conference, registration);
    if (!qrCodeUrl) {
      return res.status(400).json({
        success: false,
        message: 'Could not produce a check-in QR for this registration.'
      });
    }

    const imageResponse = await axios.get(qrCodeUrl, { responseType: 'arraybuffer', timeout: 30000 });
    const filename = buildQrDownloadFilename(registration, conference);
    res.setHeader('Content-Type', imageResponse.headers['content-type'] || 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(Buffer.from(imageResponse.data));
  } catch (error) {
    console.error('Error downloading registrant QR:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to download check-in QR code.'
    });
  }
});

/**
 * POST /api/conferences/:conferenceId/registrants/bulk-send-attendance-qr
 * Generate check-in QR codes (if needed) and email them to all completed in-person registrants.
 */
router.post('/conferences/:conferenceId/registrants/bulk-send-attendance-qr', async (req, res) => {
  try {
    if (!getAuthUser(req)) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const { conferenceId } = req.params;
    if (!(await canViewOrDownloadConferenceRegistrants(req, conferenceId))) {
      return res.status(403).json({
        success: false,
        message: 'Only the event organizer, collaborator, or an administrator can send attendance QR emails.'
      });
    }

    const conference = await Conference.findById(conferenceId).lean();
    if (!conference) {
      return res.status(404).json({ success: false, message: 'Conference not found.' });
    }
    if (conference.isVirtual && conference.paymentType === 'paid') {
      return res.status(400).json({
        success: false,
        message: 'Bulk attendance QR is for in-person events. Use Communication for paid virtual events.'
      });
    }

    const eventObjectId = new mongoose.Types.ObjectId(conferenceId);
    const registrations = await Registration.find({
      $or: [
        { conferenceId: eventObjectId },
        { conferenceId: String(conferenceId) },
      ],
    });

    const eligible = registrations.filter((registration) =>
      isEligibleForAttendanceQrEmail(conference, registration)
    );

    if (eligible.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No completed registrants with email addresses found for this event.'
      });
    }

    const userId = getAuthUser(req)._id;
    const canSendEmails = await PlanLimitsService.canSendEmails(userId, eligible.length);
    if (!canSendEmails.allowed) {
      return res.status(403).json({
        success: false,
        message: canSendEmails.reason,
        errorCode: 'EMAIL_LIMIT_EXCEEDED',
        currentCount: canSendEmails.currentCount,
        limit: canSendEmails.limit,
        requestedCount: canSendEmails.requestedCount,
        eligibleCount: eligible.length,
      });
    }

    const sent = [];
    const failed = [];

    for (const registration of eligible) {
      try {
        const result = await sendRegistrantConfirmationWithQr(conference, registration);
        sent.push(result);
      } catch (error) {
        failed.push({
          registrationId: registration._id,
          email: (registration.email || '').trim(),
          message: error.message || 'Failed to send email',
        });
      }
    }

    if (sent.length > 0) {
      await PlanLimitsService.updateEmailCount(userId, sent.length);
    }

    return res.json({
      success: true,
      message: `Attendance QR emails sent to ${sent.length} registrant(s). Each email includes a unique QR code.`,
      data: {
        sentCount: sent.length,
        failedCount: failed.length,
        totalEligible: eligible.length,
        sent,
        failed,
      },
    });
  } catch (error) {
    console.error('Error bulk sending attendance QR emails:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to send attendance QR emails.'
    });
  }
});

/**
 * POST /api/conferences/:conferenceId/registrants/:registrationId/resend-confirmation
 * Event organizer or super admin: resend the same confirmation email as public registration
 * (join details for virtual; QR check-in image for in-person when applicable).
 */
router.post('/conferences/:conferenceId/registrants/:registrationId/resend-confirmation', async (req, res) => {
  try {
    if (!getAuthUser(req)) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const { conferenceId, registrationId } = req.params;
    if (!(await canViewOrDownloadConferenceRegistrants(req, conferenceId))) {
      return res.status(403).json({
        success: false,
        message: 'Only the event organizer, collaborator, or an administrator can resend confirmation emails.'
      });
    }

    const conference = await Conference.findById(conferenceId).lean();
    if (!conference) {
      return res.status(404).json({ success: false, message: 'Conference not found.' });
    }

    const registration = await Registration.findById(registrationId);
    if (!registration) {
      return res.status(404).json({ success: false, message: 'Registration not found.' });
    }
    if (registration.conferenceId.toString() !== conferenceId.toString()) {
      return res.status(400).json({ success: false, message: 'Registration does not belong to this event.' });
    }

    const email = (registration.email || '').trim();
    if (!email) {
      return res.status(400).json({ success: false, message: 'Registration has no email address.' });
    }

    if (!isEligibleForAttendanceQrEmail(conference, registration)) {
      return res.status(400).json({
        success: false,
        message: 'Confirmation can only be resent for completed registrations (paid or free).'
      });
    }

    if (!conference.isVirtual) {
      registration.paymentInfo = registration.paymentInfo || null;
    }

    const result = await sendRegistrantConfirmationWithQr(conference, registration);

    return res.json({
      success: true,
      message: 'Attendance QR email has been sent with this registrant\'s unique check-in code.',
      data: result
    });
  } catch (error) {
    console.error('Error resending confirmation:', error);
    const status = error.message?.includes('not completed') || error.message?.includes('no email')
      ? 400
      : 500;
    return res.status(status).json({
      success: false,
      message: error.message || 'Failed to send confirmation email.'
    });
  }
});

/**
 * PATCH /api/conferences/:conferenceId/registrants/:registrationId
 * Event organizer, collaborator, or admin: update registrant email, registration form answers,
 * and optionally ticketCategoryIndex (paid events with a single fee category only).
 * File upload fields cannot be changed here. Regenerates check-in QR for in-person events when identity or ticket/pricing fields change.
 */
router.patch('/conferences/:conferenceId/registrants/:registrationId', async (req, res) => {
  try {
    if (!getAuthUser(req)) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const { conferenceId, registrationId } = req.params;
    if (!(await canViewOrDownloadConferenceRegistrants(req, conferenceId))) {
      return res.status(403).json({
        success: false,
        message: 'Only the event organizer, collaborator, or an administrator can edit registrant details.'
      });
    }

    const conference = await Conference.findById(conferenceId).lean();
    if (!conference) {
      return res.status(404).json({ success: false, message: 'Conference not found.' });
    }

    const registration = await Registration.findById(registrationId);
    if (!registration) {
      return res.status(404).json({ success: false, message: 'Registration not found.' });
    }
    if (registration.conferenceId.toString() !== conferenceId.toString()) {
      return res.status(400).json({ success: false, message: 'Registration does not belong to this event.' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (body.paymentInfo !== undefined) {
      return res.status(400).json({
        success: false,
        message: 'Payment updates are not allowed on this endpoint. Use payment status or payment tools instead.'
      });
    }

    let categoryChanged = false;
    if (
      Object.prototype.hasOwnProperty.call(body, 'ticketCategoryIndex') &&
      body.ticketCategoryIndex !== null &&
      body.ticketCategoryIndex !== ''
    ) {
      if (conference.paymentType === 'paid' && Array.isArray(conference.feeCategories) && conference.feeCategories.length > 0) {
        const catResult = await changeRegistrationTicketCategory(conference, registration, body.ticketCategoryIndex);
        if (!catResult.ok) {
          return res.status(400).json({ success: false, message: catResult.message });
        }
        if (!catResult.noop) {
          registration.numberOfTickets = catResult.numberOfTickets;
          registration.feeCategoryBreakdown = catResult.feeCategoryBreakdown;
          registration.attendeeDetails = catResult.attendeeDetails;
          registration.paymentInfo = catResult.paymentInfo;
          registration.markModified('feeCategoryBreakdown');
          registration.markModified('attendeeDetails');
          registration.markModified('paymentInfo');
          categoryChanged = true;
        }
      }
    }

    const regForm = await findRegistrationFormForConference(conferenceId);
    let formFields = Array.isArray(regForm?.fields) ? regForm.fields : [];
    if (isAlumniMeetEventType(conference.eventType, conference.customEventType)) {
      formFields = stripAlumniGraduationBranchFields(formFields);
    }
    const allowedNames = new Set(formFields.map((f) => f.name).filter(Boolean));
    Object.keys(registration.formData || {}).forEach((k) => allowedNames.add(k));
    const fileFieldNames = new Set(
      formFields.filter((f) => f && f.type === 'file').map((f) => f.name).filter(Boolean)
    );

    const prevEmail = (registration.email || '').trim().toLowerCase();
    let nextEmail = prevEmail;
    if (body.email !== undefined) {
      const raw = String(body.email).trim().toLowerCase();
      if (!raw) {
        return res.status(400).json({ success: false, message: 'Email cannot be empty.' });
      }
      const dup = await Registration.findOne({
        conferenceId,
        email: raw,
        _id: { $ne: registration._id }
      })
        .select('_id')
        .lean();
      if (dup) {
        return res.status(400).json({
          success: false,
          message: 'Another registration already uses this email for this event.'
        });
      }
      nextEmail = raw;
    }

    const prevFormSnapshot = JSON.stringify(registration.formData || {});
    let nextFormData = { ...(registration.formData || {}) };

    if (body.formData !== undefined) {
      if (!body.formData || typeof body.formData !== 'object' || Array.isArray(body.formData)) {
        return res.status(400).json({ success: false, message: 'formData must be an object.' });
      }
      for (const [key, val] of Object.entries(body.formData)) {
        if (!allowedNames.has(key)) continue;
        if (fileFieldNames.has(key) || key === 'transactionProof') continue;
        nextFormData[key] = val;
      }
    }

    for (const f of formFields) {
      if (f && (f.type === 'email' || (f.name && String(f.name).toLowerCase() === 'email'))) {
        if (f.name) nextFormData[f.name] = nextEmail;
      }
    }

    const emailChanged = nextEmail !== prevEmail;
    const formChanged = JSON.stringify(nextFormData) !== prevFormSnapshot;

    registration.email = nextEmail;
    registration.formData = nextFormData;

    const isPaidEvent = conference.paymentType === 'paid';
    const payStatus = (registration.paymentInfo && registration.paymentInfo.paymentStatus)
      ? String(registration.paymentInfo.paymentStatus).trim()
      : '';
    const shouldHaveQr =
      !conference.isVirtual && (!isPaidEvent || payStatus === 'completed');

    let newQrCodeUrl = null;
    if (shouldHaveQr && (emailChanged || formChanged || categoryChanged)) {
      const qrCodeDataUrl = await generateCompactAttendanceQrDataUrl(registration);
      const uploadResult = await cloudinary.uploader.upload(qrCodeDataUrl, {
        folder: 'conference_qr_codes',
        public_id: `QR_${conferenceId}_${registration._id}_${Date.now()}`
      });
      newQrCodeUrl = uploadResult.secure_url;
      registration.qrCodeUrl = newQrCodeUrl;
    }

    await registration.save();

    const lean = registration.toObject ? registration.toObject() : registration;
    return res.json({
      success: true,
      message: 'Registrant updated.',
      qrRegenerated: !!newQrCodeUrl,
      data: lean
    });
  } catch (error) {
    console.error('Error updating registration:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error while updating registration.'
    });
  }
});

// REST API: Get all attendees for a conference (for Angular frontend)
router.get('/conferences/:id/attendees', async (req, res) => {
  try {
    if (!getAuthUser(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const conferenceId = req.params.id;
    if (!(await canViewOrDownloadConferenceRegistrants(req, conferenceId))) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const attendees = await Registration.find({ conferenceId, attended: true }).lean();
    
    res.json(attendees);
  } catch (err) {
    console.error("❌ Error fetching attendees:", err);
    res.status(500).json({ error: 'Server error' });
  }
});

// REST API: Get registration form for a conference (for Angular frontend)
router.get('/conferences/:id/registration-form', async (req, res) => {
  try {
    await consolidateRegistrationFormDuplicates(req.params.id);
    const conference = await Conference.findById(req.params.id).select('eventType customEventType').lean();
    const registrationForm = await findRegistrationFormForConference(req.params.id);
    const base = registrationForm || { fields: [], displayEventName: '', posterUrl: '' };
    let fields = Array.isArray(base.fields) ? base.fields : [];
    if (conference && isAlumniMeetEventType(conference.eventType, conference.customEventType)) {
      fields = stripAlumniGraduationBranchFields(fields);
    }
    res.json({ ...base, fields });
  } catch (err) {
    console.error("❌ Error fetching registration form:", err);
    res.status(500).json({ error: 'Server error' });
  }
});

// REST API: Save registration form for a conference (for Angular frontend)
router.post('/conferences/:id/registration-form', registrationFormUploadMiddleware, async (req, res) => {
  try {
    if (!getAuthUser(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!(await canModifyConference(req, req.params.id))) {
      return res.status(403).json({ error: 'Not authorized to modify this event' });
    }

    const conferenceObjectId = toConferenceObjectId(req.params.id);
    if (!conferenceObjectId) {
      return res.status(400).json({ error: 'Invalid conference id' });
    }

    const displayEventName = String(req.body.displayEventName || '').trim();
    const $set = { displayEventName };

    const previousForm = await findRegistrationFormForConference(req.params.id);
    const previousFields = Array.isArray(previousForm?.fields) ? previousForm.fields : [];

    if (req.body.fields !== undefined) {
      const parsedFields = parseRegistrationFormFields(req.body.fields);
      if (
        parsedFields.length === 0 &&
        req.body.fields != null &&
        String(req.body.fields).trim() !== '' &&
        String(req.body.fields).trim() !== '[]'
      ) {
        console.error('❌ Registration form fields payload could not be parsed', {
          conferenceId: req.params.id,
          type: typeof req.body.fields,
        });
        return res.status(400).json({ error: 'Invalid registration form fields payload.' });
      }
      $set.fields = parsedFields;
    } else {
      const existing = await findRegistrationFormForConference(req.params.id);
      if (existing?.fields?.length) {
        $set.fields = existing.fields;
      } else {
        $set.fields = [];
      }
    }

    const conference = await Conference.findById(conferenceObjectId)
      .select('eventType customEventType title urlSlug slug')
      .lean();
    if (conference && isAlumniMeetEventType(conference.eventType, conference.customEventType)) {
      $set.fields = stripAlumniGraduationBranchFields($set.fields);
    }

    if (req.file) {
      try {
        $set.posterUrl = await handleRegistrationPosterUpload(req.file);
      } catch (uploadErr) {
        console.error('❌ Registration poster upload failed:', uploadErr);
        return res.status(500).json({ error: 'Failed to upload poster image' });
      }
    } else if (req.body.removePoster === 'true' || req.body.removePoster === true) {
      $set.posterUrl = '';
    }

    const registrationForm = await saveRegistrationFormForConference(req.params.id, $set);

    let notifyResult = { affectedRegistrantCount: 0, emailsToNotify: [] };
    if (req.body.fields !== undefined && Array.isArray($set.fields)) {
      const { affected } = diffRegistrationFormFieldChanges(previousFields, $set.fields);
      if (affected.length > 0) {
        notifyResult = await syncPendingFieldsAfterFormUpdate(
          conferenceObjectId,
          previousFields,
          $set.fields
        );
        const slug = conference?.urlSlug || conference?.slug || String(conferenceObjectId);
        const labelByName = new Map($set.fields.map((f) => [f.name, f.label || f.name]));
        for (const email of notifyResult.emailsToNotify) {
          try {
            const reg = await Registration.findOne({ conferenceId: conferenceObjectId, email }).lean();
            const labels = (reg?.pendingRequiredFieldNames || [])
              .map((n) => labelByName.get(n) || n)
              .filter(Boolean);
            await sendRegistrationFieldsUpdateEmail(conference, email, labels, slug);
          } catch (mailErr) {
            console.error('❌ Failed to send registration fields update email:', mailErr);
          }
        }
        if (previousForm?._id) {
          await RegistrationForm.findByIdAndUpdate(previousForm._id, {
            $inc: { schemaVersion: 1 },
          });
        }
      }
    }

    res.json({
      ...registrationForm,
      pendingFieldsNotify: {
        affectedRegistrantCount: notifyResult.affectedRegistrantCount,
        newFieldsCount: diffRegistrationFormFieldChanges(previousFields, $set.fields || []).affected.length,
      },
    });
  } catch (err) {
    console.error("❌ Error saving registration form:", err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * DELETE /api/conferences/:conferenceId/registrants/:registrationId
 * Event organizer or super admin only — remove a registrant.
 */
router.delete('/conferences/:conferenceId/registrants/:registrationId', async (req, res) => {
  try {
    if (!getAuthUser(req)) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const { conferenceId, registrationId } = req.params;

    if (!(await canOrganizerOrAdminManageRegistrants(req, conferenceId))) {
      return res.status(403).json({
        success: false,
        message: 'Only the event organizer or an administrator can remove a registrant.',
      });
    }

    const registration = await Registration.findById(registrationId).select('conferenceId').lean();
    if (!registration) {
      return res.status(404).json({ success: false, message: 'Registration not found.' });
    }
    if (registration.conferenceId.toString() !== conferenceId.toString()) {
      return res.status(400).json({
        success: false,
        message: 'Registration does not belong to this event.',
      });
    }

    await Registration.deleteOne({ _id: registrationId });

    const conference = await Conference.findById(conferenceId).select('status createdBy').lean();
    if (conference) {
      const isIncompleteEvent = conference.status === 'draft' || conference.status === 'published';
      if (isIncompleteEvent && conference.createdBy) {
        PlanLimitsService.decreaseContactCount(conference.createdBy, 1)
          .then((ok) => {
            if (ok) {
              console.log(`✅ Decreased contact count for deleted registration from ${conference.status} event`);
            }
          })
          .catch((usageError) => {
            console.error('Error decreasing contact count after registration deletion:', usageError);
          });
      }
    }

    return res.json({ success: true, message: 'Registrant removed successfully.' });
  } catch (err) {
    console.error('Error removing registrant:', err);
    return res.status(500).json({
      success: false,
      message: 'Server error. Please try again later.',
    });
  }
});

module.exports = router;

