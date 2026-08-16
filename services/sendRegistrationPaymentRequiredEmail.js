const { sendEmail } = require('./emailService');

function getFrontendBaseUrl() {
  const isProduction = process.env.NODE_ENV === 'production';
  return isProduction ? (process.env.FRONTEND_URL || 'https://www.audienzo.com') : 'http://localhost:4200';
}

/**
 * Notify a registrant that payment is now required for an event they registered for when it was free.
 */
async function sendRegistrationPaymentRequiredEmail(conference, email, slugOrId) {
  const eventTitle = conference?.title || 'your event';
  const slug = slugOrId || conference?.urlSlug || conference?.slug || conference?._id;
  const payUrl = `${getFrontendBaseUrl()}/register/${slug}?completePayment=1`;

  const subject = `Complete payment details for ${eventTitle}`;
  const textContent = `Dear participant,

The event "${eventTitle}" now requires payment to confirm your registration.

Please open the link below, sign in with the same email you used when registering, and submit your payment details:

${payUrl}

Thank you,
Audienzo`;

  const htmlContent = `
    <html>
    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #374151; padding: 20px;">
      <div style="max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 32px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
        <h1 style="color: #1a0dab; font-size: 22px; margin: 0 0 16px;">Payment required</h1>
        <p>The event <strong>${eventTitle}</strong> is now a paid event. Please complete your payment details to stay registered.</p>
        <p style="margin: 28px 0;">
          <a href="${payUrl}" style="display: inline-block; background: #1a0dab; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">Complete payment details</a>
        </p>
        <p style="font-size: 14px; color: #6b7280;">If the button does not work, copy this link: ${payUrl}</p>
      </div>
    </body>
    </html>`;

  await sendEmail(email, subject, textContent, htmlContent);
}

module.exports = { sendRegistrationPaymentRequiredEmail };
