const db = require('../config/db');

async function logAudit({ conferenceId = null, userId = null, action, entityType = null, entityId = null, details = {} }) {
  try {
    await db.query(
      `INSERT INTO audit_logs (conference_id, user_id, action, entity_type, entity_id, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [conferenceId, userId, action, entityType, entityId ? String(entityId) : null, JSON.stringify(details)]
    );
  } catch (err) {
    console.error('Audit logging failure:', err.message);
  }
}

module.exports = { logAudit };
