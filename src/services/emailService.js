const db = require('../config/db');

let hostingerSDK = null;
try {
  hostingerSDK = require('hostinger-mail-api-sdk');
} catch (e) {
  // SDK optionally loaded if installed
}

const HOSTINGER_API_KEY = process.env.HOSTINGER_API_KEY;
const SENDER_EMAIL = process.env.HOSTINGER_SENDER_EMAIL || 'info@shazusofttechnologies.org';
const SENDER_NAME = process.env.HOSTINGER_SENDER_NAME || 'Shazu Soft Technologies';

let cachedMailboxResourceId = null;

/**
 * Base method to dispatch transactional emails via Hostinger Mail API SDK
 */
async function sendEmail({ toEmail, toName, subject, htmlContent, textContent = '', templateName = 'custom', conferenceId = null }) {
  const hostingerKey = process.env.HOSTINGER_API_KEY || HOSTINGER_API_KEY;

  if (!hostingerKey) {
    console.warn('[Email Service] HOSTINGER_API_KEY is not configured. Email skipped:', { toEmail, subject });
    return { success: false, error: 'HOSTINGER_API_KEY is not set' };
  }

  // 1. Primary: Try Hostinger Mail SDK
  if (hostingerSDK && hostingerSDK.Configuration && hostingerSDK.SendApi) {
    try {
      const config = new hostingerSDK.Configuration({
        accessToken: hostingerKey,
        apiKey: hostingerKey,
      });

      const sendApi = new hostingerSDK.SendApi(config);

      if (!cachedMailboxResourceId && hostingerSDK.AccountApi) {
        try {
          const accountApi = new hostingerSDK.AccountApi(config);
          const accRes = await accountApi.getCurrentAccount();
          const accData = accRes.data ? accRes.data.data || accRes.data : accRes;
          const mailboxes = accData.mailboxes || (Array.isArray(accData) ? accData : []);
          
          const targetAddr = SENDER_EMAIL.toLowerCase().trim();
          const matchedMb = mailboxes.find(
            (mb) => (mb.email && mb.email.toLowerCase().trim() === targetAddr) || (mb.address && mb.address.toLowerCase().trim() === targetAddr)
          );

          if (matchedMb) {
            cachedMailboxResourceId = matchedMb.resourceId || matchedMb.id;
          } else if (mailboxes.length > 0) {
            cachedMailboxResourceId = mailboxes[0].resourceId || mailboxes[0].id;
          }
        } catch (e) {
          // ignore lookup warning
        }
      }

      const resourceId = cachedMailboxResourceId || 'AC27733647b7b2b04cefeca882d854';
      const sendRequest = {
        from: SENDER_NAME ? `${SENDER_NAME} <${SENDER_EMAIL}>` : SENDER_EMAIL,
        to: [toEmail],
        subject: subject || 'Notification',
        html: htmlContent || `<p>${textContent || subject}</p>`,
        text: textContent || subject,
      };

      const response = await sendApi.sendEmail(resourceId, sendRequest);
      const messageId = response?.data?.id || response?.id || 'sent-sdk';

      await logEmailRecord({
        conferenceId,
        recipientEmail: toEmail,
        recipientName: toName,
        subject,
        templateName,
        contentPreview: (htmlContent || subject).slice(0, 300),
        status: 'sent',
        brevoMessageId: messageId,
      });

      console.log(`[Hostinger Mail SDK Success] Email dispatched to ${toEmail} | ID: ${messageId}`);
      return { success: true, messageId, statusCode: response ? response.status || 204 : 204 };
    } catch (sdkErr) {
      const errorMsg = sdkErr.response && sdkErr.response.data ? JSON.stringify(sdkErr.response.data) : sdkErr.message;
      console.warn('[Hostinger Mail SDK Error]:', errorMsg);
    }
  }

  // 2. Direct REST API endpoints fallback
  const authHeader = hostingerKey.startsWith('Bearer ') ? hostingerKey : `Bearer ${hostingerKey}`;
  const payload = {
    from: SENDER_NAME ? `${SENDER_NAME} <${SENDER_EMAIL}>` : SENDER_EMAIL,
    to: [toEmail],
    subject,
    html: htmlContent,
  };

  const HOSTINGER_ENDPOINTS = [
    'https://api.mail.hostinger.com/api/v1/send',
    'https://api.mail.hostinger.com/api/v1/emails',
    'https://api.mail.hostinger.com/v1/send',
    'https://api.hostinger.com/v1/email/send',
    'https://api.hostinger.com/v1/emails',
  ];

  let lastError = null;

  for (const endpoint of HOSTINGER_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Authorization': authHeader,
          'x-api-key': hostingerKey,
        },
        body: JSON.stringify(payload),
      });

      const text = await response.text();
      let data = {};
      try {
        data = JSON.parse(text);
      } catch (e) {
        data = { raw: text };
      }

      if (response.ok) {
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

        console.log(`[Hostinger Email Success] Email dispatched to ${toEmail} via ${endpoint} | ID: ${messageId}`);
        return { success: true, messageId };
      } else {
        lastError = data;
      }
    } catch (err) {
      lastError = err.message;
    }
  }

  console.error('[Hostinger Email Error]', lastError);
  await logEmailRecord({
    conferenceId,
    recipientEmail: toEmail,
    recipientName: toName,
    subject,
    templateName,
    contentPreview: htmlContent.slice(0, 300),
    status: 'failed',
    errorMessage: typeof lastError === 'object' ? JSON.stringify(lastError) : String(lastError),
  });

  return { success: false, error: lastError };
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
    ${decision === 'accepted' ? `
      <div style="background: #ebf8fa; border: 1px dashed #319795; border-radius: 6px; padding: 12px; margin: 15px 0;">
        <p style="margin: 0 0 6px 0; font-weight: bold; color: #234e52;">📄 Recommended File Naming Format for Camera-Ready:</p>
        <p style="margin: 0; font-family: monospace; font-size: 13px; color: #285e61;">${(conference.short_name || 'CONF').replace(/\s+/g, '_')}_${submission.submission_number}_CameraReady.pdf</p>
        <p style="margin: 6px 0 0 0; font-size: 12px; color: #4a5568;"><em>*Please avoid spaces or special characters in filenames for seamless indexing.</em></p>
      </div>
      <p><strong>Next Step:</strong> Please prepare and upload your Camera-Ready paper before the deadline: ${conference.camera_ready_deadline ? new Date(conference.camera_ready_deadline).toLocaleDateString() : 'See portal'}.</p>
    ` : ''}
    ${decision === 'revision_required' ? `
      <div style="background: #fffaf0; border: 1px dashed #dd6b20; border-radius: 6px; padding: 12px; margin: 15px 0;">
        <p style="margin: 0 0 6px 0; font-weight: bold; color: #7b341e;">📄 Recommended File Naming Format for Revision:</p>
        <p style="margin: 0; font-family: monospace; font-size: 13px; color: #9c4221;">${(conference.short_name || 'CONF').replace(/\s+/g, '_')}_${submission.submission_number}_Revision.pdf</p>
        <p style="margin: 6px 0 0 0; font-size: 12px; color: #4a5568;"><em>*Please avoid spaces or special characters in filenames for seamless tracking.</em></p>
      </div>
      <p><strong>Next Step:</strong> Please address reviewer remarks and submit your revised manuscript via the portal.</p>
    ` : ''}
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

// 6. Camera-Ready Status Notification (Approved, Revision/Correction Requested, or Rejected)
async function sendCameraReadyStatusEmail({ author, conference, submission, status, remarks }) {
  const isApproved = status === 'camera_ready_approved';
  const isRejected = status === 'rejected' || status === 'camera_ready_rejected';
  
  let badgeColor = '#38a169'; // green for approved
  let statusText = 'CAMERA-READY APPROVED';
  let templateName = 'camera_ready_approved';

  if (isRejected) {
    badgeColor = '#e53e3e'; // red for reject
    statusText = 'CAMERA-READY REJECTED';
    templateName = 'camera_ready_rejected';
  } else if (!isApproved) {
    badgeColor = '#d69e2e'; // amber for correction requested
    statusText = 'CORRECTION REQUIRED';
    templateName = 'camera_ready_revision_required';
  }

  const html = wrapHtml(
    `Camera-Ready Status: ${statusText}`,
    `
    <h3>Dear ${author.first_name} ${author.last_name},</h3>
    <p>We are writing to update you on the status of your Camera-Ready manuscript for <strong>${conference.name} (${conference.short_name})</strong>.</p>
    <div style="background: #f7fafc; border-left: 4px solid ${badgeColor}; padding: 16px; margin: 15px 0;">
      <p style="margin: 0 0 8px 0;"><strong>Submission ID:</strong> ${submission.submission_number}</p>
      <p style="margin: 0 0 8px 0;"><strong>Title:</strong> ${submission.title}</p>
      <p style="margin: 0 0 8px 0;"><strong>Status:</strong> <span style="color: ${badgeColor}; font-weight: bold;">${statusText}</span></p>
      ${remarks ? `<p style="margin: 8px 0 0 0;"><strong>Committee Remarks / Notes:</strong><br>${remarks}</p>` : ''}
    </div>
    ${
      isApproved
        ? `<p>Your camera-ready manuscript has been verified and approved. It is now finalized and locked for publication in the official proceedings and presentation sessions.</p>
           <p>Thank you for your valuable contribution to <strong>${conference.name}</strong>.</p>`
        : isRejected
        ? `<p>The program committee has reviewed your camera-ready submission and regrets to inform you that it has been rejected and will not be included in the final proceedings.</p>`
        : `
          <div style="background: #fffaf0; border: 1px dashed #dd6b20; border-radius: 6px; padding: 12px; margin: 15px 0;">
            <p style="margin: 0 0 6px 0; font-weight: bold; color: #7b341e;">📄 Recommended File Naming Format for Corrected Copy:</p>
            <p style="margin: 0; font-family: monospace; font-size: 13px; color: #9c4221;">${(conference.short_name || 'CONF').replace(/\s+/g, '_')}_${submission.submission_number}_CameraReady.pdf</p>
            <p style="margin: 6px 0 0 0; font-size: 12px; color: #4a5568;"><em>*Please ensure no spaces or special characters are present in the filename.</em></p>
          </div>
          <p><strong>Next Step:</strong> Please review the committee's remarks above, apply the requested formatting or content adjustments, and upload your revised camera-ready PDF via the author portal as soon as possible.</p>
        `
    }
    `
  );

  return sendEmail({
    toEmail: author.email,
    toName: `${author.first_name} ${author.last_name}`,
    subject: `[${conference.short_name}] Camera-Ready Status: ${statusText} (Paper #${submission.submission_number})`,
    htmlContent: html,
    templateName,
    conferenceId: conference.id,
  });
}

// 7. Paper Withdrawn Notification
async function sendWithdrawalNotification({ toEmail, toName, paperTitle, submissionNumber, conferenceName, conferenceId }) {
  const html = wrapHtml(
    `Paper Withdrawn: #${submissionNumber}`,
    `
    <h3>Dear ${toName},</h3>
    <p>Please be informed that the following submission has been withdrawn from <strong>${conferenceName}</strong>:</p>
    <div style="background: #fff5f5; border-left: 4px solid #e53e3e; padding: 16px; margin: 15px 0;">
      <p style="margin: 0 0 8px 0;"><strong>Submission ID:</strong> ${submissionNumber}</p>
      <p style="margin: 0 0 8px 0;"><strong>Title:</strong> ${paperTitle}</p>
      <p style="margin: 0;"><strong>Status:</strong> <span style="color: #e53e3e; font-weight: bold;">WITHDRAWN / REMOVED</span></p>
    </div>
    <p>All associated files, manuscript records, and reviewer assignments have been completely removed from the system. If you were assigned to review this paper, no further evaluation is required.</p>
    <p>Thank you for your valuable contribution to <strong>${conferenceName}</strong>.</p>
    `
  );

  return sendEmail({
    toEmail,
    toName,
    subject: `[${conferenceName}] Paper Withdrawn Notification: #${submissionNumber}`,
    htmlContent: html,
    templateName: 'paper_withdrawn',
    conferenceId,
  });
}

// 9. Program Committee Invitation Notification
async function sendCommitteeInvitation({ reviewer, conference, tempPassword, customSubject, customMessage }) {
  const loginUrl = process.env.FRONTEND_URL || 'https://www.cmt.shazusofttechnologies.org/login';

  const defaultBody = `
    <h3>Dear ${reviewer.first_name} ${reviewer.last_name || ''},</h3>
    <p>You have been formally enrolled as a Peer Reviewer and Technical Program Committee member for <strong>${conference.name}</strong> (${conference.short_name}).</p>
    
    <div style="background: #f0fdf4; border-left: 4px solid #10b981; padding: 18px; margin: 18px 0; border-radius: 4px;">
      <p style="margin: 0 0 8px 0;"><strong>Conference / Publication:</strong> ${conference.name}</p>
      <p style="margin: 0 0 8px 0;"><strong>Role:</strong> Technical Program Committee / Peer Reviewer</p>
      <p style="margin: 0 0 8px 0;"><strong>Account Email:</strong> <code>${reviewer.email}</code></p>
      ${
        tempPassword
          ? `<p style="margin: 0 0 8px 0;"><strong>Temporary Password:</strong> <code style="background:#e2e8f0;padding:3px 8px;border-radius:4px;font-size:1.1em;color:#0f2942;">${tempPassword}</code></p>
             <p style="margin: 0; font-size: 0.875rem; color: #475569;"><em>Please sign in and update your password under your Profile settings.</em></p>`
          : '<p style="margin: 0; font-size: 0.875rem; color: #475569;">You can sign in using your existing registered account credentials.</p>'
      }
    </div>

    ${customMessage ? `<div style="background: #f8fafc; padding: 16px; border-radius: 6px; margin: 16px 0; border: 1px dashed #cbd5e1;"><p style="margin:0; white-space: pre-wrap;">${customMessage}</p></div>` : ''}

    <div style="text-align: center; margin: 24px 0;">
      <a href="${loginUrl}" style="display: inline-block; padding: 12px 28px; background: #1565C0; color: #ffffff !important; text-decoration: none; border-radius: 6px; font-weight: 700; font-size: 15px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);">
        Sign In to Reviewer Portal →
      </a>
    </div>

    <p style="font-size: 0.9rem; color: #64748b; margin-top: 20px;">
      Direct Portal URL: <a href="${loginUrl}" style="color: #1565C0;">${loginUrl}</a>
    </p>
    <p>Thank you for contributing your valuable academic expertise to <strong>${conference.short_name}</strong>.</p>
  `;

  const html = wrapHtml('Program Committee Invitation', defaultBody);

  return sendEmail({
    toEmail: reviewer.email,
    toName: `${reviewer.first_name} ${reviewer.last_name || ''}`.trim(),
    subject: customSubject || `[${conference.short_name}] Program Committee Invitation & Reviewer Access`,
    htmlContent: html,
    templateName: 'committee_invitation',
    conferenceId: conference.id,
  });
}

// 9b. Call for Papers / Author Invitation Notification
async function sendAuthorInvitation({ author, conference, tempPassword, customSubject, customMessage }) {
  const submitUrl = `${process.env.FRONTEND_URL || 'https://www.cmt.shazusofttechnologies.org'}/submit-paper`;
  const registerUrl = `${process.env.FRONTEND_URL || 'https://www.cmt.shazusofttechnologies.org'}/register?ref=${encodeURIComponent(conference.short_name || 'invite')}`;

  const defaultBody = `
    <h3>Dear ${author.first_name} ${author.last_name || ''},</h3>
    <p>You are cordially invited to submit your research paper / manuscript to <strong>${conference.name}</strong> (${conference.short_name}).</p>
    
    <div style="background: #f0f9ff; border-left: 4px solid #0284c7; padding: 18px; margin: 18px 0; border-radius: 4px;">
      <p style="margin: 0 0 8px 0;"><strong>Conference / Journal:</strong> ${conference.name}</p>
      ${conference.submission_deadline ? `<p style="margin: 0 0 8px 0;"><strong>Submission Deadline:</strong> ${new Date(conference.submission_deadline).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</p>` : ''}
      <p style="margin: 0 0 8px 0;"><strong>Account Email:</strong> <code>${author.email}</code></p>
      ${
        tempPassword
          ? `<p style="margin: 0 0 8px 0;"><strong>Temporary Password:</strong> <code style="background:#e2e8f0;padding:3px 8px;border-radius:4px;font-size:1.1em;color:#0f2942;">${tempPassword}</code></p>
             <p style="margin: 0; font-size: 0.875rem; color: #475569;"><em>We have created an author account for you. Please sign in and set your new password.</em></p>`
          : '<p style="margin: 0; font-size: 0.875rem; color: #475569;">You can sign in with your registered account or register directly to submit.</p>'
      }
    </div>

    ${customMessage ? `<div style="background: #f8fafc; padding: 16px; border-radius: 6px; margin: 16px 0; border: 1px dashed #cbd5e1;"><p style="margin:0; white-space: pre-wrap;">${customMessage}</p></div>` : ''}

    <div style="text-align: center; margin: 24px 0;">
      <a href="${submitUrl}" style="display: inline-block; padding: 12px 28px; background: #0284c7; color: #ffffff !important; text-decoration: none; border-radius: 6px; font-weight: 700; font-size: 15px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);">
        Submit Your Manuscript Now →
      </a>
    </div>

    <p style="font-size: 0.9rem; color: #64748b; margin-top: 20px;">
      Submit Online: <a href="${submitUrl}" style="color: #0284c7;">${submitUrl}</a>
    </p>
    <p>We look forward to receiving your high-quality academic contributions.</p>
  `;

  const html = wrapHtml('Call for Papers & Manuscript Invitation', defaultBody);

  return sendEmail({
    toEmail: author.email,
    toName: `${author.first_name} ${author.last_name || ''}`.trim(),
    subject: customSubject || `[Call for Papers] Invitation to Submit to ${conference.short_name || conference.name}`,
    htmlContent: html,
    templateName: 'author_invitation',
    conferenceId: conference.id,
  });
}

// 10. Password Reset Notification
async function sendPasswordResetEmail({ user, resetUrl }) {
  const html = wrapHtml(
    'Password Reset Request',
    `
    <h3>Dear ${user.first_name} ${user.last_name || ''},</h3>
    <p>We received a request to reset the password for your account (<strong>${user.email}</strong>) on the <strong>Shazu Soft Conference Management Tool (CJMS)</strong>.</p>
    
    <div style="background: #f8fafc; border-left: 4px solid #1565C0; padding: 18px; margin: 18px 0; border-radius: 4px;">
      <p style="margin: 0 0 8px 0;"><strong>Security Notice:</strong> This password reset link is valid for <strong>60 minutes</strong>.</p>
      <p style="margin: 0; font-size: 0.875rem; color: #64748b;">If you did not request this password reset, no action is required and your account remains secure.</p>
    </div>

    <div style="text-align: center; margin: 24px 0;">
      <a href="${resetUrl}" style="display: inline-block; padding: 12px 28px; background: #1565C0; color: #ffffff !important; text-decoration: none; border-radius: 6px; font-weight: 700; font-size: 15px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);">
        Reset Your Password →
      </a>
    </div>

    <p style="font-size: 0.85rem; color: #64748b; margin-top: 20px; word-break: break-all;">
      Or copy and paste this link into your browser:<br/>
      <a href="${resetUrl}" style="color: #1565C0;">${resetUrl}</a>
    </p>
    <p>Best regards,<br/>Shazu Soft CMT Security Team</p>
    `
  );

  return sendEmail({
    toEmail: user.email,
    toName: `${user.first_name} ${user.last_name || ''}`.trim(),
    subject: `[Shazu Soft CMT] Password Reset Instructions`,
    htmlContent: html,
    templateName: 'password_reset',
  });
}

module.exports = {
  sendEmail,
  sendWelcomeEmail,
  sendSubmissionConfirmation,
  sendReviewerInvitation,
  sendCommitteeInvitation,
  sendAuthorInvitation,
  sendPasswordResetEmail,
  sendDecisionNotification,
  sendBroadcastAnnouncement,
  sendCameraReadyStatusEmail,
  sendWithdrawalNotification,
};