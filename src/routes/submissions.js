const db = require('../config/db');
const { authenticate, requireRoles } = require('../middlewares/auth');
const { uploadToR2, getDownloadPresignedUrl } = require('../config/r2');
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

      // Send automated Brevo email confirmation
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
      const subRes = await db.query('SELECT * FROM submissions WHERE id = $1', [id]);
      if (subRes.rows.length === 0) {
        return reply.code(404).send({ error: 'Submission not found' });
      }
      const submission = subRes.rows[0];

      const fileType = (data.fields.fileType && data.fields.fileType.value) || 'manuscript';
      const buffer = await data.toBuffer();
      const filename = data.filename;
      const mimeType = data.mimetype;
      const fileSize = buffer.length;

      // Unique storage key
      const timestamp = Date.now();
      const sanitizedName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const s3Key = `conferences/${submission.conference_id}/submissions/${submission.submission_number}/${fileType}_${timestamp}_${sanitizedName}`;

      // Upload to Cloudflare R2
      const r2Result = await uploadToR2(s3Key, buffer, mimeType);

      // Get current version count for this file type
      const verRes = await db.query(
        'SELECT COUNT(*) FROM submission_files WHERE submission_id = $1 AND file_type = $2',
        [id, fileType]
      );
      const nextVersion = parseInt(verRes.rows[0].count, 10) + 1;

      // Record in DB
      const fileRecordRes = await db.query(
        `INSERT INTO submission_files (submission_id, file_type, file_name, file_size, mime_type, s3_key, public_url, version, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *;`,
        [id, fileType, filename, fileSize, mimeType, s3Key, r2Result.publicUrl, nextVersion, request.currentUser.id]
      );

      // Update submission status if uploading revision or camera-ready
      if (fileType === 'revision') {
        const rebuttalNotes = (data.fields.rebuttalNotes && data.fields.rebuttalNotes.value) || '';
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
        details: { submissionId: id, fileType, filename, size: fileSize },
      });

      return { file: fileRecordRes.rows[0] };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: 'File upload failed', details: err.message });
    }
  });

  // Get download presigned URL for a file
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

  // Update submission metadata (Title, Abstract, Keywords, Track)
  fastify.put('/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params;
    const { title, abstract, keywords, trackId, status } = request.body || {};

    try {
      const res = await db.query(
        `UPDATE submissions SET
            title = COALESCE($1, title),
            abstract = COALESCE($2, abstract),
            keywords = COALESCE($3, keywords),
            track_id = COALESCE($4, track_id),
            status = COALESCE($5, status),
            updated_at = CURRENT_TIMESTAMP
         WHERE id = $6
         RETURNING *;`,
        [title, abstract, keywords, trackId, status, id]
      );

      if (res.rows.length === 0) {
        return reply.code(404).send({ error: 'Submission not found' });
      }

      return { submission: res.rows[0] };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to update submission', details: err.message });
    }
  });
}

module.exports = submissionRoutes;
