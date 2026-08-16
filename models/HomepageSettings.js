const mongoose = require('mongoose');

const homepageSettingsSchema = new mongoose.Schema({
  key: {
    type: String,
    default: 'homepage',
    unique: true
  },
  heroTagline: { type: String, default: '' },
  heroSubtext: { type: String, default: '' },
  heroBannerImageUrl: { type: String, default: '' },
  updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model('HomepageSettings', homepageSettingsSchema);
