const db = require('../config/db');
const { authenticate, requireRoles } = require('../middlewares/auth');
const { logAudit } = require('../services/auditService');

async function announcementRoutes(fastify, options) {
  // Get announcements for a conference (filtered by role)
  fastify.get('/conference/:conferenceId', async (request, reply) => {
    const { conferenceId } = request.params;
    let userRole = 'participant';

    try {
      if (request.headers.authorization) {
        await request.jwtVerify();
        const userRes = await db.query('SELECT role FROM users WHERE id = $1', [request.user.id]);
        if (userRes.rows.length > 0) {
          userRole = userRes.rows[0].role;
        }
      }
    } catch (e) {
      // Unauthenticated, treat as participant/public
    }

    try {
      let queryText = `
        SELECT a.*, u.first_name as author_first_name, u.last_name as author_last_name
        FROM announcements a
        LEFT JOIN users u ON a.created_by = u.id
        WHERE a.conference_id = $1
      `;
      const params = [conferenceId];

      if (userRole !== 'admin' && userRole !== 'chair') {
        if (userRole === 'reviewer') {
          queryText += ` AND (a.target_role IN ('all', 'reviewers'))`;
        } else if (userRole === 'author') {
          queryText += ` AND (a.target_role IN ('all', 'authors'))`;
        } else {
          queryText += ` AND (a.target_role IN ('all', 'participants'))`;
        }
      }

      queryText += ' ORDER BY a.created_at DESC';
      const res = await db.query(queryText, params);
      return { announcements: res.rows };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to fetch announcements', details: err.message });
    }
  });

  // Chair/Admin: Post announcement
  fastify.post('/', { preHandler: [authenticate, requireRoles('admin', 'chair')] }, async (request, reply) => {
    const { conferenceId, title, content, targetRole = 'all' } = request.body || {};

    if (!conferenceId || !title || !content) {
      return reply.code(400).send({ error: 'Conference ID, Title, and Content are required.' });
    }

    try {
      const res = await db.query(
        `INSERT INTO announcements (conference_id, title, content, target_role, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *;`,
        [conferenceId, title.trim(), content.trim(), targetRole, request.currentUser.id]
      );

      await logAudit({
        conferenceId,
        userId: request.currentUser.id,
        action: 'ANNOUNCEMENT_CREATED',
        entityType: 'announcement',
        entityId: res.rows[0].id,
        details: { title, targetRole },
      });

      return { announcement: res.rows[0] };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to create announcement', details: err.message });
    }
  });

  // Delete announcement
  fastify.delete('/:id', { preHandler: [authenticate, requireRoles('admin', 'chair')] }, async (request, reply) => {
    const { id } = request.params;
    try {
      await db.query('DELETE FROM announcements WHERE id = $1', [id]);
      return { success: true, message: 'Announcement deleted' };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to delete announcement', details: err.message });
    }
  });
}

module.exports = announcementRoutes;
