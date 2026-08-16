require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const Registration = require('../models/Registration');
const Conference = require('../models/Conference');
const { getAuthUser } = require('../utils/authUser');
const { isEventUpcoming } = require('../utils/eventDateUtils');
const { findRegistrationFormForConference } = require('../utils/registrationFormStore');
const {
    isAlumniMeetEventType,
    stripAlumniGraduationBranchFields,
} = require('../utils/alumniMeetRegistrationFields');
const { reconcileRegistrationPendingFields } = require('../utils/registrationFormDiff');
const { reconcileRegistrationPayment, PAYMENT_NOTIFICATION_MESSAGE } = require('../utils/registrationPaymentReconcile');

const router = express.Router();

const trimmed = (value) => (value == null ? '' : String(value)).trim();

function toObjectIds(ids) {
    return [...new Set((ids || []).map((id) => String(id)))]
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));
}

function normalizeInterest(value) {
    return String(value || '').toLowerCase().trim();
}

function interestAsText(interest) {
    return normalizeInterest(interest).replace(/-/g, ' ');
}

function scoreEventForVisitor(event, user) {
    const interests = (user.interests || []).map(normalizeInterest).filter(Boolean);
    let score = 0;

    const eventType = normalizeInterest(event.eventType);
    const customType = normalizeInterest(event.customEventType);
    const title = normalizeInterest(event.title);
    const description = normalizeInterest(event.description);
    const location = normalizeInterest(event.location);
    const tags = (event.tags || []).map(normalizeInterest).filter(Boolean);

    for (const interest of interests) {
        const text = interestAsText(interest);
        if (eventType && eventType === interest) score += 25;
        if (tags.some((tag) => tag === interest || tag.includes(text) || text.includes(tag))) score += 18;
        if (customType && (customType.includes(text) || text.includes(customType))) score += 15;
        if (title && (title.includes(text) || text.includes(title))) score += 8;
        if (description && description.includes(text)) score += 4;
    }

    const city = normalizeInterest(user.location?.city);
    if (city && location.includes(city)) score += 12;

    const followed = (user.followedOrganizers || []).map(String);
    if (followed.includes(String(event.createdBy))) score += 30;

    return score;
}

function sortByStartDate(a, b) {
    return new Date(a.startDate).getTime() - new Date(b.startDate).getTime();
}

function requireParticipant(req, res, next) {
    const authed = getAuthUser(req);
    if (!authed) {
        return res.status(401).json({ success: false, message: 'Not logged in.' });
    }
    if (authed.role !== 'visitor' && authed.role !== 'user') {
        return res.status(403).json({ success: false, message: 'Participant access required.' });
    }
    req.participantId = authed._id;
    next();
}

/** @deprecated use requireParticipant — kept as alias */
function requireVisitor(req, res, next) {
    req.visitorId = undefined;
    return requireParticipant(req, res, () => {
        req.visitorId = req.participantId;
        next();
    });
}

async function linkRegistrationsToUser(userId, email) {
    await Registration.updateMany(
        { email: email.toLowerCase(), $or: [{ userId: null }, { userId: { $exists: false } }] },
        { $set: { userId } }
    );
}

async function getFormFieldsForConference(conference) {
    const regForm = await findRegistrationFormForConference(conference._id);
    let formFields = regForm && Array.isArray(regForm.fields) ? regForm.fields : [];
    if (isAlumniMeetEventType(conference.eventType, conference.customEventType)) {
        formFields = stripAlumniGraduationBranchFields(formFields);
    }
    return formFields;
}

function mapRegistrationItem(reg, confMap, formFieldsByConferenceId) {
    const conference = confMap[String(reg.conferenceId)] || null;
    const pendingNames = Array.isArray(reg.pendingRequiredFieldNames)
        ? reg.pendingRequiredFieldNames.filter(Boolean)
        : [];
    const formFields = formFieldsByConferenceId[String(reg.conferenceId)] || [];
    const labelByName = new Map(formFields.map((f) => [f.name, f.label || f.name]));
    const pendingFieldLabels = pendingNames.map((n) => labelByName.get(n) || n);

    return {
        registration: {
            _id: reg._id,
            attended: reg.attended,
            attendedAt: reg.attendedAt,
            registeredAt: reg.registeredAt,
            qrCodeUrl: reg.qrCodeUrl,
            formData: reg.formData,
            paymentInfo: reg.paymentInfo,
            pendingRequiredFieldNames: pendingNames,
            hasPendingFields: pendingNames.length > 0,
            pendingFieldLabels,
            hasPendingPayment: !!reg.needsPaymentCompletion,
        },
        conference,
    };
}

async function buildPendingRegistrationNotifications(userId, email) {
    await linkRegistrationsToUser(userId, email);
    const registrations = await Registration.find({
        $or: [{ userId }, { email: email.toLowerCase() }],
    })
        .sort({ formFieldsUpdateNotifiedAt: -1, updatedAt: -1 })
        .lean();

    if (!registrations.length) {
        return { unreadCount: 0, notifications: [] };
    }

    const conferenceIds = [...new Set(registrations.map((r) => String(r.conferenceId)))];
    const conferences = await Conference.find({ _id: { $in: conferenceIds } }).lean();
    const confMap = Object.fromEntries(conferences.map((c) => [String(c._id), c]));

    const formFieldsByConferenceId = {};
    for (const conf of conferences) {
        formFieldsByConferenceId[String(conf._id)] = await getFormFieldsForConference(conf);
    }

    const notifications = [];
    for (const reg of registrations) {
        const conference = confMap[String(reg.conferenceId)];
        if (!conference) continue;

        const slug = conference.urlSlug || conference.slug || String(conference._id);

        const formFields = formFieldsByConferenceId[String(reg.conferenceId)] || [];
        const pendingNames = await reconcileRegistrationPendingFields(reg, formFields, {
            persist: true,
            setNotifiedAtOnNew: true,
        });
        if (pendingNames.length) {
            const labelByName = new Map(formFields.map((f) => [f.name, f.label || f.name]));
            const pendingFieldLabels = pendingNames.map((n) => labelByName.get(n) || n);
            const fieldWord = pendingNames.length === 1 ? 'field' : 'fields';
            notifications.push({
                id: `${reg._id}_fields`,
                type: 'pending_registration_fields',
                conferenceId: String(reg.conferenceId),
                eventTitle: conference.title || 'Event',
                eventSlug: slug,
                pendingFieldNames: pendingNames,
                pendingFieldLabels,
                message: `Complete ${pendingNames.length} required registration ${fieldWord} for "${conference.title || 'your event'}".`,
                actionUrl: `/register/${slug}?editDetails=1&registrationId=${reg._id}`,
                createdAt: reg.formFieldsUpdateNotifiedAt || reg.updatedAt || reg.registeredAt,
            });
        }

        const hasPendingPayment = await reconcileRegistrationPayment(reg, conference, {
            persist: true,
            setNotifiedAtOnNew: true,
        });
        if (hasPendingPayment) {
            notifications.push({
                id: `${reg._id}_payment`,
                type: 'pending_payment',
                conferenceId: String(reg.conferenceId),
                eventTitle: conference.title || 'Event',
                eventSlug: slug,
                pendingFieldNames: [],
                pendingFieldLabels: [],
                message: PAYMENT_NOTIFICATION_MESSAGE(conference.title),
                actionUrl: `/register/${slug}?completePayment=1`,
                createdAt: reg.paymentUpdateNotifiedAt || reg.updatedAt || reg.registeredAt,
            });
        }
    }

    notifications.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return {
        unreadCount: notifications.length,
        notifications,
    };
}

// GET /api/visitor/profile
router.get('/profile', requireVisitor, async (req, res) => {
    try {
        const user = await User.findById(req.visitorId)
            .select('-password -resetPasswordToken -resetPasswordExpires');
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }
        res.json({ success: true, user });
    } catch (err) {
        console.error('Visitor profile error:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// PUT /api/visitor/profile — interests, location, reminders, onboarding
router.put('/profile', requireVisitor, async (req, res) => {
    try {
        const { interests, location, eventReminderEnabled, visitorOnboardingCompleted, fullName } = req.body;
        const update = {};

        if (Array.isArray(interests)) {
            update.interests = interests.map((i) => trimmed(i)).filter(Boolean);
        }
        if (location && typeof location === 'object') {
            update.location = {
                city: trimmed(location.city),
                state: trimmed(location.state),
                country: trimmed(location.country) || 'IN'
            };
        }
        if (typeof eventReminderEnabled === 'boolean') {
            update.eventReminderEnabled = eventReminderEnabled;
        }
        if (typeof visitorOnboardingCompleted === 'boolean') {
            update.visitorOnboardingCompleted = visitorOnboardingCompleted;
        }
        if (fullName != null) {
            update.fullName = trimmed(fullName);
        }

        const user = await User.findByIdAndUpdate(req.visitorId, update, { new: true })
            .select('-password -resetPasswordToken -resetPasswordExpires');

        if (req.session && req.session.user) {
            req.session.user.fullName = user.fullName;
        }

        res.json({ success: true, user });
    } catch (err) {
        console.error('Visitor profile update error:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// GET /api/visitor/registrations
router.get('/registrations', requireVisitor, async (req, res) => {
    try {
        const user = await User.findById(req.visitorId).select('email');
        await linkRegistrationsToUser(req.visitorId, user.email);

        const registrations = await Registration.find({
            $or: [{ userId: req.visitorId }, { email: user.email.toLowerCase() }]
        })
            .sort({ registeredAt: -1 })
            .lean();

        const conferenceIds = [...new Set(registrations.map((r) => String(r.conferenceId)))];
        const conferences = await Conference.find({ _id: { $in: conferenceIds } }).lean();
        const confMap = Object.fromEntries(conferences.map((c) => [String(c._id), c]));

        const formFieldsByConferenceId = {};
        for (const conf of conferences) {
            formFieldsByConferenceId[String(conf._id)] = await getFormFieldsForConference(conf);
        }

        for (const reg of registrations) {
            const formFields = formFieldsByConferenceId[String(reg.conferenceId)] || [];
            await reconcileRegistrationPendingFields(reg, formFields, { persist: true });
            const conference = confMap[String(reg.conferenceId)];
            if (conference) {
                await reconcileRegistrationPayment(reg, conference, { persist: true });
            }
        }

        const items = registrations
            .map((reg) => mapRegistrationItem(reg, confMap, formFieldsByConferenceId))
            .filter((item) => item.conference);

        res.json({ success: true, registrations: items });
    } catch (err) {
        console.error('Visitor registrations error:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// GET /api/visitor/attended
router.get('/attended', requireVisitor, async (req, res) => {
    try {
        const user = await User.findById(req.visitorId).select('email');
        await linkRegistrationsToUser(req.visitorId, user.email);

        const registrations = await Registration.find({
            attended: true,
            $or: [{ userId: req.visitorId }, { email: user.email.toLowerCase() }]
        })
            .sort({ attendedAt: -1 })
            .lean();

        const conferenceIds = registrations.map((r) => r.conferenceId);
        const conferences = await Conference.find({ _id: { $in: conferenceIds } }).lean();
        const confMap = Object.fromEntries(conferences.map((c) => [String(c._id), c]));

        const items = registrations.map((reg) => ({
            registration: {
                _id: reg._id,
                attendedAt: reg.attendedAt,
                registeredAt: reg.registeredAt
            },
            conference: confMap[String(reg.conferenceId)] || null
        })).filter((item) => item.conference);

        res.json({ success: true, attended: items });
    } catch (err) {
        console.error('Visitor attended error:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// GET /api/visitor/notifications — in-app alerts (e.g. incomplete registration fields)
router.get('/notifications', requireVisitor, async (req, res) => {
    try {
        const user = await User.findById(req.visitorId).select('email');
        if (!user?.email) {
            return res.json({ success: true, unreadCount: 0, notifications: [] });
        }
        const payload = await buildPendingRegistrationNotifications(req.visitorId, user.email);
        res.json({ success: true, ...payload });
    } catch (err) {
        console.error('Visitor notifications error:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// GET /api/visitor/saved-events
router.get('/saved-events', requireVisitor, async (req, res) => {
    try {
        const user = await User.findById(req.visitorId).select('savedEventIds');
        const events = await Conference.find({
            _id: { $in: user.savedEventIds || [] },
            isPublic: 'yes',
            status: { $ne: 'draft' }
        }).lean();
        res.json({ success: true, events });
    } catch (err) {
        console.error('Visitor saved events error:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// POST /api/visitor/saved-events/:conferenceId
router.post('/saved-events/:conferenceId', requireVisitor, async (req, res) => {
    try {
        const conferenceId = req.params.conferenceId;
        const conference = await Conference.findById(conferenceId);
        if (!conference) {
            return res.status(404).json({ success: false, message: 'Event not found.' });
        }
        await User.findByIdAndUpdate(req.visitorId, {
            $addToSet: { savedEventIds: conferenceId }
        });
        res.json({ success: true, message: 'Event saved.' });
    } catch (err) {
        console.error('Save event error:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// DELETE /api/visitor/saved-events/:conferenceId
router.delete('/saved-events/:conferenceId', requireVisitor, async (req, res) => {
    try {
        await User.findByIdAndUpdate(req.visitorId, {
            $pull: { savedEventIds: req.params.conferenceId }
        });
        res.json({ success: true, message: 'Event removed from saved.' });
    } catch (err) {
        console.error('Unsave event error:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// POST /api/visitor/follow/:organizerId
router.post('/follow/:organizerId', requireVisitor, async (req, res) => {
    try {
        const organizer = await User.findById(req.params.organizerId);
        if (!organizer || organizer.role === 'visitor') {
            return res.status(404).json({ success: false, message: 'Organizer not found.' });
        }
        await User.findByIdAndUpdate(req.visitorId, {
            $addToSet: { followedOrganizers: organizer._id }
        });
        res.json({ success: true, message: 'Organizer followed.' });
    } catch (err) {
        console.error('Follow organizer error:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// DELETE /api/visitor/follow/:organizerId
router.delete('/follow/:organizerId', requireVisitor, async (req, res) => {
    try {
        await User.findByIdAndUpdate(req.visitorId, {
            $pull: { followedOrganizers: req.params.organizerId }
        });
        res.json({ success: true, message: 'Organizer unfollowed.' });
    } catch (err) {
        console.error('Unfollow organizer error:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// GET /api/visitor/followed-organizers
router.get('/followed-organizers', requireVisitor, async (req, res) => {
    try {
        const user = await User.findById(req.visitorId).select('followedOrganizers');
        const organizers = await User.find({
            _id: { $in: user.followedOrganizers || [] }
        }).select('fullName organization email image').lean();
        res.json({ success: true, organizers });
    } catch (err) {
        console.error('Followed organizers error:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// GET /api/visitor/recommendations
router.get('/recommendations', requireVisitor, async (req, res) => {
    try {
        const user = await User.findById(req.visitorId)
            .select('interests location savedEventIds followedOrganizers email');
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }
        await linkRegistrationsToUser(req.visitorId, user.email);

        const registered = await Registration.find({
            $or: [{ userId: req.visitorId }, { email: user.email.toLowerCase() }]
        }).select('conferenceId').lean();

        const excludeIds = toObjectIds(registered.map((r) => r.conferenceId));

        const query = {
            isPublic: 'yes',
            status: { $ne: 'draft' },
        };
        if (excludeIds.length > 0) {
            query._id = { $nin: excludeIds };
        }

        const allEvents = await Conference.find(query).sort({ startDate: 1 }).lean();
        const upcoming = allEvents.filter(isEventUpcoming);

        const ranked = upcoming
            .map((event) => ({ event, score: scoreEventForVisitor(event, user) }))
            .sort((a, b) => {
                if (b.score !== a.score) return b.score - a.score;
                return sortByStartDate(a.event, b.event);
            });

        const hasInterestMatch = ranked.some((item) => item.score > 0);
        const hasInterests = Array.isArray(user.interests) && user.interests.length > 0;

        let picks;
        if (hasInterests && hasInterestMatch) {
            picks = ranked.filter((item) => item.score > 0).slice(0, 12).map((item) => item.event);
        } else {
            picks = ranked.slice(0, 12).map((item) => item.event);
        }

        res.json({ success: true, events: picks });
    } catch (err) {
        console.error('Recommendations error:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

// GET /api/visitor/explore — all public events with recommended flags
router.get('/explore', requireVisitor, async (req, res) => {
    try {
        const user = await User.findById(req.visitorId)
            .select('interests location followedOrganizers email');
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }

        const events = await Conference.find({
            isPublic: 'yes',
            status: { $ne: 'draft' }
        })
            .sort({ startDate: 1 })
            .lean();

        const eventsWithFlags = events.map((event) => {
            const score = scoreEventForVisitor(event, user);
            return {
                ...event,
                isRecommended: score > 0,
                recommendationScore: score
            };
        });

        res.json({ success: true, events: eventsWithFlags });
    } catch (err) {
        console.error('Explore events error:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

module.exports = router;
