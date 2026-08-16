const express = require('express');
const router = express.Router();
const BlogPost = require('../models/BlogPost');
const NodeCache = require('node-cache');

// Initialize cache with 5 minute TTL
const blogCache = new NodeCache({ stdTTL: 300 });

// Helper function to invalidate cache
const invalidateCache = () => {
  blogCache.flushAll();
};

/**
 * GET /api/blog/posts
 * Get all published blog posts (public)
 */
router.get('/posts', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    const search = (req.query.search || '').toString().trim();
    const tag = (req.query.tag || '').toString().trim();
    const year = req.query.year ? parseInt(req.query.year) : undefined;
    const month = req.query.month ? parseInt(req.query.month) : undefined;

    // Cache key includes filters
    const cacheKey = `blog-posts-${page}-${limit}-${encodeURIComponent(search)}-${encodeURIComponent(tag)}-${year || ''}-${month || ''}`;
    const cached = blogCache.get(cacheKey);
    if (cached) {
      return res.json({
        success: true,
        data: cached
      });
    }

    const filter = { published: true };
    if (tag) {
      filter.tags = tag;
    }

    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: 'i' } },
        { excerpt: { $regex: search, $options: 'i' } },
        { content: { $regex: search, $options: 'i' } }
      ];
    }

    // Archive filter: year or year+month
    if (year && !Number.isNaN(year) && year >= 1970 && year <= 2100) {
      if (month && !Number.isNaN(month) && month >= 1 && month <= 12) {
        const start = new Date(Date.UTC(year, month - 1, 1));
        const end = new Date(Date.UTC(year, month, 1));
        filter.publishedAt = { $gte: start, $lt: end };
      } else {
        const start = new Date(Date.UTC(year, 0, 1));
        const end = new Date(Date.UTC(year + 1, 0, 1));
        filter.publishedAt = { $gte: start, $lt: end };
      }
    }

    const posts = await BlogPost.find(filter)
      .select('-content') // Don't send full content in list
      .populate('author', 'fullName email')
      .sort({ publishedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await BlogPost.countDocuments(filter);

    const result = {
      posts,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    };

    // Cache the result
    blogCache.set(cacheKey, result);

    res.json({
      success: true,
      data: result
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
 * GET /api/blog/meta
 * Sidebar metadata for public resources/blog list (categories + archives)
 */
router.get('/meta', async (req, res) => {
  try {
    const cacheKey = 'blog-meta';
    const cached = blogCache.get(cacheKey);
    if (cached) {
      return res.json({ success: true, data: cached });
    }

    const categories = await BlogPost.aggregate([
      { $match: { published: true } },
      { $unwind: { path: '$tags', preserveNullAndEmptyArrays: false } },
      { $group: { _id: '$tags', count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } }
    ]);

    const archives = await BlogPost.aggregate([
      { $match: { published: true, publishedAt: { $type: 'date' } } },
      {
        $group: {
          _id: { year: { $year: '$publishedAt' }, month: { $month: '$publishedAt' } },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.year': -1, '_id.month': -1 } }
    ]);

    const result = {
      categories: categories.map(c => ({ tag: c._id, count: c.count })),
      archives: archives.map(a => ({ year: a._id.year, month: a._id.month, count: a.count }))
    };

    blogCache.set(cacheKey, result);

    return res.json({ success: true, data: result });
  } catch (error) {
    console.error('Error fetching blog meta:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch blog meta',
      error: error.message
    });
  }
});

/**
 * GET /api/blog/posts/:slug
 * Get single blog post by slug (public)
 */
router.get('/posts/:slug', async (req, res) => {
  try {
    const { slug } = req.params;

    // Check cache first
    const cacheKey = `blog-post-${slug}`;
    const cached = blogCache.get(cacheKey);
    if (cached) {
      // Increment views (async, don't wait)
      BlogPost.findOneAndUpdate(
        { slug },
        { $inc: { views: 1 } }
      ).catch(err => console.error('Error incrementing views:', err));

      return res.json({
        success: true,
        data: cached
      });
    }

    const post = await BlogPost.findOne({ slug, published: true })
      .populate('author', 'fullName email')
      .lean();

    if (!post) {
      return res.status(404).json({
        success: false,
        message: 'Blog post not found'
      });
    }

    // Increment views
    await BlogPost.findOneAndUpdate(
      { slug },
      { $inc: { views: 1 } }
    );
    post.views = (post.views || 0) + 1;

    // Cache the result
    blogCache.set(cacheKey, post);

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
 * GET /api/blog/recent
 * Get recent published posts (public)
 */
router.get('/recent', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 5;

    // Check cache
    const cacheKey = `blog-recent-${limit}`;
    const cached = blogCache.get(cacheKey);
    if (cached) {
      return res.json({
        success: true,
        data: cached
      });
    }

    const posts = await BlogPost.find({ published: true })
      .select('title slug excerpt imageUrl publishedAt authorName')
      .sort({ publishedAt: -1 })
      .limit(limit)
      .lean();

    // Cache the result
    blogCache.set(cacheKey, posts);

    res.json({
      success: true,
      data: posts
    });
  } catch (error) {
    console.error('Error fetching recent posts:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch recent posts',
      error: error.message
    });
  }
});

// Export cache invalidation function for use in admin routes
module.exports = { router, invalidateCache };

