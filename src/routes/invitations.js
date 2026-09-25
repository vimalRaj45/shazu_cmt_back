const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { authenticate, requireRoles } = require('../middlewares/auth');
const { sendCommitteeInvitation, sendAuthorInvitation } = require('../services/emailService');
const { logAudit } = require('../services/auditService');

async function invitationRoutes(fastify, options) {
  // Get recent invitations history for a conference or all conferences (Chair/Admin)
  fastify.get('/history', { preHandler: [authenticate, requireRoles('admin', 'chair')] }, async (request, reply) => {
    const { conferenceId, limit = 50 } = request.query || {};

    try {
      let query = `
        SELECT el.*, c.name as conference_name, c.short_name as conference_short_name
        FROM email_logs el
        LEFT JOIN conferences c ON el.conference_id = c.id
        WHERE el.template_name IN ('committee_invitation', 'author_invitation')
      `;
      const params = [];

      if (conferenceId) {
        params.push(parseInt(conferenceId, 10));
        query += ` AND el.conference_id = $${params.length}`;
      }

      params.push(parseInt(limit, 10) || 50);
      query += ` ORDER BY el.sent_at DESC LIMIT $${params.length}`;

      const res = await db.query(query, params);
      return { invitations: res.rows };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to fetch invitation history', details: err.message });
    }
  });

  // Bulk send invitations to Authors or Reviewers (Chair/Admin)
  fastify.post('/bulk', { preHandler: [authenticate, requireRoles('admin', 'chair')] }, async (request, reply) => {
    const {
      conferenceId,
      role = 'author', // 'author' | 'reviewer'
      recipients = [], // Array of { email, name, institution }
      customSubject = '',
      customMessage = '',
    } = request.body || {};

    const confId = parseInt(conferenceId, 10);
    if (!confId || isNaN(confId)) {
      return reply.code(400).send({ error: 'Please select a valid Journal or Conference.' });
    }

    if (!Array.isArray(recipients) || recipients.length === 0) {
      return reply.code(400).send({ error: 'Please provide at least one valid recipient email.' });
    }

    try {
      // Validate Conference / Journal
      const confRes = await db.query('SELECT * FROM conferences WHERE id = $1', [confId]);
      if (confRes.rows.length === 0) {
        return reply.code(404).send({ error: 'Selected Conference / Journal not found.' });
      }
      const conference = confRes.rows[0];

      const results = [];
      let sentCount = 0;
      let failedCount = 0;
      let skippedCount = 0;

      for (const item of recipients) {
        const rawEmail = typeof item === 'string' ? item : item.email;
        if (!rawEmail || !rawEmail.includes('@')) {
          results.push({ email: rawEmail || 'unknown', status: 'failed', error: 'Invalid email address' });
          failedCount++;
          continue;
        }

        const cleanEmail = String(rawEmail).toLowerCase().trim();
        const recipientName = typeof item === 'object' && item.name ? item.name.trim() : '';
        const institution = typeof item === 'object' && item.institution ? item.institution.trim() : 'Academic / Research Institution';

        try {
          // Check if user already exists
          const uRes = await db.query('SELECT id, email, first_name, last_name, role FROM users WHERE email = $1', [cleanEmail]);
          let targetUser = null;
          let tempPassword = null;
          let isNewAccount = false;

          if (uRes.rows.length > 0) {
            targetUser = uRes.rows[0];
            // If inviting as reviewer and user is author, upgrade role
            if (role === 'reviewer' && targetUser.role === 'author') {
              await db.query("UPDATE users SET role = 'reviewer' WHERE id = $1", [targetUser.id]);
              targetUser.role = 'reviewer';
            }
          } else {
            // Provision user account
            isNewAccount = true;
            let firstName = 'Invited';
            let lastName = role === 'reviewer' ? 'Reviewer' : 'Author';

            if (recipientName) {
              const nameParts = recipientName.split(' ');
              firstName = nameParts[0];
              lastName = nameParts.slice(1).join(' ') || (role === 'reviewer' ? 'Reviewer' : 'Author');
            } else {
              const userPrefix = cleanEmail.split('@')[0];
              firstName = userPrefix.charAt(0).toUpperCase() + userPrefix.slice(1);
            }

            tempPassword = (role === 'reviewer' ? 'Rev_' : 'Auth_') + Math.random().toString(36).slice(-6) + '!';
            const passwordHash = await bcrypt.hash(tempPassword, 10);

            const newUserRes = await db.query(
              `INSERT INTO users (
                 email, password_hash, first_name, last_name, role,
                 institution, department, designation, domain
               )
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
               RETURNING id, email, first_name, last_name, role;`,
              [
                cleanEmail,
                passwordHash,
                firstName,
                lastName,
                role === 'reviewer' ? 'reviewer' : 'author',
                institution,
                'Academic Department',
                role === 'reviewer' ? 'Peer Reviewer' : 'Author / Researcher',
                'Computer Science & Engineering',
              ]
            );
            targetUser = newUserRes.rows[0];
          }

          // If role is reviewer, link to conference_reviewers
          if (role === 'reviewer') {
            await db.query(
              `INSERT INTO conference_reviewers (conference_id, reviewer_id, status)
               VALUES ($1, $2, 'accepted')
               ON CONFLICT (conference_id, reviewer_id) DO UPDATE SET status = 'accepted';`,
              [confId, targetUser.id]
            );

            // Send reviewer invitation email
            await sendCommitteeInvitation({
              reviewer: targetUser,
              conference,
              tempPassword,
              customSubject: customSubject || undefined,
              customMessage: customMessage || undefined,
            });
          } else {
            // Role is author -> Send Call for Papers / Author invitation email
            await sendAuthorInvitation({
              author: targetUser,
              conference,
              tempPassword,
              customSubject: customSubject || undefined,
              customMessage: customMessage || undefined,
            });
          }

          sentCount++;
          results.push({
            email: cleanEmail,
            name: `${targetUser.first_name} ${targetUser.last_name || ''}`.trim(),
            role,
            status: 'sent',
            isNewAccount,
            tempPassword: tempPassword || undefined,
          });
        } catch (itemErr) {
          console.error(`[Bulk Invite Error] for ${cleanEmail}:`, itemErr);
          results.push({
            email: cleanEmail,
            status: 'failed',
            error: itemErr.message || 'Error sending invitation',
          });
          failedCount++;
        }
      }

      await logAudit({
        conferenceId: confId,
        userId: request.currentUser?.id,
        action: 'BULK_INVITATIONS_DISPATCHED',
        entityType: 'invitations',
        entityId: confId,
        details: {
          conferenceId: confId,
          role,
          totalCount: recipients.length,
          sentCount,
          failedCount,
        },
      });

      return {
        success: true,
        message: `Successfully processed ${recipients.length} invitations (${sentCount} sent, ${failedCount} failed).`,
        totalProcessed: recipients.length,
        sentCount,
        failedCount,
        skippedCount,
        results,
      };
    } catch (err) {
      console.error('[Bulk Invitations Error]:', err);
      return reply.code(500).send({ error: 'Failed to process bulk invitations', details: err.message });
    }
  });
}

module.exports = invitationRoutes;
