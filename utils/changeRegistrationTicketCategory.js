const { resolveRegistrationTicketsAndPayment } = require('./resolveRegistrationTicketsAndPayment');

function trimmed(value) {
  return (value == null ? '' : String(value)).trim();
}

function normalizeOrganizerPaymentStatus(raw) {
  const s = trimmed(raw).toLowerCase();
  if (s === 'pending' || s === 'wait' || s === 'unpaid') return 'pending';
  if (s === 'completed' || s === 'approve' || s === 'approved' || s === 'paid') return 'completed';
  return 'completed';
}

/** Same rules as registrationRoutes.buildAttendeeDetailsForManualRow */
function buildAttendeeDetailsForManualRow(conference, categoryIndex, quantity, displayName, attendeeExtra) {
  const organizerAttendeeFields = Array.isArray(conference.attendeeFields) ? conference.attendeeFields : [];
  const fieldsForCategory = organizerAttendeeFields.filter((f) => {
    const appliesTo = Number(f?.appliesToCategoryIndex);
    return appliesTo === -1 || appliesTo === categoryIndex;
  });
  const rowAtt = attendeeExtra && typeof attendeeExtra === 'object' ? attendeeExtra : {};
  const attendees = [];
  for (let ai = 0; ai < quantity; ai += 1) {
    const one = {};
    for (const f of fieldsForCategory) {
      const key = f?.name;
      if (!key) continue;
      let val = rowAtt[key];
      if (val == null || (typeof val === 'string' && !val.trim())) {
        if (f.required) {
          val = displayName;
        }
      }
      const t = typeof val === 'string' ? val.trim() : val;
      if (f.required && (t === undefined || t === null || t === '')) {
        throw new Error(`Attendee field "${f.label || key}" is required (category ${categoryIndex + 1}).`);
      }
      one[key] = t;
    }
    attendees.push(one);
  }
  return [{ categoryIndex, attendees }];
}

function getPrimaryCategoryIndex(registration) {
  const br = registration.feeCategoryBreakdown;
  if (Array.isArray(br) && br.length === 1 && br[0]?.categoryIndex != null) {
    return Number(br[0].categoryIndex);
  }
  const ad = registration.attendeeDetails;
  if (Array.isArray(ad) && ad.length === 1 && ad[0]?.categoryIndex != null) {
    return Number(ad[0].categoryIndex);
  }
  return null;
}

function extractAttendeeExtraFromRegistration(registration) {
  const blocks = registration.attendeeDetails || [];
  if (!Array.isArray(blocks) || blocks.length === 0) return {};
  const firstBlock = blocks[0];
  const firstAtt = firstBlock?.attendees?.[0];
  return firstAtt && typeof firstAtt === 'object' ? { ...firstAtt } : {};
}

function getQuantityFromBreakdown(registration) {
  const br = registration.feeCategoryBreakdown;
  if (!Array.isArray(br) || br.length === 0) return 1;
  if (br.length > 1) return null;
  const q = parseInt(br[0]?.quantity, 10);
  if (isNaN(q) || q < 1) return 1;
  return q;
}

/**
 * Recompute ticket breakdown / attendee details / payment for a new single category.
 * @param {object} conference — Mongoose doc or lean
 * @param {import('mongoose').Document} registration
 * @param {number} newCategoryIndex
 * @returns {Promise<{ ok: boolean, message?: string, numberOfTickets?: number, feeCategoryBreakdown?: any[], attendeeDetails?: any[], paymentInfo?: object }>}
 */
async function changeRegistrationTicketCategory(conference, registration, newCategoryIndex) {
  const isPaid = conference.paymentType === 'paid';
  const cats = Array.isArray(conference.feeCategories) ? conference.feeCategories : [];
  if (!isPaid || cats.length === 0) {
    return { ok: false, message: 'This event does not use ticket categories.' };
  }

  const idx = parseInt(newCategoryIndex, 10);
  if (isNaN(idx) || idx < 0 || idx >= cats.length) {
    return { ok: false, message: 'Invalid ticket category.' };
  }

  const br = registration.feeCategoryBreakdown;
  if (Array.isArray(br) && br.length > 1) {
    return {
      ok: false,
      message:
        'Changing category is only supported when the registration has a single ticket category. Remove and re-add for multi-category registrations.'
    };
  }

  const adBlocks = registration.attendeeDetails;
  if (Array.isArray(adBlocks) && adBlocks.length > 1) {
    return {
      ok: false,
      message:
        'Changing category is only supported when the registration has a single ticket category. Remove and re-add for multi-category registrations.'
    };
  }

  const qty = getQuantityFromBreakdown(registration);
  if (qty == null) {
    return { ok: false, message: 'Could not read ticket quantity for this registration.' };
  }

  const current = getPrimaryCategoryIndex(registration);
  if (current === idx) {
    return { ok: true, noop: true };
  }

  const formData = registration.formData && typeof registration.formData === 'object' ? registration.formData : {};
  const displayName = trimmed(formData.name) || trimmed(registration.email) || 'Participant';
  const conferenceId = registration.conferenceId.toString();
  const email = (registration.email || '').trim().toLowerCase();

  let attendeeDetailsJson;
  try {
    attendeeDetailsJson = JSON.stringify(
      buildAttendeeDetailsForManualRow(conference, idx, qty, displayName, extractAttendeeExtraFromRegistration(registration))
    );
  } catch (e) {
    return { ok: false, message: e.message || 'Could not build attendee details for the new category.' };
  }

  const cat = cats[idx];
  const unitAmount = Number(cat.amount) || 0;
  const feeCategoryBreakdownJson = JSON.stringify([
    {
      categoryIndex: idx,
      quantity: qty,
      categoryName: cat.name || '',
      unitAmount,
      subtotal: unitAmount * qty
    }
  ]);

  const oldPi = registration.paymentInfo && typeof registration.paymentInfo === 'object' ? registration.paymentInfo : {};
  const organizerPaymentStatus = normalizeOrganizerPaymentStatus(oldPi.paymentStatus);

  const flatBody = {
    email,
    paymentNotes: oldPi.notes || '',
    numberOfTickets: qty,
    feeCategoryBreakdown: feeCategoryBreakdownJson,
    attendeeDetails: attendeeDetailsJson,
    couponCode: oldPi.couponCode || ''
  };

  const ticketResult = await resolveRegistrationTicketsAndPayment(
    conference,
    conferenceId,
    email,
    flatBody,
    [],
    { organizerSkipPaymentProof: true, organizerPaymentStatus }
  );

  if (!ticketResult.ok) {
    return { ok: false, message: ticketResult.message || 'Could not apply ticket category.' };
  }

  const newPi = ticketResult.paymentInfo && typeof ticketResult.paymentInfo === 'object' ? ticketResult.paymentInfo : {};
  const mergedPaymentInfo = {
    ...newPi,
    paymentStatus: oldPi.paymentStatus || newPi.paymentStatus,
    transactionProofUrl: oldPi.transactionProofUrl,
    transactionId: oldPi.transactionId,
    transactionDate: oldPi.transactionDate,
    paymentMethod: oldPi.paymentMethod || newPi.paymentMethod
  };

  return {
    ok: true,
    numberOfTickets: ticketResult.numberOfTickets,
    feeCategoryBreakdown: ticketResult.feeCategoryBreakdown,
    attendeeDetails: ticketResult.attendeeDetails,
    paymentInfo: mergedPaymentInfo
  };
}

module.exports = {
  changeRegistrationTicketCategory
};
