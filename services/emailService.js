const { SendMailClient } = require('zeptomail');

// Initialize ZeptoMail with API key
if (!process.env.ZEPTO_API_KEY) {
    console.error('❌ ZEPTO_API_KEY is not set in environment variables');
    throw new Error('ZeptoMail API key is required');
}

// Validate sender email
if (!process.env.EMAIL_USER) {
    console.error('❌ EMAIL_USER is not set in environment variables');
    throw new Error('Sender email is required');
}

const url = "https://api.zeptomail.in/";
const token = process.env.ZEPTO_API_KEY;
const client = new SendMailClient({url, token});

/**
 * Convert internal attachment objects to ZeptoMail API format (base64 + mime_type).
 * @param {Array<{filename?: string, name?: string, content: Buffer|string, type?: string, mime_type?: string}>} attachments
 */
function toZeptoAttachments(attachments = []) {
    if (!attachments || attachments.length === 0) return [];
    return attachments.map((att) => {
        const buffer = Buffer.isBuffer(att.content)
            ? att.content
            : Buffer.from(att.content || '', typeof att.content === 'string' ? 'base64' : undefined);
        return {
            name: att.filename || att.name || 'attachment',
            content: buffer.toString('base64'),
            mime_type: att.type || att.mime_type || 'application/octet-stream'
        };
    });
}

/** Wrap plain-text body for htmlbody when no HTML tags are present */
function toHtmlBody(html, text) {
    const raw = (html || text || '').toString();
    if (!raw.trim()) return '<p></p>';
    if (/<[a-z][\s\S]*>/i.test(raw)) return raw;
    const escaped = raw
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    return `<div style="font-family:Arial,sans-serif;font-size:16px;line-height:1.6;color:#374151;white-space:pre-wrap;">${escaped}</div>`;
}

/**
 * Send email using ZeptoMail API
 * @param {string|Array} to - Recipient email(s)
 * @param {string} subject - Email subject
 * @param {string} text - Plain text content
 * @param {string} html - HTML content
 * @param {Date} sendAt - Optional scheduled send time (ZeptoMail doesn't support scheduling)
 * @param {Array} attachments - Optional attachments { filename, content: Buffer, type }
 * @returns {Promise} ZeptoMail response
 */
const sendEmail = async (to, subject, text, html, sendAt = null, attachments = []) => {
    try {
        // Ensure 'to' is an array for ZeptoMail
        const recipients = Array.isArray(to) ? to : [to];
        
        // Convert recipients to ZeptoMail format
        const toAddresses = recipients.map(email => ({
            email_address: {
                address: email,
                name: email.split('@')[0] // Use part before @ as name
            }
        }));

        const msg = {
            from: {
                address: "support@audienzo.com", // Use verified sender address
                name: "Audienzo"
            },
            to: toAddresses,
            subject: subject,
            htmlbody: toHtmlBody(html, text),
            textbody: text || html || ''
        };

        if (sendAt && sendAt > new Date()) {
            console.warn('⚠️ ZeptoMail does not support scheduled sending. Email will be sent immediately.');
        }

        const zeptoAttachments = toZeptoAttachments(attachments);
        if (zeptoAttachments.length > 0) {
            msg.attachments = zeptoAttachments;
        }

        const response = await client.sendMail(msg);
        return response;
    } catch (error) {
        console.error('❌ ZeptoMail error:', error);
        
        // Enhanced error logging for debugging
        if (error.response) {
            console.error('ZeptoMail Response Status:', error.response.status);
            console.error('ZeptoMail Response Headers:', error.response.headers);
            console.error('ZeptoMail Response Body:', error.response.body);
            
            // Specific error messages for common issues
            if (error.response.status === 403) {
                console.error('❌ 403 Forbidden - Check your ZeptoMail API key and sender verification');
                console.error('💡 Make sure:');
                console.error('   1. ZEPTO_API_KEY is correct and has Mail Send permissions');
                console.error('   2. EMAIL_USER is verified in ZeptoMail');
                console.error('   3. API key is not expired');
            } else if (error.response.status === 401) {
                console.error('❌ 401 Unauthorized - Invalid API key');
            } else if (error.response.status === 400) {
                console.error('❌ 400 Bad Request - Check email format and content');
            }
        }
        
        throw error;
    }
};

/**
 * Normalize and dedupe recipient email addresses.
 * @param {string|string[]|null|undefined} recipients
 * @returns {string[]}
 */
function normalizeRecipientList(recipients) {
    const list = Array.isArray(recipients) ? recipients : [recipients];
    const seen = new Set();
    const out = [];
    for (const raw of list) {
        const email = String(raw || '').trim().toLowerCase();
        if (!email || !/\S+@\S+\.\S+/.test(email) || seen.has(email)) continue;
        seen.add(email);
        out.push(email);
    }
    return out;
}

/**
 * Send bulk emails using ZeptoMail API — one separate message per recipient
 * so recipients cannot see each other's email addresses.
 * @param {Array} recipients - Array of recipient emails
 * @param {string} subject - Email subject
 * @param {string} text - Plain text content
 * @param {string} html - HTML content
 * @param {Date} sendAt - Optional scheduled send time
 * @param {Array} attachments - Optional attachments
 * @returns {Promise<{sent:number, failed:number, errors:Array}>}
 */
const sendBulkEmail = async (recipients, subject, text, html, sendAt = null, attachments = []) => {
    try {
        const uniqueRecipients = normalizeRecipientList(recipients);
        if (uniqueRecipients.length === 0) {
            throw new Error('No valid recipient email addresses provided.');
        }

        const errors = [];
        let sent = 0;

        for (const email of uniqueRecipients) {
            try {
                await sendEmail(email, subject, text, html, sendAt, attachments);
                sent += 1;
            } catch (err) {
                errors.push({ email, message: err?.message || String(err) });
                console.error(`❌ Failed to send email to ${email}:`, err);
            }
        }

        if (sent === 0) {
            const first = errors[0]?.message || 'Failed to send emails';
            throw new Error(first);
        }

        if (errors.length > 0) {
            console.warn(`Bulk email partial success: ${sent}/${uniqueRecipients.length} sent`);
        }

        return { sent, failed: errors.length, errors };
    } catch (error) {
        console.error('Bulk email error:', error);
        throw error;
    }
};

/**
 * Send scheduled reminder email
 * Note: ZeptoMail doesn't support scheduled sending, so this will send immediately
 * @param {string|Array} to - Recipient email(s)
 * @param {string} subject - Email subject
 * @param {string} text - Plain text content
 * @param {string} html - HTML content
 * @param {Date} scheduledTime - When to send the email (will be ignored)
 * @returns {Promise} ZeptoMail response
 */
const sendScheduledEmail = async (to, subject, text, html, scheduledTime) => {
    try {
        // Validate scheduled time is in the future (even though we'll send immediately)
        if (scheduledTime <= new Date()) {
            throw new Error('Scheduled time must be in the future');
        }

        console.warn('⚠️ ZeptoMail does not support scheduled sending. Email will be sent immediately.');
        return await sendEmail(to, subject, text, html, null);
    } catch (error) {
        console.error('Scheduled email error:', error);
        throw error;
    }
};

/**
 * Generate welcome email content for new subscribers (with invoice details)
 * @param {Object} userData - User information
 * @param {string} userData.fullName - User's full name
 * @param {string} userData.email - User's email
 * @param {string} planId - Plan ID (free, entry, enterprise, custom)
 * @param {string} planName - Display name of the plan
 * @param {string} currency - Currency (INR/USD)
 * @param {Date} activationDate - When the plan was activated
 * @param {Date} expiryDate - When the plan expires (null for entry plan)
 * @param {Object} invoiceDetails - Optional invoice details (invoiceId, invoiceUrl, basePrice, gstAmount, totalAmount)
 * @returns {Object} Email content with subject, text, and html
 */
const generateWelcomeEmail = (userData, planId, planName, currency = 'INR', activationDate = new Date(), expiryDate = null, invoiceDetails = null) => {
    const customerName = userData.fullName || userData.email.split('@')[0];
    const activationDateStr = activationDate.toLocaleDateString('en-US', { 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
    });
    
    // Plan-specific details
    let planDetails = {
        type: 'Free',
        duration: 'Unlimited',
        features: [
            'Host and manage events seamlessly',
            'Track registrations and attendees in real-time',
            'Send automated reminders and customize forms',
            'Basic analytics and event insights'
        ]
    };

    if (planId === 'entry') {
        planDetails = {
            type: 'Entry',
            duration: 'Per-event purchase',
            features: [
                'Host and manage events seamlessly',
                'Track registrations and attendees in real-time',
                'Send automated reminders and customize forms',
                'Access exclusive analytics and event insights',
                'Priority customer support'
            ]
        };
    } else if (planId === 'business') {
        planDetails = {
            type: 'Business',
            duration: '1 year',
            features: [
                'Host and manage events seamlessly',
                'Track registrations and attendees in real-time',
                'Send automated reminders and customize forms',
                'Access exclusive analytics and event insights',
                'Up to 25 in-person events per year',
                'Priority customer support'
            ]
        };
    } else if (planId === 'enterprise') {
        planDetails = {
            type: 'Enterprise',
            duration: '1 year',
            features: [
                'Host and manage events seamlessly',
                'Track registrations and attendees in real-time',
                'Send automated reminders and customize forms',
                'Access exclusive analytics and event insights',
                'Advanced reporting and analytics'
            ]
        };
    } else if (planId === 'custom') {
        planDetails = {
            type: 'Custom',
            duration: 'Custom duration',
            features: [
                'Host and manage events seamlessly',
                'Track registrations and attendees in real-time',
                'Send automated reminders and customize forms',
                'Access exclusive analytics and event insights',
                'Custom features and integrations',
                'Dedicated support team'
            ]
        };
    }

    const currencySymbol = currency === 'INR' ? '₹' : '$';
    const hasInvoice = invoiceDetails && invoiceDetails.invoiceId;
    
    const subject = `🎉 Welcome to Audienzo — Your ${planDetails.type} Plan is Now Active!${hasInvoice ? ' (Invoice Attached)' : ''}`;
    
    let invoiceText = '';
    if (hasInvoice) {
      invoiceText = `

📄 INVOICE DETAILS:

Invoice Number: ${invoiceDetails.invoiceId}
Issue Date: ${activationDateStr}
Plan: ${planName} Plan

Payment Breakdown:
- Base Price: ${currencySymbol}${invoiceDetails.basePrice.toFixed(2)}
- GST @ 18%: ${currencySymbol}${invoiceDetails.gstAmount.toFixed(2)}
- Total Amount: ${currencySymbol}${invoiceDetails.totalAmount.toFixed(2)}
- Currency: ${currency}

${invoiceDetails.invoiceUrl ? `View Invoice: ${invoiceDetails.invoiceUrl}` : ''}

Note: GST applicable as per government norms.`;
    }
    
    const text = `Subject: 🎉 Welcome to Audienzo — Your ${planDetails.type} Plan is Now Active!${hasInvoice ? ' (Invoice Attached)' : ''}

Hello ${customerName},

Thank you for choosing Audienzo! We're excited to let you know that your ${planDetails.type} Plan has been successfully activated.

Here are your plan details:

Plan Type: ${planDetails.type}
Duration: ${planDetails.duration}
Activation Date: ${activationDateStr}${expiryDate ? `\nExpiry Date: ${expiryDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}` : ''}${invoiceText}

With this plan, you'll be able to:

${planDetails.features.map(feature => `• ${feature}`).join('\n')}

If you ever need help managing your events or upgrading your plan, our support team is always here for you — just reply to this email or reach out to support@audienzo.com.

We're thrilled to have you as part of the Audienzo community — let's make your next event unforgettable!

Best regards,
The Audienzo Team
www.audienzo.com`;

    // Generate invoice section HTML if invoice details provided
    let invoiceHtml = '';
    if (hasInvoice) {
      invoiceHtml = `
            <!-- Invoice Section -->
            <div style="background-color: #fff3cd; padding: 20px; border-radius: 6px; margin-bottom: 25px; border-left: 4px solid #ffc107;">
                <h3 style="color: #333; margin: 0 0 15px 0; font-size: 18px;">📄 Invoice Details</h3>
                <div style="color: #555; font-size: 15px; line-height: 1.8;">
                    <p style="margin: 5px 0;"><strong>Invoice Number:</strong> ${invoiceDetails.invoiceId}</p>
                    <p style="margin: 5px 0;"><strong>Plan:</strong> ${planName} Plan</p>
                    <p style="margin: 5px 0;"><strong>Issue Date:</strong> ${activationDateStr}</p>
                    <div style="border-top: 1px solid #e0e0e0; margin: 15px 0; padding-top: 15px;">
                        <p style="margin: 5px 0;"><strong>Base Price:</strong> ${currencySymbol}${invoiceDetails.basePrice.toFixed(2)}</p>
                        <p style="margin: 5px 0;"><strong>GST @ 18%:</strong> ${currencySymbol}${invoiceDetails.gstAmount.toFixed(2)}</p>
                        <p style="margin: 10px 0 0 0; padding-top: 10px; border-top: 2px solid #333;"><strong>Total Amount:</strong> ${currencySymbol}${invoiceDetails.totalAmount.toFixed(2)}</p>
                    </div>
                    <p style="margin: 5px 0;"><strong>Currency:</strong> ${currency}</p>
                    ${invoiceDetails.invoiceUrl ? `<p style="margin: 10px 0 0 0;"><a href="${invoiceDetails.invoiceUrl}" style="display: inline-block; background-color: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px; font-weight: bold;">👉 View Invoice</a></p>` : ''}
                    <p style="margin: 10px 0 0 0; color: #856404; font-size: 14px;"><strong>Note:</strong> GST applicable as per government norms.</p>
                </div>
            </div>`;
    }
    
    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f8f9fa;">
        <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <!-- Header -->
            <div style="text-align: center; margin-bottom: 30px;">
                <h1 style="color: #007bff; margin: 0; font-size: 28px;">🎉 Welcome to Audienzo!</h1>
                <p style="color: #666; font-size: 18px; margin: 10px 0 0 0;">Your ${planDetails.type} Plan is Now Active!${hasInvoice ? ' 📄 Invoice Included' : ''}</p>
            </div>

            <!-- Greeting -->
            <div style="margin-bottom: 25px;">
                <p style="color: #333; font-size: 16px; line-height: 1.6; margin: 0;">Hello ${customerName},</p>
                <p style="color: #333; font-size: 16px; line-height: 1.6; margin: 10px 0 0 0;">Thank you for choosing Audienzo! We're excited to let you know that your <strong>${planDetails.type} Plan</strong> has been successfully activated.</p>
            </div>

            <!-- Plan Details -->
            <div style="background-color: #f8f9fa; padding: 20px; border-radius: 6px; margin-bottom: 25px;">
                <h3 style="color: #333; margin: 0 0 15px 0; font-size: 18px;">Here are your plan details:</h3>
                <div style="color: #555; font-size: 15px; line-height: 1.6;">
                    <p style="margin: 5px 0;"><strong>Plan Type:</strong> ${planDetails.type}</p>
                    <p style="margin: 5px 0;"><strong>Duration:</strong> ${planDetails.duration}</p>
                    <p style="margin: 5px 0;"><strong>Activation Date:</strong> ${activationDateStr}</p>
                    ${expiryDate ? `<p style="margin: 5px 0;"><strong>Expiry Date:</strong> ${expiryDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</p>` : ''}
                </div>
            </div>
            
            ${invoiceHtml}

            <!-- Features -->
            <div style="margin-bottom: 25px;">
                <h3 style="color: #333; margin: 0 0 15px 0; font-size: 18px;">With this plan, you'll be able to:</h3>
                <ul style="color: #555; font-size: 15px; line-height: 1.6; margin: 0; padding-left: 20px;">
                    ${planDetails.features.map(feature => `<li style="margin: 8px 0;">${feature}</li>`).join('')}
                </ul>
            </div>

            <!-- Support -->
            <div style="background-color: #e3f2fd; padding: 20px; border-radius: 6px; margin-bottom: 25px;">
                <p style="color: #333; font-size: 15px; line-height: 1.6; margin: 0;">If you ever need help managing your events or upgrading your plan, our support team is always here for you — just reply to this email or reach out to <a href="mailto:support@audienzo.com" style="color: #007bff; text-decoration: none;">support@audienzo.com</a>.</p>
            </div>

            <!-- Closing -->
            <div style="text-align: center; margin-bottom: 20px;">
                <p style="color: #333; font-size: 16px; line-height: 1.6; margin: 0;">We're thrilled to have you as part of the Audienzo community — let's make your next event unforgettable!</p>
            </div>

            <!-- Footer -->
            <div style="text-align: center; padding-top: 20px; border-top: 1px solid #e0e0e0;">
                <p style="color: #666; font-size: 14px; margin: 0;">Best regards,<br><strong>The Audienzo Team</strong></p>
                <p style="color: #666; font-size: 14px; margin: 10px 0 0 0;"><a href="https://www.audienzo.com" style="color: #007bff; text-decoration: none;">www.audienzo.com</a></p>
            </div>
        </div>
    </div>`;

    return { subject, text, html };
};

/**
 * Send welcome email to new subscriber (with optional invoice details)
 * @param {Object} userData - User information
 * @param {string} planId - Plan ID
 * @param {string} planName - Plan display name
 * @param {string} currency - Currency
 * @param {Date} activationDate - Activation date
 * @param {Date} expiryDate - Expiry date (null for entry plan)
 * @param {Object} invoiceDetails - Optional invoice details (invoiceId, invoiceUrl, basePrice, gstAmount, totalAmount)
 * @returns {Promise} Email send result
 */
const sendWelcomeEmail = async (userData, planId, planName, currency = 'INR', activationDate = new Date(), expiryDate = null, invoiceDetails = null) => {
    try {
        const emailContent = generateWelcomeEmail(userData, planId, planName, currency, activationDate, expiryDate, invoiceDetails);
        return await sendEmail(userData.email, emailContent.subject, emailContent.text, emailContent.html);
    } catch (error) {
        console.error('Error sending welcome email:', error);
        throw error;
    }
};

/**
 * Generate expiry reminder email content for paid plans
 * @param {Object} userData - User information
 * @param {string} planId - Plan ID (entry, enterprise, custom)
 * @param {string} planName - Display name of the plan
 * @param {Date} expiryDate - When the plan expires
 * @param {number} remainingDays - Days remaining until expiry
 * @returns {Object} Email content with subject, text, and html
 */
const generateExpiryReminderEmail = (userData, planId, planName, expiryDate, remainingDays = 7) => {
    const customerName = userData.fullName || userData.email.split('@')[0];
    const expiryDateStr = expiryDate.toLocaleDateString('en-US', { 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
    });
    
    // Get plan display name
    const planDisplayName = planName || (planId === 'entry' ? 'Entry' : 
                                       planId === 'business' ? 'Business' :
                                       planId === 'enterprise' ? 'Enterprise' : 
                                       planId === 'custom' ? 'Custom' : 'Paid');
    
    const subject = `⏰ Your Audienzo ${planDisplayName} Plan Expires Soon — Renew to Stay Connected`;
    
    const text = `Subject: ⏰ Your Audienzo ${planDisplayName} Plan Expires Soon — Renew to Stay Connected

Hello ${customerName},

We hope you've enjoyed using Audienzo to manage and grow your events! This is a friendly reminder that your ${planDisplayName} Plan is set to expire on ${expiryDateStr}, just ${remainingDays} days from now.

Here's a quick summary of your current plan:

Plan Type: ${planDisplayName}
Expiry Date: ${expiryDateStr}
Remaining Days: ${remainingDays} days

To continue enjoying uninterrupted access to your event dashboard, analytics, and communication tools, we recommend renewing your plan before it expires.

You can easily renew or upgrade your plan here:
👉 https://www.audienzo.com/pricing

If you have any questions or need assistance choosing a plan, our team is happy to help — just reply to this email or contact us at support@audienzo.com.

Thank you for being a valued part of the Audienzo community — we look forward to powering your next successful event!

Warm regards,
The Audienzo Team
www.audienzo.com`;

    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f8f9fa;">
        <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <!-- Header -->
            <div style="text-align: center; margin-bottom: 30px;">
                <h1 style="color: #ff6b35; margin: 0; font-size: 28px;">⏰ Plan Expiry Reminder</h1>
                <p style="color: #666; font-size: 18px; margin: 10px 0 0 0;">Your ${planDisplayName} Plan Expires Soon</p>
            </div>

            <!-- Greeting -->
            <div style="margin-bottom: 25px;">
                <p style="color: #333; font-size: 16px; line-height: 1.6; margin: 0;">Hello ${customerName},</p>
                <p style="color: #333; font-size: 16px; line-height: 1.6; margin: 10px 0 0 0;">We hope you've enjoyed using Audienzo to manage and grow your events! This is a friendly reminder that your <strong>${planDisplayName} Plan</strong> is set to expire on <strong>${expiryDateStr}</strong>, just <strong>${remainingDays} days</strong> from now.</p>
            </div>

            <!-- Plan Summary -->
            <div style="background-color: #fff3cd; padding: 20px; border-radius: 6px; margin-bottom: 25px; border-left: 4px solid #ff6b35;">
                <h3 style="color: #333; margin: 0 0 15px 0; font-size: 18px;">Here's a quick summary of your current plan:</h3>
                <div style="color: #555; font-size: 15px; line-height: 1.6;">
                    <p style="margin: 5px 0;"><strong>Plan Type:</strong> ${planDisplayName}</p>
                    <p style="margin: 5px 0;"><strong>Expiry Date:</strong> ${expiryDateStr}</p>
                    <p style="margin: 5px 0;"><strong>Remaining Days:</strong> ${remainingDays} days</p>
                </div>
            </div>

            <!-- Renewal CTA -->
            <div style="background-color: #e3f2fd; padding: 20px; border-radius: 6px; margin-bottom: 25px; text-align: center;">
                <p style="color: #333; font-size: 16px; line-height: 1.6; margin: 0 0 15px 0;">To continue enjoying uninterrupted access to your event dashboard, analytics, and communication tools, we recommend renewing your plan before it expires.</p>
                <a href="https://www.audienzo.com/pricing" style="display: inline-block; background-color: #007bff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px;">👉 Renew Your Plan</a>
            </div>

            <!-- Support -->
            <div style="background-color: #f8f9fa; padding: 20px; border-radius: 6px; margin-bottom: 25px;">
                <p style="color: #333; font-size: 15px; line-height: 1.6; margin: 0;">If you have any questions or need assistance choosing a plan, our team is happy to help — just reply to this email or reach out to <a href="mailto:support@audienzo.com" style="color: #007bff; text-decoration: none;">support@audienzo.com</a>.</p>
            </div>

            <!-- Closing -->
            <div style="text-align: center; margin-bottom: 20px;">
                <p style="color: #333; font-size: 16px; line-height: 1.6; margin: 0;">Thank you for being a valued part of the Audienzo community — we look forward to powering your next successful event!</p>
            </div>

            <!-- Footer -->
            <div style="text-align: center; padding-top: 20px; border-top: 1px solid #e0e0e0;">
                <p style="color: #666; font-size: 14px; margin: 0;">Warm regards,<br><strong>The Audienzo Team</strong></p>
                <p style="color: #666; font-size: 14px; margin: 10px 0 0 0;"><a href="https://www.audienzo.com" style="color: #007bff; text-decoration: none;">www.audienzo.com</a></p>
            </div>
        </div>
    </div>`;

    return { subject, text, html };
};

/**
 * Generate upgrade reminder email content for free plans
 * @param {Object} userData - User information
 * @param {Date} planSelectedAt - When the free plan was selected
 * @returns {Object} Email content with subject, text, and html
 */
const generateUpgradeReminderEmail = (userData, planSelectedAt) => {
    const customerName = userData.fullName || userData.email.split('@')[0];
    const planStartDateStr = planSelectedAt.toLocaleDateString('en-US', { 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
    });
    
    const subject = `🚀 Upgrade Your Audienzo Free Plan — Unlock Premium Features!`;
    
    const text = `Subject: 🚀 Upgrade Your Audienzo Free Plan — Unlock Premium Features!

Hello ${customerName},

We hope you've been enjoying your free Audienzo experience since ${planStartDateStr}! You've been using our platform for a while now, and we'd love to show you what's possible with our premium plans.

Here's what you're currently using:
- Free Plan (Unlimited webinars)
- Basic analytics and event insights
- Standard support

Upgrade to unlock these powerful features:
• Host in-person events (Entry Plan: Pay per event)
• Advanced analytics and reporting
• Priority customer support
• QR code check-ins
• Paid event capabilities
• And much more!

Ready to take your events to the next level?

👉 Upgrade to Entry Plan: https://www.audienzo.com/billing
👉 View all plans: https://www.audienzo.com/pricing

If you have any questions about our plans or need help choosing the right one, our team is here to help — just reply to this email or contact us at support@audienzo.com.

Thank you for being part of the Audienzo community — let's make your next event unforgettable!

Best regards,
The Audienzo Team
www.audienzo.com`;

    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f8f9fa;">
        <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <!-- Header -->
            <div style="text-align: center; margin-bottom: 30px;">
                <h1 style="color: #28a745; margin: 0; font-size: 28px;">🚀 Ready to Upgrade?</h1>
                <p style="color: #666; font-size: 18px; margin: 10px 0 0 0;">Unlock Premium Features with Audienzo</p>
            </div>

            <!-- Greeting -->
            <div style="margin-bottom: 25px;">
                <p style="color: #333; font-size: 16px; line-height: 1.6; margin: 0;">Hello ${customerName},</p>
                <p style="color: #333; font-size: 16px; line-height: 1.6; margin: 10px 0 0 0;">We hope you've been enjoying your free Audienzo experience since <strong>${planStartDateStr}</strong>! You've been using our platform for a while now, and we'd love to show you what's possible with our premium plans.</p>
            </div>

            <!-- Current vs Premium -->
            <div style="display: flex; margin-bottom: 25px; gap: 20px;">
                <!-- Current Plan -->
                <div style="flex: 1; background-color: #f8f9fa; padding: 20px; border-radius: 6px;">
                    <h3 style="color: #333; margin: 0 0 15px 0; font-size: 18px;">Your Current Plan</h3>
                    <ul style="color: #555; font-size: 15px; line-height: 1.6; margin: 0; padding-left: 20px;">
                        <li>Free Plan (Unlimited webinars)</li>
                        <li>Basic analytics and event insights</li>
                        <li>Standard support</li>
                    </ul>
                </div>
                
                <!-- Premium Features -->
                <div style="flex: 1; background-color: #e8f5e8; padding: 20px; border-radius: 6px;">
                    <h3 style="color: #333; margin: 0 0 15px 0; font-size: 18px;">Upgrade to Unlock</h3>
                    <ul style="color: #555; font-size: 15px; line-height: 1.6; margin: 0; padding-left: 20px;">
                        <li>Host in-person events (Entry: Pay per event)</li>
                        <li>Advanced analytics and reporting</li>
                        <li>Priority customer support</li>
                        <li>QR code check-ins</li>
                        <li>Paid event capabilities</li>
                        <li>And much more!</li>
                    </ul>
                </div>
            </div>

            <!-- CTA Buttons -->
            <div style="text-align: center; margin-bottom: 25px;">
                <p style="color: #333; font-size: 16px; line-height: 1.6; margin: 0 0 20px 0;">Ready to take your events to the next level?</p>
                <div style="display: flex; gap: 15px; justify-content: center; flex-wrap: wrap;">
                    <a href="https://www.audienzo.com/billing" style="display: inline-block; background-color: #007bff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px;">👉 Upgrade to Entry Plan</a>
                    <a href="https://www.audienzo.com/pricing" style="display: inline-block; background-color: #6c757d; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px;">View All Plans</a>
                </div>
            </div>

            <!-- Support -->
            <div style="background-color: #f8f9fa; padding: 20px; border-radius: 6px; margin-bottom: 25px;">
                <p style="color: #333; font-size: 15px; line-height: 1.6; margin: 0;">If you have any questions about our plans or need help choosing the right one, our team is here to help — just reply to this email or reach out to <a href="mailto:support@audienzo.com" style="color: #007bff; text-decoration: none;">support@audienzo.com</a>.</p>
            </div>

            <!-- Closing -->
            <div style="text-align: center; margin-bottom: 20px;">
                <p style="color: #333; font-size: 16px; line-height: 1.6; margin: 0;">Thank you for being part of the Audienzo community — let's make your next event unforgettable!</p>
            </div>

            <!-- Footer -->
            <div style="text-align: center; padding-top: 20px; border-top: 1px solid #e0e0e0;">
                <p style="color: #666; font-size: 14px; margin: 0;">Best regards,<br><strong>The Audienzo Team</strong></p>
                <p style="color: #666; font-size: 14px; margin: 10px 0 0 0;"><a href="https://www.audienzo.com" style="color: #007bff; text-decoration: none;">www.audienzo.com</a></p>
            </div>
        </div>
    </div>`;

    return { subject, text, html };
};

/**
 * Send expiry reminder email for paid plans
 * @param {Object} userData - User information
 * @param {string} planId - Plan ID
 * @param {string} planName - Plan display name
 * @param {Date} expiryDate - Expiry date
 * @param {number} remainingDays - Days remaining until expiry
 * @returns {Promise} Email send result
 */
const sendExpiryReminderEmail = async (userData, planId, planName, expiryDate, remainingDays = 7) => {
    try {
        const emailContent = generateExpiryReminderEmail(userData, planId, planName, expiryDate, remainingDays);
        return await sendEmail(userData.email, emailContent.subject, emailContent.text, emailContent.html);
    } catch (error) {
        console.error('Error sending expiry reminder email:', error);
        throw error;
    }
};

/**
 * Send upgrade reminder email for free plans
 * @param {Object} userData - User information
 * @param {Date} planSelectedAt - When the free plan was selected
 * @returns {Promise} Email send result
 */
const sendUpgradeReminderEmail = async (userData, planSelectedAt) => {
    try {
        const emailContent = generateUpgradeReminderEmail(userData, planSelectedAt);
        return await sendEmail(userData.email, emailContent.subject, emailContent.text, emailContent.html);
    } catch (error) {
        console.error('Error sending upgrade reminder email:', error);
        throw error;
    }
};

/**
 * Generate usage limit alert email content
 * @param {Object} userData - User information
 * @param {string} limitType - Type of limit reached (events, contacts, emails)
 * @param {Object} usageInfo - Usage information
 * @param {string} planId - Current plan ID
 * @returns {Object} Email content with subject, text, and html
 */
const generateUsageAlertEmail = (userData, limitType, usageInfo, planId) => {
    const customerName = userData.fullName || userData.email.split('@')[0];
    
    // Get plan display name
    const planDisplayName = planId === 'free' ? 'Free' : 
                           planId === 'entry' ? 'Entry' : 
                           planId === 'business' ? 'Business' :
                           planId === 'enterprise' ? 'Enterprise' : 
                           planId === 'custom' ? 'Custom' : 'Current';
    
    // Limit type specific content
    let limitDetails = {};
    let upgradeMessage = '';
    let featureName = '';
    
    switch (limitType) {
        case 'events':
            limitDetails = {
                current: usageInfo.current,
                limit: usageInfo.limit,
                type: 'in-person events'
            };
            upgradeMessage = 'Upgrade to create unlimited in-person events and unlock premium features!';
            featureName = 'Event Creation';
            break;
        case 'contacts':
            limitDetails = {
                current: usageInfo.current,
                limit: usageInfo.limit,
                type: 'contacts'
            };
            upgradeMessage = 'Upgrade to manage more contacts and grow your audience!';
            featureName = 'Contact Management';
            break;
        case 'emails':
            limitDetails = {
                current: usageInfo.current,
                limit: usageInfo.limit,
                type: 'emails'
            };
            upgradeMessage = 'Upgrade to send unlimited emails and reach more attendees!';
            featureName = 'Email Marketing';
            break;
    }
    
    const subject = `⚠️ Usage Limit Reached - ${featureName} Limit Exceeded`;
    
    const text = `Subject: ⚠️ Usage Limit Reached - ${featureName} Limit Exceeded

Hello ${customerName},

You've reached your ${limitDetails.type} limit on your ${planDisplayName} plan.

Current Usage: ${limitDetails.current} / ${limitDetails.limit} ${limitDetails.type}

${upgradeMessage}

Here's what you can do:

1. Upgrade your plan to unlock higher limits
2. Review your current usage in the billing dashboard
3. Contact support if you need assistance

Ready to upgrade? Visit your billing dashboard:
👉 https://www.audienzo.com/billing

Need help choosing the right plan? Our team is here to help!
📧 support@audienzo.com

Best regards,
The Audienzo Team
www.audienzo.com`;

    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f8f9fa;">
        <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <!-- Header -->
            <div style="text-align: center; margin-bottom: 30px;">
                <h1 style="color: #dc2626; margin: 0; font-size: 28px;">⚠️ Usage Limit Reached</h1>
                <p style="color: #666; font-size: 18px; margin: 10px 0 0 0;">${featureName} Limit Exceeded</p>
            </div>

            <!-- Greeting -->
            <div style="margin-bottom: 25px;">
                <p style="color: #333; font-size: 16px; line-height: 1.6; margin: 0;">Hello ${customerName},</p>
                <p style="color: #333; font-size: 16px; line-height: 1.6; margin: 10px 0 0 0;">You've reached your <strong>${limitDetails.type}</strong> limit on your <strong>${planDisplayName} plan</strong>.</p>
            </div>

            <!-- Usage Alert -->
            <div style="background-color: #fef2f2; padding: 20px; border-radius: 6px; margin-bottom: 25px; border-left: 4px solid #dc2626;">
                <h3 style="color: #333; margin: 0 0 15px 0; font-size: 18px;">Current Usage:</h3>
                <div style="color: #555; font-size: 15px; line-height: 1.6;">
                    <p style="margin: 5px 0;"><strong>${limitDetails.type}:</strong> ${limitDetails.current} / ${limitDetails.limit}</p>
                    <p style="margin: 5px 0; color: #dc2626;"><strong>Status:</strong> Limit Exceeded</p>
                </div>
            </div>

            <!-- Upgrade Message -->
            <div style="background-color: #e3f2fd; padding: 20px; border-radius: 6px; margin-bottom: 25px; text-align: center;">
                <p style="color: #333; font-size: 16px; line-height: 1.6; margin: 0 0 15px 0;">${upgradeMessage}</p>
                <a href="https://www.audienzo.com/billing" style="display: inline-block; background-color: #007bff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px;">👉 Upgrade Your Plan</a>
            </div>

            <!-- Next Steps -->
            <div style="background-color: #f8f9fa; padding: 20px; border-radius: 6px; margin-bottom: 25px;">
                <h3 style="color: #333; margin: 0 0 15px 0; font-size: 18px;">What you can do:</h3>
                <ul style="color: #555; font-size: 15px; line-height: 1.6; margin: 0; padding-left: 20px;">
                    <li style="margin: 8px 0;">Upgrade your plan to unlock higher limits</li>
                    <li style="margin: 8px 0;">Review your current usage in the billing dashboard</li>
                    <li style="margin: 8px 0;">Contact support if you need assistance</li>
                </ul>
            </div>

            <!-- Support -->
            <div style="background-color: #f8f9fa; padding: 20px; border-radius: 6px; margin-bottom: 25px;">
                <p style="color: #333; font-size: 15px; line-height: 1.6; margin: 0;">Need help choosing the right plan? Our team is here to help — just reply to this email or reach out to <a href="mailto:support@audienzo.com" style="color: #007bff; text-decoration: none;">support@audienzo.com</a>.</p>
            </div>

            <!-- Closing -->
            <div style="text-align: center; margin-bottom: 20px;">
                <p style="color: #333; font-size: 16px; line-height: 1.6; margin: 0;">Thank you for using Audienzo — let's help you reach your event goals!</p>
            </div>

            <!-- Footer -->
            <div style="text-align: center; padding-top: 20px; border-top: 1px solid #e0e0e0;">
                <p style="color: #666; font-size: 14px; margin: 0;">Best regards,<br><strong>The Audienzo Team</strong></p>
                <p style="color: #666; font-size: 14px; margin: 10px 0 0 0;"><a href="https://www.audienzo.com" style="color: #007bff; text-decoration: none;">www.audienzo.com</a></p>
            </div>
        </div>
    </div>`;

    return { subject, text, html };
};

/**
 * Send usage limit alert email
 * @param {Object} userData - User information
 * @param {string} limitType - Type of limit reached
 * @param {Object} usageInfo - Usage information
 * @param {string} planId - Current plan ID
 * @returns {Promise} Email send result
 */
const sendUsageAlertEmail = async (userData, limitType, usageInfo, planId) => {
    try {
        const emailContent = generateUsageAlertEmail(userData, limitType, usageInfo, planId);
        return await sendEmail(userData.email, emailContent.subject, emailContent.text, emailContent.html);
    } catch (error) {
        console.error('Error sending usage alert email:', error);
        throw error;
    }
};

/**
 * Generate invoice email content
 * @param {Object} userData - User information
 * @param {string} invoiceId - Invoice ID
 * @param {string} invoiceUrl - Invoice URL
 * @param {string} planName - Plan name
 * @param {number} basePrice - Base price
 * @param {number} gstAmount - GST amount
 * @param {number} totalAmount - Total amount
 * @param {string} currency - Currency code
 * @param {Date} issueDate - Invoice issue date
 * @returns {Object} Email content with subject, text, and html
 */
const generateInvoiceEmail = (userData, invoiceId, invoiceUrl, planName, basePrice, gstAmount, totalAmount, currency = 'INR', issueDate = new Date()) => {
    const customerName = userData.fullName || userData.email.split('@')[0];
    const issueDateStr = issueDate.toLocaleDateString('en-US', { 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
    });
    const currencySymbol = currency === 'INR' ? '₹' : '$';
    
    const subject = `📄 Your Invoice for ${planName} Plan - Payment Successful`;
    
    const text = `Subject: 📄 Your Invoice for ${planName} Plan - Payment Successful

Hello ${customerName},

Thank you for your payment! Your subscription to the ${planName} Plan has been successfully activated.

Invoice Details:
- Invoice Number: ${invoiceId}
- Plan: ${planName} Plan
- Issue Date: ${issueDateStr}
- Base Price: ${currencySymbol}${basePrice.toFixed(2)}
- GST @ 18%: ${currencySymbol}${gstAmount.toFixed(2)}
- Total Amount: ${currencySymbol}${totalAmount.toFixed(2)}
- Currency: ${currency}

You can view and download your invoice here:
👉 ${invoiceUrl || 'Available in your billing dashboard'}

GST applicable as per government norms.

This invoice will also be available in your billing dashboard for future reference.

If you have any questions about your invoice or subscription, please contact us at support@audienzo.com.

Thank you for choosing Audienzo!

Best regards,
The Audienzo Team
www.audienzo.com`;

    const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f8f9fa;">
        <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
            <!-- Header -->
            <div style="text-align: center; margin-bottom: 30px;">
                <h1 style="color: #28a745; margin: 0; font-size: 28px;">📄 Payment Successful!</h1>
                <p style="color: #666; font-size: 18px; margin: 10px 0 0 0;">Your Invoice for ${planName} Plan</p>
            </div>

            <!-- Greeting -->
            <div style="margin-bottom: 25px;">
                <p style="color: #333; font-size: 16px; line-height: 1.6; margin: 0;">Hello ${customerName},</p>
                <p style="color: #333; font-size: 16px; line-height: 1.6; margin: 10px 0 0 0;">Thank you for your payment! Your subscription to the <strong>${planName} Plan</strong> has been successfully activated.</p>
            </div>

            <!-- Invoice Details -->
            <div style="background-color: #f8f9fa; padding: 20px; border-radius: 6px; margin-bottom: 25px;">
                <h3 style="color: #333; margin: 0 0 15px 0; font-size: 18px;">Invoice Details:</h3>
                <div style="color: #555; font-size: 15px; line-height: 1.8;">
                    <p style="margin: 5px 0;"><strong>Invoice Number:</strong> ${invoiceId}</p>
                    <p style="margin: 5px 0;"><strong>Plan:</strong> ${planName} Plan</p>
                    <p style="margin: 5px 0;"><strong>Issue Date:</strong> ${issueDateStr}</p>
                    <div style="border-top: 1px solid #e0e0e0; margin: 15px 0; padding-top: 15px;">
                        <p style="margin: 5px 0;"><strong>Base Price:</strong> ${currencySymbol}${basePrice.toFixed(2)}</p>
                        <p style="margin: 5px 0;"><strong>GST @ 18%:</strong> ${currencySymbol}${gstAmount.toFixed(2)}</p>
                        <p style="margin: 10px 0 0 0; padding-top: 10px; border-top: 2px solid #333;"><strong>Total Amount:</strong> ${currencySymbol}${totalAmount.toFixed(2)}</p>
                    </div>
                    <p style="margin: 5px 0;"><strong>Currency:</strong> ${currency}</p>
                </div>
            </div>

            <!-- Invoice Download -->
            <div style="background-color: #e3f2fd; padding: 20px; border-radius: 6px; margin-bottom: 25px; text-align: center;">
                <p style="color: #333; font-size: 16px; line-height: 1.6; margin: 0 0 15px 0;">You can view and download your invoice:</p>
                ${invoiceUrl ? `<a href="${invoiceUrl}" style="display: inline-block; background-color: #007bff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px;">👉 View Invoice</a>` : '<p style="color: #666; font-size: 14px;">Available in your billing dashboard</p>'}
            </div>

            <!-- GST Note -->
            <div style="background-color: #fff3cd; padding: 15px; border-radius: 6px; margin-bottom: 25px; border-left: 4px solid #ffc107;">
                <p style="color: #856404; font-size: 14px; line-height: 1.6; margin: 0;"><strong>Note:</strong> GST applicable as per government norms.</p>
            </div>

            <!-- Footer -->
            <div style="background-color: #f8f9fa; padding: 20px; border-radius: 6px; margin-bottom: 25px;">
                <p style="color: #333; font-size: 15px; line-height: 1.6; margin: 0;">This invoice will also be available in your billing dashboard for future reference.</p>
                <p style="color: #333; font-size: 15px; line-height: 1.6; margin: 10px 0 0 0;">If you have any questions about your invoice or subscription, please contact us at <a href="mailto:support@audienzo.com" style="color: #007bff; text-decoration: none;">support@audienzo.com</a>.</p>
            </div>

            <!-- Closing -->
            <div style="text-align: center; margin-bottom: 20px;">
                <p style="color: #333; font-size: 16px; line-height: 1.6; margin: 0;">Thank you for choosing Audienzo!</p>
            </div>

            <!-- Footer -->
            <div style="text-align: center; padding-top: 20px; border-top: 1px solid #e0e0e0;">
                <p style="color: #666; font-size: 14px; margin: 0;">Best regards,<br><strong>The Audienzo Team</strong></p>
                <p style="color: #666; font-size: 14px; margin: 10px 0 0 0;"><a href="https://www.audienzo.com" style="color: #007bff; text-decoration: none;">www.audienzo.com</a></p>
            </div>
        </div>
    </div>`;

    return { subject, text, html };
};

/**
 * Send invoice email to user
 * @param {Object} userData - User information
 * @param {string} invoiceId - Invoice ID
 * @param {string} invoiceUrl - Invoice URL
 * @param {string} planName - Plan name
 * @param {number} basePrice - Base price
 * @param {number} gstAmount - GST amount
 * @param {number} totalAmount - Total amount
 * @param {string} currency - Currency code
 * @param {Date} issueDate - Invoice issue date
 * @returns {Promise} Email send result
 */
const sendInvoiceEmail = async (userData, invoiceId, invoiceUrl, planName, basePrice, gstAmount, totalAmount, currency = 'INR', issueDate = new Date()) => {
    try {
        const emailContent = generateInvoiceEmail(userData, invoiceId, invoiceUrl, planName, basePrice, gstAmount, totalAmount, currency, issueDate);
        return await sendEmail(userData.email, emailContent.subject, emailContent.text, emailContent.html);
    } catch (error) {
        console.error('Error sending invoice email:', error);
        throw error;
    }
};

module.exports = {
    sendEmail,
    sendBulkEmail,
    sendScheduledEmail,
    generateWelcomeEmail,
    sendWelcomeEmail,
    generateExpiryReminderEmail,
    sendExpiryReminderEmail,
    generateUpgradeReminderEmail,
    sendUpgradeReminderEmail,
    generateUsageAlertEmail,
    sendUsageAlertEmail,
    generateInvoiceEmail,
    sendInvoiceEmail
};