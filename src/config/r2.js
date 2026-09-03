require('dotenv').config();
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const r2Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET_NAME = process.env.R2_BUCKET_NAME || 'shazusoftbucket';
const PUBLIC_BASE_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');

/**
 * Upload a buffer or stream to Cloudflare R2
 */
async function uploadToR2(key, fileBuffer, contentType) {
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    Body: fileBuffer,
    ContentType: contentType,
  });

  await r2Client.send(command);

  // Return public dev url if available or key
  const publicUrl = PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/${key}` : `/${key}`;
  return {
    key,
    publicUrl,
    bucket: BUCKET_NAME,
  };
}

/**
 * Generate a pre-signed download URL (valid for 1 hour)
 */
async function getDownloadPresignedUrl(key, expiresIn = 3600) {
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
  });
  return await getSignedUrl(r2Client, command, { expiresIn });
}

/**
 * Delete an object from R2
 */
async function deleteFromR2(key) {
  const command = new DeleteObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
  });
  return await r2Client.send(command);
}

/**
 * Get an object as a Buffer from R2
 */
async function getObjectBuffer(key) {
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
  });
  const response = await r2Client.send(command);
  const byteArray = await response.Body.transformToByteArray();
  return Buffer.from(byteArray);
}

module.exports = {
  r2Client,
  uploadToR2,
  getDownloadPresignedUrl,
  deleteFromR2,
  getObjectBuffer,
  BUCKET_NAME,
  PUBLIC_BASE_URL,
};


