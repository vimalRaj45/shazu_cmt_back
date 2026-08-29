require('dotenv').config();

const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET;

/**
 * Server-side verification of Cloudflare Turnstile token via siteverify API
 * @param {string} token - The cf-turnstile-response token from client
 * @param {string} expectedAction - Optional action identifier (e.g. 'login', 'signup')
 * @param {object} req - Fastify request object to extract client IP
 * @returns {Promise<{success: boolean, error?: string, bypassed?: boolean}>}
 */
async function verifyTurnstileToken(token, expectedAction = '', req = null) {
  const secret = process.env.TURNSTILE_SECRET;
  
  // If TURNSTILE_SECRET is not configured in backend environment, log warning and bypass in non-strict dev mode
  if (!secret) {
    console.warn('[Turnstile] TURNSTILE_SECRET is not configured in environment. Verification bypassed.');
    return { success: true, bypassed: true };
  }

  if (typeof token !== 'string' || !token || token.trim().length === 0 || token.length > 2048) {
    console.warn('[Turnstile] Missing or invalid Turnstile response token.');
    return { success: false, error: 'Turnstile bot verification token is missing or invalid.' };
  }

  let clientIp = '';
  if (req) {
    clientIp = (req.headers && req.headers['x-forwarded-for'])
      ? req.headers['x-forwarded-for'].split(',')[0].trim()
      : (req.ip || '');
  }

  try {
    const params = new URLSearchParams();
    params.append('secret', secret);
    params.append('response', token.trim());
    if (clientIp) {
      params.append('remoteip', clientIp);
    }

    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      signal: AbortSignal.timeout(10000),
      body: params.toString(),
    });

    if (!response.ok) {
      console.error(`[Turnstile Error] Siteverify HTTP status: ${response.status}`);
      return { success: false, error: `Turnstile verification service returned status ${response.status}` };
    }

    const result = await response.json();

    if (!result.success) {
      console.warn('[Turnstile Failed]', result);
      return {
        success: false,
        error: 'Bot verification failed. Please refresh and complete the security check.',
        errorCodes: result['error-codes'] || [],
      };
    }

    if (expectedAction && result.action && result.action !== expectedAction) {
      console.warn(`[Turnstile Action Mismatch] Expected '${expectedAction}', got '${result.action}'`);
      return { success: false, error: 'Turnstile verification action mismatch.' };
    }

    return { success: true, result };
  } catch (err) {
    console.error('[Turnstile Exception]', err);
    return { success: false, error: 'Failed to communicate with Turnstile verification service: ' + err.message };
  }
}

module.exports = {
  verifyTurnstileToken,
};
