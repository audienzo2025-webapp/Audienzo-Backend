const { sendEmail } = require('./emailService');

/**
 * Send the standard registration confirmation email (virtual: join details;
 * in-person: includes check-in QR image URL in HTML).
 *
 * @param {object} conference — Mongoose doc or lean object
 * @param {string} email
 * @param {object} savedFormData — registration formData (uses .name for greeting)
 * @param {string} qrCodeUrl — required for non-virtual events (Cloudinary URL)
 */
async function sendRegistrationConfirmationEmail(conference, email, savedFormData, qrCodeUrl) {
  const form = savedFormData && typeof savedFormData === 'object' ? savedFormData : {};
  const nameField = form.name || 'Participant';
  const subject = `Registration Confirmation - ${conference.title}`;
  let htmlContent;
  let textContent;
  if (conference.isVirtual) {
    const joinLink = conference.location;
    const eventDate = conference.startDate;
    const eventTime = conference.time;
    const organizerName = conference.organizer || 'Event Organizer';
    htmlContent = `
                <html>
                <head>
                    <meta charset="utf-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                </head>
                <body style="margin: 0; padding: 20px; background-color: #f8fafc; font-family: Arial, sans-serif;">
                    <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); padding: 40px;">
                        <h1 style="color: #007bff; font-size: 24px; margin: 0 0 20px 0; text-align: center;">Registration Confirmation</h1>
                        <p style="font-size: 16px; line-height: 1.6; color: #374151; margin: 0 0 16px 0;">Dear ${nameField},</p>
                        <p style="font-size: 16px; line-height: 1.6; color: #374151; margin: 0 0 20px 0;">Thank you for registering for <strong style="color: #1F2937;">"${conference.title}"</strong>! 🎉</p>
                        <div style="background-color: #F3F4F6; padding: 24px; border-radius: 8px; margin: 24px 0; border-left: 4px solid #4F46E5;">
                            <h3 style="color: #374151; margin: 0 0 16px 0; font-size: 18px;">Your Event Details:</h3>
                            <p style="margin: 8px 0; font-size: 16px; color: #374151;">
                                <span style="font-size: 18px; margin-right: 8px;">📅</span>
                                <strong style="color: #1F2937;">Date:</strong> ${eventDate}
                            </p>
                            <p style="margin: 8px 0; font-size: 16px; color: #374151;">
                                <span style="font-size: 18px; margin-right: 8px;">⏰</span>
                                <strong style="color: #1F2937;">Time:</strong> ${eventTime}
                            </p>
                            <p style="margin: 8px 0; font-size: 16px; color: #374151;">
                                <span style="font-size: 18px; margin-right: 8px;">🔗</span>
                                <strong style="color: #1F2937;">Join Link:</strong>
                                <a href="${joinLink}" style="color: #007bff; text-decoration: none; word-break: break-all;">${joinLink}</a>
                            </p>
                        </div>
                        <p style="font-size: 16px; line-height: 1.6; color: #374151; margin: 20px 0;">Please make sure to join a few minutes early to ensure a smooth experience.</p>
                        <p style="font-size: 16px; line-height: 1.6; color: #374151; margin: 20px 0 0 0;">Best regards,<br><strong style="color: #1F2937;">${organizerName}</strong></p>
                    </div>
                </body>
                </html>
            `;
    textContent = `Dear ${nameField},\n\nThank you for registering for "${conference.title}"! 🎉\n\nHere are your event details:\n\n📅 Date: ${eventDate}\n⏰ Time: ${eventTime}\n🔗 Join Link: ${joinLink}\n\nPlease make sure to join a few minutes early to ensure a smooth experience.\n\nBest regards,\n${organizerName}`;
  } else {
    htmlContent = `
                <html>
                <head>
                    <meta charset="utf-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                </head>
                <body style="margin: 0; padding: 20px; background-color: #f8fafc; font-family: Arial, sans-serif;">
                    <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); padding: 40px;">
                        <h1 style="color: #007bff; font-size: 24px; margin: 0 0 20px 0; text-align: center;">Registration Confirmation</h1>
                        <p style="font-size: 16px; line-height: 1.6; color: #374151; margin: 0 0 16px 0;">Dear ${nameField},</p>
                        <p style="font-size: 16px; line-height: 1.6; color: #374151; margin: 0 0 20px 0;">You have successfully registered for <strong style="color: #1F2937;">"${conference.title}"</strong>!</p>
                        <p style="font-size: 16px; line-height: 1.6; color: #374151; margin: 0 0 20px 0;">Your QR code for event check-in is below:</p>
                        <div style="text-align: center; margin: 30px 0; padding: 20px; background-color: #F9FAFB; border-radius: 8px;">
                            <img src="${qrCodeUrl}" alt="QR Code" style="max-width: 250px; height: auto; border: 2px solid #E5E7EB; border-radius: 8px; display: block; margin: 0 auto;">
                        </div>
                        <p style="font-size: 16px; line-height: 1.6; color: #374151; margin: 20px 0; text-align: center;">Please bring this QR code with you to the event for easy check-in.</p>
                    </div>
                </body>
                </html>
            `;
    textContent = `Dear ${nameField},\n\nYou have successfully registered for "${conference.title}"!\n\nYour QR code for event check-in has been attached. Please bring this QR code with you to the event for easy check-in.`;
  }
  await sendEmail(email, subject, textContent, htmlContent);
}

module.exports = { sendRegistrationConfirmationEmail };
