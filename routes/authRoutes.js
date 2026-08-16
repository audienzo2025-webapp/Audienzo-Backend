require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Registration = require('../models/Registration');
const crypto = require('crypto');
const { uploadImage } = require('../config/cloudinary');
const { sendEmail, sendWelcomeEmail } = require('../services/emailService');
const UsageAlertService = require('../services/usageAlertService');
const OtpChallenge = require('../models/OtpChallenge');
const EmailVerificationProof = require('../models/EmailVerificationProof');
const {
    hashOtpChallenge,
    hashVerificationToken,
    timingSafeEqualStr,
} = require('../utils/emailVerificationCrypto');
const { getAuthUser } = require('../utils/authUser');
const { signUserToken } = require('../utils/jwtTokens');

const router = express.Router();

const trimmed = (value) => (value == null ? '' : String(value)).trim();

// Utility function to validate email format
const isValidEmail = (email) => {
    return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
};

// Helper function to get plan display name
const getPlanDisplayName = (planId) => {
  const planNames = {
    'free': 'Free',
    'entry': 'Entry',
    'business': 'Business',
    'enterprise': 'Enterprise',
    'custom': 'Custom'
  };
  return planNames[planId] || 'Unknown Plan';
};

// ✅ Route: POST /send-otp
router.post('/send-otp', async (req, res) => {
    const { email, purpose } = req.body;

    if (!isValidEmail(email)) {
        return res.status(400).json({ success: false, message: 'Invalid email address.' });
    }

    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser && (purpose === 'signup' || purpose === 'visitor-signup')) {
        return res.status(409).json({ success: false, message: 'Email already exists. Please use a different one.' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const lowerEmail = email.toLowerCase();
    const otpPurpose = (purpose === 'signup' || purpose === 'visitor-signup') ? 'signup' : 'conference';

    await OtpChallenge.deleteMany({ email: lowerEmail });
    const otpHash = hashOtpChallenge(lowerEmail, otp);
    await OtpChallenge.create({
        email: lowerEmail,
        purpose: otpPurpose,
        otpHash,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });

    req.session.email = lowerEmail;
    req.session.otp = null;
    req.session.verified = false;

    // Define email subject, text, and HTML based on the purpose
    let subject = "OTP Verification";
    let text = `Your OTP is: ${otp}`;
    let html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f8f9fa;">
            <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
                <h2 style="color: #333; text-align: center; margin-bottom: 30px;">OTP Verification</h2>
                <p style="color: #666; font-size: 16px; line-height: 1.6;">Your OTP is:</p>
                <div style="background-color: #007bff; color: white; font-size: 24px; font-weight: bold; text-align: center; padding: 15px; border-radius: 5px; letter-spacing: 3px; margin: 20px 0;">${otp}</div>
                <p style="color: #666; font-size: 14px; text-align: center;">This OTP will expire in 15 minutes.</p>
            </div>
        </div>
    `;

    if (purpose === 'signup') {
        subject = "Signup OTP Verification";
        text = `Thank you for signing up!\n\nYour OTP is: ${otp}`;
        html = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f8f9fa;">
                <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
                    <h2 style="color: #28a745; text-align: center; margin-bottom: 30px;">Welcome to Audienzo!</h2>
                    <p style="color: #666; font-size: 16px; line-height: 1.6;">Thank you for signing up! Please verify your email address using the OTP below:</p>
                    <div style="background-color: #28a745; color: white; font-size: 24px; font-weight: bold; text-align: center; padding: 15px; border-radius: 5px; letter-spacing: 3px; margin: 20px 0;">${otp}</div>
                    <p style="color: #666; font-size: 14px; text-align: center;">This OTP will expire in 15 minutes.</p>
                </div>
            </div>
        `;
    } else if (purpose === 'visitor-signup') {
        subject = "Visitor Account OTP Verification";
        text = `Welcome to Audienzo!\n\nYour OTP is: ${otp}`;
        html = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f8f9fa;">
                <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
                    <h2 style="color: #1a0dab; text-align: center; margin-bottom: 30px;">Create Your Visitor Account</h2>
                    <p style="color: #666; font-size: 16px; line-height: 1.6;">Verify your email to discover events, save favorites, and manage your registrations:</p>
                    <div style="background-color: #1a0dab; color: white; font-size: 24px; font-weight: bold; text-align: center; padding: 15px; border-radius: 5px; letter-spacing: 3px; margin: 20px 0;">${otp}</div>
                    <p style="color: #666; font-size: 14px; text-align: center;">This OTP will expire in 15 minutes.</p>
                </div>
            </div>
        `;
    } else if (purpose === 'conference') {
        subject = "Conference Registration OTP";
        text = `You're almost registered!\n\nYour conference OTP is: ${otp}`;
        html = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f8f9fa;">
                <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
                    <h2 style="color: #007bff; text-align: center; margin-bottom: 30px;">Conference Registration</h2>
                    <p style="color: #666; font-size: 16px; line-height: 1.6;">You're almost registered! Please complete your registration using the OTP below:</p>
                    <div style="background-color: #007bff; color: white; font-size: 24px; font-weight: bold; text-align: center; padding: 15px; border-radius: 5px; letter-spacing: 3px; margin: 20px 0;">${otp}</div>
                    <p style="color: #666; font-size: 14px; text-align: center;">This OTP will expire in 15 minutes.</p>
                </div>
            </div>
        `;
    }

    try {
        await sendEmail(email, subject, text, html);
        return res.status(200).json({ success: true, message: 'OTP sent to your email via ZeptoMail.' });
    } catch (err) {
        console.error("Email send error:", err);
        await OtpChallenge.deleteMany({ email: lowerEmail });
        return res.status(500).json({ success: false, message: 'Failed to send OTP. Try again.' });
    }
});

// ✅ Route: POST /verify-otp
router.post('/verify-otp', async (req, res) => {
    const { email, otp } = req.body;
    const normalizedEmail = trimmed(email).toLowerCase();
    const normalizedOtp = String(otp ?? '').replace(/\s+/g, '').trim();

    if (!isValidEmail(normalizedEmail) || !/^\d{6}$/.test(normalizedOtp)) {
        return res.status(400).json({
            success: false,
            message: 'Invalid email or verification code format.',
        });
    }

    const challenge = await OtpChallenge.findOne({
        email: normalizedEmail,
        expiresAt: { $gt: new Date() },
    }).sort({ createdAt: -1 });

    if (!challenge || !timingSafeEqualStr(challenge.otpHash, hashOtpChallenge(normalizedEmail, normalizedOtp))) {
        return res.status(400).json({
            success: false,
            message: 'Invalid or expired OTP. Each code is valid for 15 minutes—request a new code if yours has expired.',
        });
    }

    await OtpChallenge.deleteMany({ email: normalizedEmail });

    const plainToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashVerificationToken(plainToken);
    await EmailVerificationProof.updateMany(
        { email: normalizedEmail, purpose: challenge.purpose, consumed: false },
        { $set: { consumed: true } }
    );
    await EmailVerificationProof.create({
        email: normalizedEmail,
        purpose: challenge.purpose,
        tokenHash,
        consumed: false,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    req.session.email = normalizedEmail;
    req.session.otp = null;
    req.session.verified = true;

    return res.status(200).json({
        success: true,
        message: 'OTP verified successfully.',
        verificationToken: plainToken,
    });
});


// Helper function for user creation and validation
async function createUser({ email, password, role = 'user', fullName = '' }) {
    if (!email || !password) {
        return { error: 'Missing required fields.' };
    }
    if (password.length < 6) {
        return { error: 'Password must be at least 6 characters long.' };
    }
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
        return { error: 'Email already exists.', conflict: true };
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const userData = {
        email: email.toLowerCase(),
        password: hashedPassword,
        role: role === 'visitor' ? 'visitor' : 'user',
        fullName: fullName || ''
    };
    if (role === 'visitor') {
        userData.visitorOnboardingCompleted = false;
    }
    const newUser = new User(userData);
    await newUser.save();
    return { success: true, user: newUser };
}

// ✅ Route: POST /signup (after OTP verified)
router.post('/signup', async (req, res) => {
    try {
        const { password, terms, googleSignup, email: googleEmail, emailVerificationToken } = req.body;
        let email = googleSignup ? googleEmail : req.session.email;
        let proofId = null;

        if (!terms) {
            return res.status(400).json({ success: false, message: 'You must agree to the Terms and Conditions.' });
        }

        if (googleSignup) {
            const result = await createUser({ email, password });
            if (result.error) {
                if (result.conflict) {
                    return res.status(409).json({ success: false, message: result.error });
                }
                return res.status(400).json({ success: false, message: result.error });
            }
            return res.status(200).json({ success: true, message: 'Google signup successful! You can now log in.' });
        }

        if (req.session.verified && req.session.email) {
            email = req.session.email;
        } else if (emailVerificationToken) {
            const tokenHash = hashVerificationToken(emailVerificationToken);
            const proof = await EmailVerificationProof.findOne({
                tokenHash,
                purpose: 'signup',
                consumed: false,
                expiresAt: { $gt: new Date() },
            });
            if (!proof) {
                return res.status(400).json({
                    success: false,
                    message: 'Email verification expired. Please verify your email again.',
                });
            }
            email = proof.email;
            proofId = proof._id;
        }

        if (!email) {
            return res.status(400).json({ success: false, message: 'Please verify your email before signing up.' });
        }

        const result = await createUser({ email, password });
        if (result.error) {
            if (result.conflict) {
                return res.status(409).json({ success: false, message: result.error });
            }
            return res.status(400).json({ success: false, message: result.error });
        }

        if (proofId) {
            await EmailVerificationProof.deleteOne({ _id: proofId });
        }

        // Clear session data after successful signup
        req.session.otp = null;
        req.session.email = null;
        req.session.verified = false;

        return res.status(200).json({ success: true, message: 'Signup successful! You can now log in.' });
    } catch (error) {
        console.error("Signup Error:", error);
        return res.status(500).json({ success: false, message: 'An unexpected error occurred. Please try again.' });
    }
});

async function linkRegistrationsToUser(userId, email) {
    await Registration.updateMany(
        { email: email.toLowerCase(), $or: [{ userId: null }, { userId: { $exists: false } }] },
        { $set: { userId } }
    );
}

// ✅ Route: POST /signup-visitor (visitor account — no plan selection)
router.post('/signup-visitor', async (req, res) => {
    try {
        const { password, terms, fullName, emailVerificationToken } = req.body;
        let email = req.session.email;
        let proofId = null;

        if (!terms) {
            return res.status(400).json({ success: false, message: 'You must agree to the Terms and Conditions.' });
        }

        if (req.session.verified && req.session.email) {
            email = req.session.email;
        } else if (emailVerificationToken) {
            const tokenHash = hashVerificationToken(emailVerificationToken);
            const proof = await EmailVerificationProof.findOne({
                tokenHash,
                purpose: 'signup',
                consumed: false,
                expiresAt: { $gt: new Date() },
            });
            if (!proof) {
                return res.status(400).json({
                    success: false,
                    message: 'Email verification expired. Please verify your email again.',
                });
            }
            email = proof.email;
            proofId = proof._id;
        }

        if (!email) {
            return res.status(400).json({ success: false, message: 'Please verify your email before signing up.' });
        }

        const result = await createUser({ email, password, role: 'visitor', fullName: trimmed(fullName) });
        if (result.error) {
            if (result.conflict) {
                return res.status(409).json({ success: false, message: result.error });
            }
            return res.status(400).json({ success: false, message: result.error });
        }

        const user = result.user;
        await linkRegistrationsToUser(user._id, email);

        if (proofId) {
            await EmailVerificationProof.deleteOne({ _id: proofId });
        }

        req.session.otp = null;
        req.session.email = null;
        req.session.verified = false;

        req.session.user = {
            _id: user._id,
            email: user.email,
            fullName: user.fullName,
            role: user.role,
            isAdmin: false
        };

        await User.findByIdAndUpdate(user._id, { lastLoginAt: new Date() });

        const userResponse = user.toObject();
        delete userResponse.password;
        const accessToken = signUserToken(user);

        return res.status(200).json({
            success: true,
            message: 'Visitor account created successfully.',
            user: userResponse,
            accessToken
        });
    } catch (error) {
        console.error('Visitor Signup Error:', error);
        return res.status(500).json({ success: false, message: 'An unexpected error occurred. Please try again.' });
    }
});

// ✅ Login Routes

router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Both fields are required.' });
        }

        if (!isValidEmail(email)) {
            return res.status(400).json({ success: false, message: 'Invalid email format.' });
        }

        const user = await User.findOne({ email: email.toLowerCase() });

        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ success: false, message: 'Invalid email or password.' });
        }

        // Deactivated Audienzo Team (or admin) cannot log in
        if (user.isActive === false) {
            return res.status(403).json({ success: false, message: 'Account is deactivated. Contact Super Admin.' });
        }

        // Store profile and role in session for guards and redirects
        req.session.user = {
          _id: user._id,
          email: user.email,
          fullName: user.fullName,
          organization: user.organization,
          phone: user.phone,
          image: user.image,
          role: user.role,
          isAdmin: user.isAdmin
        };

        // Update last login time for admin dashboard
        await User.findByIdAndUpdate(user._id, { lastLoginAt: new Date() });

        if (user.role === 'visitor') {
            await linkRegistrationsToUser(user._id, user.email);
        }

        const userResponse = user.toObject();
        delete userResponse.password;
        delete userResponse.resetPasswordToken;
        userResponse.role = user.role;
        userResponse.isAdmin = user.isAdmin;
        userResponse.isActive = user.isActive;
        const accessToken = signUserToken(user);
        return res.status(200).json({ success: true, message: 'Login successful.', user: userResponse, accessToken });
    } catch (error) {
        console.error("Login Error:", error);
        return res.status(500).json({ success: false, message: 'An error occurred. Please try again.' });
    }
});

// Logout route
router.post('/logout', (req, res) => {
    req.session.destroy(err => {
      if (err) {
        console.error('Logout error:', err);
        return res.status(500).send('Logout failed');
      }
      // Clear the session cookie
      res.clearCookie('connect.sid');
      res.status(200).send('Logged out');
    });
  });
  
// Endpoint to check if an email is already registered
router.post('/check-email', async (req, res) => {
    const { email } = req.body;
    if (!email) {
        return res.status(400).json({ success: false, message: 'Email is required.' });
    }
    const user = await User.findOne({ email: email.toLowerCase() });
    return res.json({ success: true, exists: !!user });
});

// POST /api/auth/request-reset
router.post('/request-reset', async (req, res) => {
    const { email } = req.body;
    if (!email) {
        return res.status(400).json({ success: false, message: 'Email is required.' });
    }
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
        // For security, don't reveal if email exists
        return res.status(200).json({ success: true, message: 'If this email is registered, a reset link has been sent.' });
    }
    // Generate token
    const token = crypto.randomBytes(32).toString('hex');
    user.resetPasswordToken = token;
    user.resetPasswordExpires = Date.now() + 1000 * 60 * 60; // 1 hour
    await user.save();
    // Send improved HTML email
    // Environment detection for frontend URL
    const isProduction = process.env.NODE_ENV === 'production';
    const frontendUrl = isProduction ? process.env.FRONTEND_URL : 'http://localhost:4200';
    const resetUrl = `${frontendUrl}/reset-password?token=${token}`;
    const subject = 'Password Reset Request for Your Audienzo Account';
    const text = `Hello,\n\nWe received a request to reset the password for your Audienzo account.\n\nTo reset your password, please use the button below or copy and paste this link into your browser:\n${resetUrl}\n\nIf you did not request a password reset, please ignore this email. Your password will remain unchanged.\n\nThank you,\nThe Audienzo Team`;
    const html = `
      <div style=\"font-family:sans-serif;max-width:480px;margin:auto;\">
        <h2>Password Reset Request</h2>
        <p>Hello,</p>
        <p>We received a request to reset the password for your Audienzo account.</p>
        <p style=\"margin:24px 0;\">
          <a href=\"${resetUrl}\" style=\"display:inline-block;padding:12px 24px;background:#6d28d9;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold;\">Reset Password</a>
        </p>
        <p>If the button above does not work, copy and paste this link into your browser:</p>
        <p><a href=\"${resetUrl}\">${resetUrl}</a></p>
        <p>If you did not request a password reset, please ignore this email. Your password will remain unchanged.</p>
        <p>Thank you,<br/>The Audienzo Team</p>
      </div>
    `;
    try {
        await sendEmail(user.email, subject, text, html);
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Failed to send reset email.' });
    }
    return res.status(200).json({ success: true, message: 'If this email is registered, a reset link has been sent.' });
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
    const { token, password } = req.body;
    if (!token || !password) {
        return res.status(400).json({ success: false, message: 'Token and new password are required.' });
    }
    const user = await User.findOne({
        resetPasswordToken: token,
        resetPasswordExpires: { $gt: Date.now() }
    });
    if (!user) {
        return res.status(400).json({ success: false, message: 'Invalid or expired token.' });
    }
    if (password.length < 6) {
        return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }
    user.password = await bcrypt.hash(password, 10);
    user.resetPasswordToken = null;
    user.resetPasswordExpires = null;
    await user.save();
    return res.status(200).json({ success: true, message: 'Password has been reset. You can now log in.' });
});

// PUT /api/auth/profile - update user profile
router.put('/profile', async (req, res) => {
    if (!getAuthUser(req)) {
        return res.status(401).json({ error: 'Not logged in' });
    }
    const userId = getAuthUser(req)._id;
    const { fullName, organization, phone, image } = req.body;
    try {
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        if (fullName !== undefined) user.fullName = fullName;
        if (organization !== undefined) user.organization = organization;
        if (phone !== undefined) user.phone = phone;
        if (image !== undefined) user.image = image;
        await user.save();
        // Update session user
        req.session.user = user;
        const { password, ...userObj } = user.toObject();
        const accessToken = signUserToken(user);
        res.json({ user: userObj, accessToken });
    } catch (err) {
        console.error('Profile update error:', err);
        res.status(500).json({ error: 'Failed to update profile' });
    }
});

// POST /api/auth/profile-image - upload and set profile image
router.post('/profile-image', uploadImage.single('image'), async (req, res) => {
    if (!getAuthUser(req)) {
        return res.status(401).json({ error: 'Not logged in' });
    }
    const userId = getAuthUser(req)._id;
    if (!req.file || !req.file.path) {
        return res.status(400).json({ error: 'No image uploaded' });
    }
    try {
        // The file is already uploaded to Cloudinary by multer-storage-cloudinary
        const imageUrl = req.file.path;
        const user = await User.findByIdAndUpdate(userId, { image: imageUrl }, { new: true });
        req.session.user = user;
        const { password, ...userObj } = user.toObject();
        const accessToken = signUserToken(user);
        res.json({ user: userObj, accessToken });
    } catch (err) {
        console.error('Profile image upload error:', err);
        res.status(500).json({ error: 'Failed to upload profile image' });
    }
});

// API: Get current logged-in user info
router.get('/me', async (req, res) => {
    
    if (getAuthUser(req)) {
        try {
            const user = await User.findById(getAuthUser(req)._id).select('-password');
            if (!user) {
                return res.status(401).json({ error: 'Not logged in' });
            }
            res.json({ user });
        } catch (err) {
            console.error('Error fetching user in /api/me:', err);
            res.status(500).json({ error: 'Server error' });
        }
    } else {
        res.status(401).json({ error: 'Not logged in' });
    }
});

// API: Check session status (for Angular authentication check)
router.get('/session', async (req, res) => {
    if (getAuthUser(req)) {
        try {
            const user = await User.findById(getAuthUser(req)._id).select('email fullName role isAdmin isActive selectedPlan visitorOnboardingCompleted');
            if (user) {
                if (user.isActive === false) {
                    req.session.destroy(() => {});
                    return res.json({ loggedIn: false });
                }
                res.json({ 
                    loggedIn: true, 
                    user: {
                        _id: user._id,
                        email: user.email,
                        fullName: user.fullName,
                        role: user.role,
                        isAdmin: user.isAdmin,
                        selectedPlan: user.selectedPlan,
                        visitorOnboardingCompleted: user.visitorOnboardingCompleted
                    }
                });
            } else {
                res.json({ 
                    loggedIn: false 
                });
            }
        } catch (error) {
            console.error('Session check error:', error);
            res.json({ 
                loggedIn: false 
            });
        }
    } else {
        res.json({ 
            loggedIn: false 
        });
    }
});

// API: Check if user has selected a plan
router.get('/plan-status', async (req, res) => {
    try {
        if (!getAuthUser(req)) {
            return res.status(401).json({ error: 'Not logged in' });
        }

        const user = await User.findById(getAuthUser(req)._id);
        if (!user) {
            return res.status(401).json({ error: 'User not found' });
        }

        res.json({ 
            hasSelectedPlan: !!user.selectedPlan,
            selectedPlan: user.selectedPlan,
            planCurrency: user.planCurrency,
            planSelectedAt: user.planSelectedAt
        });
    } catch (error) {
        console.error('Error checking plan status:', error);
        res.status(500).json({ error: 'Failed to check plan status' });
    }
});

// API: Set user's plan
router.post('/set-plan', async (req, res) => {
    try {
        if (!getAuthUser(req)) {
            return res.status(401).json({ error: 'Not logged in' });
        }

        const { planId, currency } = req.body;
        
        // Validate planId
        const validPlans = ['free', 'entry', 'business', 'enterprise', 'custom'];
        if (!validPlans.includes(planId)) {
            return res.status(400).json({ error: 'Invalid plan ID' });
        }

        // Validate currency
        const validCurrencies = ['INR', 'USD'];
        if (currency && !validCurrencies.includes(currency)) {
            return res.status(400).json({ error: 'Invalid currency' });
        }

        const updateData = {
            selectedPlan: planId,
            planSelectedAt: new Date()
        };

        if (currency) {
            updateData.planCurrency = currency;
        }

        const existingUser = await User.findById(getAuthUser(req)._id);
        if (!existingUser) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Participant upgrading to event coordinator when selecting a plan
        if (existingUser.role === 'visitor') {
            updateData.role = 'user';
        }

        const user = await User.findByIdAndUpdate(
            getAuthUser(req)._id, 
            updateData,
            { new: true }
        );

        if (req.session && req.session.user) {
            req.session.user.role = user.role;
        }

        // Send welcome email for plan selection
        try {
          const planName = getPlanDisplayName(planId);
          let expiryDate = null;
          
          // Set expiry date for paid plans (not for free plan)
          if (planId !== 'free') {
            const now = new Date();
            if (planId === 'entry') {
              // Entry plan: per-event model - set long expiry but track by purchasedEventCount
              expiryDate = new Date(now.getTime() + (365 * 24 * 60 * 60 * 1000));
            } else if (planId === 'business' || planId === 'enterprise' || planId === 'custom') {
              // Business, Enterprise, and Custom plans: annual, so end date is 1 year from now
              expiryDate = new Date(now.getTime() + (365 * 24 * 60 * 60 * 1000));
            }
          }

          await sendWelcomeEmail(
            {
              fullName: user.fullName,
              email: user.email
            },
            planId,
            planName,
            currency || 'INR',
            new Date(),
            expiryDate
          );
        } catch (emailError) {
          console.error('❌ Failed to send welcome email:', emailError);
          // Don't fail the plan selection if email fails
        }

        // Reset usage alert counts for new plan
        try {
          await UsageAlertService.resetAlertCounts(user._id);
        } catch (alertResetError) {
          console.error('❌ Failed to reset usage alert counts:', alertResetError);
          // Don't fail the plan selection if alert reset fails
        }

        // Update session user data
        req.session.user = user;

        res.json({ 
            success: true, 
            message: 'Plan selected successfully',
            planId: user.selectedPlan,
            planCurrency: user.planCurrency,
            planSelectedAt: user.planSelectedAt,
            accessToken: signUserToken(user)
        });
    } catch (error) {
        console.error('Error setting plan:', error);
        res.status(500).json({ error: 'Failed to set plan' });
    }
});

// API: Get user's current plan details
router.get('/plan-details', async (req, res) => {
    try {
        if (!getAuthUser(req)) {
            return res.status(401).json({ error: 'Not logged in' });
        }

        const user = await User.findById(getAuthUser(req)._id);
        if (!user) {
            return res.status(401).json({ error: 'User not found' });
        }

        res.json({
            selectedPlan: user.selectedPlan,
            planCurrency: user.planCurrency,
            planSelectedAt: user.planSelectedAt,
            hasSelectedPlan: !!user.selectedPlan
        });
    } catch (error) {
        console.error('Error fetching plan details:', error);
        res.status(500).json({ error: 'Failed to fetch plan details' });
    }
});

// API: Toggle auto-renewal setting
router.put('/auto-renewal', async (req, res) => {
    try {
        if (!getAuthUser(req)) {
            return res.status(401).json({ error: 'Not logged in' });
        }

        const { autoRenewal } = req.body;
        
        if (typeof autoRenewal !== 'boolean') {
            return res.status(400).json({ error: 'Auto-renewal must be a boolean value' });
        }

        const user = await User.findByIdAndUpdate(
            getAuthUser(req)._id,
            { autoRenewal: autoRenewal },
            { new: true }
        );

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Update session user data
        req.session.user = user;

        res.json({
            success: true,
            message: `Auto-renewal ${autoRenewal ? 'enabled' : 'disabled'} successfully`,
            autoRenewal: user.autoRenewal,
            accessToken: signUserToken(user)
        });
    } catch (error) {
        console.error('Error updating auto-renewal:', error);
        res.status(500).json({ error: 'Failed to update auto-renewal setting' });
    }
});

// API: Cancel subscription (plan remains active until end date)
router.post('/cancel-subscription', async (req, res) => {
    try {
        if (!getAuthUser(req)) {
            return res.status(401).json({ error: 'Not logged in' });
        }

        const { reason } = req.body;
        const user = await User.findById(getAuthUser(req)._id);
        
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        if (!user.selectedPlan || user.selectedPlan === 'free') {
            return res.status(400).json({ error: 'No active subscription to cancel' });
        }

        if (user.subscriptionStatus === 'cancelled') {
            return res.status(400).json({ error: 'Subscription is already cancelled' });
        }

        // Calculate subscription end date based on plan
        let subscriptionEndDate;
        const now = new Date();
        
        if (user.selectedPlan === 'entry') {
            // Entry plan: per-event model - set long expiry but track by purchasedEventCount
            subscriptionEndDate = new Date(now.getTime() + (365 * 24 * 60 * 60 * 1000));
        } else if (user.selectedPlan === 'business' || user.selectedPlan === 'enterprise') {
            // Business and Enterprise plans: annual, so end date is 1 year from last payment
            subscriptionEndDate = new Date(now.getTime() + (365 * 24 * 60 * 60 * 1000));
        } else {
            // Default: 1 year from now
            subscriptionEndDate = new Date(now.getTime() + (365 * 24 * 60 * 60 * 1000));
        }

        const updatedUser = await User.findByIdAndUpdate(
            getAuthUser(req)._id,
            {
                subscriptionStatus: 'cancelled',
                subscriptionEndDate: subscriptionEndDate,
                cancelledAt: now,
                cancellationReason: reason || 'User requested cancellation'
                // Note: We don't change autoRenewal here - let user control it
            },
            { new: true }
        );

        // Update session user data
        req.session.user = updatedUser;

        res.json({
            success: true,
            message: 'Subscription cancelled successfully. Your plan will remain active until the end of your current billing period.',
            subscriptionStatus: updatedUser.subscriptionStatus,
            subscriptionEndDate: updatedUser.subscriptionEndDate,
            cancelledAt: updatedUser.cancelledAt,
            accessToken: signUserToken(updatedUser)
        });
    } catch (error) {
        console.error('Error cancelling subscription:', error);
        res.status(500).json({ error: 'Failed to cancel subscription' });
    }
});

// API: Get subscription status and details
router.get('/subscription-status', async (req, res) => {
    try {
        if (!getAuthUser(req)) {
            return res.status(401).json({ error: 'Not logged in' });
        }

        const user = await User.findById(getAuthUser(req)._id);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Check if subscription has expired
        let isActive = true;
        if (user.subscriptionEndDate && new Date() > user.subscriptionEndDate) {
            isActive = false;
            // Update status to expired
            await User.findByIdAndUpdate(user._id, { subscriptionStatus: 'expired' });
        }

        res.json({
            success: true,
            subscription: {
                planId: user.selectedPlan,
                planCurrency: user.planCurrency,
                planSelectedAt: user.planSelectedAt,
                subscriptionStatus: user.subscriptionStatus,
                subscriptionEndDate: user.subscriptionEndDate,
                cancelledAt: user.cancelledAt,
                cancellationReason: user.cancellationReason,
                autoRenewal: user.autoRenewal,
                isActive: isActive,
                hasSelectedPlan: !!user.selectedPlan
            }
        });
    } catch (error) {
        console.error('Error fetching subscription status:', error);
        res.status(500).json({ error: 'Failed to fetch subscription status' });
    }
});

// API: Update notification settings
router.post('/update-notification-settings', async (req, res) => {
    try {
        if (!getAuthUser(req)) {
            return res.status(401).json({ error: 'Not logged in' });
        }

        const { notificationSettings } = req.body;
        
        if (!notificationSettings) {
            return res.status(400).json({ error: 'Notification settings are required' });
        }

        const user = await User.findByIdAndUpdate(
            getAuthUser(req)._id,
            { notificationSettings },
            { new: true }
        );

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Update session user data
        req.session.user = user;

        res.json({
            success: true,
            message: 'Notification settings updated successfully',
            notificationSettings: user.notificationSettings,
            accessToken: signUserToken(user)
        });
    } catch (error) {
        console.error('Error updating notification settings:', error);
        res.status(500).json({ error: 'Failed to update notification settings' });
    }
});

module.exports = router;