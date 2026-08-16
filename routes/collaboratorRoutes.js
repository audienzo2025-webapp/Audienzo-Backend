require('dotenv').config();
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const CollaboratorInvitation = require('../models/CollaboratorInvitation');
const Conference = require('../models/Conference');
const User = require('../models/User');
const { getAuthUser } = require('../utils/authUser');
const { sendEmail } = require('../services/emailService');

async function isAdminUser(req) {
    if (!getAuthUser(req)) return false;
    const user = await User.findById(getAuthUser(req)._id).select('role isAdmin').lean();
    return user && (user.role === 'admin' || user.isAdmin === true);
}

async function canManageCollaboratorsForEvent(req, event) {
    if (!event || !getAuthUser(req)) return false;
    const isOwner = event.createdBy && event.createdBy.toString() === getAuthUser(req)._id.toString();
    if (isOwner) return true;
    return isAdminUser(req);
}

// Helper function to generate invitation token
const generateToken = () => {
    return crypto.randomBytes(32).toString('hex');
};

// Helper function to generate invitation email HTML
const generateInvitationEmail = (ownerName, ownerEmail, eventNames, acceptUrl) => {
    const eventList = eventNames.map(name => `<li style="margin: 8px 0;"><strong>${name}</strong></li>`).join('');
    
    const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
        <div style="background-color: white; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); overflow: hidden;">
            <!-- Header with Gradient -->
            <div style="background: linear-gradient(135deg, #007bff 0%, #0056b3 100%); padding: 40px 30px; text-align: center;">
                <h1 style="color: #ffffff; margin: 0; font-size: 32px; font-weight: 700; letter-spacing: -0.5px;">Event Collaboration Invitation</h1>
            </div>

            <!-- Body Content -->
            <div style="padding: 40px 30px;">
                <!-- Greeting -->
                <div style="margin-bottom: 30px;">
                    <p style="color: #333333; font-size: 16px; line-height: 1.6; margin: 0 0 12px 0;">Hello,</p>
                    <p style="color: #333333; font-size: 16px; line-height: 1.6; margin: 0;">
                        You have been invited by <strong>${ownerEmail}</strong> to collaborate on the following event(s):
                    </p>
                </div>

                <!-- Event List with Styled Box -->
                <div style="background-color: #f9fafb; border-left: 4px solid #007bff; border-radius: 8px; padding: 20px; margin-bottom: 30px;">
                    <ul style="color: #1f2937; font-size: 15px; line-height: 1.8; margin: 0; padding-left: 0; list-style: none;">
                        ${eventList}
                    </ul>
                </div>

                <!-- Access Description -->
                <div style="margin-bottom: 30px;">
                    <p style="color: #4b5563; font-size: 15px; line-height: 1.6; margin: 0;">
                        As a collaborator, you will have full access to manage these events.
                    </p>
                </div>

                <!-- CTA Button with Gradient -->
                <div style="text-align: center; margin-bottom: 25px;">
                    <a href="${acceptUrl}" 
                       style="display: inline-block; background: linear-gradient(135deg, #007bff 0%, #0056b3 100%); color: #ffffff; padding: 16px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 6px rgba(0, 123, 255, 0.3); transition: all 0.3s ease;">
                        Accept Invitation
                    </a>
                </div>

                <!-- Instructional Text -->
                <div style="text-align: center; margin-bottom: 30px;">
                    <p style="color: #6b7280; font-size: 13px; line-height: 1.5; margin: 0;">
                        Click the button above to accept the invitation and access your events.
                    </p>
                </div>
            </div>

            <!-- Footer -->
            <div style="background-color: #f9fafb; padding: 30px; text-align: center; border-top: 1px solid #e5e7eb;">
                <p style="color: #4b5563; font-size: 14px; line-height: 1.6; margin: 0 0 8px 0;">
                    Best regards,<br>
                    <strong style="color: #1f2937;">The Audienzo Team</strong>
                </p>
                <p style="color: #6b7280; font-size: 13px; margin: 12px 0 0 0;">
                    <a href="https://www.audienzo.com" style="color: #007bff; text-decoration: none; font-weight: 500;">www.audienzo.com</a>
                </p>
            </div>
        </div>
    </div>`;

    const text = `
Event Collaboration Invitation

Hello,

You have been invited by ${ownerEmail} to collaborate on the following event(s):

${eventNames.map(name => `• ${name}`).join('\n')}

As a collaborator, you will have full access to manage these events.

Accept the invitation by clicking the link below:
${acceptUrl}

Click the link above to accept the invitation and access your events.

Best regards,
The Audienzo Team
www.audienzo.com
    `;

    return { html, text };
};

// POST /api/collaborators/invite - Send collaboration invitations
router.post('/invite', async (req, res) => {
    try {
        if (!getAuthUser(req)) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const { collaboratorEmails, eventIds } = req.body;

        // Validate input
        if (!collaboratorEmails || !Array.isArray(collaboratorEmails) || collaboratorEmails.length === 0) {
            return res.status(400).json({ success: false, message: 'Please provide at least one collaborator email' });
        }

        if (!eventIds || !Array.isArray(eventIds) || eventIds.length === 0) {
            return res.status(400).json({ success: false, message: 'Please select at least one event' });
        }

        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        for (const email of collaboratorEmails) {
            if (!emailRegex.test(email)) {
                return res.status(400).json({ success: false, message: `Invalid email format: ${email}` });
            }
        }

        const events = await Conference.find({ _id: { $in: eventIds } });
        if (events.length !== eventIds.length) {
            return res.status(404).json({ success: false, message: 'One or more events were not found' });
        }

        const admin = await isAdminUser(req);
        if (!admin) {
            const allOwned = events.every(
                (e) => e.createdBy && e.createdBy.toString() === getAuthUser(req)._id.toString()
            );
            if (!allOwned) {
                return res.status(403).json({ success: false, message: 'You can only invite collaborators to your own events' });
            }
        }

        const frontendUrl = process.env.NODE_ENV === 'production'
            ? process.env.FRONTEND_URL
            : 'http://localhost:4200';

        const eventsByOwner = new Map();
        for (const event of events) {
            const ownerId = event.createdBy.toString();
            if (!eventsByOwner.has(ownerId)) {
                eventsByOwner.set(ownerId, { ownerId, eventIds: [], eventDocs: [] });
            }
            const group = eventsByOwner.get(ownerId);
            group.eventIds.push(event._id);
            group.eventDocs.push(event);
        }

        const results = [];

        for (const email of collaboratorEmails) {
            const normalizedEmail = email.toLowerCase().trim();

            for (const group of eventsByOwner.values()) {
                const owner = await User.findById(group.ownerId);
                const ownerName = owner?.fullName || owner?.email || 'Event Organizer';
                const ownerEmail = owner?.email || 'Event Organizer';

                const existingInvitation = await CollaboratorInvitation.findOne({
                    collaboratorEmail: normalizedEmail,
                    eventOwner: group.ownerId,
                    events: { $all: group.eventIds },
                    status: 'pending',
                    expiresAt: { $gt: new Date() }
                });

                if (existingInvitation) {
                    results.push({
                        email: normalizedEmail,
                        success: false,
                        message: 'An invitation has already been sent to this email for these events'
                    });
                    continue;
                }

                const token = generateToken();
                const invitation = new CollaboratorInvitation({
                    eventOwner: group.ownerId,
                    collaboratorEmail: normalizedEmail,
                    events: group.eventIds,
                    token
                });

                await invitation.save();

                const eventNames = group.eventDocs.map((e) => e.title);
                const acceptUrl = `${frontendUrl}/accept-invitation?token=${token}`;
                const emailContent = generateInvitationEmail(ownerName, ownerEmail, eventNames, acceptUrl);

                try {
                    await sendEmail(
                        normalizedEmail,
                        `🎉 Collaboration Invitation - ${eventNames.length} Event(s)`,
                        emailContent.text,
                        emailContent.html
                    );

                    results.push({
                        email: normalizedEmail,
                        success: true,
                        message: 'Invitation sent successfully'
                    });
                } catch (emailError) {
                    console.error('Error sending invitation email:', emailError);
                    results.push({
                        email: normalizedEmail,
                        success: true,
                        message: 'Invitation created, but email delivery failed'
                    });
                }
            }
        }

        const allSuccess = results.every(r => r.success);
        return res.status(allSuccess ? 200 : 207).json({
            success: allSuccess,
            message: allSuccess 
                ? 'Invitations sent successfully' 
                : 'Some invitations were sent, but some had issues',
            results
        });

    } catch (error) {
        console.error('Error sending collaboration invitations:', error);
        return res.status(500).json({ success: false, message: 'Server error while sending invitations' });
    }
});

// POST /api/collaborators/accept/:token - Accept collaboration invitation
router.post('/accept/:token', async (req, res) => {
    try {
        const { token } = req.params;

        // Find invitation by token
        const invitation = await CollaboratorInvitation.findOne({ token });

        if (!invitation) {
            return res.status(404).json({ success: false, message: 'Invitation not found or invalid' });
        }

        // Check if invitation is expired
        if (invitation.expiresAt < new Date()) {
            invitation.status = 'expired';
            await invitation.save();
            return res.status(400).json({ success: false, message: 'This invitation has expired' });
        }

        // Check if already accepted
        if (invitation.status === 'accepted') {
            return res.status(400).json({ success: false, message: 'This invitation has already been accepted' });
        }

        // Check if user is logged in
        if (!getAuthUser(req)) {
            // Store token in session to accept after login
            req.session.pendingInvitationToken = token;
            return res.status(401).json({ 
                success: false, 
                message: 'Please log in to accept the invitation',
                requiresLogin: true 
            });
        }

        // Verify that the logged-in user's email matches the invitation email
        const user = await User.findById(getAuthUser(req)._id);
        if (user.email.toLowerCase() !== invitation.collaboratorEmail.toLowerCase()) {
            return res.status(403).json({ 
                success: false, 
                message: 'This invitation was sent to a different email address' 
            });
        }

        // Add user as collaborator to all events
        for (const eventId of invitation.events) {
            const event = await Conference.findById(eventId);
            if (event) {
                const alreadyCollaborator = (event.collaborators || []).some(
                    (id) => id && id.toString() === user._id.toString()
                );
                if (!alreadyCollaborator) {
                    event.collaborators.push(user._id);
                    await event.save();
                }
            }
        }

        // Mark invitation as accepted
        invitation.status = 'accepted';
        invitation.acceptedAt = new Date();
        await invitation.save();

        return res.status(200).json({
            success: true,
            message: 'Invitation accepted successfully. Events have been added to your dashboard.',
            eventIds: invitation.events
        });

    } catch (error) {
        console.error('Error accepting collaboration invitation:', error);
        return res.status(500).json({ success: false, message: 'Server error while accepting invitation' });
    }
});

// GET /api/collaborators/accept/:token - Get invitation details (for checking before accepting)
router.get('/accept/:token', async (req, res) => {
    try {
        const { token } = req.params;

        const invitation = await CollaboratorInvitation.findOne({ token })
            .populate('events', 'title startDate location')
            .populate('eventOwner', 'fullName email');

        if (!invitation) {
            return res.status(404).json({ success: false, message: 'Invitation not found' });
        }

        // Check if expired
        if (invitation.expiresAt < new Date()) {
            return res.status(400).json({ 
                success: false, 
                message: 'This invitation has expired',
                expired: true 
            });
        }

        // Check if already accepted
        if (invitation.status === 'accepted') {
            return res.status(400).json({ 
                success: false, 
                message: 'This invitation has already been accepted',
                accepted: true 
            });
        }

        return res.status(200).json({
            success: true,
            invitation: {
                collaboratorEmail: invitation.collaboratorEmail,
                events: invitation.events,
                owner: invitation.eventOwner,
                expiresAt: invitation.expiresAt
            }
        });

    } catch (error) {
        console.error('Error fetching invitation:', error);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
});

// GET /api/collaborators/my-collaborations - Get events where user is a collaborator
router.get('/my-collaborations', async (req, res) => {
    try {
        if (!getAuthUser(req)) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const events = await Conference.find({
            collaborators: getAuthUser(req)._id
        }).populate('createdBy', 'fullName email');

        return res.status(200).json({
            success: true,
            events
        });

    } catch (error) {
        console.error('Error fetching collaborations:', error);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
});

// GET /api/collaborators/event/:eventId - Get all collaborators for a specific event
router.get('/event/:eventId', async (req, res) => {
    try {
        if (!getAuthUser(req)) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const { eventId } = req.params;

        // Find the event and verify the user is the owner
        const event = await Conference.findById(eventId);
        if (!event) {
            return res.status(404).json({ success: false, message: 'Event not found' });
        }

        const isOwner = event.createdBy && event.createdBy.toString() === getAuthUser(req)._id.toString();
        const userDoc = await User.findById(getAuthUser(req)._id).select('role isAdmin').lean();
        const isAdmin = userDoc && (userDoc.role === 'admin' || userDoc.isAdmin === true);
        if (!isOwner && !isAdmin) {
            return res.status(403).json({ success: false, message: 'You can only view collaborators for your own events' });
        }
        const ownerId = event.createdBy;
        const invitations = await CollaboratorInvitation.find({
            eventOwner: ownerId,
            events: eventId
        }).sort({ createdAt: -1 });

        // Get unique collaborator emails from invitations
        const collaboratorEmails = [...new Set(invitations.map(inv => inv.collaboratorEmail.toLowerCase()))];

        // Get user details for accepted collaborators (those who have accounts)
        const acceptedCollaborators = await User.find({
            email: { $in: collaboratorEmails }
        }).select('email fullName _id');

        // Create a map of email to user for quick lookup
        const userMap = new Map();
        acceptedCollaborators.forEach(user => {
            userMap.set(user.email.toLowerCase(), user);
        });

        // Combine invitation data with user details
        const collaboratorsWithStatus = invitations.map(invitation => {
            const user = userMap.get(invitation.collaboratorEmail.toLowerCase());
            
            return {
                invitationId: invitation._id,
                _id: user?._id || null,
                email: invitation.collaboratorEmail,
                fullName: user?.fullName || '',
                invitationStatus: invitation.status,
                acceptedAt: invitation.acceptedAt || null,
                invitedAt: invitation.createdAt || null,
                expiresAt: invitation.expiresAt || null
            };
        });

        // Remove duplicates (keep the most recent invitation per email)
        const uniqueCollaborators = [];
        const seenEmails = new Set();
        for (const collab of collaboratorsWithStatus.reverse()) {
            if (!seenEmails.has(collab.email.toLowerCase())) {
                seenEmails.add(collab.email.toLowerCase());
                uniqueCollaborators.push(collab);
            }
        }

        return res.status(200).json({
            success: true,
            collaborators: uniqueCollaborators.reverse()
        });

    } catch (error) {
        console.error('Error fetching event collaborators:', error);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
});

// DELETE /api/collaborators/event/:eventId/invitation/:invitationId — cancel pending (or stale) invite for this event
router.delete('/event/:eventId/invitation/:invitationId', async (req, res) => {
    try {
        if (!getAuthUser(req)) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const { eventId, invitationId } = req.params;

        const event = await Conference.findById(eventId);
        if (!event) {
            return res.status(404).json({ success: false, message: 'Event not found' });
        }

        if (!(await canManageCollaboratorsForEvent(req, event))) {
            return res.status(403).json({
                success: false,
                message: 'Only the event organizer or an administrator can cancel invitations'
            });
        }

        const invitation = await CollaboratorInvitation.findById(invitationId);
        if (!invitation) {
            return res.status(404).json({ success: false, message: 'Invitation not found' });
        }

        if (invitation.eventOwner.toString() !== event.createdBy.toString()) {
            return res.status(403).json({ success: false, message: 'Invalid invitation for this event' });
        }

        const eventInInvite = invitation.events.some(
            (eid) => eid.toString() === eventId
        );
        if (!eventInInvite) {
            return res.status(403).json({ success: false, message: 'Invitation does not include this event' });
        }

        if (invitation.status === 'accepted') {
            return res.status(400).json({
                success: false,
                message: 'Accepted collaborators must be removed using Remove, not cancel invitation'
            });
        }

        if (invitation.events.length <= 1) {
            await CollaboratorInvitation.deleteOne({ _id: invitation._id });
        } else {
            await CollaboratorInvitation.updateOne(
                { _id: invitation._id },
                { $pull: { events: eventId } }
            );
        }

        return res.status(200).json({
            success: true,
            message: 'Invitation cancelled'
        });
    } catch (error) {
        console.error('Error cancelling collaborator invitation:', error);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
});

// DELETE /api/collaborators/event/:eventId/remove/:collaboratorId - Remove a collaborator from an event
router.delete('/event/:eventId/remove/:collaboratorId', async (req, res) => {
    try {
        if (!getAuthUser(req)) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const { eventId, collaboratorId } = req.params;

        // Find the event and verify the user is the owner
        const event = await Conference.findById(eventId);
        if (!event) {
            return res.status(404).json({ success: false, message: 'Event not found' });
        }

        if (!(await canManageCollaboratorsForEvent(req, event))) {
            return res.status(403).json({
                success: false,
                message: 'Only the event organizer or an administrator can remove collaborators'
            });
        }
        // Remove collaborator from event
        event.collaborators = event.collaborators.filter(
            collabId => collabId.toString() !== collaboratorId
        );
        await event.save();

        return res.status(200).json({
            success: true,
            message: 'Collaborator removed successfully'
        });

    } catch (error) {
        console.error('Error removing collaborator:', error);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
});

module.exports = router;

