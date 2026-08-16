const {
  findRegistrationFormForConference,
  saveRegistrationFormForConference,
} = require('./registrationFormStore');

function isAlumniMeetEventType(eventType, customEventType) {
  const type = String(eventType || '').trim().toLowerCase();
  const custom = String(customEventType || '').trim().toLowerCase();
  const finalType = type === 'others' && custom ? custom : type;
  return finalType === 'alumni-meet';
}

/** Legacy auto-injected fields removed from alumni meet forms — not organizer-added fields. */
function isLegacyAlumniAutoField(field) {
  const id = String(field?.id || '').toLowerCase();
  return id === 'alumni_graduation_year' || id === 'alumni_branch';
}

function stripAlumniGraduationBranchFields(existingFields) {
  if (!Array.isArray(existingFields)) return [];
  return existingFields.filter((f) => !isLegacyAlumniAutoField(f));
}

async function stripAlumniGraduationBranchFromRegistrationForm(conferenceId) {
  const existing = await findRegistrationFormForConference(conferenceId);
  if (!existing) return;

  const currentFields = Array.isArray(existing.fields) ? existing.fields : [];
  const strippedFields = stripAlumniGraduationBranchFields(currentFields);

  if (strippedFields.length === currentFields.length) {
    return;
  }

  await saveRegistrationFormForConference(conferenceId, { fields: strippedFields });
}

module.exports = {
  isAlumniMeetEventType,
  stripAlumniGraduationBranchFields,
  stripAlumniGraduationBranchFromRegistrationForm,
};
