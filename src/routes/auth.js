const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { authenticate } = require('../middlewares/auth');
const { sendWelcomeEmail, sendPasswordResetEmail } = require('../services/emailService');
const { logAudit } = require('../services/auditService');
const { fetchOrcidProfile, cleanOrcid, isValidOrcid, getOrcidOAuthUrl, exchangeOrcidOAuthCode } = require('../services/orcidService');
const { verifyTurnstileToken } = require('../services/turnstileService');

async function authRoutes(fastify, options) {
  // Get ORCID OAuth URL
  fastify.get('/orcid/url', async (request, reply) => {
    try {
      const { redirectUri } = request.query || {};
      console.log('[Auth Route] Generating ORCID OAuth URL for redirectUri:', redirectUri);
      const authData = getOrcidOAuthUrl(redirectUri);
      return authData;
    } catch (err) {
      console.error('[Auth Route] Error in /orcid/url:', err);
      return reply.code(500).send({ error: 'Failed to generate ORCID OAuth URL: ' + err.message });
    }
  });

  // ORCID OAuth Callback (Exchange Code & Sign-in/Sign-up)
  fastify.post('/orcid/callback', async (request, reply) => {
    const { code, redirectUri } = request.body || {};
    console.log('[Auth Route] /orcid/callback received request:', {
      hasCode: Boolean(code),
      codePrefix: code ? String(code).slice(0, 8) : null,
      redirectUri,
    });

    if (!code) {
      return reply.code(400).send({ error: 'Authorization code is required' });
    }

    try {
      // 1. Exchange code with ORCID
      const orcidData = await exchangeOrcidOAuthCode(code, redirectUri);
      console.log('[Auth Route] ORCID code exchanged successfully:', orcidData);
      const cleanedOrcid = cleanOrcid(orcidData.orcid);

      if (!cleanedOrcid) {
        return reply.code(400).send({ error: 'Failed to retrieve verified ORCID iD' });
      }

      // 2. Check if user already exists with this ORCID iD
      const existingUserRes = await db.query('SELECT * FROM users WHERE orcid_id = $1', [cleanedOrcid]);

      let user;
      let isNewUser = false;

      if (existingUserRes.rows.length > 0) {
        // Existing user found -> Log in
        user = existingUserRes.rows[0];
      } else {
        // New user -> Fetch rich public profile from ORCID
        isNewUser = true;
        let profile = {};
        try {
          profile = await fetchOrcidProfile(cleanedOrcid);
        } catch (fetchErr) {
          console.warn('Could not fetch public ORCID record:', fetchErr.message);
        }

        const firstName = profile.firstName || orcidData.name?.split(' ')[0] || 'Scholar';
        const lastName = profile.lastName || orcidData.name?.split(' ').slice(1).join(' ') || 'Researcher';
        const dummyEmail = `orcid.${cleanedOrcid.replace(/-/g, '')}@orcid.user`;
        const defaultPasswordHash = await bcrypt.hash(`orcid_oauth_${cleanedOrcid}`, 10);

        const insertRes = await db.query(
          `INSERT INTO users (
              email, password_hash, first_name, last_name, institution, department, country, 
              role, qualification, designation, domain, areas_of_interest, expertise_keywords, 
              max_review_limit, orcid_id, bio
           )
           VALUES ($1, $2, $3, $4, $5, $6, 'India', 'author', $7, $8, $9, $10, $11, 3, $12, $13)
           RETURNING id, email, first_name, last_name, institution, department, country, role, qualification, designation, domain, areas_of_interest, expertise_keywords, max_review_limit, orcid_id, bio;`,
          [
            dummyEmail,
            defaultPasswordHash,
            firstName,
            lastName,
            profile.institution || '',
            profile.department || '',
            profile.qualification || 'Ph.D. / Doctorate',
            profile.designation || 'Researcher',
            profile.domain || 'Computer Science & Engineering',
            profile.areasOfInterest || ['Peer Review', 'Research'],
            profile.areasOfInterest || ['Peer Review', 'Research'],
            cleanedOrcid,
            profile.bio || `ORCID Verified Scholar Profile (${cleanedOrcid})`,
          ]
        );
        user = insertRes.rows[0];
      }

      // Generate JWT Token
      const token = fastify.jwt.sign({ id: user.id, email: user.email, role: user.role });

      const safeUser = {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        institution: user.institution,
        department: user.department,
        country: user.country,
        role: user.role,
        qualification: user.qualification,
        designation: user.designation,
        domain: user.domain,
        areas_of_interest: user.areas_of_interest || [],
        expertise_keywords: user.expertise_keywords || [],
        max_review_limit: user.max_review_limit || 3,
        orcid_id: user.orcid_id,
        google_scholar_url: user.google_scholar_url,
        bio: user.bio,
      };

      await logAudit({
        userId: user.id,
        action: isNewUser ? 'USER_REGISTERED_VIA_ORCID' : 'USER_LOGIN_VIA_ORCID',
        entityType: 'user',
        entityId: user.id,
        details: { orcidId: cleanedOrcid, isNewUser },
      });

      return { user: safeUser, token, isNewUser };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: 'ORCID authentication failed', details: err.message });
    }
  });

  // ORCID Public Profile Lookup (Auto-fill)
  fastify.post('/orcid/lookup', async (request, reply) => {
    const { orcidId } = request.body || {};
    if (!orcidId) {
      return reply.code(400).send({ error: 'ORCID iD is required (e.g. 0000-0002-1825-0097)' });
    }

    try {
      const profile = await fetchOrcidProfile(orcidId);
      return { success: true, profile };
    } catch (err) {
      return reply.code(400).send({ error: err.message || 'Failed to lookup ORCID profile' });
    }
  });

  // Register new user (Standard or ORCID verified)
  fastify.post('/register', async (request, reply) => {
    const {
      email,
      password,
      firstName,
      lastName,
      institution,
      department,
      country,
      role = 'author',
      qualification = '',
      designation = '',
      domain = '',
      areasOfInterest = [],
      expertiseKeywords = [],
      maxReviewLimit = 3,
      orcidId = '',
      googleScholarUrl = '',
      bio = '',
      turnstileToken,
      'cf-turnstile-response': cfTurnstileResponse,
      referralSource = '',
      partnerJournal = '',
      partnerConference = '',
    } = request.body || {};

    if (!email || !password || !firstName || !lastName) {
      return reply.code(400).send({ error: 'Email, password, first name and last name are required.' });
    }

    const tToken = turnstileToken || cfTurnstileResponse || '';
    const turnstileCheck = await verifyTurnstileToken(tToken, 'signup', request);
    if (!turnstileCheck.success && !turnstileCheck.bypassed) {
      return reply.code(403).send({ error: turnstileCheck.error || 'Bot verification failed.' });
    }

    const cleanedOrcid = cleanOrcid(orcidId);

    try {
      const existing = await db.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase().trim()]);
      if (existing.rows.length > 0) {
        return reply.code(409).send({
          error: 'An account with this email address already exists. Please sign in to access your portal.',
          accountExists: true,
        });
      }

      if (cleanedOrcid) {
        const existingOrcid = await db.query('SELECT id FROM users WHERE orcid_id = $1', [cleanedOrcid]);
        if (existingOrcid.rows.length > 0) {
          return reply.code(409).send({
            error: 'An account with this ORCID iD is already registered. Please sign in.',
            accountExists: true,
          });
        }
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const combinedKeywords = Array.from(new Set([...(Array.isArray(areasOfInterest) ? areasOfInterest : []), ...(Array.isArray(expertiseKeywords) ? expertiseKeywords : [])]));

      const res = await db.query(
        `INSERT INTO users (
            email, password_hash, first_name, last_name, institution, department, country, 
            role, qualification, designation, domain, areas_of_interest, expertise_keywords, 
            max_review_limit, orcid_id, google_scholar_url, bio
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         RETURNING id, email, first_name, last_name, institution, department, country, role, qualification, designation, domain, areas_of_interest, expertise_keywords, max_review_limit, orcid_id, google_scholar_url, bio, created_at;`,
        [
          email.toLowerCase().trim(),
          passwordHash,
          firstName.trim(),
          lastName.trim(),
          institution || '',
          department || '',
          country || '',
          role,
          qualification || '',
          designation || '',
          domain || '',
          Array.isArray(areasOfInterest) ? areasOfInterest : [],
          combinedKeywords,
          parseInt(maxReviewLimit, 10) || 3,
          cleanedOrcid || null,
          googleScholarUrl || '',
          bio || '',
        ]
      );

      const user = res.rows[0];
      const token = fastify.jwt.sign({ id: user.id, email: user.email, role: user.role });

      // Trigger welcome email asynchronously (non-blocking)
      sendWelcomeEmail(user).catch((e) => console.error('Failed welcome email:', e.message));

      await logAudit({
        userId: user.id,
        action: referralSource || partnerJournal || partnerConference ? 'USER_REGISTERED_VIA_EXTERNAL_PARTNER' : 'USER_REGISTERED',
        entityType: 'user',
        entityId: user.id,
        details: {
          email: user.email,
          role: user.role,
          qualification: user.qualification,
          domain: user.domain,
          orcidId: user.orcid_id,
          referralSource: referralSource || partnerJournal || partnerConference || null,
        },
      });

      return { user, token };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to register user', details: err.message });
    }
  });

  // Login (Email or ORCID iD + Password)
  fastify.post('/login', async (request, reply) => {
    const { email, identifier, password, turnstileToken, 'cf-turnstile-response': cfTurnstileResponse } = request.body || {};
    const loginIdentifier = (email || identifier || '').trim();

    if (!loginIdentifier || !password) {
      return reply.code(400).send({ error: 'Email/ORCID iD and password are required' });
    }

    const tToken = turnstileToken || cfTurnstileResponse || '';
    const turnstileCheck = await verifyTurnstileToken(tToken, 'login', request);
    if (!turnstileCheck.success && !turnstileCheck.bypassed) {
      return reply.code(403).send({ error: turnstileCheck.error || 'Bot verification failed.' });
    }

    try {
      const cleaned = cleanOrcid(loginIdentifier);
      const res = await db.query(
        'SELECT * FROM users WHERE email = $1 OR orcid_id = $2',
        [loginIdentifier.toLowerCase(), cleaned]
      );
      if (res.rows.length === 0) {
        return reply.code(401).send({ error: 'Invalid credentials. Please check your email/ORCID and password.' });
      }

      const user = res.rows[0];
      const isValid = await bcrypt.compare(password, user.password_hash);
      if (!isValid) {
        return reply.code(401).send({ error: 'Invalid credentials. Please check your email/ORCID and password.' });
      }

      const token = fastify.jwt.sign({ id: user.id, email: user.email, role: user.role });

      const safeUser = {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        institution: user.institution,
        department: user.department,
        country: user.country,
        role: user.role,
        qualification: user.qualification,
        designation: user.designation,
        domain: user.domain,
        areas_of_interest: user.areas_of_interest || [],
        expertise_keywords: user.expertise_keywords || [],
        max_review_limit: user.max_review_limit || 3,
        orcid_id: user.orcid_id,
        google_scholar_url: user.google_scholar_url,
        bio: user.bio,
      };

      await logAudit({
        userId: user.id,
        action: 'USER_LOGIN',
        entityType: 'user',
        entityId: user.id,
        details: { email: user.email, loginVia: user.email === loginIdentifier.toLowerCase() ? 'email' : 'orcid' },
      });

      return { user: safeUser, token };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: 'Login failed', details: err.message });
    }
  });

  // Get current authenticated user profile
  fastify.get('/me', { preHandler: [authenticate] }, async (request, reply) => {
    try {
      const res = await db.query(
        `SELECT id, email, first_name, last_name, institution, department, country, role, 
                qualification, designation, domain, areas_of_interest, expertise_keywords, 
                max_review_limit, orcid_id, google_scholar_url, bio, created_at 
         FROM users WHERE id = $1`,
        [request.currentUser.id]
      );
      if (res.rows.length === 0) {
        return reply.code(404).send({ error: 'User not found' });
      }
      return { user: res.rows[0] };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to fetch user', details: err.message });
    }
  });

  // Update profile
  fastify.put('/profile', { preHandler: [authenticate] }, async (request, reply) => {
    const {
      firstName,
      lastName,
      institution,
      department,
      country,
      qualification,
      designation,
      domain,
      areasOfInterest,
      expertiseKeywords,
      maxReviewLimit,
      orcidId,
      googleScholarUrl,
      bio,
    } = request.body || {};

    try {
      const res = await db.query(
        `UPDATE users SET 
            first_name = COALESCE($1, first_name),
            last_name = COALESCE($2, last_name),
            institution = COALESCE($3, institution),
            department = COALESCE($4, department),
            country = COALESCE($5, country),
            qualification = COALESCE($6, qualification),
            designation = COALESCE($7, designation),
            domain = COALESCE($8, domain),
            areas_of_interest = COALESCE($9, areas_of_interest),
            expertise_keywords = COALESCE($10, expertise_keywords),
            max_review_limit = COALESCE($11, max_review_limit),
            orcid_id = COALESCE($12, orcid_id),
            google_scholar_url = COALESCE($13, google_scholar_url),
            bio = COALESCE($14, bio),
            updated_at = CURRENT_TIMESTAMP
         WHERE id = $15
         RETURNING id, email, first_name, last_name, institution, department, country, role, qualification, designation, domain, areas_of_interest, expertise_keywords, max_review_limit, orcid_id, google_scholar_url, bio;`,
        [
          firstName,
          lastName,
          institution,
          department,
          country,
          qualification,
          designation,
          domain,
          areasOfInterest,
          expertiseKeywords,
          maxReviewLimit,
          orcidId,
          googleScholarUrl,
          bio,
          request.currentUser.id,
        ]
      );
      return { user: res.rows[0] };
    } catch (err) {
      return reply.code(500).send({ error: 'Failed to update profile', details: err.message });
    }
  });

  // Request Password Reset Link
  fastify.post('/forgot-password', async (request, reply) => {
    const { email } = request.body || {};
    if (!email) {
      return reply.code(400).send({ error: 'Email address is required.' });
    }

    try {
      const cleanEmail = email.toLowerCase().trim();
      const res = await db.query('SELECT id, email, first_name, last_name FROM users WHERE email = $1', [cleanEmail]);

      if (res.rows.length === 0) {
        // Return generic message to prevent email enumeration
        return { message: 'If an account exists with this email, a password reset link has been dispatched.' };
      }

      const user = res.rows[0];
      const resetToken = fastify.jwt.sign(
        { userId: user.id, email: user.email, purpose: 'password_reset' },
        { expiresIn: '1h' }
      );

      const frontendUrl = process.env.FRONTEND_URL || 'https://www.cmt.shazusofttechnologies.org';
      const resetUrl = `${frontendUrl}/reset-password?token=${encodeURIComponent(resetToken)}`;

      if (sendPasswordResetEmail) {
        try {
          await sendPasswordResetEmail({ user, resetUrl });
        } catch (emailErr) {
          console.warn('[Forgot Password] Email sending error:', emailErr.message);
        }
      }

      await logAudit({
        userId: user.id,
        action: 'USER_REQUESTED_PASSWORD_RESET',
        entityType: 'user',
        entityId: user.id,
        details: { email: user.email },
      });

      return { message: 'Password reset link sent! Please check your email inbox.' };
    } catch (err) {
      console.error('[Forgot Password Error]:', err);
      return reply.code(500).send({ error: 'Failed to process password reset request', details: err.message });
    }
  });

  // Set New Password using Reset Token
  fastify.post('/reset-password', async (request, reply) => {
    const { token, newPassword } = request.body || {};
    if (!token || !newPassword) {
      return reply.code(400).send({ error: 'Reset token and new password are required.' });
    }

    if (newPassword.length < 6) {
      return reply.code(400).send({ error: 'Password must be at least 6 characters long.' });
    }

    try {
      let decoded;
      try {
        decoded = fastify.jwt.verify(token);
      } catch (jwtErr) {
        return reply.code(400).send({ error: 'Invalid or expired password reset link. Please request a new one.' });
      }

      if (decoded.purpose !== 'password_reset' || !decoded.userId) {
        return reply.code(400).send({ error: 'Invalid reset token purpose.' });
      }

      const passwordHash = await bcrypt.hash(newPassword, 10);
      const updateRes = await db.query(
        'UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id, email',
        [passwordHash, decoded.userId]
      );

      if (updateRes.rows.length === 0) {
        return reply.code(404).send({ error: 'User account not found.' });
      }

      await logAudit({
        userId: decoded.userId,
        action: 'USER_COMPLETED_PASSWORD_RESET',
        entityType: 'user',
        entityId: decoded.userId,
        details: { email: decoded.email },
      });

      return { message: 'Password has been reset successfully! You can now sign in.' };
    } catch (err) {
      console.error('[Reset Password Error]:', err);
      return reply.code(500).send({ error: 'Failed to reset password', details: err.message });
    }
  });

  // Change Password for Logged-in User
  fastify.post('/change-password', { preHandler: [authenticate] }, async (request, reply) => {
    const { currentPassword, newPassword } = request.body || {};
    if (!newPassword || newPassword.length < 6) {
      return reply.code(400).send({ error: 'New password must be at least 6 characters long.' });
    }

    try {
      const userRes = await db.query('SELECT id, password_hash FROM users WHERE id = $1', [request.currentUser.id]);
      if (userRes.rows.length === 0) {
        return reply.code(404).send({ error: 'User not found.' });
      }

      const user = userRes.rows[0];
      if (currentPassword) {
        const matches = await bcrypt.compare(currentPassword, user.password_hash);
        if (!matches) {
          return reply.code(400).send({ error: 'Current password does not match.' });
        }
      }

      const passwordHash = await bcrypt.hash(newPassword, 10);
      await db.query('UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [
        passwordHash,
        request.currentUser.id,
      ]);

      await logAudit({
        userId: request.currentUser.id,
        action: 'USER_CHANGED_PASSWORD',
        entityType: 'user',
        entityId: request.currentUser.id,
      });

      return { message: 'Password updated successfully!' };
    } catch (err) {
      console.error('[Change Password Error]:', err);
      return reply.code(500).send({ error: 'Failed to change password', details: err.message });
    }
  });
}

module.exports = authRoutes;
