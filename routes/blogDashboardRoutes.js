const express = require('express');
const router = express.Router();
const BlogPost = require('../models/BlogPost');
const blogEditorAuthMiddleware = require('../middleware/blogEditorAuthMiddleware');
const { cloudinary, uploadImage } = require('../config/cloudinary');
const { invalidateCache } = require('./blogRoutes');

// Apply blog editor middleware to all routes
router.use(blogEditorAuthMiddleware);

/**
 * GET /api/blog-dashboard/analytics/overview
 * Get overview statistics for blog dashboard
 */
router.get('/analytics/overview', async (req, res) => {
  try {
    const now = new Date();
    const last7Days = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const last30Days = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const last90Days = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfWeek = new Date(now.getTime() - (now.getDay() * 24 * 60 * 60 * 1000));
    startOfWeek.setHours(0, 0, 0, 0);

    // Total posts
    const totalPosts = await BlogPost.countDocuments();
    const publishedPosts = await BlogPost.countDocuments({ published: true });
    const draftPosts = await BlogPost.countDocuments({ published: false });

    // Total views
    const totalViewsResult = await BlogPost.aggregate([
      { $group: { _id: null, totalViews: { $sum: '$views' } } }
    ]);
    const totalViews = totalViewsResult[0]?.totalViews || 0;

    // Views in last 30 days (approximate - based on published posts)
    const recentViewsResult = await BlogPost.aggregate([
      {
        $match: {
          published: true,
          publishedAt: { $gte: last30Days }
        }
      },
      { $group: { _id: null, totalViews: { $sum: '$views' } } }
    ]);
    const recentViews = recentViewsResult[0]?.totalViews || 0;

    // Posts published this month
    const postsThisMonth = await BlogPost.countDocuments({
      published: true,
      publishedAt: { $gte: startOfMonth }
    });

    // Posts published this week
    const postsThisWeek = await BlogPost.countDocuments({
      published: true,
      publishedAt: { $gte: startOfWeek }
    });

    // Average views per post
    const avgViews = publishedPosts > 0 ? Math.round(totalViews / publishedPosts) : 0;

    // Most popular posts (top 5)
    const topPosts = await BlogPost.find({ published: true })
      .select('title slug views publishedAt')
      .sort({ views: -1 })
      .limit(5)
      .lean();

    // Recent posts (last 5 published)
    const recentPosts = await BlogPost.find({ published: true })
      .select('title slug views publishedAt')
      .sort({ publishedAt: -1 })
      .limit(5)
      .lean();

    res.json({
      success: true,
      data: {
        overview: {
          totalPosts,
          publishedPosts,
          draftPosts,
          totalViews,
          recentViews,
          avgViews,
          postsThisMonth,
          postsThisWeek
        },
        topPosts,
        recentPosts
      }
    });
  } catch (error) {
    console.error('Error fetching blog analytics overview:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch analytics overview',
      error: error.message
    });
  }
});

/**
 * GET /api/blog-dashboard/analytics/detailed
 * Get detailed analytics with time series data
 */
router.get('/analytics/detailed', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const now = new Date();
    const startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    // Views over time (grouped by day)
    const viewsOverTime = await BlogPost.aggregate([
      {
        $match: {
          published: true,
          publishedAt: { $gte: startDate }
        }
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$publishedAt' }
          },
          views: { $sum: '$views' },
          posts: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // Views by post
    const viewsByPost = await BlogPost.find({ published: true })
      .select('title slug views publishedAt')
      .sort({ views: -1 })
      .limit(20)
      .lean();

    // Publishing frequency (posts per month)
    const publishingFrequency = await BlogPost.aggregate([
      {
        $match: {
          published: true,
          publishedAt: { $gte: startDate }
        }
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m', date: '$publishedAt' }
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // Tag performance
    const tagPerformance = await BlogPost.aggregate([
      {
        $match: { published: true }
      },
      { $unwind: { path: '$tags', preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: '$tags',
          views: { $sum: '$views' },
          posts: { $sum: 1 }
        }
      },
      { $sort: { views: -1 } },
      { $limit: 10 }
    ]);

    // Author performance (if multiple authors)
    const authorPerformance = await BlogPost.aggregate([
      {
        $match: { published: true }
      },
      {
        $group: {
          _id: '$authorName',
          views: { $sum: '$views' },
          posts: { $sum: 1 }
        }
      },
      { $sort: { views: -1 } }
    ]);

    // Calculate growth rate
    const firstHalf = await BlogPost.aggregate([
      {
        $match: {
          published: true,
          publishedAt: { $gte: new Date(now.getTime() - days * 24 * 60 * 60 * 1000) }
        }
      },
      {
        $group: {
          _id: null,
          views: { $sum: '$views' }
        }
      }
    ]);

    const secondHalf = await BlogPost.aggregate([
      {
        $match: {
          published: true,
          publishedAt: { $gte: new Date(now.getTime() - (days / 2) * 24 * 60 * 60 * 1000) }
        }
      },
      {
        $group: {
          _id: null,
          views: { $sum: '$views' }
        }
      }
    ]);

    const firstHalfViews = firstHalf[0]?.views || 0;
    const secondHalfViews = secondHalf[0]?.views || 0;
    const growthRate = firstHalfViews > 0 
      ? ((secondHalfViews - firstHalfViews) / firstHalfViews * 100).toFixed(1)
      : '0';

    res.json({
      success: true,
      data: {
        viewsOverTime,
        viewsByPost,
        publishingFrequency,
        tagPerformance,
        authorPerformance,
        growthRate: parseFloat(growthRate)
      }
    });
  } catch (error) {
    console.error('Error fetching detailed analytics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch detailed analytics',
      error: error.message
    });
  }
});

/**
 * GET /api/blog-dashboard/analytics/posts/:id
 * Get analytics for a specific post
 */
router.get('/analytics/posts/:id', async (req, res) => {
  try {
    const post = await BlogPost.findById(req.params.id).lean();

    if (!post) {
      return res.status(404).json({
        success: false,
        message: 'Blog post not found'
      });
    }

    // Calculate days since published
    const daysSincePublished = post.publishedAt
      ? Math.floor((new Date() - new Date(post.publishedAt)) / (1000 * 60 * 60 * 24))
      : 0;

    // Average views per day
    const avgViewsPerDay = daysSincePublished > 0
      ? (post.views || 0) / daysSincePublished
      : 0;

    res.json({
      success: true,
      data: {
        post: {
          _id: post._id,
          title: post.title,
          slug: post.slug,
          views: post.views || 0,
          publishedAt: post.publishedAt,
          createdAt: post.createdAt
        },
        metrics: {
          totalViews: post.views || 0,
          daysSincePublished,
          avgViewsPerDay: Math.round(avgViewsPerDay * 10) / 10
        }
      }
    });
  } catch (error) {
    console.error('Error fetching post analytics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch post analytics',
      error: error.message
    });
  }
});

/**
 * GET /api/blog-dashboard/posts
 * Get all blog posts (including drafts) for blog dashboard
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
    console.error('Error fetching blog posts:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch blog posts',
      error: error.message
    });
  }
});

/**
 * GET /api/blog-dashboard/posts/:id
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
 * POST /api/blog-dashboard/posts
 * Create new blog post
 */
router.post('/posts', uploadImage.single('image'), async (req, res) => {
  try {
    const { title, excerpt, content, published, tags, authorName } = req.body;
    const userId = req.blogEditorUser._id;

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
      imageUrl = req.file.path;
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
      authorName: authorName || req.blogEditorUser.fullName || 'Audienzo Team',
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
 * PUT /api/blog-dashboard/posts/:id
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
 * DELETE /api/blog-dashboard/posts/:id
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
 * PUT /api/blog-dashboard/posts/:id/publish
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
 * POST /api/blog-dashboard/upload-image
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
