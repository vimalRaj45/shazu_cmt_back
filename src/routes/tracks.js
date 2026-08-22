const db = require('../config/db');
const { authenticate, requireRoles } = require('../middlewares/auth');

async function trackRoutes(fastify, options) {
  // Get tracks for a conference
  fastify.get('/conference/:conferenceId', async (request, reply) => {
    const { conferenceId } = request.params;
    try {
      const res = await db.query('SELECT * FROM tracks WHERE conference_id = $1 ORDER BY name ASC', [conferenceId]);
      return { tracks: res.rows };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to fetch tracks', details: err.message });
    }
  });

  // Create track (Chair or Admin)
  fastify.post('/', { preHandler: [authenticate, requireRoles('admin', 'chair')] }, async (request, reply) => {
    const { conferenceId, name, description, isActive = true, submissionDeadline } = request.body || {};

    if (!conferenceId || !name) {
      return reply.code(400).send({ error: 'Conference ID and Track Name are required' });
    }

    try {
      const res = await db.query(
        `INSERT INTO tracks (conference_id, name, description, is_active, submission_deadline)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *;`,
        [conferenceId, name.trim(), description || '', isActive, submissionDeadline || null]
      );
      return { track: res.rows[0] };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to create track', details: err.message });
    }
  });

  // Update track
  fastify.put('/:id', { preHandler: [authenticate, requireRoles('admin', 'chair')] }, async (request, reply) => {
    const { id } = request.params;
    const { name, description, isActive, submissionDeadline } = request.body || {};

    try {
      const res = await db.query(
        `UPDATE tracks SET
            name = COALESCE($1, name),
            description = COALESCE($2, description),
            is_active = COALESCE($3, is_active),
            submission_deadline = COALESCE($4, submission_deadline)
         WHERE id = $5
         RETURNING *;`,
        [name, description, isActive, submissionDeadline, id]
      );
      if (res.rows.length === 0) {
        return reply.code(404).send({ error: 'Track not found' });
      }
      return { track: res.rows[0] };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to update track', details: err.message });
    }
  });

  // Delete track
  fastify.delete('/:id', { preHandler: [authenticate, requireRoles('admin', 'chair')] }, async (request, reply) => {
    const { id } = request.params;
    try {
      // Check if submissions exist on this track
      const subCheck = await db.query('SELECT COUNT(*) FROM submissions WHERE track_id = $1', [id]);
      if (parseInt(subCheck.rows[0].count, 10) > 0) {
        return reply.code(400).send({ error: 'Cannot delete track that already has paper submissions. Disable it instead.' });
      }

      await db.query('DELETE FROM tracks WHERE id = $1', [id]);
      return { success: true, message: 'Track deleted' };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to delete track', details: err.message });
    }
  });
}

module.exports = trackRoutes;
