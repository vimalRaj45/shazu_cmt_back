const db = require('../config/db');
const { authenticate } = require('../middlewares/auth');
const { logAudit } = require('../services/auditService');

async function reviewRoutes(fastify, options) {
  // Reviewer: List my assigned papers
  fastify.get('/my-assignments', { preHandler: [authenticate] }, async (request, reply) => {
    const reviewerId = request.currentUser.id;

    try {
      const res = await db.query(
        `SELECT ra.id as assignment_id, ra.invitation_status, ra.assigned_at,
                s.id as submission_id, s.submission_number, s.title, s.abstract, s.keywords, s.status as submission_status,
                t.name as track_name,
                c.id as conference_id, c.name as conference_name, c.short_name as conference_short_name, c.review_deadline,
                r.id as review_id, r.overall_score, r.recommendation, r.is_draft, r.submitted_at,
                r.q_relevance, r.q_structure, r.q_language, r.q_figures_tables, r.q_discussion_conclusions,
                r.q_references_cited, r.q_comments_authors, r.q_special_comments_editor, r.q_reviewer_decision,
                (SELECT json_agg(sf.*) FROM submission_files sf WHERE sf.submission_id = s.id) as files
         FROM reviewer_assignments ra
         JOIN submissions s ON ra.submission_id = s.id
         JOIN conferences c ON s.conference_id = c.id
         LEFT JOIN tracks t ON s.track_id = t.id
         LEFT JOIN reviews r ON r.submission_id = s.id AND r.reviewer_id = $1
         WHERE ra.reviewer_id = $1
         ORDER BY s.id DESC`,
        [reviewerId]
      );
      return { assignments: res.rows };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to fetch reviewer assignments', details: err.message });
    }
  });

  // Get review details for a specific submission
  fastify.get('/submission/:submissionId', { preHandler: [authenticate] }, async (request, reply) => {
    const { submissionId } = request.params;
    const userId = request.currentUser.id;
    const userRole = request.currentUser.role;

    try {
      if (userRole === 'admin' || userRole === 'chair') {
        // Chair/Admin sees all reviews with full 9 questions + reviewer identities
        const reviewsRes = await db.query(
          `SELECT r.*, u.first_name as reviewer_first_name, u.last_name as reviewer_last_name, u.institution as reviewer_institution, u.email as reviewer_email
           FROM reviews r
           JOIN users u ON r.reviewer_id = u.id
           WHERE r.submission_id = $1
           ORDER BY r.submitted_at ASC`,
          [submissionId]
        );
        return { reviews: reviewsRes.rows };
      } else if (userRole === 'reviewer') {
        // Reviewer sees ONLY their own review
        const reviewRes = await db.query(
          `SELECT * FROM reviews WHERE submission_id = $1 AND reviewer_id = $2`,
          [submissionId, userId]
        );
        return { review: reviewRes.rows[0] || null };
      } else {
        // Authors: Double-blind view of finalized reviews (Q1-Q7, Q9). Q8 (Special Comments to Editor) is hidden!
        const decCheck = await db.query(
          `SELECT pd.decision, s.corresponding_author_id 
           FROM submissions s
           LEFT JOIN paper_decisions pd ON s.id = pd.submission_id
           WHERE s.id = $1`,
          [submissionId]
        );
        if (decCheck.rows.length === 0 || decCheck.rows[0].corresponding_author_id !== userId) {
          return reply.code(403).send({ error: 'Unauthorized' });
        }

        const authorReviewsRes = await db.query(
          `SELECT id, technical_quality, originality, relevance, presentation_quality, overall_score, recommendation,
                  comments_for_authors, submitted_at,
                  q_relevance, q_structure, q_language, q_figures_tables, q_discussion_conclusions,
                  q_references_cited, q_comments_authors, q_reviewer_decision
           FROM reviews
           WHERE submission_id = $1 AND is_draft = false
           ORDER BY submitted_at ASC`,
          [submissionId]
        );
        return { reviews: authorReviewsRes.rows };
      }
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to fetch review', details: err.message });
    }
  });

  // Submit or Save Draft Review (Microsoft CMT 9-Question Standard)
  fastify.post('/submission/:submissionId', { preHandler: [authenticate] }, async (request, reply) => {
    const { submissionId } = request.params;
    const reviewerId = request.currentUser.id;
    const {
      // 9 Questions
      qRelevance = 'Relevant',
      qStructure = 'Good',
      qLanguage = 'Good',
      qFiguresTables = 'Well Defined',
      qDiscussionConclusions = 'Good',
      qReferencesCited = 'Yes',
      qCommentsAuthors = '',
      qSpecialCommentsEditor = '',
      qReviewerDecision = 'Accepted with Minor Revision',
      // Legacy / score fields
      technicalQuality,
      originality,
      relevance,
      presentationQuality,
      overallScore,
      recommendation,
      commentsForAuthors,
      confidentialChairNotes,
      isDraft = false,
    } = request.body || {};

    try {
      // Verify reviewer assignment
      const assignCheck = await db.query(
        'SELECT id FROM reviewer_assignments WHERE submission_id = $1 AND reviewer_id = $2',
        [submissionId, reviewerId]
      );
      if (assignCheck.rows.length === 0 && request.currentUser.role !== 'admin') {
        return reply.code(403).send({ error: 'You are not assigned to review this paper.' });
      }

      // Check if already locked
      const existingRev = await db.query('SELECT is_draft FROM reviews WHERE submission_id = $1 AND reviewer_id = $2', [submissionId, reviewerId]);
      if (existingRev.rows.length > 0 && !existingRev.rows[0].is_draft && isDraft) {
        return reply.code(400).send({ error: 'This review is already finalized and cannot be converted back to a draft.' });
      }

      const effectiveCommentsAuthors = qCommentsAuthors || commentsForAuthors || '';
      const effectiveConfidentialNotes = qSpecialCommentsEditor || confidentialChairNotes || '';
      const effectiveDecision = qReviewerDecision || recommendation || 'Accepted with Minor Revision';

      const res = await db.query(
        `INSERT INTO reviews (
            submission_id, reviewer_id, technical_quality, originality, relevance, presentation_quality,
            overall_score, recommendation, comments_for_authors, confidential_chair_notes,
            q_relevance, q_structure, q_language, q_figures_tables, q_discussion_conclusions,
            q_references_cited, q_comments_authors, q_special_comments_editor, q_reviewer_decision,
            is_draft, submitted_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, ${isDraft ? 'NULL' : 'CURRENT_TIMESTAMP'}, CURRENT_TIMESTAMP)
         ON CONFLICT (submission_id, reviewer_id) DO UPDATE SET
            technical_quality = EXCLUDED.technical_quality,
            originality = EXCLUDED.originality,
            relevance = EXCLUDED.relevance,
            presentation_quality = EXCLUDED.presentation_quality,
            overall_score = EXCLUDED.overall_score,
            recommendation = EXCLUDED.recommendation,
            comments_for_authors = EXCLUDED.comments_for_authors,
            confidential_chair_notes = EXCLUDED.confidential_chair_notes,
            q_relevance = EXCLUDED.q_relevance,
            q_structure = EXCLUDED.q_structure,
            q_language = EXCLUDED.q_language,
            q_figures_tables = EXCLUDED.q_figures_tables,
            q_discussion_conclusions = EXCLUDED.q_discussion_conclusions,
            q_references_cited = EXCLUDED.q_references_cited,
            q_comments_authors = EXCLUDED.q_comments_authors,
            q_special_comments_editor = EXCLUDED.q_special_comments_editor,
            q_reviewer_decision = EXCLUDED.q_reviewer_decision,
            is_draft = EXCLUDED.is_draft,
            submitted_at = CASE WHEN EXCLUDED.is_draft = false THEN CURRENT_TIMESTAMP ELSE reviews.submitted_at END,
            updated_at = CURRENT_TIMESTAMP
         RETURNING *;`,
        [
          submissionId,
          reviewerId,
          technicalQuality || 4,
          originality || 4,
          relevance || 4,
          presentationQuality || 4,
          overallScore || 4,
          effectiveDecision,
          effectiveCommentsAuthors,
          effectiveConfidentialNotes,
          qRelevance,
          qStructure,
          qLanguage,
          qFiguresTables,
          qDiscussionConclusions,
          qReferencesCited,
          effectiveCommentsAuthors,
          effectiveConfidentialNotes,
          effectiveDecision,
          isDraft,
        ]
      );

      const subRes = await db.query('SELECT conference_id FROM submissions WHERE id = $1', [submissionId]);

      await logAudit({
        conferenceId: subRes.rows[0] ? subRes.rows[0].conference_id : null,
        userId: reviewerId,
        action: isDraft ? 'REVIEW_DRAFT_SAVED' : 'REVIEW_SUBMITTED',
        entityType: 'review',
        entityId: res.rows[0].id,
        details: { submissionId, isDraft, decision: effectiveDecision },
      });

      return {
        review: res.rows[0],
        message: isDraft ? 'Review draft saved successfully' : 'Review submitted successfully',
      };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to submit review', details: err.message });
    }
  });
}

module.exports = reviewRoutes;
