const db = require('../config/db');
const { authenticate, requireRoles } = require('../middlewares/auth');

async function auditLogRoutes(fastify, options) {
  // Get recent system activity / audit log entries (Admin/Chair)
  fastify.get('/', { preHandler: [authenticate, requireRoles('admin', 'chair')] }, async (request, reply) => {
    const { conferenceId, limit = 100 } = request.query || {};
    try {
      let queryText = `
        SELECT a.*, u.first_name, u.last_name, u.email, u.role as user_role,
               c.short_name as conference_short_name
        FROM audit_logs a
        LEFT JOIN users u ON a.user_id = u.id
        LEFT JOIN conferences c ON a.conference_id = c.id
      `;
      const params = [];

      if (conferenceId) {
        params.push(conferenceId);
        queryText += ` WHERE a.conference_id = $${params.length}`;
      }

      queryText += ' ORDER BY a.created_at DESC LIMIT ' + (parseInt(limit, 10) || 100);

      const res = await db.query(queryText, params);
      return { logs: res.rows };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to fetch audit logs', details: err.message });
    }
  });
}

module.exports = auditLogRoutes;
