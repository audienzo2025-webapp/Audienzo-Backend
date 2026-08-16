const Registration = require('../models/Registration');

function isFieldValuePresent(formData, field) {
  if (!field?.name) return true;
  const v = formData?.[field.name];
  if (v == null || v === '') return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

/** Fields newly added or made required since the previous form version. */
function diffRegistrationFormFieldChanges(previousFields, nextFields) {
  const prev = Array.isArray(previousFields) ? previousFields : [];
  const next = Array.isArray(nextFields) ? nextFields : [];
  const prevByName = new Map(prev.filter((f) => f?.name).map((f) => [f.name, f]));
  const added = [];
  const newlyRequired = [];

  for (const field of next) {
    if (!field?.name) continue;
    const old = prevByName.get(field.name);
    if (!old) {
      added.push(field);
    } else if (field.required && !old.required) {
      newlyRequired.push(field);
    }
  }
  return { added, newlyRequired, affected: [...added, ...newlyRequired] };
}

function computePendingNamesForRegistration(formData, affectedFields) {
  const pending = [];
  for (const field of affectedFields) {
    if (!isFieldValuePresent(formData, field)) {
      pending.push(field.name);
    }
  }
  return pending;
}

function mergePendingFieldNames(existingPending, newPending, formData, allFields) {
  const byName = new Map((allFields || []).filter((f) => f?.name).map((f) => [f.name, f]));
  const set = new Set(Array.isArray(existingPending) ? existingPending : []);
  for (const name of newPending || []) {
    const field = byName.get(name);
    if (field && !isFieldValuePresent(formData, field)) {
      set.add(name);
    }
  }
  for (const name of [...set]) {
    const field = byName.get(name);
    if (!field || isFieldValuePresent(formData, field)) {
      set.delete(name);
    }
  }
  return [...set];
}

function computeAllMissingRequiredFieldNames(formData, formFields) {
  const pending = [];
  for (const field of formFields || []) {
    if (!field?.name || !field.required) continue;
    if (!isFieldValuePresent(formData, field)) {
      pending.push(field.name);
    }
  }
  return pending;
}

/**
 * Align pendingRequiredFieldNames with the live form vs stored answers.
 * Catches missing values after DB edits, form updates, or partial saves.
 * @returns {Promise<string[]>}
 */
async function reconcileRegistrationPendingFields(registration, formFields, options = {}) {
  const { persist = true, setNotifiedAtOnNew = false } = options;
  if (!registration?._id) return [];

  const missing = computeAllMissingRequiredFieldNames(registration.formData || {}, formFields);
  const prev = Array.isArray(registration.pendingRequiredFieldNames)
    ? registration.pendingRequiredFieldNames
    : [];
  const prevSet = new Set(prev);
  const changed =
    missing.length !== prev.length ||
    missing.some((n) => !prevSet.has(n)) ||
    prev.some((n) => !missing.includes(n));

  if (!changed) return missing;

  const update = { pendingRequiredFieldNames: missing };
  if (setNotifiedAtOnNew && missing.length > 0 && missing.some((n) => !prevSet.has(n))) {
    update.formFieldsUpdateNotifiedAt = new Date();
  }

  if (persist) {
    await Registration.updateOne({ _id: registration._id }, { $set: update });
    registration.pendingRequiredFieldNames = missing;
    if (update.formFieldsUpdateNotifiedAt) {
      registration.formFieldsUpdateNotifiedAt = update.formFieldsUpdateNotifiedAt;
    }
  }

  return missing;
}

/**
 * After registration form fields change, mark existing registrants who must complete new fields.
 * @returns {{ affectedRegistrantCount: number, emailsToNotify: string[] }}
 */
async function syncPendingFieldsAfterFormUpdate(conferenceId, previousFields, nextFields) {
  const { affected } = diffRegistrationFormFieldChanges(previousFields, nextFields);
  if (!affected.length) {
    return { affectedRegistrantCount: 0, emailsToNotify: [] };
  }

  const affectedNames = new Set(affected.map((f) => f.name).filter(Boolean));
  const registrations = await Registration.find({ conferenceId });
  const emailsToNotify = [];
  let affectedRegistrantCount = 0;

  for (const reg of registrations) {
    const newPending = computeAllMissingRequiredFieldNames(reg.formData, nextFields);
    const missingAffected = newPending.filter((n) => affectedNames.has(n));
    const prevJson = JSON.stringify(reg.pendingRequiredFieldNames || []);
    const nextJson = JSON.stringify(newPending);

    if (prevJson !== nextJson) {
      reg.pendingRequiredFieldNames = newPending;
      if (missingAffected.length > 0) {
        reg.formFieldsUpdateNotifiedAt = new Date();
      }
      await reg.save();
    }

    if (missingAffected.length > 0) {
      affectedRegistrantCount++;
      emailsToNotify.push(reg.email);
    }
  }

  return {
    affectedRegistrantCount,
    emailsToNotify: [...new Set(emailsToNotify.map((e) => String(e).toLowerCase()))],
  };
}

module.exports = {
  isFieldValuePresent,
  diffRegistrationFormFieldChanges,
  computePendingNamesForRegistration,
  computeAllMissingRequiredFieldNames,
  mergePendingFieldNames,
  reconcileRegistrationPendingFields,
  syncPendingFieldsAfterFormUpdate,
};
