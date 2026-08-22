const db = require('../config/db');
const { authenticate, requireRoles } = require('../middlewares/auth');
const { sendReviewerInvitation } = require('../services/emailService');
const { logAudit } = require('../services/auditService');

async function reviewerRoutes(fastify, options) {
  // Get conference reviewer pool (with status and load count)
  fastify.get('/conference/:conferenceId', { preHandler: [authenticate, requireRoles('admin', 'chair')] }, async (request, reply) => {
    const { conferenceId } = request.params;
    try {
      const res = await db.query(
        `SELECT u.id, u.email, u.first_name, u.last_name, u.institution, u.department, u.country, u.expertise_keywords,
                cr.status as invitation_status, cr.invited_at, cr.responded_at,
                (SELECT COUNT(*) FROM reviewer_assignments ra 
                 JOIN submissions s ON ra.submission_id = s.id 
                 WHERE ra.reviewer_id = u.id AND s.conference_id = $1) as assigned_papers_count,
                (SELECT COUNT(*) FROM reviews r 
                 JOIN submissions s ON r.submission_id = s.id 
                 WHERE r.reviewer_id = u.id AND s.conference_id = $1 AND r.is_draft = false) as completed_reviews_count
         FROM conference_reviewers cr
         JOIN users u ON cr.reviewer_id = u.id
         WHERE cr.conference_id = $1
         ORDER BY u.first_name ASC`,
        [conferenceId]
      );
      return { reviewers: res.rows };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to fetch conference reviewers', details: err.message });
    }
  });

  // Invite Reviewer to conference
  fastify.post('/conference/:conferenceId/invite', { preHandler: [authenticate, requireRoles('admin', 'chair')] }, async (request, reply) => {
    const { conferenceId } = request.params;
    const { reviewerId, email } = request.body || {};

    try {
      let targetUserId = reviewerId;

      if (!targetUserId && email) {
        // Find or check user by email
        const uRes = await db.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase().trim()]);
        if (uRes.rows.length > 0) {
          targetUserId = uRes.rows[0].id;
        } else {
          return reply.code(404).send({ error: 'No user found with this email. Please ensure the user has an account.' });
        }
      }

      const res = await db.query(
        `INSERT INTO conference_reviewers (conference_id, reviewer_id, status)
         VALUES ($1, $2, 'accepted')
         ON CONFLICT (conference_id, reviewer_id) DO UPDATE SET status = 'accepted'
         RETURNING *;`,
        [conferenceId, targetUserId]
      );

      return { invitation: res.rows[0], message: 'Reviewer added to conference program committee' };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to invite reviewer', details: err.message });
    }
  });

  // Check conflicts for a submission against all conference reviewers
  fastify.get('/conflicts/submission/:submissionId', { preHandler: [authenticate, requireRoles('admin', 'chair')] }, async (request, reply) => {
    const { submissionId } = request.params;
    try {
      const subRes = await db.query(
        `SELECT s.id, s.conference_id, s.corresponding_author_id, u.institution as author_institution, u.email as author_email
         FROM submissions s
         JOIN users u ON s.corresponding_author_id = u.id
         WHERE s.id = $1`,
        [submissionId]
      );

      if (subRes.rows.length === 0) {
        return reply.code(404).send({ error: 'Submission not found' });
      }
      const sub = subRes.rows[0];

      // Fetch co-author institutions and emails
      const coAuthorsRes = await db.query('SELECT email, institution FROM submission_authors WHERE submission_id = $1', [submissionId]);
      const authorInstitutions = new Set([sub.author_institution, ...coAuthorsRes.rows.map((a) => a.institution)].filter(Boolean).map((i) => i.toLowerCase().trim()));
      const authorEmails = new Set([sub.author_email, ...coAuthorsRes.rows.map((a) => a.email)].filter(Boolean).map((e) => e.toLowerCase().trim()));

      // Fetch all reviewers for this conference
      const revRes = await db.query(
        `SELECT u.id, u.email, u.first_name, u.last_name, u.institution, u.expertise_keywords
         FROM conference_reviewers cr
         JOIN users u ON cr.reviewer_id = u.id
         WHERE cr.conference_id = $1`,
        [sub.conference_id]
      );

      // Fetch explicitly recorded conflicts
      const manualConflictsRes = await db.query(
        'SELECT reviewer_id, conflict_type, notes FROM conflicts WHERE submission_id = $1',
        [submissionId]
      );
      const manualConflictsMap = {};
      manualConflictsRes.rows.forEach((c) => {
        manualConflictsMap[c.reviewer_id] = c;
      });

      // Compute conflict status for each reviewer
      const analyzedReviewers = revRes.rows.map((rev) => {
        let hasConflict = false;
        let conflictReason = '';

        if (authorEmails.has(rev.email.toLowerCase().trim()) || rev.id === sub.corresponding_author_id) {
          hasConflict = true;
          conflictReason = 'Author/Co-author on paper';
        } else if (rev.institution && authorInstitutions.has(rev.institution.toLowerCase().trim())) {
          hasConflict = true;
          conflictReason = `Same Institution (${rev.institution})`;
        } else if (manualConflictsMap[rev.id]) {
          hasConflict = true;
          conflictReason = manualConflictsMap[rev.id].notes || `Declared conflict (${manualConflictsMap[rev.id].conflict_type})`;
        }

        return {
          ...rev,
          hasConflict,
          conflictReason,
        };
      });

      return { reviewersWithConflictStatus: analyzedReviewers };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to analyze reviewer conflicts', details: err.message });
    }
  });

  // Assign Reviewer to paper
  fastify.post('/assign', { preHandler: [authenticate, requireRoles('admin', 'chair')] }, async (request, reply) => {
    const { submissionId, reviewerId } = request.body || {};

    if (!submissionId || !reviewerId) {
      return reply.code(400).send({ error: 'submissionId and reviewerId are required' });
    }

    try {
      // Check conflict before assignment
      const subRes = await db.query(
        `SELECT s.id, s.submission_number, s.title, s.conference_id, s.corresponding_author_id,
                u.institution as author_institution, u.email as author_email,
                c.name as conference_name, c.short_name as conference_short_name, c.review_deadline
         FROM submissions s
         JOIN users u ON s.corresponding_author_id = u.id
         JOIN conferences c ON s.conference_id = c.id
         WHERE s.id = $1`,
        [submissionId]
      );

      if (subRes.rows.length === 0) {
        return reply.code(404).send({ error: 'Submission not found' });
      }
      const sub = subRes.rows[0];

      // Reviewer details
      const revRes = await db.query('SELECT * FROM users WHERE id = $1', [reviewerId]);
      if (revRes.rows.length === 0) {
        return reply.code(404).send({ error: 'Reviewer not found' });
      }
      const reviewer = revRes.rows[0];

      // Block if author or same institution
      if (sub.corresponding_author_id === reviewerId || (sub.author_institution && reviewer.institution && sub.author_institution.toLowerCase().trim() === reviewer.institution.toLowerCase().trim())) {
        return reply.code(400).send({ error: 'Cannot assign reviewer: Institutional or authorship conflict detected.' });
      }

      // Insert assignment
      const assignRes = await db.query(
        `INSERT INTO reviewer_assignments (submission_id, reviewer_id, assigned_by, invitation_status)
         VALUES ($1, $2, $3, 'accepted')
         ON CONFLICT (submission_id, reviewer_id) DO NOTHING
         RETURNING *;`,
        [submissionId, reviewerId, request.currentUser.id]
      );

      // Update paper status to under_review if submitted
      await db.query(`UPDATE submissions SET status = 'under_review', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'submitted'`, [submissionId]);

      // Trigger Brevo email to reviewer
      sendReviewerInvitation({
        reviewer,
        conference: { id: sub.conference_id, name: sub.conference_name, short_name: sub.conference_short_name, review_deadline: sub.review_deadline },
        submission: sub,
      }).catch((e) => console.error('Failed to notify reviewer by email:', e.message));

      await logAudit({
        conferenceId: sub.conference_id,
        userId: request.currentUser.id,
        action: 'REVIEWER_ASSIGNED',
        entityType: 'reviewer_assignment',
        entityId: submissionId,
        details: { submissionId, reviewerId, reviewerName: `${reviewer.first_name} ${reviewer.last_name}` },
      });

      return { assignment: assignRes.rows[0], message: 'Reviewer successfully assigned and notified.' };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to assign reviewer', details: err.message });
    }
  });

  // Remove reviewer assignment
  fastify.delete('/assign', { preHandler: [authenticate, requireRoles('admin', 'chair')] }, async (request, reply) => {
    const { submissionId, reviewerId } = request.body || {};

    try {
      await db.query('DELETE FROM reviewer_assignments WHERE submission_id = $1 AND reviewer_id = $2', [submissionId, reviewerId]);
      return { success: true, message: 'Reviewer assignment removed' };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to remove assignment', details: err.message });
    }
  });
}

module.exports = reviewerRoutes;
