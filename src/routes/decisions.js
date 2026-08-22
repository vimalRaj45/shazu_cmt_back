const db = require('../config/db');
const { authenticate, requireRoles } = require('../middlewares/auth');
const { sendDecisionNotification } = require('../services/emailService');
const { logAudit } = require('../services/auditService');

async function decisionRoutes(fastify, options) {
  // Get decision details and summary for a submission
  fastify.get('/submission/:submissionId', { preHandler: [authenticate] }, async (request, reply) => {
    const { submissionId } = request.params;
    try {
      const res = await db.query(
        `SELECT pd.*, u.first_name as decider_first_name, u.last_name as decider_last_name 
         FROM paper_decisions pd
         LEFT JOIN users u ON pd.decided_by = u.id
         WHERE pd.submission_id = $1`,
        [submissionId]
      );
      return { decision: res.rows[0] || null };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to fetch decision', details: err.message });
    }
  });

  // Chair: Record / Update Paper Decision
  fastify.post('/submission/:submissionId', { preHandler: [authenticate, requireRoles('admin', 'chair')] }, async (request, reply) => {
    const { submissionId } = request.params;
    const { decision, decisionNotes, notifyAuthor = true } = request.body || {};

    if (!decision || !['accept', 'reject', 'revision_required'].includes(decision)) {
      return reply.code(400).send({ error: "Invalid decision value. Must be 'accept', 'reject', or 'revision_required'." });
    }

    try {
      // Map decision to submission status
      let newStatus = 'accepted';
      if (decision === 'reject') newStatus = 'rejected';
      if (decision === 'revision_required') newStatus = 'revision_required';

      // Update paper status
      await db.query(`UPDATE submissions SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [newStatus, submissionId]);

      // Record decision
      const decRes = await db.query(
        `INSERT INTO paper_decisions (submission_id, decision, decision_notes, notified_authors, decided_by, decided_at)
         VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
         ON CONFLICT (submission_id) DO UPDATE SET
            decision = EXCLUDED.decision,
            decision_notes = EXCLUDED.decision_notes,
            notified_authors = EXCLUDED.notified_authors,
            decided_by = EXCLUDED.decided_by,
            decided_at = CURRENT_TIMESTAMP
         RETURNING *;`,
        [submissionId, decision, decisionNotes || '', notifyAuthor, request.currentUser.id]
      );

      // Fetch submission & author info to send email notification
      const subRes = await db.query(
        `SELECT s.id, s.submission_number, s.title, s.conference_id,
                u.id as author_id, u.email as author_email, u.first_name as author_first_name, u.last_name as author_last_name,
                c.name as conference_name, c.short_name as conference_short_name, c.camera_ready_deadline
         FROM submissions s
         JOIN users u ON s.corresponding_author_id = u.id
         JOIN conferences c ON s.conference_id = c.id
         WHERE s.id = $1`,
        [submissionId]
      );

      if (subRes.rows.length > 0 && notifyAuthor) {
        const row = subRes.rows[0];
        sendDecisionNotification({
          author: { email: row.author_email, first_name: row.author_first_name, last_name: row.author_last_name },
          conference: { name: row.conference_name, short_name: row.conference_short_name, camera_ready_deadline: row.camera_ready_deadline },
          submission: { submission_number: row.submission_number, title: row.title },
          decision,
          decisionNotes,
        }).catch((e) => console.error('Failed to dispatch decision email:', e.message));
      }

      await logAudit({
        conferenceId: subRes.rows[0] ? subRes.rows[0].conference_id : null,
        userId: request.currentUser.id,
        action: 'PAPER_DECISION_RECORDED',
        entityType: 'paper_decision',
        entityId: submissionId,
        details: { decision, submissionNumber: subRes.rows[0]?.submission_number },
      });

      return {
        decision: decRes.rows[0],
        message: `Decision successfully recorded as ${decision.toUpperCase()}`,
      };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to record decision', details: err.message });
    }
  });
}

module.exports = decisionRoutes;
