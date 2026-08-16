const { findRegistrationFormForConference } = require('./registrationFormStore');
const {
  isAlumniMeetEventType,
  stripAlumniGraduationBranchFields,
} = require('./alumniMeetRegistrationFields');

function trimmed(value) {
  return (value == null ? '' : String(value)).trim();
}

function formatFieldValue(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) {
    return value
      .filter((v) => v != null && String(v).trim() !== '')
      .map((v) => String(v).trim())
      .join(', ');
  }
  return String(value).trim();
}

/** Same columns as coordinator registrants table (email + form fields, excluding file/password). */
function buildPublicColumns(formFields) {
  const columns = [{ key: 'email', label: 'Email' }];
  for (const field of formFields || []) {
    if (!field || !field.name || field.name === 'email') continue;
    if (field.type === 'file' || field.type === 'password') continue;
    columns.push({ key: field.name, label: field.label || field.name });
  }
  return columns;
}

function buildPublicRegistrantRow(registration, formFields) {
  const values = {
    email: trimmed(registration.email) || 'N/A',
  };
  for (const field of formFields || []) {
    if (!field || !field.name || field.name === 'email') continue;
    if (field.type === 'file' || field.type === 'password') continue;
    const formatted = formatFieldValue(registration.formData?.[field.name]);
    values[field.name] = formatted || 'N/A';
  }
  return {
    id: String(registration._id),
    values,
    registeredAt: registration.registeredAt || null,
  };
}

async function getFormFieldsForPublicList(conference) {
  const regForm = await findRegistrationFormForConference(conference._id);
  let formFields = regForm && Array.isArray(regForm.fields) ? regForm.fields : [];
  if (isAlumniMeetEventType(conference.eventType, conference.customEventType)) {
    formFields = stripAlumniGraduationBranchFields(formFields);
  }
  return formFields;
}

/** All registrants — same data shape as the coordinator table (no approval filter). */
function buildPublicRegistrantListResponse(conference, registrations, formFields) {
  const columns = buildPublicColumns(formFields);
  const registrants = (registrations || []).map((reg) =>
    buildPublicRegistrantRow(reg, formFields)
  );

  registrants.sort((a, b) => {
    const ta = a.registeredAt ? new Date(a.registeredAt).getTime() : 0;
    const tb = b.registeredAt ? new Date(b.registeredAt).getTime() : 0;
    return ta - tb;
  });

  return { columns, registrants, total: registrants.length };
}

module.exports = {
  getFormFieldsForPublicList,
  buildPublicRegistrantListResponse,
};
