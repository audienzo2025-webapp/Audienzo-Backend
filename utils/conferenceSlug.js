const Conference = require('../models/Conference');

function generateSlugFromTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function normalizeUrlSlugInput(raw) {
  let t = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!t) return '';
  t = t.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return t.slice(0, 120);
}

async function isPublicSlugTaken(slug, excludeId) {
  if (!slug) return false;
  const q = {
    $or: [
      { urlSlug: slug },
      { slug: slug },
      { slugRedirects: slug }
    ]
  };
  if (excludeId) {
    q._id = { $ne: excludeId };
  }
  const found = await Conference.findOne(q).select('_id').lean();
  return !!found;
}

async function allocateUniquePublicSlug(base, excludeId) {
  const normalized = normalizeUrlSlugInput(base) || 'event';
  let n = 0;
  while (n < 500) {
    const candidate = n === 0 ? normalized : `${normalized}-${n}`;
    if (!(await isPublicSlugTaken(candidate, excludeId))) {
      return candidate;
    }
    n += 1;
  }
  throw new Error('Unable to allocate a unique URL slug');
}

async function findConferenceByPublicSlug(slug) {
  if (!slug || !String(slug).trim()) return null;
  const s = String(slug).trim();
  return Conference.findOne({
    $or: [
      { urlSlug: s },
      { slug: s },
      { slugRedirects: s }
    ]
  }).lean();
}

function applySlugAliasesToLeanDoc(doc) {
  if (!doc) return doc;
  const primary = String(doc.urlSlug || doc.slug || '').trim();
  return { ...doc, urlSlug: primary, slug: primary };
}

/**
 * One-time safe migration: urlSlug from legacy slug or title; sync slug mirror; drop legacy unique on slug if present.
 */
async function migrateConferenceUrlSlugs() {
  const cursor = Conference.find({}).cursor();
  for await (const doc of cursor) {
    const legacy = String(doc.slug || '').trim();
    const currentUrl = String(doc.urlSlug || '').trim();
    if (!currentUrl) {
      const base = legacy || generateSlugFromTitle(doc.title) || 'event';
      const unique = await allocateUniquePublicSlug(base, doc._id);
      await Conference.updateOne({ _id: doc._id }, { $set: { urlSlug: unique, slug: unique } });
    } else if (!legacy || legacy !== currentUrl) {
      await Conference.updateOne({ _id: doc._id }, { $set: { slug: currentUrl } });
    }
  }
  try {
    await Conference.collection.dropIndex('slug_1');
  } catch (_) {
    /* index missing or different name */
  }
}

module.exports = {
  generateSlugFromTitle,
  normalizeUrlSlugInput,
  isPublicSlugTaken,
  allocateUniquePublicSlug,
  findConferenceByPublicSlug,
  applySlugAliasesToLeanDoc,
  migrateConferenceUrlSlugs
};
