// http/routes/auth.js — POST /auth/login, /auth/logout, /auth/change-password (Customer-auth spec).

import express from 'express';
import { createRequireAuth } from '../middleware/requireAuth.js';
import { serializeCookie } from '../cookies.js';

export const SESSION_COOKIE_NAME = 'sid';

/**
 * @param {{
 *   authStore: ReturnType<typeof import('../../auth.js').createAuthStore>,
 *   config: import('../../config.js').Config,
 *   rateLimiter: ReturnType<typeof import('../rateLimiter.js').createRateLimiter>,
 * }} deps
 */
export function createAuthRoutes({ authStore, config, rateLimiter }) {
  const router = express.Router();
  // change-password, logout, and me stay reachable while must_change_password
  // is still set -- the gate blocks access to data, not the ability to log
  // out, complete the one action that clears it, or ask "am I gated?" on a
  // fresh page load (spec: "besides login/logout").
  const requireAuth = createRequireAuth({ authStore, exemptPaths: ['/change-password', '/logout', '/me'] });

  router.post('/login', (req, res) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== 'string' || typeof password !== 'string' || email.trim() === '' || password === '') {
      res.status(400).json({ error: 'email and password are required' });
      return;
    }

    const rateLimitKey = email.trim().toLowerCase();
    if (!rateLimiter.check(rateLimitKey)) {
      res.status(429).json({ error: 'too many attempts, try again later' });
      return;
    }

    const user = authStore.verifyPassword(email, password);
    if (!user) {
      rateLimiter.recordFailure(rateLimitKey);
      // Identical response for "no such user" and "wrong password" -- never
      // reveal which (spec's error-handling rule).
      res.status(401).json({ error: 'invalid email or password' });
      return;
    }

    rateLimiter.reset(rateLimitKey);
    const sessionId = authStore.createSession(user.id);
    res.setHeader(
      'Set-Cookie',
      serializeCookie(SESSION_COOKIE_NAME, sessionId, {
        maxAgeSeconds: config.sessionTtlHours * 3600,
        secure: config.isProduction,
      }),
    );
    res.status(200).json({
      mustChangePassword: user.mustChangePassword,
      tenantId: user.tenantId,
      isSuperadmin: user.isSuperadmin,
    });
  });

  router.get('/me', requireAuth, (req, res) => {
    // req.authUser doesn't carry mustChangePassword (it's meaningless once
    // requireAuth has already let a normal route through) -- this route is
    // exempt from the gate specifically so it can still report it.
    const user = authStore.getUser(req.authUser.id);
    res.status(200).json({
      mustChangePassword: user.mustChangePassword,
      tenantId: user.tenantId,
      isSuperadmin: user.isSuperadmin,
    });
  });

  router.post('/logout', requireAuth, (req, res) => {
    authStore.deleteSession(req.sessionId);
    res.setHeader(
      'Set-Cookie',
      serializeCookie(SESSION_COOKIE_NAME, '', { maxAgeSeconds: 0, secure: config.isProduction }),
    );
    res.status(200).json({ ok: true });
  });

  router.post('/change-password', requireAuth, (req, res) => {
    const { currentPassword, newPassword } = req.body ?? {};
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      res.status(400).json({ error: 'currentPassword and newPassword are required' });
      return;
    }
    try {
      authStore.changePassword(req.authUser.id, { currentPassword, newPassword });
      res.status(200).json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err?.message ?? String(err) });
    }
  });

  return router;
}
