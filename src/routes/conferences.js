const db = require('../config/db');
const { authenticate, requireRoles } = require('../middlewares/auth');
const { logAudit } = require('../services/auditService');

async function conferenceRoutes(fastify, options) {
  // Public/All users: List conferences
  fastify.get('/', async (request, reply) => {
    try {
      const res = await db.query(`
        SELECT c.*, 
               u.first_name as creator_first_name, u.last_name as creator_last_name,
               (SELECT COUNT(*) FROM tracks WHERE conference_id = c.id) as track_count,
               (SELECT COUNT(*) FROM submissions WHERE conference_id = c.id) as submission_count
        FROM conferences c
        LEFT JOIN users u ON c.created_by = u.id
        ORDER BY c.start_date DESC
      `);
      return { conferences: res.rows };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to fetch conferences', details: err.message });
    }
  });

  // Get conference by ID (with tracks, chairs, and stats)
  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params;
    try {
      const confRes = await db.query(
        `SELECT c.*, u.first_name as creator_first_name, u.last_name as creator_last_name
         FROM conferences c
         LEFT JOIN users u ON c.created_by = u.id
         WHERE c.id = $1`,
        [id]
      );

      if (confRes.rows.length === 0) {
        return reply.code(404).send({ error: 'Conference not found' });
      }

      const conf = confRes.rows[0];

      // Tracks
      const tracksRes = await db.query('SELECT * FROM tracks WHERE conference_id = $1 ORDER BY name ASC', [id]);
      conf.tracks = tracksRes.rows;

      // Chairs
      const chairsRes = await db.query(
        `SELECT u.id, u.first_name, u.last_name, u.email, u.institution 
         FROM conference_chairs cc
         JOIN users u ON cc.user_id = u.id
         WHERE cc.conference_id = $1`,
        [id]
      );
      conf.chairs = chairsRes.rows;

      // Reviewers count
      const revCountRes = await db.query('SELECT COUNT(*) FROM conference_reviewers WHERE conference_id = $1', [id]);
      conf.reviewer_count = parseInt(revCountRes.rows[0].count, 10);

      // Submission count
      const subCountRes = await db.query('SELECT COUNT(*) FROM submissions WHERE conference_id = $1', [id]);
      conf.submission_count = parseInt(subCountRes.rows[0].count, 10);

      return { conference: conf };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to fetch conference details', details: err.message });
    }
  });

  // Create conference (Admin or Chair)
  fastify.post('/', { preHandler: [authenticate, requireRoles('admin', 'chair')] }, async (request, reply) => {
    const {
      name,
      shortName,
      description,
      venue,
      logoUrl,
      startDate,
      endDate,
      submissionDeadline,
      reviewDeadline,
      decisionDate,
      cameraReadyDeadline,
      status = 'open',
      chairIds = [],
      tracks = [],
    } = request.body || {};

    if (!name || !shortName || !startDate || !endDate || !submissionDeadline) {
      return reply.code(400).send({ error: 'Conference Name, Short Name, Start/End Dates, and Submission Deadline are required.' });
    }

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      const confRes = await client.query(
        `INSERT INTO conferences (name, short_name, description, venue, logo_url, start_date, end_date, submission_deadline, review_deadline, decision_date, camera_ready_deadline, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING *;`,
        [
          name,
          shortName,
          description || '',
          venue || '',
          logoUrl || '',
          startDate,
          endDate,
          submissionDeadline,
          reviewDeadline || null,
          decisionDate || null,
          cameraReadyDeadline || null,
          status,
          request.currentUser.id,
        ]
      );

      const newConf = confRes.rows[0];

      // Add default chair if creator is chair/admin or explicit chairIds
      const chairsToAssign = new Set(chairIds);
      chairsToAssign.add(request.currentUser.id);

      for (const chairId of chairsToAssign) {
        await client.query(
          `INSERT INTO conference_chairs (conference_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING;`,
          [newConf.id, chairId]
        );
      }

      // Add tracks if provided
      if (Array.isArray(tracks) && tracks.length > 0) {
        for (const t of tracks) {
          const tName = typeof t === 'string' ? t : t.name;
          const tDesc = typeof t === 'object' ? t.description : '';
          if (tName && tName.trim()) {
            await client.query(
              `INSERT INTO tracks (conference_id, name, description, is_active) VALUES ($1, $2, $3, true);`,
              [newConf.id, tName.trim(), tDesc || '']
            );
          }
        }
      } else {
        // Default General track
        await client.query(
          `INSERT INTO tracks (conference_id, name, description, is_active) VALUES ($1, 'Main Track', 'General Track', true);`,
          [newConf.id]
        );
      }

      await client.query('COMMIT');

      await logAudit({
        conferenceId: newConf.id,
        userId: request.currentUser.id,
        action: 'CONFERENCE_CREATED',
        entityType: 'conference',
        entityId: newConf.id,
        details: { name: newConf.name, shortName: newConf.short_name },
      });

      return { conference: newConf };
    } catch (err) {
      await client.query('ROLLBACK');
      return reply.code(500).send({ error: 'Failed to create conference', details: err.message });
    } finally {
      client.release();
    }
  });

  // Update conference
  fastify.put('/:id', { preHandler: [authenticate, requireRoles('admin', 'chair')] }, async (request, reply) => {
    const { id } = request.params;
    const {
      name,
      shortName,
      description,
      venue,
      logoUrl,
      startDate,
      endDate,
      submissionDeadline,
      reviewDeadline,
      decisionDate,
      cameraReadyDeadline,
      status,
    } = request.body || {};

    try {
      const res = await db.query(
        `UPDATE conferences SET
            name = COALESCE($1, name),
            short_name = COALESCE($2, short_name),
            description = COALESCE($3, description),
            venue = COALESCE($4, venue),
            logo_url = COALESCE($5, logo_url),
            start_date = COALESCE($6, start_date),
            end_date = COALESCE($7, end_date),
            submission_deadline = COALESCE($8, submission_deadline),
            review_deadline = COALESCE($9, review_deadline),
            decision_date = COALESCE($10, decision_date),
            camera_ready_deadline = COALESCE($11, camera_ready_deadline),
            status = COALESCE($12, status),
            updated_at = CURRENT_TIMESTAMP
         WHERE id = $13
         RETURNING *;`,
        [
          name,
          shortName,
          description,
          venue,
          logoUrl,
          startDate,
          endDate,
          submissionDeadline,
          reviewDeadline,
          decisionDate,
          cameraReadyDeadline,
          status,
          id,
        ]
      );

      if (res.rows.length === 0) {
        return reply.code(404).send({ error: 'Conference not found' });
      }

      await logAudit({
        conferenceId: id,
        userId: request.currentUser.id,
        action: 'CONFERENCE_UPDATED',
        entityType: 'conference',
        entityId: id,
        details: { status, name },
      });

      return { conference: res.rows[0] };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to update conference', details: err.message });
    }
  });
}

module.exports = conferenceRoutes;
