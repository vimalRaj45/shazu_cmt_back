const db = require('../config/db');
const { authenticate } = require('../middlewares/auth');

async function dashboardRoutes(fastify, options) {
  // Get overview metrics based on user role and selected conference
  fastify.get('/overview', { preHandler: [authenticate] }, async (request, reply) => {
    const { conferenceId } = request.query || {};
    const userId = request.currentUser.id;
    const userRole = request.currentUser.role;

    try {
      const stats = {};

      if (userRole === 'admin' || userRole === 'chair') {
        // Chair/Admin Global or Conference Stats
        let confFilter = '';
        const params = [];
        if (conferenceId) {
          params.push(conferenceId);
          confFilter = ` WHERE conference_id = $${params.length}`;
        }

        const totalSubs = await db.query(`SELECT COUNT(*) FROM submissions ${confFilter}`, params);
        const underReview = await db.query(`SELECT COUNT(*) FROM submissions WHERE status = 'under_review' ${conferenceId ? 'AND conference_id = $1' : ''}`, params);
        const accepted = await db.query(`SELECT COUNT(*) FROM submissions WHERE status IN ('accepted', 'camera_ready_pending', 'camera_ready_approved') ${conferenceId ? 'AND conference_id = $1' : ''}`, params);
        const rejected = await db.query(`SELECT COUNT(*) FROM submissions WHERE status = 'rejected' ${conferenceId ? 'AND conference_id = $1' : ''}`, params);
        const revision = await db.query(`SELECT COUNT(*) FROM submissions WHERE status = 'revision_required' ${conferenceId ? 'AND conference_id = $1' : ''}`, params);
        const cameraPending = await db.query(`SELECT COUNT(*) FROM submissions WHERE status = 'camera_ready_pending' ${conferenceId ? 'AND conference_id = $1' : ''}`, params);

        const totalReviews = await db.query(`
          SELECT COUNT(*) as total_assigned,
                 COUNT(*) FILTER (WHERE r.is_draft = false) as completed,
                 COUNT(*) FILTER (WHERE r.id IS NULL OR r.is_draft = true) as pending
          FROM reviewer_assignments ra
          JOIN submissions s ON ra.submission_id = s.id
          LEFT JOIN reviews r ON r.submission_id = s.id AND r.reviewer_id = ra.reviewer_id
          ${conferenceId ? 'WHERE s.conference_id = $1' : ''}
        `, params);

        stats.admin = {
          totalSubmissions: parseInt(totalSubs.rows[0].count, 10),
          underReview: parseInt(underReview.rows[0].count, 10),
          accepted: parseInt(accepted.rows[0].count, 10),
          rejected: parseInt(rejected.rows[0].count, 10),
          revisionRequired: parseInt(revision.rows[0].count, 10),
          cameraReadyPending: parseInt(cameraPending.rows[0].count, 10),
          totalAssignedReviews: parseInt(totalReviews.rows[0].total_assigned, 10),
          completedReviews: parseInt(totalReviews.rows[0].completed, 10),
          pendingReviews: parseInt(totalReviews.rows[0].pending, 10),
        };
        stats.chair = stats.admin; // Backwards compatibility
      }

      if (userRole === 'reviewer' || userRole === 'chair' || userRole === 'admin') {
        const revStats = await db.query(`
          SELECT COUNT(*) as total_assigned,
                 COUNT(*) FILTER (WHERE r.is_draft = false) as completed,
                 COUNT(*) FILTER (WHERE r.id IS NULL OR r.is_draft = true) as pending
          FROM reviewer_assignments ra
          JOIN submissions s ON ra.submission_id = s.id
          LEFT JOIN reviews r ON r.submission_id = s.id AND r.reviewer_id = ra.reviewer_id
          WHERE ra.reviewer_id = $1
        `, [userId]);

        stats.reviewer = {
          assignedPapers: parseInt(revStats.rows[0].total_assigned, 10),
          completedReviews: parseInt(revStats.rows[0].completed, 10),
          pendingReviews: parseInt(revStats.rows[0].pending, 10),
        };
      }

      if (userRole === 'author' || userRole === 'chair' || userRole === 'admin') {
        const authorStats = await db.query(`
          SELECT COUNT(*) as total,
                 COUNT(*) FILTER (WHERE status = 'submitted') as submitted,
                 COUNT(*) FILTER (WHERE status = 'under_review') as under_review,
                 COUNT(*) FILTER (WHERE status IN ('accepted', 'camera_ready_pending', 'camera_ready_approved')) as accepted,
                 COUNT(*) FILTER (WHERE status = 'rejected') as rejected,
                 COUNT(*) FILTER (WHERE status = 'revision_required') as revision_required
          FROM submissions
          WHERE corresponding_author_id = $1
        `, [userId]);

        stats.author = {
          totalSubmissions: parseInt(authorStats.rows[0].total, 10),
          submitted: parseInt(authorStats.rows[0].submitted, 10),
          underReview: parseInt(authorStats.rows[0].under_review, 10),
          accepted: parseInt(authorStats.rows[0].accepted, 10),
          rejected: parseInt(authorStats.rows[0].rejected, 10),
          revisionRequired: parseInt(authorStats.rows[0].revision_required, 10),
        };
      }

      // Recent announcements
      const annRes = await db.query('SELECT * FROM announcements ORDER BY created_at DESC LIMIT 5');
      stats.recentAnnouncements = annRes.rows;

      // Active Conferences
      const confRes = await db.query("SELECT id, name, short_name, start_date, end_date, submission_deadline, status FROM conferences WHERE status != 'completed' ORDER BY start_date ASC LIMIT 5");
      stats.activeConferences = confRes.rows;

      return { stats };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to fetch dashboard metrics', details: err.message });
    }
  });
}

module.exports = dashboardRoutes;
