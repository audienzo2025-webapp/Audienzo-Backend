const CouponCode = require('../models/CouponCode');
const couponHelpers = require('../routes/couponRoutes');
const { conferenceRequiresRegistrantApproval, conferenceRequiresRegistrationPaymentDetails } = require('./registrationPaymentReconcile');

function trimmed(value) {
    return (value == null ? '' : String(value)).trim();
}

/**
 * Shared ticket / fee / coupon / payment resolution for public registration and organizer manual add.
 * @param {import('mongoose').Document} conference
 * @param {string} conferenceId
 * @param {string} email
 * @param {object} body - flat keys (multipart or JSON manual payload)
 * @param {Array} files - multer files array
 * @param {{ organizerSkipPaymentProof?: boolean }} opts - when true, never require proof; mark paid rows completed for organizer
 */
async function resolveRegistrationTicketsAndPayment(conference, conferenceId, email, body, files, opts = {}) {
    const isPaidEvent = conference.paymentType === 'paid';
    let requiresPaymentFields = opts.organizerSkipPaymentProof
        ? false
        : conferenceRequiresRegistrationPaymentDetails(conference);
    let requiresTransactionProof = requiresPaymentFields && !!trimmed(conference.qrCodeUrl);

    let numberOfTickets = 1;
    let feeCategoryBreakdown = [];
    let paymentInfo = null;
    let attendeeDetails = [];

    const rawCouponCode = body?.couponCode || body?.coupon || '';
    const couponCode = couponHelpers.normalizeCode(rawCouponCode);
    let couponPricing = null;
    let appliedCoupon = null;
    let accessCodeValidated = false;

    if (isPaidEvent) {
        if (Array.isArray(conference.feeCategories) && conference.feeCategories.length > 0) {
            const rawBreakdown = body.feeCategoryBreakdown;
            let parsedBreakdown = [];
            try {
                parsedBreakdown = rawBreakdown ? JSON.parse(rawBreakdown) : [];
            } catch (e) {
                return { ok: false, message: 'Invalid category ticket breakdown format.' };
            }

            if (!Array.isArray(parsedBreakdown) || parsedBreakdown.length === 0) {
                if (!couponCode) {
                    return { ok: false, message: 'Please add at least one ticket in a registration category.' };
                }

                const found = await CouponCode.findOne({ conferenceId, code: couponCode }).lean();
                if (!found) {
                    return { ok: false, message: 'Invalid coupon code.' };
                }

                const result = await couponHelpers.validateCouponForPreview({
                    conference,
                    coupon: found,
                    email,
                    breakdown: []
                });
                if (!result.ok) {
                    return { ok: false, message: result.message };
                }
                if (!found.accessOnly) {
                    return { ok: false, message: 'Please add at least one ticket in a registration category.' };
                }

                couponPricing = result;
                appliedCoupon = found;
                accessCodeValidated = true;
                requiresPaymentFields = false;
                requiresTransactionProof = false;
                numberOfTickets = 1;
                feeCategoryBreakdown = [];
                attendeeDetails = [];

                paymentInfo = {
                    transactionDate: undefined,
                    paymentStatus: 'completed',
                    notes: body.paymentNotes || '',
                    amount: 0,
                    originalAmount: 0,
                    discountAmount: 0,
                    couponCode
                };
            } else {
                let totalTickets = 0;
                let totalAmount = 0;
                const normalizedBreakdown = [];

                for (const item of parsedBreakdown) {
                    const idx = parseInt(item?.categoryIndex, 10);
                    const qty = parseInt(item?.quantity, 10);
                    if (isNaN(idx) || idx < 0 || idx >= conference.feeCategories.length) {
                        return { ok: false, message: 'Invalid registration category selected.' };
                    }
                    if (isNaN(qty) || qty < 1) {
                        return { ok: false, message: 'Category quantity must be at least 1.' };
                    }
                    const cat = conference.feeCategories[idx];
                    const unitAmount = Number(cat.amount) || 0;
                    totalTickets += qty;
                    totalAmount += unitAmount * qty;
                    normalizedBreakdown.push({
                        categoryIndex: idx,
                        categoryName: cat.name || '',
                        unitAmount,
                        quantity: qty,
                        subtotal: unitAmount * qty
                    });
                }

                if (conference.allowMultipleTickets) {
                    const maxAllowed = conference.maxTicketsPerRegistration || 50;
                    if (totalTickets < 1 || totalTickets > maxAllowed) {
                        return { ok: false, message: `Total tickets across categories must be between 1 and ${maxAllowed}.` };
                    }
                } else if (totalTickets !== 1) {
                    return { ok: false, message: 'Only one ticket is allowed for this event.' };
                }

                numberOfTickets = totalTickets;
                feeCategoryBreakdown = normalizedBreakdown;

                if (couponCode) {
                    const found = await CouponCode.findOne({ conferenceId, code: couponCode }).lean();
                    if (!found) {
                        return { ok: false, message: 'Invalid coupon code.' };
                    }
                    const result = await couponHelpers.validateCouponForPreview({
                        conference,
                        coupon: found,
                        email,
                        breakdown: normalizedBreakdown
                    });
                    if (!result.ok) {
                        return { ok: false, message: result.message };
                    }
                    couponPricing = result;
                    appliedCoupon = found;
                    if (found.accessOnly) {
                        accessCodeValidated = true;
                    }
                    if (couponPricing.payableAmount === 0) {
                        requiresPaymentFields = false;
                        requiresTransactionProof = false;
                    }
                }

                const gatedSelected = normalizedBreakdown.filter(b => (Number(b?.unitAmount) || 0) === 0);
                if (gatedSelected.length > 0 && !accessCodeValidated) {
                    const gatedIdxs = gatedSelected.map(b => Number(b.categoryIndex)).filter(n => !isNaN(n));
                    const accessCoupons = await CouponCode.find({
                        conferenceId,
                        isActive: true,
                        accessOnly: true,
                        allowedCategoryIndexes: { $in: gatedIdxs }
                    }).select('_id').lean();
                    if (Array.isArray(accessCoupons) && accessCoupons.length > 0) {
                        return {
                            ok: false,
                            message: 'Access code is required for the selected registration category.'
                        };
                    }
                }

                const organizerAttendeeFields = Array.isArray(conference.attendeeFields) ? conference.attendeeFields : [];
                const rawAttendeeDetails = body.attendeeDetails;
                let parsedAttendeeDetails = [];
                try {
                    parsedAttendeeDetails = rawAttendeeDetails ? JSON.parse(rawAttendeeDetails) : [];
                } catch (e) {
                    return { ok: false, message: 'Invalid attendee details format.' };
                }
                const attendeeMap = new Map();
                if (Array.isArray(parsedAttendeeDetails)) {
                    parsedAttendeeDetails.forEach(entry => {
                        const idx = parseInt(entry?.categoryIndex, 10);
                        if (!isNaN(idx)) attendeeMap.set(idx, entry);
                    });
                }

                try {
                    attendeeDetails = normalizedBreakdown.map(item => {
                        const categoryIndex = item.categoryIndex;
                        const categoryEntry = attendeeMap.get(categoryIndex) || {};
                        const attendees = Array.isArray(categoryEntry.attendees) ? categoryEntry.attendees : [];
                        if (attendees.length !== item.quantity) {
                            throw new Error(`Attendee details count must match quantity for category ${item.categoryName || (categoryIndex + 1)}.`);
                        }
                        const fieldsForCategory = organizerAttendeeFields.filter(f => {
                            const appliesTo = Number(f?.appliesToCategoryIndex);
                            return appliesTo === -1 || appliesTo === categoryIndex;
                        });
                        const normalizedAttendees = attendees.map((att, attendeeIdx) => {
                            const one = {};
                            fieldsForCategory.forEach(field => {
                                const key = field?.name;
                                if (!key) return;
                                const value = att ? att[key] : undefined;
                                const t = typeof value === 'string' ? value.trim() : value;
                                if (field.required && (t === undefined || t === null || t === '')) {
                                    throw new Error(`"${field.label || key}" is required for attendee ${attendeeIdx + 1} in category ${item.categoryName || (categoryIndex + 1)}.`);
                                }
                                one[key] = t;
                            });
                            return one;
                        });
                        return {
                            categoryIndex,
                            attendees: normalizedAttendees
                        };
                    });
                } catch (e) {
                    return { ok: false, message: e.message || 'Invalid attendee details.' };
                }

                paymentInfo = {
                    transactionDate: requiresPaymentFields && body.transactionDate
                        ? new Date(body.transactionDate)
                        : undefined,
                    paymentStatus: ((couponPricing && couponPricing.payableAmount === 0) ? 'completed' : ((Number(totalAmount) || 0) === 0 ? 'completed' : 'pending')),
                    notes: body.paymentNotes || '',
                    amount: (couponPricing ? couponPricing.payableAmount : totalAmount),
                    originalAmount: totalAmount,
                    discountAmount: (couponPricing ? couponPricing.discountAmount : 0),
                    couponCode: (couponPricing ? couponCode : undefined),
                    feeCategoryBreakdown: normalizedBreakdown
                };
            }
        } else {
            if (conference.allowMultipleTickets) {
                const raw = body.numberOfTickets;
                const n = parseInt(raw, 10);
                if (!isNaN(n) && n >= 1 && n <= (conference.maxTicketsPerRegistration || 50)) {
                    numberOfTickets = n;
                } else {
                    return { ok: false, message: `Number of tickets must be between 1 and ${conference.maxTicketsPerRegistration || 50}.` };
                }
            }

            const feeCategoryAmount = body.feeCategoryAmount != null ? parseFloat(body.feeCategoryAmount) : null;
            const unitAmount = feeCategoryAmount != null && !isNaN(feeCategoryAmount) ? feeCategoryAmount : (conference.ticketPrice || 0);
            const totalAmount = unitAmount * numberOfTickets;

            if (couponCode) {
                const found = await CouponCode.findOne({ conferenceId, code: couponCode }).lean();
                if (!found) {
                    return { ok: false, message: 'Invalid coupon code.' };
                }
                const result = await couponHelpers.validateCouponForPreview({
                    conference,
                    coupon: found,
                    email,
                    breakdown: []
                });
                if (!result.ok) {
                    return { ok: false, message: result.message };
                }
                couponPricing = result;
                appliedCoupon = found;
                if (found.accessOnly) {
                    accessCodeValidated = true;
                }
                if (couponPricing.payableAmount === 0) {
                    requiresPaymentFields = false;
                    requiresTransactionProof = false;
                }
            }

            paymentInfo = {
                transactionDate: requiresPaymentFields && body.transactionDate
                    ? new Date(body.transactionDate)
                    : undefined,
                paymentStatus: ((couponPricing && couponPricing.payableAmount === 0) ? 'completed' : ((Number(totalAmount) || 0) === 0 ? 'completed' : 'pending')),
                notes: body.paymentNotes || '',
                feeCategoryName: body.feeCategoryName || undefined,
                feeCategoryAmount: feeCategoryAmount,
                amount: (couponPricing ? couponPricing.payableAmount : totalAmount),
                originalAmount: totalAmount,
                discountAmount: (couponPricing ? couponPricing.discountAmount : 0),
                couponCode: (couponPricing ? couponCode : undefined)
            };
        }

        if (requiresPaymentFields) {
            if (!body.transactionDate) {
                return { ok: false, message: 'Transaction date is required for paid events.' };
            }
            if (!trimmed(body.transactionId)) {
                return { ok: false, message: 'Transaction ID is required for paid events.' };
            }
        }

        const transactionProofFile = files?.find(f => f.fieldname === 'transactionProof');
        if (requiresTransactionProof) {
            if (!transactionProofFile) {
                return { ok: false, message: 'Transaction proof is required for paid events.' };
            }

            try {
                const cloudinary = require('cloudinary').v2;
                const uploadResult = await cloudinary.uploader.upload(transactionProofFile.path, {
                    folder: 'payment_proofs',
                    resource_type: 'auto'
                });
                paymentInfo.transactionProofUrl = uploadResult.secure_url;
                paymentInfo.transactionId = trimmed(body.transactionId);
                if (body.transactionDate) {
                    paymentInfo.transactionDate = new Date(body.transactionDate);
                }
                const fs = require('fs');
                fs.unlinkSync(transactionProofFile.path);
            } catch (uploadErr) {
                console.error('Transaction proof upload failed:', uploadErr);
                return { ok: false, message: 'Failed to upload transaction proof.' };
            }
        } else if (paymentInfo) {
            if (trimmed(body.transactionId)) {
                paymentInfo.transactionId = trimmed(body.transactionId);
            }
            if (body.transactionDate) {
                paymentInfo.transactionDate = new Date(body.transactionDate);
            }
            if (transactionProofFile) {
                try {
                    const cloudinary = require('cloudinary').v2;
                    const uploadResult = await cloudinary.uploader.upload(transactionProofFile.path, {
                        folder: 'payment_proofs',
                        resource_type: 'auto'
                    });
                    paymentInfo.transactionProofUrl = uploadResult.secure_url;
                    const fs = require('fs');
                    fs.unlinkSync(transactionProofFile.path);
                } catch (uploadErr) {
                    console.error('Transaction proof upload failed:', uploadErr);
                    return { ok: false, message: 'Failed to upload transaction proof.' };
                }
            }
        }
    } else if (conference.allowMultipleTickets) {
        const raw = body.numberOfTickets;
        const n = parseInt(raw, 10);
        if (!isNaN(n) && n >= 1 && n <= (conference.maxTicketsPerRegistration || 50)) {
            numberOfTickets = n;
        } else {
            return { ok: false, message: `Number of tickets must be between 1 and ${conference.maxTicketsPerRegistration || 50}.` };
        }
    }

    if (opts.organizerSkipPaymentProof && paymentInfo) {
        if (!conferenceRequiresRegistrantApproval(conference)) {
            paymentInfo.paymentStatus = 'completed';
            paymentInfo.paymentMethod = paymentInfo.paymentMethod || 'manual';
            paymentInfo.paymentApprovedAt = new Date();
            const extra = 'Confirmed automatically (approval not required).';
            paymentInfo.notes = paymentInfo.notes ? `${paymentInfo.notes} ${extra}` : extra;
        } else {
            const decision = opts.organizerPaymentStatus === 'pending' ? 'pending' : 'completed';
            paymentInfo.paymentStatus = decision;
            paymentInfo.paymentMethod = paymentInfo.paymentMethod || 'manual';
            if (decision === 'completed') {
                paymentInfo.paymentApprovedAt = new Date();
            } else {
                paymentInfo.paymentApprovedAt = null;
            }
            if (decision === 'pending') {
                const extra = 'Recorded by organizer — payment pending verification.';
                paymentInfo.notes = paymentInfo.notes ? `${paymentInfo.notes} ${extra}` : extra;
            } else {
                const extra = 'Confirmed by organizer (manual registration).';
                paymentInfo.notes = paymentInfo.notes ? `${paymentInfo.notes} ${extra}` : extra;
            }
        }
    }

    return {
        ok: true,
        numberOfTickets,
        feeCategoryBreakdown,
        attendeeDetails,
        paymentInfo,
        appliedCoupon,
        couponCode
    };
}

module.exports = { resolveRegistrationTicketsAndPayment };
