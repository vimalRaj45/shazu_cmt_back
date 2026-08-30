require('dotenv').config();
const db = require('../config/db');

const HOSTINGER_API_KEY = process.env.HOSTINGER_API_KEY;
const SENDER_EMAIL = process.env.HOSTINGER_SENDER_EMAIL || 'info@shazusofttechnologies.org';
const SENDER_NAME = process.env.HOSTINGER_SENDER_NAME || 'Shazu Soft Technologies';

/**
 * Base method to dispatch transactional emails via Hostinger Mail API
 */
async function sendEmail({ toEmail, toName, subject, htmlContent, templateName = 'custom', conferenceId = null }) {
  const hostingerKey = process.env.HOSTINGER_API_KEY || HOSTINGER_API_KEY;

  if (!hostingerKey) {
    console.warn('[Email Service] HOSTINGER_API_KEY is not configured. Email skipped:', { toEmail, subject });
    return { success: false, error: 'HOSTINGER_API_KEY is not set' };
  }

  const authHeader = hostingerKey.startsWith('Bearer ') ? hostingerKey : `Bearer ${hostingerKey}`;
  const payload = {
    from: SENDER_NAME ? `${SENDER_NAME} <${SENDER_EMAIL}>` : SENDER_EMAIL,
    to: toEmail,
    subject,
    html: htmlContent,
  };

  try {
    const response = await fetch('https://api.mail.hostinger.com/v1/emails', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': authHeader,
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('[Hostinger Email Error]', data);
      await logEmailRecord({
        conferenceId,
        recipientEmail: toEmail,
        recipientName: toName,
        subject,
        templateName,
        contentPreview: htmlContent.slice(0, 300),
        status: 'failed',
        errorMessage: JSON.stringify(data),
      });
      return { success: false, error: data };
    }

    const messageId = data.id || data.messageId || (data.data && data.data.id) || 'sent';

    await logEmailRecord({
      conferenceId,
      recipientEmail: toEmail,
      recipientName: toName,
      subject,
      templateName,
      contentPreview: htmlContent.slice(0, 300),
      status: 'sent',
      brevoMessageId: messageId,
    });

    console.log(`[Hostinger Email Success] Email dispatched to ${toEmail} | ID: ${messageId}`);
    return { success: true, messageId };
  } catch (err) {
    console.error('[Hostinger Email Exception]', err);
    await logEmailRecord({
      conferenceId,
      recipientEmail: toEmail,
      recipientName: toName,
      subject,
      templateName,
      contentPreview: htmlContent.slice(0, 300),
      status: 'failed',
      errorMessage: err.message,
    });
    return { success: false, error: err.message };
  }
}

/**
 * Log outgoing email into database
 */
async function logEmailRecord({ conferenceId, recipientEmail, recipientName, subject, templateName, contentPreview, status, brevoMessageId, errorMessage }) {
  try {
    await db.query(
      `INSERT INTO email_logs (conference_id, recipient_email, recipient_name, subject, template_name, content_preview, status, brevo_message_id, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [conferenceId, recipientEmail, recipientName || '', subject, templateName, contentPreview, status, brevoMessageId || null, errorMessage || null]
    );
  } catch (dbErr) {
    console.error('Failed to log email record in DB:', dbErr.message);
  }
}

/**
 * Common HTML wrapper layout
 */
function wrapHtml(title, bodyHtml) {
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <title>${title}</title>
    <style>
      body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f6f9; margin: 0; padding: 20px; color: #2d3748; }
      .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
      .header { background: linear-gradient(135deg, #1e3c72 0%, #2a5298 100%); color: #ffffff; padding: 28px; text-align: center; }
      .header h1 { margin: 0; font-size: 22px; letter-spacing: 0.5px; }
      .content { padding: 32px; line-height: 1.6; }
      .badge { display: inline-block; padding: 6px 12px; background: #e2e8f0; border-radius: 4px; font-weight: bold; font-size: 14px; margin: 10px 0; }
      .footer { background: #edf2f7; padding: 18px; text-align: center; font-size: 12px; color: #718096; }
      .button { display: inline-block; padding: 12px 24px; background: #2a5298; color: #ffffff !important; text-decoration: none; border-radius: 6px; font-weight: 600; margin-top: 15px; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h1>Shazu Soft Technologies CMT</h1>
      </div>
      <div class="content">
        ${bodyHtml}
      </div>
      <div class="footer">
        <p>This is an automated message from Shazu Soft Conference Management Tool (CMT).</p>
        <p>© ${new Date().getFullYear()} Shazu Soft Technologies. All rights reserved.</p>
      </div>
    </div>
  </body>
  </html>
  `;
}

// ----------------- Predefined Email Templates ----------------- //

// 1. Account Created
async function sendWelcomeEmail(user) {
  const html = wrapHtml(
    'Welcome to Shazu Soft CMT',
    `
    <h3>Dear ${user.first_name} ${user.last_name},</h3>
    <p>Welcome to the <strong>Shazu Soft Conference Management Tool (CMT)</strong>.</p>
    <p>Your account has been created with the primary role: <span class="badge">${user.role.toUpperCase()}</span></p>
    <p>You can log in to manage your submissions, review assigned papers, or configure conference programs.</p>
    <p>Login Email: <strong>${user.email}</strong></p>
    `
  );
  return sendEmail({
    toEmail: user.email,
    toName: `${user.first_name} ${user.last_name}`,
    subject: `Welcome to Shazu Soft CMT - Account Created`,
    htmlContent: html,
    templateName: 'account_created',
  });
}

// 2. Submission Received Confirmation
async function sendSubmissionConfirmation({ user, conference, submission }) {
  const html = wrapHtml(
    'Paper Submission Received',
    `
    <h3>Dear ${user.first_name} ${user.last_name},</h3>
    <p>Thank you for submitting your manuscript to <strong>${conference.name} (${conference.short_name})</strong>.</p>
    <div style="background: #f7fafc; border-left: 4px solid #3182ce; padding: 16px; margin: 15px 0;">
      <p style="margin: 0 0 8px 0;"><strong>Submission ID:</strong> ${submission.submission_number}</p>
      <p style="margin: 0 0 8px 0;"><strong>Title:</strong> ${submission.title}</p>
      <p style="margin: 0;"><strong>Status:</strong> ${submission.status.toUpperCase()}</p>
    </div>
    <p>You can track the review status and update metadata from your Author Dashboard.</p>
    `
  );
  return sendEmail({
    toEmail: user.email,
    toName: `${user.first_name} ${user.last_name}`,
    subject: `[${conference.short_name}] Submission Confirmation: ${submission.submission_number}`,
    htmlContent: html,
    templateName: 'submission_received',
    conferenceId: conference.id,
  });
}

// 3. Reviewer Assignment / Invitation
async function sendReviewerInvitation({ reviewer, conference, submission }) {
  const html = wrapHtml(
    'Reviewer Assignment Notification',
    `
    <h3>Dear ${reviewer.first_name} ${reviewer.last_name},</h3>
    <p>You have been assigned as a peer reviewer for <strong>${conference.name}</strong>.</p>
    <div style="background: #f7fafc; border-left: 4px solid #805ad5; padding: 16px; margin: 15px 0;">
      <p style="margin: 0 0 8px 0;"><strong>Paper ID:</strong> ${submission.submission_number}</p>
      <p style="margin: 0 0 8px 0;"><strong>Title:</strong> ${submission.title}</p>
      <p style="margin: 0;"><strong>Review Deadline:</strong> ${conference.review_deadline ? new Date(conference.review_deadline).toLocaleDateString() : 'As specified in system'}</p>
    </div>
    <p>Please log in to your Reviewer Dashboard to download the manuscript and submit your review.</p>
    `
  );
  return sendEmail({
    toEmail: reviewer.email,
    toName: `${reviewer.first_name} ${reviewer.last_name}`,
    subject: `[${conference.short_name}] Review Assignment: ${submission.submission_number}`,
    htmlContent: html,
    templateName: 'reviewer_assignment',
    conferenceId: conference.id,
  });
}

// 4. Paper Decision Notification (Accept, Reject, Revision Required)
async function sendDecisionNotification({ author, conference, submission, decision, decisionNotes }) {
  let decisionBadgeColor = '#38a169'; // green for accept
  let statusText = 'ACCEPTED';
  if (decision === 'reject') {
    decisionBadgeColor = '#e53e3e';
    statusText = 'REJECTED';
  } else if (decision === 'revision_required') {
    decisionBadgeColor = '#d69e2e';
    statusText = 'REVISION REQUIRED';
  }

  const html = wrapHtml(
    `Paper Decision: ${statusText}`,
    `
    <h3>Dear ${author.first_name} ${author.last_name},</h3>
    <p>The program committee of <strong>${conference.name}</strong> has reached a decision regarding your submission.</p>
    <div style="background: #f7fafc; border-left: 4px solid ${decisionBadgeColor}; padding: 16px; margin: 15px 0;">
      <p style="margin: 0 0 8px 0;"><strong>Submission ID:</strong> ${submission.submission_number}</p>
      <p style="margin: 0 0 8px 0;"><strong>Title:</strong> ${submission.title}</p>
      <p style="margin: 0 0 8px 0;"><strong>Decision:</strong> <span style="color: ${decisionBadgeColor}; font-weight: bold;">${statusText}</span></p>
      ${decisionNotes ? `<p style="margin: 8px 0 0 0;"><strong>Chair Feedback:</strong><br>${decisionNotes}</p>` : ''}
    </div>
    ${decision === 'accepted' ? `<p><strong>Next Step:</strong> Please prepare and upload your Camera-Ready paper before the deadline: ${conference.camera_ready_deadline ? new Date(conference.camera_ready_deadline).toLocaleDateString() : 'See portal'}.</p>` : ''}
    ${decision === 'revision_required' ? `<p><strong>Next Step:</strong> Please address reviewer remarks and submit your revised manuscript via the portal.</p>` : ''}
    `
  );

  return sendEmail({
    toEmail: author.email,
    toName: `${author.first_name} ${author.last_name}`,
    subject: `[${conference.short_name}] Decision for Submission ${submission.submission_number}: ${statusText}`,
    htmlContent: html,
    templateName: `decision_${decision}`,
    conferenceId: conference.id,
  });
}

// 5. Broadcast Announcement
async function sendBroadcastAnnouncement({ recipients, conference, title, content }) {
  const results = [];
  for (const user of recipients) {
    const html = wrapHtml(
      title,
      `
      <h3>Dear ${user.first_name || 'Participant'},</h3>
      <p>An announcement has been published for <strong>${conference.name} (${conference.short_name})</strong>:</p>
      <div style="background: #f7fafc; border-left: 4px solid #2b6cb0; padding: 16px; margin: 15px 0;">
        <h4 style="margin: 0 0 10px 0;">${title}</h4>
        <div style="white-space: pre-wrap;">${content}</div>
      </div>
      <p>Log in to the portal for full details.</p>
      `
    );
    const res = await sendEmail({
      toEmail: user.email,
      toName: `${user.first_name || ''} ${user.last_name || ''}`.trim(),
      subject: `[${conference.short_name} Announcement] ${title}`,
      htmlContent: html,
      templateName: 'broadcast_announcement',
      conferenceId: conference.id,
    });
    results.push(res);
  }
  return results;
}

module.exports = {
  sendEmail,
  sendWelcomeEmail,
  sendSubmissionConfirmation,
  sendReviewerInvitation,
  sendDecisionNotification,
  sendBroadcastAnnouncement,
};
