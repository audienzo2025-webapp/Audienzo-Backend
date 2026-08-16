const Registration = require('../models/Registration');

const PAYMENT_NOTIFICATION_MESSAGE = (eventTitle) =>
  `Complete payment details for "${eventTitle || 'your event'}".`;

function trimmed(value) {
  return (value == null ? '' : String(value)).trim();
}

/** Paid event: organizer requires transaction details on the registration form */
function conferenceRequiresRegistrationPaymentDetails(conference) {
  if (!conference || conference.paymentType !== 'paid') return false;
  return conference.requirePaymentDetails !== false;
}

/** Event uses manual QR/bank transfer proof flow */
function conferenceRequiresTransactionProof(conference) {
  if (!conferenceRequiresRegistrationPaymentDetails(conference)) return false;
  return !!trimmed(conference.qrCodeUrl);
}

/** Zero-amount / coupon waiver — no transaction proof required */
function isPaymentWaived(paymentInfo) {
  if (!paymentInfo || typeof paymentInfo !== 'object') return false;
  const amount = Number(paymentInfo.amount);
  const original = Number(paymentInfo.originalAmount);
  if (!Number.isNaN(amount) && amount === 0) return true;
  if (!Number.isNaN(original) && original === 0 && (Number.isNaN(amount) || amount === 0)) {
    return true;
  }
  return false;
}

function isOrganizerApprovedPayment(paymentInfo) {
  return !!(paymentInfo && paymentInfo.paymentApprovedAt);
}

/** When false, registrants are auto-completed after registration / payment details (no approve/reject step). */
function conferenceRequiresRegistrantApproval(conference) {
  return conference?.requireRegistrantApproval !== false;
}

/** True when registrant has submitted enough for coordinator review (transaction ID or waiver). */
function hasSubmittedPaymentDetails(paymentInfo, conference) {
  if (!paymentInfo || typeof paymentInfo !== 'object') return false;
  if (isPaymentWaived(paymentInfo)) return true;
  return !!trimmed(paymentInfo.transactionId);
}

/**
 * On paid events:
 * - missing payment details → pending (never completed)
 * - details submitted → pending until organizer approves (paymentApprovedAt)
 * - waived (zero amount) → completed without approval
 * @returns {boolean} whether paymentInfo was modified
 */
function normalizePaidEventPaymentState(registration, conference) {
  if (!conference || conference.paymentType !== 'paid' || !registration) return false;

  if (!registration.paymentInfo || typeof registration.paymentInfo !== 'object') {
    registration.paymentInfo = { paymentStatus: 'pending' };
    return true;
  }

  const pi = registration.paymentInfo;
  const status = trimmed(pi.paymentStatus).toLowerCase();
  let modified = false;

  if (!conferenceRequiresRegistrantApproval(conference)) {
    if (status === 'rejected') {
      pi.paymentApprovedAt = null;
      return modified;
    }
    const hasDetails = hasSubmittedPaymentDetails(pi, conference);
    if (isPaymentWaived(pi) || hasDetails) {
      if (status !== 'completed') {
        pi.paymentStatus = 'completed';
        modified = true;
      }
      if (!pi.paymentApprovedAt) {
        pi.paymentApprovedAt = new Date();
        modified = true;
      }
    } else if (status !== 'pending') {
      pi.paymentStatus = 'pending';
      pi.paymentApprovedAt = null;
      modified = true;
    }
    return modified;
  }

  if (isPaymentWaived(pi)) {
    if (status !== 'completed') {
      pi.paymentStatus = 'completed';
      modified = true;
    }
    return modified;
  }

  const hasDetails = hasSubmittedPaymentDetails(pi, conference);
  const organizerApproved = isOrganizerApprovedPayment(pi);

  if (status === 'rejected') {
    pi.paymentApprovedAt = null;
    return modified;
  }

  if (!hasDetails) {
    if (status === 'completed' || !status) {
      pi.paymentStatus = 'pending';
      pi.paymentApprovedAt = null;
      modified = true;
    }
    return modified;
  }

  // All required fields present — completed only after coordinator approval
  if (status === 'completed' && !organizerApproved) {
    pi.paymentStatus = 'pending';
    modified = true;
  }

  if (organizerApproved && status !== 'completed') {
    pi.paymentStatus = 'completed';
    modified = true;
  }

  return modified;
}

/**
 * Notify when paid event registrant has not submitted payment details yet.
 * Once details are submitted, status stays pending until organizer approves — no notification.
 */
function registrationNeedsPaymentCompletion(registration, conference) {
  if (!conference || conference.paymentType !== 'paid') return false;
  if (!conferenceRequiresRegistrationPaymentDetails(conference)) return false;
  if (!registration) return false;

  const pi = registration.paymentInfo;
  if (!pi || typeof pi !== 'object') return true;

  if (isPaymentWaived(pi)) return false;

  if (hasSubmittedPaymentDetails(pi, conference)) return false;

  return true;
}

async function reconcileRegistrationPayment(registration, conference, options = {}) {
  const { persist = true, setNotifiedAtOnNew = false } = options;
  if (!registration?._id) return false;

  const paymentNormalized = normalizePaidEventPaymentState(registration, conference);
  const needs = registrationNeedsPaymentCompletion(registration, conference);
  const prev = !!registration.needsPaymentCompletion;

  const update = { needsPaymentCompletion: needs };
  if (needs && !prev && setNotifiedAtOnNew) {
    update.paymentUpdateNotifiedAt = new Date();
  }
  if (!needs) {
    update.paymentUpdateNotifiedAt = null;
  }

  if (persist && (prev !== needs || update.paymentUpdateNotifiedAt || paymentNormalized)) {
    const setPayload = { ...update };
    if (paymentNormalized || registration.paymentInfo) {
      setPayload.paymentInfo = registration.paymentInfo;
    }
    await Registration.updateOne({ _id: registration._id }, { $set: setPayload });
    registration.needsPaymentCompletion = needs;
    if (update.paymentUpdateNotifiedAt) {
      registration.paymentUpdateNotifiedAt = update.paymentUpdateNotifiedAt;
    }
  } else if (!persist) {
    registration.needsPaymentCompletion = needs;
  }

  return needs;
}

/**
 * Flag registrants on a paid event who have not submitted payment details.
 * @returns {{ affectedRegistrantCount: number, emailsToNotify: string[] }}
 */
async function syncPendingPaymentAfterEventPaid(conferenceId, conference) {
  if (!conference || conference.paymentType !== 'paid') {
    return { affectedRegistrantCount: 0, emailsToNotify: [] };
  }

  const registrations = await Registration.find({ conferenceId });
  const emailsToNotify = [];
  let affectedRegistrantCount = 0;

  for (const reg of registrations) {
    const needs = await reconcileRegistrationPayment(reg, conference, {
      persist: true,
      setNotifiedAtOnNew: true,
    });

    if (needs) {
      affectedRegistrantCount++;
      emailsToNotify.push(reg.email);
    }
  }

  return {
    affectedRegistrantCount,
    emailsToNotify: [...new Set(emailsToNotify.map((e) => String(e).toLowerCase()))],
  };
}

async function syncRegistrationsAfterApprovalDisabled(conferenceId, conference) {
  if (!conferenceId || !conference || conferenceRequiresRegistrantApproval(conference)) {
    return { updatedCount: 0 };
  }

  const registrations = await Registration.find({ conferenceId });
  let updatedCount = 0;

  for (const reg of registrations) {
    if (conference.paymentType !== 'paid') {
      const regStatus = trimmed(reg.registrationStatus).toLowerCase();
      if (regStatus === 'pending') {
        await Registration.updateOne(
          { _id: reg._id },
          { $set: { registrationStatus: 'completed', registrationApprovedAt: new Date() } }
        );
        updatedCount++;
      }
      continue;
    }

    const changed = normalizePaidEventPaymentState(reg, conference);
    if (changed) {
      await Registration.updateOne(
        { _id: reg._id },
        { $set: { paymentInfo: reg.paymentInfo } }
      );
      updatedCount++;
    }
  }

  return { updatedCount };
}

module.exports = {
  PAYMENT_NOTIFICATION_MESSAGE,
  conferenceRequiresRegistrationPaymentDetails,
  conferenceRequiresTransactionProof,
  conferenceRequiresRegistrantApproval,
  isPaymentWaived,
  isOrganizerApprovedPayment,
  hasSubmittedPaymentDetails,
  normalizePaidEventPaymentState,
  registrationNeedsPaymentCompletion,
  reconcileRegistrationPayment,
  syncPendingPaymentAfterEventPaid,
  syncRegistrationsAfterApprovalDisabled,
};
