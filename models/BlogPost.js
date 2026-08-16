const mongoose = require('mongoose');

const blogPostSchema = new mongoose.Schema({
    title: {
        type: String,
        required: true,
        trim: true
    },
    slug: {
        type: String,
        unique: true,
        sparse: true,
        lowercase: true
    },
    excerpt: {
        type: String,
        required: true,
        trim: true
    },
    content: {
        type: String,
        required: true
    },
    author: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    authorName: {
        type: String,
        default: 'Audienzo Team'
    },
    imageUrl: {
        type: String,
        default: ''
    },
    published: {
        type: Boolean,
        default: false
    },
    publishedAt: {
        type: Date
    },
    views: {
        type: Number,
        default: 0
    },
    tags: {
        type: [String],
        default: []
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

// Generate slug from title before saving
blogPostSchema.pre('save', function (next) {
    if (this.isModified('title') || this.isNew) {
        this.slug = this.title
            .toLowerCase()
            .trim()
            .replace(/[^\w\s-]/g, '') // Remove special characters
            .replace(/[\s_-]+/g, '-') // Replace spaces and underscores with hyphens
            .replace(/^-+|-+$/g, ''); // Remove leading/trailing hyphens
    }
    
    // Set publishedAt when published status changes to true
    if (this.isModified('published') && this.published && !this.publishedAt) {
        this.publishedAt = new Date();
    }
    
    // Update updatedAt
    this.updatedAt = Date.now();
    next();
});

// Index for faster queries
blogPostSchema.index({ slug: 1 });
blogPostSchema.index({ published: 1, publishedAt: -1 });
blogPostSchema.index({ createdAt: -1 });

module.exports = mongoose.models.BlogPost || mongoose.model('BlogPost', blogPostSchema);

