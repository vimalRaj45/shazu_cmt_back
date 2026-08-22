const db = require('../config/db');
const { authenticate, requireRoles } = require('../middlewares/auth');
const { sendBroadcastAnnouncement, sendEmail } = require('../services/emailService');
const { logAudit } = require('../services/auditService');

async function emailRoutes(fastify, options) {
  // Get email delivery logs for a conference (Chair/Admin)
  fastify.get('/logs/:conferenceId', { preHandler: [authenticate, requireRoles('admin', 'chair')] }, async (request, reply) => {
    const { conferenceId } = request.params;
    try {
      const res = await db.query(
        `SELECT * FROM email_logs WHERE conference_id = $1 ORDER BY sent_at DESC LIMIT 200`,
        [conferenceId]
      );
      return { logs: res.rows };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to fetch email logs', details: err.message });
    }
  });

  // Chair/Admin: Broadcast email to selected target group (All Authors, All Reviewers, All Participants, or Custom List)
  fastify.post('/broadcast', { preHandler: [authenticate, requireRoles('admin', 'chair')] }, async (request, reply) => {
    const { conferenceId, targetGroup, subject, content, customEmails = [] } = request.body || {};

    if (!conferenceId || !subject || !content) {
      return reply.code(400).send({ error: 'Conference ID, Subject, and Content are required.' });
    }

    try {
      const confRes = await db.query('SELECT id, name, short_name FROM conferences WHERE id = $1', [conferenceId]);
      if (confRes.rows.length === 0) {
        return reply.code(404).send({ error: 'Conference not found' });
      }
      const conference = confRes.rows[0];

      let recipients = [];

      if (targetGroup === 'authors') {
        const authRes = await db.query(
          `SELECT DISTINCT u.email, u.first_name, u.last_name 
           FROM submissions s 
           JOIN users u ON s.corresponding_author_id = u.id 
           WHERE s.conference_id = $1`,
          [conferenceId]
        );
        recipients = authRes.rows;
      } else if (targetGroup === 'reviewers') {
        const revRes = await db.query(
          `SELECT DISTINCT u.email, u.first_name, u.last_name 
           FROM conference_reviewers cr 
           JOIN users u ON cr.reviewer_id = u.id 
           WHERE cr.conference_id = $1`,
          [conferenceId]
        );
        recipients = revRes.rows;
      } else if (targetGroup === 'all') {
        const allRes = await db.query(`SELECT DISTINCT email, first_name, last_name FROM users WHERE role != 'admin'`);
        recipients = allRes.rows;
      } else if (targetGroup === 'custom' && Array.isArray(customEmails)) {
        recipients = customEmails.map((e) => ({ email: e.trim(), first_name: '', last_name: '' }));
      }

      if (recipients.length === 0) {
        return reply.code(400).send({ error: 'No recipients found for the selected target group.' });
      }

      // Dispatch via Brevo
      sendBroadcastAnnouncement({
        recipients,
        conference,
        title: subject,
        content,
      }).catch((e) => console.error('Error during broadcast:', e.message));

      await logAudit({
        conferenceId,
        userId: request.currentUser.id,
        action: 'EMAIL_BROADCAST_TRIGGERED',
        entityType: 'email_broadcast',
        entityId: conferenceId,
        details: { targetGroup, recipientCount: recipients.length, subject },
      });

      return {
        success: true,
        message: `Email broadcast queued to ${recipients.length} recipients via Brevo.`,
        recipientCount: recipients.length,
      };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to broadcast email', details: err.message });
    }
  });
}

module.exports = emailRoutes;
