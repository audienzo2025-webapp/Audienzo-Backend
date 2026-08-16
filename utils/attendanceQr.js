const mongoose = require('mongoose');
const Registration = require('../models/Registration');

/** Compact QR payload — easier for cameras to decode than full formData JSON. */
function buildCompactAttendanceQrPayload(registration) {
  const email = (registration.email || '').trim();
  const payload = {
    email,
    conferenceId: registration.conferenceId.toString(),
  };
  if (registration._id) {
    payload.registrationId = String(registration._id);
  }
  return payload;
}

const COMPACT_QR_CODE_OPTIONS = {
  errorCorrectionLevel: 'M',
  margin: 2,
  width: 512,
};

async function generateCompactAttendanceQrDataUrl(registration) {
  const QRCode = require('qrcode');
  const payload = buildCompactAttendanceQrPayload(registration);
  return QRCode.toDataURL(JSON.stringify(payload), COMPACT_QR_CODE_OPTIONS);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolve registration from decoded QR JSON for a given event.
 * Supports registrationId (preferred) or email (case-insensitive).
 */
async function findRegistrationForQrCheckIn(conferenceId, parsedData) {
  if (!parsedData || typeof parsedData !== 'object') {
    return null;
  }

  const conferenceFilter = mongoose.Types.ObjectId.isValid(conferenceId)
    ? {
        $or: [
          { conferenceId: new mongoose.Types.ObjectId(conferenceId) },
          { conferenceId: String(conferenceId) },
        ],
      }
    : { conferenceId: String(conferenceId) };

  const qrConferenceId = (parsedData.conferenceId || '').toString().trim();
  if (qrConferenceId && qrConferenceId !== String(conferenceId)) {
    return null;
  }

  const registrationId = (parsedData.registrationId || '').toString().trim();
  if (registrationId && mongoose.Types.ObjectId.isValid(registrationId)) {
    const byId = await Registration.findOne({
      _id: registrationId,
      ...conferenceFilter,
    }).select('+formData');
    if (byId) {
      return byId;
    }
  }

  const email = (parsedData.email || '').trim();
  if (!email) {
    return null;
  }

  const byEmail = await Registration.findOne({
    ...conferenceFilter,
    email: { $regex: new RegExp(`^${escapeRegex(email)}$`, 'i') },
  }).select('+formData');

  return byEmail || null;
}

function getRegistrantDisplayNameFromForm(formData, email) {
  const form = formData && typeof formData === 'object' ? formData : {};
  if (form.name && String(form.name).trim()) {
    return String(form.name).trim();
  }
  const first = form.firstName || form.first_name || form.text_field || '';
  const last = form.lastName || form.last_name || form.text_field_1 || '';
  const combined = `${first} ${last}`.trim();
  if (combined) {
    return combined;
  }
  return (email || 'Participant').toString().trim();
}

module.exports = {
  buildCompactAttendanceQrPayload,
  generateCompactAttendanceQrDataUrl,
  COMPACT_QR_CODE_OPTIONS,
  findRegistrationForQrCheckIn,
  getRegistrantDisplayNameFromForm,
};
