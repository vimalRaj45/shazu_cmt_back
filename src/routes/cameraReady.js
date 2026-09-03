const db = require('../config/db');
const { authenticate, requireRoles } = require('../middlewares/auth');
const { logAudit } = require('../services/auditService');
const { sendCameraReadyStatusEmail } = require('../services/emailService');

async function cameraReadyRoutes(fastify, options) {
  // Get camera-ready submissions for a conference (Chair/Admin)
  fastify.get('/conference/:conferenceId', { preHandler: [authenticate, requireRoles('admin', 'chair')] }, async (request, reply) => {
    const { conferenceId } = request.params;
    try {
      const res = await db.query(
        `SELECT s.id, s.submission_number, s.title, s.status, s.updated_at,
                t.name as track_name,
                u.first_name as author_first_name, u.last_name as author_last_name, u.email as author_email,
                (SELECT json_agg(sf.* ORDER BY sf.version DESC) FROM submission_files sf WHERE sf.submission_id = s.id) as files,
                (SELECT json_agg(sf.* ORDER BY sf.version DESC) FROM submission_files sf WHERE sf.submission_id = s.id AND sf.file_type = 'camera_ready') as camera_ready_files
         FROM submissions s
         LEFT JOIN tracks t ON s.track_id = t.id
         LEFT JOIN users u ON s.corresponding_author_id = u.id
         WHERE s.conference_id = $1 AND s.status IN ('accepted', 'camera_ready_pending', 'camera_ready_approved')
         ORDER BY s.updated_at DESC`,
        [conferenceId]
      );
      return { submissions: res.rows };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to fetch camera-ready list', details: err.message });
    }
  });

  // Chair: Approve Camera-Ready submission or Request Correction
  fastify.post('/:submissionId/status', { preHandler: [authenticate, requireRoles('admin', 'chair')] }, async (request, reply) => {
    const { submissionId } = request.params;
    const { status, remarks } = request.body || {}; // 'camera_ready_approved' or 'revision_required'

    if (!['camera_ready_approved', 'revision_required', 'rejected', 'camera_ready_rejected', 'camera_ready_pending'].includes(status)) {
      return reply.code(400).send({ error: 'Invalid camera-ready status' });
    }

    try {
      const res = await db.query(
        `UPDATE submissions SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *;`,
        [status, submissionId]
      );

      if (res.rows.length === 0) {
        return reply.code(404).send({ error: 'Submission not found' });
      }

      const sub = res.rows[0];

      await logAudit({
        conferenceId: sub.conference_id,
        userId: request.currentUser.id,
        action: 'CAMERA_READY_STATUS_UPDATED',
        entityType: 'submission',
        entityId: submissionId,
        details: { status, remarks },
      });

      // Send email notification to corresponding author
      if (status === 'camera_ready_approved' || status === 'revision_required') {
        try {
          const detailRes = await db.query(
            `SELECT s.title, s.submission_number, 
                    u.email as author_email, u.first_name as author_first_name, u.last_name as author_last_name,
                    c.id as conference_id, c.name as conference_name, c.short_name as conference_short_name
             FROM submissions s
             JOIN users u ON s.corresponding_author_id = u.id
             JOIN conferences c ON s.conference_id = c.id
             WHERE s.id = $1`,
            [submissionId]
          );

          if (detailRes.rows.length > 0) {
            const d = detailRes.rows[0];
            sendCameraReadyStatusEmail({
              author: {
                email: d.author_email,
                first_name: d.author_first_name,
                last_name: d.author_last_name,
              },
              conference: {
                id: d.conference_id,
                name: d.conference_name,
                short_name: d.conference_short_name,
              },
              submission: {
                submission_number: d.submission_number,
                title: d.title,
              },
              status,
              remarks,
            }).catch((emailErr) => {
              request.log.error(`[CameraReady Email Error]: ${emailErr.message}`);
            });
          }
        } catch (fetchErr) {
          request.log.error(`[CameraReady Fetch Author Detail Error]: ${fetchErr.message}`);
        }
      }

      return {
        submission: sub,
        message: status === 'camera_ready_approved' ? 'Camera-Ready Paper Approved!' : 'Status updated.',
      };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to update camera-ready status', details: err.message });
    }
  });
}

module.exports = cameraReadyRoutes;
