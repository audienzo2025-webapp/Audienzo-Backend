const express = require('express');
const router = express.Router();
const HomepageSettings = require('../models/HomepageSettings');
const blogEditorAuthMiddleware = require('../middleware/blogEditorAuthMiddleware');
const { uploadImage } = require('../config/cloudinary');

const DEFAULT_TAGLINE = 'Audienzo — The Minimalist Way to Manage Events.';
const DEFAULT_SUBTEXT = 'One clean platform for serious event managers who value efficiency over complexity';
const DEFAULT_BANNER_URL = 'https://opencraft.com/wp-content/uploads/group-of-people-sitting-at-conference-open-edx-conference-speakers-2023-opencraft.jpg';

/**
 * GET /api/site-settings/homepage
 * Public: get homepage hero settings (tagline, subtext, banner URL)
 */
router.get('/homepage', async (req, res) => {
  try {
    let doc = await HomepageSettings.findOne({ key: 'homepage' }).lean();
    if (!doc) {
      return res.json({
        success: true,
        data: {
          heroTagline: DEFAULT_TAGLINE,
          heroSubtext: DEFAULT_SUBTEXT,
          heroBannerImageUrl: DEFAULT_BANNER_URL
        }
      });
    }
    res.json({
      success: true,
      data: {
        heroTagline: doc.heroTagline || DEFAULT_TAGLINE,
        heroSubtext: doc.heroSubtext || DEFAULT_SUBTEXT,
        heroBannerImageUrl: doc.heroBannerImageUrl || DEFAULT_BANNER_URL
      }
    });
  } catch (err) {
    console.error('GET site-settings/homepage error:', err);
    res.status(500).json({ success: false, message: 'Failed to load homepage settings' });
  }
});

/**
 * PUT /api/site-settings/homepage
 * Protected: update homepage hero settings (audienzo team / blog editor / admin)
 */
router.put('/homepage', blogEditorAuthMiddleware, async (req, res) => {
  try {
    const { heroTagline, heroSubtext, heroBannerImageUrl } = req.body || {};
    let doc = await HomepageSettings.findOne({ key: 'homepage' });
    if (!doc) {
      doc = new HomepageSettings({ key: 'homepage' });
    }
    if (typeof heroTagline === 'string') doc.heroTagline = heroTagline.trim();
    if (typeof heroSubtext === 'string') doc.heroSubtext = heroSubtext.trim();
    if (typeof heroBannerImageUrl === 'string') doc.heroBannerImageUrl = heroBannerImageUrl.trim();
    doc.updatedAt = new Date();
    await doc.save();
    res.json({
      success: true,
      data: {
        heroTagline: doc.heroTagline || DEFAULT_TAGLINE,
        heroSubtext: doc.heroSubtext || DEFAULT_SUBTEXT,
        heroBannerImageUrl: doc.heroBannerImageUrl || DEFAULT_BANNER_URL
      }
    });
  } catch (err) {
    console.error('PUT site-settings/homepage error:', err);
    res.status(500).json({ success: false, message: 'Failed to update homepage settings' });
  }
});

/**
 * POST /api/site-settings/homepage/upload-banner
 * Protected: upload banner image (multipart), returns URL for heroBannerImageUrl
 */
router.post('/homepage/upload-banner', blogEditorAuthMiddleware, uploadImage.single('image'), async (req, res) => {
  try {
    if (!req.file || !req.file.path) {
      return res.status(400).json({ success: false, message: 'No image file provided' });
    }
    const url = req.file.path;
    res.json({ success: true, url });
  } catch (err) {
    console.error('Upload homepage banner error:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to upload banner' });
  }
});

module.exports = router;
