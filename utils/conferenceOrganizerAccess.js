const User = require('../models/User');
const Conference = require('../models/Conference');
const { getAuthUser } = require('./authUser');
const {
  conferenceRequiresRegistrantApproval,
  isPaymentWaived,
} = require('./registrationPaymentReconcile');

/** Super admin (platform admin) */
async function isAdminUser(req) {
  if (!getAuthUser(req)) return false;
  const user = await User.findById(getAuthUser(req)._id).select('role isAdmin').lean();
  return user && (user.role === 'admin' || user.isAdmin === true);
}

/** Normalize payment status for paid-event confirmation / QR eligibility */
function isRegistrationPaymentCompleted(conference, registration) {
  if (!conference) return true;
  if (conference.paymentType === 'paid') {
    const status = (registration?.paymentInfo?.paymentStatus || '')
      .toString()
      .trim()
      .toLowerCase();
    return status === 'completed' || status === 'approved' || status === 'paid';
  }
  const regStatus = (registration?.registrationStatus || 'completed')
    .toString()
    .trim()
    .toLowerCase();
  return regStatus === 'completed';
}

/** In-person attendance QR email — paid events, free events, and waived/zero-amount tickets. */
function isEligibleForAttendanceQrEmail(conference, registration) {
  const email = (registration?.email || '').trim();
  if (!email || !conference) {
    return false;
  }

  const regStatus = (registration?.registrationStatus || '')
    .toString()
    .trim()
    .toLowerCase();
  const payStatus = (registration?.paymentInfo?.paymentStatus || '')
    .toString()
    .trim()
    .toLowerCase();

  if (regStatus === 'rejected' || payStatus === 'rejected') {
    return false;
  }

  if (!conferenceRequiresRegistrantApproval(conference)) {
    return true;
  }

  if (conference.paymentType === 'paid') {
    if (isPaymentWaived(registration.paymentInfo)) {
      return true;
    }
    return payStatus === 'completed' || payStatus === 'approved' || payStatus === 'paid';
  }

  return regStatus === 'completed' || regStatus === '';
}

function isInPersonConference(conference) {
  if (!conference) return false;
  const v = conference.isVirtual;
  return !(v === true || v === 'true' || v === 1 || v === '1');
}

/**
 * Event owner, collaborator, or super admin — for viewing registrants and downloading QR codes.
 */
async function canViewOrDownloadConferenceRegistrants(req, conferenceId) {
  if (!getAuthUser(req)) return false;
  if (await isAdminUser(req)) return true;
  const conference = await Conference.findById(conferenceId).select('createdBy collaborators').lean();
  if (!conference) return false;
  const userId = getAuthUser(req)._id.toString();
  if (conference.createdBy && conference.createdBy.toString() === userId) return true;
  if (Array.isArray(conference.collaborators) && conference.collaborators.some((c) => c && c.toString() === userId)) {
    return true;
  }
  return false;
}

/**
 * Event owner or super admin only — not collaborators.
 * Use for mutating registrant records (edit, payment approve, resend, delete).
 */
async function canOrganizerOrAdminManageRegistrants(req, conferenceId) {
  if (!getAuthUser(req)) return false;
  if (await isAdminUser(req)) return true;
  const conference = await Conference.findById(conferenceId).select('createdBy').lean();
  if (!conference) return false;
  const userId = getAuthUser(req)._id.toString();
  return !!(conference.createdBy && conference.createdBy.toString() === userId);
}

/**
 * Event owner, collaborator, or super admin — for editing conference settings and registration forms.
 */
async function canModifyConference(req, conferenceId) {
  if (!getAuthUser(req)) return false;
  if (await isAdminUser(req)) return true;
  const conference = await Conference.findById(conferenceId).select('createdBy collaborators').lean();
  if (!conference) return false;
  const userId = String(getAuthUser(req)._id);
  if (conference.createdBy && String(conference.createdBy) === userId) return true;
  if (Array.isArray(conference.collaborators) && conference.collaborators.some((c) => c && String(c) === userId)) {
    return true;
  }
  return false;
}

/** Published events with public visibility may be read without coordinator auth. */
function isConferencePubliclyViewable(conference) {
  if (!conference) return false;
  const status = (conference.status || '').toString().trim().toLowerCase();
  const isPublic = (conference.isPublic || 'yes').toString().trim().toLowerCase();
  return status === 'published' && isPublic === 'yes';
}

module.exports = {
  isAdminUser,
  isRegistrationPaymentCompleted,
  isEligibleForAttendanceQrEmail,
  isInPersonConference,
  isConferencePubliclyViewable,
  canViewOrDownloadConferenceRegistrants,
  canOrganizerOrAdminManageRegistrants,
  canModifyConference,
};
