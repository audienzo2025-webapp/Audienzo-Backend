const RegistrationForm = require('../models/Registrationform');
const mongoose = require('mongoose');

function toConferenceObjectId(id) {
  if (!id || !mongoose.Types.ObjectId.isValid(String(id))) return null;
  return new mongoose.Types.ObjectId(String(id));
}

/** All registration form docs for a conference (ObjectId + legacy string conferenceId). */
async function findAllRegistrationFormsForConference(conferenceId) {
  const conferenceObjectId = toConferenceObjectId(conferenceId);
  if (!conferenceObjectId) return [];
  return RegistrationForm.find({
    $or: [
      { conferenceId: conferenceObjectId },
      { conferenceId: String(conferenceId) },
    ],
  }).lean();
}

function pickCanonicalRegistrationForm(docs) {
  if (!Array.isArray(docs) || docs.length === 0) return null;
  return [...docs].sort((a, b) => {
    const aLen = Array.isArray(a.fields) ? a.fields.length : 0;
    const bLen = Array.isArray(b.fields) ? b.fields.length : 0;
    if (bLen !== aLen) return bLen - aLen;
    const aUpdated = new Date(a.updatedAt || 0).getTime();
    const bUpdated = new Date(b.updatedAt || 0).getTime();
    if (bUpdated !== aUpdated) return bUpdated - aUpdated;
    return String(b._id).localeCompare(String(a._id));
  })[0];
}

/** Find the canonical registration form for a conference. */
async function findRegistrationFormForConference(conferenceId) {
  const docs = await findAllRegistrationFormsForConference(conferenceId);
  return pickCanonicalRegistrationForm(docs);
}

async function saveRegistrationFormForConference(conferenceId, patch) {
  const conferenceObjectId = toConferenceObjectId(conferenceId);
  if (!conferenceObjectId) {
    throw new Error('Invalid conference id');
  }

  const all = await findAllRegistrationFormsForConference(conferenceId);
  const existing = pickCanonicalRegistrationForm(all);
  const $set = { ...patch, conferenceId: conferenceObjectId };

  let saved;
  if (existing?._id) {
    saved = await RegistrationForm.findByIdAndUpdate(existing._id, { $set }, { new: true }).lean();
    const dupIds = all
      .filter((d) => String(d._id) !== String(existing._id))
      .map((d) => d._id);
    if (dupIds.length) {
      await RegistrationForm.deleteMany({ _id: { $in: dupIds } });
    }
  } else {
    saved = await RegistrationForm.findOneAndUpdate(
      { conferenceId: conferenceObjectId },
      { $set },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
  }

  return saved;
}

/** Merge duplicate registration form docs into one canonical record. */
async function consolidateRegistrationFormDuplicates(conferenceId) {
  const all = await findAllRegistrationFormsForConference(conferenceId);
  if (all.length <= 1) {
    return pickCanonicalRegistrationForm(all);
  }
  const canonical = pickCanonicalRegistrationForm(all);
  if (!canonical) return null;
  return saveRegistrationFormForConference(conferenceId, {
    fields: Array.isArray(canonical.fields) ? canonical.fields : [],
    displayEventName: canonical.displayEventName || '',
    posterUrl: canonical.posterUrl || '',
  });
}

module.exports = {
  toConferenceObjectId,
  findAllRegistrationFormsForConference,
  findRegistrationFormForConference,
  saveRegistrationFormForConference,
  consolidateRegistrationFormDuplicates,
};
