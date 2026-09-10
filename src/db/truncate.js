require('dotenv').config();
const db = require('../config/db');
const { r2Client, BUCKET_NAME, deleteFromR2 } = require('../config/r2');
const { ListObjectsV2Command, DeleteObjectsCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

/**
 * Delete objects from Cloudflare R2 bucket
 * @param {string} prefix - Optional prefix to target (e.g. 'conferences/' or '')
 */
async function purgeBucketObjects(prefix = '') {
  console.log(`\n📦 Checking Cloudflare R2 bucket: "${BUCKET_NAME}" (prefix: "${prefix || 'ALL'}")`);
  let totalDeleted = 0;
  let continuationToken = null;

  try {
    do {
      const listCommand = new ListObjectsV2Command({
        Bucket: BUCKET_NAME,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      });

      const listRes = await r2Client.send(listCommand);
      const objects = listRes.Contents || [];

      if (objects.length > 0) {
        // Batch delete up to 1000 objects per call
        try {
          const deleteCommand = new DeleteObjectsCommand({
            Bucket: BUCKET_NAME,
            Delete: {
              Objects: objects.map((obj) => ({ Key: obj.Key })),
              Quiet: true,
            },
          });
          await r2Client.send(deleteCommand);
          totalDeleted += objects.length;
          console.log(`   🗑️  Batch deleted ${objects.length} objects from R2`);
        } catch (batchErr) {
          // Fallback to individual deletion if batch delete is restricted
          console.warn(`   ⚠️ Batch delete error (${batchErr.message}). Falling back to individual deletes...`);
          for (const obj of objects) {
            try {
              await deleteFromR2(obj.Key);
              totalDeleted++;
            } catch (singleErr) {
              console.warn(`   ⚠️ Could not delete ${obj.Key}:`, singleErr.message);
            }
          }
        }
      }

      continuationToken = listRes.NextContinuationToken;
    } while (continuationToken);

    console.log(`✅ Cloudflare R2 bucket purge complete! Total objects removed: ${totalDeleted}`);
  } catch (err) {
    console.warn(`⚠️ Cloudflare R2 bucket scan/purge warning: ${err.message}`);
    console.log('   (Proceeding with database truncation)');
  }

  return totalDeleted;
}

/**
 * Main Truncate Script
 * Supports two modes:
 *  1. Default or '--submissions' (or '-s'):
 *     Purges all submission files from R2 and truncates all submission-related tables
 *     (submissions, submission_authors, submission_files, reviews, reviewer_assignments,
 *      conflicts, paper_decisions, session_presentations). Keeps users & conferences intact.
 * 
 *  2. '--all' (or '-a'):
 *     Purges ALL bucket objects and truncates EVERY database table (including users & conferences).
 */
async function truncateDatabase() {
  const isFullWipe = process.argv.includes('--all') || process.argv.includes('-a');

  console.log('\n======================================================');
  console.log(`🧹 SHAZU SOFT CMT — ${isFullWipe ? 'FULL SYSTEM PURGE (--all)' : 'SUBMISSIONS & BUCKET TRUNCATE'}`);
  console.log('======================================================');

  const client = await db.getClient();

  try {
    // 1. Fetch any explicit s3_keys from submission_files to ensure they are deleted
    console.log('\n1. Fetching registered submission files from database...');
    let dbKeys = [];
    try {
      const filesRes = await client.query('SELECT s3_key FROM submission_files WHERE s3_key IS NOT NULL');
      dbKeys = filesRes.rows.map((r) => r.s3_key).filter(Boolean);
      console.log(`   Found ${dbKeys.length} file records in database.`);
    } catch (e) {
      console.log('   Notice: Could not query submission_files table, proceeding to bucket scan.');
    }

    // 2. Delete all tracked files from R2
    if (dbKeys.length > 0) {
      console.log(`2. Deleting ${dbKeys.length} tracked submission files from Cloudflare R2...`);
      let count = 0;
      for (const key of dbKeys) {
        try {
          await deleteFromR2(key);
          count++;
        } catch (r2Err) {
          // Ignore individual delete errors
        }
      }
      console.log(`   ✅ Removed ${count} tracked files from R2.`);
    }

    // 3. Scan & sweep any remaining or orphaned submission files from the R2 bucket
    console.log('\n3. Sweeping Cloudflare R2 bucket for any remaining submission files...');
    if (isFullWipe) {
      // Full wipe: purge entire bucket
      await purgeBucketObjects('');
    } else {
      // Submissions only: purge conferences/ and submissions/ prefixes
      await purgeBucketObjects('conferences/');
      await purgeBucketObjects('submissions/');
    }

    // 4. Truncate PostgreSQL database tables
    console.log('\n4. Truncating database tables & resetting identity sequences...');

    if (isFullWipe) {
      // Full database wipe
      await client.query(`
        TRUNCATE TABLE 
          audit_logs,
          email_logs,
          announcements,
          session_presentations,
          conflicts,
          paper_decisions,
          reviews,
          reviewer_assignments,
          conference_reviewers,
          conference_chairs,
          submission_files,
          submission_authors,
          submissions,
          tracks,
          conferences,
          users
        RESTART IDENTITY CASCADE;
      `);
      console.log('   ✅ ALL database tables (users, conferences, submissions, logs) truncated!');
    } else {
      // Submissions-only wipe (preserves conferences, tracks, users, announcements)
      await client.query(`
        TRUNCATE TABLE 
          session_presentations,
          conflicts,
          paper_decisions,
          reviews,
          reviewer_assignments,
          submission_files,
          submission_authors,
          submissions
        RESTART IDENTITY CASCADE;
      `);
      console.log('   ✅ All submissions, files, authors, reviews, decisions & presentations truncated!');
      console.log('   ℹ️  Conferences, tracks, and user accounts have been preserved.');
    }

    console.log('\n======================================================');
    console.log('✨ TRUNCATE & BUCKET PURGE COMPLETED SUCCESSFULLY!');
    console.log('======================================================\n');
  } catch (err) {
    console.error('\n❌ Truncate failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await db.pool.end();
  }
}

if (require.main === module) {
  truncateDatabase();
}

module.exports = truncateDatabase;
