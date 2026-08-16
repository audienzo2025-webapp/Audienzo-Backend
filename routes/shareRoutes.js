const express = require('express');
const router = express.Router();

const BlogPost = require('../models/BlogPost');
const { findConferenceByPublicSlug, applySlugAliasesToLeanDoc } = require('../utils/conferenceSlug');

function escapeHtml(input) {
  return String(input || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function normalizeWhitespace(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function truncate(s, maxLen) {
  const str = normalizeWhitespace(s);
  if (!maxLen || str.length <= maxLen) return str;
  return str.slice(0, Math.max(0, maxLen - 1)).trimEnd() + '…';
}

function absoluteUrl(base, path) {
  const b = String(base || '').replace(/\/+$/, '');
  const p = String(path || '').replace(/^\/+/, '');
  return b && p ? `${b}/${p}` : (b || p);
}

function normalizeOrigin(origin) {
  return String(origin || '').trim().replace(/\/+$/, '');
}

function safeParseUrl(url) {
  try {
    return new URL(String(url));
  } catch {
    return null;
  }
}

function hostVariants(hostname) {
  const h = String(hostname || '').toLowerCase().trim();
  if (!h) return new Set();
  const set = new Set([h]);
  if (h.startsWith('www.')) {
    set.add(h.slice(4));
  } else {
    set.add(`www.${h}`);
  }
  return set;
}

function isAllowedFrontendUrl(candidateUrl, frontendOrigin) {
  const origin = normalizeOrigin(frontendOrigin);
  const base = safeParseUrl(origin);
  const candidate = safeParseUrl(candidateUrl);
  if (!base || !candidate) return false;

  // Must be same protocol, and host must match (allow www/non-www variants).
  if (candidate.protocol !== base.protocol) return false;
  const allowedHosts = hostVariants(base.hostname);
  return allowedHosts.has(candidate.hostname.toLowerCase());
}

function getCanonicalOverride(req, frontendUrl) {
  const raw = req.query && req.query.canonical;
  if (!raw) return '';
  const canonical = String(raw).trim();
  // Only allow canonical URLs under our frontend domain to prevent poisoning.
  if (isAllowedFrontendUrl(canonical, frontendUrl)) return canonical;
  return '';
}

function getRedirectOverride(req, frontendUrl) {
  const raw = req.query && req.query.redirect;
  if (!raw) return '';
  const redirect = String(raw).trim();
  // Only allow redirects under our frontend domain.
  if (isAllowedFrontendUrl(redirect, frontendUrl)) return redirect;
  return '';
}

function renderShareHtml({
  title,
  description,
  imageUrl,
  url,
  type,
  redirectUrl
}) {
  const safeTitle = escapeHtml(title);
  const safeDesc = escapeHtml(description);
  const safeImg = escapeHtml(imageUrl);
  const safeUrl = escapeHtml(url);
  const safeType = escapeHtml(type || 'website');
  const safeRedirect = escapeHtml(redirectUrl || url);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
    <meta name="description" content="${safeDesc}" />

    <meta property="og:title" content="${safeTitle}" />
    <meta property="og:description" content="${safeDesc}" />
    <meta property="og:image" content="${safeImg}" />
    <meta property="og:url" content="${safeUrl}" />
    <meta property="og:type" content="${safeType}" />

    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${safeTitle}" />
    <meta name="twitter:description" content="${safeDesc}" />
    <meta name="twitter:image" content="${safeImg}" />

    <meta http-equiv="refresh" content="0; url=${safeRedirect}" />
  </head>
  <body>
    <noscript>
      <p><a href="${safeRedirect}">Continue</a></p>
    </noscript>
    <script>window.location.replace(${JSON.stringify(redirectUrl || url)});</script>
  </body>
</html>`;
}

/**
 * Public share page for events. LinkedIn/Facebook fetch OG tags from here.
 * GET /share/event/:slug
 */
router.get('/share/event/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const confRaw = await findConferenceByPublicSlug(slug);
    if (!confRaw) return res.status(404).send('Event not found');
    const conf = applySlugAliasesToLeanDoc(confRaw);
    const canonical = conf.urlSlug || conf.slug || slug;

    const isProduction = process.env.NODE_ENV === 'production';
    const frontendUrl = isProduction ? process.env.FRONTEND_URL : 'http://localhost:4200';
    const backendUrl = isProduction ? process.env.BACKEND_URL : 'http://localhost:3000';

    const shareUrl = absoluteUrl(backendUrl, `share/event/${encodeURIComponent(slug)}`);
    const defaultRedirectUrl = absoluteUrl(frontendUrl, `event-details/${encodeURIComponent(canonical)}`);
    const canonicalOverride = getCanonicalOverride(req, frontendUrl);
    const redirectOverride = getRedirectOverride(req, frontendUrl);
    const ogUrl = canonicalOverride || shareUrl;
    const redirectUrl = redirectOverride || defaultRedirectUrl;

    const title = conf.title || 'Event';
    const description = truncate(conf.description || '', 180) || 'View event details';
    const imageUrl = conf.imageUrl || absoluteUrl(frontendUrl, 'assets/placeholder.jpg');

    res.setHeader('Content-Type', 'text/html; charset=UTF-8');
    res.setHeader('Cache-Control', 'public, max-age=300'); // 5 minutes
    return res.send(renderShareHtml({
      title,
      description,
      imageUrl,
      url: ogUrl,
      type: 'website',
      redirectUrl
    }));
  } catch (err) {
    console.error('Error rendering event share page:', err);
    return res.status(500).send('Server error');
  }
});

/**
 * Public share page for blog posts. LinkedIn fetches OG tags from here.
 * GET /share/blog/:slug
 */
router.get('/share/blog/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const post = await BlogPost.findOne({ slug, published: true }).lean();
    if (!post) return res.status(404).send('Blog post not found');

    const isProduction = process.env.NODE_ENV === 'production';
    const frontendUrl = isProduction ? process.env.FRONTEND_URL : 'http://localhost:4200';
    const backendUrl = isProduction ? process.env.BACKEND_URL : 'http://localhost:3000';

    const shareUrl = absoluteUrl(backendUrl, `share/blog/${encodeURIComponent(slug)}`);
    const defaultRedirectUrl = absoluteUrl(frontendUrl, `blog/${encodeURIComponent(slug)}`);
    const canonicalOverride = getCanonicalOverride(req, frontendUrl);
    const redirectOverride = getRedirectOverride(req, frontendUrl);
    const ogUrl = canonicalOverride || shareUrl;
    const redirectUrl = redirectOverride || defaultRedirectUrl;

    const title = post.title || 'Blog';
    const description = truncate(post.excerpt || '', 180) || 'Read the article';
    const imageUrl = post.imageUrl || absoluteUrl(frontendUrl, 'assets/placeholder.jpg');

    res.setHeader('Content-Type', 'text/html; charset=UTF-8');
    res.setHeader('Cache-Control', 'public, max-age=300'); // 5 minutes
    return res.send(renderShareHtml({
      title,
      description,
      imageUrl,
      url: ogUrl,
      type: 'article',
      redirectUrl
    }));
  } catch (err) {
    console.error('Error rendering blog share page:', err);
    return res.status(500).send('Server error');
  }
});

module.exports = router;

