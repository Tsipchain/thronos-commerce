'use strict';

const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

function safeKey(value) {
  const key = String(value || '').replace(/\\/g, '/');
  if (!key || key.startsWith('/') || key.includes('..') || !/^[a-zA-Z0-9/_-]+\.(mp4|webm)$/.test(key)) {
    throw new Error('Invalid video storage key.');
  }
  return key;
}

function createVideoStorage(options = {}) {
  const provider = String(options.provider || process.env.VIDEO_STORAGE_PROVIDER || 'local').toLowerCase();
  const localRoot = options.localRoot;
  if (provider === 'local') {
    return {
      provider,
      async put({ key, buffer, filePath }) {
        const clean = safeKey(key);
        const target = path.resolve(localRoot, clean);
        if (!target.startsWith(path.resolve(localRoot) + path.sep)) throw new Error('Invalid video path.');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (filePath) fs.copyFileSync(filePath, target);
        else fs.writeFileSync(target, buffer);
        return { key: clean };
      },
      async remove(key) {
        const clean = safeKey(key);
        const target = path.resolve(localRoot, clean);
        if (!target.startsWith(path.resolve(localRoot) + path.sep)) throw new Error('Invalid video path.');
        try { fs.unlinkSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      },
      localPath(key) {
        const clean = safeKey(key);
        const target = path.resolve(localRoot, clean);
        if (!target.startsWith(path.resolve(localRoot) + path.sep)) throw new Error('Invalid video path.');
        return target;
      },
      async playbackUrl() { return null; }
    };
  }
  if (provider !== 's3') throw new Error(`Unsupported VIDEO_STORAGE_PROVIDER: ${provider}`);
  const bucket = options.bucket || process.env.VIDEO_STORAGE_BUCKET;
  if (!bucket) throw new Error('VIDEO_STORAGE_BUCKET is required for S3 video storage.');
  const accessKeyId = options.accessKey || process.env.VIDEO_STORAGE_ACCESS_KEY || '';
  const secretAccessKey = options.secretKey || process.env.VIDEO_STORAGE_SECRET_KEY || '';
  const client = new S3Client({
    endpoint: options.endpoint || process.env.VIDEO_STORAGE_ENDPOINT || undefined,
    region: options.region || process.env.VIDEO_STORAGE_REGION || 'us-east-1',
    forcePathStyle: Boolean(options.endpoint || process.env.VIDEO_STORAGE_ENDPOINT),
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {})
  });
  return {
    provider,
    async put({ key, buffer, filePath, contentType }) {
      const clean = safeKey(key);
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: clean, Body: filePath ? fs.createReadStream(filePath) : buffer, ContentType: contentType }));
      return { key: clean };
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: safeKey(key) }));
    },
    localPath() { return null; },
    async playbackUrl(key) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: safeKey(key) }), { expiresIn: 300 });
    }
  };
}

module.exports = { createVideoStorage, safeKey };
