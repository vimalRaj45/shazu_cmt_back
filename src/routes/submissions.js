const path = require('path');
const archiver = require('archiver');
const db = require('../config/db');
const { authenticate, requireRoles } = require('../middlewares/auth');
const { uploadToR2, getDownloadPresignedUrl, deleteFromR2, getObjectBuffer } = require('../config/r2');
const { sendSubmissionConfirmation } = require('../services/emailService');
const { logAudit } = require('../services/auditService');

async function submissionRoutes(fastify, options) {
  // Generate unique submission number helper
  async function generateSubmissionNumber() {
    const year = new Date().getFullYear();
    const countRes = await db.query('SELECT COUNT(*) FROM submissions');
    const seq = parseInt(countRes.rows[0].count, 10) + 101;
    return `CMT-${year}-${String(seq).padStart(5, '0')}`;
  }

  // Author: List my submissions
  fastify.get('/my', { preHandler: [authenticate] }, async (request, reply) => {
    try {
      const userId = request.currentUser.id;
      const res = await db.query(
        `SELECT s.*, 
                c.name as conference_name, c.short_name as conference_short_name,
                t.name as track_name,
                pd.decision, pd.decision_notes,
                (SELECT json_agg(sa.* ORDER BY sa.author_order ASC) FROM submission_authors sa WHERE sa.submission_id = s.id) as authors,
                (SELECT json_agg(sf.*) FROM submission_files sf WHERE sf.submission_id = s.id) as files
         FROM submissions s
         JOIN conferences c ON s.conference_id = c.id
         LEFT JOIN tracks t ON s.track_id = t.id
         LEFT JOIN paper_decisions pd ON s.id = pd.submission_id
         WHERE s.corresponding_author_id = $1 OR s.id IN (
           SELECT submission_id FROM submission_authors WHERE email = $2
         )
         ORDER BY s.created_at DESC`,
        [userId, request.currentUser.email]
      );
      return { submissions: res.rows };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to fetch author submissions', details: err.message });
    }
  });

  // Chair/Admin: List all submissions for a conference
  fastify.get('/conference/:conferenceId', { preHandler: [authenticate, requireRoles('admin', 'chair')] }, async (request, reply) => {
    const { conferenceId } = request.params;
    const { trackId, status, search } = request.query || {};

    try {
      let queryText = `
        SELECT s.*, 
               t.name as track_name,
               u.first_name as author_first_name, u.last_name as author_last_name, u.email as author_email,
               pd.decision, pd.decision_notes,
               (SELECT COUNT(*) FROM reviewer_assignments ra WHERE ra.submission_id = s.id) as assigned_reviewers_count,
               (SELECT COUNT(*) FROM reviews r WHERE r.submission_id = s.id AND r.is_draft = false) as completed_reviews_count,
               (SELECT ROUND(AVG(r.overall_score), 2) FROM reviews r WHERE r.submission_id = s.id AND r.is_draft = false) as average_score,
               (SELECT json_agg(sa.* ORDER BY sa.author_order ASC) FROM submission_authors sa WHERE sa.submission_id = s.id) as authors,
               (SELECT json_agg(sf.*) FROM submission_files sf WHERE sf.submission_id = s.id) as files
        FROM submissions s
        LEFT JOIN tracks t ON s.track_id = t.id
        LEFT JOIN users u ON s.corresponding_author_id = u.id
        LEFT JOIN paper_decisions pd ON s.id = pd.submission_id
        WHERE s.conference_id = $1
      `;
      const params = [conferenceId];

      if (trackId) {
        params.push(trackId);
        queryText += ` AND s.track_id = $${params.length}`;
      }

      if (status) {
        params.push(status);
        queryText += ` AND s.status = $${params.length}`;
      }

      if (search) {
        params.push(`%${search}%`);
        queryText += ` AND (s.title ILIKE $${params.length} OR s.submission_number ILIKE $${params.length})`;
      }

      queryText += ' ORDER BY s.id DESC';

      const res = await db.query(queryText, params);
      return { submissions: res.rows };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to fetch conference submissions', details: err.message });
    }
  });

  // Get single submission by ID
  fastify.get('/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params;
    const userId = request.currentUser.id;
    const userRole = request.currentUser.role;

    try {
      const res = await db.query(
        `SELECT s.*, 
                c.name as conference_name, c.short_name as conference_short_name,
                c.review_deadline, c.decision_date, c.camera_ready_deadline,
                t.name as track_name,
                u.first_name as author_first_name, u.last_name as author_last_name, u.email as author_email,
                pd.decision, pd.decision_notes
         FROM submissions s
         JOIN conferences c ON s.conference_id = c.id
         LEFT JOIN tracks t ON s.track_id = t.id
         LEFT JOIN users u ON s.corresponding_author_id = u.id
         LEFT JOIN paper_decisions pd ON s.id = pd.submission_id
         WHERE s.id = $1`,
        [id]
      );

      if (res.rows.length === 0) {
        return reply.code(404).send({ error: 'Submission not found' });
      }

      const submission = res.rows[0];

      // Access control check:
      // Admin/Chair can view all
      // Author can view own
      // Reviewer can view only if assigned
      if (userRole !== 'admin' && userRole !== 'chair') {
        const isAuthor = submission.corresponding_author_id === userId;
        const isAssignedReviewerRes = await db.query(
          'SELECT id FROM reviewer_assignments WHERE submission_id = $1 AND reviewer_id = $2',
          [id, userId]
        );
        const isAssignedReviewer = isAssignedReviewerRes.rows.length > 0;

        if (!isAuthor && !isAssignedReviewer) {
          return reply.code(403).send({ error: 'You are not authorized to view this paper submission.' });
        }
      }

      // Fetch authors
      const authorsRes = await db.query('SELECT * FROM submission_authors WHERE submission_id = $1 ORDER BY author_order ASC', [id]);
      submission.authors = authorsRes.rows;

      // Fetch files
      const filesRes = await db.query('SELECT * FROM submission_files WHERE submission_id = $1 ORDER BY uploaded_at DESC', [id]);
      submission.files = filesRes.rows;

      return { submission };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to fetch submission', details: err.message });
    }
  });

  // Create new Paper Submission
  fastify.post('/', { preHandler: [authenticate] }, async (request, reply) => {
    const {
      conferenceId,
      trackId,
      title,
      abstract,
      keywords = [],
      authors = [],
    } = request.body || {};

    if (!conferenceId || !title || !abstract) {
      return reply.code(400).send({ error: 'Conference ID, Title, and Abstract are required' });
    }

    // Verify conference exists and is open
    const confRes = await db.query('SELECT * FROM conferences WHERE id = $1', [conferenceId]);
    if (confRes.rows.length === 0) {
      return reply.code(404).send({ error: 'Conference does not exist' });
    }
    const conf = confRes.rows[0];

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      const submissionNumber = await generateSubmissionNumber();

      const subRes = await client.query(
        `INSERT INTO submissions (conference_id, track_id, submission_number, title, abstract, keywords, corresponding_author_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'submitted')
         RETURNING *;`,
        [conferenceId, trackId || null, submissionNumber, title.trim(), abstract.trim(), keywords, request.currentUser.id]
      );

      const newSub = subRes.rows[0];

      // Add Primary / Corresponding Author first
      if (Array.isArray(authors) && authors.length > 0) {
        for (let i = 0; i < authors.length; i++) {
          const a = authors[i];
          await client.query(
            `INSERT INTO submission_authors (submission_id, name, email, institution, department, country, is_primary, is_corresponding, author_order)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);`,
            [
              newSub.id,
              a.name || `${request.currentUser.first_name} ${request.currentUser.last_name}`,
              a.email || request.currentUser.email,
              a.institution || request.currentUser.institution || '',
              a.department || '',
              a.country || '',
              i === 0,
              a.is_corresponding !== undefined ? a.is_corresponding : i === 0,
              i + 1,
            ]
          );
        }
      } else {
        // Default current user as primary author
        await client.query(
          `INSERT INTO submission_authors (submission_id, name, email, institution, department, country, is_primary, is_corresponding, author_order)
           VALUES ($1, $2, $3, $4, $5, $6, true, true, 1);`,
          [
            newSub.id,
            `${request.currentUser.first_name} ${request.currentUser.last_name}`,
            request.currentUser.email,
            request.currentUser.institution || '',
            request.currentUser.department || '',
            request.currentUser.country || '',
          ]
        );
      }

      await client.query('COMMIT');

      // Send automated Hostinger email confirmation
      sendSubmissionConfirmation({
        user: request.currentUser,
        conference: conf,
        submission: newSub,
      }).catch((e) => console.error('Failed to send submission email:', e.message));

      await logAudit({
        conferenceId,
        userId: request.currentUser.id,
        action: 'SUBMISSION_CREATED',
        entityType: 'submission',
        entityId: newSub.id,
        details: { submissionNumber: newSub.submission_number, title: newSub.title },
      });

      return { submission: newSub };
    } catch (err) {
      await client.query('ROLLBACK');
      return reply.code(500).send({ error: 'Failed to create submission', details: err.message });
    } finally {
      client.release();
    }
  });

  // Upload file (manuscript, supplementary, revision, camera_ready, presentation) directly to R2
  fastify.post('/:id/upload-file', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params;
    const data = await request.file();

    if (!data) {
      return reply.code(400).send({ error: 'No file uploaded' });
    }

    try {
      const subRes = await db.query(
        `SELECT s.*, c.short_name as conference_short_name
         FROM submissions s
         LEFT JOIN conferences c ON s.conference_id = c.id
         WHERE s.id = $1`,
        [id]
      );
      if (subRes.rows.length === 0) {
        return reply.code(404).send({ error: 'Submission not found' });
      }
      const submission = subRes.rows[0];

      const queryType = request.query && (request.query.fileType || request.query.type);
      let fileType = queryType || (data.fields && data.fields.fileType && data.fields.fileType.value);

      // If not explicitly provided and submission is already accepted, automatically treat upload as camera_ready
      if (!fileType) {
        fileType = (submission.status === 'accepted' || submission.status === 'camera_ready_pending' || submission.status === 'camera_ready_approved')
          ? 'camera_ready'
          : 'manuscript';
      }

      const buffer = await data.toBuffer();
      const originalFilename = data.filename || 'manuscript.pdf';
      const mimeType = data.mimetype;
      const fileSize = buffer.length;

      // Get current version count for this file type to assign next version
      const verRes = await db.query(
        'SELECT COUNT(*) FROM submission_files WHERE submission_id = $1 AND file_type = $2',
        [id, fileType]
      );
      const nextVersion = parseInt(verRes.rows[0].count, 10) + 1;

      // Build standardized, space-free file name
      const ext = path.extname(originalFilename) || '.pdf';
      const confCode = (submission.conference_short_name || 'CONF').replace(/[^a-zA-Z0-9_-]/g, '_');
      const subCode = (submission.submission_number || `SUB-${submission.id}`).replace(/[^a-zA-Z0-9_-]/g, '_');
      const typeLabel = fileType === 'camera_ready' ? 'CameraReady' : fileType === 'revision' ? 'Revision' : fileType === 'supplementary' ? 'Supplementary' : 'Manuscript';
      
      // Standardized display name e.g. "ICACIT-2026_CMT-2026-00101_Revision_v2.pdf"
      const standardizedFilename = `${confCode}_${subCode}_${typeLabel}_v${nextVersion}${ext}`;

      // Clean original filename without spaces for S3 storage safety
      const cleanOriginal = originalFilename.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');
      const timestamp = Date.now();
      const s3Key = `conferences/${submission.conference_id}/submissions/${subCode}/${fileType}_v${nextVersion}_${timestamp}_${cleanOriginal}`;

      // Upload to Cloudflare R2
      const r2Result = await uploadToR2(s3Key, buffer, mimeType);

      // Record in DB with the clean standardized filename
      const fileRecordRes = await db.query(
        `INSERT INTO submission_files (submission_id, file_type, file_name, file_size, mime_type, s3_key, public_url, version, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *;`,
        [id, fileType, standardizedFilename, fileSize, mimeType, s3Key, r2Result.publicUrl, nextVersion, request.currentUser.id]
      );

      // Update submission status if uploading revision or camera-ready
      if (fileType === 'revision') {
        const rebuttalNotes = (data.fields && data.fields.rebuttalNotes && data.fields.rebuttalNotes.value) || '';
        await db.query(
          `UPDATE submissions SET status = 'under_review', rebuttal_notes = COALESCE($1, rebuttal_notes), updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
          [rebuttalNotes || null, id]
        );
      } else if (fileType === 'camera_ready') {
        await db.query(`UPDATE submissions SET status = 'camera_ready_pending', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
      }

      await logAudit({
        conferenceId: submission.conference_id,
        userId: request.currentUser.id,
        action: 'FILE_UPLOADED',
        entityType: 'submission_file',
        entityId: fileRecordRes.rows[0].id,
        details: { submissionId: id, fileType, filename: standardizedFilename, originalFilename, size: fileSize },
      });

      return { file: fileRecordRes.rows[0] };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: 'File upload failed', details: err.message });
    }
  });

  // Get download presigned URL / file details
  fastify.get('/files/:fileId', { preHandler: [authenticate] }, async (request, reply) => {
    const { fileId } = request.params;
    try {
      const fileRes = await db.query('SELECT * FROM submission_files WHERE id = $1', [fileId]);
      if (fileRes.rows.length === 0) {
        return reply.code(404).send({ error: 'File not found' });
      }

      const file = fileRes.rows[0];
      const downloadUrl = await getDownloadPresignedUrl(file.s3_key);

      return {
        file,
        downloadUrl,
        publicUrl: file.public_url,
        fileName: file.file_name,
      };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to generate download URL', details: err.message });
    }
  });

  // Get download presigned URL for a file (legacy alias)
  fastify.get('/files/:fileId/download', { preHandler: [authenticate] }, async (request, reply) => {
    const { fileId } = request.params;
    try {
      const fileRes = await db.query('SELECT * FROM submission_files WHERE id = $1', [fileId]);
      if (fileRes.rows.length === 0) {
        return reply.code(404).send({ error: 'File not found' });
      }

      const file = fileRes.rows[0];
      const downloadUrl = await getDownloadPresignedUrl(file.s3_key);

      return {
        downloadUrl,
        publicUrl: file.public_url,
        fileName: file.file_name,
      };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to generate download URL', details: err.message });
    }
  });

  // Delete a submission file (Admin / Chair / File Owner)
  fastify.delete('/files/:fileId', { preHandler: [authenticate] }, async (request, reply) => {
    const { fileId } = request.params;
    const idNum = parseInt(fileId, 10);
    if (isNaN(idNum)) {
      return reply.code(400).send({ error: 'Invalid file ID' });
    }

    try {
      const fileRes = await db.query(
        `SELECT sf.*, s.conference_id, s.corresponding_author_id, s.submission_number
         FROM submission_files sf
         JOIN submissions s ON sf.submission_id = s.id
         WHERE sf.id = $1`,
        [idNum]
      );

      if (fileRes.rows.length === 0) {
        return reply.code(404).send({ error: 'File not found in database or already deleted' });
      }

      const file = fileRes.rows[0];
      const isPrivileged = request.currentUser.role === 'admin' || request.currentUser.role === 'chair';
      const isOwner = request.currentUser.id === file.uploaded_by || request.currentUser.id === file.corresponding_author_id;

      if (!isPrivileged && !isOwner) {
        return reply.code(403).send({ error: 'You do not have permission to delete this file' });
      }

      // 1. Delete from R2 bucket
      if (file.s3_key) {
        try {
          await deleteFromR2(file.s3_key);
        } catch (r2Err) {
          request.log.warn(`Failed to delete object from R2 (${file.s3_key}): ${r2Err.message}`);
        }
      }

      // 2. Delete from DB
      await db.query('DELETE FROM submission_files WHERE id = $1', [idNum]);

      // 3. Audit log
      await logAudit({
        conferenceId: file.conference_id,
        userId: request.currentUser.id,
        action: 'FILE_DELETED',
        entityType: 'submission_file',
        entityId: idNum,
        details: { submissionId: file.submission_id, submissionNumber: file.submission_number, fileName: file.file_name },
      });

      return { message: 'File deleted successfully', fileId: idNum };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to delete file', details: err.message });
    }
  });

  // Download all files as a ZIP archive (Chair/Admin)
  fastify.get('/conference/:conferenceId/download-zip', { preHandler: [authenticate, requireRoles('admin', 'chair')] }, async (request, reply) => {
    const { conferenceId } = request.params;
    const { fileType, trackId, status } = request.query || {};

    try {
      let query = `
        SELECT sf.*, s.submission_number, s.title, c.short_name as conference_short_name
        FROM submission_files sf
        JOIN submissions s ON sf.submission_id = s.id
        JOIN conferences c ON s.conference_id = c.id
        WHERE s.conference_id = $1
      `;
      const params = [conferenceId];

      if (fileType && fileType !== 'all') {
        params.push(fileType);
        query += ` AND sf.file_type = $${params.length}`;
      }

      if (trackId) {
        params.push(trackId);
        query += ` AND s.track_id = $${params.length}`;
      }

      if (status) {
        params.push(status);
        query += ` AND s.status = $${params.length}`;
      }

      query += ` ORDER BY s.submission_number ASC, sf.version DESC`;

      const filesRes = await db.query(query, params);
      if (filesRes.rows.length === 0) {
        return reply.code(404).send({ error: 'No files found matching the criteria to download' });
      }

      const confCode = (filesRes.rows[0].conference_short_name || 'CONF').replace(/[^a-zA-Z0-9_-]/g, '_');
      const zipFilename = `${confCode}_Submissions_Backup_${new Date().toISOString().slice(0, 10)}.zip`;

      const archive = archiver('zip', { zlib: { level: 6 } });

      reply.header('Content-Type', 'application/zip');
      reply.header('Content-Disposition', `attachment; filename="${zipFilename}"`);

      // Pipe archive to response stream
      reply.send(archive);

      for (const f of filesRes.rows) {
        try {
          const buffer = await getObjectBuffer(f.s3_key);
          const subFolder = f.submission_number ? f.submission_number.replace(/[^a-zA-Z0-9_-]/g, '_') : `SUB_${f.submission_id}`;
          const cleanName = f.file_name ? f.file_name.replace(/[^a-zA-Z0-9._-]/g, '_') : `file_${f.id}.pdf`;
          archive.append(buffer, { name: `${subFolder}/${cleanName}` });
        } catch (fileErr) {
          request.log.error(`[ZIP Warning] Failed to add file ${f.id} (${f.s3_key}): ${fileErr.message}`);
        }
      }

      await archive.finalize();
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to generate ZIP archive', details: err.message });
    }
  });

  // Bulk Delete Submission Files (Admin / Chair)
  fastify.post('/conference/:conferenceId/bulk-delete-files', { preHandler: [authenticate, requireRoles('admin', 'chair')] }, async (request, reply) => {
    const { conferenceId } = request.params;
    const { fileIds } = request.body || {};

    if (!Array.isArray(fileIds) || fileIds.length === 0) {
      return reply.code(400).send({ error: 'Please provide an array of fileIds to delete' });
    }

    try {
      const filesRes = await db.query(
        `SELECT sf.id, sf.s3_key, sf.file_name, sf.submission_id, s.conference_id, s.submission_number
         FROM submission_files sf
         JOIN submissions s ON sf.submission_id = s.id
         WHERE sf.id = ANY($1::int[]) AND s.conference_id = $2`,
        [fileIds, conferenceId]
      );

      let deletedCount = 0;
      for (const f of filesRes.rows) {
        if (f.s3_key) {
          try {
            await deleteFromR2(f.s3_key);
          } catch (r2Err) {
            request.log.warn(`Failed to delete R2 object (${f.s3_key}): ${r2Err.message}`);
          }
        }
        await db.query('DELETE FROM submission_files WHERE id = $1', [f.id]);
        deletedCount++;
      }

      await logAudit({
        conferenceId,
        userId: request.currentUser.id,
        action: 'BULK_FILES_DELETED',
        entityType: 'submission_file',
        entityId: null,
        details: { deletedCount, fileIds },
      });

      return { message: `Successfully deleted ${deletedCount} files`, deletedCount };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to bulk delete files', details: err.message });
    }
  });
}

module.exports = submissionRoutes;
