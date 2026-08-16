const { sendEmail } = require('./emailService');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getRegistrantDisplayName(formData, email) {
  const form = formData && typeof formData === 'object' ? formData : {};
  if (form.name && String(form.name).trim()) {
    return String(form.name).trim();
  }
  const first = form.firstName || form.first_name || form.text_field || '';
  const last = form.lastName || form.last_name || form.text_field_1 || '';
  const combined = `${first} ${last}`.trim();
  if (combined) {
    return combined;
  }
  return (email || 'Participant').toString().trim();
}

function getRegistrantPhone(formData) {
  const form = formData && typeof formData === 'object' ? formData : {};
  return (
    form.phone ||
    form.phoneNumber ||
    form.mobile ||
    form.contactNumber ||
    form.text_field_2 ||
    ''
  ).toString().trim();
}

/**
 * Send a personalized attendance email with this registrant's unique check-in QR code.
 */
async function sendAttendanceQrEmail(conference, registration, qrCodeUrl) {
  const form =
    registration?.formData && typeof registration.formData === 'object'
      ? registration.formData
      : {};
  const email = (registration?.email || '').trim();
  const nameField = getRegistrantDisplayName(form, email);
  const phone = getRegistrantPhone(form);
  const eventTitle = escapeHtml(conference?.title || 'your event');
  const eventDate = escapeHtml(conference?.startDate || conference?.date || 'To be announced');
  const eventTime = escapeHtml(conference?.time || '');
  const location = escapeHtml(conference?.location || conference?.eventLocation || '');
  const organizerName = escapeHtml(conference?.organizer || 'Event Organizer');

  const subject = `Your check-in QR — ${conference?.title || 'Event'}`;

  const detailsRows = [
    `<p style="margin:8px 0;font-size:15px;color:#374151;"><strong>Name:</strong> ${escapeHtml(nameField)}</p>`,
    `<p style="margin:8px 0;font-size:15px;color:#374151;"><strong>Email:</strong> ${escapeHtml(email)}</p>`,
  ];
  if (phone) {
    detailsRows.push(
      `<p style="margin:8px 0;font-size:15px;color:#374151;"><strong>Phone:</strong> ${escapeHtml(phone)}</p>`
    );
  }
  detailsRows.push(
    `<p style="margin:8px 0;font-size:15px;color:#374151;"><strong>Date:</strong> ${eventDate}${eventTime ? ` · ${eventTime}` : ''}</p>`
  );
  if (location) {
    detailsRows.push(
      `<p style="margin:8px 0;font-size:15px;color:#374151;"><strong>Location:</strong> ${location}</p>`
    );
  }

  const htmlContent = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:20px;background-color:#f8fafc;font-family:Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;background-color:#ffffff;border-radius:8px;box-shadow:0 4px 6px rgba(0,0,0,0.1);padding:40px;">
    <h1 style="color:#0891b2;font-size:24px;margin:0 0 20px 0;text-align:center;">Your attendance QR code</h1>
    <p style="font-size:16px;line-height:1.6;color:#374151;margin:0 0 16px 0;">Dear ${escapeHtml(nameField)},</p>
    <p style="font-size:16px;line-height:1.6;color:#374151;margin:0 0 20px 0;">
      Here is your personal check-in QR code for <strong>${eventTitle}</strong>. This code is unique to you — please do not share it.
    </p>
    <div style="background-color:#F3F4F6;padding:20px;border-radius:8px;margin:20px 0;border-left:4px solid #0891b2;">
      <h3 style="color:#374151;margin:0 0 12px 0;font-size:16px;">Your registration details</h3>
      ${detailsRows.join('\n')}
    </div>
    <div style="text-align:center;margin:30px 0;padding:20px;background-color:#F9FAFB;border-radius:8px;">
      <img src="${qrCodeUrl}" alt="Check-in QR code" style="max-width:250px;height:auto;border:2px solid #E5E7EB;border-radius:8px;display:block;margin:0 auto;">
    </div>
    <p style="font-size:15px;line-height:1.6;color:#374151;margin:20px 0;text-align:center;">
      Show this QR code at the event entrance for attendance check-in.
    </p>
    <p style="font-size:15px;line-height:1.6;color:#374151;margin:20px 0 0 0;">
      Best regards,<br><strong>${organizerName}</strong>
    </p>
  </div>
</body>
</html>`;

  const textLines = [
    `Dear ${nameField},`,
    '',
    `Your personal check-in QR code for "${conference?.title || 'your event'}".`,
    '',
    `Name: ${nameField}`,
    `Email: ${email}`,
  ];
  if (phone) {
    textLines.push(`Phone: ${phone}`);
  }
  textLines.push(
    `Date: ${conference?.startDate || conference?.date || 'To be announced'}${eventTime ? ` · ${conference?.time || ''}` : ''}`,
    '',
    `QR code image: ${qrCodeUrl}`,
    '',
    'Show this QR code at the event for attendance check-in.',
    '',
    organizerName
  );

  await sendEmail(email, subject, textLines.join('\n'), htmlContent);
}

module.exports = {
  sendAttendanceQrEmail,
  getRegistrantDisplayName,
};
