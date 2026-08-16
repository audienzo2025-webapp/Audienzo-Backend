require('dotenv').config();
const express = require('express');
const router = express.Router();
const Registration = require('../models/Registration');
const Conference = require('../models/Conference');
const cloudinary = require('cloudinary').v2;
const QRCode = require('qrcode');
const { uploadLocal } = require('../config/cloudinary');
const RegistrationForm = require('../models/Registrationform');
const {
  findRegistrationFormForConference,
} = require('../utils/registrationFormStore');
const { sendRegistrationConfirmationEmail } = require('../services/sendRegistrationConfirmationEmail');
const { validateContactLimits } = require('../middleware/planLimitsMiddleware');
const PlanLimitsService = require('../services/planLimitsService');
const UsageAlertService = require('../services/usageAlertService');
const CouponCode = require('../models/CouponCode');
const couponHelpers = require('./couponRoutes');
const {
  isAlumniMeetEventType,
  stripAlumniGraduationBranchFields,
} = require('../utils/alumniMeetRegistrationFields');
const {
  isFieldValuePresent,
  mergePendingFieldNames,
  computeAllMissingRequiredFieldNames,
  reconcileRegistrationPendingFields,
} = require('../utils/registrationFormDiff');
const {
  registrationNeedsPaymentCompletion,
  reconcileRegistrationPayment,
  conferenceRequiresRegistrationPaymentDetails,
  conferenceRequiresTransactionProof,
  conferenceRequiresRegistrantApproval,
  hasSubmittedPaymentDetails,
  isPaymentWaived,
  PAYMENT_NOTIFICATION_MESSAGE,
} = require('../utils/registrationPaymentReconcile');
const { resolveRegistrationTicketsAndPayment } = require('../utils/resolveRegistrationTicketsAndPayment');
const { isRegistrationDeadlinePassed } = require('../utils/eventDateUtils');
const EmailVerificationProof = require('../models/EmailVerificationProof');
const { hashVerificationToken } = require('../utils/emailVerificationCrypto');
const User = require('../models/User');
const { getAuthUser } = require('../utils/authUser');
const { canOrganizerOrAdminManageRegistrants } = require('../utils/conferenceOrganizerAccess');
const { generateCompactAttendanceQrDataUrl } = require('../utils/attendanceQr');

function trimmed(value) {
    return (value == null ? '' : String(value)).trim();
}

function getRegistrationEmailFromBody(body, formFields) {
    for (const field of formFields || []) {
        if (field.type === 'email' || (field.name && String(field.name).toLowerCase() === 'email')) {
            const raw = body[field.name];
            const val = Array.isArray(raw) ? raw[0] : raw;
            if (val != null && String(val).trim()) {
                return trimmed(String(val)).toLowerCase();
            }
        }
    }
    const fb = body.email;
    if (fb != null && String(fb).trim()) {
        return trimmed(String(fb)).toLowerCase();
    }
    return '';
}

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isValidObjectId(value) {
    return /^[a-f\d]{24}$/i.test(trimmed(value));
}

function registrantOwnsRegistration(registration, authed, verificationEmail) {
    if (!registration) return false;
    if (authed && authed._id && registration.userId) {
        if (String(registration.userId) === String(authed._id)) return true;
    }
    const regEmail = trimmed(registration.email).toLowerCase();
    const authEmail = authed && authed.email ? trimmed(authed.email).toLowerCase() : '';
    const verifyEmail = verificationEmail ? trimmed(verificationEmail).toLowerCase() : '';
    if (authEmail && regEmail === authEmail) return true;
    if (verifyEmail && regEmail === verifyEmail) return true;
    return false;
}

async function findRegistrationForConferenceEmail(conferenceId, email) {
    const normalized = trimmed(email).toLowerCase();
    if (!normalized) return null;
    let registration = await Registration.findOne({ conferenceId, email: normalized });
    if (!registration && trimmed(email) !== normalized) {
        registration = await Registration.findOne({ conferenceId, email: trimmed(email) });
    }
    if (!registration) {
        registration = await Registration.findOne({
            conferenceId,
            email: { $regex: new RegExp(`^${escapeRegex(normalized)}$`, 'i') },
        });
    }
    return registration;
}

/** Find a registrant's row the same way My Registrations does (userId, registrationId, or email). */
async function findRegistrationForRegistrant(conferenceId, req, verification) {
    const authed = getAuthUser(req);
    const registrationId = trimmed(req.body?.registrationId || req.query?.registrationId || '');

    if (registrationId && isValidObjectId(registrationId)) {
        const byId = await Registration.findOne({ _id: registrationId, conferenceId });
        if (byId) {
            if (registrantOwnsRegistration(byId, authed, verification?.email)) {
                return byId;
            }
            return null;
        }
    }

    if (authed && authed._id) {
        const byUserId = await Registration.findOne({ conferenceId, userId: authed._id });
        if (byUserId) return byUserId;
    }

    if (verification && verification.email) {
        return findRegistrationForConferenceEmail(conferenceId, verification.email);
    }

    return null;
}

async function resolveConferenceRegistrantVerification(req, formFields, conference) {
    const formEmail = getRegistrationEmailFromBody(req.body, formFields);

    if (conference && conference.skipEmailOtp) {
        if (!formEmail) {
            return { ok: false, message: 'Email is required.' };
        }
        return { ok: true, email: formEmail, proofId: null };
    }

    const authed = getAuthUser(req);
    if (authed && authed.email) {
        const userEmail = trimmed(authed.email).toLowerCase();
        if (formEmail && formEmail !== userEmail) {
            return { ok: false, message: 'Email must match your logged-in account.' };
        }
        const email = userEmail || formEmail;
        if (!email) {
            return { ok: false, message: 'Email is required.' };
        }
        return { ok: true, email, proofId: null };
    }

    if (req.session && req.session.verified && req.session.email) {
        const sessionEmail = trimmed(req.session.email).toLowerCase();
        if (formEmail && formEmail !== sessionEmail) {
            return { ok: false, message: 'Email must match the address you verified with OTP.' };
        }
        const email = sessionEmail || formEmail;
        if (!email) {
            return { ok: false, message: 'Email not verified. Please verify OTP first.' };
        }
        return { ok: true, email, proofId: null };
    }

    const token = trimmed(req.body.emailVerificationToken || '');
    if (!token) {
        return { ok: false, message: 'Email not verified. Please verify OTP first.' };
    }
    const tokenHash = hashVerificationToken(token);
    const proof = await EmailVerificationProof.findOne({
        tokenHash,
        purpose: 'conference',
        consumed: false,
        expiresAt: { $gt: new Date() },
    }).lean();

    if (!proof) {
        return { ok: false, message: 'Email verification expired. Please verify your email again.' };
    }
    const proofEmail = (proof.email || '').toLowerCase();
    if (!formEmail || formEmail !== proofEmail) {
        return { ok: false, message: 'Email must match the address you verified with OTP.' };
    }
    return { ok: true, email: proofEmail, proofId: proof._id };
}

function hasAnyExternalPaymentLink(conference) {
    if (!conference) return false;
    if (trimmed(conference.paymentLink)) return true;
    const cats = Array.isArray(conference.feeCategories) ? conference.feeCategories : [];
    return cats.some(c => trimmed(c?.paymentLink));
}

async function userCanManageConference(req, conferenceId) {
    const authed = getAuthUser(req);
    if (!authed) return false;
    const user = await User.findById(authed._id).select('role isAdmin').lean();
    if (user && (user.role === 'admin' || user.isAdmin === true)) return true;
    const conference = await Conference.findById(conferenceId).select('createdBy collaborators').lean();
    if (!conference) return false;
    const userId = authed._id.toString();
    if (conference.createdBy && conference.createdBy.toString() === userId) return true;
    if (conference.collaborators && conference.collaborators.some(c => c && c.toString() === userId)) return true;
    return false;
}

async function sendRegistrationConfirmationIfReady(conference, email, savedFormData, qrCodeUrl, shouldSend) {
    if (!shouldSend) return;
    try {
        await sendRegistrationConfirmationEmail(conference, email, savedFormData, qrCodeUrl);
    } catch (emailErr) {
        console.error('❌ Email sending failed:', emailErr);
    }
}

async function assertOrganizerBatchContactHeadroom(creatorId, registrationEmails) {
    const planCheck = await PlanLimitsService.canAddContact(creatorId);
    if (!planCheck.allowed) {
        return { ok: false, message: planCheck.reason || 'Contact limit reached.' };
    }
    const limit = planCheck.limit;
    const current = planCheck.currentCount;
    if (!limit || limit <= 0) {
        return { ok: true };
    }
    const userConferences = await Conference.find({ createdBy: creatorId }).distinct('_id');
    const existingEmails = await Registration.distinct('email', { conferenceId: { $in: userConferences } });
    const set = new Set(existingEmails.map(e => String(e).toLowerCase()));
    let netNew = 0;
    for (const em of registrationEmails) {
        const k = String(em).toLowerCase();
        if (!set.has(k)) {
            netNew++;
            set.add(k);
        }
    }
    if (current + netNew > limit) {
        return {
            ok: false,
            message: `Adding ${netNew} new contact(s) would exceed your contact limit (${current}/${limit}). Reduce the list or upgrade your plan.`
        };
    }
    return { ok: true };
}

function resolveFormFieldKeyByHints(formFields, hints) {
    const fields = Array.isArray(formFields) ? formFields : [];
    for (const h of hints) {
        const found = fields.find(f => f.name && String(f.name).toLowerCase() === h);
        if (found) return found.name;
    }
    for (const h of hints) {
        const found = fields.find(f => (f.label || '').trim().toLowerCase() === h);
        if (found) return found.name;
    }
    return null;
}

function resolveFirstNameFieldKey(formFields) {
    return resolveFormFieldKeyByHints(formFields, [
        'first_name',
        'firstname',
        'fname',
        'given_name',
        'givenname',
        'first name',
        'given name'
    ]);
}

function resolveLastNameFieldKey(formFields) {
    return resolveFormFieldKeyByHints(formFields, [
        'last_name',
        'lastname',
        'lname',
        'surname',
        'family_name',
        'familyname',
        'last name',
        'family name'
    ]);
}

function normalizeOrganizerPaymentStatus(raw) {
    const s = trimmed(raw).toLowerCase();
    if (s === 'pending' || s === 'wait' || s === 'unpaid') return 'pending';
    if (s === 'completed' || s === 'approve' || s === 'approved' || s === 'paid') return 'completed';
    return 'completed';
}

function buildAttendeeDetailsForManualRow(conference, categoryIndex, quantity, displayName, attendeeExtra) {
    const organizerAttendeeFields = Array.isArray(conference.attendeeFields) ? conference.attendeeFields : [];
    const fieldsForCategory = organizerAttendeeFields.filter(f => {
        const appliesTo = Number(f?.appliesToCategoryIndex);
        return appliesTo === -1 || appliesTo === categoryIndex;
    });
    const rowAtt = attendeeExtra && typeof attendeeExtra === 'object' ? attendeeExtra : {};
    const attendees = [];
    for (let ai = 0; ai < quantity; ai++) {
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

async function persistOrganizerManualRegistration({
    conference,
    conferenceId,
    email,
    savedFormData,
    flatBody,
    isPaidEvent,
    organizerPaymentStatus
}) {
    const ticketResult = await resolveRegistrationTicketsAndPayment(
        conference,
        conferenceId,
        email,
        flatBody,
        [],
        { organizerSkipPaymentProof: true, organizerPaymentStatus }
    );
    if (!ticketResult.ok) {
        return { ok: false, message: ticketResult.message };
    }
    const { numberOfTickets, feeCategoryBreakdown, attendeeDetails, paymentInfo } = ticketResult;

    let qrCodeUrl = '';
    const freeRegConfirmed = !isPaidEvent && (
        !conferenceRequiresRegistrantApproval(conference) || organizerPaymentStatus !== 'pending'
    );
    const shouldGenerateAttendeeQr =
        !conference.isVirtual &&
        (freeRegConfirmed || (isPaidEvent && paymentInfo && paymentInfo.paymentStatus === 'completed'));

    if (shouldGenerateAttendeeQr) {
        const qrCodeDataUrl = await generateCompactAttendanceQrDataUrl({
            email,
            conferenceId: conferenceId.toString(),
        });
        try {
            const uploadResult = await cloudinary.uploader.upload(qrCodeDataUrl, {
                folder: 'conference_qr_codes',
                public_id: `QR_${conferenceId}_${Date.now()}`
            });
            qrCodeUrl = uploadResult.secure_url;
        } catch (uploadErr) {
            console.error('Cloudinary upload failed:', uploadErr);
            return { ok: false, message: 'QR code upload failed.' };
        }
    }

    const registrationData = {
        conferenceId,
        email,
        formData: savedFormData,
        numberOfTickets,
        attendeeDetails,
        registeredAt: new Date()
    };

    if (!conference.isVirtual && qrCodeUrl) {
        registrationData.qrCodeUrl = qrCodeUrl;
    }
    if (paymentInfo) {
        registrationData.paymentInfo = paymentInfo;
    }
    if (feeCategoryBreakdown.length > 0) {
        registrationData.feeCategoryBreakdown = feeCategoryBreakdown;
    }
    if (!isPaidEvent) {
        registrationData.registrationStatus = conferenceRequiresRegistrantApproval(conference)
            ? (organizerPaymentStatus === 'pending' ? 'pending' : 'completed')
            : 'completed';
        if (registrationData.registrationStatus === 'completed') {
            registrationData.registrationApprovedAt = new Date();
        }
    }

    const newRegistration = new Registration(registrationData);
    await newRegistration.save();

    try {
        const conferenceCreator = await User.findById(conference.createdBy);
        if (conferenceCreator) {
            await PlanLimitsService.updateContactCount(conferenceCreator._id, 1);
            if (conferenceCreator.usageStats) {
                const currentCount = conferenceCreator.usageStats.contacts || 0;
                const planLimits = PlanLimitsService.getPlanLimits(conferenceCreator.selectedPlan || 'free');
                const limit = planLimits.contacts;
                if (limit > 0) {
                    await UsageAlertService.checkContactLimits(conferenceCreator._id, currentCount, limit);
                }
            }
        }
    } catch (alertError) {
        console.error('Error updating usage stats after manual registration:', alertError);
    }

    const shouldSendConfirmationEmail =
        (isPaidEvent && paymentInfo && paymentInfo.paymentStatus === 'completed') ||
        (!isPaidEvent && registrationData.registrationStatus === 'completed');
    await sendRegistrationConfirmationIfReady(conference, email, savedFormData, qrCodeUrl, shouldSendConfirmationEmail);

    return { ok: true, registrationId: newRegistration._id };
}

function isSplitNameFormField(field) {
    const n = String(field?.name || '').toLowerCase().replace(/-/g, '_');
    const lbl = String(field?.label || '').trim().toLowerCase();
    const keys = new Set([
        'first_name', 'last_name', 'firstname', 'lastname', 'fname', 'lname',
        'given_name', 'surname', 'givenname', 'family_name', 'familyname'
    ]);
    if (keys.has(n)) return true;
    if (/\bfirst\s+name\b/.test(lbl) || /\blast\s+name\b/.test(lbl)) return true;
    if (lbl === 'given name' || lbl === 'surname' || lbl === 'family name') return true;
    return false;
}

function buildSavedFormDataForBatchRow(formFields, email, displayName, extra, organizerFirstName, organizerLastName) {
    const saved = {};
    const ex = extra && typeof extra === 'object' ? extra : {};
    const nameKey = resolveFormFieldKeyByHints(formFields, ['name', 'full_name', 'fullname', 'full name']) || 'name';
    const emailKeyHint = resolveFormFieldKeyByHints(formFields, ['email', 'e_mail']);

    formFields.forEach(field => {
        if (field.type === 'file') return;
        if (isSplitNameFormField(field)) return;
        const v = ex[field.name];
        if (v !== undefined && v !== null && v !== '') {
            saved[field.name] = v;
        }
    });

    formFields.forEach(field => {
        if (field.type === 'email' || (field.name && String(field.name).toLowerCase() === 'email')) {
            saved[field.name] = email;
        }
    });
    if (emailKeyHint) {
        saved[emailKeyHint] = email;
    }
    saved[nameKey] = displayName;
    saved.name = displayName;

    const stripSplitNameKeys = [
        'first_name', 'last_name', 'firstname', 'lastname', 'fname', 'lname',
        'given_name', 'surname', 'givenname', 'family_name', 'familyname'
    ];
    const stripSet = new Set(stripSplitNameKeys);
    for (const k of Object.keys(saved)) {
        const nk = String(k).toLowerCase().replace(/-/g, '_');
        if (stripSet.has(nk)) delete saved[k];
    }

    const fn = trimmed(organizerFirstName != null ? String(organizerFirstName) : '');
    const ln = trimmed(organizerLastName != null ? String(organizerLastName) : '');
    const fk = resolveFirstNameFieldKey(formFields);
    const lk = resolveLastNameFieldKey(formFields);
    if (fk && fn) saved[fk] = fn;
    if (lk && ln) saved[lk] = ln;

    return saved;
}

// GET: Registration Form
router.get('/register/:id', async (req, res) => {
    try {
        const conference = await Conference.findById(req.params.id);
        if (!conference) {
            return res.status(404).json({ success: false, message: 'Conference not found.' });
        }
        // Fetch dynamic form fields from RegistrationForm model
        let formFields = [];
        const regForm = await findRegistrationFormForConference(conference._id);
        if (regForm && Array.isArray(regForm.fields)) {
            formFields = regForm.fields;
        }
        if (isAlumniMeetEventType(conference.eventType, conference.customEventType)) {
            formFields = stripAlumniGraduationBranchFields(formFields);
        }
        return res.json({
            success: true,
            formFields,
            displayEventName: (regForm && regForm.displayEventName) ? regForm.displayEventName : '',
            posterUrl: (regForm && regForm.posterUrl) ? regForm.posterUrl : ''
        });
    } catch (err) {
        console.error('Error fetching conference:', err);
        return res.status(500).json({ success: false, message: 'Server error. Please try again later.' });
    }
});

/** Check if email is already registered and has new fields to complete */
router.post('/register/:id/pending-status', async (req, res) => {
    try {
        const conferenceId = req.params.id;
        const conference = await Conference.findById(conferenceId);
        if (!conference) {
            return res.json({ success: false, message: 'Conference not found.' });
        }

        const regForm = await findRegistrationFormForConference(conferenceId);
        let formFields = regForm && Array.isArray(regForm.fields) ? regForm.fields : [];
        if (isAlumniMeetEventType(conference.eventType, conference.customEventType)) {
            formFields = stripAlumniGraduationBranchFields(formFields);
        }

        const verification = await resolveConferenceRegistrantVerification(req, formFields, conference);
        if (!verification.ok) {
            return res.json({ success: false, message: verification.message });
        }

        const registration = await findRegistrationForRegistrant(conferenceId, req, verification);

        if (!registration) {
            return res.json({
                success: true,
                isRegistered: false,
                hasPendingFields: false,
                pendingFields: [],
                pendingFieldNames: [],
            });
        }

        const pendingNames = await reconcileRegistrationPendingFields(registration, formFields, {
            persist: true,
            setNotifiedAtOnNew: true,
        });
        const pendingFields = formFields.filter((f) => pendingNames.includes(f.name));

        return res.json({
            success: true,
            isRegistered: true,
            registrationId: registration._id,
            hasPendingFields: pendingNames.length > 0,
            pendingFields,
            pendingFieldNames: pendingNames,
            formData: registration.formData || {},
            paymentInfo: registration.paymentInfo || null,
            numberOfTickets: registration.numberOfTickets || 1,
            feeCategoryBreakdown: registration.feeCategoryBreakdown || [],
            message: pendingNames.length
                ? 'Required registration fields are missing. Please complete them below.'
                : null,
        });
    } catch (err) {
        console.error('Error checking pending registration fields:', err);
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
});

/** Registrant completes new/missing fields after form update */
router.patch('/register/:id/complete-fields', uploadLocal.any(), async (req, res) => {
    try {
        const conferenceId = req.params.id;
        const conference = await Conference.findById(conferenceId);
        if (!conference) {
            return res.json({ success: false, message: 'Conference not found.' });
        }

        const regForm = await findRegistrationFormForConference(conferenceId);
        let formFields = regForm && Array.isArray(regForm.fields) ? regForm.fields : [];
        if (isAlumniMeetEventType(conference.eventType, conference.customEventType)) {
            formFields = stripAlumniGraduationBranchFields(formFields);
        }

        const verification = await resolveConferenceRegistrantVerification(req, formFields, conference);
        if (!verification.ok) {
            return res.json({ success: false, message: verification.message });
        }

        const registration = await findRegistrationForRegistrant(conferenceId, req, verification);
        if (!registration) {
            return res.json({ success: false, message: 'No registration found for this email.' });
        }

        const pendingNames = await reconcileRegistrationPendingFields(registration, formFields, {
            persist: true,
        });
        if (!pendingNames.length) {
            return res.json({ success: true, message: 'No pending fields to complete.', pendingFieldNames: [] });
        }

        const pendingFields = formFields.filter((f) => pendingNames.includes(f.name));
        const fileFieldNames = new Set(
            pendingFields.filter((f) => f.type === 'file').map((f) => f.name)
        );

        const nextFormData = { ...(registration.formData || {}) };
        for (const field of pendingFields) {
            if (field.type === 'file') continue;
            if (req.body[field.name] !== undefined) {
                nextFormData[field.name] = req.body[field.name];
            }
            if ((field.type === 'checkbox' || field.type === 'radio') && field.hasOtherOption) {
                const otherTextKey = field.name + '_other_text';
                if (req.body[otherTextKey]) {
                    if (Array.isArray(nextFormData[field.name])) {
                        const otherIndex = nextFormData[field.name].indexOf('__OTHER__');
                        if (otherIndex !== -1) {
                            nextFormData[field.name][otherIndex] = req.body[otherTextKey];
                        }
                    } else if (nextFormData[field.name] === '__OTHER__') {
                        nextFormData[field.name] = req.body[otherTextKey];
                    }
                }
            }
        }

        if (req.files && Array.isArray(req.files)) {
            for (const file of req.files) {
                const cleanFieldname = file.fieldname.replace(/\[\]$/, '');
                if (!pendingNames.includes(cleanFieldname)) continue;
                const fileExtension = file.originalname.toLowerCase().split('.').pop();
                const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg'];
                const uploadOptions = { folder: 'registration_uploads' };
                if (imageExtensions.includes(fileExtension)) {
                    uploadOptions.resource_type = 'image';
                } else if (fileExtension === 'pdf') {
                    uploadOptions.resource_type = 'raw';
                } else {
                    uploadOptions.resource_type = 'raw';
                }
                uploadOptions.public_id = `${cleanFieldname}_${Date.now()}_${Math.random().toString(36).substring(7)}`;
                const uploadResult = await cloudinary.uploader.upload(file.path, uploadOptions);
                nextFormData[cleanFieldname] = uploadResult.secure_url;
            }
        }

        for (const field of pendingFields) {
            if (field.required && !isFieldValuePresent(nextFormData, field)) {
                if (field.type === 'file' && fileFieldNames.has(field.name)) {
                    return res.json({
                        success: false,
                        message: `File field "${field.label}" is required. Please contact the organizer to update this field.`,
                    });
                }
                return res.json({ success: false, message: `Field "${field.label}" is required.` });
            }
        }

        registration.formData = nextFormData;
        registration.pendingRequiredFieldNames = computeAllMissingRequiredFieldNames(
            nextFormData,
            formFields
        );
        registration.markModified('formData');

        const isPaidEvent = conference.paymentType === 'paid';
        const payStatus = (registration.paymentInfo && registration.paymentInfo.paymentStatus)
            ? String(registration.paymentInfo.paymentStatus).trim()
            : '';
        const shouldHaveQr = !conference.isVirtual && (!isPaidEvent || payStatus === 'completed');

        if (shouldHaveQr) {
            const qrCodeDataUrl = await generateCompactAttendanceQrDataUrl(registration);
            const uploadResult = await cloudinary.uploader.upload(qrCodeDataUrl, {
                folder: 'conference_qr_codes',
                public_id: `QR_${conferenceId}_${registration._id}_${Date.now()}`,
            });
            registration.qrCodeUrl = uploadResult.secure_url;
        }

        await registration.save();

        if (verification.proofId) {
            await EmailVerificationProof.findByIdAndUpdate(verification.proofId, { consumed: true });
        }

        return res.json({
            success: true,
            message: 'Thank you! Your additional registration details have been saved.',
            pendingFieldNames: registration.pendingRequiredFieldNames,
            hasPendingFields: (registration.pendingRequiredFieldNames || []).length > 0,
        });
    } catch (err) {
        console.error('Error completing pending registration fields:', err);
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
});

/** Load existing registration for edit (logged-in registrant). */
router.post('/register/:id/registration-details', async (req, res) => {
    try {
        const conferenceId = req.params.id;
        const conference = await Conference.findById(conferenceId);
        if (!conference) {
            return res.json({ success: false, message: 'Conference not found.' });
        }

        const regForm = await findRegistrationFormForConference(conferenceId);
        let formFields = regForm && Array.isArray(regForm.fields) ? regForm.fields : [];
        if (isAlumniMeetEventType(conference.eventType, conference.customEventType)) {
            formFields = stripAlumniGraduationBranchFields(formFields);
        }

        const verification = await resolveConferenceRegistrantVerification(req, formFields, conference);
        if (!verification.ok) {
            return res.json({ success: false, message: verification.message });
        }

        const registration = await findRegistrationForRegistrant(conferenceId, req, verification);
        if (!registration) {
            return res.json({ success: false, message: 'No registration found for your account on this event.' });
        }

        await reconcileRegistrationPendingFields(registration, formFields, { persist: true });
        await reconcileRegistrationPayment(registration, conference, { persist: true });

        const pendingNames = registration.pendingRequiredFieldNames || [];
        const hasPendingPayment = registrationNeedsPaymentCompletion(registration, conference);

        return res.json({
            success: true,
            registrationId: registration._id,
            email: registration.email,
            formData: registration.formData || {},
            formFields,
            paymentInfo: registration.paymentInfo || null,
            numberOfTickets: registration.numberOfTickets || 1,
            feeCategoryBreakdown: registration.feeCategoryBreakdown || [],
            attendeeDetails: registration.attendeeDetails || [],
            hasPendingFields: pendingNames.length > 0,
            pendingFieldNames: pendingNames,
            hasPendingPayment,
            requiresPaymentDetails: conferenceRequiresRegistrationPaymentDetails(conference),
            requiresTransactionProof: conferenceRequiresTransactionProof(conference),
            isPaidEvent: conference.paymentType === 'paid',
            lastEditedAt: registration.lastEditedAt || null,
            lastEditedByEmail: registration.lastEditedByEmail || registration.email,
        });
    } catch (err) {
        console.error('Error loading registration details:', err);
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
});

function applyCheckboxRadioOtherValues(nextFormData, field, body) {
    if ((field.type !== 'checkbox' && field.type !== 'radio') || !field.hasOtherOption) return;
    const otherTextKey = field.name + '_other_text';
    if (!body[otherTextKey]) return;
    if (Array.isArray(nextFormData[field.name])) {
        const otherIndex = nextFormData[field.name].indexOf('__OTHER__');
        if (otherIndex !== -1) {
            nextFormData[field.name][otherIndex] = body[otherTextKey];
        }
    } else if (nextFormData[field.name] === '__OTHER__') {
        nextFormData[field.name] = body[otherTextKey];
    }
}

async function uploadRegistrationFileToCloudinary(file, cleanFieldname) {
    const fileExtension = file.originalname.toLowerCase().split('.').pop();
    const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg'];
    const uploadOptions = { folder: 'registration_uploads' };
    if (imageExtensions.includes(fileExtension)) {
        uploadOptions.resource_type = 'image';
    } else if (fileExtension === 'pdf') {
        uploadOptions.resource_type = 'raw';
    } else {
        uploadOptions.resource_type = 'raw';
    }
    uploadOptions.public_id = `${cleanFieldname}_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const uploadResult = await cloudinary.uploader.upload(file.path, uploadOptions);
    const fs = require('fs');
    if (file.path && fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
    }
    return uploadResult.secure_url;
}

async function buildUpdatedRegistrationFormData(registration, formFields, req) {
    const nextFormData = { ...(registration.formData || {}) };

    for (const field of formFields) {
        if (field.type === 'file') continue;
        if (field.type === 'email') {
            nextFormData[field.name] = registration.email;
            continue;
        }
        if (field.type === 'checkbox') {
            const raw = req.body[field.name] ?? req.body[`${field.name}[]`];
            if (raw !== undefined) {
                nextFormData[field.name] = Array.isArray(raw)
                    ? raw.filter((v) => v != null && String(v).trim() !== '')
                    : raw === '' || raw == null
                      ? []
                      : [raw];
            }
            applyCheckboxRadioOtherValues(nextFormData, field, req.body);
            continue;
        }
        if (Object.prototype.hasOwnProperty.call(req.body, field.name)) {
            nextFormData[field.name] = req.body[field.name];
        }
        applyCheckboxRadioOtherValues(nextFormData, field, req.body);
    }

    if (req.files && Array.isArray(req.files)) {
        for (const file of req.files) {
            const cleanFieldname = file.fieldname.replace(/\[\]$/, '');
            if (cleanFieldname === 'transactionProof') continue;
            const fieldDef = formFields.find((f) => f.name === cleanFieldname && f.type === 'file');
            if (!fieldDef) continue;
            const url = await uploadRegistrationFileToCloudinary(file, cleanFieldname);
            if (nextFormData[cleanFieldname]) {
                if (!Array.isArray(nextFormData[cleanFieldname])) {
                    nextFormData[cleanFieldname] = [nextFormData[cleanFieldname]];
                }
                nextFormData[cleanFieldname].push(url);
            } else {
                nextFormData[cleanFieldname] = [url];
            }
        }
    }

    return nextFormData;
}

/** Registrant updates saved registration form answers (and payment details on paid events). */
router.patch('/register/:id/update-details', uploadLocal.any(), async (req, res) => {
    try {
        const conferenceId = req.params.id;
        const conference = await Conference.findById(conferenceId);
        if (!conference) {
            return res.json({ success: false, message: 'Conference not found.' });
        }

        const regForm = await findRegistrationFormForConference(conferenceId);
        let formFields = regForm && Array.isArray(regForm.fields) ? regForm.fields : [];
        if (isAlumniMeetEventType(conference.eventType, conference.customEventType)) {
            formFields = stripAlumniGraduationBranchFields(formFields);
        }

        const verification = await resolveConferenceRegistrantVerification(req, formFields, conference);
        if (!verification.ok) {
            return res.json({ success: false, message: verification.message });
        }

        const registration = await findRegistrationForRegistrant(conferenceId, req, verification);
        if (!registration) {
            return res.json({ success: false, message: 'No registration found for your account on this event.' });
        }

        const nextFormData = await buildUpdatedRegistrationFormData(registration, formFields, req);

        for (const field of formFields) {
            if (field.required && !isFieldValuePresent(nextFormData, field)) {
                if (field.type === 'file') {
                    return res.json({
                        success: false,
                        message: `File field "${field.label}" is required. Please upload a file.`,
                    });
                }
                return res.json({ success: false, message: `Field "${field.label}" is required.` });
            }
        }

        registration.formData = nextFormData;
        registration.pendingRequiredFieldNames = computeAllMissingRequiredFieldNames(
            nextFormData,
            formFields
        );
        registration.markModified('formData');

        const isPaidEvent = conference.paymentType === 'paid';
        if (isPaidEvent) {
            if (!registration.paymentInfo || typeof registration.paymentInfo !== 'object') {
                registration.paymentInfo = { paymentStatus: 'pending' };
            }
            const pi = registration.paymentInfo;
            const txId = trimmed(req.body.transactionId);
            const txDateRaw = req.body.transactionDate;
            if (txId) pi.transactionId = txId;
            if (txDateRaw) pi.transactionDate = new Date(txDateRaw);

            const proofFile = req.files?.find((f) => f.fieldname === 'transactionProof');
            if (proofFile) {
                try {
                    const uploadResult = await cloudinary.uploader.upload(proofFile.path, {
                        folder: 'payment_proofs',
                        resource_type: 'auto',
                    });
                    pi.transactionProofUrl = uploadResult.secure_url;
                    const fs = require('fs');
                    if (proofFile.path && fs.existsSync(proofFile.path)) {
                        fs.unlinkSync(proofFile.path);
                    }
                } catch (uploadErr) {
                    console.error('Transaction proof upload failed:', uploadErr);
                    return res.json({ success: false, message: 'Failed to upload transaction proof.' });
                }
            }

            if (conferenceRequiresRegistrationPaymentDetails(conference) && !isPaymentWaived(pi)) {
                if (!trimmed(pi.transactionId)) {
                    return res.json({ success: false, message: 'Transaction ID is required.' });
                }
                if (!pi.transactionDate) {
                    return res.json({ success: false, message: 'Transaction date is required.' });
                }
            }

            if (conferenceRequiresTransactionProof(conference) && !isPaymentWaived(pi)) {
                if (!trimmed(pi.transactionProofUrl)) {
                    return res.json({ success: false, message: 'Transaction proof is required.' });
                }
            }

            registration.markModified('paymentInfo');
            await reconcileRegistrationPayment(registration, conference, { persist: false });
        }

        const payStatus = (registration.paymentInfo?.paymentStatus || '').toString().trim();
        const shouldHaveQr = !conference.isVirtual && (!isPaidEvent || payStatus === 'completed');

        if (shouldHaveQr) {
            const qrCodeDataUrl = await generateCompactAttendanceQrDataUrl(registration);
            const uploadResult = await cloudinary.uploader.upload(qrCodeDataUrl, {
                folder: 'conference_qr_codes',
                public_id: `QR_${conferenceId}_${registration._id}_${Date.now()}`,
            });
            registration.qrCodeUrl = uploadResult.secure_url;
        }

        registration.needsPaymentCompletion = registrationNeedsPaymentCompletion(registration, conference);

        const editedAt = new Date();
        registration.lastEditedAt = editedAt;
        registration.lastEditedByEmail = verification.email;
        if (!Array.isArray(registration.registrantEditHistory)) {
            registration.registrantEditHistory = [];
        }
        registration.registrantEditHistory.push({
            editedAt,
            editedByEmail: verification.email,
        });
        if (registration.registrantEditHistory.length > 50) {
            registration.registrantEditHistory = registration.registrantEditHistory.slice(-50);
        }
        registration.markModified('registrantEditHistory');

        await registration.save();

        if (verification.proofId) {
            await EmailVerificationProof.findByIdAndUpdate(verification.proofId, { consumed: true });
        }

        return res.json({
            success: true,
            message: 'Your registration details have been updated.',
            pendingFieldNames: registration.pendingRequiredFieldNames || [],
            hasPendingFields: (registration.pendingRequiredFieldNames || []).length > 0,
            paymentInfo: registration.paymentInfo || null,
            qrCodeUrl: registration.qrCodeUrl || '',
        });
    } catch (err) {
        console.error('Error updating registration details:', err);
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
});

/** Check if registered user must complete payment (event became paid) */
router.post('/register/:id/payment-pending-status', async (req, res) => {
    try {
        const conferenceId = req.params.id;
        const conference = await Conference.findById(conferenceId);
        if (!conference) {
            return res.json({ success: false, message: 'Conference not found.' });
        }

        const regForm = await findRegistrationFormForConference(conferenceId);
        let formFields = regForm && Array.isArray(regForm.fields) ? regForm.fields : [];
        if (isAlumniMeetEventType(conference.eventType, conference.customEventType)) {
            formFields = stripAlumniGraduationBranchFields(formFields);
        }

        const verification = await resolveConferenceRegistrantVerification(req, formFields, conference);
        if (!verification.ok) {
            return res.json({ success: false, message: verification.message });
        }

        const registration = await findRegistrationForRegistrant(conferenceId, req, verification);

        if (!registration) {
            return res.json({
                success: true,
                isRegistered: false,
                hasPendingPayment: false,
            });
        }

        const hasPendingPayment = await reconcileRegistrationPayment(registration, conference, {
            persist: true,
            setNotifiedAtOnNew: true,
        });

        const amountDue = registration.paymentInfo?.amount
            ?? (conference.ticketPrice || 0) * (registration.numberOfTickets || 1);

        return res.json({
            success: true,
            isRegistered: true,
            hasPendingPayment,
            requiresPaymentDetails: conferenceRequiresRegistrationPaymentDetails(conference),
            requiresTransactionProof: conferenceRequiresTransactionProof(conference),
            amountDue,
            numberOfTickets: registration.numberOfTickets || 1,
            message: hasPendingPayment
                ? PAYMENT_NOTIFICATION_MESSAGE(conference.title)
                : null,
        });
    } catch (err) {
        console.error('Error checking pending payment:', err);
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
});

/** Existing registrant submits payment after event became paid */
router.patch('/register/:id/complete-payment', uploadLocal.any(), async (req, res) => {
    try {
        const conferenceId = req.params.id;
        const conference = await Conference.findById(conferenceId);
        if (!conference) {
            return res.json({ success: false, message: 'Conference not found.' });
        }
        if (conference.paymentType !== 'paid') {
            return res.json({ success: false, message: 'This event does not require payment.' });
        }

        const regForm = await findRegistrationFormForConference(conferenceId);
        let formFields = regForm && Array.isArray(regForm.fields) ? regForm.fields : [];
        if (isAlumniMeetEventType(conference.eventType, conference.customEventType)) {
            formFields = stripAlumniGraduationBranchFields(formFields);
        }

        const verification = await resolveConferenceRegistrantVerification(req, formFields, conference);
        if (!verification.ok) {
            return res.json({ success: false, message: verification.message });
        }

        const registration = await findRegistrationForRegistrant(conferenceId, req, verification);
        if (!registration) {
            return res.json({ success: false, message: 'No registration found for this email.' });
        }

        const stillNeeds = await reconcileRegistrationPayment(registration, conference, { persist: true });
        if (!stillNeeds) {
            const status = registration.paymentInfo?.paymentStatus || 'pending';
            return res.json({
                success: true,
                message: status === 'completed'
                    ? 'Payment already approved.'
                    : 'Payment details already submitted. Pending verification by the organizer.',
                hasPendingPayment: false,
                paymentStatus: status,
            });
        }

        const body = { ...req.body };
        const feeCats = Array.isArray(conference.feeCategories) ? conference.feeCategories : [];

        if (feeCats.length > 0 && !body.feeCategoryBreakdown) {
            let breakdown = [];
            try {
                breakdown = body.feeCategoryBreakdown ? JSON.parse(body.feeCategoryBreakdown) : [];
            } catch (e) {
                breakdown = [];
            }
            if (!Array.isArray(breakdown) || breakdown.length === 0) {
                const selectedIdx = parseInt(body.selectedCategoryIndex, 10);
                const qty = parseInt(body.numberOfTickets, 10) || registration.numberOfTickets || 1;
                let idx = !isNaN(selectedIdx) && selectedIdx >= 0 && selectedIdx < feeCats.length
                    ? selectedIdx
                    : feeCats.findIndex((c) => (Number(c.amount) || 0) > 0);
                if (idx < 0) idx = 0;
                body.feeCategoryBreakdown = JSON.stringify([{ categoryIndex: idx, quantity: qty }]);
            }
        } else if (!feeCats.length) {
            body.numberOfTickets = String(registration.numberOfTickets || 1);
            if (conference.ticketPrice != null) {
                body.feeCategoryAmount = String(conference.ticketPrice);
            }
        }

        const ticketResult = await resolveRegistrationTicketsAndPayment(
            conference,
            conferenceId,
            verification.email,
            body,
            req.files || []
        );
        if (!ticketResult.ok) {
            return res.json({ success: false, message: ticketResult.message });
        }

        registration.paymentInfo = {
            ...(registration.paymentInfo || {}),
            ...(ticketResult.paymentInfo || {}),
        };
        if (ticketResult.numberOfTickets) {
            registration.numberOfTickets = ticketResult.numberOfTickets;
        }
        if (ticketResult.feeCategoryBreakdown?.length) {
            registration.feeCategoryBreakdown = ticketResult.feeCategoryBreakdown;
        }
        registration.markModified('paymentInfo');

        if (!isPaymentWaived(registration.paymentInfo)) {
            if (conferenceRequiresRegistrantApproval(conference)) {
                registration.paymentInfo.paymentStatus = 'pending';
                registration.paymentInfo.paymentApprovedAt = null;
            } else {
                registration.paymentInfo.paymentStatus = 'completed';
                registration.paymentInfo.paymentApprovedAt = new Date();
            }
        }
        await reconcileRegistrationPayment(registration, conference, { persist: true });
        await registration.save();

        if (verification.proofId) {
            await EmailVerificationProof.findByIdAndUpdate(verification.proofId, { consumed: true });
        }

        const finalStatus = registration.paymentInfo?.paymentStatus || 'pending';
        return res.json({
            success: true,
            message: finalStatus === 'completed'
                ? 'Payment details saved successfully.'
                : 'Payment details submitted. Pending verification by the organizer.',
            hasPendingPayment: false,
            paymentStatus: finalStatus,
        });
    } catch (err) {
        console.error('Error completing payment:', err);
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
});

router.post('/register/:id', uploadLocal.any(), validateContactLimits, async (req, res) => {
    try {
        const conferenceId = req.params.id;
        // Use conference from middleware if available (avoid duplicate fetch)
        const conference = req.conference || await Conference.findById(conferenceId);
        if (!conference) {
            return res.json({ success: false, message: 'Conference not found.' });
        }
        const isPaidEvent = conference.paymentType === 'paid';

        // Fetch dynamic form fields from RegistrationForm model
        const regForm = await findRegistrationFormForConference(conferenceId);
        let formFields = regForm && Array.isArray(regForm.fields) ? regForm.fields : [];
        if (isAlumniMeetEventType(conference.eventType, conference.customEventType)) {
            formFields = stripAlumniGraduationBranchFields(formFields);
        }

        if (conference.hideRegistrationSubmit) {
            return res.json({
                success: false,
                message: 'Registration on this page is disabled. Please select a ticket category and use the payment link.',
            });
        }

        const verification = await resolveConferenceRegistrantVerification(req, formFields, conference);
        if (!verification.ok) {
            return res.json({ success: false, message: verification.message });
        }
        const email = verification.email;
        const proofIdToConsume = verification.proofId;

        // Build savedFormData only from known fields
        const savedFormData = {};
        formFields.forEach(field => {
            if (field.type === 'checkbox') {
                const raw = req.body[field.name] ?? req.body[`${field.name}[]`];
                if (raw !== undefined) {
                    savedFormData[field.name] = Array.isArray(raw)
                        ? raw.filter((v) => v != null && String(v).trim() !== '')
                        : raw === '' || raw == null
                          ? []
                          : [raw];
                }
            } else if (req.body[field.name] !== undefined) {
                savedFormData[field.name] = req.body[field.name];
            }
            // Handle "Other" text input for checkbox and radio fields
            if ((field.type === 'checkbox' || field.type === 'radio') && field.hasOtherOption) {
                const otherTextKey = field.name + '_other_text';
                if (req.body[otherTextKey]) {
                    // The frontend should have already replaced "__OTHER__" with the actual text
                    // But we can also handle it here as a fallback
                    if (Array.isArray(savedFormData[field.name])) {
                        const otherIndex = savedFormData[field.name].indexOf('__OTHER__');
                        if (otherIndex !== -1) {
                            savedFormData[field.name][otherIndex] = req.body[otherTextKey];
                        }
                    } else if (savedFormData[field.name] === '__OTHER__') {
                        savedFormData[field.name] = req.body[otherTextKey];
                    }
                }
            }
        });

        // Validate required fields
        for (const field of formFields) {
            if (!field.required) continue;
            if (field.type === 'file') {
                const hasFile = (req.files || []).some((f) => {
                    const clean = String(f.fieldname || '').replace(/\[\]$/, '');
                    return clean === field.name;
                });
                if (!hasFile) {
                    return res.json({ success: false, message: `Field "${field.label}" is required.` });
                }
                continue;
            }
            if (!isFieldValuePresent(savedFormData, field)) {
                return res.json({ success: false, message: `Field "${field.label}" is required.` });
            }
        }

        // Registration open through deadline day; closed from the next calendar day
        if (isRegistrationDeadlinePassed(conference.deadline)) {
            return res.json({ success: false, message: 'Registration deadline has passed.' });
        }

        // Prevent duplicate registrations (unless organizer allows duplicates for this event)
        const existingRegistration = conference.allowDuplicateRegistration
            ? null
            : await findRegistrationForConferenceEmail(conferenceId, email);
        if (existingRegistration) {
            const pendingNames = await reconcileRegistrationPendingFields(
                existingRegistration,
                formFields,
                { persist: true, setNotifiedAtOnNew: true }
            );
            const hasPendingPayment = await reconcileRegistrationPayment(
                existingRegistration,
                conference,
                { persist: true, setNotifiedAtOnNew: true }
            );
            if (hasPendingPayment) {
                return res.json({
                    success: false,
                    message: 'You are already registered. Please complete payment for this event.',
                    alreadyRegistered: true,
                    hasPendingPayment: true,
                    hasPendingFields: pendingNames.length > 0,
                    pendingFieldNames: pendingNames,
                });
            }
            return res.json({
                success: false,
                message: pendingNames.length
                    ? 'You have already registered. Please complete the required fields for this event.'
                    : 'You are already registered for this conference. Use Edit details to update your registration.',
                alreadyRegistered: true,
                canEditDetails: true,
                hasPendingFields: pendingNames.length > 0,
                pendingFieldNames: pendingNames,
            });
        }

        const ticketResult = await resolveRegistrationTicketsAndPayment(
            conference,
            conferenceId,
            email,
            req.body,
            req.files || [],
            { organizerSkipPaymentProof: false }
        );
        if (!ticketResult.ok) {
            return res.json({ success: false, message: ticketResult.message });
        }
        const { numberOfTickets, feeCategoryBreakdown, attendeeDetails, paymentInfo, appliedCoupon, couponCode } = ticketResult;

        // Upload files to Cloudinary and add URLs to formData
        if (req.files && Array.isArray(req.files)) {
            for (const file of req.files) {
                 // Skip transaction proof as it's already handled
                if (file.fieldname === 'transactionProof') continue;

                // Remove array notation from fieldname if present (e.g., "fieldname[]" -> "fieldname")
                const cleanFieldname = file.fieldname.replace(/\[\]$/, '');

                // Determine file type and upload accordingly
                const fileExtension = file.originalname.toLowerCase().split('.').pop();
                const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg'];
                const pdfExtensions = ['pdf'];
                
                let uploadOptions = {
                    folder: 'registration_uploads'
                };

                if (imageExtensions.includes(fileExtension)) {
                    // Upload as image
                    uploadOptions.resource_type = 'image';
                    uploadOptions.public_id = `${cleanFieldname}_${Date.now()}_${Math.random().toString(36).substring(7)}`;
                } else if (pdfExtensions.includes(fileExtension)) {
                    // Upload as PDF
                    uploadOptions.resource_type = 'raw';
                    uploadOptions.public_id = `${cleanFieldname}_${Date.now()}_${Math.random().toString(36).substring(7)}`;
                } else {
                    // Default to raw for other file types
                    uploadOptions.resource_type = 'raw';
                    uploadOptions.public_id = `${cleanFieldname}_${Date.now()}_${Math.random().toString(36).substring(7)}`;
                }

                try {
                    const uploadResult = await cloudinary.uploader.upload(file.path, uploadOptions);
                    
                    // Handle multiple files - store as array
                    if (savedFormData[cleanFieldname]) {
                        // If field already exists, convert to array if not already
                        if (!Array.isArray(savedFormData[cleanFieldname])) {
                            savedFormData[cleanFieldname] = [savedFormData[cleanFieldname]];
                        }
                        savedFormData[cleanFieldname].push(uploadResult.secure_url);
                    } else {
                        // First file for this field - store as array for consistency
                        savedFormData[cleanFieldname] = [uploadResult.secure_url];
                    }
                    
                    // Clean up local file
                    const fs = require('fs');
                    fs.unlinkSync(file.path);
                } catch (uploadErr) {
                    console.error(`File upload failed for ${cleanFieldname}:`, uploadErr);
                    return res.json({ success: false, message: `Failed to upload ${cleanFieldname}.` });
                }
            }
        }

        // Generate QR code only for offline events (and only when registration is fully confirmed)
        let qrCodeUrl = '';
        const registrationConfirmedForQr = isPaidEvent
            ? (paymentInfo && paymentInfo.paymentStatus === 'completed')
            : !conferenceRequiresRegistrantApproval(conference);
        const shouldGenerateAttendeeQr =
            !conference.isVirtual && registrationConfirmedForQr;

        if (shouldGenerateAttendeeQr) {
        const qrCodeDataUrl = await generateCompactAttendanceQrDataUrl({
            email,
            conferenceId: conferenceId.toString(),
        });

        // Upload QR to Cloudinary
        let uploadResult;
        try {
            uploadResult = await cloudinary.uploader.upload(qrCodeDataUrl, {
                folder: 'conference_qr_codes',
                public_id: `QR_${conferenceId}_${Date.now()}`
            });
                qrCodeUrl = uploadResult.secure_url;
        } catch (uploadErr) {
            console.error('Cloudinary upload failed:', uploadErr);
            return res.json({ success: false, message: 'QR code upload failed.' });
        }
        }

        // Save registration
        const registrationData = {
            conferenceId,
            email,
            formData: savedFormData,
            numberOfTickets,
            attendeeDetails,
            registeredAt: new Date()
        };

        // Only include QR code URL for offline events
        if (!conference.isVirtual && qrCodeUrl) {
            registrationData.qrCodeUrl = qrCodeUrl;
        }

        // Add payment info if it's a paid event
        if (paymentInfo) {
            registrationData.paymentInfo = paymentInfo;
        }
        if (!isPaidEvent) {
            registrationData.registrationStatus = conferenceRequiresRegistrantApproval(conference)
                ? 'pending'
                : 'completed';
            if (registrationData.registrationStatus === 'completed') {
                registrationData.registrationApprovedAt = new Date();
            }
        }
        if (feeCategoryBreakdown.length > 0) {
            registrationData.feeCategoryBreakdown = feeCategoryBreakdown;
        }

        const authed = getAuthUser(req);
        if (authed && authed._id) {
            registrationData.userId = authed._id;
        }

        const newRegistration = new Registration(registrationData);

        await newRegistration.save();

        await reconcileRegistrationPayment(newRegistration, conference, {
          persist: true,
          setNotifiedAtOnNew: true,
        });
        
        // Update usage stats and check limits for contact limits
        try {
            // Get the conference creator's user ID to update their contact count
            const conferenceCreator = await require('../models/User').findById(conference.createdBy);
            if (conferenceCreator) {
                // Update contact count in conference creator's usageStats
                await PlanLimitsService.updateContactCount(conferenceCreator._id, 1);
                
                // Check usage limits and send alert if needed
                if (conferenceCreator.usageStats) {
                    const currentCount = conferenceCreator.usageStats.contacts || 0;
                    const planLimits = PlanLimitsService.getPlanLimits(conferenceCreator.selectedPlan || 'free');
                    const limit = planLimits.contacts;
                    
                    if (limit > 0) { // Only check if there's a limit
                        await UsageAlertService.checkContactLimits(conferenceCreator._id, currentCount, limit);
                    }
                }
            }
        } catch (alertError) {
            console.error('Error updating usage stats or checking alerts after registration:', alertError);
            // Don't fail the registration if update/alert fails
        }

        // Send confirmation email only when registration is fully confirmed.
        const shouldSendConfirmationEmail =
            (isPaidEvent && paymentInfo && paymentInfo.paymentStatus === 'completed') ||
            (!isPaidEvent && registrationData.registrationStatus === 'completed');
        await sendRegistrationConfirmationIfReady(conference, email, savedFormData, qrCodeUrl, shouldSendConfirmationEmail);

        if (isPaidEvent && paymentInfo && paymentInfo.paymentStatus === 'pending') {
            if (proofIdToConsume) {
                await EmailVerificationProof.deleteOne({ _id: proofIdToConsume });
            }
            return res.json({
                success: true,
                paymentStatus: 'pending',
                message: 'Registration submitted. Payment is pending verification by the organizer.'
            });
        }

        if (!isPaidEvent && registrationData.registrationStatus === 'pending') {
            if (proofIdToConsume) {
                await EmailVerificationProof.deleteOne({ _id: proofIdToConsume });
            }
            return res.json({
                success: true,
                registrationStatus: 'pending',
                message: 'Registration submitted. Pending approval by the organizer.'
            });
        }

        // Mark coupon usage after successful registration (best-effort).
        // Includes completed payments, full waivers, and pending payments where a coupon changed the amount.
        const shouldMarkCouponUsed =
            isPaidEvent &&
            appliedCoupon &&
            couponCode &&
            paymentInfo &&
            (paymentInfo.paymentStatus === 'completed' ||
                paymentInfo.paymentStatus === 'pending');
        if (shouldMarkCouponUsed) {
            try {
                const emailKey = (email || '').toLowerCase();
                await CouponCode.updateOne(
                    { _id: appliedCoupon._id },
                    {
                        $inc: { usedCount: 1 },
                        ...(emailKey ? { $push: { usageByEmail: { email: emailKey, usedAt: new Date() } } } : {})
                    }
                );
            } catch (couponUpdateErr) {
                console.warn('Coupon usage update failed:', couponUpdateErr?.message || couponUpdateErr);
            }
        }

        if (proofIdToConsume) {
            await EmailVerificationProof.deleteOne({ _id: proofIdToConsume });
        }
        return res.json({ success: true, paymentStatus: paymentInfo?.paymentStatus || undefined, message: 'Registration successful! Check your email for confirmation.' });

    } catch (err) {
        console.error('Error processing registration:', err);
        return res.json({ success: false, message: err?.message || 'Server error. Please try again later.' });
    }
});

// Organizer / collaborator / admin: add multiple registrants manually (email + first/last name + category required where applicable; optional extra fields). Legacy `name` still accepted. Per-row payment: approve (completed) or pending. Confirmation email only when payment is completed (or free event).
router.post('/conferences/:id/registrants/manual', async (req, res) => {
    try {
        if (!getAuthUser(req)) {
            return res.status(401).json({ success: false, message: 'You must be logged in.' });
        }
        const conferenceId = req.params.id;
        if (!(await userCanManageConference(req, conferenceId))) {
            return res.status(403).json({ success: false, message: 'Not authorized to manage this event.' });
        }

        const conference = await Conference.findById(conferenceId);
        if (!conference) {
            return res.json({ success: false, message: 'Conference not found.' });
        }

        const payload = req.body && typeof req.body === 'object' ? req.body : {};
        const rawRows = payload.registrants;
        if (!Array.isArray(rawRows) || rawRows.length === 0) {
            return res.json({ success: false, message: 'Provide a non-empty "registrants" array.' });
        }
        if (rawRows.length > 50) {
            return res.json({ success: false, message: 'You can add at most 50 registrants per request.' });
        }

        const regForm = await findRegistrationFormForConference(conferenceId);
        let formFields = regForm && Array.isArray(regForm.fields) ? regForm.fields : [];
        if (isAlumniMeetEventType(conference.eventType, conference.customEventType)) {
            formFields = stripAlumniGraduationBranchFields(formFields);
        }

        for (const field of formFields) {
            if (field.type === 'file' && field.required) {
                return res.json({
                    success: false,
                    message: `This registration form requires file field "${field.label}". Manual batch add is not available until that field is optional or removed.`
                });
            }
        }

        const isPaidEvent = conference.paymentType === 'paid';
        const hasFeeCategories = isPaidEvent && Array.isArray(conference.feeCategories) && conference.feeCategories.length > 0;
        const globalNotes = trimmed(payload.paymentNotes || '');

        const validationErrors = [];
        const normalized = [];

        const seenEmails = new Set();
        for (let i = 0; i < rawRows.length; i++) {
            const row = rawRows[i] && typeof rawRows[i] === 'object' ? rawRows[i] : {};
            const email = trimmed(row.email || '').toLowerCase();
            const firstName = trimmed(row.firstName != null ? String(row.firstName) : '');
            const lastName = trimmed(row.lastName != null ? String(row.lastName) : '');
            const legacyName = trimmed(row.name != null ? String(row.name) : '');
            let displayName = '';
            if (firstName && lastName) {
                displayName = `${firstName} ${lastName}`.replace(/\s+/g, ' ').trim();
            } else if (legacyName) {
                displayName = legacyName;
            }
            const paymentDecision = normalizeOrganizerPaymentStatus(row.paymentStatus);
            const extra = row.extra && typeof row.extra === 'object' ? row.extra : {};
            const attendeeExtra = row.attendee && typeof row.attendee === 'object' ? row.attendee : {};

            if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                validationErrors.push({ index: i, message: 'Valid email is required.' });
                continue;
            }
            if (!displayName) {
                if (firstName || lastName) {
                    validationErrors.push({ index: i, message: 'Both first and last name are required.' });
                } else {
                    validationErrors.push({ index: i, message: 'Name is required.' });
                }
                continue;
            }
            if (seenEmails.has(email)) {
                validationErrors.push({ index: i, message: 'Duplicate email in this list.' });
                continue;
            }
            seenEmails.add(email);

            let categoryIndex = row.categoryIndex;
            if (hasFeeCategories) {
                const ci = parseInt(categoryIndex, 10);
                if (isNaN(ci) || ci < 0 || ci >= conference.feeCategories.length) {
                    validationErrors.push({ index: i, message: 'Valid ticket category (categoryIndex) is required for this paid event.' });
                    continue;
                }
                categoryIndex = ci;
            } else {
                categoryIndex = null;
            }

            normalized.push({
                index: i,
                email,
                displayName,
                firstName,
                lastName,
                paymentDecision: isPaidEvent ? paymentDecision : (paymentDecision === 'pending' ? 'pending' : 'completed'),
                extra,
                attendeeExtra,
                categoryIndex
            });
        }

        if (validationErrors.length) {
            return res.json({ success: false, message: 'Validation failed.', errors: validationErrors });
        }

        for (const row of normalized) {
            if (conference.allowDuplicateRegistration) continue;
            const exists = await Registration.findOne({ conferenceId, email: row.email }).select('_id').lean();
            if (exists) {
                validationErrors.push({ index: row.index, message: 'This email is already registered for this event.' });
            }
        }
        if (validationErrors.length) {
            return res.json({ success: false, message: 'Validation failed.', errors: validationErrors });
        }

        const headroom = await assertOrganizerBatchContactHeadroom(
            conference.createdBy,
            normalized.map(r => r.email)
        );
        if (!headroom.ok) {
            return res.status(403).json({ success: false, message: headroom.message });
        }

        const results = [];
        for (const row of normalized) {
            const savedFormData = buildSavedFormDataForBatchRow(
                formFields,
                row.email,
                row.displayName,
                row.extra,
                row.firstName,
                row.lastName
            );
            let feeCategoryBreakdownJson = '[]';
            let attendeeDetailsJson = '[]';
            let numberOfTickets = 1;

            if (hasFeeCategories && row.categoryIndex != null) {
                const cat = conference.feeCategories[row.categoryIndex];
                const unitAmount = Number(cat.amount) || 0;
                feeCategoryBreakdownJson = JSON.stringify([
                    {
                        categoryIndex: row.categoryIndex,
                        quantity: 1,
                        categoryName: cat.name || '',
                        unitAmount,
                        subtotal: unitAmount
                    }
                ]);
                try {
                    attendeeDetailsJson = JSON.stringify(
                        buildAttendeeDetailsForManualRow(
                            conference,
                            row.categoryIndex,
                            1,
                            row.displayName,
                            row.attendeeExtra
                        )
                    );
                } catch (e) {
                    return res.json({
                        success: false,
                        message: e.message || 'Invalid attendee details.',
                        failedAtIndex: row.index
                    });
                }
                numberOfTickets = 1;
            }

            const flatBody = {
                ...row.extra,
                email: row.email,
                paymentNotes: globalNotes,
                numberOfTickets,
                feeCategoryBreakdown: feeCategoryBreakdownJson,
                attendeeDetails: attendeeDetailsJson
            };

            const saved = await persistOrganizerManualRegistration({
                conference,
                conferenceId,
                email: row.email,
                savedFormData,
                flatBody,
                isPaidEvent,
                organizerPaymentStatus: row.paymentDecision
            });
            if (!saved.ok) {
                return res.json({
                    success: false,
                    message: saved.message || 'Could not save a registrant.',
                    failedAtIndex: row.index,
                    added: results.length,
                    results
                });
            }
            results.push({ email: row.email, registrationId: saved.registrationId });
        }

        return res.json({
            success: true,
            added: results.length,
            results,
            message: `Successfully added ${results.length} registrant(s). Confirmation emails are sent only for approved (completed) payments and free events.`
        });
    } catch (err) {
        console.error('Manual registrant batch error:', err);
        return res.status(500).json({ success: false, message: err?.message || 'Server error.' });
    }
});

// DELETE: Remove registrant (event organizer or super admin only)
router.delete('/registrant/:registrationId', async (req, res) => {
    try {
        if (!getAuthUser(req)) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const { registrationId } = req.params;

        const registration = await Registration.findById(registrationId)
            .select('conferenceId')
            .lean();
        if (!registration) {
            return res.status(404).json({
                success: false,
                message: 'Registration not found.'
            });
        }

        if (!(await canOrganizerOrAdminManageRegistrants(req, registration.conferenceId))) {
            return res.status(403).json({
                success: false,
                message: 'Only the event organizer or an administrator can remove a registrant.'
            });
        }

        await Registration.deleteOne({ _id: registrationId });

        const conference = await Conference.findById(registration.conferenceId)
            .select('status createdBy')
            .lean();
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
            } else if (!isIncompleteEvent) {
                console.log(`⏭️ Skipped contact count decrease for completed event (status: ${conference.status})`);
            }
        }

        return res.json({
            success: true,
            message: 'Registrant removed successfully.'
        });

    } catch (err) {
        console.error('Error removing registrant:', err);
        return res.status(500).json({ 
            success: false, 
            message: 'Server error. Please try again later.' 
        });
    }
});

module.exports = router;