const crypto = require('crypto');

function getPepper() {
  return process.env.OTP_PEPPER || process.env.SESSION_SECRET || 'change_me_in_production';
}

function hashOtpChallenge(email, otpPlain) {
  const e = String(email || '').trim().toLowerCase();
  const o = String(otpPlain || '').replace(/\s+/g, '').trim();
  return crypto.createHmac('sha256', getPepper()).update(`otp:${e}:${o}`).digest('hex');
}

function hashVerificationToken(token) {
  const t = String(token || '').trim();
  return crypto.createHmac('sha256', getPepper()).update(`proof:${t}`).digest('hex');
}

function timingSafeEqualStr(a, b) {
  try {
    const ba = Buffer.from(String(a), 'utf8');
    const bb = Buffer.from(String(b), 'utf8');
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

module.exports = {
  hashOtpChallenge,
  hashVerificationToken,
  timingSafeEqualStr,
};
