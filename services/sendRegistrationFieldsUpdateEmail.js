const { sendEmail } = require('./emailService');

function getFrontendBaseUrl() {
  const isProduction = process.env.NODE_ENV === 'production';
  return isProduction ? (process.env.FRONTEND_URL || 'https://www.audienzo.com') : 'http://localhost:4200';
}

/**
 * Notify a registrant that new registration fields were added and must be completed.
 */
async function sendRegistrationFieldsUpdateEmail(conference, email, pendingFieldLabels, slugOrId) {
  const eventTitle = conference?.title || 'your event';
  const slug = slugOrId || conference?.urlSlug || conference?.slug || conference?._id;
  const completeUrl = `${getFrontendBaseUrl()}/register/${slug}`;
  const fieldList = (pendingFieldLabels || []).map((l) => `• ${l}`).join('\n');
  const fieldListHtml = (pendingFieldLabels || []).map((l) => `<li>${l}</li>`).join('');

  const subject = `Action required: complete your registration for ${eventTitle}`;
  const textContent = `Dear participant,

The organizer has updated the registration form for "${eventTitle}".

Please complete the following new field(s):
${fieldList || '• (see registration page)'}

Open your registration page and sign in with the same email you used when registering:
${completeUrl}

Thank you,
Audienzo`;

  const htmlContent = `
    <html>
    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #374151; padding: 20px;">
      <div style="max-width: 600px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 32px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
        <h1 style="color: #1a0dab; font-size: 22px; margin: 0 0 16px;">Registration form updated</h1>
        <p>The organizer has added new field(s) to the registration form for <strong>${eventTitle}</strong>.</p>
        <p>Please complete these field(s) using the same email you registered with:</p>
        <ul style="padding-left: 20px;">${fieldListHtml || '<li>See the registration page for details</li>'}</ul>
        <p style="margin: 28px 0;">
          <a href="${completeUrl}" style="display: inline-block; background: #1a0dab; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">Complete missing fields</a>
        </p>
        <p style="font-size: 14px; color: #6b7280;">If the button does not work, copy this link: ${completeUrl}</p>
      </div>
    </body>
    </html>`;

  await sendEmail(email, subject, textContent, htmlContent);
}

module.exports = { sendRegistrationFieldsUpdateEmail };
