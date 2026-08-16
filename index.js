require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const mongoose = require("mongoose");
const session = require("express-session");
const flash = require("express-flash");
const MongoStore = require("connect-mongo");
const path = require("path");
const bugRoutes = require("./routes/bug");
const demoRoutes = require("./routes/demoRoutes");
const Conference = require("./models/Conference");
const conferenceRoutes = require("./routes/conferenceRoutes");
const registrationRoutes = require("./routes/registrationRoutes");
const authRoutes = require("./routes/authRoutes");
const paymentRoutes = require("./routes/paymentRoutes");
const checkoutRoutes = require("./routes/checkoutRoutes");
const reminderRoutes = require("./routes/reminderRoutes");
const bulkemailRoutes = require("./routes/bulkemailRoutes");
const markAttendanceRoutes = require("./routes/markAttendanceRoutes");
const adminRoutes = require("./routes/adminRoutes");
const supportRoutes = require("./routes/supportRoutes");
const collaboratorRoutes = require("./routes/collaboratorRoutes");
const couponRoutesModule = require("./routes/couponRoutes");
const couponRoutes = couponRoutesModule.router;
const blogRoutesModule = require("./routes/blogRoutes");
const blogRoutes = blogRoutesModule.router;
const adminBlogRoutes = require("./routes/adminBlogRoutes");
const shareRoutes = require("./routes/shareRoutes");
const visitorRoutes = require("./routes/visitorRoutes");
const { attachJwtUser } = require("./middleware/jwtMiddleware");
const { getAuthUser } = require("./utils/authUser");
const { signUserToken } = require("./utils/jwtTokens");
const cors = require('cors');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const index = express();

// Trust proxy for Railway deployment (important for HTTPS and proxy headers)
index.set('trust proxy', 1);

/** Normalize env URL to a browser Origin (scheme + host + port), no trailing path. */
function normalizeOrigin(url) {
  if (!url || typeof url !== "string") return null;
  const trimmed = url.trim();
  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed.replace(/\/$/, "");
  }
}

// Hosted PaaS often omits NODE_ENV=production; session cookies must use SameSite=None for SPA↔API.
const isProduction =
  process.env.NODE_ENV === "production" ||
  process.env.RENDER === "true" ||
  process.env.RAILWAY_ENVIRONMENT === "production" ||
  !!process.env.DYNO;

const frontendUrl = isProduction ? process.env.FRONTEND_URL : 'http://localhost:4200';
const backendUrl = isProduction ? process.env.BACKEND_URL : 'http://localhost:3000';

// CORS configuration for separate frontend deployment
const extraOrigins = (process.env.FRONTEND_URLS_EXTRA || '')
  .split(',')
  .map((s) => normalizeOrigin(s.trim()))
  .filter(Boolean);

const allowedOrigins = [
  'http://localhost:4200', // Development frontend
  'https://audienzo-frontend-two.vercel.app', // Vercel frontend
  normalizeOrigin(process.env.FRONTEND_URL),
  process.env.FRONTEND_URL, // legacy: exact string if normalize failed
  ...extraOrigins,
].filter(Boolean); // Remove undefined values

function isOriginAllowed(origin) {
  if (allowedOrigins.includes(origin)) return true;
  try {
    const { hostname } = new URL(origin);
    // Vercel production + preview deployments (*.vercel.app)
    if (hostname === 'vercel.app' || hostname.endsWith('.vercel.app')) {
      return true;
    }
  } catch (_) {
    /* ignore */
  }
  return false;
}

// Enable CORS for Angular frontend
index.use(cors({ 
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    if (isOriginAllowed(origin)) {
      return callback(null, true);
    }
    
    // Log unauthorized origin attempts
    console.log('🚫 CORS blocked origin:', origin);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Static Files
index.use(express.static(path.join(__dirname, "public")));

// Body Parsers
index.use(express.urlencoded({ extended: true }));
index.use(express.json());

// ✅ Corrected MongoDB Connection (Removed Deprecated Options)
mongoose
  .connect(process.env.MONGO_URI)
  .then(async () => {
    console.log("✅ MongoDB connected");
    try {
      const { migrateConferenceUrlSlugs } = require("./utils/conferenceSlug");
      await migrateConferenceUrlSlugs();
      console.log("✅ Conference urlSlug migration checked");
    } catch (mErr) {
      console.warn("⚠️ Conference urlSlug migration:", mErr && mErr.message ? mErr.message : mErr);
    }
  })
  .catch((err) => console.error("❌ MongoDB Connection Error:", err));

// ✅ Corrected Session Setup
index.use(
  session({
    secret: process.env.SESSION_SECRET || "default_secret",
    resave: false,
    saveUninitialized: false,
    // Trust X-Forwarded-Proto behind Render/Railway so secure cookies work
    proxy: isProduction,
    store: MongoStore.create({
      mongoUrl: process.env.MONGO_URI,
      collectionName: "sessions",
    }),
    cookie: { 
      secure: isProduction, // Set to true in production (HTTPS)
      httpOnly: true, // Keep cookies secure - Angular will use API calls instead
      sameSite: isProduction ? 'none' : 'lax', // 'none' for cross-origin in production
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      // Don't set domain for cross-origin requests
      path: '/'
    }
  })
);

index.use(attachJwtUser);

// ✅ Flash Messages Setup
index.use(flash());

// ✅ Middleware for Flash Messages & User Session
index.use((req, res, next) => {
  res.locals.messages = req.flash();
  res.locals.user = getAuthUser(req) || null;
  next();
});

index.use(passport.initialize());
index.use(passport.session());

// Configure Passport with Google OAuth
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: isProduction 
    ? `${backendUrl}api/auth/google/callback`
    : 'http://localhost:3000/api/auth/google/callback'
}, (accessToken, refreshToken, profile, done) => {
  // Here you can find or create the user in your DB
  // For now, just pass the profile
  return done(null, profile);
}));

passport.serializeUser((user, done) => {
  done(null, user);
});
passport.deserializeUser((obj, done) => {
  done(null, obj);
});

// Google OAuth routes
// Step 1: Start the Google OAuth flow and preserve the authType (login or signup)
index.get('/api/auth/google', (req, res, next) => {
  const authType = req.query.authType || 'signup';
  const returnUrl = typeof req.query.returnUrl === 'string' ? req.query.returnUrl.trim() : '';
  let state = authType;
  if (returnUrl.startsWith('/') && !returnUrl.startsWith('//') && !returnUrl.startsWith('/login')) {
    state = `${authType}:${encodeURIComponent(returnUrl)}`;
  }
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    state,
    prompt: 'select_account'
  })(req, res, next);
});

// Step 2: Google OAuth Callback with proper state handling
index.get('/api/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/signup' }),
  async (req, res) => {
    try {
      const email = req.user.emails[0].value;
      const User = require('./models/User');
      const stateRaw = req.query.state || 'signup';
      let state = stateRaw;
      let returnUrl = '';
      if (stateRaw.includes(':')) {
        const sep = stateRaw.indexOf(':');
        state = stateRaw.slice(0, sep);
        returnUrl = decodeURIComponent(stateRaw.slice(sep + 1));
        if (!returnUrl.startsWith('/') || returnUrl.startsWith('//')) {
          returnUrl = '';
        }
      }
      const returnUrlQuery = returnUrl ? `?returnUrl=${encodeURIComponent(returnUrl)}` : '';

      let user = await User.findOne({ email });

      if (state === 'login') {
        if (!user) {
          return res.redirect(`${frontendUrl}/login?googleError=notfound`);
        }
        if (user.isActive === false) {
          return res.redirect(`${frontendUrl}/login?googleError=deactivated`);
        }

        req.session.user = {
          _id: user._id,
          email: user.email,
          role: user.role,
          isAdmin: user.isAdmin
        };
        const token = signUserToken(user);
        return res.redirect(
          `${frontendUrl}/google-auth-callback${returnUrlQuery}#access_token=${encodeURIComponent(token)}`
        );
      }

      // Signup flow (default):
      if (user) {
        // User already exists, redirect to signup with error
        return res.redirect(`${frontendUrl}/signup?googleError=exists`);
      }

      // Create new user
      user = new User({
        email,
        password: require('crypto').randomBytes(32).toString('hex') // Random password
      });
      await user.save();

      // Set session user
      req.session.user = { _id: user._id, email: user.email };
      const token = signUserToken(user);
      return res.redirect(
        `${frontendUrl}/google-auth-callback${returnUrlQuery}#access_token=${encodeURIComponent(token)}`
      );

    } catch (error) {
      console.error('Google OAuth callback error:', error);
      return res.redirect(`${frontendUrl}/login?googleError=server`);
    }
  }
);

// ✅ Move Reminder Routes AFTER session & flash are set up
index.use('/api/reminders', reminderRoutes);

// Routes
index.use('/api/auth', authRoutes);
index.use('/api/visitor', visitorRoutes);
index.use('/api/payment', paymentRoutes);
index.use('/api/checkout', checkoutRoutes);
index.use('/api', conferenceRoutes);
index.use('/api',registrationRoutes);
index.use('/api', bulkemailRoutes);
index.use('/api', markAttendanceRoutes);
index.use("/api",bugRoutes);
index.use("/api", demoRoutes);
index.use('/api/admin', adminRoutes);
index.use('/api/support', supportRoutes);
index.use('/api/collaborators', collaboratorRoutes);
index.use('/api/coupons', couponRoutes);
index.use('/api/blog', blogRoutes);
index.use('/api/admin/blog', adminBlogRoutes);
const blogDashboardRoutes = require('./routes/blogDashboardRoutes');
const siteSettingsRoutes = require('./routes/siteSettingsRoutes');
index.use('/api/blog-dashboard', blogDashboardRoutes);
index.use('/api/site-settings', siteSettingsRoutes);
// Public share pages (Open Graph tags for LinkedIn/Facebook)
index.use('/', shareRoutes);

// API-only backend - no frontend serving
console.log('🚀 API-only backend mode: Serving only API endpoints');

// Health check endpoint for Render
index.get("/", (req, res) => {
  res.json({ 
    message: "Audienzo Backend API", 
    status: "running", 
    timestamp: new Date().toISOString(),
    environment: isProduction ? 'production' : 'development'
  });
});

// API health check
index.get("/api/health", (req, res) => {
  res.json({ 
    status: "healthy", 
    timestamp: new Date().toISOString(),
    environment: isProduction ? 'production' : 'development'
  });
});

// Lightweight health endpoint (no database, no auth)
index.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "audienzo-backend"
  });
});

// Start Server
const PORT = process.env.PORT || 3000;
index.listen(PORT, () => console.log(`🚀 Server running on port ${PORT} in ${isProduction ? 'production' : 'development'} mode`));
