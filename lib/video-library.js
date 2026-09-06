'use strict';

const crypto = require('crypto');

function text(value) { return String(value || '').trim(); }
function slugify(value) {
  return text(value).toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}
function normalizeVideo(record, tenantId) {
  const now = new Date().toISOString();
  const sourceType = record && record.sourceType === 'uploaded' ? 'uploaded' : 'external';
  return {
    id: text(record && record.id) || `vid_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
    tenantId: text(tenantId),
    slug: slugify(record && (record.slug || record.titleEn || record.titleEl)) || `video-${Date.now().toString(36)}`,
    titleEl: text(record && record.titleEl), titleEn: text(record && record.titleEn),
    descriptionEl: text(record && record.descriptionEl), descriptionEn: text(record && record.descriptionEn),
    thumbnailUrl: text(record && record.thumbnailUrl), sourceType,
    videoStorageKey: sourceType === 'uploaded' ? text(record && record.videoStorageKey) : '',
    externalVideoUrl: sourceType === 'external' ? text(record && record.externalVideoUrl) : '',
    durationSeconds: record && record.durationSeconds !== '' && Number.isFinite(Number(record.durationSeconds)) ? Math.max(0, Number(record.durationSeconds)) : null,
    category: text(record && record.category),
    accessLevel: record && record.accessLevel === 'subscriber' ? 'subscriber' : 'public',
    published: record && record.published === true,
    featured: record && record.featured === true,
    sortOrder: Number.isFinite(Number(record && record.sortOrder)) ? Number(record.sortOrder) : 0,
    createdAt: text(record && record.createdAt) || now,
    updatedAt: now,
    publishedAt: record && record.published === true ? (text(record.publishedAt) || now) : null
  };
}
function listVideos(file, loadJson, tenantId) {
  const rows = loadJson(file, []);
  return (Array.isArray(rows) ? rows : []).filter((row) => String(row.tenantId || tenantId) === String(tenantId)).map((row) => normalizeVideo(row, tenantId));
}

module.exports = { normalizeVideo, listVideos, slugify };
