const db = require('../config/db');
const { authenticate, requireRoles } = require('../middlewares/auth');

async function sessionRoutes(fastify, options) {
  // Public/All: List sessions and presentation schedule for a conference
  fastify.get('/conference/:conferenceId', async (request, reply) => {
    const { conferenceId } = request.params;
    try {
      const sessionsRes = await db.query(
        `SELECT cs.*, t.name as track_name,
                (
                  SELECT json_agg(
                    json_build_object(
                      'presentation_id', sp.id,
                      'submission_id', s.id,
                      'submission_number', s.submission_number,
                      'title', s.title,
                      'abstract', s.abstract,
                      'presentation_order', sp.presentation_order,
                      'start_time', sp.start_time,
                      'end_time', sp.end_time,
                      'presentation_notes', sp.presentation_notes,
                      'authors', (SELECT json_agg(sa.* ORDER BY sa.author_order ASC) FROM submission_authors sa WHERE sa.submission_id = s.id)
                    ) ORDER BY sp.presentation_order ASC
                  )
                  FROM session_presentations sp
                  JOIN submissions s ON sp.submission_id = s.id
                  WHERE sp.session_id = cs.id
                ) as presentations
         FROM conference_sessions cs
         LEFT JOIN tracks t ON cs.track_id = t.id
         WHERE cs.conference_id = $1
         ORDER BY cs.session_date ASC, cs.start_time ASC`,
        [conferenceId]
      );
      return { sessions: sessionsRes.rows };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to fetch sessions', details: err.message });
    }
  });

  // Chair/Admin: Create session
  fastify.post('/', { preHandler: [authenticate, requireRoles('admin', 'chair')] }, async (request, reply) => {
    const { conferenceId, trackId, sessionName, sessionChairName, venueRoom, sessionDate, startTime, endTime } = request.body || {};

    if (!conferenceId || !sessionName || !sessionDate || !startTime || !endTime) {
      return reply.code(400).send({ error: 'Conference ID, Session Name, Session Date, and Start/End times are required.' });
    }

    try {
      const res = await db.query(
        `INSERT INTO conference_sessions (conference_id, track_id, session_name, session_chair_name, venue_room, session_date, start_time, end_time)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *;`,
        [conferenceId, trackId || null, sessionName, sessionChairName || '', venueRoom || '', sessionDate, startTime, endTime]
      );
      return { session: res.rows[0] };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to create session', details: err.message });
    }
  });

  // Chair/Admin: Add / Reorder presentation in a session
  fastify.post('/:sessionId/presentations', { preHandler: [authenticate, requireRoles('admin', 'chair')] }, async (request, reply) => {
    const { sessionId } = request.params;
    const { submissionId, presentationOrder = 1, startTime, endTime, presentationNotes } = request.body || {};

    if (!submissionId) {
      return reply.code(400).send({ error: 'submissionId is required' });
    }

    try {
      const res = await db.query(
        `INSERT INTO session_presentations (session_id, submission_id, presentation_order, start_time, end_time, presentation_notes)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (session_id, submission_id) DO UPDATE SET
            presentation_order = EXCLUDED.presentation_order,
            start_time = EXCLUDED.start_time,
            end_time = EXCLUDED.end_time,
            presentation_notes = EXCLUDED.presentation_notes
         RETURNING *;`,
        [sessionId, submissionId, presentationOrder, startTime || null, endTime || null, presentationNotes || '']
      );
      return { presentation: res.rows[0] };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to schedule presentation in session', details: err.message });
    }
  });

  // Chair/Admin: Remove presentation from session
  fastify.delete('/:sessionId/presentations/:submissionId', { preHandler: [authenticate, requireRoles('admin', 'chair')] }, async (request, reply) => {
    const { sessionId, submissionId } = request.params;
    try {
      await db.query('DELETE FROM session_presentations WHERE session_id = $1 AND submission_id = $2', [sessionId, submissionId]);
      return { success: true, message: 'Presentation removed from session' };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to remove presentation', details: err.message });
    }
  });

  // Delete session
  fastify.delete('/:id', { preHandler: [authenticate, requireRoles('admin', 'chair')] }, async (request, reply) => {
    const { id } = request.params;
    try {
      await db.query('DELETE FROM conference_sessions WHERE id = $1', [id]);
      return { success: true, message: 'Session deleted' };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to delete session', details: err.message });
    }
  });
}

module.exports = sessionRoutes;
