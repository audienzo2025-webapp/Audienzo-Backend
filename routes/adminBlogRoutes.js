const express = require('express');
const router = express.Router();
const BlogPost = require('../models/BlogPost');
const User = require('../models/User');
const adminAuthMiddleware = require('../middleware/adminAuthMiddleware');
const { cloudinary, uploadImage } = require('../config/cloudinary');
const { invalidateCache } = require('./blogRoutes');

// Apply admin middleware to all routes
router.use(adminAuthMiddleware);

/**
 * GET /api/admin/blog/posts
 * Get all blog posts (including drafts) for admin
 */
router.get('/posts', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    const search = req.query.search || '';

    const filter = {};
    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: 'i' } },
        { excerpt: { $regex: search, $options: 'i' } }
      ];
    }

    const posts = await BlogPost.find(filter)
      .populate('author', 'fullName email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await BlogPost.countDocuments(filter);

    res.json({
      success: true,
      data: {
        posts,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    console.error('Error fetching admin blog posts:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch blog posts',
      error: error.message
    });
  }
});

/**
 * GET /api/admin/blog/posts/:id
 * Get single blog post by ID for editing
 */
router.get('/posts/:id', async (req, res) => {
  try {
    const post = await BlogPost.findById(req.params.id)
      .populate('author', 'fullName email')
      .lean();

    if (!post) {
      return res.status(404).json({
        success: false,
        message: 'Blog post not found'
      });
    }

    res.json({
      success: true,
      data: post
    });
  } catch (error) {
    console.error('Error fetching blog post:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch blog post',
      error: error.message
    });
  }
});

/**
 * POST /api/admin/blog/posts
 * Create new blog post
 */
router.post('/posts', uploadImage.single('image'), async (req, res) => {
  try {
    const { title, excerpt, content, published, tags, authorName } = req.body;
    const userId = req.adminUser._id;

    // Validate required fields
    if (!title || !excerpt || !content) {
      return res.status(400).json({
        success: false,
        message: 'Title, excerpt, and content are required'
      });
    }

    // Handle image upload
    let imageUrl = '';
    if (req.file) {
      imageUrl = req.file.path; // Cloudinary returns secure_url in path
    }

    // Parse tags if it's a string
    let tagsArray = [];
    if (tags) {
      tagsArray = typeof tags === 'string' ? tags.split(',').map(t => t.trim()) : tags;
    }

    const postData = {
      title,
      excerpt,
      content,
      author: userId,
      authorName: authorName || req.adminUser.fullName || 'Audienzo Team',
      published: published === 'true' || published === true,
      tags: tagsArray
    };

    if (imageUrl) {
      postData.imageUrl = imageUrl;
    }

    const post = new BlogPost(postData);
    await post.save();

    // Invalidate cache
    invalidateCache();

    res.status(201).json({
      success: true,
      message: 'Blog post created successfully',
      data: post
    });
  } catch (error) {
    console.error('Error creating blog post:', error);
    
    // Handle duplicate slug error
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'A blog post with this title already exists'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to create blog post',
      error: error.message
    });
  }
});

/**
 * PUT /api/admin/blog/posts/:id
 * Update existing blog post
 */
router.put('/posts/:id', uploadImage.single('image'), async (req, res) => {
  try {
    const { title, excerpt, content, published, tags, authorName } = req.body;
    const postId = req.params.id;

    const post = await BlogPost.findById(postId);
    if (!post) {
      return res.status(404).json({
        success: false,
        message: 'Blog post not found'
      });
    }

    // Update fields
    if (title) post.title = title;
    if (excerpt) post.excerpt = excerpt;
    if (content) post.content = content;
    if (authorName) post.authorName = authorName;
    
    // Handle published status
    if (published !== undefined) {
      const wasPublished = post.published;
      post.published = published === 'true' || published === true;
      
      // Set publishedAt if publishing for the first time
      if (!wasPublished && post.published && !post.publishedAt) {
        post.publishedAt = new Date();
      }
    }

    // Handle tags
    if (tags !== undefined) {
      post.tags = typeof tags === 'string' ? tags.split(',').map(t => t.trim()) : tags;
    }

    // Handle image upload
    if (req.file) {
      // Delete old image from Cloudinary if exists
      if (post.imageUrl) {
        const publicId = post.imageUrl.split('/').pop().split('.')[0];
        cloudinary.uploader.destroy(`conference_uploads/${publicId}`)
          .catch(err => console.error('Error deleting old image:', err));
      }
      post.imageUrl = req.file.path;
    }

    await post.save();

    // Invalidate cache
    invalidateCache();

    res.json({
      success: true,
      message: 'Blog post updated successfully',
      data: post
    });
  } catch (error) {
    console.error('Error updating blog post:', error);
    
    // Handle duplicate slug error
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'A blog post with this title already exists'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to update blog post',
      error: error.message
    });
  }
});

/**
 * DELETE /api/admin/blog/posts/:id
 * Delete blog post
 */
router.delete('/posts/:id', async (req, res) => {
  try {
    const post = await BlogPost.findById(req.params.id);
    
    if (!post) {
      return res.status(404).json({
        success: false,
        message: 'Blog post not found'
      });
    }

    // Delete image from Cloudinary if exists
    if (post.imageUrl) {
      try {
        const publicId = post.imageUrl.split('/').pop().split('.')[0];
        await cloudinary.uploader.destroy(`conference_uploads/${publicId}`);
      } catch (err) {
        console.error('Error deleting image from Cloudinary:', err);
      }
    }

    await BlogPost.findByIdAndDelete(req.params.id);

    // Invalidate cache
    invalidateCache();

    res.json({
      success: true,
      message: 'Blog post deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting blog post:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete blog post',
      error: error.message
    });
  }
});

/**
 * PUT /api/admin/blog/posts/:id/publish
 * Toggle publish status
 */
router.put('/posts/:id/publish', async (req, res) => {
  try {
    const post = await BlogPost.findById(req.params.id);
    
    if (!post) {
      return res.status(404).json({
        success: false,
        message: 'Blog post not found'
      });
    }

    post.published = !post.published;
    
    // Set publishedAt if publishing for the first time
    if (post.published && !post.publishedAt) {
      post.publishedAt = new Date();
    }

    await post.save();

    // Invalidate cache
    invalidateCache();

    res.json({
      success: true,
      message: `Blog post ${post.published ? 'published' : 'unpublished'} successfully`,
      data: post
    });
  } catch (error) {
    console.error('Error toggling publish status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to toggle publish status',
      error: error.message
    });
  }
});

/**
 * POST /api/admin/blog/upload-image
 * Upload image for blog post (separate endpoint for editor)
 */
router.post('/upload-image', uploadImage.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No image file provided'
      });
    }

    res.json({
      success: true,
      data: {
        url: req.file.path,
        publicId: req.file.filename
      }
    });
  } catch (error) {
    console.error('Error uploading image:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upload image',
      error: error.message
    });
  }
});

module.exports = router;

