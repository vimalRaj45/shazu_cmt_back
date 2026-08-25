const db = require('../config/db');
const { authenticate, requireRoles } = require('../middlewares/auth');
const { sendReviewerInvitation } = require('../services/emailService');
const { logAudit } = require('../services/auditService');
const { calculateReviewerMatchScore, generateAiAutoAssignmentPlan } = require('../services/aiAssignService');

async function reviewerRoutes(fastify, options) {
  // Get conference reviewer pool (with status and load count)
  fastify.get('/conference/:conferenceId', { preHandler: [authenticate, requireRoles('admin', 'chair')] }, async (request, reply) => {
    const { conferenceId } = request.params;
    try {
      const res = await db.query(
        `SELECT u.id, u.email, u.first_name, u.last_name, u.institution, u.department, u.country,
                u.qualification, u.designation, u.domain, u.areas_of_interest, u.expertise_keywords,
                COALESCE(u.max_review_limit, 3) as max_review_limit, u.orcid_id, u.bio,
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

  // Check conflicts and compute AI match scores for a submission against all conference reviewers
  fastify.get('/conflicts/submission/:submissionId', { preHandler: [authenticate, requireRoles('admin', 'chair')] }, async (request, reply) => {
    const { submissionId } = request.params;
    try {
      const subRes = await db.query(
        `SELECT s.id, s.title, s.abstract, s.keywords, s.conference_id, s.corresponding_author_id,
                u.institution as author_institution, u.email as author_email,
                t.name as track_name
         FROM submissions s
         JOIN users u ON s.corresponding_author_id = u.id
         LEFT JOIN tracks t ON s.track_id = t.id
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
        `SELECT u.id, u.email, u.first_name, u.last_name, u.institution, u.department, u.country,
                u.qualification, u.designation, u.domain, u.areas_of_interest, u.expertise_keywords,
                COALESCE(u.max_review_limit, 3) as max_review_limit,
                (SELECT COUNT(*) FROM reviewer_assignments ra 
                 JOIN submissions s ON ra.submission_id = s.id 
                 WHERE ra.reviewer_id = u.id AND s.conference_id = $1) as assigned_papers_count
         FROM conference_reviewers cr
         JOIN users u ON cr.reviewer_id = u.id
         WHERE cr.conference_id = $1 AND cr.status = 'accepted'`,
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

      // Compute conflict status and AI match score for each reviewer
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

        // Calculate AI match rating
        const matchData = calculateReviewerMatchScore(sub, rev);

        return {
          ...rev,
          hasConflict,
          conflictReason,
          ...matchData,
        };
      });

      // Sort by match score descending (conflict-free ones first)
      analyzedReviewers.sort((a, b) => {
        if (a.hasConflict !== b.hasConflict) return a.hasConflict ? 1 : -1;
        return b.matchScore - a.matchScore;
      });

      return { reviewersWithConflictStatus: analyzedReviewers };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to analyze reviewer conflicts', details: err.message });
    }
  });

  // ✨ AI Auto-Assignment Simulation & Preview
  fastify.post('/conference/:conferenceId/ai-assign/preview', { preHandler: [authenticate, requireRoles('admin', 'chair')] }, async (request, reply) => {
    const { conferenceId } = request.params;
    const { targetReviewsPerPaper = 1, maxReviewsPerReviewer = 3, onlyUnassigned = true } = request.body || {};

    try {
      const plan = await generateAiAutoAssignmentPlan(conferenceId, {
        targetReviewsPerPaper: parseInt(targetReviewsPerPaper, 10) || 1,
        maxReviewsPerReviewer: parseInt(maxReviewsPerReviewer, 10) || 3,
        onlyUnassigned: Boolean(onlyUnassigned),
      });

      return plan;
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to generate AI auto-assignment plan', details: err.message });
    }
  });

  // ✨ AI Auto-Assignment Apply & Commit
  fastify.post('/conference/:conferenceId/ai-assign/apply', { preHandler: [authenticate, requireRoles('admin', 'chair')] }, async (request, reply) => {
    const { conferenceId } = request.params;
    const { assignments = [] } = request.body || {};

    if (!Array.isArray(assignments) || assignments.length === 0) {
      return reply.code(400).send({ error: 'No assignments provided to apply' });
    }

    try {
      // Fetch conference details for emails
      const confRes = await db.query('SELECT id, name, short_name, review_deadline FROM conferences WHERE id = $1', [conferenceId]);
      const conf = confRes.rows[0] || { id: conferenceId };

      let appliedCount = 0;
      const assignedPaperIds = new Set();

      for (const item of assignments) {
        const { submissionId, reviewerId } = item;
        if (!submissionId || !reviewerId) continue;

        // Insert assignment
        const assignRes = await db.query(
          `INSERT INTO reviewer_assignments (submission_id, reviewer_id, assigned_by, invitation_status)
           VALUES ($1, $2, $3, 'accepted')
           ON CONFLICT (submission_id, reviewer_id) DO NOTHING
           RETURNING *;`,
          [submissionId, reviewerId, request.currentUser.id]
        );

        if (assignRes.rows.length > 0) {
          appliedCount++;
          assignedPaperIds.add(submissionId);

          // Asynchronously notify reviewer
          db.query('SELECT * FROM users WHERE id = $1', [reviewerId]).then((uRes) => {
            if (uRes.rows.length > 0) {
              const reviewer = uRes.rows[0];
              db.query('SELECT id, submission_number, title FROM submissions WHERE id = $1', [submissionId]).then((sRes) => {
                if (sRes.rows.length > 0) {
                  sendReviewerInvitation({
                    reviewer,
                    conference: conf,
                    submission: sRes.rows[0],
                  }).catch((e) => console.error('Failed to notify reviewer:', e.message));
                }
              });
            }
          });
        }
      }

      // Update paper statuses to under_review
      if (assignedPaperIds.size > 0) {
        await db.query(
          `UPDATE submissions SET status = 'under_review', updated_at = CURRENT_TIMESTAMP 
           WHERE id = ANY($1::int[]) AND status = 'submitted'`,
          [Array.from(assignedPaperIds)]
        );
      }

      await logAudit({
        conferenceId,
        userId: request.currentUser.id,
        action: 'AI_AUTO_ASSIGNMENT_EXECUTED',
        entityType: 'reviewer_assignments',
        entityId: conferenceId,
        details: { totalApplied: appliedCount, papersCount: assignedPaperIds.size },
      });

      return {
        success: true,
        appliedCount,
        papersUpdated: assignedPaperIds.size,
        message: `Successfully executed ${appliedCount} AI paper-reviewer assignment(s).`,
      };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to execute AI auto-assignments', details: err.message });
    }
  });

  // Assign Reviewer to paper (Manual)
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

      // Fetch co-author institutions and emails
      const coAuthorsRes = await db.query('SELECT email, institution FROM submission_authors WHERE submission_id = $1', [submissionId]);
      const authorInstitutions = new Set([sub.author_institution, ...coAuthorsRes.rows.map((a) => a.institution)].filter(Boolean).map((i) => i.toLowerCase().trim()));
      const authorEmails = new Set([sub.author_email, ...coAuthorsRes.rows.map((a) => a.email)].filter(Boolean).map((e) => e.toLowerCase().trim()));

      // Check manually declared conflicts
      const conflictRes = await db.query('SELECT id, conflict_type, notes FROM conflicts WHERE submission_id = $1 AND reviewer_id = $2', [submissionId, reviewerId]);

      // Comprehensive COI validation
      if (sub.corresponding_author_id === reviewerId || (reviewer.email && authorEmails.has(reviewer.email.toLowerCase().trim()))) {
        return reply.code(400).send({ error: 'Conflict of Interest (COI): Cannot assign reviewer who is the primary author or co-author of this paper.' });
      }
      if (reviewer.institution && authorInstitutions.has(reviewer.institution.toLowerCase().trim())) {
        return reply.code(400).send({ error: `Conflict of Interest (COI): Institutional conflict detected with "${reviewer.institution}". Reviewers cannot evaluate papers from their own institution.` });
      }
      if (conflictRes.rows.length > 0) {
        return reply.code(400).send({ error: `Conflict of Interest (COI): Declared conflict on record (${conflictRes.rows[0].conflict_type}: ${conflictRes.rows[0].notes || 'Conflict active'}).` });
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
