const db = require('../config/db');
const { authenticate, requireRoles } = require('../middlewares/auth');

async function reportRoutes(fastify, options) {
  // Conference analytics and export data (Chair/Admin)
  fastify.get('/conference/:conferenceId/summary', { preHandler: [authenticate, requireRoles('admin', 'chair')] }, async (request, reply) => {
    const { conferenceId } = request.params;
    try {
      // Submissions by track
      const trackSubmissions = await db.query(
        `SELECT t.id as track_id, t.name as track_name, COUNT(s.id) as submission_count
         FROM tracks t
         LEFT JOIN submissions s ON t.id = s.track_id
         WHERE t.conference_id = $1
         GROUP BY t.id, t.name
         ORDER BY submission_count DESC`,
        [conferenceId]
      );

      // Submissions by status
      const statusDistribution = await db.query(
        `SELECT status, COUNT(*) as count
         FROM submissions
         WHERE conference_id = $1
         GROUP BY status`,
        [conferenceId]
      );

      // Review progress by reviewer
      const reviewerProgress = await db.query(
        `SELECT u.id, u.first_name, u.last_name, u.email, u.institution,
                COUNT(ra.id) as assigned_count,
                COUNT(r.id) FILTER (WHERE r.is_draft = false) as completed_count
         FROM conference_reviewers cr
         JOIN users u ON cr.reviewer_id = u.id
         LEFT JOIN reviewer_assignments ra ON ra.reviewer_id = u.id AND ra.submission_id IN (SELECT id FROM submissions WHERE conference_id = $1)
         LEFT JOIN reviews r ON r.submission_id = ra.submission_id AND r.reviewer_id = u.id
         WHERE cr.conference_id = $1
         GROUP BY u.id, u.first_name, u.last_name, u.email, u.institution
         ORDER BY assigned_count DESC`,
        [conferenceId]
      );

      // Complete flat exportable paper report
      const papersExport = await db.query(
        `SELECT s.submission_number, s.title, t.name as track_name, s.status,
                u.first_name || ' ' || u.last_name as primary_author, u.email as author_email, u.institution as author_institution,
                pd.decision,
                (SELECT ROUND(AVG(r.overall_score), 2) FROM reviews r WHERE r.submission_id = s.id AND r.is_draft = false) as avg_score,
                (SELECT COUNT(*) FROM reviews r WHERE r.submission_id = s.id AND r.is_draft = false) as review_count
         FROM submissions s
         LEFT JOIN tracks t ON s.track_id = t.id
         LEFT JOIN users u ON s.corresponding_author_id = u.id
         LEFT JOIN paper_decisions pd ON s.id = pd.submission_id
         WHERE s.conference_id = $1
         ORDER BY s.submission_number ASC`,
        [conferenceId]
      );

      return {
        trackSubmissions: trackSubmissions.rows,
        statusDistribution: statusDistribution.rows,
        reviewerProgress: reviewerProgress.rows,
        papersExport: papersExport.rows,
      };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to generate report', details: err.message });
    }
  });
}

module.exports = reportRoutes;
